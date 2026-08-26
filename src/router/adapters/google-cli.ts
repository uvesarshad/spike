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
import { spawn, type ChildProcess } from 'node:child_process';
import type { AdapterUsage, Capability, JsonRequest, ModelAdapter } from '../adapter.js';
import { extractJson } from '../adapter.js';
import { isSafeModelId } from '../../vibe/settings.js';

/** A24 (P1): kill the REAL CLI process (and anything it spawned), not just the
 * `shell:true` wrapper — a plain `child.kill()` only signals /bin/sh (or
 * cmd.exe), leaving the actual `gemini`/`antigravity` binary running and
 * still able to read the screenshot the caller's `finally` deletes right
 * after this settles. POSIX: `detached: true` on spawn (see run()) makes
 * `child` the leader of its own process group, so a NEGATIVE pid signals the
 * whole group. Windows has no process-group signal; `taskkill /T` walks the
 * process tree instead. */
export function killProcessGroup(child: ChildProcess): void {
  if (process.platform === 'win32') {
    if (child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    return;
  }
  try {
    if (child.pid) process.kill(-child.pid, 'SIGKILL');
  } catch {
    // group already gone, or never formed (pid raced the spawn) — fall back
    // to signalling the child directly rather than leaving it running.
    child.kill('SIGKILL');
  }
}

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
  /** A4 (P0): timeout for the `--version` availability probe. Defaults to
   * 5000ms — overridable so a fast test can exercise the hung-probe path
   * without a real 5s wait. See available()'s doc comment for why an
   * unbounded probe is a whole-router deadlock, not just a slow call. */
  availabilityProbeTimeoutMs?: number;
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
      let settled = false;
      const finish = (v: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      };
      // A4 (P0): a hung `--version` spawn (dead PATH entry, a shim that never
      // exits) must not deadlock the whole router — `availableCache` is only
      // written once THIS promise settles, so an unbounded probe here means
      // every later plan-step/plan-goals call across the whole run also hangs
      // forever waiting on the same unresolved probe. Force a negative result
      // (which the TTL cache then absorbs, same as any other failed probe)
      // after a bounded wait, and kill the wedged child so it doesn't linger.
      const timer = setTimeout(() => {
        child.kill();
        finish(false);
      }, this.opts.availabilityProbeTimeoutMs ?? 5000);
      child.once('error', () => finish(false));
      child.once('exit', (code) => finish(code === 0));
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
        // A24 (P1): leader of its own process group on POSIX — see
        // killProcessGroup()'s doc comment for why a plain child.kill() isn't
        // enough under shell:true.
        detached: process.platform !== 'win32',
        env: {
          ...process.env,
          GEMINI_CLI_TRUST_WORKSPACE: 'true',
          ...this.opts.env,
        },
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      // A5 (P0): an unhandled 'error' on a writable stream is fatal to the
      // WHOLE Node process, not just this call — if the CLI exits before (or
      // while) we write the prompt, `.end()` raises EPIPE/ERR_STREAM_WRITE_AFTER_END,
      // and with nothing listening that crashes the daemon (every connected
      // panel's session with it). The 'exit' handler below still classifies
      // the real failure from the exit code/stderr; this only stops the write
      // error itself from being fatal. Non-stdin errors are folded into
      // stderr rather than silently dropped, so the exit-code path can still
      // surface them.
      child.stdin.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code !== 'EPIPE' && err.code !== 'ERR_STREAM_WRITE_AFTER_END') {
          stderr += `\n[stdin write error] ${err.message}`;
        }
      });
      child.stdin.end(stdinText);
      const timer = setTimeout(() => {
        timedOut = true;
        // A24 (P1): kill the process GROUP, and wait for the real 'exit' below
        // before this promise settles — the caller's `finally` deletes the temp
        // screenshot right after this resolves/rejects, and that must not race
        // a still-alive child that could still be reading it.
        killProcessGroup(child);
      }, this.opts.timeoutMs ?? 120_000);
      child.once('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          return reject(new Error(`${this.opts.bin} timed out after ${this.opts.timeoutMs ?? 120_000}ms`));
        }
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
