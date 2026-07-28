/* auto-fix — the CLI-coding-agent loop. For users on a real coding agent (Claude
 * Code, Codex, Gemini CLI) the test→fix→retest cycle is AUTOMATED: a failing
 * Report becomes a fix prompt (buildFixPrompt), the prompt is handed to their
 * agent HEADLESSLY, the agent edits the code, and qaRun re-runs until green —
 * no copy-paste, unlike the GUI vibe-coder path (which only synthesizes a
 * paste-ready string).
 *
 * Dispatch recipe (mirrors src/router/adapters/google-cli.ts, where we learned
 * that a multi-line prompt CANNOT cross cmd.exe argv on Windows):
 *   - bins are probed on PATH with `<bin> --version`, shell:true (same as the
 *     google-cli availability check);
 *   - the bulky multi-line fix prompt is delivered via STDIN, never as an argv
 *     token — the '{prompt}' arg is replaced by a SHORT single-line pointer
 *     ('Apply the fix described on stdin.') and the real prompt is piped to the
 *     child's stdin (claude -p / gemini -p both read stdin; codex exec does too);
 *   - for any bin we can't vouch for, we fall back to writing the prompt to a
 *     temp file and pointing the agent at the absolute path.
 *
 * Detection order is claude → codex → gemini (most-capable first). */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { QaConfig } from '../config.js';
import { loadConfig } from '../config.js';
import { qaRun, type QaRunOptions, type QaRunResult } from '../engine.js';
import { buildFixPrompt } from './fix-prompt.js';
import type { Report } from '../report/report.js';

/** Placeholder token inside fixAgentArgs that gets replaced with the prompt
 * pointer (NOT the multi-line prompt itself — see file header). */
export const PROMPT_TOKEN = '{prompt}';

/** Short single-line pointer that replaces PROMPT_TOKEN when the prompt is
 * delivered via stdin. */
const STDIN_POINTER = 'Apply the fix described on stdin.';

/** 15-minute ceiling on a single fix dispatch (a coding agent can churn). */
const FIX_TIMEOUT_MS = 15 * 60_000;

interface AgentSpec {
  bin: string;
  args: string[];
  /** How the real prompt reaches the agent. */
  delivery: 'stdin' | 'file';
}

/** Candidate agents, most-capable first. `delivery: 'stdin'` means the
 * PROMPT_TOKEN arg is swapped for STDIN_POINTER and the prompt is piped in. */
const CANDIDATES: AgentSpec[] = [
  { bin: 'claude', args: ['-p', PROMPT_TOKEN, '--permission-mode', 'acceptEdits'], delivery: 'stdin' },
  { bin: 'codex', args: ['exec', PROMPT_TOKEN], delivery: 'stdin' },
  { bin: 'gemini', args: ['-p', PROMPT_TOKEN, '--approval-mode', 'auto_edit'], delivery: 'stdin' },
];

/** Cache the PATH probe — `null` = not yet probed, value = the resolved result. */
let detectCache: { bin: string; args: string[] } | null | undefined;

/** Does `<bin> --version` exit 0? (same recipe as google-cli's available()). */
function probeBin(bin: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawn(`${bin} --version`, { shell: true, stdio: 'ignore' });
    child.once('error', () => resolve(false));
    child.once('exit', (code) => resolve(code === 0));
  });
}

/**
 * Probe PATH for a usable fix agent (claude → codex → gemini). Returns the bin
 * + the arg template (PROMPT_TOKEN still present — dispatchFix substitutes it),
 * or null if none are installed. The probe is cached process-wide.
 */
export async function detectFixAgent(): Promise<{ bin: string; args: string[] } | null> {
  if (detectCache !== undefined) return detectCache;
  for (const c of CANDIDATES) {
    if (await probeBin(c.bin)) {
      detectCache = { bin: c.bin, args: c.args };
      return detectCache;
    }
  }
  detectCache = null;
  return detectCache;
}

/** Test seam: reset the cached PATH probe (used by v12). */
export function __resetDetectCache(): void {
  detectCache = undefined;
}

/** Resolve the delivery mode for a bin from the candidate table; default to
 * file-pointer for an unknown (config-supplied) bin we can't vouch for. */
function deliveryFor(bin: string): 'stdin' | 'file' {
  const base = path.basename(bin).replace(/\.(cmd|exe|bat)$/i, '');
  return CANDIDATES.find((c) => c.bin === base)?.delivery ?? 'file';
}

export interface DispatchResult {
  ok: boolean;
  agent: string;
  output: string;
}

export interface DispatchOptions {
  config?: Partial<QaConfig>;
  onProgress?: (line: string) => void;
}

/**
 * Hand the fix prompt for `report` to a coding agent headlessly and wait for it
 * to finish editing. Resolves { ok: exit===0, agent, output }.
 *
 * Agent resolution: cfg.fixAgentBin (explicit override) wins; otherwise
 * detectFixAgent() probes PATH; if neither yields a bin we throw an actionable
 * error naming the config field + env var to set.
 */
export async function dispatchFix(report: Report, opts: DispatchOptions = {}): Promise<DispatchResult> {
  const prompt = buildFixPrompt(report);
  if (!prompt) {
    throw new Error('dispatchFix: nothing to fix — the report has no fix prompt (verdict is pass?).');
  }

  const cfg = loadConfig(opts.config ?? {});
  const onProgress = opts.onProgress ?? (() => {});

  // Agent resolution precedence (most specific wins):
  //   1. cfg.fixAgentBin — an explicit override (bin + optional args); always wins.
  //   2. cfg.debugAgent — a SPECIFIC agent the user chose in the panel
  //      ('claude'|'codex'|'gemini'). We pick that CANDIDATES entry directly and
  //      skip PATH detection (if they picked it, run it — let spawn surface a
  //      not-installed error rather than silently falling through to another agent).
  //   3. 'auto' (or no match) — detectFixAgent() probes PATH in claude→codex→gemini order.
  let bin: string;
  let argTemplate: string[];
  const chosen = cfg.debugAgent && cfg.debugAgent !== 'auto'
    ? CANDIDATES.find((c) => c.bin === cfg.debugAgent)
    : undefined;
  if (cfg.fixAgentBin) {
    bin = cfg.fixAgentBin;
    // An override may carry its own args; if it omits PROMPT_TOKEN we still need
    // SOMEWHERE to put the prompt — default to a single PROMPT_TOKEN-bearing arg.
    argTemplate = cfg.fixAgentArgs && cfg.fixAgentArgs.length ? cfg.fixAgentArgs : [PROMPT_TOKEN];
  } else if (chosen) {
    // User pinned a specific agent — use its bin+args, no PATH detection.
    bin = chosen.bin;
    argTemplate = chosen.args;
  } else {
    const detected = await detectFixAgent();
    if (!detected) {
      throw new Error(
        'No fix agent found. Install Claude Code / Codex / Gemini CLI on PATH, or set ' +
          'config.fixAgentBin (env SPIKE_FIX_AGENT_BIN) + config.fixAgentArgs (env SPIKE_FIX_AGENT_ARGS, ' +
          `a JSON array using "${PROMPT_TOKEN}" where the prompt goes).`,
      );
    }
    bin = detected.bin;
    argTemplate = detected.args;
  }

  const delivery = deliveryFor(bin);
  const cwd = cfg.fixAgentCwd ?? process.cwd();

  // Build the real argv: substitute the PROMPT_TOKEN arg (exact equality, never
  // substring — a multi-line prompt must not land in a shell-parsed argv).
  let stdinText: string | undefined;
  let tmpFile: string | undefined;
  let args: string[];

  if (delivery === 'stdin') {
    stdinText = prompt;
    args = argTemplate.map((a) => (a === PROMPT_TOKEN ? STDIN_POINTER : a));
  } else {
    tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-fix-')), 'fix-prompt.txt');
    fs.writeFileSync(tmpFile, prompt, 'utf8');
    const pointer = `Apply the fix described in ${tmpFile}. Read that file first.`;
    args = argTemplate.map((a) => (a === PROMPT_TOKEN ? pointer : a));
  }

  // On Windows the named CLIs are .cmd shims that need a shell (codex/gemini); a
  // native .exe (claude on this machine) or bin 'node' (the test stub) runs
  // WITHOUT one. runAgent picks per-bin (see needsShell): no-shell preserves
  // argv verbatim; the shell path pre-quotes args so spaces survive.
  const agentLabel = bin;
  onProgress(`dispatching fix to ${agentLabel} (cwd ${cwd}, ${delivery} delivery)`);

  try {
    const { code, output } = await runAgent(bin, args, cwd, stdinText, onProgress);
    return { ok: code === 0, agent: agentLabel, output };
  } finally {
    if (tmpFile) {
      try { fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

/** Whether `bin` is a shell shim (.cmd/.bat) that MUST be run via shell:true.
 * Real executables (claude.exe, node, plain names resolved by spawn) run
 * WITHOUT a shell so their argv survives verbatim — critical because under
 * shell:true Node concatenates the args array into a command string with NO
 * quoting, so a space-bearing pointer ('Apply the fix … on stdin.') would be
 * word-split and the agent would see only 'Apply'. */
function needsShell(bin: string): boolean {
  return /\.(cmd|bat)$/i.test(bin);
}

/** Quote an argv token for cmd.exe (only used on the shell:true path). Wraps in
 * double quotes and escapes embedded quotes; our pointer strings carry no quotes
 * so this is mostly the space-guard. */
function cmdQuote(arg: string): string {
  if (arg === '') return '""';
  if (!/[\s"^&|<>()]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}

function runAgent(
  bin: string,
  args: string[],
  cwd: string,
  stdinText: string | undefined,
  onProgress: (line: string) => void,
): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const shell = needsShell(bin);
    // shell:true → hand spawn a single pre-quoted command string so spaces in the
    // pointer survive. Otherwise pass the args array verbatim (perfect fidelity).
    const child = shell
      ? spawn([bin, ...args.map(cmdQuote)].join(' '), { cwd, shell: true })
      : spawn(bin, args, { cwd });
    let output = '';
    let stdoutBuf = '';
    let stderrBuf = '';

    const lineSplit = (buf: string, chunk: string, label: string): string => {
      buf += chunk;
      const parts = buf.split(/\r?\n/);
      buf = parts.pop() ?? '';
      for (const line of parts) {
        output += line + '\n';
        onProgress(label ? `[${label}] ${line}` : line);
      }
      return buf;
    };

    child.stdout?.on('data', (d) => { stdoutBuf = lineSplit(stdoutBuf, String(d), ''); });
    child.stderr?.on('data', (d) => { stderrBuf = lineSplit(stderrBuf, String(d), 'stderr'); });

    if (stdinText !== undefined) child.stdin?.end(stdinText);
    else child.stdin?.end();

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* gone */ }
      reject(new Error(`fix agent ${bin} timed out after ${FIX_TIMEOUT_MS}ms`));
    }, FIX_TIMEOUT_MS);

    child.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      // flush any trailing partial lines
      if (stdoutBuf) { output += stdoutBuf + '\n'; onProgress(stdoutBuf); }
      if (stderrBuf) { output += stderrBuf + '\n'; onProgress(`[stderr] ${stderrBuf}`); }
      resolve({ code: code ?? -1, output });
    });
  });
}

/* ---- the automated loop ---------------------------------------------------- */

export type RunFn = (task: string, url: string, opts?: QaRunOptions) => Promise<QaRunResult>;

export interface RunWithAutoFixOptions {
  /** How many qaRun cycles to attempt (default 2: run, fix, re-run). */
  maxAttempts?: number;
  config?: Partial<QaConfig>;
  onProgress?: (line: string) => void;
  /** Options threaded into every qaRun round (signal, bridge, tabId, …). */
  qaRunOpts?: QaRunOptions;
  /** Injectable runner — defaults to the real qaRun. The v12 test drives it
   * with a fake (fail → pass) to assert the loop sequence with no Chrome. */
  runFn?: RunFn;
}

export interface AutoFixAttempt {
  verdict: Report['verdict'];
  /** True when a fix was dispatched after this attempt's failure. */
  fixed?: boolean;
}

export interface RunWithAutoFixResult {
  finalReport: QaRunResult;
  attempts: AutoFixAttempt[];
}

/**
 * Run the QA task; on failure (with attempts remaining) dispatch the fix prompt
 * to the coding agent, wait for it to edit, then re-run. Records one entry per
 * attempt; returns the final report.
 */
export async function runWithAutoFix(
  task: string,
  url: string,
  opts: RunWithAutoFixOptions = {},
): Promise<RunWithAutoFixResult> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 2);
  const onProgress = opts.onProgress ?? (() => {});
  const run = opts.runFn ?? qaRun;
  const baseOpts: QaRunOptions = { config: opts.config, ...opts.qaRunOpts };

  const attempts: AutoFixAttempt[] = [];
  let finalReport: QaRunResult | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const report = await run(task, url, baseOpts);
    finalReport = report;

    if (report.verdict === 'pass') {
      onProgress(`attempt ${attempt}: pass`);
      attempts.push({ verdict: report.verdict });
      break;
    }

    const last = attempt >= maxAttempts;
    if (last) {
      onProgress(`attempt ${attempt}: ${report.verdict} — no attempts left, giving up`);
      attempts.push({ verdict: report.verdict, fixed: false });
      break;
    }

    // failed and attempts remain → dispatch a fix, then loop to re-run.
    let agentLabel = 'fix agent';
    try {
      onProgress(`attempt ${attempt}: ${report.verdict} → dispatching fix…`);
      const res = await dispatchFix(report, { config: opts.config, onProgress });
      agentLabel = res.agent;
      onProgress(`attempt ${attempt}: ${agentLabel} ${res.ok ? 'finished' : 'exited non-zero'} — re-running test`);
      attempts.push({ verdict: report.verdict, fixed: true });
    } catch (e) {
      onProgress(`attempt ${attempt}: fix dispatch failed: ${e instanceof Error ? e.message : String(e)}`);
      attempts.push({ verdict: report.verdict, fixed: false });
      break; // can't fix → stop; surface the last failing report
    }
  }

  return { finalReport: finalReport!, attempts };
}
