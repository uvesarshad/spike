/* Pure settings DATA + helpers — NO Node imports (no fs/path), so this module is
 * safe to bundle into the browser (lite mode) AND is the single source of truth
 * for the daemon's settings.ts (which re-exports everything here and adds the
 * fs-backed SettingsStore). Keep this file free of any node:* import. */

/** Providers the user can pick as the browsing-control AI. */
export type ProviderId = 'nano' | 'gemini' | 'claude' | 'gpt' | 'ollama' | 'openrouter' | 'glm';
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
  // Default planner: claude CLI. The old default (gemini:cli, free Gemini quota)
  // died on 2026-06-18 (IneligibleTierError), so it's a broken out-of-box choice.
  // claude CLI needs no API key and is near-ubiquitous in this tool's audience;
  // if it's absent the router falls through the ladder to codex/BYOK/Ollama.
  // (Lite mode overrides this to a BYOK provider — it has no CLI rungs.)
  planner: { provider: 'claude', mode: 'cli' },
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
  'glm:api': 'glm-5.2', // z.ai GLM-5.2 (text-only reasoning model; planner-only)
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

/* ---- Panel-facing provider metadata (also pure; shared by daemon + lite) ---- */

/** Provider → encrypted-vault / chrome.storage key name for its API key. nano
 * (on-device) and ollama (local) need no key, so they are absent. */
export const VAULT_KEY_FOR: Partial<Record<ProviderId, string>> = {
  gemini: 'gemini',
  claude: 'anthropic',
  gpt: 'openai',
  openrouter: 'openrouter',
  glm: 'glm',
};

/** Which transports each provider supports — panel-facing metadata. */
export const PROVIDER_MODES: Record<ProviderId, string[]> = {
  nano: ['ondevice'],
  gemini: ['api', 'cli'],
  claude: ['api', 'cli'],
  gpt: ['api', 'cli'],
  ollama: ['api'],
  openrouter: ['api'],
  glm: ['api'],
};

/** The provider list the panel renders, in ladder order. */
export const PROVIDER_ORDER: ProviderId[] = ['nano', 'gemini', 'claude', 'gpt', 'ollama', 'openrouter', 'glm'];

/** Providers usable as a planner in LITE mode (no daemon → BYOK API only; nano
 * never plans; ollama needs a local daemon; cli rungs can't spawn in a browser). */
export const LITE_PLANNER_PROVIDERS: ProviderId[] = ['gemini', 'claude', 'gpt', 'openrouter', 'glm'];
