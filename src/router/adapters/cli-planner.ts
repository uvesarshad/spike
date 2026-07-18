/* Generic CLI-planner adapter (rung 1) — drives a local coding-agent CLI
 * (claude, codex; gemini has its own richer adapter) as a cheap/free
 * PLANNER + VISUAL judge.
 *
 * Serves plan-step + plan-goals (pure text — the a11y tree / a compact digest,
 * which these CLIs do well at their cheap tiers) AND visual-verdict: modern
 * claude/codex CLIs accept image attachments, so a screenshot request is wired
 * through the same spawn. When the CLI is unavailable the router still falls
 * back to Nano / API for vision, so this only ADDS a rung.
 *
 * Image attach mirrors google-cli.ts: the screenshot is written into a private
 * per-adapter work dir and referenced by BASENAME with the child's cwd set
 * there — this dodges argv-with-spaces (temp paths under a spacey Windows
 * profile) and each CLI's "won't read files outside the workspace" guard.
 * Per-bin mechanism:
 *   - claude: an `@<file>` mention in the prompt (Claude Code reads @-path
 *     images); cwd = work dir so the bare basename resolves.
 *   - codex:  `codex exec --image <file>`; cwd = work dir, prompt still on stdin.
 * (If your installed CLI names these differently, the two spots below —
 * imageArgs() and the claude prompt prefix — are the only things to change.)
 *
 * Spawn recipe mirrors google-cli.ts + auto-fix.ts: the bulky multi-line prompt
 * goes on STDIN (Windows argv can't carry newlines), the binary runs via a shell
 * (the named CLIs are .cmd shims on Windows), `<bin> --version` gates
 * availability, and the JSON is parsed leniently (claude --output-format json
 * wraps the answer in an envelope; codex prints it plain). */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Capability, JsonRequest, ModelAdapter } from '../adapter.js';
import { extractJson, withSchemaInstruction } from '../adapter.js';
import { isSafeModelId } from '../../vibe/settings.js';

/** Per-bin invocation: argv after the binary (model appended when set). Prompt is
 * always delivered on stdin, so none of these carry the prompt as an argument. */
const RECIPES: Record<string, (model?: string) => string[]> = {
  // claude reads the prompt from stdin when -p has no inline text; --output-format
  // json wraps the reply in a {type:'result', result:'...'} envelope we unwrap.
  claude: (model) => ['-p', '--output-format', 'json', ...(model ? ['--model', model] : [])],
  // codex exec reads the prompt from stdin; -m sets the model (omitted → its config).
  codex: (model) => ['exec', ...(model ? ['-m', model] : [])],
};

export interface CliPlannerOptions {
  /** Binary name — must be a key of RECIPES ('claude' | 'codex'). */
  bin: 'claude' | 'codex';
  /** Model id passed to the CLI (optional — omitted falls back to the CLI's config). */
  model?: string;
  timeoutMs?: number;
}

export class CliPlannerAdapter implements ModelAdapter {
  readonly name: string;
  readonly rung = 1 as const;
  private availableCache: { value: boolean; at: number } | null = null;
  private static readonly AVAIL_TTL_MS = 30_000;
  private workDirCache: string | null = null;
  private callSeq = 0;

  constructor(private readonly opts: CliPlannerOptions) {
    this.name = `cli(${opts.bin}${opts.model ? `:${opts.model}` : ''})`;
  }

  /** One persistent work dir per adapter (created lazily on the first image
   * call). Same rationale as google-cli.ts: the CLI runs with cwd here so a
   * bare `@shot.png` / `--image shot.png` resolves, and a per-call temp dir
   * would be un-removable on Windows while it's a child's cwd. Text-only calls
   * never touch it. */
  private workDir(): string {
    if (!this.workDirCache) {
      this.workDirCache = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-cliplan-'));
    }
    return this.workDirCache;
  }

  /** Short-TTL cached probe — same rationale/window as google-cli.ts and
   * ollama.ts: avoid a `--version` spawn on every plan-step call, while still
   * letting a CLI that becomes available mid-run (installed/PATH fixed) get
   * picked back up within 30s instead of staying "unavailable" for the whole run. */
  async available(): Promise<boolean> {
    const cached = this.availableCache;
    if (cached && Date.now() - cached.at < CliPlannerAdapter.AVAIL_TTL_MS) return cached.value;
    const value = await new Promise<boolean>((resolve) => {
      const child = spawn(`${this.opts.bin} --version`, { shell: true, stdio: 'ignore' });
      child.once('error', () => resolve(false));
      child.once('exit', (code) => resolve(code === 0));
    });
    this.availableCache = { value, at: Date.now() };
    return value;
  }

  supports(cap: Capability): boolean {
    // Now includes visual-verdict: claude/codex accept image attachments (see
    // the file header). Router still leads visual with Nano/API — this is a rung.
    return cap === 'plan-step' || cap === 'plan-goals' || cap === 'visual-verdict';
  }

  async generateJson(req: JsonRequest): Promise<unknown> {
    const recipe = RECIPES[this.opts.bin];
    if (!recipe) throw new Error(`${this.name}: no recipe for bin "${this.opts.bin}"`);
    const args = recipe(this.opts.model);
    let prompt = withSchemaInstruction(req.prompt, req.schema);
    let cwd: string | undefined;

    // Attach a screenshot when the request carries one (visual-verdict / visual
    // confirm). Written by basename into the work dir; cwd points there.
    if (req.imagePng) {
      const dir = this.workDir();
      const shot = `shot-${this.callSeq++}.png`;
      fs.writeFileSync(path.join(dir, shot), req.imagePng);
      cwd = dir;
      if (this.opts.bin === 'codex') {
        // codex exec attaches images by flag; prompt stays on stdin.
        args.push('--image', shot);
      } else {
        // claude reads @-mentioned image files; prepend the mention to the prompt.
        prompt = `@${shot}\n\n${prompt}`;
      }
    }

    const stdout = await this.run(args, prompt, cwd);
    // claude --output-format json → { ..., result: "<assistant text>" }; unwrap it.
    try {
      const env = JSON.parse(stdout.trim()) as { result?: unknown };
      if (env && typeof env.result === 'string') return extractJson(env.result);
    } catch {
      /* not an envelope — fall through to raw parse (codex, plain text) */
    }
    return extractJson(stdout);
  }

  private run(args: string[], stdinText: string, cwd?: string): Promise<string> {
    // SECURITY: the model id is the only non-constant token that lands in this
    // shell command, and it can originate from the bridge (vibe.config.set). It is
    // validated where it's set (settings/service), but re-check at the sink —
    // defense in depth means a tainted value never reaches the shell even if a new
    // caller forgets to validate. Failing here makes the router fall to the next rung.
    if (this.opts.model && !isSafeModelId(this.opts.model)) {
      throw new Error(`cli-planner: refusing to run with unsafe model id ${JSON.stringify(this.opts.model)}`);
    }
    // shell:true: the named CLIs are .cmd shims on Windows. Our argv is flags +
    // a (validated) model id + a constant screenshot basename, so joining into
    // one command string is safe.
    const command = `${this.opts.bin} ${args.join(' ')}`;
    const timeoutMs = this.opts.timeoutMs ?? 120_000;
    return new Promise((resolve, reject) => {
      const child = spawn(command, { shell: true, cwd });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.stdin.end(stdinText);
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`${this.opts.bin} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      child.once('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) return resolve(stdout);
        reject(new Error(`${this.opts.bin} exit ${code}: ${stderr.slice(0, 400)}`));
      });
    });
  }
}
