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

/** A13 (P1): one interception rule. 'block' aborts the request outright
 * (third-party/analytics — pure speed win, no response is ever synthesized);
 * 'fail' fulfills it with a chosen status (deterministic negative tests —
 * "what does the UI do when this API 500s" without needing to reproduce that
 * by luck). `urlPattern` uses CDP's own glob syntax (`*` wildcard) — the same
 * syntax `Network.setBlockedURLs`/`Fetch.enable` already accept, so no new
 * pattern language is invented here. */
export interface RouteRule {
  urlPattern: string;
  action: 'block' | 'fail';
  /** action:'fail' only — HTTP status to respond with (default 500). */
  status?: number;
  /** action:'fail' only — optional response body. */
  body?: string;
}

/** A13 (P1) viewport/device/network-throttle emulation, applied via CDP's
 * Emulation/Network domains (transport-agnostic — works over any BrowserPort
 * that exposes `cdpClient()`, not just the Playwright transport). */
export interface EmulationConfig {
  viewport?: { width: number; height: number };
  deviceScaleFactor?: number;
  isMobile?: boolean;
  /** Named presets, or explicit CDP-shaped throttle numbers (bytes/sec, ms). */
  networkThrottle?: 'offline' | 'slow-3g' | 'fast-3g' | { downloadThroughput: number; uploadThroughput: number; latency: number };
}

export interface QaConfig {
  /** Transport that drives Chrome: daemon-launched CDP, the MV3 extension
   * bridge, or Playwright attached via connectOverCDP (A3/A6/A13 — see
   * ports/playwright-browser.ts and docs/plan/26-08-08-audit-deterministic-
   * speed.md finding A26). Default stays 'cdp' — 'playwright' is opt-in. */
  via: 'cdp' | 'extension' | 'playwright';
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
  /** A10 (P0): explicit Chrome/Chromium executable override, for any
   * install off the standard-locations candidate list (Linux distros,
   * Chromium/snap/flatpak/Chrome-for-Testing, non-default install dirs).
   * Unset (default) → chrome/launch.ts's findChrome() falls back to the
   * hardcoded per-OS candidates. The SPIKE_CHROME_PATH env var (checked
   * directly inside findChrome) always wins over this field, matching this
   * file's env-beats-config resolution order. Not yet threaded through every
   * ensureChrome() call site — see chrome/launch.ts's LaunchOptions.chromePath. */
  chromePath?: string;
  /** A7 (P1): run the QA browser's Chrome headless. Default false (unchanged
   * behavior) — every product call site used to hardcode `headless: false`.
   * Gemini Nano's availability in headless is undocumented/unproven
   * (nano-runner-page.ts), so a headless run either skips the opportunistic
   * $0 Nano rung (qaRun) or, when the run genuinely needs Nano (a replay
   * script with an `assert_visual` step), splits Nano onto its OWN headed
   * Chrome via nanoCdpPort/nanoProfileDir below rather than dragging it into
   * the headless one. See engine.ts's resolveNanoLaunchOpts(). */
  headless: boolean;
  /** A7 (P1): CDP port for Nano's OWN Chrome when it must be split from the
   * (headless) QA browser's Chrome. Unset (default) → when headless is also
   * false this is irrelevant (Nano shares cfg.cdpPort, today's behavior
   * unchanged); when headless is true and this is unset, engine.ts allocates
   * a free port dynamically per run rather than colliding two Chrome
   * processes on one port. Set this to pin a stable port instead (e.g. a
   * long-running headless daemon that wants Nano's Chrome at a fixed
   * address). */
  nanoCdpPort?: number;
  /** A7 (P1): profile dir for Nano's split-off Chrome (see nanoCdpPort) — two
   * Chrome processes can never share one --user-data-dir. Unset (default) →
   * `${chromeProfile}-nano` when a split is actually needed. */
  nanoProfileDir?: string;
  /** A13 (P1): network interception rules — block third-party/analytics for
   * speed, or force an error status for deterministic negative tests. Empty
   * (default) — no interception, unchanged behavior. Config-driven (spike.
   * config.json / SPIKE_ROUTE_RULES) so a suite can declare it once. */
  routeRules: RouteRule[];
  /** A13 (P1): viewport/device/network-throttle emulation for the whole
   * session. Unset (default) — no emulation, unchanged behavior. */
  emulation?: EmulationConfig;
  /** Rung-1 Google CLI binary (gemini today, antigravity after 2026-06-18 — never hardcode). */
  googleCliBin: string;
  /** Rung-1 model id passed to the CLI. */
  googleCliModel: string;
  /** Rung-2 BYOK Gemini API key (absent → rung 2 unavailable). */
  geminiApiKey?: string;
  /** Extra env for the Google CLI child process (e.g. NODE_OPTIONS=--use-system-ca
   * behind a TLS-intercepting antivirus or corporate proxy — AVG, Zscaler, etc.).
   * A36: set SPIKE_NO_SYSTEM_CA=1 to omit that flag from the default (see
   * defaultGoogleCliEnv() below). */
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
  /** A30 (A24 Tier 1): capture a per-flow baseline (AX shape + network shape)
   * at the end of a run and, when one already exists, diff against it. Default
   * FALSE: a baseline that nobody blessed will flag every intentional UI change
   * as a difference, so this must be opted into per project. Off = today's
   * behaviour exactly. */
  differential: boolean;
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
  /** A1 (P0): let the deterministic oracle layer (Tier-0 invariants, the
   * precise assert_* verbs, Tier-2 metamorphic relations) GATE the final
   * verdict instead of merely informing it — see driver/loop.ts's
   * findStrictOracleViolation. Default TRUE: the product's own flagship demo
   * bug (a rendered-undefined total) must not slip past as a model-judged
   * pass. Set false to restore the pre-A1 evidence-only behavior. */
  strictOracles: boolean;
  /** Email/OTP module wiring: which EmailProvider (src/email/) the driver's
   * `wait_for_email` action polls. 'none' (default) — the action fails
   * cleanly rather than silently no-op'ing. 'fake-local' is the only
   * concrete provider today (dogfood/tests — see fixture/server.ts's
   * exported fixtureEmailProvider); a real IMAP/Gmail provider is a future
   * addition, not built here. NOTE: this field selects the provider KIND —
   * the caller that builds LoopOptions still injects the actual EmailProvider
   * instance (LoopOptions.emailProvider), same indirection as `vault`. */
  emailProvider: 'none' | 'fake-local';
}

/** A36 (P1): `NODE_OPTIONS=--use-system-ca` makes the Google CLI child trust the
 * OS certificate store instead of Node's bundled one — needed on machines
 * behind a TLS-intercepting antivirus or corporate proxy (AVG, Zscaler, …)
 * that MITMs outbound TLS with its own cert, otherwise the CLI's OAuth calls
 * fail (exit 41). Baked in by default since it's harmless where it isn't
 * needed and this workaround exists precisely for that audience; set
 * SPIKE_NO_SYSTEM_CA=1 to omit it entirely. Exported so tests can exercise the
 * gating logic directly without needing to reload this module (DEFAULTS below
 * calls this once at import time, same as chromeProfile's LOCALAPPDATA/HOME
 * read). */
export function defaultGoogleCliEnv(): Record<string, string> {
  if (process.env.SPIKE_NO_SYSTEM_CA === '1' || process.env.SPIKE_NO_SYSTEM_CA === 'true') return {};
  return { NODE_OPTIONS: '--use-system-ca' };
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
  // A7: headed by default — exactly today's hardcoded behavior at every call site.
  headless: false,
  // nanoCdpPort/nanoProfileDir intentionally absent — undefined means "derive
  // from headless/chromeProfile at session-open time" (see engine.ts).
  // A13: no interception/emulation by default — unchanged behavior.
  routeRules: [],
  googleCliBin: 'gemini',
  googleCliModel: 'gemini-3-flash-preview',
  googleCliEnv: defaultGoogleCliEnv(),
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
  differential: false,
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
  // A1: deterministic oracles gate the verdict by default — see QaConfig.strictOracles.
  strictOracles: true,
  // no email provider wired by default — see QaConfig.emailProvider.
  emailProvider: 'none',
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
  if (e.SPIKE_VIA === 'cdp' || e.SPIKE_VIA === 'extension' || e.SPIKE_VIA === 'playwright') out.via = e.SPIKE_VIA;
  if (e.SPIKE_BRIDGE_PORT) out.bridgePort = Number(e.SPIKE_BRIDGE_PORT);
  if (e.SPIKE_BRIDGE_HOST) out.bridgeHost = e.SPIKE_BRIDGE_HOST;
  if (e.SPIKE_EXTENSION_DIR) out.extensionDir = e.SPIKE_EXTENSION_DIR;
  if (e.SPIKE_CDP_PORT) out.cdpPort = Number(e.SPIKE_CDP_PORT);
  if (e.SPIKE_RUNNER_PORT) out.runnerPort = Number(e.SPIKE_RUNNER_PORT);
  if (e.SPIKE_FIXTURE_PORT) out.fixturePort = Number(e.SPIKE_FIXTURE_PORT);
  if (e.SPIKE_CHROME_PROFILE) out.chromeProfile = e.SPIKE_CHROME_PROFILE;
  // A10: SPIKE_CHROME_PATH is also checked directly inside chrome/launch.ts's
  // findChrome() (env always wins there too) — reading it into config as
  // well lets a resolved QaConfig.chromePath be threaded through explicitly
  // by callers that build LaunchOptions from config.
  if (e.SPIKE_CHROME_PATH) out.chromePath = e.SPIKE_CHROME_PATH;
  // A7
  if (e.SPIKE_HEADLESS) out.headless = e.SPIKE_HEADLESS !== '0' && e.SPIKE_HEADLESS !== 'false';
  if (e.SPIKE_NANO_CDP_PORT) out.nanoCdpPort = Number(e.SPIKE_NANO_CDP_PORT);
  if (e.SPIKE_NANO_PROFILE_DIR) out.nanoProfileDir = e.SPIKE_NANO_PROFILE_DIR;
  // A13: SPIKE_ROUTE_RULES is a JSON-encoded RouteRule[]; SPIKE_BLOCK_HOSTS is a
  // comma list of glob patterns folded in as convenience 'block' rules (both
  // may be present at once — block rules are appended, never replace explicit
  // JSON rules). Malformed JSON is ignored rather than crashing config load.
  {
    const rules: RouteRule[] = [];
    if (e.SPIKE_ROUTE_RULES) {
      try {
        const parsed: unknown = JSON.parse(e.SPIKE_ROUTE_RULES);
        if (Array.isArray(parsed)) {
          for (const r of parsed) {
            if (r && typeof r === 'object' && typeof (r as RouteRule).urlPattern === 'string' && ((r as RouteRule).action === 'block' || (r as RouteRule).action === 'fail')) {
              rules.push(r as RouteRule);
            }
          }
        }
      } catch { /* ignore malformed */ }
    }
    if (e.SPIKE_BLOCK_HOSTS) {
      for (const pattern of e.SPIKE_BLOCK_HOSTS.split(',').map((h) => h.trim()).filter(Boolean)) {
        rules.push({ urlPattern: pattern, action: 'block' });
      }
    }
    if (rules.length) out.routeRules = rules;
  }
  if (e.SPIKE_VIEWPORT) {
    const m = /^(\d+)x(\d+)$/.exec(e.SPIKE_VIEWPORT.trim());
    if (m) out.emulation = { ...out.emulation, viewport: { width: Number(m[1]), height: Number(m[2]) } };
  }
  if (e.SPIKE_NETWORK_THROTTLE === 'offline' || e.SPIKE_NETWORK_THROTTLE === 'slow-3g' || e.SPIKE_NETWORK_THROTTLE === 'fast-3g') {
    out.emulation = { ...out.emulation, networkThrottle: e.SPIKE_NETWORK_THROTTLE };
  }
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
  if (e.SPIKE_DIFFERENTIAL) out.differential = e.SPIKE_DIFFERENTIAL !== '0' && e.SPIKE_DIFFERENTIAL !== 'false';
  if (e.SPIKE_READ_ONLY) out.readOnly = e.SPIKE_READ_ONLY !== '0' && e.SPIKE_READ_ONLY !== 'false';
  // A1: default is true (DEFAULTS.strictOracles) — only an explicit '0'/'false' opts out.
  if (e.SPIKE_STRICT_ORACLES) out.strictOracles = e.SPIKE_STRICT_ORACLES !== '0' && e.SPIKE_STRICT_ORACLES !== 'false';
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
  if (e.SPIKE_EMAIL_PROVIDER === 'none' || e.SPIKE_EMAIL_PROVIDER === 'fake-local') out.emailProvider = e.SPIKE_EMAIL_PROVIDER;
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
    if (typeof raw.strictOracles === 'boolean') out.strictOracles = raw.strictOracles;
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
