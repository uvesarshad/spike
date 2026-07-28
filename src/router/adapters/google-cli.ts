/* Rung 1 — generic "Google CLI" adapter over the free-quota headless mode.
 * Today the binary is `gemini`; on 2026-06-18 the free tier moves to the
 * Antigravity CLI (keeps -p, adds --output-format) — so the binary, model and
 * extra env all come from config and are NEVER hardcoded.
 *
 * Spawn recipe (each piece verified against gemini-cli on this machine):
 * - the bulky multi-line prompt goes via STDIN (piped stdin is appended to -p;
 *   Windows shells cannot pass newline-laden argv reliably);
 * - -p stays a short single line we control: the @image attach + a pointer to
 *   stdin;
 * - screenshots are written to a temp dir and the CLI runs with cwd THERE:
 *   the CLI only reads @files inside its workspace and refuses gitignored
 *   paths (artifacts/ is gitignored), so the repo cwd would reject them;
 * - GEMINI_CLI_TRUST_WORKSPACE=true — headless runs in an untrusted dir exit 55;
 * - machine gotcha (product doc §6.5): behind AVG TLS interception OAuth dies
 *   with exit 41 unless NODE_OPTIONS=--use-system-ca. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { AdapterUsage, Capability, JsonRequest, ModelAdapter } from '../adapter.js';
import { extractJson } from '../adapter.js';
import { isSafeModelId } from '../../vibe/settings.js';

/** The per-model token block in the -o json envelope:
 * stats.models[<model>].tokens = { input, prompt, candidates, total, cached, thoughts }. */
interface GeminiTokens {
  input?: number;
  prompt?: number;
  candidates?: number;
  total?: number;
  cached?: number;
  thoughts?: number;
}

/** Pull usage from the envelope's stats.models. The model key varies (it's the
 * resolved model id, which may differ from what we requested), so take the
 * FIRST key. Returns undefined when there are no parseable counts. */
function parseEnvelopeUsage(
  stats: { models?: Record<string, { tokens?: GeminiTokens }> } | undefined,
): AdapterUsage | undefined {
  const models = stats?.models;
  if (!models) return undefined;
  const firstKey = Object.keys(models)[0];
  if (!firstKey) return undefined;
  const t = models[firstKey]?.tokens;
  if (!t) return undefined;
  const usage: AdapterUsage = {};
  // prefer `prompt` (excludes cached) but fall back to `input` for the input side
  if (typeof t.prompt === 'number') usage.promptTokens = t.prompt;
  else if (typeof t.input === 'number') usage.promptTokens = t.input;
  // output = candidates (+ thoughts, which Gemini bills separately)
  if (typeof t.candidates === 'number') {
    usage.outputTokens = t.candidates + (typeof t.thoughts === 'number' ? t.thoughts : 0);
  }
  if (typeof t.total === 'number') usage.totalTokens = t.total;
  if (typeof t.cached === 'number') usage.cachedTokens = t.cached;
  return Object.keys(usage).length ? usage : undefined;
}

export interface GoogleCliOptions {
  bin: string;
  model: string;
  env: Record<string, string>;
  timeoutMs?: number;
}

export class GoogleCliAdapter implements ModelAdapter {
  readonly name: string;
  readonly rung = 1 as const;
  lastUsage?: AdapterUsage;
  private availableCache: { value: boolean; at: number } | null = null;
  private static readonly AVAIL_TTL_MS = 30_000;
  private workDirCache: string | null = null;
  private callSeq = 0;

  constructor(private readonly opts: GoogleCliOptions) {
    this.name = `google-cli(${opts.bin})`;
  }

  /** One persistent work dir per adapter — the CLI runs with cwd here, and on
   * Windows a dir that is (or recently was) a child process's cwd can't be
   * removed (EPERM), so per-call temp dirs are a trap. The OS temp cleaner
   * owns it eventually. */
  private workDir(): string {
    if (!this.workDirCache) {
      this.workDirCache = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-cli-'));
    }
    return this.workDirCache;
  }

  /** Short-TTL cached probe (mirrors ollama.ts's pattern): a `--version` spawn is
   * slow enough that re-probing on EVERY plan-step call across a long run (hours
   * of navigator steps per CLAUDE.md) would add real overhead, but caching
   * forever would also mean a CLI installed/fixed mid-run (e.g. `npm i -g` while
   * the daemon is running) never gets picked back up. 30s balances both. */
  async available(): Promise<boolean> {
    const cached = this.availableCache;
    if (cached && Date.now() - cached.at < GoogleCliAdapter.AVAIL_TTL_MS) return cached.value;
    const value = await new Promise<boolean>((resolve) => {
      const child = spawn(`${this.opts.bin} --version`, { shell: true, stdio: 'ignore' });
      child.once('error', () => resolve(false));
      child.once('exit', (code) => resolve(code === 0));
    });
    this.availableCache = { value, at: Date.now() };
    return value;
  }

  supports(_cap: Capability): boolean {
    return true; // Flash-class: plans and judges screenshots
  }

  async generateJson(req: JsonRequest): Promise<unknown> {
    const workDir = this.workDir();
    let shotName: string | null = null;
    try {
      let headline = 'Follow the instructions provided on stdin.';
      if (req.imagePng) {
        shotName = `shot-${this.callSeq++}.png`;
        fs.writeFileSync(path.join(workDir, shotName), req.imagePng);
        headline = `@${shotName} ${headline}`;
      }
      const stdinText =
        `${req.prompt}\n\nRespond with ONLY a JSON object matching this JSON schema:\n` +
        JSON.stringify(req.schema);
      this.lastUsage = undefined; // reset; only set if this call yields counts
      const stdout = await this.run(headline, stdinText, workDir);
      // -o json wraps the model text in an envelope: { response: "...", stats: {...} }
      try {
        const envelope = JSON.parse(stdout.trim()) as {
          response?: string;
          stats?: { models?: Record<string, { tokens?: GeminiTokens }> };
        };
        this.lastUsage = parseEnvelopeUsage(envelope.stats);
        if (typeof envelope.response === 'string') return extractJson(envelope.response);
      } catch {
        /* not an envelope — older CLI or plain text mode */
      }
      return extractJson(stdout);
    } finally {
      if (shotName) {
        try { fs.rmSync(path.join(workDir, shotName), { force: true }); } catch { /* best effort */ }
      }
    }
  }

  private run(headline: string, stdinText: string, cwd: string): Promise<string> {
    // SECURITY: -m ${model} is interpolated into a shell command. The model comes
    // from config today (not the bridge), but validate at the sink so a future
    // bridge-settable Gemini model can never inject shell metacharacters.
    if (this.opts.model && !isSafeModelId(this.opts.model)) {
      throw new Error(`google-cli: refusing to run with unsafe model id ${JSON.stringify(this.opts.model)}`);
    }
    // single command string (bin is typically a .cmd shim on Windows → shell);
    // headline is OUR text, single-line, no quotes — safe to wrap in ".
    // -e none: skip user extensions/MCP servers (halves startup, kills noise);
    // -o json: structured envelope instead of scraping stdout
    const command = `${this.opts.bin} -p "${headline}" -m ${this.opts.model} -e none -o json`;
    return new Promise((resolve, reject) => {
      const child = spawn(command, {
        shell: true,
        cwd,
        env: {
          ...process.env,
          GEMINI_CLI_TRUST_WORKSPACE: 'true',
          ...this.opts.env,
        },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.stdin.end(stdinText);
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`${this.opts.bin} timed out after ${this.opts.timeoutMs ?? 120_000}ms`));
      }, this.opts.timeoutMs ?? 120_000);
      child.once('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) return resolve(stdout);
        if (code === 41) {
          return reject(
            new Error(
              `${this.opts.bin} exit 41 — OAuth/TLS failure. Behind TLS-intercepting antivirus (AVG…) set NODE_OPTIONS=--use-system-ca for the CLI (config.googleCliEnv).`,
            ),
          );
        }
        if (code === 55) {
          return reject(
            new Error(`${this.opts.bin} exit 55 — untrusted workspace; GEMINI_CLI_TRUST_WORKSPACE=true should be set (adapter bug?)`),
          );
        }
        // The Gemini CLI free tier (Gemini Code Assist for individuals) ended on
        // 2026-06-18: this client now hard-fails auth with IneligibleTierError /
        // UNSUPPORTED_CLIENT. Detect it and tell the user how to recover instead of
        // surfacing a raw stack trace (the router still escalates to the next rung).
        if (/IneligibleTier|UNSUPPORTED_CLIENT|no longer supported|Antigravity/i.test(stderr)) {
          return reject(
            new Error(
              `${this.opts.bin}: the Gemini CLI free tier (Gemini Code Assist for individuals) has ended — this client is no longer supported. ` +
                `Switch the planner to a BYOK key (e.g. \`spike config set --provider glm\` then \`spike secret set glm <key>\`; gemini/claude/openai also work), ` +
                `use the \`claude\` or \`codex\` CLI, or point googleCliBin at the Antigravity CLI once installed.`,
            ),
          );
        }
        reject(new Error(`${this.opts.bin} exit ${code}: ${stderr.slice(0, 400)}`));
      });
    });
  }
}
