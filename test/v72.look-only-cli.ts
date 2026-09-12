/* v72 — A1 (P0): look-only mode is a real switch, not a decorative default.
 *
 * `readOnly` defaults to TRUE in config (a safe posture for the browser
 * extension, which drives whatever tab happens to be open). Flowing that into
 * every caller meant a plain `spike run "<task>" --url <url>` skipped every
 * click and typed nothing, then ended `uncertain` — after a page of green
 * "skipped" ticks. A caller who NAMES a target url has already consented to
 * drive it, exactly the way `trustTargetHost` already treats that url as host
 * consent, so the effective default there is FALSE.
 *
 * This suite is pure: no Chrome, no AI, no network. It covers
 *   1. resolveReadOnly()'s precedence rule (the engine's single decision site);
 *   2. readOnlyWasConfigured()'s source detection (per-run override, env,
 *      spike.config.json) — the thing that keeps the relaxation from
 *      overriding a user who actually asked for look-only mode;
 *   3. that the CLI and the MCP tool expose the switch at all (a source-level
 *      guard: neither module can be imported — cli.ts has a top-level
 *      program.parseAsync(), mcp-server.ts opens a stdio transport).
 *
 * Run: npx tsx test/v72.look-only-cli.ts   (exits nonzero on any failed check)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveReadOnly } from '../src/engine.js';
import { readOnlyWasConfigured } from '../src/config.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ============ 1) resolveReadOnly precedence ============ */
console.log('=== v72 1/3: resolveReadOnly precedence ===');
{
  // The headline case: `spike run --url <url>` with nothing configured.
  check(
    'named target + nothing configured -> look-only OFF (the A1 bug)',
    resolveReadOnly({ trustTargetHost: true, configured: false, configReadOnly: true }) === false,
  );
  // `spike run --read-only` / qa_run { readOnly: true }.
  check(
    '--read-only wins over the named-target relaxation',
    resolveReadOnly({ optionReadOnly: true, trustTargetHost: true, configured: false, configReadOnly: true }) === true,
  );
  check(
    'an explicit per-run false wins over a configured true',
    resolveReadOnly({ optionReadOnly: false, trustTargetHost: true, configured: true, configReadOnly: true }) === false,
  );
  // A user who actually asked for look-only mode keeps it.
  check(
    'named target + explicitly configured true -> look-only stays ON',
    resolveReadOnly({ trustTargetHost: true, configured: true, configReadOnly: true }) === true,
  );
  check(
    'named target + explicitly configured false -> OFF',
    resolveReadOnly({ trustTargetHost: true, configured: true, configReadOnly: false }) === false,
  );
  // The panel path: trustTargetHost:false, so the relaxation must not apply.
  check(
    'untrusted target (the panel) + nothing configured -> the config value stands',
    resolveReadOnly({ trustTargetHost: false, configured: false, configReadOnly: true }) === true,
  );
  check(
    'untrusted target + an explicit per-run value (the panel checkbox) wins',
    resolveReadOnly({ optionReadOnly: false, trustTargetHost: false, configured: false, configReadOnly: true }) === false,
  );
}

/* ============ 2) readOnlyWasConfigured source detection ============ */
console.log('\n=== v72 2/3: readOnlyWasConfigured ===');
{
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spike-cfg-'));
  const savedEnv = process.env.SPIKE_READ_ONLY;
  delete process.env.SPIKE_READ_ONLY;

  // The SettingsStore's own `readOnly` deliberately does NOT count — the old
  // panel wrote it on every Save, so counting it would leave the CLI silently
  // look-only on any machine that ever opened the panel's settings. So this
  // baseline must be false regardless of what is on this machine's disk.
  const baseline = readOnlyWasConfigured({}, emptyDir);
  check('no override, no env, no config file -> not configured (saved panel settings do not count)', baseline === false);

  check(
    'a per-run override counts as configured (true)',
    readOnlyWasConfigured({ readOnly: true }, emptyDir) === true,
  );
  check(
    'a per-run override counts as configured (false too)',
    readOnlyWasConfigured({ readOnly: false }, emptyDir) === true,
  );

  process.env.SPIKE_READ_ONLY = '0';
  check('SPIKE_READ_ONLY=0 counts as configured', readOnlyWasConfigured({}, emptyDir) === true);
  process.env.SPIKE_READ_ONLY = '1';
  check('SPIKE_READ_ONLY=1 counts as configured', readOnlyWasConfigured({}, emptyDir) === true);
  delete process.env.SPIKE_READ_ONLY;

  const fileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spike-cfg-file-'));
  fs.writeFileSync(path.join(fileDir, 'spike.config.json'), JSON.stringify({ readOnly: true }));
  check('spike.config.json { readOnly } counts as configured', readOnlyWasConfigured({}, fileDir) === true);
  fs.writeFileSync(path.join(fileDir, 'spike.config.json'), JSON.stringify({ maxSteps: 5 }));
  check('an unrelated spike.config.json does NOT count', readOnlyWasConfigured({}, fileDir) === false);

  if (savedEnv !== undefined) process.env.SPIKE_READ_ONLY = savedEnv;
}

/* ============ 3) the switch is actually exposed ============ */
console.log('\n=== v72 3/3: --read-only / qa_run readOnly are wired ===');
{
  const cli = fs.readFileSync(path.join(repoRoot, 'src', 'cli.ts'), 'utf8');
  const readOnlyFlags = cli.match(/\.option\('--read-only'/g) ?? [];
  // run + replay, and since A22 `suite` too — every surface that drives a page
  // must be able to say "look, don't touch".
  check('cli.ts declares --read-only on run, replay and suite', readOnlyFlags.length >= 3);
  check('cli.ts forwards the flag as a qaRun/qaReplay option', /\.\.\.\(opts\.readOnly && \{ readOnly: true \}\)/.test(cli));
  check(
    'the run flag is not on by default (an absent flag must not re-impose look-only)',
    /\.option\('--read-only',[\s\S]{0,400}?, false\)/.test(cli),
  );

  const mcp = fs.readFileSync(path.join(repoRoot, 'src', 'mcp-server.ts'), 'utf8');
  check('qa_run exposes an optional readOnly input', /readOnly: z\s*\n?\s*\.boolean\(\)\s*\n?\s*\.optional\(\)/.test(mcp));
  check('qa_run forwards readOnly to qaRun', /readOnly !== undefined && \{ readOnly \}/.test(mcp));

  // The vocabulary rule: what a user reads must not say "read-only mode".
  const runFlagLine = cli.split('\n').find((l) => l.includes(".option('--read-only'") && l.includes('--url')) ?? '';
  check('the run flag help text says "look-only"', /look-only/.test(runFlagLine));
}

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} v72 checks passed`);
process.exit(failed.length ? 1 : 0);
