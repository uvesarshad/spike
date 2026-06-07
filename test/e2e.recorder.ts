/* Recorder e2e (R4) — the "AI once → deterministic forever" loop:
 *  1. AI run on the healthy fixture → pass → script recorded (json + spec.ts)
 *  2. qa replay → pass with ZERO planner calls (model_trace empty), seconds not minutes
 *  3. replay against the bug-on fixture → fail with runtime-error evidence
 *  4. replay against drifted UI (v2: renamed button) → fail → --heal re-runs
 *     the AI, re-emits the script → replaying the healed script on v2 passes at $0
 *
 * Two AI runs total (~3 min each on free quota); replays are seconds. */

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { qaReplay, qaRun } from '../src/engine.js';
import { loadScript } from '../src/recorder/script.js';
import { startFixture, stopFixture } from '../fixture/server.js';

const cfg = loadConfig();
const TASK =
  'Log in as test@test.com with password pw, add the Widget to the cart, go to the cart, check out, and place the order. The order must end on a confirmation page.';
const URL = `http://localhost:${cfg.fixturePort}/login`;

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};
const log = (l: string) => console.log(`  ${l}`);

// deterministic slate
fs.rmSync(path.join(process.cwd(), 'generated-tests'), { recursive: true, force: true });

/* 1 — record */
console.log('=== 1/4: AI run on healthy fixture (records the script) ===');
let server = startFixture(cfg.fixturePort, false);
const recorded = await qaRun(TASK, URL, { onProgress: log });
await stopFixture(server);
check('AI run passes', recorded.verdict === 'pass');
check('script recorded', Boolean(recorded.recordedScript && fs.existsSync(recorded.recordedScript)));
const script = loadScript(recorded.recordedScript!);
check('script has resilient targets (role+name, no nodeIds)', script.steps.some((s) => 'target' in s && Boolean(s.target.name)));
check('Playwright twin emitted', fs.existsSync(recorded.recordedScript!.replace(/\.json$/, '.spec.ts')));

/* 2 — $0 replay */
console.log('\n=== 2/4: deterministic replay on healthy fixture ===');
server = startFixture(cfg.fixturePort, false);
const replay = await qaReplay(script.name, { onProgress: log });
await stopFixture(server);
check('replay passes', replay.verdict === 'pass');
check('replay used ZERO planner calls', replay.model_trace.length === 0);
check('replay is fast (<60s, vs minutes for the AI run)', replay.durationMs < 60_000);

/* 3 — replay catches the regression */
console.log('\n=== 3/4: replay against the bug-on fixture ===');
server = startFixture(cfg.fixturePort, true);
const regression = await qaReplay(script.name, { onProgress: log });
await stopFixture(server);
check('replay fails on the regression', regression.verdict === 'fail');
check('regression evidence captured', Boolean(regression.console_error));

/* 4 — UI drift + self-heal */
console.log('\n=== 4/4: UI drift (v2 renames the button) + self-heal ===');
server = startFixture(cfg.fixturePort, false, 'v2');
const healed = await qaReplay(script.name, { heal: true, onProgress: log });
check('self-heal re-ran the AI and passed', healed.healed === true && healed.verdict === 'pass');
const healedScript = loadScript(script.name);
check('script re-emitted with lineage', Boolean(healedScript.healedFrom));
const replayHealed = await qaReplay(script.name, { onProgress: log });
await stopFixture(server);
check('healed script replays at $0 on the drifted UI', replayHealed.verdict === 'pass' && replayHealed.model_trace.length === 0);

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} recorder e2e checks passed`);
process.exit(failed.length ? 1 : 0);
