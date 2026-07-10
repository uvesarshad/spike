/* Generic CLI-planner adapter (rung 1) — drives a local coding-agent CLI
 * (claude, codex; gemini has its own richer adapter) as a cheap/free PLANNER.
 *
 * PLANNER ONLY (plan-step + plan-goals). Visual verdicts need an image, and
 * headless image attach is not reliable across these CLIs, so supports() rejects
 * 'visual-verdict' — those keep flowing to Nano / API / Ollama. Both planner
 * roles are pure text (the a11y tree / a compact digest), which is exactly what
 * these CLIs do well at their cheap tiers (claude haiku, gpt mini).
 *
 * Spawn recipe mirrors google-cli.ts + auto-fix.ts: the bulky multi-line prompt
 * goes on STDIN (Windows argv can't carry newlines), the binary runs via a shell
 * (the named CLIs are .cmd shims on Windows), `<bin> --version` gates
 * availability, and the JSON is parsed leniently (claude --output-format json
 * wraps the answer in an envelope; codex prints it plain). */

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

  constructor(private readonly opts: CliPlannerOptions) {
    this.name = `cli(${opts.bin}${opts.model ? `:${opts.model}` : ''})`;
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
    return cap === 'plan-step' || cap === 'plan-goals';
  }

  async generateJson(req: JsonRequest): Promise<unknown> {
    if (req.imagePng) throw new Error(`${this.name}: CLI planner does not do visual verdicts`);
    const recipe = RECIPES[this.opts.bin];
    if (!recipe) throw new Error(`${this.name}: no recipe for bin "${this.opts.bin}"`);
    const args = recipe(this.opts.model);
    const stdout = await this.run(args, withSchemaInstruction(req.prompt, req.schema));
    // claude --output-format json → { ..., result: "<assistant text>" }; unwrap it.
    try {
      const env = JSON.parse(stdout.trim()) as { result?: unknown };
      if (env && typeof env.result === 'string') return extractJson(env.result);
    } catch {
      /* not an envelope — fall through to raw parse (codex, plain text) */
    }
    return extractJson(stdout);
  }

  private run(args: string[], stdinText: string): Promise<string> {
    // SECURITY: the model id is the only non-constant token that lands in this
    // shell command, and it can originate from the bridge (vibe.config.set). It is
    // validated where it's set (settings/service), but re-check at the sink —
    // defense in depth means a tainted value never reaches the shell even if a new
    // caller forgets to validate. Failing here makes the router fall to the next rung.
    if (this.opts.model && !isSafeModelId(this.opts.model)) {
      throw new Error(`cli-planner: refusing to run with unsafe model id ${JSON.stringify(this.opts.model)}`);
    }
    // shell:true: the named CLIs are .cmd shims on Windows. Our argv is flags +
    // a (validated) model id, so joining into one command string is safe.
    const command = `${this.opts.bin} ${args.join(' ')}`;
    const timeoutMs = this.opts.timeoutMs ?? 120_000;
    return new Promise((resolve, reject) => {
      const child = spawn(command, { shell: true });
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
