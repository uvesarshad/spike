/* A47 (P2) — the CLI's exit-code contract for `run`/`replay` and the
 * top-level catch: 0 pass, 1 verdict fail, 2 uncertain, 3 infra/tool error.
 *
 * Split into its own module (rather than inlined in cli.ts) so it's a small
 * pure function a test can import directly — cli.ts itself has a top-level
 * `program.parseAsync()` side effect that makes IT unsafe to import from a
 * test process.
 */

import type { RunVerdict } from './report/report.js';

/** Exit code for a finished `run`/`replay` verdict — 0/1/2, never anything
 * else. `pass` → 0, `fail` → 1 ("the app is broken"), anything else
 * (`uncertain`) → 2. This is a real verdict outcome, distinct from exit 3
 * below, which means the tool itself never produced a verdict at all. */
export function exitCodeForVerdict(verdict: RunVerdict): 0 | 1 | 2 {
  if (verdict === 'pass') return 0;
  if (verdict === 'fail') return 1;
  return 2;
}

/** Exit code for an error that escaped an action handler unhandled — Chrome
 * failed to launch, a config file was unreadable, a genuine bug threw. This
 * is NEVER a verdict (the run/replay never got far enough to produce one),
 * so it must stay distinguishable from both exit 1 (verdict fail) and exit 2
 * (verdict uncertain) — a CI consumer branching on exit code needs to tell
 * "your app is broken" apart from "the test tool itself couldn't run". */
export const INFRA_ERROR_EXIT_CODE = 3 as const;
