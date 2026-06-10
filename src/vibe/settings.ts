/* SettingsStore — the user's non-secret picks (which "browsing control AI" drives
 * the planner, and how debugging is handled). Persisted as plain JSON at a stable
 * per-machine path so the side panel (via the daemon) and the `qa config` CLI
 * share ONE source of truth. API KEYS NEVER LAND HERE — those go in the encrypted
 * Vault (src/vault/vault.ts). loadConfig() folds these settings in below env, so
 * QA_* env vars still win for power users / tests. */

import fs from 'node:fs';
import path from 'node:path';

/** Providers the user can pick as the browsing-control AI. */
export type ProviderId = 'nano' | 'gemini' | 'claude' | 'gpt' | 'ollama' | 'openrouter';
/** How that provider is reached: hosted API key, or a local CLI binary. */
export type PlannerMode = 'api' | 'cli';
/** Paste-a-prompt vs hand the fix to a coding agent headlessly. */
export type DebugMode = 'prompt' | 'auto';
/** Which coding agent runs the automated fix ('auto' = detect on PATH). */
export type DebugAgent = 'auto' | 'claude' | 'codex' | 'gemini';

export interface PlannerSelection {
  provider: ProviderId;
  mode: PlannerMode;
  /** Model id; empty → the per-provider/mode default (defaultModelFor). */
  model?: string;
}

export interface QaSettings {
  planner: PlannerSelection;
  debugMode: DebugMode;
  debugAgent: DebugAgent;
}

export const DEFAULT_SETTINGS: QaSettings = {
  planner: { provider: 'gemini', mode: 'cli' },
  debugMode: 'prompt',
  debugAgent: 'auto',
};

/** Sensible default model per provider+mode (used when the user leaves model blank).
 * Cheap tiers throughout — that is the whole point of the ladder. */
const DEFAULT_MODELS: Record<string, string> = {
  'gemini:api': 'gemini-3-flash-preview',
  'gemini:cli': 'gemini-3-flash-preview',
  'claude:api': 'claude-haiku-4-5',
  'claude:cli': 'claude-haiku-4-5',
  'gpt:api': 'gpt-4o-mini',
  'gpt:cli': '', // codex uses its own configured model
  'ollama:api': 'llama3.2-vision',
  'openrouter:api': 'anthropic/claude-3.5-haiku',
};

export function defaultModelFor(provider: ProviderId, mode: PlannerMode): string {
  return DEFAULT_MODELS[`${provider}:${mode}`] ?? '';
}

/** Is this a safe model identifier to interpolate into a CLI command line?
 *
 * SECURITY: planner.model is user-controlled AND reachable over the bridge
 * (vibe.config.set, which any localhost WebSocket client can call). CLI-planner
 * adapters spawn `<bin> --model <model>` with shell:true, so an unsanitized model
 * is a command-injection sink (`x & calc.exe`). Real model ids are a tight
 * charset — letters, digits, and `. _ - : / +` (the `/` covers OpenRouter slugs
 * like `anthropic/claude-3.5-haiku`). Anything else (spaces, shell metacharacters)
 * is rejected. Empty is treated as "use the default", so callers test non-empty. */
export function isSafeModelId(model: string): boolean {
  return /^[A-Za-z0-9._:/+-]+$/.test(model);
}

function defaultSettingsPath(): string {
  const base = process.env.LOCALAPPDATA ?? process.env.HOME ?? '.';
  return path.join(base, 'qa-subagent', 'settings.json');
}

export class SettingsStore {
  private readonly file: string;

  constructor(file?: string) {
    this.file = file ?? defaultSettingsPath();
  }

  /** Current settings, defaults filled in for anything missing/corrupt. */
  read(): QaSettings {
    let parsed: Partial<QaSettings> = {};
    try {
      if (fs.existsSync(this.file)) parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      /* corrupt file → fall back to defaults */
    }
    return {
      planner: { ...DEFAULT_SETTINGS.planner, ...(parsed.planner ?? {}) },
      debugMode: parsed.debugMode ?? DEFAULT_SETTINGS.debugMode,
      debugAgent: parsed.debugAgent ?? DEFAULT_SETTINGS.debugAgent,
    };
  }

  /** Merge a partial patch over the current settings and persist; returns the result. */
  write(patch: Partial<QaSettings>): QaSettings {
    const next: QaSettings = {
      ...this.read(),
      ...patch,
      // planner is a nested object — merge it rather than clobber
      planner: { ...this.read().planner, ...(patch.planner ?? {}) },
    };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(next, null, 2));
    return next;
  }
}
