/* engine — the single core both transports (MCP + CLI) call.
 *
 * qaRun:    AI-driven exploration; a PASSED run is recorded to
 *           generated-tests/ (JSON trace + Playwright .spec.ts twin).
 * qaReplay: deterministic re-run of a recorded script — zero planner calls,
 *           Nano-only visuals; with heal=true a failed replay re-engages the
 *           driver on the original task and re-emits the script.
 *
 * One headed Chrome instance (daemon ports/profile) hosts both the QA tab
 * (CdpBrowser) and the Nano runner tab (NanoRunnerPage); Chrome and the runner
 * tab survive across runs so the on-device model stays warm. Rung 0 is an
 * optimization, not a dependency: without Nano the router starts at rung 1. */

import type { ChildProcess } from 'node:child_process';
import type CDP from 'chrome-remote-interface';
import { loadConfig, readOnlyWasConfigured, type EmulationConfig, type QaConfig, type RouteRule } from './config.js';
import { CdpBrowser } from './ports/cdp-browser.js';
import { ExtensionBrowser } from './ports/extension-browser.js';
// A52 (P2): playwright-core is a large optional dependency (`--via
// playwright` only) — type-only import here (erased at compile time, no
// runtime module load); the real class is dynamic-`import()`ed lazily inside
// the `cfg.via === 'playwright'` branch below, the only place a value
// reference is needed.
import type { PlaywrightBrowser } from './ports/playwright-browser.js';
import { NanoRunnerPage } from './ports/nano-runner-page.js';
import { ExtensionNano } from './ports/extension-nano.js';
import type { NanoPort } from './ports/nano-port.js';
import { BridgeServer } from './bridge/bridge-server.js';
import { launchChromeWithExtension } from './chrome/extensions.js';
import { cdpAlive, allocateFreePort } from './chrome/launch.js';
import type { BrowserPort } from './ports/browser-port.js';
import { ModelRouter } from './router/model-router.js';
import type { ModelAdapter } from './router/adapter.js';
import { NanoAdapter } from './router/adapters/nano.js';
import { GoogleCliAdapter } from './router/adapters/google-cli.js';
import { ByokGeminiAdapter } from './router/adapters/byok-gemini.js';
import { OllamaAdapter } from './router/adapters/ollama.js';
import { AnthropicAdapter } from './router/adapters/anthropic.js';
import { OpenAiCompatibleAdapter } from './router/adapters/openai-compatible.js';
import { CliPlannerAdapter } from './router/adapters/cli-planner.js';
import { openAiGatewayOptions } from './router/gateway.js';
import { defaultModelFor, type PlannerMode, type ProviderId } from './vibe/settings.js';
import { ArtifactStore } from './report/artifacts.js';
import { runDriverLoop, type StepInfo } from './driver/loop.js';
import { Vault } from './vault/vault.js';
import type { Report, RunVerdict } from './report/report.js';
import { recordRunCoverage } from './discovery/record-coverage.js';
import { compareToBaseline, loadBaseline, saveBaseline } from './assertions/differential.js';
import { detectRelationCandidates } from './assertions/metamorphic.js';
import { diffScripts, loadScript, saveScript, scriptFromReport, scriptsDir, type QaScript } from './recorder/script.js';
import { classifyHeal, type HealTier } from './recorder/heal-policy.js';
import { replayScript } from './recorder/replay.js';
import { matchReplayScriptDetailed, NEAR_MISS_MARGIN, type ReplayMatch } from './recorder/matcher.js';
import { startClipRecorder, type ClipRecorder } from './clip/screencast.js';
import { FileActionCache } from './cache/action-cache.js';
import { getDefaultTracer } from './telemetry/env.js';
import type { ActiveSpan } from './telemetry/tracer.js';
import fs from 'node:fs';
import path from 'node:path';

export interface QaRunOptions {
  maxSteps?: number;
  /** Record a passed run to generated-tests/ (default true). */
  record?: boolean;
  /** Phase 14 pre-run replay matcher: when true (default) and a confident
   * matching recorded script exists for this task+url, replay it
   * deterministically ($0) instead of running a fresh AI pass; on replay
   * failure this falls back to a fresh AI run automatically. CLI: `--no-replay`
   * sets this false. Also forced false internally when qaReplay's `--heal`
   * re-engages the driver on a specific script, so healing never re-matches
   * and re-replays the very script that just failed. */
  replay?: boolean;
  config?: Partial<QaConfig>;
  /** Progress lines (CLI prints them; MCP ignores). */
  onProgress?: (line: string) => void;
  /** Structured per-step hook (vibe panel animates these). Threaded into the
   * driver loop by the planner-side work; forwarded as vibe.step events. */
  onStep?: (info: StepInfo) => void;
  /** Caller-owned bridge (extension mode). When the panel already drives an
   * attached Chrome, the daemon reuses this bridge instead of spawning its own;
   * ownership (and close()) stays with the caller. */
  bridge?: BridgeServer;
  /** Vibe mode: attach to the user's CURRENT tab (panel-supplied) instead of
   * creating a fresh one. cdp mode ignores this. */
  tabId?: number;
  /** Multi-Chrome bridge: bind this run to the specific bridge client that asked
   * (the Chrome whose panel issued vibe.run), so a second connected Chrome can't
   * have its tabs driven by this run. Absent → default (most-recent) client. */
  clientId?: number;
  /** Cooperative cancellation, threaded into the driver loop: when aborted the
   * run ends 'uncertain' / 'cancelled by user'. (vibe.cancel depends on this.) */
  signal?: AbortSignal;
  /** Trust the explicit `url` the caller named as a target worth interacting
   * with — its host (plus the www./bare-domain variant, since apex↔www
   * redirects are common) is added to the Tier-4 allowedHosts guard for this
   * run, so `spike run "..." --url <anything>` can click/type end-to-end against
   * any site/app/no-code builder without a separate --allow-host flag. Default
   * true for CLI/MCP callers, where naming the URL on the command line already
   * IS the consent. The vibe panel (an unattended browser extension driving
   * whatever tab happens to be open) sets this false unless the user has
   * checked its own "allow click/type on this site" consent toggle. Hosts
   * OTHER than the named target (ad iframes, unexpected redirects) still stay
   * read-only unless separately allow-listed. */
  trustTargetHost?: boolean;
  /** A1 (P0): look-only mode for THIS run — the driver navigates and checks the
   * page but refuses every click/type/submit. Highest precedence: it overrides
   * spike.config.json / SPIKE_READ_ONLY / the saved settings.
   *
   * Absent is the interesting case. `readOnly` defaults to TRUE in config (a
   * safe posture for the browser extension, which drives whatever tab happens
   * to be open), but a caller who NAMED a target url — `spike run --url`, the
   * `qa_run` tool — has already said "drive this page", exactly the way
   * `trustTargetHost` treats that url as host consent. So when the target host
   * is trusted AND nobody configured `readOnly` explicitly, the effective
   * value is false; otherwise the configured value stands. `spike run
   * --read-only` sets this true for the look-only case. See resolveReadOnly. */
  readOnly?: boolean;
  /** A7 (P1): run the QA browser's Chrome headless for THIS run, overriding
   * cfg.headless. Absent → cfg.headless (default false, unchanged behavior).
   * A headless qaRun skips the opportunistic rung-0 Nano probe entirely
   * (ladder starts at rung 1) rather than dragging Nano into a headless
   * Chrome or spinning up a second headed one just for a live AI-driven
   * run — see CLAUDE.md's headed requirement for Nano and this file's
   * resolveNanoLaunchOpts(). The fully-worked-out split (Nano on its own
   * headed Chrome while the rest runs headless) is wired for qaReplay below,
   * where "does this run even need Nano" is a cheap static check on the
   * recorded script rather than a guess. */
  headless?: boolean;
  /** A6 (P1): load this storage-state file (cookies + localStorage) into the
   * session's browser context before the driver starts — the injection half
   * of "log in once, reuse everywhere". Absent → session starts with
   * whatever the transport's own default context already has (unchanged
   * behavior). See captureStorageState/injectStorageState below for the
   * shape (Playwright's own storageState() format; a raw-CDP fallback
   * produces/consumes the identical shape for the cdp/extension transports). */
  storageStatePath?: string;
  /** A6 (P1): on a PASSING run only, capture the session's storage state and
   * write it to this path — the capture half of the auth fixture. Absent →
   * no capture (unchanged behavior). */
  saveStorageStatePath?: string;
}

export interface QaRunResult extends Report {
  /** Path of the recorded script, when the run passed and recording is on. */
  recordedScript?: string;
  /** Set when this result came from a matched $0 replay (Phase 14) rather than
   * a fresh AI run — the matched script's name and match score. Absent on a
   * fresh AI-driven run. */
  replayMatch?: { name: string; score: number };
  /** A10 (P1): set when the matcher DID find a confident replay candidate but
   * that replay came back fail/errored, so qaRun silently fell back to a
   * fresh AI pass — without this field, that fallback (replay time PLUS a
   * full AI run) is invisible to any `--json`/MCP/programmatic caller that
   * doesn't wire onProgress. Absent when no match was attempted, or the
   * matched replay itself passed/was uncertain. */
  replayFallback?: {
    name: string;
    score: number;
    /** The verdict the matched replay actually produced, or 'uncertain' when
     * the replay threw before producing one (see `reason`). */
    replayVerdict: RunVerdict;
    reason: 'replay-failed' | 'replay-error';
  };
}

/** Browser-only session — the transport (CdpBrowser or ExtensionBrowser) plus
 * whatever process/bridge it stood up. Nano is composed on top by openSession;
 * kept out of this contract so a no-AI caller (tests) can drive the browser
 * alone without touching the Nano profile. */
export interface BrowserSession {
  cfg: QaConfig;
  browser: BrowserPort;
  /** Present only when this session SPAWNED a Chrome (extension mode, cold). */
  chromeProcess?: ChildProcess;
  close(): Promise<void>;
}

/**
 * Open just the browser transport per cfg.via. Shared by qaRun/qaReplay (which
 * compose Nano on top) and by no-AI tests (which drive the browser directly).
 *
 *  - 'cdp':       a daemon-launched CdpBrowser on cfg.cdpPort (today's behavior).
 *  - 'extension': a BridgeServer on cfg.bridgePort + an ExtensionBrowser over it.
 *                 Reuse-if-alive: if a Chrome already listens on cfg.cdpPort we
 *                 assume the profile already has the extension dev-loaded (it
 *                 persists in the profile) and just wait for the SW to connect;
 *                 otherwise we spawn a fresh Chrome with the extension loaded.
 */
export async function openBrowserSession(
  config: Partial<QaConfig> = {},
  deps: { bridge?: BridgeServer; tabId?: number; clientId?: number; allowedHosts?: string[] } = {},
): Promise<BrowserSession> {
  const cfg = loadConfig(config);

  if (cfg.via === 'extension') {
    // Injected bridge (vibe daemon): the caller owns it — never close it here and
    // never spawn Chrome (the user's own Chrome is already attached via the panel).
    const injected = deps.bridge;
    const bridge = injected ?? new BridgeServer(cfg.bridgePort, cfg.bridgeHost);
    let chromeProcess: ChildProcess | undefined;
    try {
      if (injected) {
        // The panel's Chrome is already attached to this bridge — its SW is
        // connected. Skip the cdpAlive/spawn dance entirely.
      } else if (await cdpAlive(cfg.cdpPort)) {
        // Chrome already up on this port — its persistent profile should carry
        // the extension. Nothing to spawn; the SW reconnects to our bridge.
      } else {
        const { chrome } = await launchChromeWithExtension({
          cdpPort: cfg.cdpPort,
          extensionDir: cfg.extensionDir,
          profileDir: cfg.chromeProfile,
          headless: cfg.headless, // A7 — default false, unchanged behavior
        });
        chromeProcess = chrome;
      }

      const browser = new ExtensionBrowser({ bridge, attachTabId: deps.tabId, clientId: deps.clientId, connectTimeoutMs: 20_000, allowedHosts: deps.allowedHosts });
      try {
        await browser.launch(); // waits for the bridge connection, then creates the tab
      } catch (e) {
        throw new Error(
          `extension transport failed to connect within ~20s: ${
            e instanceof Error ? e.message : String(e)
          }. A Chrome may be running on CDP port ${cfg.cdpPort} WITHOUT the QA extension loaded — ` +
            `close that Chrome (or set SPIKE_CDP_PORT to a free port) so a fresh Chrome with the extension can launch.`,
        );
      }

      return {
        cfg,
        browser,
        chromeProcess,
        async close() {
          await browser.close();
          // Injected bridge: ownership stays with the caller — don't close it.
          if (!injected) await bridge.close();
          // Chrome stays warm (same as cdp mode); we never kill it here.
        },
      };
    } catch (e) {
      // Only close a bridge WE created — never the caller's injected one.
      if (!injected) { try { await bridge.close(); } catch { /* already closed */ } }
      throw e;
    }
  }

  // A3/A6/A13 (P1): 'playwright' — PlaywrightBrowser attached via
  // connectOverCDP to the SAME Chrome ensureChrome() would give CdpBrowser
  // (see docs/plan/26-08-08-audit-deterministic-speed.md finding A26,
  // RESOLVED). A fresh, genuinely isolated BrowserContext per session is the
  // whole point — that's PlaywrightBrowser.launch()'s own doc comment, not
  // rebuilt here. Also the transport that exposes storageState()/
  // setStorageState() (A6) and route() (A13) — see this file's
  // applyRouteRules/applyEmulation/captureStorageState/injectStorageState.
  if (cfg.via === 'playwright') {
    // A52 (P2): lazy-load playwright-core (optionalDependency) only when a
    // caller actually asks for --via playwright — everyone else (the
    // default cdp/extension transports) never pays to resolve it. A missing
    // playwright-core surfaces here as a clear, actionable error instead of
    // a bare "Cannot find package 'playwright-core'" from deep inside the
    // module graph.
    const { PlaywrightBrowser } = await import('./ports/playwright-browser.js').catch((e: unknown) => {
      throw new Error(
        `install playwright-core to use --via playwright (npm install playwright-core): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    });
    const browser = new PlaywrightBrowser({
      port: cfg.cdpPort,
      profileDir: cfg.chromeProfile,
      headless: cfg.headless, // A7 — default false, unchanged behavior
      allowedHosts: deps.allowedHosts,
      chromePath: cfg.chromePath,
    });
    await browser.launch();
    return {
      cfg,
      browser,
      async close() {
        await browser.close(); // this run's BrowserContext closes; Chrome stays warm
      },
    };
  }

  // 'cdp' — exactly today's behavior.
  const browser = new CdpBrowser({
    port: cfg.cdpPort,
    profileDir: cfg.chromeProfile,
    headless: cfg.headless, // A7 — default false, unchanged (headed: Nano lives here, and this window is the future "watch the robot" show)
    allowedHosts: deps.allowedHosts,
    chromePath: cfg.chromePath,
  });
  await browser.launch();
  return {
    cfg,
    browser,
    async close() {
      await browser.close(); // QA tab closes; Chrome stays warm
    },
  };
}

interface Session {
  cfg: QaConfig;
  browser: BrowserPort;
  /** null when the caller opted out via `wantNano: false` (A7 — a headless
   * run that doesn't need Nano skips constructing it at all, rather than
   * starting one just to report 'unavailable'). */
  nano: NanoPort | null;
  close(): Promise<void>;
}

/** A7 (P1): where Nano's OWN Chrome/profile should live for this cfg.
 *
 *  - `cfg.headless === false` (default): unchanged from before this finding
 *    — Nano shares the QA browser's Chrome (cfg.cdpPort/chromeProfile/
 *    runnerPort), exactly today's "one headed Chrome hosts both tabs"
 *    design.
 *  - `cfg.headless === true`: the QA browser's Chrome is headless, and Nano's
 *    documented requirement is headed (nano-runner-page.ts) — so it needs a
 *    SEPARATE Chrome process, which also means a separate `--user-data-dir`
 *    (two Chromes can never share one) and, if nothing pins `cfg.
 *    nanoCdpPort`, a separate CDP port too (reusing cfg.cdpPort would either
 *    attach Nano to the already-running HEADLESS Chrome via ensureChrome()'s
 *    reuse-if-alive check, or collide with it — neither is right). A pinned
 *    `nanoCdpPort` keeps `runnerPort` as-is (the operator's problem to keep
 *    distinct across whatever else runs); an UNPINNED one also gets a freshly
 *    allocated `runnerPort`, since two NanoRunnerPage HTTP servers on the
 *    same port from two different Chrome processes is exactly the EADDRINUSE
 *    failure the audit calls out (A3) — allocateFreePort() sidesteps it
 *    entirely rather than asking the operator to manage a second fixed port. */
export async function resolveNanoLaunchOpts(cfg: QaConfig): Promise<{ cdpPort: number; runnerPort: number; profileDir: string }> {
  if (!cfg.headless) return { cdpPort: cfg.cdpPort, runnerPort: cfg.runnerPort, profileDir: cfg.chromeProfile };
  if (cfg.nanoCdpPort) {
    return { cdpPort: cfg.nanoCdpPort, runnerPort: cfg.runnerPort, profileDir: cfg.nanoProfileDir ?? `${cfg.chromeProfile}-nano` };
  }
  const [cdpPort, runnerPort] = await Promise.all([allocateFreePort(), allocateFreePort()]);
  return { cdpPort, runnerPort, profileDir: cfg.nanoProfileDir ?? `${cfg.chromeProfile}-nano` };
}

async function openSession(
  config: Partial<QaConfig>,
  deps: { bridge?: BridgeServer; tabId?: number; clientId?: number; allowedHosts?: string[]; wantNano?: boolean } = {},
): Promise<Session> {
  const browserSession = await openBrowserSession(config, deps);
  const { cfg } = browserSession;
  const wantNano = deps.wantNano ?? true; // default true: unchanged from before this finding
  let nano: NanoPort | null = null;
  if (wantNano) {
    // Nano access depends on HOW Chrome got here:
    //  - injected bridge (vibe path: the user's own Chrome, no daemon CDP) → talk
    //    to the extension's own Prompt API over the bridge (ExtensionNano). There
    //    is no daemon CDP page here to host the localhost runner.
    //  - we launched Chrome ourselves (proven cdp path; extension mode that
    //    spawned its own Chrome) → NanoRunnerPage, split onto its own
    //    port/Chrome when cfg.headless (A7 — see resolveNanoLaunchOpts).
    if (cfg.via === 'extension' && deps.bridge) {
      nano = new ExtensionNano({ bridge: deps.bridge });
    } else {
      const nanoOpts = await resolveNanoLaunchOpts(cfg);
      nano = new NanoRunnerPage(nanoOpts);
    }
    try {
      await nano.start();
    } catch (e) {
      await browserSession.close();
      throw e;
    }
  }
  return {
    cfg,
    browser: browserSession.browser,
    nano,
    async close() {
      await browserSession.close(); // QA tab closes; Chrome + runner tab stay warm
      if (nano) await nano.close();
    },
  };
}

/* =============================================================================
 * A6 (P1) — storage-state capture / injection ("log in once, reuse everywhere")
 * ========================================================================== */

/** The file format for a captured session (cookies + per-origin localStorage).
 * Deliberately its OWN type rather than a re-export of Playwright's
 * `setStorageState`/`storageState` types: those make `sameSite` required on
 * the way IN but the way OUT (`storageState()`'s return) is structurally
 * identical anyway, and keeping an independent type here means the raw-CDP
 * fallback (cdp/extension transports) never has to fight Playwright's type
 * shape to construct one. `sameSite` is always populated (defaulted to
 * 'Lax' — Chrome's own default for a cookie set without an explicit
 * attribute) rather than left optional, precisely so it satisfies
 * PlaywrightBrowser.setStorageState()'s stricter required field with no cast
 * needed at the call site below. */
export interface StorageState {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    /** Unix time in seconds; session cookies use -1, matching CDP's Cookie shape. */
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: 'Strict' | 'Lax' | 'None';
  }>;
  origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
}

/** A52 (P2): duck-typed, not `instanceof PlaywrightBrowser` — this helper is
 * called from captureStorageState/injectStorageState for ANY transport
 * (cdp/extension too), and the PlaywrightBrowser class value may never have
 * been loaded (playwright-core is now lazy, see the `cfg.via ===
 * 'playwright'` branch above) when those run over cdp/extension. Its two
 * storage-state methods are unique to this port, so their presence is a
 * reliable, load-free stand-in for the class check. */
function asPlaywrightBrowser(browser: BrowserPort): PlaywrightBrowser | null {
  const b = browser as Partial<PlaywrightBrowser>;
  return typeof b.storageState === 'function' && typeof b.setStorageState === 'function'
    ? (browser as PlaywrightBrowser)
    : null;
}

/** Capture the session's current cookies + localStorage. Prefers
 * PlaywrightBrowser's own `storageState()` (native — proven by the A26 spike
 * to reflect the run's isolated BrowserContext exactly); falls back to raw
 * CDP for the cdp/extension transports (finding A6's explicit "keep a
 * raw-CDP fallback via cdpClient()" requirement): `Network.getCookies()` for
 * cookies, plus a `Runtime.evaluate` read of `window.localStorage` on
 * whatever origin the page is CURRENTLY on (the only origin a single-page
 * CDP session can see localStorage for without navigating away first — a
 * caller that needs multiple origins' localStorage should capture right
 * after visiting each one). */
export async function captureStorageState(browser: BrowserPort): Promise<StorageState> {
  const pw = asPlaywrightBrowser(browser);
  if (pw) return pw.storageState();

  const client = browser.cdpClient?.() as CDP.Client | undefined;
  if (!client) throw new Error('captureStorageState: this transport exposes no cdpClient() — cannot capture storage state');
  const { cookies } = await client.Network.getCookies();
  let origins: StorageState['origins'] = [];
  try {
    const origin = new URL(await browser.url()).origin;
    const { result } = await client.Runtime.evaluate({
      expression: 'JSON.stringify(Object.entries(window.localStorage))',
      returnByValue: true,
    });
    const entries = JSON.parse((result.value as string | undefined) ?? '[]') as Array<[string, string]>;
    if (entries.length) origins = [{ origin, localStorage: entries.map(([name, value]) => ({ name, value })) }];
  } catch {
    // current page has no accessible localStorage (about:blank, opaque
    // origin, a cross-origin restriction) — cookies alone are still useful.
  }
  return {
    cookies: cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite ?? 'Lax',
    })),
    origins,
  };
}

/** Inject a previously-captured state. Prefers PlaywrightBrowser's
 * `setStorageState()` (its own documented semantics: clears then restores in
 * one call); the raw-CDP fallback sets cookies directly (domain-scoped, no
 * navigation needed) and, for localStorage, navigates to EACH captured
 * origin in turn before setting its entries — localStorage is only settable
 * on a page currently showing that origin. Callers should inject BEFORE the
 * driver's own first navigation; the extra origin hop(s) this may cause are
 * harmless (the driver navigates to its target url immediately after). */
export async function injectStorageState(browser: BrowserPort, state: StorageState): Promise<void> {
  const pw = asPlaywrightBrowser(browser);
  if (pw) {
    await pw.setStorageState(state);
    return;
  }
  const client = browser.cdpClient?.() as CDP.Client | undefined;
  if (!client) throw new Error('injectStorageState: this transport exposes no cdpClient() — cannot inject storage state');
  if (state.cookies.length) await client.Network.setCookies({ cookies: state.cookies });
  for (const o of state.origins) {
    if (!o.localStorage.length) continue;
    await browser.navigate(o.origin);
    for (const { name, value } of o.localStorage) {
      await client.Runtime.evaluate({ expression: `window.localStorage.setItem(${JSON.stringify(name)}, ${JSON.stringify(value)})` });
    }
  }
}

/** Read a storage-state file written by saveStorageStateFile (or Playwright's
 * own `storageState({ path })`, which is the same JSON shape). */
export function loadStorageStateFile(p: string): StorageState {
  return JSON.parse(fs.readFileSync(p, 'utf8')) as StorageState;
}

export function saveStorageStateFile(p: string, state: StorageState): void {
  fs.mkdirSync(path.dirname(path.resolve(p)), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(state, null, 2));
}

/* =============================================================================
 * A13 (P1) — network interception + viewport/device/network-throttle emulation
 * ========================================================================== */

/** Turns a CDP-style glob (`*` = zero-or-more, `?` = exactly one — the same
 * syntax `Network.setBlockedURLs`/`Fetch.enable` accept) into a RegExp, so a
 * single `RouteRule.urlPattern` can drive BOTH the CDP-side match (for
 * `Network.setBlockedURLs`, which does its own glob matching in the browser)
 * AND our own Node-side dispatch inside the `Fetch.requestPaused` handler
 * below, which has to decide in JS which configured rule paused a given
 * request — CDP's `Fetch.enable` patterns filter WHICH requests pause, but
 * the paused event itself doesn't say which pattern matched. */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

/** Apply `rules` via raw CDP (works over ANY transport that exposes
 * `cdpClient()` — cdp, playwright, extension — rather than routed through
 * PlaywrightBrowser's own `route()`, which only the playwright transport
 * has; see this file's header comment on A13). 'block' rules go through
 * `Network.setBlockedURLs` (the browser aborts them before they're even
 * issued — cheapest possible block, ideal for third-party/analytics speed
 * wins). 'fail' rules go through `Fetch.enable` + a `requestPaused` handler
 * that fulfills a matching request with the configured status instead of
 * letting it reach the network — deterministic negative-path testing ("what
 * does the UI do when this API 500s") without needing to reproduce that by
 * luck. No-ops (never throws) when the transport has no `cdpClient()` or
 * `rules` is empty — callers don't need to guard the call. */
export async function applyRouteRules(browser: BrowserPort, rules: RouteRule[]): Promise<void> {
  if (rules.length === 0) return;
  const client = browser.cdpClient?.() as CDP.Client | undefined;
  if (!client) return;

  const blockPatterns = rules.filter((r) => r.action === 'block').map((r) => r.urlPattern);
  if (blockPatterns.length) await client.Network.setBlockedURLs({ urls: blockPatterns }).catch(() => {});

  const failRules = rules.filter((r) => r.action === 'fail');
  if (failRules.length === 0) return;
  const compiled = failRules.map((r) => ({ rule: r, re: globToRegExp(r.urlPattern) }));
  await client.Fetch.enable({ patterns: failRules.map((r) => ({ urlPattern: r.urlPattern })) }).catch(() => {});
  client.Fetch.requestPaused((params: unknown) => {
    const p = params as { requestId: string; request: { url: string } };
    const hit = compiled.find(({ re }) => re.test(p.request.url));
    const settle = hit
      ? client.Fetch.fulfillRequest({
          requestId: p.requestId,
          responseCode: hit.rule.status ?? 500,
          body: hit.rule.body ? Buffer.from(hit.rule.body, 'utf8').toString('base64') : undefined,
        })
      : client.Fetch.continueRequest({ requestId: p.requestId });
    settle.catch(() => {
      // the request may already have settled/aborted on its own (a
      // navigation away, a client-side abort()) — never let a stale
      // requestId throw out of an event handler with no caller to catch it.
    });
  });
}

/** Named throttle presets, expressed in CDP's own units (bytes/sec, ms) —
 * rough real-world approximations, not a spec: 'slow-3g'/'fast-3g' mirror the
 * profiles Chrome DevTools itself ships under those names. */
const THROTTLE_PRESETS: Record<
  'offline' | 'slow-3g' | 'fast-3g',
  { offline: boolean; latency: number; downloadThroughput: number; uploadThroughput: number }
> = {
  offline: { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
  'slow-3g': { offline: false, latency: 400, downloadThroughput: (50 * 1024) / 8, uploadThroughput: (50 * 1024) / 8 },
  'fast-3g': { offline: false, latency: 150, downloadThroughput: (1.5 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 },
};

/** Apply viewport/device/network-throttle emulation via raw CDP — same
 * "works over any transport with cdpClient()" rationale as applyRouteRules.
 * No-ops (never throws) when `emulation` is unset or the transport has no
 * `cdpClient()`. */
export async function applyEmulation(browser: BrowserPort, emulation: EmulationConfig | undefined): Promise<void> {
  if (!emulation) return;
  const client = browser.cdpClient?.() as CDP.Client | undefined;
  if (!client) return;
  if (emulation.viewport) {
    await client.Emulation.setDeviceMetricsOverride({
      width: emulation.viewport.width,
      height: emulation.viewport.height,
      deviceScaleFactor: emulation.deviceScaleFactor ?? 1,
      mobile: emulation.isMobile ?? false,
    }).catch(() => {});
  }
  if (emulation.networkThrottle) {
    const profile = typeof emulation.networkThrottle === 'string' ? THROTTLE_PRESETS[emulation.networkThrottle] : { offline: false, ...emulation.networkThrottle };
    await client.Network.emulateNetworkConditions(profile).catch(() => {});
  }
}

/* =============================================================================
 * A3 (P0) — isolated session allocation for `replay --all --workers N`
 * ========================================================================== */

/** Allocate a FULLY ISOLATED session's connection info — a free CDP port, a
 * free Nano-runner HTTP port, and a fresh scratch profile dir — instead of
 * the fixed cdpPort/runnerPort/chromeProfile defaults. This is the EXPENSIVE
 * isolation path (a brand-new Chrome process): use it only when the
 * transport can't give you the CHEAP path instead (a `via: 'playwright'`
 * BrowserContext per run on ONE shared Chrome — see PlaywrightBrowser.
 * launch(), which already does this for free on every session). `replay
 * --all --workers N` uses this for every concurrent entry when `via !==
 * 'playwright'`, since CdpBrowser has no per-context isolation primitive: N
 * concurrent CdpBrowser sessions on the SAME Chrome share one cookie jar
 * even though each opens its own tab.
 *
 * Known tradeoff: like every Chrome this codebase launches (see
 * chrome/launch.ts's `ensureChrome` — always detached, never killed), an
 * isolated Chrome spun up here is NOT torn down when the session closes; it
 * is left running warm, consistent with the rest of the product's "Chrome
 * stays warm" design. For a one-off `--workers N` suite run this means N
 * extra idle Chrome processes accumulate rather than exiting with the CLI —
 * an accepted cost of reusing the existing launch primitive rather than
 * building separate process-lifecycle tracking for this one call site. */
export async function allocateIsolatedSession(baseProfileDir: string): Promise<Pick<QaConfig, 'cdpPort' | 'runnerPort' | 'chromeProfile'>> {
  const [cdpPort, runnerPort] = await Promise.all([allocateFreePort(), allocateFreePort()]);
  const chromeProfile = path.join(`${baseProfileDir}-isolated`, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  return { cdpPort, runnerPort, chromeProfile };
}

/** Nano availability with a download grace window. A fresh Chrome reports
 * 'downloading' (or 'downloadable') for ~60s while it re-validates the on-disk
 * model; giving up to rung 1 immediately would needlessly skip the $0 rung.
 * Poll every 5s up to 60s (progress line every 15s); return as soon as it
 * settles to 'available', or on any terminal state ('unavailable'/'api-missing'). */
async function pollNanoAvailable(
  nano: NanoPort,
  progress: (line: string) => void,
): Promise<string> {
  const deadline = Date.now() + 60_000;
  let lastProgress = 0;
  let a = await nano.availability();
  while ((a === 'downloading' || a === 'downloadable') && Date.now() < deadline) {
    const elapsed = Date.now() - (deadline - 60_000);
    if (elapsed - lastProgress >= 15_000) {
      progress(`rung 0: Gemini Nano ${a} — waiting up to 60s for it to become ready (${Math.round(elapsed / 1000)}s)`);
      lastProgress = elapsed;
    }
    await new Promise<void>((r) => setTimeout(r, 5_000));
    a = await nano.availability();
  }
  return a;
}

/**
 * Build the full fallback ladder (everything EXCEPT rung-0 Nano, which the caller
 * prepends only when it's available) and figure out which two adapters to PIN to
 * the front — the NAVIGATOR (cfg.navigator, leads plan-step) and the BRAIN
 * (cfg.planner, leads plan-goals).
 *
 * Every provider/mode is constructed exactly once, keyed `provider:mode`. A slot
 * pinned by a role gets that role's model (cfg.<role>.model when set, else the
 * role-appropriate default via defaultModelFor); any unpinned fallback rung takes
 * the cheap navigator-tier default. Unconfigured adapters (no key / missing CLI)
 * report available()===false and the router simply skips them, so the ladder is
 * always complete and fallback Just Works regardless of the selection. API keys
 * come from the Vault (anthropic/openai/openrouter) with an env fallback; Gemini
 * also honors the legacy cfg.geminiApiKey.
 *
 * A role pinned to nano (navigator default) resolves to name 'nano', which the
 * router simply won't find among plan-step candidates yet → it falls through to
 * the next available per-step adapter (Nano plan-step is a later phase).
 */
function buildLadder(cfg: QaConfig, vault: Vault): { adapters: ModelAdapter[]; navigatorName?: string; plannerName?: string } {
  const nav = cfg.navigator;
  const brain = cfg.planner;
  // Model for a provider:mode slot: the role that pins it supplies its own model
  // (when set) or the role default; `base` lets a slot pass an explicit fallback
  // (gemini honours cfg.googleCliModel); unpinned rungs take the cheap tier.
  const modelFor = (provider: ProviderId, mode: PlannerMode, base?: string): string => {
    if (nav.provider === provider && nav.mode === mode) return nav.model || base || defaultModelFor(provider, mode, 'navigator');
    if (brain.provider === provider && brain.mode === mode) return brain.model || base || defaultModelFor(provider, mode, 'brain');
    return base ?? defaultModelFor(provider, mode, 'navigator');
  };

  const geminiKey = vault.get('gemini') ?? cfg.geminiApiKey;
  const anthropicKey = vault.get('anthropic') ?? process.env.ANTHROPIC_API_KEY;
  const openaiKey = vault.get('openai') ?? process.env.OPENAI_API_KEY;
  const openrouterKey = vault.get('openrouter') ?? process.env.OPENROUTER_API_KEY;
  // GLM (z.ai): vault key 'glm' or GLM_API_KEY / ZAI_API_KEY env. GLM_BASE_URL
  // overrides the endpoint for the GLM Coding Plan or the mainland BigModel host.
  // GLM_THINKING=enabled turns reasoning on (slower/costlier, sharper plans);
  // default 'disabled' keeps the planner fast and cheap — the ladder's whole point.
  const glmKey = vault.get('glm') ?? process.env.GLM_API_KEY ?? process.env.ZAI_API_KEY;
  const glmThinking = process.env.GLM_THINKING === 'enabled' ? 'enabled' : 'disabled';

  // Builds the adapter for a given provider:mode slot with an explicit model.
  // Pulled out so a slot pinned by BOTH roles (e.g. navigator=claude:cli:sonnet,
  // brain=claude:cli:opus) can get a second, distinct instance below instead of
  // silently sharing one (which would make the brain run on the navigator's model).
  const makeAdapter = (provider: ProviderId, mode: PlannerMode, model: string): ModelAdapter | undefined => {
    switch (`${provider}:${mode}`) {
      case 'gemini:cli': return new GoogleCliAdapter({ bin: cfg.googleCliBin, model, env: cfg.googleCliEnv });
      case 'gemini:api': return new ByokGeminiAdapter({ apiKey: geminiKey, model });
      case 'claude:api': return new AnthropicAdapter({ apiKey: anthropicKey, model });
      case 'claude:cli': return new CliPlannerAdapter({ bin: 'claude', model });
      case 'gpt:api': return new OpenAiCompatibleAdapter(openAiGatewayOptions({ apiKey: openaiKey, defaultBaseUrl: 'https://api.openai.com/v1', label: 'gpt', model }));
      // codex uses its own configured model when none is given (default is blank)
      case 'gpt:cli': return new CliPlannerAdapter({ bin: 'codex', model: model || undefined });
      case 'openrouter:api': return new OpenAiCompatibleAdapter(openAiGatewayOptions({ apiKey: openrouterKey, defaultBaseUrl: 'https://openrouter.ai/api/v1', label: 'openrouter', model }));
      // GLM-5.2 is a text-only reasoning model: supportsVision:false → it joins the
      // plan-step ladder only (Nano/Gemini still own visual verdicts).
      case 'glm:api': return new OpenAiCompatibleAdapter(openAiGatewayOptions({ apiKey: glmKey, defaultBaseUrl: 'https://api.z.ai/api/paas/v4', label: 'glm', model, supportsVision: false, extraBody: { thinking: { type: glmThinking } } }));
      case 'ollama:api': return new OllamaAdapter({ model });
      default: return undefined;
    }
  };

  const byKey = new Map<string, ModelAdapter>();
  // gemini keeps cfg.googleCliModel as its explicit base fallback (SPIKE_GOOGLE_CLI_MODEL override).
  const SLOTS: Array<[ProviderId, PlannerMode, string | undefined]> = [
    ['gemini', 'cli', cfg.googleCliModel],
    ['gemini', 'api', cfg.googleCliModel],
    ['claude', 'api', undefined],
    ['claude', 'cli', undefined],
    ['gpt', 'api', undefined],
    ['gpt', 'cli', undefined],
    ['openrouter', 'api', undefined],
    ['glm', 'api', undefined],
    ['ollama', 'api', undefined],
  ];
  for (const [provider, mode, base] of SLOTS) {
    const adapter = makeAdapter(provider, mode, modelFor(provider, mode, base));
    if (adapter) byKey.set(`${provider}:${mode}`, adapter);
  }

  // Two pins, same lookup for each: nano resolves to name 'nano' (the router won't
  // find it among plan-step/plan-goals candidates → falls through), otherwise the
  // chosen provider:mode adapter's name. navigator → plan-step, brain → plan-goals.
  const navSlot = `${nav.provider}:${nav.mode}`;
  const brainSlot = `${brain.provider}:${brain.mode}`;
  const navigatorName = nav.provider === 'nano' ? 'nano' : byKey.get(navSlot)?.name;
  let plannerName = brain.provider === 'nano' ? 'nano' : byKey.get(brainSlot)?.name;

  // Same provider:mode slot pinned by both roles: modelFor() above resolved the
  // shared instance to the navigator's model (it's checked first), so the brain
  // would silently run on it too. When the two roles actually want different
  // models, give the brain its own second instance instead.
  if (brain.provider !== 'nano' && navSlot === brainSlot) {
    const navModel = nav.model || defaultModelFor(nav.provider, nav.mode, 'navigator');
    const brainModel = brain.model || defaultModelFor(brain.provider, brain.mode, 'brain');
    if (brainModel !== navModel) {
      const brainAdapter = makeAdapter(brain.provider, brain.mode, brainModel);
      if (brainAdapter) {
        byKey.set(`${brainSlot}:brain`, brainAdapter);
        plannerName = brainAdapter.name;
      }
    }
  }

  return { adapters: [...byKey.values()], navigatorName, plannerName };
}

/** The host of `url` plus its www./bare-domain sibling (apex↔www redirects are
 * common — e.g. a bare domain → its www. subdomain — and the guard's
 * subdomain check only covers one direction). '' / unparseable url → []. */
function targetHostCandidates(url: string): string[] {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return [];
  }
  if (!host) return [];
  return host.startsWith('www.') ? [host, host.slice(4)] : [host, `www.${host}`];
}

/** A10 (P1): pure decision of what to attach to a QaRunResult when a matched
 * replay came back `fail` (or threw) and qaRun is about to fall back to a
 * fresh AI pass. Split out from qaRun's body so the fallback shape is
 * unit-testable without a live browser session — a test can stub/fake
 * `replayVerdict`/`reason` directly instead of driving a real replay to
 * failure. `reason: 'replay-error'` (qaReplay threw) has no real verdict to
 * report, so it's recorded as 'uncertain' rather than fabricating one. */
export function buildReplayFallback(
  match: ReplayMatch,
  replayVerdict: RunVerdict,
  reason: 'replay-failed' | 'replay-error',
): NonNullable<QaRunResult['replayFallback']> {
  return { name: match.name, score: match.score, replayVerdict, reason };
}

/** A10 (P1): pure decision of whether a sub-threshold `bestCandidate` is close
 * enough to `threshold` (within `NEAR_MISS_MARGIN`) to be worth a "you had a
 * near-miss script" progress line, and the line to print — null when there's
 * nothing worth saying. Split out for the same unit-testability reason as
 * `buildReplayFallback` (no live matcher/browser needed to exercise the
 * boundary math). */
export function nearMissMessage(bestCandidate: ReplayMatch | undefined, threshold: number): string | null {
  if (!bestCandidate || bestCandidate.score < threshold - NEAR_MISS_MARGIN) return null;
  return `near-miss replay candidate "${bestCandidate.name}" scored ${bestCandidate.score.toFixed(2)} (threshold ${threshold.toFixed(2)}) — a task/URL rewording likely moved it below the bar; running a fresh AI pass`;
}

/** Best-effort re-persist of report.json AFTER engine.ts adds a field the
 * module that originally wrote the file (driver/loop.ts, recorder/replay.ts —
 * neither owned here) doesn't know about, mirroring the existing clip-path
 * re-save further down. Never throws — a write failure here must not fail
 * the run; the field is still present on the in-memory result either way. */
function persistReportPatch(artifactsDir: string, report: Report): void {
  try {
    fs.writeFileSync(path.join(artifactsDir, report.runId, 'report.json'), JSON.stringify(report, null, 2));
  } catch {
    /* best-effort */
  }
}

export async function qaRun(task: string, url: string, opts: QaRunOptions = {}): Promise<QaRunResult> {
  const progress = opts.onProgress ?? (() => {});
  const tracer = getDefaultTracer();
  const runSpan = tracer.startSpan('qa.run', { task, url });
  try {
    // Phase 14: pre-run replay matcher — a confident match replays
    // deterministically at $0 before a fresh AI run is even considered.
    let replayFallback: QaRunResult['replayFallback'];
    if (opts.replay ?? true) {
      const { matched: match, bestCandidate, threshold } = matchReplayScriptDetailed(task, url);
      runSpan.addEvent('replay.match', { found: Boolean(match), name: match?.name, score: match?.score });
      if (match) {
        progress(`matched replay ${match.name} (score ${match.score.toFixed(2)}) — using $0 replay (override with --no-replay)`);
        try {
          const replayed = await qaReplay(match.name, {
            config: opts.config,
            onProgress: progress,
            bridge: opts.bridge,
            // A7/A6: thread the caller's per-run overrides through so a
            // matched-replay short-circuit still honors them — a caller that
            // asked for --headless / --storage-state shouldn't silently lose
            // it just because a confident script match was found.
            headless: opts.headless,
            storageStatePath: opts.storageStatePath,
            saveStorageStatePath: opts.saveStorageStatePath,
            // A1 (P0): a look-only run must never be quietly satisfied by
            // replaying a saved test full of clicks — the replay refuses and
            // the fresh look-only pass below takes over.
            readOnly: opts.readOnly,
          });
          if (replayed.verdict !== 'fail') {
            runSpan.addEvent('replay.used', { name: match.name, verdict: replayed.verdict });
            const result: QaRunResult = { ...replayed, replayMatch: { name: match.name, score: match.score } };
            persistReportPatch(loadConfig(opts.config ?? {}).artifactsDir, result);
            runSpan.end({ verdict: result.verdict, source: 'replay', runId: result.runId });
            return result;
          }
          progress('matched replay failed — falling back to a fresh AI run');
          runSpan.addEvent('replay.fallback', { reason: 'replay-failed', name: match.name });
          replayFallback = buildReplayFallback(match, replayed.verdict, 'replay-failed');
        } catch (e) {
          progress(`matched replay errored (${e instanceof Error ? e.message : String(e)}) — falling back to a fresh AI run`);
          runSpan.addEvent('replay.fallback', { reason: 'replay-error', name: match.name, error: e instanceof Error ? e.message : String(e) });
          replayFallback = buildReplayFallback(match, 'uncertain', 'replay-error');
        }
      } else {
        // A10 (P1): no confident match, but something came close — surfacing
        // this is the only way a caller learns that a rename/rewording of the
        // task (or the recorded script) is what cost them a paid AI run,
        // since near-misses were previously never reported anywhere.
        const nearMiss = nearMissMessage(bestCandidate, threshold);
        if (nearMiss) {
          progress(nearMiss);
          runSpan.addEvent('replay.near_miss', { name: bestCandidate!.name, score: bestCandidate!.score, threshold });
        }
      }
    }

    const result = await runFreshAiPass(task, url, opts, progress, runSpan);
    if (replayFallback) {
      // Same "attach + re-persist" pattern as the replayMatch success path
      // above: runFreshAiPass/runDriverLoop already wrote report.json without
      // knowing about the fallback, so patch it in here — this is what makes
      // it visible to a --json/MCP/programmatic caller that reads report.json
      // rather than wiring onProgress (A10, P1).
      result.replayFallback = replayFallback;
      persistReportPatch(loadConfig(opts.config ?? {}).artifactsDir, result);
    }
    runSpan.end({ verdict: result.verdict, source: 'ai', runId: result.runId });
    return result;
  } catch (e) {
    runSpan.fail(e);
    throw e;
  }
}

/** The AI-driven exploration path — everything qaRun used to do inline before
 * the Phase 14 replay matcher was added in front of it. Split out so the
 * matcher's early-return (a matched $0 replay) never pays for opening a
 * browser session / building the model ladder at all. */
/** A1 (P0): the effective look-only setting for a run. Pure (all inputs
 * passed in) so the precedence rule is unit-testable without a browser.
 *
 * Precedence: an explicit per-run override wins; otherwise a named+trusted
 * target relaxes the safe-by-default true to false, but ONLY when no config
 * source set `readOnly` explicitly; otherwise the configured value stands. */
export function resolveReadOnly(input: {
  /** QaRunOptions.readOnly — `--read-only` / the `qa_run` input / the panel. */
  optionReadOnly?: boolean;
  /** Was the run's target url named by the caller and therefore trusted? */
  trustTargetHost: boolean;
  /** Did any config source set `readOnly` explicitly (readOnlyWasConfigured)? */
  configured: boolean;
  /** The resolved config value (DEFAULTS.readOnly when nobody set one). */
  configReadOnly: boolean;
}): boolean {
  if (input.optionReadOnly !== undefined) return input.optionReadOnly;
  if (input.trustTargetHost && !input.configured) return false;
  return input.configReadOnly;
}

async function runFreshAiPass(
  task: string,
  url: string,
  opts: QaRunOptions,
  progress: (line: string) => void,
  runSpan: ActiveSpan,
): Promise<QaRunResult> {
  // A7 (P1): fold the per-call --headless override into the config BEFORE
  // loadConfig() resolves cfg, same precedence tier as every other opts.*
  // override that flows through `config` (env still wins if a caller set
  // both, matching every other field's existing precedence).
  const configOverride: Partial<QaConfig> = { ...opts.config, ...(opts.headless !== undefined && { headless: opts.headless }) };

  // Computed before the session opens so CdpBrowser/ExtensionBrowser get the
  // Tier-4 allowedHosts guard (A4, P0) at construction time, not just inside
  // the driver loop — closes the "raw cdp passthrough bypasses the guard" gap.
  const preCfg = loadConfig(configOverride);
  const trustTargetHost = opts.trustTargetHost ?? true;
  const allowedHosts = trustTargetHost
    ? [...preCfg.allowedHosts, ...targetHostCandidates(url)]
    : preCfg.allowedHosts;
  // A1 (P0): same relaxation, one layer up — naming the target url is consent
  // to drive it, so look-only mode is off unless it was asked for. See
  // resolveReadOnly / QaRunOptions.readOnly.
  const readOnly = resolveReadOnly({
    optionReadOnly: opts.readOnly,
    trustTargetHost,
    configured: readOnlyWasConfigured(configOverride),
    configReadOnly: preCfg.readOnly,
  });

  // A7: a headless qaRun skips the opportunistic rung-0 Nano probe entirely
  // (see QaRunOptions.headless's doc comment) rather than either dragging
  // Nano into a headless Chrome or spinning up a second headed one just for
  // the $0 optimization on a live AI-driven run.
  if (readOnly) progress('look-only mode: I\u2019ll navigate and check this page, but never click or type');
  const session = await openSession(configOverride, { bridge: opts.bridge, tabId: opts.tabId, clientId: opts.clientId, allowedHosts, wantNano: !preCfg.headless });
  const { cfg, browser, nano } = session;

  // A13 (P1) + A6 (P1): interception/emulation and storage-state injection,
  // both BEFORE the driver's own first navigation — see each helper's doc
  // comment. Guarded by the same try/close-on-failure discipline openSession
  // itself uses for nano.start(), so a bad --storage-state path or a
  // misconfigured route rule doesn't leak the session.
  //
  // A30 (P1): this try/catch used to end right after storage-state injection,
  // leaving nano.warmup()/buildLadder()/ArtifactStore/FileActionCache to run
  // AFTER the session opened but BEFORE the driver's own try/finally (which
  // only starts once `artifacts`/`actionCache` already exist) — so a throw
  // from any of those four (e.g. a persistent misconfigured model id) leaked
  // the already-opened browser tab/bridge connection on every attempt.
  // Extending this same close-on-throw block through all of session-local
  // init closes that window without touching the driver's own try/finally.
  let vault: Vault;
  let adapters: ModelAdapter[];
  let navigatorName: string | undefined;
  let plannerName: string | undefined;
  let router: ModelRouter;
  let artifacts: ArtifactStore;
  let actionCache: FileActionCache | undefined;
  try {
    await applyRouteRules(browser, cfg.routeRules);
    await applyEmulation(browser, cfg.emulation);
    if (opts.storageStatePath) {
      await injectStorageState(browser, loadStorageStateFile(opts.storageStatePath));
      progress(`storage state loaded from ${opts.storageStatePath}`);
    }

    vault = new Vault();
    adapters = [];
    if (nano && (await pollNanoAvailable(nano, progress)) === 'available') {
      progress('rung 0: Gemini Nano available — warming up');
      await nano.warmup();
      adapters.push(new NanoAdapter(nano));
    } else {
      progress('rung 0: Gemini Nano not available — ladder starts at rung 1 (run `spike nano --download` to enable $0 visual checks)');
    }
    // The rest of the ladder + the user's two pins: navigator (plan-step, cheap) and
    // brain (plan-goals, smart). Each leads its own ladder; fallback stays intact.
    const built = buildLadder(cfg, vault);
    navigatorName = built.navigatorName;
    plannerName = built.plannerName;
    adapters.push(...built.adapters);
    if (navigatorName && navigatorName !== 'nano') progress(`navigator: ${navigatorName} (leads the per-step ladder; fallback intact)`);
    if (plannerName && plannerName !== 'nano') progress(`brain: ${plannerName} (leads the plan/re-plan ladder; consulted on stuck)`);
    router = new ModelRouter(adapters, {
      preferFreePlanner: cfg.preferFreePlanner,
      navigatorAdapter: navigatorName,
      plannerAdapter: plannerName,
    });

    artifacts = new ArtifactStore(cfg.artifactsDir);
    actionCache = cfg.actionCache ? new FileActionCache(cfg.actionCacheDir) : undefined;
  } catch (e) {
    await session.close();
    throw e;
  }
  progress(`run ${artifacts.runId}: "${task}" on ${url}`);
  runSpan.setAttribute('runId', artifacts.runId);
  runSpan.addEvent('session.opened', { via: cfg.via, navigator: navigatorName ?? 'nano', brain: plannerName ?? 'nano' });

  try {
    // replay clip: the ghost cursor + captions render in-page, so the
    // screencast captures the whole show; cheap (jpeg @ ~2fps) and optional.
    // EXTENSION MODE ONLY for now: one cdp-mode run showed post-navigation
    // clicks no-op'ing with the screencast active (warm daemon Chrome; not
    // reproducible on fresh profiles — see test/v16.clip-input-interaction.ts).
    // Clips are a vibe-mode feature anyway; revisit when the interaction is
    // understood.
    let clip: ClipRecorder | null = null;
    if (cfg.recordClip && browser.cdpClient) {
      try {
        // 5s guard: chrome.debugger silently never answers Page.startScreencast
        // (extension transport) — never let the clip hang the run
        clip = await Promise.race([
          startClipRecorder(browser.cdpClient() as Parameters<typeof startClipRecorder>[0], artifacts),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
        ]);
        if (!clip) progress('clip recorder unavailable on this transport — continuing without');
      } catch {
        progress('clip recorder unavailable on this transport — continuing without');
      }
    }

    const driverTracer = getDefaultTracer();
    const report: QaRunResult = await driverTracer.trace('qa.run.driver_loop', { runId: artifacts.runId, task, url }, () =>
      runDriverLoop(browser, router, artifacts, task, url, {
        maxSteps: opts.maxSteps ?? cfg.maxSteps,
        onStep: opts.onStep,
        allowedHosts,
        vault,
        signal: opts.signal,
        assertionPolicy: cfg.assertionPolicy,
        actionCache,
        videoAssertions: cfg.videoAssertions,
        readOnly,
        spendCapUsd: cfg.spendCapUsd,
        strictOracles: cfg.strictOracles,
      }),
    );
    if (clip) {
      const gif = await clip.stop().catch(() => null);
      if (gif) {
        report.evidence_paths.push(gif);
        artifacts.saveReport(report); // re-save with the clip path included
        progress(`replay clip: ${gif}`);
      }
    }
    progress(`verdict: ${report.verdict} (${report.steps.length} steps, ${Math.round(report.durationMs / 1000)}s)`);
    runSpan.addEvent('driver.loop.completed', { verdict: report.verdict, steps: report.steps.length, durationMs: report.durationMs });

    const lastAxForOracles = await (browser.peekAxTree?.() ?? browser.axTree()).catch(() => undefined);
    // A33 (A24 Tier 2): record which metamorphic relations this app's shape
    // suggests. Detection is deterministic and free; EXECUTION is not wired,
    // because a relation needs paired observations across two deliberately
    // varied runs and the driver produces one. Recording the proposals is what
    // makes the "propose once, then run forever" workflow possible — inventing
    // a fake single-run check would not.
    if (lastAxForOracles) {
      const proposals = detectRelationCandidates(lastAxForOracles);
      if (proposals.length) {
        report.metamorphicCandidates = proposals.map((p2) => ({ relation: p2.relation.id, reason: p2.reason }));
      }
    }

    // A30 (A24 Tier 1): capture or compare this flow's baseline. Opt-in
    // (cfg.differential), because an unblessed baseline flags every intentional
    // UI change. First run of a flow WRITES the baseline; later runs diff
    // against it and attach the result as evidence — never as a verdict, for
    // the same reason the Tier-0 invariants are non-fatal: nobody has measured
    // its false-positive rate against real UI churn yet.
    if (cfg.differential) {
      try {
        const flow = report.recordedScript ?? report.task.slice(0, 80);
        const finalAx = lastAxForOracles ?? (await browser.peekAxTree?.()) ?? (await browser.axTree());
        const network = report.steps.flatMap((st) => st.network ?? []);
        const existing = await loadBaseline(flow);
        if (!existing) {
          await saveBaseline({ flow, createdAt: new Date().toISOString(), ax: finalAx, network });
          progress(`differential: baseline created for "${flow}" — future runs will diff against it`);
        } else {
          const d = compareToBaseline({ ax: finalAx, network }, existing);
          report.differential = {
            mode: d.mode,
            clean: d.clean,
            axChanges: d.axChanges.length,
            networkChanges: d.network.addedRequests.length + d.network.removedRequests.length + d.network.statusClassChanges.length,
            detail: [
              ...d.axChanges.slice(0, 10).map((c) => `${c.kind}: ${c.path}`),
              ...d.network.addedRequests.slice(0, 5).map((k) => `request added: ${k.method} ${k.path} (${k.statusClass})`),
              ...d.network.removedRequests.slice(0, 5).map((k) => `request removed: ${k.method} ${k.path}`),
              ...d.network.statusClassChanges.slice(0, 5).map((c) => `status changed: ${c.method} ${c.path} ${c.before} -> ${c.after}`),
            ],
          };
          artifacts.saveReport(report);
          progress(d.clean ? 'differential: clean vs baseline' : `differential: ${report.differential.axChanges} AX + ${report.differential.networkChanges} network change(s) vs baseline`);
        }
      } catch (e) {
        progress(`differential skipped: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // A29: write the run back to the coverage ledger. Runs on EVERY verdict —
    // a failing run still exercised the routes it reached, and pretending
    // otherwise would understate coverage exactly when you most want to know
    // what was touched. No-ops silently when no ledger exists (nobody has run
    // `spike map`), which is the common case.
    {
      const cov = recordRunCoverage(report.steps, report.recordedScript ?? report.task.slice(0, 60));
      if (cov.ledgerPresent && (cov.routesMarked.length || cov.elementsMarked)) {
        progress(`coverage: ${cov.routesMarked.length} route(s), ${cov.elementsMarked} element(s) marked exercised`);
      }
      if (cov.unknownRoutes.length) {
        progress(`coverage: ${cov.unknownRoutes.length} route(s) reached that \`spike map\` never discovered — likely interaction-gated`);
      }
    }

    if (report.verdict === 'pass' && (opts.record ?? true)) {
      const { jsonPath, specPath } = saveScript(scriptFromReport(report));
      report.recordedScript = jsonPath;
      progress(`recorded: ${jsonPath} (+ Playwright twin ${specPath}) — replay at $0 with \`spike replay\``);
      runSpan.addEvent('script.recorded', { jsonPath });
    }
    // A6 (P1): capture-half of the auth fixture — only on a passing run (a
    // failed/uncertain run's cookies may reflect a broken/half-logged-in
    // state not worth propagating to every subsequent flow).
    if (report.verdict === 'pass' && opts.saveStorageStatePath) {
      try {
        saveStorageStateFile(opts.saveStorageStatePath, await captureStorageState(browser));
        progress(`storage state saved to ${opts.saveStorageStatePath}`);
      } catch (e) {
        progress(`storage state capture failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return report;
  } finally {
    await session.close();
  }
}

export interface QaReplayOptions {
  /** On replay failure, re-engage the driver on the original task and re-emit the script. */
  heal?: boolean;
  /** A1 (P0): look-only mode (`spike replay --read-only`). A saved test is made
   * of clicks and typing, so the replay refuses up front with a plain-English
   * `uncertain` instead of half-running it — see replayScript. Explicit only:
   * unlike qaRun, replay does NOT read `readOnly` from the config, so a replay
   * only ever becomes look-only because a caller asked for it on this call. */
  readOnly?: boolean;
  config?: Partial<QaConfig>;
  onProgress?: (line: string) => void;
  /** Caller-owned bridge (extension mode) — see QaRunOptions.bridge. */
  bridge?: BridgeServer;
  /** A11 (P1): on a FAILED replay attempt, retry up to this many additional
   * times (each a fresh navigate-and-replay over the SAME session/script)
   * before giving up / engaging `heal`. Default 0 — opt-in, no behaviour
   * change unless a caller asks for it. A flow that fails at least once but
   * eventually passes is reported via `QaReplayResult.flaky` rather than as
   * a clean first-try pass, so a real flake rate stays visible instead of
   * being silently absorbed into "green". */
  retries?: number;
  /** A7 (P1): run this replay's browser headless, overriding cfg.headless.
   * Unlike qaRun's headless (which just skips Nano opportunistically), this
   * gates Nano on whether the SCRIPT actually needs it: if any step is
   * `assert_visual`, Nano is started on its OWN split-off headed Chrome
   * (resolveNanoLaunchOpts) alongside the headless QA browser; otherwise
   * Nano is skipped entirely — no second Chrome pays for a run that was
   * never going to use it. See replay.ts:53-55 for how "does this run need
   * Nano" already gets decided once nano is (or isn't) present. */
  headless?: boolean;
  /** A6 (P1): load this storage-state file before replaying — see
   * QaRunOptions.storageStatePath. */
  storageStatePath?: string;
  /** A6 (P1): on a PASSING replay, capture + save storage state here — see
   * QaRunOptions.saveStorageStatePath. This is the primitive the suite-level
   * auth fixture (cli.ts's `replay --all --auth-fixture`) is built on: run a
   * login script once with this set, then pass the resulting file as every
   * subsequent entry's `storageStatePath`. */
  saveStorageStatePath?: string;
}

/** A11 (P1): recorded when `retries` masked at least one failed attempt.
 * Deliberately NOT a new `RunVerdict` value: `report.verdict` stays 'pass'
 * (the flow DID end in a pass; that's what an exit-code consumer should act
 * on), and `flaky` is purely additive detail for anything that wants to
 * surface "this passed, but wobbled" instead of a silent clean pass.
 *
 * Why not add 'flaky' to RunVerdict itself: `RunVerdict` is read by
 * pass/fail/other exit-code ternaries in cli.ts (`report.verdict === 'pass'
 * ? 0 : report.verdict === 'fail' ? 1 : 2`) and mcp-server.ts
 * (`report.verdict === 'fail' ? false : undefined`) — neither is an
 * exhaustive `switch`, so a new literal wouldn't fail to compile, but both
 * treat "anything that isn't 'pass' or 'fail'" as the SAME bucket as
 * 'uncertain' (exit 2 / non-error). A flow that failed once and then passed
 * is not "uncertain" — it has a confirmed, reproduced-clean final state —
 * so folding it into that bucket would make an eventually-GREEN flow exit
 * non-zero, exactly backwards from what a retry policy is for. Keeping
 * `verdict: 'pass'` and adding this field is the least invasive shape: every
 * existing pass/fail consumer keeps working unchanged, and only a caller
 * that explicitly checks `.flaky` sees the extra signal. */
export interface FlakyInfo {
  /** Total attempts made (1 + however many retries were actually consumed). */
  attempts: number;
  /** One entry per attempt BEFORE the final (passing) one. */
  failedAttempts: Array<{ runId: string; verdict: RunVerdict; reason: string }>;
}

export interface QaReplayResult extends Report {
  healed?: boolean;
  recordedScript?: string;
  /** A11 (P1): present only when at least one retry attempt failed before
   * the flow eventually passed. Absent on a clean first-try pass/fail. */
  flaky?: FlakyInfo;
}

/** A11 (P1): given the sequence of attempt reports a retry loop already
 * produced (attempt 1 first, in order), decides the final report to return
 * and stamps `.flaky` onto it when applicable. Pulled out of qaReplay's
 * retry loop specifically so it's unit-testable with a list of STUBBED
 * attempt-shaped objects — no browser, no real replay — per A11's test
 * brief. `attempts` must be non-empty.
 *
 * The rule: the LAST attempt is always the reported outcome (a retry loop
 * only keeps retrying while an attempt is 'fail', so the last one is either
 * the eventual pass/uncertain, or 'fail' because attempts ran out). Flaky
 * means at least one earlier attempt failed AND the final one is not
 * 'fail' — a flow that fails on every single attempt is just a fail, not
 * flaky (there is no "eventually passed" to flag). */
export function resolveRetryOutcome<T extends Report>(attempts: T[]): T & { flaky?: FlakyInfo } {
  if (attempts.length === 0) throw new Error('resolveRetryOutcome: attempts must be non-empty');
  const final = attempts[attempts.length - 1];
  const before = attempts.slice(0, -1);
  if (before.length > 0 && final.verdict !== 'fail') {
    return {
      ...final,
      flaky: {
        attempts: attempts.length,
        failedAttempts: before.map((a) => ({ runId: a.runId, verdict: a.verdict, reason: a.reason })),
      },
    };
  }
  return final;
}

/** A21: write a quarantined heal candidate ALONGSIDE (never over) the script
 * it would have replaced, so a human can inspect/diff/promote it later
 * without the original ever having been touched. Same directory and naming
 * convention as `saveScript()`, distinguished by the `.candidate.json`
 * suffix — `listScripts()` globs only `*.json` filenames as a whole and
 * doesn't attempt to load candidates as scripts, so nothing replays this
 * automatically, which is the point. */
function saveHealCandidate(script: QaScript, root = process.cwd()): string {
  const dir = scriptsDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${script.name}.candidate.json`);
  fs.writeFileSync(p, JSON.stringify(script, null, 2));
  return p;
}

export interface HealDecision {
  tier: HealTier;
  reasons: string[];
  /** Set when tier !== 'quarantine': the (over)written script's path. */
  jsonPath?: string;
  /** Set only when tier === 'quarantine': the candidate's path (original untouched). */
  candidatePath?: string;
}

/**
 * A21: classify a heal candidate against the script it would replace, then
 * perform (or withhold) the disk write accordingly:
 *  - 'auto'/'notice'  → `newScript` is saved over `oldScript.name` as today.
 *  - 'quarantine'      → `oldScript` is left COMPLETELY untouched on disk;
 *                        `newScript` is written alongside as `<name>.candidate.json`.
 *
 * Pulled out of `qaReplay()`'s heal branch specifically so it's unit-testable
 * without a live browser/session — a test can build two `QaScript` objects in
 * memory (no AI run, no replay) and assert on the tier, the reasons, and the
 * files actually left on disk in a temp `root`. */
export function applyHealDecision(oldScript: QaScript, newScript: QaScript, root = process.cwd()): HealDecision {
  const { tier, reasons } = classifyHeal(oldScript, newScript);
  if (tier === 'quarantine') {
    const candidatePath = saveHealCandidate(newScript, root);
    return { tier, reasons, candidatePath };
  }
  const { jsonPath } = saveScript(newScript, root);
  return { tier, reasons, jsonPath };
}

export async function qaReplay(nameOrPath: string, opts: QaReplayOptions = {}): Promise<QaReplayResult> {
  const progress = opts.onProgress ?? (() => {});
  const script: QaScript = loadScript(nameOrPath);
  progress(`replaying "${script.name}" (${script.steps.length} steps, recorded ${script.createdAt}) — no planner, $0`);

  const tracer = getDefaultTracer();
  const replaySpan = tracer.startSpan('qa.replay', { scriptName: script.name, task: script.task, url: script.url });

  // A7: fold the per-call --headless override in before loadConfig() resolves
  // cfg — same precedence tier as every other opts.* override, see qaRun's
  // identical configOverride.
  const configOverride: Partial<QaConfig> = { ...opts.config, ...(opts.headless !== undefined && { headless: opts.headless }) };

  // Same A4 (P0) defense-in-depth wiring as qaRun: give the port the recorded
  // script's own host up front, so the guard is live even during replay.
  const preCfg = loadConfig(configOverride);
  const allowedHosts = [...preCfg.allowedHosts, ...targetHostCandidates(script.url)];
  // A7: unlike qaRun, gate Nano on whether THIS script actually uses it — a
  // headless replay with no assert_visual step never needs a second Chrome.
  const scriptNeedsNano = script.steps.some((s) => s.type === 'assert_visual');
  const wantNano = !preCfg.headless || scriptNeedsNano;
  const session = await openSession(configOverride, { bridge: opts.bridge, allowedHosts, wantNano });

  // A13 (P1) + A6 (P1): same wiring as runFreshAiPass — see its doc comment.
  try {
    await applyRouteRules(session.browser, session.cfg.routeRules);
    await applyEmulation(session.browser, session.cfg.emulation);
    if (opts.storageStatePath) {
      await injectStorageState(session.browser, loadStorageStateFile(opts.storageStatePath));
      progress(`storage state loaded from ${opts.storageStatePath}`);
    }
  } catch (e) {
    await session.close();
    throw e;
  }

  const maxAttempts = 1 + Math.max(0, opts.retries ?? 0);
  const attemptReports: QaReplayResult[] = [];
  let report: QaReplayResult;
  try {
    let artifacts = new ArtifactStore(session.cfg.artifactsDir);
    let current: QaReplayResult = await replayScript(session.browser, session.nano, artifacts, script, { onProgress: progress, readOnly: opts.readOnly });
    attemptReports.push(current);
    // A11 (P1): opt-in retry loop — only engages when the caller asked for
    // retries AND the attempt actually failed. Each retry gets its own fresh
    // ArtifactStore (its own runId/screenshots) so a failed attempt's
    // evidence survives on disk even after a later attempt passes.
    while (current.verdict === 'fail' && attemptReports.length < maxAttempts) {
      progress(`replay attempt ${attemptReports.length}/${maxAttempts} failed — retrying (${maxAttempts - attemptReports.length} attempt(s) left)`);
      replaySpan.addEvent('replay.retry', { attempt: attemptReports.length, runId: current.runId });
      artifacts = new ArtifactStore(session.cfg.artifactsDir);
      current = await replayScript(session.browser, session.nano, artifacts, script, { onProgress: progress, readOnly: opts.readOnly });
      attemptReports.push(current);
    }
    report = resolveRetryOutcome(attemptReports);
    if (report.flaky) {
      progress(`flaky: failed ${report.flaky.failedAttempts.length} time(s) before passing on attempt ${report.flaky.attempts} of ${maxAttempts} — reported as flaky, not a clean pass`);
      replaySpan.addEvent('replay.flaky', { attempts: report.flaky.attempts });
    }
    progress(`replay verdict: ${report.verdict} (${Math.round(report.durationMs / 1000)}s)`);
    replaySpan.setAttribute('runId', report.runId);
    // A6 (P1): capture-half of the auth fixture — see QaReplayOptions.saveStorageStatePath.
    if (report.verdict === 'pass' && opts.saveStorageStatePath) {
      try {
        saveStorageStateFile(opts.saveStorageStatePath, await captureStorageState(session.browser));
        progress(`storage state saved to ${opts.saveStorageStatePath}`);
      } catch (e) {
        progress(`storage state capture failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } catch (e) {
    replaySpan.fail(e);
    throw e;
  } finally {
    await session.close();
  }

  if (report.verdict === 'fail' && opts.heal) {
    replaySpan.addEvent('heal.start', { runId: report.runId, failedStep: report.failing_step?.index ?? -1 });
    progress(`self-heal: replay failed at step ${report.failing_step ? report.failing_step.index + 1 : '?'} — re-engaging the driver on the original task`);
    const healed = await qaRun(script.task, script.url, {
      record: false, // we re-emit manually to keep the script's name + lineage
      replay: false, // never let the matcher re-find and re-replay THIS SAME failing script
      config: opts.config,
      readOnly: opts.readOnly, // A1 (P0): healing must not click when look-only was asked for
      onProgress: progress,
    });
    if (healed.verdict === 'pass') {
      const newScript = scriptFromReport(healed);
      newScript.name = script.name; // same identity, new steps
      newScript.healedFrom = {
        runId: report.runId,
        failedStep: report.failing_step?.index ?? -1,
        healedAt: new Date().toISOString(),
      };
      progress(`what changed: ${diffScripts(script, newScript)}`);

      // A21: classify + persist (or don't) — pulled into its own testable
      // function, see applyHealDecision below.
      const decision = applyHealDecision(script, newScript);

      if (decision.tier === 'quarantine') {
        // The whole safety property: the OLD script stays active untouched,
        // the candidate is written ALONGSIDE it, and the run is reported as
        // 'uncertain' (never 'pass') so an unreviewed heal can never
        // silently become the suite's truth. If nobody ever reviews it, the
        // flow degrades to "unverified" (a visible loss of coverage) — never
        // to a false-confidence green.
        progress(`self-heal QUARANTINED for review: ${decision.reasons.join('; ')} — original script left untouched; candidate saved at ${decision.candidatePath}`);
        replaySpan.end({ verdict: 'uncertain', healed: false, healTier: decision.tier, runId: report.runId });
        return {
          ...healed,
          verdict: 'uncertain',
          reason: `heal candidate quarantined for review (${decision.reasons.join('; ')}) — original script kept active pending review`,
          healed: false,
          healReview: { tier: decision.tier, reasons: decision.reasons, candidatePath: decision.candidatePath },
        };
      }

      progress(`self-heal succeeded (${decision.tier}) — script re-emitted: ${decision.jsonPath}${decision.reasons.length ? ` [${decision.reasons.join('; ')}]` : ''}`);
      replaySpan.end({ verdict: report.verdict, healed: true, healTier: decision.tier, runId: report.runId });
      return { ...healed, healed: true, recordedScript: decision.jsonPath, healReview: { tier: decision.tier, reasons: decision.reasons } };
    }
    progress('self-heal failed too — the app is genuinely broken, reporting the AI run verdict');
    replaySpan.end({ verdict: report.verdict, healed: false, runId: report.runId });
    return { ...healed, healed: false };
  }

  replaySpan.end({ verdict: report.verdict, runId: report.runId });
  return report;
}

/* ---------- A11 (P1): flake quarantine list ---------- */

export interface QuarantineEntry {
  name: string;
  reason?: string;
  addedAt: string;
}

/** `.spike-quarantine.json` at `root` (default cwd, same convention as
 * `generated-tests/`) — a small, hand-editable list of script names that are
 * KNOWN-flaky: still replayed and still reported every run (never silently
 * skipped), but excluded from the AGGREGATE exit code (see `suiteExitCode`)
 * so one known-flaky flow can't hard-fail an otherwise-green suite. */
export function quarantineListPath(root = process.cwd()): string {
  return path.join(root, '.spike-quarantine.json');
}

/** Never throws: a missing or malformed quarantine file means "nothing is
 * quarantined", not a crashed run — the file is a convenience, not a
 * dependency. */
export function loadQuarantineList(root = process.cwd()): QuarantineEntry[] {
  const p = quarantineListPath(root);
  if (!fs.existsSync(p)) return [];
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!Array.isArray(raw)) return [];
    return raw.filter((e): e is QuarantineEntry => Boolean(e) && typeof e === 'object' && typeof (e as QuarantineEntry).name === 'string');
  } catch {
    return [];
  }
}

export function isQuarantined(name: string, root = process.cwd()): boolean {
  return loadQuarantineList(root).some((e) => e.name === name);
}

export function addToQuarantine(name: string, reason?: string, root = process.cwd()): QuarantineEntry[] {
  const list = loadQuarantineList(root).filter((e) => e.name !== name);
  list.push({ name, reason, addedAt: new Date().toISOString() });
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(quarantineListPath(root), JSON.stringify(list, null, 2));
  return list;
}

export function removeFromQuarantine(name: string, root = process.cwd()): QuarantineEntry[] {
  const list = loadQuarantineList(root).filter((e) => e.name !== name);
  fs.writeFileSync(quarantineListPath(root), JSON.stringify(list, null, 2));
  return list;
}

/** Pure aggregate-exit-code computation for a `spike replay --all`-style
 * batch — the same pass/fail/uncertain → 0/1/2 mapping `cli.ts` already uses
 * per-flow, except a result whose script `name` is in the quarantine list
 * never contributes to `worst`: it is still present in `results` for
 * reporting, just excluded from deciding the process exit code (A11:
 * "excluded from the aggregate exit code but still run and still report").
 * Exported so a batch-runner caller can adopt the exclusion rule without
 * re-deriving it. */
export interface SuiteResultEntry {
  name: string;
  verdict: RunVerdict;
}

export function suiteExitCode(results: SuiteResultEntry[], root = process.cwd()): number {
  const quarantined = new Set(loadQuarantineList(root).map((e) => e.name));
  let worst = 0;
  for (const r of results) {
    if (quarantined.has(r.name)) continue;
    worst = Math.max(worst, r.verdict === 'pass' ? 0 : r.verdict === 'fail' ? 1 : 2);
  }
  return worst;
}
