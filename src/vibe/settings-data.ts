/* Pure settings DATA + helpers — NO Node imports (no fs/path), so this module is
 * safe to bundle into the browser (lite mode) AND is the single source of truth
 * for the daemon's settings.ts (which re-exports everything here and adds the
 * fs-backed SettingsStore). Keep this file free of any node:* import. */

/** Providers the user can pick as the browsing-control AI. */
export type ProviderId = 'nano' | 'gemini' | 'claude' | 'gpt' | 'ollama' | 'openrouter' | 'glm';
/** How that provider is reached: hosted API key, a local CLI binary, or (nano
 * only) the on-device Prompt API. */
export type PlannerMode = 'api' | 'cli' | 'ondevice';
/** Paste-a-prompt vs hand the fix to a coding agent headlessly. */
export type DebugMode = 'prompt' | 'auto';
/** Which coding agent runs the automated fix ('auto' = detect on PATH). */
export type DebugAgent = 'auto' | 'claude' | 'codex' | 'gemini';

/** The two user-pinned model roles. NAVIGATOR = the cheap/free model that drives
 * each step (plan-step, called every step); BRAIN = the smart model that makes /
 * repairs the sub-goal plan (plan-goals, called rarely). Visual verdicts are
 * always Nano-first and aren't a user-pinned role, so they're absent here. */
export type ModelRole = 'navigator' | 'brain';

export interface PlannerSelection {
  provider: ProviderId;
  mode: PlannerMode;
  /** Model id; empty → the per-provider/mode/role default (defaultModelFor). */
  model?: string;
}

export interface QaSettings {
  /** BRAIN — the smart model that makes/repairs the plan (plan-goals). */
  planner: PlannerSelection;
  /** NAVIGATOR — the cheap/free model that drives each step (plan-step). */
  navigator: PlannerSelection;
  debugMode: DebugMode;
  debugAgent: DebugAgent;
  /** Opt-in video assertions: when true, an `assert_visual { mode: 'video' }`
   * step routes the recorded clip to a video-capable adapter (paid, slower)
   * instead of judging the screenshot. Off by default — costly. Non-secret, so
   * it lives in the store (never a key). Mirrors config.videoAssertions /
   * QA_VIDEO_ASSERTIONS; env still wins. */
  videoAssertions?: boolean;
  /** A5b (P1) safety: dry-run/read-only default. When true, the driver may
   * navigate/observe/screenshot but MUST refuse the mutating actions (click,
   * type, upload_file, drag_and_drop, blur, mouse, open_tab, switch_tab,
   * close_tab, script) — it records a clearly-labeled skipped step instead of
   * executing them. A safety layer ON TOP OF the existing Tier-4 allowedHosts
   * guard, not a replacement. Defaults to TRUE — first runs are safe by
   * default; the user opts OUT to let the agent actually click/type. Non-secret,
   * so it lives in the store. Mirrors config.readOnly / QA_READ_ONLY; env still
   * wins. */
  readOnly?: boolean;
  /** A5a (P1) safety: optional per-run spend cap in USD. undefined/absent = no
   * cap (off by default). When set, the driver aborts the run once its
   * best-available spend proxy (paid model-call token total — precise USD
   * isn't derivable without per-adapter pricing; see driver/loop.ts's
   * estimatedPaidSpendUsd) reaches this figure, ending cleanly with verdict
   * 'uncertain' and reason "spend cap reached". Non-secret, so it lives in the
   * store. Mirrors config.spendCapUsd / QA_SPEND_CAP_USD; env still wins. */
  spendCapUsd?: number;
}

export const DEFAULT_SETTINGS: QaSettings = {
  // BRAIN default: Claude Sonnet via BYOK. The brain is consulted rarely (initial
  // plan + on stuck), so paying for a smart model barely affects run cost. Out of
  // the box the user has no Anthropic key yet → the panel must prompt for one and
  // the ladder degrades gracefully (falls through to any other configured planner).
  // (The daemon's config.ts keeps claude:cli as ITS brain default — it has CLI
  // rungs; lite/BYOK has none, so the shared default here is api.)
  planner: { provider: 'claude', mode: 'api', model: '' },
  // NAVIGATOR default: Gemini Nano, on-device and $0. It does the frequent grunt
  // work every step, so cheap/free is the whole point; cloud fallback applies
  // automatically when Nano can't drive a step (or has no plan-step support yet).
  navigator: { provider: 'nano', mode: 'ondevice' },
  debugMode: 'prompt',
  debugAgent: 'auto',
  videoAssertions: false,
  // A5b: safe by default — first runs must not click/type until the user
  // explicitly opts in (panel toggle / QA_READ_ONLY=0).
  readOnly: true,
  // spendCapUsd intentionally absent here — undefined/OFF is the default; the
  // user opts in with an explicit positive USD figure.
};

/** NAVIGATOR (cheap) default model per provider+mode. Called on EVERY step, so
 * cheap tiers throughout — that is the whole point of the ladder. Also the
 * back-compat / legacy table: defaultModelFor() with no role falls back here so
 * every pre-split 2-arg caller keeps today's behaviour. */
const NAVIGATOR_MODELS: Record<string, string> = {
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

/** BRAIN (smart) default model per provider+mode. The brain is consulted rarely,
 * so a pricier/smarter tier barely affects run cost. gemini has no confirmed Pro
 * id here, so it keeps flash; cli variants match their api brain value. */
const BRAIN_MODELS: Record<string, string> = {
  'gemini:api': 'gemini-3-flash-preview', // no confirmed pro id — keep flash
  'gemini:cli': 'gemini-3-flash-preview',
  'claude:api': 'claude-sonnet-5',
  'claude:cli': 'claude-sonnet-5',
  'gpt:api': 'gpt-4o',
  'gpt:cli': '', // codex uses its own configured model
  'ollama:api': 'llama3.2-vision',
  'openrouter:api': 'anthropic/claude-3.5-sonnet',
  'glm:api': 'glm-5.2', // z.ai GLM-5.2 (text-only reasoning model)
};

/** Sensible default model id when the user leaves model blank, keyed by
 * provider+mode AND role. role omitted → the navigator/legacy table, so existing
 * 2-arg callers are unaffected. */
export function defaultModelFor(provider: ProviderId, mode: PlannerMode, role?: ModelRole): string {
  const table = role === 'brain' ? BRAIN_MODELS : NAVIGATOR_MODELS;
  return table[`${provider}:${mode}`] ?? '';
}

/** True for a PlannerSelection pinned to a known-dead provider/mode. Today that's
 * only the Gemini CLI free tier (Gemini Code Assist for individuals), which
 * ended 2026-06-18 and now hard-fails auth (see google-cli.ts's IneligibleTier
 * detection). Centralised here (pure, no node imports) so SettingsStore's
 * migration (settings.ts) and config.ts's startup warning agree on what counts
 * as "dead" without either owning the other's logic. */
export function isDeadPlannerSelection(sel: PlannerSelection): boolean {
  return sel.provider === 'gemini' && sel.mode === 'cli';
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

/** Providers usable as the BRAIN (planner) in LITE mode (no daemon → BYOK API
 * only; nano is never the brain; ollama needs a local daemon; cli rungs can't
 * spawn in a browser). GLM-5.2 qualifies — the brain works from a text digest. */
export const LITE_PLANNER_PROVIDERS: ProviderId[] = ['gemini', 'claude', 'gpt', 'openrouter', 'glm'];

/** Providers usable as the NAVIGATOR in LITE mode: cheap vision-capable BYOK
 * models plus $0 on-device Nano. glm is excluded — it's text-only, so a poor
 * navigator (the navigator must actually look at the page every step). */
export const LITE_NAVIGATOR_PROVIDERS: ProviderId[] = ['nano', 'gemini', 'claude', 'gpt', 'openrouter'];
