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
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import type { QaConfig } from '../config.js';
import { loadConfig } from '../config.js';
import { qaRun, type QaRunOptions, type QaRunResult } from '../engine.js';
import { buildFixPrompt } from './fix-prompt.js';
import { captureBeforeFix, waitForRebuild, type RebuildWaitOptions } from './rebuild-wait.js';
import { SettingsStore, type QaSettings } from './settings.js';
import type { Report } from '../report/report.js';

/** Placeholder token inside fixAgentArgs that gets replaced with the prompt
 * pointer (NOT the multi-line prompt itself — see file header). */
export const PROMPT_TOKEN = '{prompt}';

/** Short single-line pointer that replaces PROMPT_TOKEN when the prompt is
 * delivered via stdin. */
const STDIN_POINTER = 'Apply the fix described on stdin.';

/** 15-minute ceiling on a single fix dispatch (a coding agent can churn). */
const FIX_TIMEOUT_MS = 15 * 60_000;

/* ---- A16: one-time per-project consent gate before an unattended edit ------
 *
 * dispatchFix hands the fix prompt to a coding agent running WITH edit
 * permissions (`claude -p --permission-mode acceptEdits`, `gemini
 * --approval-mode auto_edit`, …) — it edits files on disk with nobody
 * reviewing the diff first. The FIRST time that happens for a given project
 * directory, we require an explicit human confirmation:
 *   - interactive TTY (stdin+stdout both TTYs — the common case for
 *     `spike run --fix` / `spike fix --apply` typed at a terminal): ask y/N.
 *   - non-TTY (CI, a daemon child, a script): refuse unless the caller already
 *     vouches for consent via `yesAutoFix` (intended for a CLI `--yes-auto-fix`
 *     flag) or `confirmed` (intended for an explicit panel/bridge confirm —
 *     `vibe.fix { confirmed: true }`). Neither flag is wired into cli.ts /
 *     service.ts yet (out of scope here — see auto-fix.ts's module header);
 *     this gate is the enforcement point they need to call into once they are.
 * Acceptance is remembered per PROJECT DIRECTORY (not per run) in the
 * SettingsStore, so it's asked at most once per project. QaSettings
 * (settings-data.ts) doesn't declare this field — out of scope to edit here —
 * so it's read/written through an explicit cast, isolated to this block. */

interface AutoFixSettingsExt {
  /** Absolute project directories that have already confirmed 'auto' mode. */
  autoFixAcceptedDirs?: string[];
}

function projectKey(cwd: string): string {
  return path.resolve(cwd);
}

function readAcceptedDirs(store: SettingsStore): string[] {
  const raw = store.readRaw() as unknown as AutoFixSettingsExt;
  return Array.isArray(raw.autoFixAcceptedDirs) ? raw.autoFixAcceptedDirs : [];
}

function isAutoFixAccepted(store: SettingsStore, cwd: string): boolean {
  return readAcceptedDirs(store).includes(projectKey(cwd));
}

/**
 * A11: has this project directory already been accepted for unattended edits?
 *
 * The bridge/panel path needs to ASK this question before it dispatches, because
 * it has no terminal to fall back to: a caller with no confirmation and no prior
 * acceptance must be answered with a "please confirm" payload the side panel can
 * render, not left waiting on a y/N prompt nobody will ever see. Same per-project
 * store as ensureAutoFixConfirmed's own check — this is a read-only peek at it.
 */
export function isAutoFixAcceptedFor(cwd: string, store?: SettingsStore): boolean {
  try {
    return isAutoFixAccepted(store ?? new SettingsStore(), cwd);
  } catch {
    return false;
  }
}

function recordAutoFixAcceptance(store: SettingsStore, cwd: string): void {
  const key = projectKey(cwd);
  const dirs = new Set(readAcceptedDirs(store));
  if (dirs.has(key)) return;
  dirs.add(key);
  store.write({ autoFixAcceptedDirs: Array.from(dirs) } as unknown as Partial<QaSettings>);
}

/** Real interactive y/N prompt against process.stdin/stdout (only reached when
 * both are TTYs). Test seam: pass `promptFn` in AutoFixConfirmOptions instead. */
function defaultPromptFn(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

export interface AutoFixConfirmOptions {
  /** Project directory this dispatch edits — the confirmation is remembered
   * per directory. Defaults to cfg.fixAgentCwd ?? process.cwd(). */
  cwd?: string;
  /** CLI: --yes-auto-fix — pre-accept for a non-interactive invocation. */
  yesAutoFix?: boolean;
  /** Bridge/panel: the human already confirmed via an explicit UI control. */
  confirmed?: boolean;
  /** Test seam: an injected SettingsStore instead of the default per-machine one. */
  settingsStore?: SettingsStore;
  /** Test seam: replace the interactive y/N prompt. */
  promptFn?: (question: string) => Promise<boolean>;
  /** Test seam: override the real `stdin/stdout are TTYs` detection so the TTY
   * and non-TTY branches are deterministically testable regardless of how the
   * test runner itself is invoked. Undefined (the default) uses the real check. */
  interactive?: boolean;
}

/** Thrown when 'auto' mode can't proceed without a human confirming first
 * (declined, or non-interactive with no consent flag). */
export class AutoFixNotConfirmedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AutoFixNotConfirmedError';
  }
}

/**
 * Gate an unattended file-editing dispatch behind one-time-per-project human
 * consent. Resolves silently once consent is established (a prior acceptance
 * already on file, a fresh y/N accept, or an explicit `confirmed`/`yesAutoFix`
 * flag); throws AutoFixNotConfirmedError when consent can't be obtained.
 */
export async function ensureAutoFixConfirmed(opts: AutoFixConfirmOptions = {}): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const store = opts.settingsStore ?? new SettingsStore();

  if (isAutoFixAccepted(store, cwd)) return;

  if (opts.confirmed === true || opts.yesAutoFix === true) {
    recordAutoFixAcceptance(store, cwd);
    return;
  }

  const interactive = opts.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (interactive) {
    const ask = opts.promptFn ?? defaultPromptFn;
    const accepted = await ask(
      `\nspike auto-fix will let a coding agent edit files in ${cwd} without further confirmation ` +
        `(asked once per project). Continue? [y/N] `,
    );
    if (accepted) {
      recordAutoFixAcceptance(store, cwd);
      return;
    }
    throw new AutoFixNotConfirmedError(`auto-fix declined for ${cwd}`);
  }

  throw new AutoFixNotConfirmedError(
    `auto-fix needs a one-time confirmation for ${cwd} (non-interactive session, so no y/N prompt is possible) — ` +
      'pass --yes-auto-fix (CLI) or confirmed:true (panel/bridge) once to accept it, ' +
      'or run the fix interactively (a real terminal) once first.',
  );
}

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
  /** A16 one-time-per-project consent gate — see ensureAutoFixConfirmed.
   * `confirmed`/`yesAutoFix` are the two ways a caller can vouch for consent
   * in a non-interactive session; `settingsStore`/`promptFn` are test seams. */
  confirmed?: boolean;
  yesAutoFix?: boolean;
  settingsStore?: SettingsStore;
  promptFn?: (question: string) => Promise<boolean>;
  interactive?: boolean;
  /** A11 (P0): the folder to fall back on when no project folder is configured.
   * Supplied ONLY by the command line, where the working directory the user
   * typed the command in IS an explicit choice. The panel path deliberately
   * passes nothing: the desktop helper starts at login from an arbitrary
   * directory, so falling back to it would let a coding agent edit the wrong
   * repo. With neither, dispatchFix refuses instead of guessing. */
  defaultCwd?: string;
}

/** A11: what the user is told when no project folder is configured. Plain, and
 * it names the one place they can fix it. */
export const NO_PROJECT_FOLDER_MESSAGE =
  "Spike doesn't know which project folder to fix. Open Settings and set your project folder — " +
  'the folder on this computer that holds the code for the site you are testing.';

/**
 * Hand the fix prompt for `report` to a coding agent headlessly and wait for it
 * to finish editing. Resolves { ok: exit===0, agent, output }.
 *
 * Agent resolution: cfg.fixAgentBin (explicit override) wins; otherwise
 * detectFixAgent() probes PATH; if neither yields a bin we throw an actionable
 * error naming the config field + env var to set.
 *
 * Before any of that: ensureAutoFixConfirmed() gates the whole dispatch behind
 * one-time-per-project human consent (A16) — this is the single choke point
 * where files actually get edited unattended, so every caller (the `--fix`
 * loop below, `spike fix --apply`, the panel's auto-fix button) goes through
 * it, throwing AutoFixNotConfirmedError rather than spawning anything.
 */
export async function dispatchFix(report: Report, opts: DispatchOptions = {}): Promise<DispatchResult> {
  const prompt = buildFixPrompt(report);
  if (!prompt) {
    throw new Error('dispatchFix: nothing to fix — the report has no fix prompt (verdict is pass?).');
  }

  const cfg = loadConfig(opts.config ?? {});
  const onProgress = opts.onProgress ?? (() => {});

  // A11 (P0): never guess the project folder. process.cwd() used to be the
  // silent fallback, which for a helper started at login is whatever directory
  // it happened to inherit — a coding agent pointed there edits the wrong repo
  // (or nothing at all). Refuse and say what to do instead.
  const projectDir = cfg.fixAgentCwd ?? opts.defaultCwd;
  if (!projectDir) throw new Error(NO_PROJECT_FOLDER_MESSAGE);

  await ensureAutoFixConfirmed({
    cwd: projectDir,
    confirmed: opts.confirmed,
    yesAutoFix: opts.yesAutoFix,
    settingsStore: opts.settingsStore,
    promptFn: opts.promptFn,
    interactive: opts.interactive,
  });

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
  const cwd = projectDir;

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
  /** A16 consent-gate passthrough for the dispatchFix call each failed attempt
   * makes — see ensureAutoFixConfirmed. */
  confirmed?: boolean;
  yesAutoFix?: boolean;
  settingsStore?: SettingsStore;
  promptFn?: (question: string) => Promise<boolean>;
  interactive?: boolean;
  /** A11: command-line fallback project folder — see DispatchOptions.defaultCwd. */
  defaultCwd?: string;
  /** A6: also dispatch a fix when the result is `uncertain`. Default false —
   * an uncertain run may not be a bug at all, and "fixing" code that wasn't
   * broken is worse than doing nothing. CLI: `--fix-on-uncertain`. */
  fixOnUncertain?: boolean;
  /** A6: how to wait for the fix to show up before re-testing. */
  rebuild?: RebuildWaitOptions;
  /** A6: skip the first run — the caller already has a failing report (the
   * panel's "Auto-fix" button re-tests the run it just showed). */
  initialReport?: QaRunResult;
  /** Injectable dispatcher — defaults to the real dispatchFix. */
  dispatchFn?: (report: QaRunResult, opts: DispatchOptions) => Promise<{ ok: boolean; agent: string }>;
}

export interface AutoFixAttempt {
  verdict: Report['verdict'];
  /** True when a fix was dispatched after this attempt's failure. */
  fixed?: boolean;
}

export interface RunWithAutoFixResult {
  finalReport: QaRunResult;
  attempts: AutoFixAttempt[];
  /** A6: set when the final result was produced after a wait that could not
   * confirm the page rebuilt (it is also appended to finalReport.reason). */
  rebuildNote?: string;
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

  const dispatch = opts.dispatchFn ?? dispatchFix;
  const attempts: AutoFixAttempt[] = [];
  let finalReport: QaRunResult | undefined;
  let staleNote: string | undefined;
  let appliedNote: string | undefined;
  let pending: QaRunResult | undefined = opts.initialReport;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let report = pending ?? (await run(task, url, baseOpts));
    pending = undefined;
    // A6: a re-test that ran after a wait we could not confirm may be for the
    // old version — say so on the report itself, not just in the progress log.
    appliedNote = undefined;
    if (staleNote && attempt > 1) {
      appliedNote = staleNote;
      report = { ...report, reason: report.reason ? `${report.reason} (${staleNote})` : staleNote };
    }
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

    // A6: only a `fail` is a bug worth editing code for.
    if (report.verdict !== 'fail' && !opts.fixOnUncertain) {
      onProgress(`attempt ${attempt}: ${report.verdict} — not a confirmed failure, so no fix was dispatched (--fix-on-uncertain changes that)`);
      attempts.push({ verdict: report.verdict, fixed: false });
      break;
    }

    // failed and attempts remain → dispatch a fix, then loop to re-run.
    let agentLabel = 'fix agent';
    try {
      onProgress(`attempt ${attempt}: ${report.verdict} → dispatching fix…`);
      const before = await captureBeforeFix(url, opts.rebuild);
      const res = await dispatch(report, {
        config: opts.config,
        onProgress,
        defaultCwd: opts.defaultCwd,
        confirmed: opts.confirmed,
        yesAutoFix: opts.yesAutoFix,
        settingsStore: opts.settingsStore,
        promptFn: opts.promptFn,
        interactive: opts.interactive,
      });
      agentLabel = res.agent;
      onProgress(`attempt ${attempt}: ${agentLabel} ${res.ok ? 'finished' : 'exited non-zero'} — waiting for the change to show up`);
      const waited = await waitForRebuild(url, before, { onProgress, ...opts.rebuild });
      staleNote = waited.confirmed ? undefined : waited.note;
      if (staleNote) onProgress(`attempt ${attempt}: ${staleNote}`);
      onProgress(`attempt ${attempt}: re-running test`);
      attempts.push({ verdict: report.verdict, fixed: true });
    } catch (e) {
      onProgress(`attempt ${attempt}: fix dispatch failed: ${e instanceof Error ? e.message : String(e)}`);
      attempts.push({ verdict: report.verdict, fixed: false });
      break; // can't fix → stop; surface the last failing report
    }
  }

  return { finalReport: finalReport!, attempts, ...(appliedNote && { rebuildNote: appliedNote }) };
}
