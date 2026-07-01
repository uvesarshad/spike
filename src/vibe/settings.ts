/* SettingsStore — the user's non-secret picks (which "browsing control AI" drives
 * the planner, and how debugging is handled). Persisted as plain JSON at a stable
 * per-machine path so the side panel (via the daemon) and the `qa config` CLI
 * share ONE source of truth. API KEYS NEVER LAND HERE — those go in the encrypted
 * Vault (src/vault/vault.ts). loadConfig() folds these settings in below env, so
 * QA_* env vars still win for power users / tests.
 *
 * Types + pure data/helpers live in settings-data.ts (no node imports) so they
 * can ALSO be bundled into the browser (lite mode). Re-exported here so the
 * daemon's many `from './settings.js'` importers are unaffected. */

import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_SETTINGS, defaultModelFor, isSafeModelId } from './settings-data.js';
import type {
  ProviderId,
  PlannerMode,
  ModelRole,
  DebugMode,
  DebugAgent,
  PlannerSelection,
  QaSettings,
} from './settings-data.js';

export { DEFAULT_SETTINGS, defaultModelFor, isSafeModelId };
export type { ProviderId, PlannerMode, ModelRole, DebugMode, DebugAgent, PlannerSelection, QaSettings };

function defaultSettingsPath(): string {
  const base = process.env.LOCALAPPDATA ?? process.env.HOME ?? '.';
  return path.join(base, 'qa-subagent', 'settings.json');
}

export class SettingsStore {
  private readonly file: string;

  constructor(file?: string) {
    this.file = file ?? defaultSettingsPath();
  }

  /** Current settings, defaults filled in for anything missing/corrupt. Spreading
   * DEFAULT_SETTINGS UNDER the stored config is the migration path: a config
   * written before the planner/navigator split (no `navigator` key) inherits the
   * default navigator (Nano) rather than coming back undefined. */
  read(): QaSettings {
    let parsed: Partial<QaSettings> = {};
    try {
      if (fs.existsSync(this.file)) parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      /* corrupt file → fall back to defaults */
    }
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      // planner + navigator are nested objects — merge them rather than clobber.
      planner: { ...DEFAULT_SETTINGS.planner, ...(parsed.planner ?? {}) },
      navigator: { ...DEFAULT_SETTINGS.navigator, ...(parsed.navigator ?? {}) },
    };
  }

  /** Merge a partial patch over the current settings and persist; returns the result. */
  write(patch: Partial<QaSettings>): QaSettings {
    const current = this.read();
    const next: QaSettings = {
      ...current,
      ...patch,
      // planner + navigator are nested objects — merge them rather than clobber.
      planner: { ...current.planner, ...(patch.planner ?? {}) },
      navigator: { ...current.navigator, ...(patch.navigator ?? {}) },
    };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(next, null, 2));
    return next;
  }
}
