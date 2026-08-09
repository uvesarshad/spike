#!/usr/bin/env node
/* Benchmark harness (audit enhancement 18).
 *
 * `docs/benchmark.md` had exactly one cost measurement and no speed baseline,
 * so every performance claim in the v0.2 audit — "~81% of wall-clock is model
 * latency", "replay is ~16x faster" — was a one-off observation nobody could
 * re-derive. This makes them reproducible.
 *
 * Measures, against the local dogfood fixture:
 *   1. AI pass wall-clock, split into model latency vs everything else
 *   2. Deterministic replay wall-clock of the SAME flow, and the ratio
 *   3. Per-role model call counts (navigator vs brain) — the two-tier claim
 *   4. Flake rate over N consecutive replays
 *
 * Usage: node scripts/benchmark.mjs [--replays 5] [--json]
 *
 * Deliberately NOT a test: it spends real model tokens on the AI pass, so it
 * is never part of `npm test` or CI. Run it when you change the driver loop
 * and want to know whether you made things better or worse.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : args[i + 1];
};
const REPLAYS = parseInt(flag('replays', '3'), 10);
const JSON_OUT = args.includes('--json');
const ROOT = process.cwd();

/* SPIKE_READ_ONLY=0 is load-bearing: `readOnly` defaults to TRUE (a correct
 * safety posture for arbitrary user sites), and without opting out every
 * click/type is silently skipped — the AI pass "runs", records nothing, and
 * the replay leg then measures an EMPTY suite. That produced a meaningless
 * "264x speedup" on the first run of this harness. Same trap the two e2e
 * suites sat in until 2026-08-09 (audit A1). */
const CHILD_ENV = { ...process.env, SPIKE_READ_ONLY: '0' };

const run = (cmd, cmdArgs) =>
  new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(cmd, cmdArgs, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: CHILD_ENV });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out, ms: Date.now() - started }));
  });

const latestReport = () => {
  const dir = path.join(ROOT, 'artifacts');
  if (!fs.existsSync(dir)) return null;
  const runs = fs
    .readdirSync(dir)
    .map((d) => path.join(dir, d, 'report.json'))
    .filter((p) => fs.existsSync(p))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return runs.length ? JSON.parse(fs.readFileSync(runs[0], 'utf8')) : null;
};

const TASK =
  'Log in as test@test.com with password pw, add the Widget to the cart, go to the cart, check out, and place the order. The order must end on a confirmation page.';

console.error('starting fixture…');
const fixture = spawn(process.execPath, ['dist/cli.js', 'fixture', '--bug', 'off'], {
  cwd: ROOT,
  stdio: 'ignore',
  detached: true,
});
fixture.unref();
await new Promise((r) => setTimeout(r, 3000));

const results = { aiPass: null, replay: null, flake: null };

try {
  // ---- 1. AI pass (records a script as a side effect) ----
  console.error('AI pass (spends real tokens)…');
  fs.rmSync(path.join(ROOT, 'generated-tests'), { recursive: true, force: true });
  const ai = await run(process.execPath, [
    'dist/cli.js', 'run', TASK, '--url', 'http://localhost:9401/login', '--no-replay',
  ]);
  const report = latestReport();
  if (report) {
    const trace = report.model_trace ?? [];
    const modelMs = trace.reduce((a, e) => a + (e.ms ?? 0), 0);
    const byRole = {};
    for (const e of trace) byRole[e.capability ?? 'unknown'] = (byRole[e.capability ?? 'unknown'] ?? 0) + 1;
    results.aiPass = {
      verdict: report.verdict,
      steps: report.steps?.length ?? 0,
      wallMs: report.durationMs ?? ai.ms,
      modelMs,
      modelSharePct: report.durationMs ? Math.round((modelMs / report.durationMs) * 1000) / 10 : null,
      calls: trace.length,
      callsByRole: byRole,
      avgCallMs: trace.length ? Math.round(modelMs / trace.length) : 0,
    };
  }

  // ---- 2 + 3. Deterministic replay, repeated (also gives the flake rate) ----
  console.error(`replaying ${REPLAYS}x…`);
  const replayMs = [];
  const verdicts = [];
  for (let i = 0; i < REPLAYS; i++) {
    const r = await run(process.execPath, ['dist/cli.js', 'replay', '--all']);
    replayMs.push(r.ms);
    verdicts.push(r.code === 0 ? 'pass' : r.code === 1 ? 'fail' : 'uncertain');
  }
  const scriptsDir = path.join(ROOT, 'generated-tests');
  const scriptCount = fs.existsSync(scriptsDir) ? fs.readdirSync(scriptsDir).filter((f) => f.endsWith('.json')).length : 0;
  if (scriptCount === 0) {
    // Refuse to report a speedup derived from replaying nothing.
    results.replay = { runs: REPLAYS, error: 'no recorded script — the AI pass did not produce one, so there is nothing to replay' };
    results.flake = { passRate: 0, stable: false, error: 'not measured' };
    throw new Error('benchmark aborted: AI pass recorded no script (did it pass?)');
  }
  const median = [...replayMs].sort((a, b) => a - b)[Math.floor(replayMs.length / 2)];
  results.replay = { runs: REPLAYS, medianMs: median, allMs: replayMs, verdicts };
  if (results.aiPass?.wallMs && median) {
    results.replay.speedupVsAi = Math.round((results.aiPass.wallMs / median) * 10) / 10;
  }
  const passes = verdicts.filter((v) => v === 'pass').length;
  results.flake = {
    passRate: REPLAYS ? passes / REPLAYS : 0,
    // A flow that does not agree with itself across identical runs is flaky,
    // regardless of which way it lands — that is the number a suite owner
    // actually needs, and nothing in the product measured it before.
    stable: passes === REPLAYS || passes === 0,
  };
} finally {
  try { process.kill(-fixture.pid); } catch { try { fixture.kill(); } catch {} }
}

if (JSON_OUT) {
  console.log(JSON.stringify(results, null, 2));
} else {
  const a = results.aiPass;
  const r = results.replay;
  console.log('\n=== spike benchmark ===');
  if (a) {
    console.log(`AI pass      ${a.verdict}, ${a.steps} steps, ${(a.wallMs / 1000).toFixed(1)}s wall`);
    console.log(`  model      ${(a.modelMs / 1000).toFixed(1)}s across ${a.calls} call(s), avg ${a.avgCallMs}ms  → ${a.modelSharePct}% of wall-clock`);
    console.log(`  by role    ${Object.entries(a.callsByRole).map(([k, v]) => `${k}=${v}`).join('  ')}`);
  } else {
    console.log('AI pass      (no report found)');
  }
  if (r) {
    console.log(`replay       median ${(r.medianMs / 1000).toFixed(1)}s over ${r.runs} run(s)  → ${r.speedupVsAi ?? '?'}x faster than the AI pass`);
    console.log(`             verdicts: ${r.verdicts.join(', ')}`);
    console.log(`flake        ${results.flake.stable ? 'stable' : 'FLAKY — identical runs disagreed'} (pass rate ${Math.round(results.flake.passRate * 100)}%)`);
  }
}
