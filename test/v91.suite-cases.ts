/* V91 — `spike suite`: hand-writable cases, a working JSON reporter, and
 * `needsAuth` that finally does something (A22, P1).
 *
 * Three separate bugs lived under one finding:
 *
 *   1. A "suite" could only list ALREADY-RECORDED scripts, so authoring one
 *      meant driving every flow through the AI first. There was no way to
 *      write "test this, here" down. `cases: [{name, url, task}]` is that way.
 *   2. `--reporter json --out <path>` was ACCEPTED and wired to nothing:
 *      buildJsonSummary had no caller outside a test, so a CI job asking for a
 *      JSON artifact got no file and a green step.
 *   3. `needsAuth` was schema-validated and then read by nobody — a flow
 *      marked "needs a login" ran anyway and failed.
 *
 * Pure/in-memory: a scratch directory for the config + report files, a
 * scripted runOne for the runner. No Chrome, no model, no network, no ports.
 *
 * Covers:
 *   1. a cases-only / entries-only / mixed suite.json all parse
 *   2. an unknown key and an empty suite are both rejected loudly
 *   3. a suite with one failing case exits 1 (the whole point of an exit code)
 *   4. `--reporter json --out` writes a real file with the right shape
 *   5. the junit reporter still writes, and missing parent dirs are created
 *   6. needsAuth skips without a storage state and runs with one
 *   7. `expect: 'fail'` holds a known-broken flow red-side-up
 *   8. the CLI wires all of it up (command registered, reporter shared)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyExpectation, loadSuiteConfig, resolveSuite, skipsForMissingAuth, SUITE_CONFIG_FILENAME } from '../src/suite/config.js';
import { runSuite, type RunOneFn, type Verdict } from '../src/suite/runner.js';
import { buildJsonSummary, isSuiteReporter, writeSuiteReport, type SuiteJsonSummary } from '../src/suite/reporters.js';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'spike-v91-'));
const freshRoot = (): string => fs.mkdtempSync(path.join(scratch, 'root-'));
function writeSuite(root: string, config: unknown): void {
  fs.writeFileSync(path.join(root, SUITE_CONFIG_FILENAME), JSON.stringify(config, null, 2));
}

/* ---------- 1. the schema ---------- */
console.log('\n=== v91 1/8: a suite can be written by hand ===');
{
  const root = freshRoot();
  writeSuite(root, {
    cases: [
      { name: 'checkout', url: 'http://localhost:9401/login', task: 'log in and complete checkout' },
      { name: 'signup rejects a bad email', url: 'http://localhost:9401/', task: 'check the signup form rejects "nope"', tags: ['smoke'], expect: 'pass' },
    ],
  });
  const cfg = loadSuiteConfig(root);
  check('a cases-only suite parses', cfg !== null && cfg.cases.length === 2);
  check('entries defaults to an empty list, never undefined', Array.isArray(cfg?.entries) && cfg?.entries.length === 0);
  check('a case keeps its name, url and task', cfg?.cases[0].name === 'checkout' && cfg?.cases[0].url.includes('9401') && cfg?.cases[0].task.startsWith('log in'));
  check('a case can carry tags', JSON.stringify(cfg?.cases[1].tags) === JSON.stringify(['smoke']));
}
{
  const root = freshRoot();
  writeSuite(root, { entries: [{ script: 'checkout' }], cases: [{ name: 'smoke', url: 'http://x.test', task: 'look around' }] });
  const cfg = loadSuiteConfig(root);
  check('cases and entries can coexist in one file', cfg?.cases.length === 1 && cfg?.entries.length === 1);
}
{
  const root = freshRoot();
  writeSuite(root, { entries: [{ script: 'checkout' }] });
  const cfg = loadSuiteConfig(root);
  check('an entries-only suite still parses (no regression)', cfg?.entries.length === 1);
  check('cases defaults to an empty list', Array.isArray(cfg?.cases) && cfg?.cases.length === 0);
}
{
  const root = freshRoot();
  check('no suite file at all resolves to the sorted default, with no cases', resolveSuite(root).cases.length === 0);
}

/* ---------- 2. bad files fail loudly ---------- */
console.log('\n=== v91 2/8: a malformed suite fails loudly ===');
{
  const root = freshRoot();
  writeSuite(root, { cases: [{ name: 'x', url: 'http://x.test', task: 'go', expect: 'maybe' }] });
  let msg = '';
  try { loadSuiteConfig(root); } catch (e) { msg = (e as Error).message; }
  check('an invalid expect value is rejected', msg.includes('invalid') && msg.includes('expect'));
}
{
  const root = freshRoot();
  writeSuite(root, { cases: [{ name: 'x', url: 'http://x.test', task: 'go', retries: 3 }] });
  let threw = false;
  try { loadSuiteConfig(root); } catch { threw = true; }
  check('an unknown key on a case is rejected (strict schema)', threw);
}
{
  const root = freshRoot();
  writeSuite(root, {});
  let msg = '';
  try { loadSuiteConfig(root); } catch (e) { msg = (e as Error).message; }
  check('a suite with neither cases nor entries is rejected, not run as zero tests', msg.includes('at least one test'));
}
{
  const root = freshRoot();
  writeSuite(root, { cases: [{ name: 'x', task: 'go' }] });
  let threw = false;
  try { loadSuiteConfig(root); } catch { threw = true; }
  check('a case with no url is rejected', threw);
}

/* ---------- 3. exit code ---------- */
console.log('\n=== v91 3/8: one failing case reddens the suite ===');
const scripted = (verdicts: Record<string, Verdict>): RunOneFn => async (id) => {
  const v = verdicts[id];
  if (!v) throw new Error(`v91: no scripted verdict for "${id}"`);
  return { verdict: v };
};
let failingOutcome!: Awaited<ReturnType<typeof runSuite>>;
{
  const entries = [{ script: 'checkout' }, { script: 'signup' }, { script: 'search' }];
  failingOutcome = await runSuite(entries, scripted({ checkout: 'pass', signup: 'fail', search: 'pass' }));
  check('a suite with one failing case exits 1', failingOutcome.worst === 1);
  check('the passing cases are still reported', failingOutcome.results.filter((r) => r.verdict === 'pass').length === 2);

  const allPass = await runSuite(entries, scripted({ checkout: 'pass', signup: 'pass', search: 'pass' }));
  check('an all-passing suite exits 0', allPass.worst === 0);

  const uncertain = await runSuite(entries, scripted({ checkout: 'pass', signup: 'uncertain', search: 'pass' }));
  check('an uncertain case exits 2, not 0', uncertain.worst === 2);
}

/* ---------- 4. the JSON reporter actually writes ---------- */
console.log('\n=== v91 4/8: --reporter json --out writes a real file ===');
{
  const out = path.join(scratch, 'reports', 'suite.json');
  check('the report path does not exist beforehand', !fs.existsSync(out));
  const written = writeSuiteReport(failingOutcome, 'json', out, 'spike suite');
  check('writeSuiteReport returns the path it wrote', written === out);
  check('the file exists afterwards', fs.existsSync(out));
  check('a missing parent directory is created', fs.existsSync(path.dirname(out)));

  const parsed = JSON.parse(fs.readFileSync(out, 'utf8')) as SuiteJsonSummary;
  check('the file is the buildJsonSummary shape', JSON.stringify(parsed) === JSON.stringify(buildJsonSummary(failingOutcome)));
  check('it carries the suite-level exit code', parsed.worst === 1);
  check('it carries one entry per test', parsed.results.length === 3);
  check('each entry names the test and its verdict', parsed.results.every((r) => typeof r.script === 'string' && ['pass', 'fail', 'uncertain'].includes(r.verdict)));
  check('each entry carries a duration', parsed.results.every((r) => typeof r.durationMs === 'number'));
  check('the failing test is identifiable in the artifact', parsed.results.some((r) => r.script === 'signup' && r.verdict === 'fail'));
  check('shortCircuited is reported', parsed.shortCircuited === false);
}

/* ---------- 5. junit + reporter validation ---------- */
console.log('\n=== v91 5/8: the junit reporter and the flag guard ===');
{
  const out = path.join(scratch, 'reports', 'nested', 'deeper', 'junit.xml');
  writeSuiteReport(failingOutcome, 'junit', out);
  const xml = fs.readFileSync(out, 'utf8');
  check('junit still writes through the shared writer', xml.startsWith('<?xml') && xml.includes('<testsuite '));
  check('junit marks the failing test', xml.includes('<failure'));
  check('deeply nested parent directories are created', fs.existsSync(out));

  check('"json" is a known reporter', isSuiteReporter('json'));
  check('"junit" is a known reporter', isSuiteReporter('junit'));
  check('"tap" is not', !isSuiteReporter('tap'));
}

/* ---------- 6. needsAuth ---------- */
console.log('\n=== v91 6/8: needsAuth is consumed, not decoration ===');
{
  const items = [
    { name: 'public page', needsAuth: false },
    { name: 'dashboard', needsAuth: true },
    { name: 'pricing' },
  ];
  const without = skipsForMissingAuth(items, false);
  check('a needsAuth test is skipped with no storage state', without.skipped.length === 1 && without.skipped[0].name === 'dashboard');
  check('tests that do not need auth still run', without.run.length === 2);

  const withAuth = skipsForMissingAuth(items, true);
  check('nothing is skipped once a storage state is supplied', withAuth.skipped.length === 0 && withAuth.run.length === 3);
  check('a skipped test is separated out, never silently dropped', without.run.length + without.skipped.length === items.length);
}

/* ---------- 7. expect ---------- */
console.log('\n=== v91 7/8: expect holds a known-broken flow red-side-up ===');
{
  check('expect defaults to pass — a passing run passes', applyExpectation('pass') === 'pass');
  check('expect defaults to pass — a failing run fails', applyExpectation('fail') === 'fail');
  check('expect:fail — the flow still failing counts as a pass', applyExpectation('fail', 'fail') === 'pass');
  check('expect:fail — the flow going green turns the suite red', applyExpectation('pass', 'fail') === 'fail');
  check('expect:fail — "could not tell" is never evidence it is still broken', applyExpectation('uncertain', 'fail') === 'uncertain');
  check('expect:pass leaves uncertain alone', applyExpectation('uncertain', 'pass') === 'uncertain');
}

/* ---------- 8. the CLI wiring ---------- */
console.log('\n=== v91 8/8: the command is actually wired up ===');
{
  const cli = fs.readFileSync(path.join(REPO_ROOT, 'src', 'cli.ts'), 'utf8');
  check('a `suite` command is registered', /\.command\('suite'\)/.test(cli));
  check('cases go through qaRun', /kind === 'entry'[\s\S]{0,1400}qaRun\(/.test(cli));
  check('entries go through qaReplay', /qaReplay\(item \?/.test(cli));
  check('both suite paths share --storage-state', (cli.match(/--storage-state <path>/g) ?? []).length >= 3);
  check('replay --all no longer ignores --reporter json', !/fs\.writeFileSync\(opts\.out, buildJUnitXml/.test(cli) && /emitSuiteReport\(outcome, opts\.reporter, opts\.out/.test(cli));
  check('asking for a report with no --out is an error, never a quiet no-op', /requires --out <path>/.test(cli));
  check('the skip message tells the user how to include those tests', /pass --storage-state <file> to include/.test(cli));
}

try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }

const failed = checks.filter(([, ok]) => !ok);
console.log(`\nv91: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) {
  console.error('FAILED: ' + failed.map(([l]) => l).join(', '));
  process.exit(1);
}
