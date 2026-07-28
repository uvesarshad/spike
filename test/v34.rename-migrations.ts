/* v34 — the Spike-rename back-compat shims. Everything here exists so a user who
 * installed the tool as "browser-qa-subagent" keeps their env recipes, settings,
 * encrypted API keys, and extension-stored keys after the rename.
 *
 * ALL OF THIS IS DELETED AT 1.0 — when it goes, delete this file with it. Until
 * then these are the guard rails: a regression here silently orphans real user
 * data (API keys!) rather than failing loudly, which is exactly why it's tested.
 *
 * Covers:
 *   1. applyLegacyEnvAliases  — QA_FOO -> SPIKE_FOO
 *   2. migrateLegacyPath      — qa-subagent/ -> spike/, qa-subagent-vault/ -> spike-vault/
 *   3. CONFIG_FILENAMES       — spike.config.json preferred, qa.config.json still read
 *   4. extension/sw.js        — chrome.storage qaKeys/qaSettings -> spikeKeys/spikeSettings
 *
 * (4) slices the real block out of extension/sw.js and evaluates it against a
 * mock chrome.storage, so it tests shipped source rather than a copy — the SW
 * can't be imported directly (it needs MV3 globals). */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyLegacyEnvAliases, migrateLegacyPath } from '../src/env-compat.js';
import { loadConfig } from '../src/config.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

const REPO_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'v34-'));

// ---- 1. env aliasing -------------------------------------------------------
{
  const env: NodeJS.ProcessEnv = { QA_CDP_PORT: '9999', QA_VIA: 'cdp', SPIKE_VIA: 'extension' };
  const bridged = applyLegacyEnvAliases(env);
  check('legacy QA_ var is aliased onto SPIKE_', env.SPIKE_CDP_PORT === '9999');
  check('explicit SPIKE_ value is never clobbered', env.SPIKE_VIA === 'extension');
  check('bridged list names only what it moved', bridged.length === 1 && bridged[0] === 'QA_CDP_PORT');

  const untouched: NodeJS.ProcessEnv = { PATH: '/bin', SPIKE_CDP_PORT: '1' };
  check('non-QA_ vars are left alone', applyLegacyEnvAliases(untouched).length === 0);

  // idempotent: a second pass must not re-report or change anything
  check('aliasing is idempotent', applyLegacyEnvAliases(env).length === 0 && env.SPIKE_CDP_PORT === '9999');
}

// ---- 2. on-disk path migration --------------------------------------------
{
  const root = tmp();
  const legacy = path.join(root, 'qa-subagent');
  const next = path.join(root, 'spike');
  fs.mkdirSync(legacy);
  fs.writeFileSync(path.join(legacy, 'settings.json'), '{"planner":{"provider":"claude"}}');

  const got = migrateLegacyPath(legacy, next);
  check('legacy dir is moved to the new name', got === next && !fs.existsSync(legacy));
  check(
    'migrated contents survive byte-for-byte',
    fs.readFileSync(path.join(next, 'settings.json'), 'utf8') === '{"planner":{"provider":"claude"}}',
  );
  check('migration is idempotent', migrateLegacyPath(legacy, next) === next && fs.existsSync(next));

  // both present → new wins, legacy left untouched (never silently merged/clobbered)
  const root2 = tmp();
  const l2 = path.join(root2, 'qa-subagent');
  const n2 = path.join(root2, 'spike');
  fs.mkdirSync(l2);
  fs.mkdirSync(n2);
  fs.writeFileSync(path.join(n2, 'settings.json'), 'NEW');
  check(
    'existing new-name dir wins and legacy is preserved',
    migrateLegacyPath(l2, n2) === n2 &&
      fs.readFileSync(path.join(n2, 'settings.json'), 'utf8') === 'NEW' &&
      fs.existsSync(l2),
  );

  // neither present → returns the new path, creates nothing
  const root3 = tmp();
  const n3 = path.join(root3, 'spike');
  check('no dirs present → nothing is created', migrateLegacyPath(path.join(root3, 'qa-subagent'), n3) === n3 && !fs.existsSync(n3));
}

// ---- 3. config filename fallback ------------------------------------------
{
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'qa.config.json'), JSON.stringify({ cdpPort: 7777 }));
  check('legacy qa.config.json is still read', loadConfig({}, dir).cdpPort === 7777);

  fs.writeFileSync(path.join(dir, 'spike.config.json'), JSON.stringify({ cdpPort: 8888 }));
  check('spike.config.json wins when both exist', loadConfig({}, dir).cdpPort === 8888);
}

// ---- 4. extension chrome.storage migration --------------------------------
{
  const src = fs.readFileSync(path.join(REPO_ROOT, 'extension', 'sw.js'), 'utf8');
  const start = src.indexOf('const KEYS_STORAGE_KEY');
  const end = src.indexOf('async function getKeys()');
  const block = start >= 0 && end > start ? src.slice(start, end) : '';
  check('sw.js migration block is locatable', block.length > 0);

  type Store = Record<string, unknown>;
  const mockChrome = (store: Store) => ({
    storage: {
      local: {
        get: (k: string, cb: (v: Store) => void) => cb(k in store ? { [k]: store[k] } : {}),
        set: (o: Store, cb: () => void) => { Object.assign(store, o); cb(); },
        remove: (k: string, cb: () => void) => { delete store[k]; cb(); },
      },
    },
  });

  const migrate = async (initial: Store): Promise<Store> => {
    const store: Store = { ...initial };
    const factory = new Function('chrome', `${block}; return ensureStorageMigrated;`);
    const ensure = factory(mockChrome(store)) as () => Promise<void>;
    await ensure();
    await ensure(); // idempotence
    return store;
  };

  const a = await migrate({ qaKeys: { anthropic: 'sk-legacy' }, qaSettings: { readOnly: false } });
  check(
    'stored API keys survive under the new name',
    (a.spikeKeys as Record<string, string>)?.anthropic === 'sk-legacy' && !('qaKeys' in a),
  );
  check(
    'stored settings survive under the new name',
    (a.spikeSettings as Record<string, unknown>)?.readOnly === false && !('qaSettings' in a),
  );

  const b = await migrate({ qaKeys: { anthropic: 'OLD' }, spikeKeys: { anthropic: 'NEW' } });
  check(
    'an existing new-name value is never clobbered by the legacy one',
    (b.spikeKeys as Record<string, string>).anthropic === 'NEW' && !('qaKeys' in b),
  );

  const c = await migrate({});
  check('empty storage stays empty (no keys invented)', Object.keys(c).length === 0);

  const d = await migrate({ spikeKeys: { glm: 'k' } });
  check('already-migrated storage is untouched', Object.keys(d).length === 1 && (d.spikeKeys as Record<string, string>).glm === 'k');
}

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} v34 rename-migration checks passed`);
process.exit(failed.length ? 1 : 0);
