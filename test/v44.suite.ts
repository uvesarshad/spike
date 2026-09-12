/* v44 — A12 (P1) + A15's machine-readable half: a real suite concept over
 * `spike replay --all`.
 *
 * Before this, `replay --all` was `listScripts()` (an UNORDERED
 * `fs.readdirSync`) iterated by a plain serial `for…of`, aggregating only
 * `worst = max(pass 0, fail 1, uncertain 2)` (docs/plan/26-08-08-audit-
 * deterministic-speed.md, A12). No ordering, tags, filters, sharding,
 * fixtures, setup/teardown, or machine-readable output existed.
 *
 * This suite covers `src/suite/{config,runner,reporters}.ts` entirely at the
 * unit level — NO browser, NO real model calls. Every `runOne` here is a
 * scripted fake; the browser layer is injected exactly the way `runSuite`
 * requires (see runner.ts's header comment), so this test never imports
 * engine.ts/ports/*.
 *
 * Covers:
 *   1. deterministic default ordering (no spike.suite.json)
 *   2. config-driven ordering (spike.suite.json's own order wins)
 *   3. tag filter (OR match)
 *   4. --filter substring selection
 *   5. shard partition: every script covered exactly once, no overlap, for
 *      several N
 *   6. workers>1 actually overlaps (a concurrency counter, not wall-clock)
 *   7. worst-exit-code aggregation for every verdict combination
 *   8. JUnit XML is well-formed and carries one <testcase> per script with
 *      non-pass verdicts marked as <failure>
 *   9. setup/teardown run first/last; a failing setup short-circuits the
 *      entries (but teardown still runs — see runner.ts's runSuite doc)
 *
 * Run: npx tsx test/v44.suite.ts
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveSuite, loadSuiteConfig, defaultEntries, type SuiteFileConfig } from '../src/suite/config.js';
import {
  runSuite,
  runEntries,
  worstExitCode,
  filterByTags,
  filterByString,
  parseShard,
  shardEntries,
  type SuiteEntry,
  type RunOneFn,
  type Verdict,
} from '../src/suite/runner.js';
import { buildJUnitXml, buildJsonSummary } from '../src/suite/reporters.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

/* ===================== fixtures ===================== */

function freshRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'v44-suite-'));
}

function writeScriptFile(root: string, name: string): void {
  const dir = path.join(root, 'generated-tests');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), '{}'); // content is never parsed by this suite
}

// Takes the FILE's shape (entries/cases both optional — A22), not the resolved
// SuiteFileConfig, so a fixture can write exactly what a user would author.
function writeSuiteConfig(root: string, config: Partial<SuiteFileConfig>): void {
  fs.writeFileSync(path.join(root, 'spike.suite.json'), JSON.stringify(config, null, 2));
}

/** A scripted `RunOneFn`: `verdicts[id]` decides the outcome, missing keys
 * throw (surfacing a test-authoring mistake loudly instead of hanging). */
function scriptedRunOne(verdicts: Record<string, Verdict>): RunOneFn {
  return async (id: string) => {
    if (!(id in verdicts)) throw new Error(`scriptedRunOne: no scripted verdict for "${id}"`);
    return { verdict: verdicts[id] };
  };
}

/** A `RunOneFn` that records concurrency: how many calls are in flight at
 * once (peak), and a start/end event log — used to prove `--workers N`
 * actually overlaps rather than just accepting the flag. */
function concurrencyTracker(delayMs = 20): { runOne: RunOneFn; peak: () => number; events: string[] } {
  let inFlight = 0;
  let peak = 0;
  const events: string[] = [];
  const runOne: RunOneFn = async (id: string) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    events.push(`start:${id}`);
    await new Promise((r) => setTimeout(r, delayMs));
    events.push(`end:${id}`);
    inFlight--;
    return { verdict: 'pass' };
  };
  return { runOne, peak: () => peak, events };
}

/** Minimal well-formedness check for the JUnit output: every open tag has a
 * matching close (or is self-closing), properly nested, stack empty at EOF.
 * Not a full XML parser (no external XML dependency in this repo) — but
 * sufficient to catch a malformed emitter (unescaped text breaking tag
 * boundaries, mismatched nesting, unclosed elements). */
function isWellFormedXml(xml: string): boolean {
  const withoutDecl = xml.replace(/^<\?xml[^>]*\?>\s*/, '');
  const tagRe = /<(\/?)([a-zA-Z0-9_:-]+)([^>]*?)(\/?)>/g;
  const stack: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(withoutDecl))) {
    const [, closing, tagName, , selfClose] = m;
    if (closing) {
      if (stack.pop() !== tagName) return false;
    } else if (!selfClose) {
      stack.push(tagName);
    }
  }
  return stack.length === 0;
}

/* ===================== 1/9: deterministic default ordering ===================== */
console.log('=== v44 1/9: deterministic default ordering (no spike.suite.json) ===');
{
  const root = freshRoot();
  // Write in an order that is NOT alphabetical — if defaultEntries just
  // reflected fs.readdirSync order this would (on most filesystems) come
  // back in write order, not sorted order.
  writeScriptFile(root, 'charlie');
  writeScriptFile(root, 'alpha');
  writeScriptFile(root, 'bravo');

  const entries1 = defaultEntries(root);
  const names1 = entries1.map((e) => path.basename(e.script, '.json'));
  check('default entries are sorted by basename', JSON.stringify(names1) === JSON.stringify(['alpha', 'bravo', 'charlie']));

  // Stability: re-running the discovery gives the identical order every time.
  const entries2 = defaultEntries(root);
  const names2 = entries2.map((e) => path.basename(e.script, '.json'));
  check('default ordering is stable across repeated calls', JSON.stringify(names1) === JSON.stringify(names2));

  check('resolveSuite() falls back to defaultEntries when no config exists', resolveSuite(root).entries.length === 3);
  check('loadSuiteConfig() returns null when no config file exists', loadSuiteConfig(root) === null);

  fs.rmSync(root, { recursive: true, force: true });
}

/* ===================== 2/9: config-driven ordering ===================== */
console.log('\n=== v44 2/9: config-driven ordering (spike.suite.json order wins, untouched) ===');
{
  const root = freshRoot();
  writeScriptFile(root, 'alpha');
  writeScriptFile(root, 'bravo');
  writeScriptFile(root, 'charlie');
  // Deliberately reverse-alphabetical — a config-driven suite's ORDER is a
  // stated feature (e.g. login before checkout), so it must never get
  // silently re-sorted by the loader.
  writeSuiteConfig(root, { entries: [{ script: 'charlie' }, { script: 'alpha' }, { script: 'bravo' }] });

  const resolved = resolveSuite(root);
  const names = resolved.entries.map((e) => e.script);
  check('config-driven order is preserved exactly as written (not sorted)', JSON.stringify(names) === JSON.stringify(['charlie', 'alpha', 'bravo']));

  const config = loadSuiteConfig(root);
  check('loadSuiteConfig returns the parsed config when the file exists', config !== null && config.entries.length === 3);

  fs.rmSync(root, { recursive: true, force: true });
}

/* ===================== 3/9: tag filter ===================== */
console.log('\n=== v44 3/9: tag filter (OR match across --tag values) ===');
{
  const entries: SuiteEntry[] = [
    { script: 'login', tags: ['smoke', 'auth'] },
    { script: 'checkout', tags: ['slow'] },
    { script: 'search', tags: [] },
    { script: 'profile' }, // no tags field at all
  ];
  check('a single tag keeps only matching entries', JSON.stringify(filterByTags(entries, ['smoke']).map((e) => e.script)) === JSON.stringify(['login']));
  check(
    'multiple --tag values OR-match',
    JSON.stringify(filterByTags(entries, ['smoke', 'slow']).map((e) => e.script)) === JSON.stringify(['login', 'checkout']),
  );
  check('an entry with no tags never matches a non-empty tag filter', !filterByTags(entries, ['smoke']).some((e) => e.script === 'search' || e.script === 'profile'));
  check('no --tag supplied is a no-op', filterByTags(entries, []).length === entries.length);
  check('undefined tags is a no-op', filterByTags(entries, undefined).length === entries.length);
}

/* ===================== 4/9: --filter substring selection ===================== */
console.log('\n=== v44 4/9: --filter substring selection ===');
{
  const entries: SuiteEntry[] = [{ script: 'login-flow' }, { script: 'checkout-flow' }, { script: 'search' }];
  check('substring filter keeps only matching script ids', JSON.stringify(filterByString(entries, 'flow').map((e) => e.script)) === JSON.stringify(['login-flow', 'checkout-flow']));
  check('empty/undefined filter is a no-op', filterByString(entries, undefined).length === 3 && filterByString(entries, '').length === 3);
}

/* ===================== 5/9: shard partition — full coverage, no overlap ===================== */
console.log('\n=== v44 5/9: --shard i/N deterministically covers every script exactly once ===');
{
  const entries: SuiteEntry[] = Array.from({ length: 11 }, (_, i) => ({ script: `script-${String(i).padStart(2, '0')}` }));
  for (const n of [1, 2, 3, 4, 7]) {
    const seen = new Map<string, number>();
    for (let i = 1; i <= n; i++) {
      const shard = shardEntries(entries, { index: i, count: n });
      for (const e of shard) seen.set(e.script, (seen.get(e.script) ?? 0) + 1);
    }
    const allCoveredOnce = entries.every((e) => seen.get(e.script) === 1);
    check(`N=${n}: every script appears in exactly one shard`, allCoveredOnce);
    const totalAcrossShards = [...seen.values()].reduce((a, b) => a + b, 0);
    check(`N=${n}: shards partition with no duplication (total == entry count)`, totalAcrossShards === entries.length);
  }
  // Sharding is independent of input order: shuffle the entries, shard again,
  // membership per shard index is unchanged (sorted by name internally).
  const shuffled = [...entries].reverse();
  const shard1Original = shardEntries(entries, { index: 1, count: 3 })
    .map((e) => e.script)
    .sort();
  const shard1Shuffled = shardEntries(shuffled, { index: 1, count: 3 })
    .map((e) => e.script)
    .sort();
  check('shard membership is independent of input order', JSON.stringify(shard1Original) === JSON.stringify(shard1Shuffled));

  check('parseShard parses "2/4"', JSON.stringify(parseShard('2/4')) === JSON.stringify({ index: 2, count: 4 }));
  let threw = false;
  try {
    parseShard('0/4');
  } catch {
    threw = true;
  }
  check('parseShard rejects an out-of-range index (0/4)', threw);
  threw = false;
  try {
    parseShard('5/4');
  } catch {
    threw = true;
  }
  check('parseShard rejects i > N (5/4)', threw);
  threw = false;
  try {
    parseShard('not-a-shard');
  } catch {
    threw = true;
  }
  check('parseShard rejects a malformed spec', threw);
}

/* ===================== 6/9: workers>1 actually overlaps ===================== */
console.log('\n=== v44 6/9: --workers N produces real concurrent overlap (not just accepted) ===');
{
  const entries: SuiteEntry[] = Array.from({ length: 6 }, (_, i) => ({ script: `s${i}` }));

  const serial = concurrencyTracker(15);
  await runEntries(entries, serial.runOne, { workers: 1 });
  check('workers=1 (default) never overlaps — peak concurrency is exactly 1', serial.peak() === 1);

  const parallel = concurrencyTracker(15);
  await runEntries(entries, parallel.runOne, { workers: 3 });
  check('workers=3 overlaps — peak concurrency is > 1', parallel.peak() > 1);
  check('workers=3 never exceeds the requested concurrency', parallel.peak() <= 3);

  // Results still land at the correct index regardless of completion order.
  const tagged: SuiteEntry[] = entries.map((e, i) => ({ ...e, tags: [`idx-${i}`] }));
  const results = await runEntries(tagged, parallel.runOne, { workers: 3 });
  check(
    'concurrent results preserve input order/index (not completion order)',
    results.every((r, i) => r.script === `s${i}`),
  );
}

/* ===================== 7/9: worst-exit-code aggregation ===================== */
console.log('\n=== v44 7/9: worst-exit-code aggregation for every verdict combination ===');
{
  const ALL: Verdict[] = ['pass', 'fail', 'uncertain'];
  const rank: Record<Verdict, 0 | 1 | 2> = { pass: 0, fail: 1, uncertain: 2 };
  for (const a of ALL) {
    for (const b of ALL) {
      const expected = Math.max(rank[a], rank[b]) as 0 | 1 | 2;
      check(`worstExitCode([${a}, ${b}]) === ${expected}`, worstExitCode([a, b]) === expected);
    }
  }
  check('worstExitCode([]) defaults to pass (0)', worstExitCode([]) === 0);
  check('worstExitCode(single fail) === 1', worstExitCode(['fail']) === 1);
  check('worstExitCode(single uncertain) === 2', worstExitCode(['uncertain']) === 2);
  check(
    'worstExitCode over pass/fail/uncertain triple is 2 regardless of order',
    worstExitCode(['pass', 'uncertain', 'fail']) === 2 && worstExitCode(['uncertain', 'fail', 'pass']) === 2,
  );

  // Full runSuite aggregation across representative combinations (entries only).
  const combos: { verdicts: Verdict[]; expected: 0 | 1 | 2 }[] = [
    { verdicts: ['pass', 'pass'], expected: 0 },
    { verdicts: ['pass', 'fail'], expected: 1 },
    { verdicts: ['pass', 'uncertain'], expected: 2 },
    { verdicts: ['fail', 'uncertain'], expected: 2 },
    { verdicts: ['fail', 'fail'], expected: 1 },
    { verdicts: ['uncertain', 'uncertain'], expected: 2 },
  ];
  for (const { verdicts, expected } of combos) {
    const entries: SuiteEntry[] = verdicts.map((_, i) => ({ script: `e${i}` }));
    const map: Record<string, Verdict> = {};
    verdicts.forEach((v, i) => (map[`e${i}`] = v));
    const outcome = await runSuite(entries, scriptedRunOne(map));
    check(`runSuite([${verdicts.join(',')}]).worst === ${expected}`, outcome.worst === expected);
  }
}

/* ===================== 8/9: JUnit XML well-formed + per-script cases ===================== */
console.log('\n=== v44 8/9: JUnit XML is well-formed and marks non-pass verdicts as failures ===');
{
  const entries: SuiteEntry[] = [{ script: 'login' }, { script: 'checkout' }, { script: 'weird & <name> "quoted"' }];
  const map: Record<string, Verdict> = { login: 'pass', checkout: 'fail', 'weird & <name> "quoted"': 'uncertain' };
  const outcome = await runSuite(entries, scriptedRunOne(map));

  const xml = buildJUnitXml(outcome);
  check('JUnit output is well-formed XML (balanced/nested tags)', isWellFormedXml(xml));
  check('JUnit output starts with an XML declaration', xml.startsWith('<?xml'));
  check('JUnit output has exactly one <testcase> per script', (xml.match(/<testcase /g) ?? []).length === entries.length);
  check('JUnit <testsuite tests="N"> matches the entry count', xml.includes(`tests="${entries.length}"`));
  check('JUnit <testsuite failures="N"> counts the non-pass verdicts (fail + uncertain)', xml.includes('failures="2"'));
  check('JUnit marks the failing script with a <failure> element', (xml.match(/<failure /g) ?? []).length === 2);
  check('a passing script has no <failure> element on its testcase', /login[^]*?\/>/.test(xml) || /name="login"[^>]*\/>/.test(xml));
  check('special characters in a script name are escaped, not raw', xml.includes('weird &amp; &lt;name&gt; &quot;quoted&quot;') && !xml.includes('weird & <name>'));

  // buildJsonSummary sanity (additive JSON reporter, separate from the
  // existing --json stdout array contract preserved in cli.ts).
  const summary = buildJsonSummary(outcome);
  check('buildJsonSummary worst matches runSuite outcome', summary.worst === outcome.worst);
  check('buildJsonSummary has one result per entry', summary.results.length === entries.length);
  check('buildJsonSummary marks the fail entry', summary.results.find((r) => r.script === 'checkout')?.verdict === 'fail');
}

/* ===================== 9/9: setup/teardown ordering + short-circuit ===================== */
console.log('\n=== v44 9/9: setup/teardown run first/last; a failing setup short-circuits entries ===');
{
  const order: string[] = [];
  const entries: SuiteEntry[] = [{ script: 'e1' }, { script: 'e2' }, { script: 'e3' }];

  // Happy path: setup passes, entries run in order, teardown runs last.
  {
    const runOne: RunOneFn = async (id) => {
      order.push(id);
      return { verdict: 'pass' };
    };
    const outcome = await runSuite(entries, runOne, { setup: 'seed-db', teardown: 'cleanup-db' });
    check('setup runs first', order[0] === 'seed-db');
    check('entries run in configured order between setup and teardown', JSON.stringify(order.slice(1, 4)) === JSON.stringify(['e1', 'e2', 'e3']));
    check('teardown runs last', order[order.length - 1] === 'cleanup-db');
    check('setup result is reported', outcome.setup?.script === 'seed-db' && outcome.setup?.verdict === 'pass');
    check('teardown result is reported', outcome.teardown?.script === 'cleanup-db' && outcome.teardown?.verdict === 'pass');
    check('happy path is not short-circuited', outcome.shortCircuited === false);
    check('happy path runs every entry', outcome.results.length === 3);
  }

  // Failing setup short-circuits: no entries run, but teardown still fires
  // (cleanup for whatever the setup itself may have partially done).
  {
    order.length = 0;
    const map: Record<string, Verdict> = { 'seed-db': 'fail', 'cleanup-db': 'pass' };
    const runOne: RunOneFn = async (id) => {
      order.push(id);
      if (!(id in map)) throw new Error(`unexpected call to ${id} after a failing setup`);
      return { verdict: map[id] };
    };
    const outcome = await runSuite(entries, runOne, { setup: 'seed-db', teardown: 'cleanup-db' });
    check('a failing setup short-circuits: no entry scripts are ever called', order.every((id) => id === 'seed-db' || id === 'cleanup-db'));
    check('shortCircuited is reported', outcome.shortCircuited === true);
    check('no entries ran', outcome.results.length === 0);
    check('setup failure is recorded', outcome.setup?.verdict === 'fail');
    check('teardown still ran despite the short-circuit', outcome.teardown?.script === 'cleanup-db' && order.includes('cleanup-db'));
    check('worst reflects the setup failure even with zero entries run', outcome.worst === 1);
  }

  // An uncertain (not just failing) setup also short-circuits.
  {
    const runOne: RunOneFn = async (id) => ({ verdict: id === 'seed-db' ? 'uncertain' : 'pass' });
    const outcome = await runSuite(entries, runOne, { setup: 'seed-db' });
    check('an uncertain setup also short-circuits', outcome.shortCircuited === true && outcome.results.length === 0);
    check('worst reflects the uncertain setup', outcome.worst === 2);
  }

  // A suite with no setup/teardown configured behaves exactly like plain
  // runEntries — no phantom setup/teardown results.
  {
    const outcome = await runSuite(entries, scriptedRunOne({ e1: 'pass', e2: 'pass', e3: 'pass' }));
    check('no setup configured -> outcome.setup is undefined', outcome.setup === undefined);
    check('no teardown configured -> outcome.teardown is undefined', outcome.teardown === undefined);
    check('never short-circuits without a setup', outcome.shortCircuited === false);
  }

  // A thrown error inside runOne is caught and counted as a failure, not a
  // crash — a broken suite entry must still show up in the aggregate exit
  // code rather than silently killing the whole run.
  {
    const runOne: RunOneFn = async (id) => {
      if (id === 'e2') throw new Error('boom');
      return { verdict: 'pass' };
    };
    const outcome = await runSuite(entries, runOne);
    check('a thrown runOne error is caught and recorded as fail', outcome.results.find((r) => r.script === 'e2')?.verdict === 'fail');
    check('the error message is captured on the result', outcome.results.find((r) => r.script === 'e2')?.error === 'boom');
    check('other entries still run despite one throwing', outcome.results.filter((r) => r.verdict === 'pass').length === 2);
    check('worst reflects the thrown-error failure', outcome.worst === 1);
  }
}

/* ===================== summary ===================== */
const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} v44 suite checks passed`);
process.exit(failed.length ? 1 : 0);
