/* Back-compat shim for the pre-Spike env prefix.
 *
 * Every tunable used to be `QA_*` (the tool was "browser-qa-subagent"); it is
 * `SPIKE_*` now. Rather than teach ~39 read sites across config.ts, telemetry,
 * the CLI and the tests to check two names each, this aliases the whole prefix
 * ONCE, at process start, by mutating process.env: any `QA_FOO` that is set
 * becomes `SPIKE_FOO` too, unless `SPIKE_FOO` is already set (new name wins).
 *
 * Generic on purpose — it covers vars added later without being updated.
 *
 * Imported for side effects only, from the real entry points (cli.ts,
 * mcp-server.ts) and from config.ts so library consumers get it as well. ESM
 * module caching makes the repeat imports free.
 *
 * REMOVE AT 1.0: this exists so shell recipes and scripts written against the
 * old prefix keep working through the rename. Deleting this file and its three
 * imports is the entire removal. */

import fs from 'node:fs';

const LEGACY_PREFIX = 'QA_';
const PREFIX = 'SPIKE_';

/** One-time on-disk migration for state dirs/files that were named `qa-*` before
 * the rename (the SettingsStore dir, the secrets Vault dir). Moves `legacy` to
 * `next` when `next` does not exist yet, so a user's settings and encrypted API
 * keys survive the rename instead of silently reappearing as defaults.
 *
 * Returns the path the caller should use. Best-effort: if the move fails (locked
 * file, read-only volume, cross-device) we fall back to the legacy path rather
 * than losing access to real user data. Drop at 1.0 with the rest of this file. */
export function migrateLegacyPath(legacy: string, next: string): string {
  try {
    if (fs.existsSync(next)) return next;
    if (!fs.existsSync(legacy)) return next;
    fs.renameSync(legacy, next);
    return next;
  } catch {
    return fs.existsSync(legacy) ? legacy : next;
  }
}

/** Aliases legacy QA_* vars onto SPIKE_*. Returns the names it bridged (for the
 * one-time notice and for tests). Idempotent. */
export function applyLegacyEnvAliases(env: NodeJS.ProcessEnv = process.env): string[] {
  const bridged: string[] = [];
  for (const key of Object.keys(env)) {
    if (!key.startsWith(LEGACY_PREFIX)) continue;
    const value = env[key];
    if (value === undefined) continue;
    const renamed = PREFIX + key.slice(LEGACY_PREFIX.length);
    if (env[renamed] !== undefined) continue; // explicit new-name value wins
    env[renamed] = value;
    bridged.push(key);
  }
  return bridged;
}

const bridged = applyLegacyEnvAliases();
if (bridged.length && !process.env.SPIKE_SUPPRESS_LEGACY_ENV_WARNING) {
  // stderr, not stdout — stdout is the MCP stdio transport and the --json contract.
  console.error(
    `[spike] note: ${bridged.join(', ')} ${bridged.length === 1 ? 'uses' : 'use'} the old QA_ prefix; ` +
      `renamed to SPIKE_. Update to ${bridged.map((k) => PREFIX + k.slice(LEGACY_PREFIX.length)).join(', ')}.`,
  );
}
