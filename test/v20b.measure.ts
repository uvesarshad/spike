/* v20b — ONE real measured QA run, fully env-isolated, to populate the launch
 * benchmark (docs/benchmark.md). It:
 *  - starts the healthy fixture on QA_FIXTURE_PORT (9422),
 *  - runs ONE qaRun in cdp mode against a THROWAWAY mkdtemp Chrome profile (so
 *    Nano is unavailable → rung 1 / Google CLI does ALL the work → fully
 *    measured), on its own CDP/runner/fixture ports,
 *  - prints report.tokens + a per-trace usage table, and saves nothing else.
 *
 * Isolation (a parallel agent owns the default 9322 Chrome — stay off it):
 *   QA_CDP_PORT=9342  QA_FIXTURE_PORT=9422  QA_RECORD_CLIP=0
 *   QA_CHROME_PROFILE=<mkdtemp>  QA_RUNNER_PORT=9442
 *
 * Run: npx tsx test/v20b.measure.ts
 * (Needs the gemini CLI logged in + internet; several minutes — each planner
 *  step is a free-quota Flash call.)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-measure-'));
process.env.QA_CDP_PORT = '9342';
process.env.QA_FIXTURE_PORT = '9422';
process.env.QA_RUNNER_PORT = '9442';
process.env.QA_RECORD_CLIP = '0';
process.env.QA_CHROME_PROFILE = PROFILE;

const { loadConfig } = await import('../src/config.js');
const { qaRun } = await import('../src/engine.js');
const { startFixture, stopFixture } = await import('../fixture/server.js');

const cfg = loadConfig();
const TASK =
  'Log in as test@test.com with password pw, add the Widget to the cart, go to the cart, check out, and place the order. The order must end on a confirmation page.';

console.log('=== v20b: one real measured QA run (healthy fixture) ===');
console.log(`profile (throwaway): ${PROFILE}`);
console.log(`cdp ${cfg.cdpPort}  fixture ${cfg.fixturePort}  runner ${cfg.runnerPort}`);
console.log(`model: ${cfg.googleCliBin} / ${cfg.googleCliModel}`);
console.log(`date: ${new Date().toISOString()}\n`);

const server = startFixture(cfg.fixturePort, false);
const started = Date.now();
try {
  const report = await qaRun(TASK, `http://localhost:${cfg.fixturePort}/login`, {
    onProgress: (l) => console.log(`  ${l}`),
  });
  const wall = Date.now() - started;

  console.log('\n----- verdict -----');
  console.log(`verdict: ${report.verdict}`);
  console.log(`reason : ${report.reason}`);
  console.log(`steps  : ${report.steps.length}   durationMs: ${report.durationMs}   wall: ${wall}ms`);

  console.log('\n----- report.tokens -----');
  console.log(JSON.stringify(report.tokens, null, 2));
  console.log(`tokenEstimate (caller pays): ${report.tokenEstimate}`);

  console.log('\n----- per-call model trace -----');
  const hdr = ['step', 'cap', 'rung', 'adapter', 'ms', 'prompt', 'output', 'total', 'cached'];
  console.log(hdr.join('\t'));
  for (const t of report.model_trace) {
    console.log(
      [
        t.step,
        t.capability,
        t.rung,
        t.adapter,
        t.ms,
        t.usage?.promptTokens ?? '-',
        t.usage?.outputTokens ?? '-',
        t.usage?.totalTokens ?? '-',
        t.usage?.cachedTokens ?? '-',
      ].join('\t'),
    );
  }

  // benchmark summary line — copy-paste into docs/benchmark.md
  const plannerCalls = report.model_trace.filter((t) => t.capability === 'plan-step').length;
  const visualCalls = report.model_trace.filter((t) => t.capability === 'visual-verdict').length;
  const rung0 = report.tokens?.callsByRung[0] ?? 0;
  console.log('\n----- benchmark row -----');
  console.log(
    JSON.stringify({
      verdict: report.verdict,
      plannerCalls,
      visualCalls,
      rung0Calls: rung0,
      cheapModelTotal: report.tokens?.cheapModelTotal,
      cheapModelCached: report.tokens?.cheapModelCached,
      callsByRung: report.tokens?.callsByRung,
      verdictPayloadTokens: report.tokens?.verdictPayloadTokens,
      wallMs: wall,
    }),
  );

  process.exit(report.verdict === 'pass' ? 0 : 1);
} finally {
  await stopFixture(server);
}
