/* Shared shell-out indirection for the OS-native keychain KeyProvider
 * backends (KeychainKeyProvider on macOS, LibsecretKeyProvider on Linux).
 *
 * Mirrors the run()/__setRunner() pattern from
 * src/service/install-service.ts EXACTLY: a swappable module-level function
 * reference is the only thing that ever calls spawnSync, so tests can stub
 * it (via __setShellRunner) and assert the exact file/args/stdin without any
 * real OS/keychain interaction and zero persistence. The one difference from
 * install-service.ts's runner is shape, not pattern: install-service.ts's
 * commands are fire-and-forget (void, throw on failure), but a key provider
 * needs the child's stdout back (to read the stored key) and needs to tell
 * "not installed" apart from "not found" apart from "hard error" — so this
 * runner returns a result object instead of throwing. */

import { spawnSync } from 'node:child_process';

export interface ShellResult {
  /** Process exit status; null if the process could not be spawned at all
   * (e.g. ENOENT — binary not on PATH) or was killed by a signal. */
  status: number | null;
  stdout: string;
  stderr: string;
  /** Set when the command could not be spawned at all (e.g. ENOENT). When
   * set, `status` is meaningless. */
  spawnError?: Error;
}

let runner: (file: string, args: string[], input?: string) => ShellResult = (file, args, input) => {
  const res = spawnSync(file, args, { encoding: 'utf8', input });
  return {
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    spawnError: res.error,
  };
};

/** Test-only: replace the shell runner. Returns the previous runner so a test
 * can restore it afterwards. */
export function __setShellRunner(
  fn: (file: string, args: string[], input?: string) => ShellResult,
): (file: string, args: string[], input?: string) => ShellResult {
  const prev = runner;
  runner = fn;
  return prev;
}

/** Run an external command, capturing output instead of throwing — callers
 * decide what a nonzero status / spawn failure means (e.g. "item not found,
 * fall back" vs "hard error, surface it"). `input`, when given, is written to
 * the child's stdin and the pipe is closed (this is how secret payloads are
 * handed to CLIs that support a stdin form, e.g. `secret-tool store`, instead
 * of ever appearing as a command-line argument). */
export function runShell(file: string, args: string[], input?: string): ShellResult {
  return runner(file, args, input);
}
