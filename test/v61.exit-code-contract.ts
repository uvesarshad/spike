/* v61 — A47 (P2): the CLI exit-code contract (0 pass / 1 verdict fail /
 * 2 uncertain / 3 infra-or-tool-error). Pure function checks against
 * src/cli-exit-codes.ts — no AI, no Chrome, no spawning the real CLI process
 * (cli.ts itself can't be safely imported: it has a top-level
 * `program.parseAsync()` side effect).
 *
 *  Run: npx tsx test/v61.exit-code-contract.ts   (exits nonzero on any failed check)
 */

import { exitCodeForVerdict, INFRA_ERROR_EXIT_CODE } from '../src/cli-exit-codes.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

console.log('=== v61: A47 exit-code contract ===');

check('pass -> 0', exitCodeForVerdict('pass') === 0);
check('fail -> 1', exitCodeForVerdict('fail') === 1);
check('uncertain -> 2', exitCodeForVerdict('uncertain') === 2);
check('infra/tool error constant is 3', INFRA_ERROR_EXIT_CODE === 3);
check('the four codes are all distinct', new Set([0, 1, 2, INFRA_ERROR_EXIT_CODE]).size === 4);

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} v61 checks passed`);
process.exit(failed.length ? 1 : 0);
