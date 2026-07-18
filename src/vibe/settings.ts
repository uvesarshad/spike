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
import { DEFAULT_SETTINGS, defaultModelFor, isDeadPlannerSelection, isSafeModelId } from './settings-data.js';
import type {
  ProviderId,
  PlannerMode,
  ModelRole,
  DebugMode,
  DebugAgent,
  PlannerSelection,
  QaSettings,
} from './settings-data.js';

export { DEFAULT_SETTINGS, defaultModelFor, isDeadPlannerSelection, isSafeModelId };
export type { ProviderId, PlannerMode, ModelRole, DebugMode, DebugAgent, PlannerSelection, QaSettings };

function defaultSettingsPath(): string {
  const base = process.env.LOCALAPPDATA ?? process.env.HOME ?? '.';
  return path.join(base, 'qa-subagent', 'settings.json');
}

/** Daemon-only migration target for a dead/missing BRAIN pin (Phase 13, config
 * drift fix). Deliberately NOT DEFAULT_SETTINGS.planner (claude:api) — that
 * table is shared with lite/browser mode, which has no CLI rungs. The daemon
 * DOES have CLI rungs, so claude:cli is both this migration target and
 * src/config.ts's own DEFAULTS.planner; keep the two in sync. */
const DAEMON_PLANNER_MIGRATION: PlannerSelection = { provider: 'claude', mode: 'cli', model: '' };

export class SettingsStore {
  private readonly file: string;
  /** Last-read raw value + the file's mtime at that read, so an unchanged file
   * (the common case — settings aren't polled today, but future callers might)
   * skips the sync readFileSync+JSON.parse (and the migration check) entirely.
   * Invalidated the instant the on-disk mtime moves — including the migration
   * rewrite in readRaw() and any write() below, both of which re-stat the file
   * after writing and refresh this cache with the new mtime. */
  private cache?: { mtimeMs: number; value: Partial<QaSettings> };

  constructor(file?: string) {
    this.file = file ?? defaultSettingsPath();
  }

  /** Settings AS ACTUALLY STORED ON DISK — no default-filling for planner or
   * navigator, so a field the user never explicitly saved comes back absent
   * rather than looking like an explicit choice. config.ts's fromSettings()
   * relies on this distinction: it only lets a stored planner/navigator
   * override config.ts's OWN role-specific defaults (e.g. the daemon's
   * claude:cli brain default) when the user actually picked something.
   *
   * Also runs the Phase 13 config-drift migration: a persisted `planner` pinned
   * to the dead Gemini CLI free tier, or a persisted config with no `navigator`
   * key at all (pre-split), is rewritten to the current daemon defaults
   * (brain → claude:cli, navigator → nano) right here, once, so every other
   * reader (this file, `qa config` CLI, the panel) sees the fixed values
   * without re-deriving the migration themselves. */
  readRaw(): Partial<QaSettings> {
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(this.file);
    } catch {
      /* file doesn't exist (or is otherwise unstattable) — nothing cached to reuse */
    }
    if (stat && this.cache && this.cache.mtimeMs === stat.mtimeMs) return this.cache.value;

    let parsed: Partial<QaSettings> = {};
    let fileExisted = false;
    try {
      if (fs.existsSync(this.file)) {
        fileExisted = true;
        parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      }
    } catch {
      /* corrupt file → treat as empty; don't overwrite a file we couldn't parse */
      return {};
    }
    if (!fileExisted) return parsed;

    const deadPlanner = Boolean(parsed.planner && isDeadPlannerSelection(parsed.planner));
    const missingNavigator = !parsed.navigator;
    if (!deadPlanner && !missingNavigator) {
      if (stat) this.cache = { mtimeMs: stat.mtimeMs, value: parsed };
      return parsed;
    }

    const migrated: Partial<QaSettings> = {
      ...parsed,
      planner: deadPlanner ? { ...DAEMON_PLANNER_MIGRATION } : parsed.planner,
      navigator: missingNavigator ? { ...DEFAULT_SETTINGS.navigator } : parsed.navigator,
    };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(migrated, null, 2));
      this.cache = { mtimeMs: fs.statSync(this.file).mtimeMs, value: migrated };
    } catch {
      /* best effort — caller still gets the migrated value in-memory; next read retries the write */
      this.cache = undefined;
    }
    return migrated;
  }

  /** Current settings, defaults filled in for anything missing/corrupt. Spreading
   * DEFAULT_SETTINGS UNDER the stored config (post-migration via readRaw()) means
   * a config written before the planner/navigator split, or one still pinned to
   * the dead gemini:cli free tier, comes back fully migrated rather than
   * inheriting a stale/dead pin. */
  read(): QaSettings {
    const parsed = this.readRaw();
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
    try {
      this.cache = { mtimeMs: fs.statSync(this.file).mtimeMs, value: next };
    } catch {
      this.cache = undefined;
    }
    return next;
  }
}
