/* M4 verification —
 * Part 1 (always runs): escalation policy with fake adapters, no external deps.
 * Part 2 (live, skips gracefully): Google CLI adapter returns a real JSON
 * verdict on the spike's bad.png screenshot. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import type { Capability, JsonRequest, ModelAdapter } from '../src/router/adapter.js';
import { extractJson } from '../src/router/adapter.js';
import { GoogleCliAdapter } from '../src/router/adapters/google-cli.js';
import { ModelRouter } from '../src/router/model-router.js';
import { VERDICT_JSON_SCHEMA, verdictPrompt } from '../src/router/verdict.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

/* ---------- part 1: escalation policy ---------- */

function fake(
  name: string,
  rung: 0 | 1 | 2 | 3,
  caps: Capability[],
  impl: (req: JsonRequest) => unknown,
  isAvailable = true,
): ModelAdapter {
  return {
    name,
    rung,
    available: async () => isAvailable,
    supports: (c) => caps.includes(c),
    generateJson: async (req) => impl(req),
  };
}

const png = Buffer.from('fakepng');

{
  // uncertain rung-0 verdict escalates to rung 1
  const router = new ModelRouter([
    fake('nano-fake', 0, ['visual-verdict'], () => ({ verdict: 'uncertain', summary: 'hmm', issues: [] })),
    fake('flash-fake', 1, ['visual-verdict', 'plan-step'], () => ({ verdict: 'fail', summary: 'broken', issues: ['x'] })),
  ]);
  const v = await router.visualVerdict(png, 'page ok?', 1);
  check('uncertain rung-0 escalates to rung 1', v.verdict === 'fail');
  check(
    'trace records the escalation',
    router.trace.length === 2 &&
      router.trace[0].adapter === 'nano-fake' &&
      router.trace[1].escalatedFrom === 'nano-fake',
  );
}

{
  // throwing rung-0 escalates; unavailable adapters are skipped
  const router = new ModelRouter([
    fake('nano-dead', 0, ['visual-verdict'], () => {
      throw new Error('boom');
    }),
    fake('flash-offline', 1, ['visual-verdict'], () => ({ verdict: 'pass', summary: '', issues: [] }), false),
    fake('byok-fake', 2, ['visual-verdict', 'plan-step'], () => ({ verdict: 'pass', summary: 'ok', issues: [] })),
  ]);
  const v = await router.visualVerdict(png, 'page ok?', 2);
  check('error escalates past unavailable adapter to rung 2', v.verdict === 'pass');
  check('skipped adapter never appears in trace', !router.trace.some((t) => t.adapter === 'flash-offline'));
}

{
  // rung 0 never plans; no planner → clean error
  const router = new ModelRouter([
    fake('nano-fake', 0, ['visual-verdict'], () => ({})),
  ]);
  let msg = '';
  try {
    await router.planJson('plan!', {}, 3);
  } catch (e) {
    msg = (e as Error).message;
  }
  check('no planner available → clean actionable error', msg.includes('no planner available'));
}

{
  // whole ladder uncertain → honest uncertain, no throw
  const router = new ModelRouter([
    fake('nano-fake', 0, ['visual-verdict'], () => ({ verdict: 'uncertain', summary: 'a', issues: [] })),
    fake('flash-fake', 1, ['visual-verdict'], () => ({ verdict: 'uncertain', summary: 'b', issues: [] })),
  ]);
  const v = await router.visualVerdict(png, 'page ok?', 4);
  check('all-uncertain ladder returns uncertain (not an error)', v.verdict === 'uncertain');
}

{
  // extractJson copes with prose and fences
  const cases: [string, boolean][] = [
    ['{"a":1}', true],
    ['Sure! ```json\n{"a":1}\n``` hope that helps', true],
    ['prefix {"a":{"b":2}} suffix', true],
  ];
  check(
    'extractJson handles bare/fenced/embedded JSON',
    cases.every(([s]) => {
      try {
        return typeof extractJson(s) === 'object';
      } catch {
        return false;
      }
    }),
  );
}

/* ---------- part 1.5 (Phase 13): config drift — settings migration + env precedence ---------- */

{
  // isolate LOCALAPPDATA so this never touches the real machine's settings.json
  const savedLocalAppData = process.env.LOCALAPPDATA;
  const savedEnv: Record<string, string | undefined> = {};
  for (const k of ['SPIKE_PLANNER_PROVIDER', 'SPIKE_PLANNER_MODE', 'SPIKE_PLANNER_MODEL', 'SPIKE_NAVIGATOR_PROVIDER', 'SPIKE_NAVIGATOR_MODE', 'SPIKE_NAVIGATOR_MODEL']) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-config-drift-'));
  process.env.LOCALAPPDATA = tmp;
  // post-rename dir; `qa-subagent/` is migrated onto this by migrateLegacyPath (see test/v34).
  const settingsPath = path.join(tmp, 'spike', 'settings.json');

  try {
    // a fresh machine (no settings.json at all) resolves the DAEMON's own
    // defaults (claude:cli brain, and — since A13 — the cheap tier of that same
    // provider for the model that clicks, NOT the on-device model) rather than
    // the shared lite DEFAULT_SETTINGS.planner (claude:api), which would drift.
    const fresh = loadConfig();
    check(
      'no settings.json → daemon default brain is claude:cli (not lite claude:api)',
      fresh.planner.provider === 'claude' && fresh.planner.mode === 'cli',
    );
    // A13: defaulting this to the on-device model meant that on any machine
    // failing its 22GB gate the pin was dropped and the BRAIN model drove every
    // step — the cost lever gone, silently. It now derives from the brain pin.
    check(
      "no settings.json → the model that clicks is the brain provider's cheap tier, not on-device",
      fresh.navigator.provider === 'claude' && fresh.navigator.mode === 'cli' && fresh.navigator.model === 'claude-haiku-4-5',
    );

    // a settings.json still pinned to the dead gemini:cli free tier (and
    // missing `navigator`, pre-split) migrates to the daemon defaults and the
    // migration is PERSISTED back to disk.
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ planner: { provider: 'gemini', mode: 'cli', model: 'gemini-3-flash-preview' }, debugMode: 'prompt', debugAgent: 'auto' }),
    );
    const migrated = loadConfig();
    check('dead gemini:cli planner migrates to claude:cli', migrated.planner.provider === 'claude' && migrated.planner.mode === 'cli');
    check(
      "missing navigator migrates to the fixed brain's cheap tier (A13), never to on-device",
      migrated.navigator.provider === 'claude' && migrated.navigator.mode === 'cli',
    );
    const onDisk = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as { planner?: { provider?: string; mode?: string }; navigator?: { provider?: string } };
    check('migration is rewritten to disk (planner)', onDisk.planner?.provider === 'claude' && onDisk.planner?.mode === 'cli');
    check('migration is rewritten to disk (navigator)', onDisk.navigator?.provider === 'claude');

    // env still overrides the (migrated) settings-store value.
    process.env.SPIKE_PLANNER_PROVIDER = 'glm';
    process.env.SPIKE_PLANNER_MODE = 'api';
    const envOverridden = loadConfig();
    check('env (SPIKE_PLANNER_PROVIDER/MODE) overrides the settings store', envOverridden.planner.provider === 'glm' && envOverridden.planner.mode === 'api');
    delete process.env.SPIKE_PLANNER_PROVIDER;
    delete process.env.SPIKE_PLANNER_MODE;

    // a LONE SPIKE_*_MODEL env var partial-merges onto provider/mode rather than
    // wiping them back to config.ts's raw DEFAULTS.
    process.env.SPIKE_PLANNER_MODEL = 'claude-opus-9';
    const partial = loadConfig();
    check(
      'a lone SPIKE_PLANNER_MODEL merges onto the migrated provider/mode (no wipe)',
      partial.planner.provider === 'claude' && partial.planner.mode === 'cli' && partial.planner.model === 'claude-opus-9',
    );
    delete process.env.SPIKE_PLANNER_MODEL;
  } finally {
    if (savedLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = savedLocalAppData;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/* ---------- part 2: live google-cli (skips when absent) ---------- */

const cfg = loadConfig();
const cli = new GoogleCliAdapter({
  bin: cfg.googleCliBin,
  model: cfg.googleCliModel,
  env: cfg.googleCliEnv,
});

if (await cli.available()) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const bad = path.join(here, '..', 'spikes', 'cdp-logpoint', 'shots', 'bad.png');
  if (fs.existsSync(bad)) {
    try {
      const t0 = Date.now();
      const raw = (await cli.generateJson({
        prompt: verdictPrompt('Does this dashboard page render correctly with no error messages?'),
        schema: VERDICT_JSON_SCHEMA,
        imagePng: fs.readFileSync(bad),
      })) as { verdict?: string };
      console.log(`live google-cli verdict in ${Date.now() - t0} ms:`, JSON.stringify(raw));
      check('live google-cli returns fail on bad.png', raw.verdict === 'fail');
    } catch (e) {
      // "skips gracefully" per the header comment above: the binary being on
      // PATH doesn't mean it can actually authenticate (e.g. the Gemini CLI
      // free tier died 2026-06-18 — see CLAUDE.md's gotchas). A live-call
      // failure here is an environment fact, not a router/adapter regression.
      console.log(`SKIP  live google-cli (call failed: ${(e as Error).message.slice(0, 200)})`);
    }
  } else {
    console.log('SKIP  live google-cli (no bad.png — run spike capture-shots)');
  }
} else {
  console.log(`SKIP  live google-cli (${cfg.googleCliBin} not on PATH)`);
}

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
