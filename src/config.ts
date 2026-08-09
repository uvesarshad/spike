/* Central config. Resolution order: explicit overrides → env → spike.config.json → defaults.
 * Ports deliberately differ from the spikes (CDP 9223/9224, HTTP 9333/9334) so a
 * still-running spike Chrome never collides with the daemon. */

import './env-compat.js'; // aliases legacy QA_* env vars onto SPIKE_* — must precede any env read
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SettingsStore,
  isDeadPlannerSelection,
  type DebugAgent,
  type DebugMode,
  type PlannerSelection,
  type ProviderId,
  type PlannerMode,
} from './vibe/settings.js';
import type { AssertionPolicy } from './assertions/policy.js';

/** Repo's extension/ dir, resolved relative to this source file (src/ → up → extension). */
const DEFAULT_EXTENSION_DIR = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)), // .../src/
  '..', // repo root
  'extension',
);

export interface QaConfig {
  /** Transport that drives Chrome: daemon-launched CDP, or the MV3 extension bridge. */
  via: 'cdp' | 'extension';
  /** WebSocket port the daemon↔extension bridge listens on (extension mode). */
  bridgePort: number;
  /** Interface the bridge WebSocket server binds to. Defaults to loopback-only
   * (A1 hardening) — the server used to omit `host` entirely, which made `ws`
   * default to binding ALL interfaces (0.0.0.0/::), reachable from the LAN. */
  bridgeHost: string;
  /** Unpacked extension dir dev-loaded in extension mode. */
  extensionDir: string;
  /** CDP port for the daemon's Chrome. */
  cdpPort: number;
  /** Local HTTP port serving the Nano runner page. */
  runnerPort: number;
  /** Local HTTP port for the fixture app (dev/dogfood only). */
  fixturePort: number;
  /** Chrome profile dir — must live on a volume with 22 GB+ free (Gemini Nano storage gate). */
  chromeProfile: string;
  /** Rung-1 Google CLI binary (gemini today, antigravity after 2026-06-18 — never hardcode). */
  googleCliBin: string;
  /** Rung-1 model id passed to the CLI. */
  googleCliModel: string;
  /** Rung-2 BYOK Gemini API key (absent → rung 2 unavailable). */
  geminiApiKey?: string;
  /** Extra env for the Google CLI child process (e.g. NODE_OPTIONS=--use-system-ca behind AVG TLS interception). */
  googleCliEnv: Record<string, string>;
  /** Where run artifacts (report.json, screenshots) are written. */
  artifactsDir: string;
  /** File-backed verified action cache. Enabled by default (A9, 2026-08-09):
   * `verifyActionEffect()` now requires intent-specific proof per action type
   * (targeted element/URL/region evidence for click/hover, exact-match-first
   * for select_option, previously-empty-or-changed for secret `type`) instead
   * of the old "anything on the page changed" catch-all, so a hit landing on
   * a role+name+nth match that is no longer the semantically same element
   * (reordered list, recycled label) can no longer be laundered by an
   * unrelated page mutation (toast, ad refresh, ticker). Set
   * `SPIKE_ACTION_CACHE=0` to disable. */
  actionCache: boolean;
  actionCacheDir: string;
  /** Default driver-loop step budget. */
  maxSteps: number;
  /** Auto-fix: coding-agent CLI that receives the fix prompt headlessly
   * (e.g. bin 'claude', args ['-p','{prompt}','--permission-mode','acceptEdits']).
   * Unset bin → auto-detect claude/codex on PATH. '{prompt}' is substituted. */
  fixAgentBin?: string;
  fixAgentArgs?: string[];
  /** Project directory the fix agent runs in (defaults to cwd). */
  fixAgentCwd?: string;
  /** Hosts the driver may click/type on; everywhere else is read-only
   * (navigation + looking allowed, mutation blocked) — Tier-4 guardrail. */
  allowedHosts: string[];
  /** Record a replay GIF (ghost cursor + captions are in-page, so they're in frame). */
  recordClip: boolean;
  /** Visual assertion policy. single-ladder preserves the cheap existing path;
   * stricter modes can require multi-model agreement when enough visual adapters are configured. */
  assertionPolicy: AssertionPolicy;
  /** Opt-in (Phase 8, default false — it is costly): route `assert_visual { mode:
   * 'video' }` to a video-capable model (router.videoVerdict()) instead of the
   * screenshot fallback. OFF → mode:'video' still runs, but as a safe screenshot
   * verdict with a report note ("video assertion requested but disabled"). */
  videoAssertions: boolean;
  /** A5b (P1) safety: dry-run/read-only default — enforced in driver/loop.ts's
   * single mutation-guard site. A safety layer ON TOP OF allowedHosts (Tier-4),
   * not a replacement: even an allowed host's mutating actions are skipped
   * while this is true. Defaults to true (mirrors DEFAULT_SETTINGS.readOnly). */
  readOnly: boolean;
  /** A5a (P1) safety: optional per-run spend cap in USD. undefined = no cap
   * (default). Precise USD isn't derivable (no per-adapter pricing table), so
   * the driver enforces this against a best-available proxy — see
   * driver/loop.ts's estimatedPaidSpendUsd. */
  spendCapUsd?: number;
  /** Keep the FREE rung-1 Google CLI as the first planner even when a BYOK key is
   * present. Default false: providing a key IS the opt-in to spend it for ~3×
   * faster planning (rung-2 HTTP beats the CLI cold-spawn). Set true to keep free
   * quota first for plan-step. Visual verdicts are unaffected (Nano always first). */
  preferFreePlanner: boolean;
  /** BRAIN — the smart model pinned to the FRONT of the plan-goals ladder (the
   * rare plan/re-plan call; fallback still applies). From SettingsStore (panel/CLI). */
  planner: PlannerSelection;
  /** NAVIGATOR — the cheap/free model pinned to the FRONT of the plan-step ladder
   * (the per-step call; fallback still applies). From SettingsStore (panel/CLI). */
  navigator: PlannerSelection;
  /** Debugging UX: 'prompt' = surface a paste-ready fix prompt; 'auto' = hand it
   * to a coding agent headlessly. */
  debugMode: DebugMode;
  /** Which coding agent runs the automated fix ('auto' = detect on PATH). */
  debugAgent: DebugAgent;
}

const DEFAULTS: QaConfig = {
  via: 'cdp',
  bridgePort: 9410,
  bridgeHost: '127.0.0.1',
  extensionDir: DEFAULT_EXTENSION_DIR,
  cdpPort: 9322,
  runnerPort: 9400,
  fixturePort: 9401,
  chromeProfile: path.join(process.env.LOCALAPPDATA ?? process.env.HOME ?? '.', 'spike-chrome-profile'),
  googleCliBin: 'gemini',
  googleCliModel: 'gemini-3-flash-preview',
  googleCliEnv: { NODE_OPTIONS: '--use-system-ca' },
  artifactsDir: path.resolve('artifacts'),
  actionCache: true,
  actionCacheDir: path.resolve('.spike-action-cache'),
  maxSteps: 40,
  allowedHosts: ['localhost', '127.0.0.1'],
  // opt-in (SPIKE_RECORD_CLIP=1): GIF capture works over raw CDP (test/v14) but
  // chrome.debugger does NOT expose Page.startScreencast (extension mode), and
  // one cdp-mode run showed an unexplained input interaction — see TODO.md.
  // Vibe-mode clips need a chrome.tabCapture recorder (planned).
  recordClip: false,
  assertionPolicy: 'single-ladder',
  videoAssertions: false,
  // A5b: safe by default (mirrors DEFAULT_SETTINGS.readOnly).
  readOnly: true,
  // spendCapUsd intentionally absent — undefined/OFF is the default.
  preferFreePlanner: false,
  // BRAIN default: claude CLI — the daemon HAS cli rungs and the former gemini:cli
  // free tier is dead (see settings.ts). (This intentionally differs from
  // DEFAULT_SETTINGS.planner, which is api because lite/BYOK has no cli rungs.)
  planner: { provider: 'claude', mode: 'cli' },
  // NAVIGATOR default: Nano, on-device, $0 — explicitly its OWN value (A27), no
  // longer a shared reference to DEFAULT_SETTINGS.navigator. The daemon drives a
  // real CDP-controlled Chrome it owns, so it CAN confirm Nano is actually live
  // before a run starts (unlike lite/BYOK's browser-extension bundle, which has
  // no synchronous on-device probe at config-build time and silently fell through
  // to an accidental cloud adapter — see settings-data.ts's DEFAULT_SETTINGS.navigator
  // and lite-engine.ts's resolveNavigatorName). Keeping Nano as the daemon's default
  // preserves its $0 zero-config navigator; lite/BYOK's default is now a cheap cloud
  // model instead. (Same daemon-vs-lite split as the BRAIN default above.)
  navigator: { provider: 'nano', mode: 'ondevice' },
  debugMode: 'prompt',
  debugAgent: 'auto',
};

/** Valid enum values for env-override parsing (silently ignore garbage). */
const PROVIDERS: ProviderId[] = ['nano', 'gemini', 'claude', 'gpt', 'ollama', 'openrouter', 'glm'];
const DEBUG_AGENTS: DebugAgent[] = ['auto', 'claude', 'codex', 'gemini'];
const ASSERTION_POLICIES: AssertionPolicy[] = ['single-ladder', 'fail-on-disagreement', 'arbiter-on-disagreement'];

/** Config filenames, most-preferred first. `qa.config.json` is the pre-Spike
 * name, still read so an existing checkout keeps working — drop it at 1.0
 * alongside src/env-compat.ts. */
const CONFIG_FILENAMES = ['spike.config.json', 'qa.config.json'];

function fromFile(cwd: string): Partial<QaConfig> {
  for (const name of CONFIG_FILENAMES) {
    const p = path.join(cwd, name);
    if (!fs.existsSync(p)) continue;
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
  }
  return {};
}

function fromEnv(): Partial<QaConfig> {
  const e = process.env;
  const out: Partial<QaConfig> = {};
  if (e.SPIKE_VIA === 'cdp' || e.SPIKE_VIA === 'extension') out.via = e.SPIKE_VIA;
  if (e.SPIKE_BRIDGE_PORT) out.bridgePort = Number(e.SPIKE_BRIDGE_PORT);
  if (e.SPIKE_BRIDGE_HOST) out.bridgeHost = e.SPIKE_BRIDGE_HOST;
  if (e.SPIKE_EXTENSION_DIR) out.extensionDir = e.SPIKE_EXTENSION_DIR;
  if (e.SPIKE_CDP_PORT) out.cdpPort = Number(e.SPIKE_CDP_PORT);
  if (e.SPIKE_RUNNER_PORT) out.runnerPort = Number(e.SPIKE_RUNNER_PORT);
  if (e.SPIKE_FIXTURE_PORT) out.fixturePort = Number(e.SPIKE_FIXTURE_PORT);
  if (e.SPIKE_CHROME_PROFILE) out.chromeProfile = e.SPIKE_CHROME_PROFILE;
  if (e.SPIKE_GOOGLE_CLI_BIN) out.googleCliBin = e.SPIKE_GOOGLE_CLI_BIN;
  if (e.SPIKE_GOOGLE_CLI_MODEL) out.googleCliModel = e.SPIKE_GOOGLE_CLI_MODEL;
  if (e.GEMINI_API_KEY) out.geminiApiKey = e.GEMINI_API_KEY;
  if (e.SPIKE_ARTIFACTS_DIR) out.artifactsDir = e.SPIKE_ARTIFACTS_DIR;
  if (e.SPIKE_ACTION_CACHE) out.actionCache = e.SPIKE_ACTION_CACHE !== '0' && e.SPIKE_ACTION_CACHE !== 'false';
  if (e.SPIKE_ACTION_CACHE_DIR) out.actionCacheDir = e.SPIKE_ACTION_CACHE_DIR;
  if (e.SPIKE_MAX_STEPS) out.maxSteps = Number(e.SPIKE_MAX_STEPS);
  if (e.SPIKE_FIX_AGENT_BIN) out.fixAgentBin = e.SPIKE_FIX_AGENT_BIN;
  if (e.SPIKE_FIX_AGENT_ARGS) {
    try { out.fixAgentArgs = JSON.parse(e.SPIKE_FIX_AGENT_ARGS); } catch { /* ignore malformed */ }
  }
  if (e.SPIKE_FIX_AGENT_CWD) out.fixAgentCwd = e.SPIKE_FIX_AGENT_CWD;
  if (e.SPIKE_ALLOWED_HOSTS) out.allowedHosts = e.SPIKE_ALLOWED_HOSTS.split(',').map((h) => h.trim()).filter(Boolean);
  if (e.SPIKE_RECORD_CLIP) out.recordClip = e.SPIKE_RECORD_CLIP !== '0' && e.SPIKE_RECORD_CLIP !== 'false';
  if (e.SPIKE_ASSERTION_POLICY && ASSERTION_POLICIES.includes(e.SPIKE_ASSERTION_POLICY as AssertionPolicy)) {
    out.assertionPolicy = e.SPIKE_ASSERTION_POLICY as AssertionPolicy;
  }
  if (e.SPIKE_VIDEO_ASSERTIONS) out.videoAssertions = e.SPIKE_VIDEO_ASSERTIONS !== '0' && e.SPIKE_VIDEO_ASSERTIONS !== 'false';
  if (e.SPIKE_READ_ONLY) out.readOnly = e.SPIKE_READ_ONLY !== '0' && e.SPIKE_READ_ONLY !== 'false';
  if (e.SPIKE_SPEND_CAP_USD) {
    const n = Number(e.SPIKE_SPEND_CAP_USD);
    if (Number.isFinite(n) && n > 0) out.spendCapUsd = n; // 0/garbage → leave unset (no cap)
  }
  if (e.SPIKE_PREFER_FREE_PLANNER) out.preferFreePlanner = e.SPIKE_PREFER_FREE_PLANNER !== '0' && e.SPIKE_PREFER_FREE_PLANNER !== 'false';
  // planner (BRAIN) selection — env wins over the SettingsStore (power-users / tests).
  const planner: Partial<PlannerSelection> = {};
  if (e.SPIKE_PLANNER_PROVIDER && PROVIDERS.includes(e.SPIKE_PLANNER_PROVIDER as ProviderId)) planner.provider = e.SPIKE_PLANNER_PROVIDER as ProviderId;
  if (e.SPIKE_PLANNER_MODE === 'api' || e.SPIKE_PLANNER_MODE === 'cli') planner.mode = e.SPIKE_PLANNER_MODE as PlannerMode;
  if (e.SPIKE_PLANNER_MODEL) planner.model = e.SPIKE_PLANNER_MODEL;
  if (Object.keys(planner).length) out.planner = planner as PlannerSelection;
  // navigator selection — mirrors SPIKE_PLANNER_* (also accepts 'ondevice' for nano).
  const navigator: Partial<PlannerSelection> = {};
  if (e.SPIKE_NAVIGATOR_PROVIDER && PROVIDERS.includes(e.SPIKE_NAVIGATOR_PROVIDER as ProviderId)) navigator.provider = e.SPIKE_NAVIGATOR_PROVIDER as ProviderId;
  if (e.SPIKE_NAVIGATOR_MODE === 'api' || e.SPIKE_NAVIGATOR_MODE === 'cli' || e.SPIKE_NAVIGATOR_MODE === 'ondevice') navigator.mode = e.SPIKE_NAVIGATOR_MODE as PlannerMode;
  if (e.SPIKE_NAVIGATOR_MODEL) navigator.model = e.SPIKE_NAVIGATOR_MODEL;
  if (Object.keys(navigator).length) out.navigator = navigator as PlannerSelection;
  if (e.SPIKE_DEBUG_MODE === 'prompt' || e.SPIKE_DEBUG_MODE === 'auto') out.debugMode = e.SPIKE_DEBUG_MODE;
  if (e.SPIKE_DEBUG_AGENT && DEBUG_AGENTS.includes(e.SPIKE_DEBUG_AGENT as DebugAgent)) out.debugAgent = e.SPIKE_DEBUG_AGENT as DebugAgent;
  return out;
}

/** The user's panel/CLI picks (planner + navigator + debug prefs). Folded in below env.
 *
 * planner/navigator come from readRaw() — NOT read() — so a role the user never
 * explicitly saved stays absent here rather than arriving as SettingsStore's own
 * shared default (DEFAULT_SETTINGS.planner is claude:API, for lite/browser mode,
 * which has no CLI rungs). That would otherwise silently clobber DEFAULTS.planner
 * (claude:CLI, this module's own daemon default) even with zero settings.json on
 * disk — the config-drift bug Phase 13 fixes. readRaw() also performs the
 * dead-planner/missing-navigator migration and rewrites the file when it fires. */
function fromSettings(): Partial<QaConfig> {
  try {
    const store = new SettingsStore();
    const raw = store.readRaw();
    const s = store.read(); // debugMode/debugAgent defaults already match config.ts's own
    const out: Partial<QaConfig> = { debugMode: s.debugMode, debugAgent: s.debugAgent };
    if (raw.planner) out.planner = raw.planner;
    if (raw.navigator) out.navigator = raw.navigator;
    // Only contribute the toggle when the user actually saved it (raw, not the
    // defaulted read) so it never clobbers DEFAULTS.videoAssertions; env still wins.
    if (typeof raw.videoAssertions === 'boolean') out.videoAssertions = raw.videoAssertions;
    // Same "only when the user actually saved it" rule as videoAssertions above —
    // readOnly/spendCapUsd must never clobber DEFAULTS with a defaulted read.
    if (typeof raw.readOnly === 'boolean') out.readOnly = raw.readOnly;
    if (typeof raw.spendCapUsd === 'number') out.spendCapUsd = raw.spendCapUsd;
    return out;
  } catch {
    return {};
  }
}

/** Recovery hint shared with google-cli.ts's runtime error — printed once at
 * config-resolution time so a dead pin surfaces before the run even starts,
 * not just on the first failed call. */
function deadPlannerHint(role: 'brain' | 'navigator'): string {
  return (
    `[qa] warning: ${role} is pinned to gemini:cli — the Gemini CLI free tier (Gemini Code Assist ` +
    'for individuals) ended 2026-06-18 and this client now hard-fails auth. Switch via ' +
    '`spike config set --provider claude --mode cli` (or another BYOK key: glm/gemini/claude/openai), ' +
    'use the `claude`/`codex` CLI, or point googleCliBin at the Antigravity CLI once installed.'
  );
}

/** Startup warning when a resolved role pin is known-dead (Phase 13). Fires
 * only when the FINAL merged config (after settings/env/overrides) still
 * resolves to gemini:cli — the common on-disk case is already migrated away by
 * SettingsStore.readRaw(), so this mainly catches an explicit env/override/
 * spike.config.json pin a power user set deliberately. */
function warnIfDeadPlanner(cfg: QaConfig): void {
  if (isDeadPlannerSelection(cfg.planner)) console.warn(deadPlannerHint('brain'));
  if (isDeadPlannerSelection(cfg.navigator)) console.warn(deadPlannerHint('navigator'));
}

export function loadConfig(overrides: Partial<QaConfig> = {}, cwd = process.cwd()): QaConfig {
  // precedence (low → high): defaults < spike.config.json < SettingsStore < env < overrides.
  // planner env may be a PARTIAL selection — merge it onto whatever's beneath so a
  // lone SPIKE_PLANNER_MODEL doesn't wipe provider/mode.
  const fileCfg = fromFile(cwd);
  const settingsCfg = fromSettings();
  const envCfg = fromEnv();
  const merged: QaConfig = { ...DEFAULTS, ...fileCfg, ...settingsCfg, ...envCfg, ...overrides };
  merged.planner = {
    ...DEFAULTS.planner,
    ...(fileCfg.planner ?? {}),
    ...(settingsCfg.planner ?? {}),
    ...(envCfg.planner ?? {}),
    ...(overrides.planner ?? {}),
  };
  // navigator: same partial-merge precedence as planner (a lone SPIKE_NAVIGATOR_MODEL
  // must not wipe provider/mode).
  merged.navigator = {
    ...DEFAULTS.navigator,
    ...(fileCfg.navigator ?? {}),
    ...(settingsCfg.navigator ?? {}),
    ...(envCfg.navigator ?? {}),
    ...(overrides.navigator ?? {}),
  };
  warnIfDeadPlanner(merged);
  return merged;
}
