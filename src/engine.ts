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
import { loadConfig, type QaConfig } from './config.js';
import { CdpBrowser } from './ports/cdp-browser.js';
import { ExtensionBrowser } from './ports/extension-browser.js';
import { NanoRunnerPage } from './ports/nano-runner-page.js';
import { ExtensionNano } from './ports/extension-nano.js';
import type { NanoPort } from './ports/nano-port.js';
import { BridgeServer } from './bridge/bridge-server.js';
import { launchChromeWithExtension } from './chrome/extensions.js';
import { cdpAlive } from './chrome/launch.js';
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
import type { Report } from './report/report.js';
import { diffScripts, loadScript, saveScript, scriptFromReport, type QaScript } from './recorder/script.js';
import { replayScript } from './recorder/replay.js';
import { matchReplayScript } from './recorder/matcher.js';
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
}

export interface QaRunResult extends Report {
  /** Path of the recorded script, when the run passed and recording is on. */
  recordedScript?: string;
  /** Set when this result came from a matched $0 replay (Phase 14) rather than
   * a fresh AI run — the matched script's name and match score. Absent on a
   * fresh AI-driven run. */
  replayMatch?: { name: string; score: number };
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
          headless: false,
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
            `close that Chrome (or set QA_CDP_PORT to a free port) so a fresh Chrome with the extension can launch.`,
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

  // 'cdp' — exactly today's behavior.
  const browser = new CdpBrowser({
    port: cfg.cdpPort,
    profileDir: cfg.chromeProfile,
    headless: false, // headed: Nano lives here, and this window is the future "watch the robot" show
    allowedHosts: deps.allowedHosts,
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
  nano: NanoPort;
  close(): Promise<void>;
}

async function openSession(config: Partial<QaConfig>, deps: { bridge?: BridgeServer; tabId?: number; clientId?: number; allowedHosts?: string[] } = {}): Promise<Session> {
  const browserSession = await openBrowserSession(config, deps);
  const { cfg } = browserSession;
  // Nano access depends on HOW Chrome got here:
  //  - injected bridge (vibe path: the user's own Chrome, no daemon CDP) → talk
  //    to the extension's own Prompt API over the bridge (ExtensionNano). There
  //    is no daemon CDP page here to host the localhost runner.
  //  - we launched Chrome ourselves (proven cdp path; extension mode that
  //    spawned its own Chrome) → NanoRunnerPage over cfg.cdpPort.
  const nano: NanoPort =
    cfg.via === 'extension' && deps.bridge
      ? new ExtensionNano({ bridge: deps.bridge })
      : new NanoRunnerPage({
          cdpPort: cfg.cdpPort,
          runnerPort: cfg.runnerPort,
          profileDir: cfg.chromeProfile,
        });
  try {
    await nano.start();
  } catch (e) {
    await browserSession.close();
    throw e;
  }
  return {
    cfg,
    browser: browserSession.browser,
    nano,
    async close() {
      await browserSession.close(); // QA tab closes; Chrome + runner tab stay warm
      await nano.close();
    },
  };
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
  // gemini keeps cfg.googleCliModel as its explicit base fallback (QA_GOOGLE_CLI_MODEL override).
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
 * common — e.g. mapleandsand.com → www.mapleandsand.com — and the guard's
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
    if (opts.replay ?? true) {
      const match = matchReplayScript(task, url);
      runSpan.addEvent('replay.match', { found: Boolean(match), name: match?.name, score: match?.score });
      if (match) {
        progress(`matched replay ${match.name} (score ${match.score.toFixed(2)}) — using $0 replay (override with --no-replay)`);
        try {
          const replayed = await qaReplay(match.name, {
            config: opts.config,
            onProgress: progress,
            bridge: opts.bridge,
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
        } catch (e) {
          progress(`matched replay errored (${e instanceof Error ? e.message : String(e)}) — falling back to a fresh AI run`);
          runSpan.addEvent('replay.fallback', { reason: 'replay-error', name: match.name, error: e instanceof Error ? e.message : String(e) });
        }
      }
    }

    const result = await runFreshAiPass(task, url, opts, progress, runSpan);
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
async function runFreshAiPass(
  task: string,
  url: string,
  opts: QaRunOptions,
  progress: (line: string) => void,
  runSpan: ActiveSpan,
): Promise<QaRunResult> {
  // Computed before the session opens so CdpBrowser/ExtensionBrowser get the
  // Tier-4 allowedHosts guard (A4, P0) at construction time, not just inside
  // the driver loop — closes the "raw cdp passthrough bypasses the guard" gap.
  const preCfg = loadConfig(opts.config ?? {});
  const allowedHosts = (opts.trustTargetHost ?? true)
    ? [...preCfg.allowedHosts, ...targetHostCandidates(url)]
    : preCfg.allowedHosts;

  const session = await openSession(opts.config ?? {}, { bridge: opts.bridge, tabId: opts.tabId, clientId: opts.clientId, allowedHosts });
  const { cfg, browser, nano } = session;

  const vault = new Vault();
  const adapters: ModelAdapter[] = [];
  if ((await pollNanoAvailable(nano, progress)) === 'available') {
    progress('rung 0: Gemini Nano available — warming up');
    await nano.warmup();
    adapters.push(new NanoAdapter(nano));
  } else {
    progress('rung 0: Gemini Nano not available — ladder starts at rung 1 (run `spike nano --download` to enable $0 visual checks)');
  }
  // The rest of the ladder + the user's two pins: navigator (plan-step, cheap) and
  // brain (plan-goals, smart). Each leads its own ladder; fallback stays intact.
  const { adapters: ladder, navigatorName, plannerName } = buildLadder(cfg, vault);
  adapters.push(...ladder);
  if (navigatorName && navigatorName !== 'nano') progress(`navigator: ${navigatorName} (leads the per-step ladder; fallback intact)`);
  if (plannerName && plannerName !== 'nano') progress(`brain: ${plannerName} (leads the plan/re-plan ladder; consulted on stuck)`);
  const router = new ModelRouter(adapters, {
    preferFreePlanner: cfg.preferFreePlanner,
    navigatorAdapter: navigatorName,
    plannerAdapter: plannerName,
  });

  const artifacts = new ArtifactStore(cfg.artifactsDir);
  const actionCache = cfg.actionCache ? new FileActionCache(cfg.actionCacheDir) : undefined;
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
        readOnly: cfg.readOnly,
        spendCapUsd: cfg.spendCapUsd,
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

    if (report.verdict === 'pass' && (opts.record ?? true)) {
      const { jsonPath, specPath } = saveScript(scriptFromReport(report));
      report.recordedScript = jsonPath;
      progress(`recorded: ${jsonPath} (+ Playwright twin ${specPath}) — replay at $0 with \`spike replay\``);
      runSpan.addEvent('script.recorded', { jsonPath });
    }
    return report;
  } finally {
    await session.close();
  }
}

export interface QaReplayOptions {
  /** On replay failure, re-engage the driver on the original task and re-emit the script. */
  heal?: boolean;
  config?: Partial<QaConfig>;
  onProgress?: (line: string) => void;
  /** Caller-owned bridge (extension mode) — see QaRunOptions.bridge. */
  bridge?: BridgeServer;
}

export interface QaReplayResult extends Report {
  healed?: boolean;
  recordedScript?: string;
}

export async function qaReplay(nameOrPath: string, opts: QaReplayOptions = {}): Promise<QaReplayResult> {
  const progress = opts.onProgress ?? (() => {});
  const script: QaScript = loadScript(nameOrPath);
  progress(`replaying "${script.name}" (${script.steps.length} steps, recorded ${script.createdAt}) — no planner, $0`);

  const tracer = getDefaultTracer();
  const replaySpan = tracer.startSpan('qa.replay', { scriptName: script.name, task: script.task, url: script.url });

  // Same A4 (P0) defense-in-depth wiring as qaRun: give the port the recorded
  // script's own host up front, so the guard is live even during replay.
  const preCfg = loadConfig(opts.config ?? {});
  const allowedHosts = [...preCfg.allowedHosts, ...targetHostCandidates(script.url)];
  const session = await openSession(opts.config ?? {}, { bridge: opts.bridge, allowedHosts });
  const artifacts = new ArtifactStore(session.cfg.artifactsDir);

  let report: QaReplayResult;
  try {
    report = await replayScript(session.browser, session.nano, artifacts, script, { onProgress: progress });
    progress(`replay verdict: ${report.verdict} (${Math.round(report.durationMs / 1000)}s)`);
    replaySpan.setAttribute('runId', report.runId);
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
      const { jsonPath } = saveScript(newScript);
      progress(`self-heal succeeded — script re-emitted: ${jsonPath}`);
      replaySpan.end({ verdict: report.verdict, healed: true, runId: report.runId });
      return { ...healed, healed: true, recordedScript: jsonPath };
    }
    progress('self-heal failed too — the app is genuinely broken, reporting the AI run verdict');
    replaySpan.end({ verdict: report.verdict, healed: false, runId: report.runId });
    return { ...healed, healed: false };
  }

  replaySpan.end({ verdict: report.verdict, runId: report.runId });
  return report;
}
