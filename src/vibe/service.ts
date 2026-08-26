/* VibeService — the daemon side of vibe mode.
 *
 * The side panel (parallel agent's work) speaks the bridge's reverse-RPC channel
 * to ask the daemon to run a QA task and to poll busy-state. The daemon answers
 * the request immediately ({accepted:true}) and then streams progress lines,
 * a final plain-English report, and a paste-ready fix prompt back over the bridge
 * as `vibe.*` events.
 *
 * Reverse-RPC methods registered here:
 *   vibe.run    {task, url} → {accepted:true}      (then async vibe.progress/done/error events)
 *   vibe.status {}          → {busy:boolean}
 *   vibe.fix    {}          → {accepted:true}      (then async vibe.fix-progress/-done events)
 *   vibe.cancel {}          → {cancelled:boolean}  (aborts the active run)
 *   vibe.clip   {}          → {name, mime, dataBase64}  (last saved replay clip)
 *   vibe.map.get      {host?} → {present:false} | {present:true, baseUrl?, routeCount,
 *                                stateCount, lastMappedAt}  (A51: read-only summary of
 *                                .spike/app-model.json for `host`, when it matches the
 *                                model's mapped host)
 *   vibe.coverage.get {host?} → {present:false} | {present:true, routes, interactiveElements,
 *                                perRoute}  (A51: read-only coverageReport() for `host`)
 *
 * Events emitted (via bridge.sendEvent):
 *   vibe.progress     {line}
 *   vibe.done         {verdict, reason, console_error, failing_step, evidence_paths,
 *                      plainReport, fixPrompt, durationMs}
 *   vibe.error        {message}
 *   vibe.fix-progress {line}
 *   vibe.fix-done     {ok, agent?} | {ok:false, message}
 *
 * Single-run invariant: only one QA run at a time (one attached Chrome, one tab).
 * A second vibe.run while busy is rejected with an error result, not queued.
 *
 * Auto-fix bridge: after a FAILED run we stash lastFailedReport so the panel can
 * ask the daemon (vibe.fix) to hand that report's fix prompt to a CLI coding
 * agent headlessly — no copy-paste. vibe.cancel aborts an in-flight run via an
 * AbortController whose signal is threaded into qaRun (engine owns QaRunOptions.
 * signal). */

import fs from 'node:fs';
import path from 'node:path';
import type { BridgeServer } from '../bridge/bridge-server.js';
import { qaRun, type QaRunOptions } from '../engine.js';
import { loadConfig } from '../config.js';
import { slimReport, type Report } from '../report/report.js';
import { renderPlainReport, buildFixPrompt } from './fix-prompt.js';
import { dispatchFix } from './auto-fix.js';
import { loadAppModel, coverageReport, type AppModel } from '../discovery/index.js';
import {
  SettingsStore,
  defaultModelFor,
  isSafeModelId,
  type ProviderId,
  type QaSettings,
} from './settings.js';
import { Vault } from '../vault/vault.js';

/* The provider→vault-name CONTRACT. The vault key NAME differs from the
 * provider id for historical reasons (the router/adapters look these up by
 * their own names): gemini→"gemini", claude→"anthropic", gpt→"openai",
 * openrouter→"openrouter". nano (on-device) and ollama (local) need no key, so
 * they are absent here — vibe.key.* throws for them. NEVER expose key VALUES
 * over the bridge; only presence (hasKey) is ever reported. */
const VAULT_KEY_FOR: Partial<Record<ProviderId, string>> = {
  gemini: 'gemini',
  claude: 'anthropic',
  gpt: 'openai',
  openrouter: 'openrouter',
  glm: 'glm',
};

/** Which transports each provider supports — panel-facing metadata, not the
 * PlannerMode union (nano's 'ondevice' isn't a PlannerMode), so this is a plain
 * string list: nano is on-device only; ollama is a local API; the hosted models
 * offer both a key'd API and a CLI binary. */
const PROVIDER_MODES: Record<ProviderId, string[]> = {
  nano: ['ondevice'],
  gemini: ['api', 'cli'],
  claude: ['api', 'cli'],
  gpt: ['api', 'cli'],
  ollama: ['api'],
  openrouter: ['api'],
  glm: ['api'], // z.ai hosted key'd API only (no first-party CLI)
};

/** The provider list the panel renders, in ladder order. */
const PROVIDER_ORDER: ProviderId[] = ['nano', 'gemini', 'claude', 'gpt', 'ollama', 'openrouter', 'glm'];

/** A3: validates vibe.run's allowHost — a bare hostname (optionally with a
 * trailing :port), no scheme/path/credentials/whitespace. Keeps a malformed
 * or injection-shaped string from being folded straight into allowedHosts. */
const PLAIN_HOSTNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*(:\d{1,5})?$/;
function isPlainHostname(host: string): boolean {
  return PLAIN_HOSTNAME_RE.test(host);
}

/** Shape of the extension's rec.start / rec.stop bridge responses. */
interface RecStartResult { ok: boolean; reason?: string; mime?: string }
interface RecStopResult { ok: boolean; reason?: string; webmBase64?: string; bytes?: number; mime?: string }

/** A51: the host (hostname[:port], matching the `hostOf()`/`allowHost`
 * convention used elsewhere in this file and in the panel — see
 * PLAIN_HOSTNAME_RE above) a discovered AppModel belongs to. `baseUrl` (set by
 * `discoverApp` whenever a run has one) is the primary source; a legacy/manual
 * model without it falls back to the first route that parses as an absolute
 * URL (crawl-discovered routes always are; static-only routes may be bare
 * patterns like `/about` and are skipped). Undefined when neither yields a
 * parseable host — callers then treat the model as unscoped (serve it as-is). */
function appModelHost(model: AppModel): string | undefined {
  if (model.baseUrl) {
    try {
      return new URL(model.baseUrl).host;
    } catch {
      /* fall through to route-based lookup */
    }
  }
  for (const r of model.routes) {
    try {
      return new URL(r.route).host;
    } catch {
      /* not an absolute URL (a bare static pattern) — try the next route */
    }
  }
  return undefined;
}

export class VibeService {
  private busy = false;
  /** The last failed Report — the source for vibe.fix's dispatch. Cleared on a
   * passing run (nothing to fix) so vibe.fix can't re-dispatch a stale failure. */
  private lastFailedReport: Report | null = null;
  /** Guards against overlapping fix dispatches. */
  private fixing = false;
  /** Aborts the active qaRun (vibe.cancel). Null when no run is in flight. */
  private activeRun: AbortController | null = null;
  /** tabId the active run is driving, when known (undefined for a create-a-tab
   * run) — lets the A23 detach handler below match a `detached` event to the
   * run it actually affects, rather than aborting on any stray detach. */
  private activeRunTabId: number | null = null;
  /** A23: set right before aborting `activeRun` because of a `detached` bridge
   * event, so `execute()` can report a clear reason instead of whatever
   * generic message qaRun surfaces for a plain aborted signal ("cancelled by
   * user" — same wording as an explicit vibe.cancel, not helpful when what
   * actually happened is Chrome's debugging session was closed). */
  private detachAbortMessage: string | null = null;
  /** Absolute path of the clip saved by the most recent run (replay.mp4|.webm).
   * Null until a run produces one; vibe.clip serves it back to the panel. */
  private lastClipPath: string | null = null;

  constructor(private readonly bridge: BridgeServer) {}

  /** TEST SEAM ONLY: let v22.clip-share point lastClipPath at a temp file without
   * spawning Chrome. Not used in production (real runs set it via stopAndSaveClip). */
  noteClipForTest(p: string): void {
    this.lastClipPath = p;
  }

  start(): void {
    // A23: sw.js emits {event:'detached'} whenever chrome.debugger detaches
    // from a tab (e.g. the user dismissed Chrome's "<ext> is debugging this
    // browser" banner). Previously nothing subscribed to it — the run just
    // kept going, hammering a dead CDP session, and failed later with an
    // opaque error instead of a clear one. Single-run invariant means there's
    // at most one activeRun at a time, so an unmatched tabId on the run
    // (create-a-tab path — activeRunTabId is null) treats any detach as
    // affecting it; a known tabId only aborts on a matching detach.
    this.bridge.onEvent((evt) => {
      if (evt.event !== 'detached') return;
      if (!this.activeRun) return;
      const params = evt.params as { tabId?: unknown };
      const tabId = typeof params.tabId === 'number' ? params.tabId : undefined;
      if (this.activeRunTabId !== null && tabId !== undefined && tabId !== this.activeRunTabId) return;
      this.detachAbortMessage = "Chrome's debugging session was closed";
      this.activeRun.abort();
    });

    this.bridge.onRequest('vibe.status', async () => ({ busy: this.busy }));
    this.bridge.onRequest('vibe.run', async (params, ctx) => {
      // A3: only the paired bridge client (A2) may drive a run.
      if (!this.bridge.isAuthenticated(ctx.clientId)) throw new Error('vibe.run: unauthenticated client');
      if (this.busy) throw new Error('a run is already in progress');
      const task = String((params as { task?: unknown }).task ?? '');
      const url = String((params as { url?: unknown }).url ?? '');
      // tabId (the panel's current tab) is optional — absent → create-a-tab path.
      const rawTabId = (params as { tabId?: unknown }).tabId;
      const tabId = typeof rawTabId === 'number' ? rawTabId : undefined;
      // allowHost (the panel's consent toggle): when present, the user opted to
      // let the agent click/type on this host → add it to allowedHosts for this
      // run. Absent → the daemon's read-only guard applies on third-party hosts.
      // A3: validated as a plain hostname (optionally with a port) — an
      // authenticated caller is still not a reason to fold an arbitrary string
      // straight into allowedHosts.
      const rawAllowHost = (params as { allowHost?: unknown }).allowHost;
      const trimmedAllowHost = typeof rawAllowHost === 'string' ? rawAllowHost.trim() : '';
      if (trimmedAllowHost && !isPlainHostname(trimmedAllowHost)) {
        throw new Error('vibe.run: invalid allowHost');
      }
      const allowHost = trimmedAllowHost || undefined;
      if (!task || !url) throw new Error('vibe.run requires { task, url }');
      this.busy = true;
      // Fire-and-forget the actual run; the request returns immediately.
      // ctx.clientId binds the whole run (browser calls + UI events) to the
      // Chrome whose panel asked — a second connected Chrome stays untouched.
      void this.execute(task, url, tabId, allowHost, ctx?.clientId);
      return { accepted: true };
    });

    // vibe.fix — hand the last failed run's fix prompt to a CLI coding agent.
    this.bridge.onRequest('vibe.fix', async (params, ctx) => {
      // A3: only the paired bridge client (A2) may dispatch an auto-fix.
      if (!this.bridge.isAuthenticated(ctx.clientId)) throw new Error('vibe.fix: unauthenticated client');
      if (!this.lastFailedReport) throw new Error('vibe.fix: no failed run to fix yet');
      if (this.fixing) throw new Error('vibe.fix: a fix is already in progress');
      this.fixing = true;
      const report = this.lastFailedReport;
      // A16: the panel's explicit "confirm auto-fix" control is the only way
      // a bridge caller vouches for the one-time per-project consent gate.
      const confirmed = (params as { confirmed?: boolean } | undefined)?.confirmed === true;
      void this.dispatch(report, ctx?.clientId, confirmed);
      return { accepted: true };
    });

    // vibe.cancel — abort the in-flight run.
    this.bridge.onRequest('vibe.cancel', async () => {
      if (!this.activeRun) return { cancelled: false };
      this.activeRun.abort();
      return { cancelled: true };
    });

    // vibe.clip — serve the LAST saved replay clip back to the panel so it can
    // offer a download. Clips are a few MB; returning one base64 frame is fine.
    this.bridge.onRequest('vibe.clip', async () => {
      const p = this.lastClipPath;
      if (!p) throw new Error('no clip from the last run');
      let buf: Buffer;
      try {
        buf = fs.readFileSync(p);
      } catch {
        throw new Error('no clip from the last run');
      }
      const ext = path.extname(p).toLowerCase();
      const mime = ext === '.mp4' ? 'video/mp4' : 'video/webm';
      return { name: path.basename(p), mime, dataBase64: buf.toString('base64') };
    });

    // vibe.map.get — A51: read-only summary of the discovery layer's
    // `.spike/app-model.json` (built by `spike map`) for the panel's "Site map"
    // card. No mutation, no host-trust implications — this never drives the
    // browser, it only reads a file already on disk. `host` (the panel's
    // current-tab hostname) is optional; when given and the model was mapped
    // for a different host, we report {present:false} rather than surfacing
    // stale data for the wrong site.
    this.bridge.onRequest('vibe.map.get', async (params) => {
      const rawHost = (params as { host?: unknown } | undefined)?.host;
      const host = typeof rawHost === 'string' ? rawHost.trim() : '';
      const model = loadAppModel(process.cwd());
      if (!model || model.routes.length === 0) return { present: false };
      const modelHost = appModelHost(model);
      if (host && modelHost && modelHost !== host) return { present: false };
      const stateCount = model.routes.reduce((n, r) => n + r.states.length, 0);
      return {
        present: true,
        baseUrl: model.baseUrl,
        routeCount: model.routes.length,
        stateCount,
        lastMappedAt: model.generatedAt,
      };
    });

    // vibe.coverage.get — A51: read-only per-route covered/uncovered breakdown
    // from the same ledger, via discovery/coverage.ts's coverageReport() (never
    // hand-rolled here). Same host-scoping contract as vibe.map.get above.
    this.bridge.onRequest('vibe.coverage.get', async (params) => {
      const rawHost = (params as { host?: unknown } | undefined)?.host;
      const host = typeof rawHost === 'string' ? rawHost.trim() : '';
      const model = loadAppModel(process.cwd());
      if (!model || model.routes.length === 0) return { present: false };
      const modelHost = appModelHost(model);
      if (host && modelHost && modelHost !== host) return { present: false };
      const report = coverageReport(model);
      return {
        present: true,
        routes: report.routes,
        interactiveElements: report.interactiveElements,
        perRoute: report.perRoute,
      };
    });

    // vibe.config.get — the panel's settings screen reads the user's current
    // non-secret picks (planner / debug mode / debug agent) plus, per provider,
    // the transports it supports, the default models, and WHETHER a key is on
    // file. Key VALUES never cross the bridge — only presence (hasKey).
    this.bridge.onRequest('vibe.config.get', async () => {
      const settings = new SettingsStore().read();
      const vault = new Vault();
      const providers = PROVIDER_ORDER.map((id) => {
        const vaultName = VAULT_KEY_FOR[id];
        const needsKey = Boolean(vaultName);
        // hasKey: a stored vault entry counts; for gemini an env GEMINI_API_KEY
        // also counts (the CLI/adapter honors it without us storing anything).
        let hasKey = false;
        if (needsKey) {
          hasKey = Boolean(vault.get(vaultName!));
          if (id === 'gemini' && process.env.GEMINI_API_KEY) hasKey = true;
        }
        return {
          id,
          modes: PROVIDER_MODES[id],
          apiModelDefault: defaultModelFor(id, 'api'),
          cliModelDefault: defaultModelFor(id, 'cli'),
          // role-aware defaults for the two Settings cards (navigator=cheap, brain=smart).
          navModelDefault: defaultModelFor(id, 'api', 'navigator'),
          brainModelDefault: defaultModelFor(id, 'api', 'brain'),
          needsKey,
          hasKey,
        };
      });
      return {
        planner: settings.planner,
        navigator: settings.navigator,
        debugMode: settings.debugMode,
        debugAgent: settings.debugAgent,
        videoAssertions: settings.videoAssertions ?? false,
        // A5b/A5a (P1 safety): dry-run default + optional spend cap. readOnly
        // mirrors DEFAULT_SETTINGS' safe-by-default true; spendCapUsd stays
        // undefined (OFF) unless the user set one.
        readOnly: settings.readOnly ?? true,
        spendCapUsd: settings.spendCapUsd,
        // A1 headline feature: deterministic verdicts, safe-by-default true.
        strictOracles: settings.strictOracles ?? true,
        providers,
      };
    });

    // vibe.config.set — persist the panel's picks. Loose validation: we forward
    // only the three known fields (unknown keys ignored) to SettingsStore.write,
    // which merges over the current settings and returns the full result.
    this.bridge.onRequest('vibe.config.set', async (params, ctx) => {
      // A3: only the paired bridge client (A2) may change settings.
      if (!this.bridge.isAuthenticated(ctx.clientId)) throw new Error('vibe.config.set: unauthenticated client');
      const p = (params ?? {}) as Partial<QaSettings>;
      const patch: Partial<QaSettings> = {};
      if (p.planner !== undefined) {
        // SECURITY: planner.model is later interpolated into a CLI command for
        // claude/codex CLI mode. This handler is reachable by any localhost
        // WebSocket client, so reject a tainted model id here rather than persist
        // it. (Empty model = "use the default" and is fine.)
        const model = (p.planner as { model?: unknown }).model;
        if (typeof model === 'string' && model && !isSafeModelId(model)) {
          throw new Error('vibe.config.set: invalid model id (letters, digits and . _ - : / + only)');
        }
        patch.planner = p.planner;
      }
      if (p.navigator !== undefined) {
        // Same command-injection guard as planner above — navigator.model is
        // interpolated into the CLI command line for cli-mode navigators.
        const model = (p.navigator as { model?: unknown }).model;
        if (typeof model === 'string' && model && !isSafeModelId(model)) {
          throw new Error('vibe.config.set: invalid model id (letters, digits and . _ - : / + only)');
        }
        patch.navigator = p.navigator;
      }
      if (p.debugMode !== undefined) patch.debugMode = p.debugMode;
      if (p.debugAgent !== undefined) patch.debugAgent = p.debugAgent;
      if (p.videoAssertions !== undefined) patch.videoAssertions = Boolean(p.videoAssertions);
      // A5b: dry-run toggle — plain boolean coercion, same as videoAssertions.
      if (p.readOnly !== undefined) patch.readOnly = Boolean(p.readOnly);
      // A5a: optional spend cap — 0/negative/non-finite clears it (explicit OFF),
      // matching SPIKE_SPEND_CAP_USD's env parsing in config.ts.
      if (p.spendCapUsd !== undefined) {
        const n = Number(p.spendCapUsd);
        patch.spendCapUsd = Number.isFinite(n) && n > 0 ? n : undefined;
      }
      // A1: dry-run toggle — same plain boolean coercion as readOnly/videoAssertions.
      if (p.strictOracles !== undefined) patch.strictOracles = Boolean(p.strictOracles);
      return new SettingsStore().write(patch);
    });

    // vibe.key.set — store an API key in the encrypted Vault under the CONTRACT
    // name for that provider. Only key-bearing providers are allowed; nano and
    // ollama (and anything unknown) throw. The key is never echoed back.
    this.bridge.onRequest('vibe.key.set', async (params, ctx) => {
      // A3: only the paired bridge client (A2) may store an API key.
      if (!this.bridge.isAuthenticated(ctx.clientId)) throw new Error('vibe.key.set: unauthenticated client');
      const p = (params ?? {}) as { provider?: unknown; key?: unknown };
      const provider = String(p.provider ?? '') as ProviderId;
      const vaultName = VAULT_KEY_FOR[provider];
      if (!vaultName) throw new Error(`vibe.key.set: provider ${String(p.provider)} takes no key`);
      const key = typeof p.key === 'string' ? p.key : '';
      if (!key) throw new Error(`vibe.key.set: a non-empty { key } is required for provider ${provider}`);
      new Vault().set(vaultName, String(key));
      return { ok: true, provider };
    });

    // vibe.key.clear — delete the stored key for a provider. Returns whether a
    // key was actually present (cleared:false means there was nothing to clear).
    this.bridge.onRequest('vibe.key.clear', async (params, ctx) => {
      // A3: only the paired bridge client (A2) may clear a stored API key.
      if (!this.bridge.isAuthenticated(ctx.clientId)) throw new Error('vibe.key.clear: unauthenticated client');
      const p = (params ?? {}) as { provider?: unknown };
      const provider = String(p.provider ?? '') as ProviderId;
      const vaultName = VAULT_KEY_FOR[provider];
      if (!vaultName) throw new Error(`vibe.key.clear: provider ${String(p.provider)} takes no key`);
      const cleared = new Vault().delete(vaultName);
      return { ok: true, provider, cleared };
    });
  }

  private async execute(task: string, url: string, tabId?: number, allowHost?: string, clientId?: number): Promise<void> {
    const controller = new AbortController();
    this.activeRun = controller;
    this.activeRunTabId = typeof tabId === 'number' ? tabId : null;
    this.detachAbortMessage = null;
    const target = clientId !== undefined ? { clientId } : undefined;
    const progress = (line: string) => this.bridge.sendEvent('vibe.progress', { line }, target);

    // Replay recording brackets the run. Only attempt it on REAL panel runs
    // (tabId present): tabCapture needs the extension to have been invoked on a
    // real tab — there's no clip for the create-a-tab/test path. Every recorder
    // call is failure-tolerant; the clip is a nice-to-have, never a run blocker.
    let recording = false;
    if (typeof tabId === 'number') {
      try {
        const start = await this.bridge.call<RecStartResult>('rec.start', { tabId }, 20_000, target);
        if (start && start.ok) {
          recording = true;
          progress('recording replay clip…');
        } else {
          progress(`clip unavailable: ${start?.reason ?? 'recorder declined to start'}`);
        }
      } catch (e) {
        progress(`clip unavailable: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    try {
      // The engine agent is adding QaRunOptions.signal; until that lands the
      // structural cast keeps this typechecking. TODO: drop the cast once
      // QaRunOptions.signal is declared.
      // Consent: only when the panel passed allowHost do we widen allowedHosts.
      // Unchecked → the default allowedHosts (localhost/127.0.0.1) stand, so the
      // read-only guard applies on third-party hosts and the run ends with the
      // guard message (which the panel surfaces). qaRun's own trustTargetHost
      // default (true, for CLI/MCP callers who named the URL as a deliberate
      // target) is explicitly turned off here unless the checkbox was on — the
      // panel drives whatever tab happens to be open, so naming a URL is not
      // itself consent the way typing it on a command line is.
      const config = allowHost
        ? { via: 'extension' as const, allowedHosts: [...loadConfig().allowedHosts, allowHost] }
        : { via: 'extension' as const };
      const runOpts = {
        bridge: this.bridge,
        tabId,
        clientId,
        config,
        trustTargetHost: Boolean(allowHost),
        record: false,
        onProgress: progress,
        onStep: (info) => this.bridge.sendEvent('vibe.step', info as unknown as Record<string, unknown>, target),
        signal: controller.signal,
      } as QaRunOptions & { signal?: AbortSignal };
      const report = await qaRun(task, url, runOpts);

      // Stop recording and persist the webm (failure-tolerant — a missing clip
      // never changes the verdict). Keyed by the report's runId so it lands
      // alongside report.json + screenshots.
      const clipPath = recording ? await this.stopAndSaveClip(report.runId, progress, target) : undefined;

      // A23: qaRun returns a normal (not thrown) report even when its signal
      // was aborted mid-run — the driver just stamps a generic "cancelled by
      // user" reason. If OUR abort fired because the debugger detached,
      // report that clear reason instead of the generic result.
      if (this.detachAbortMessage) {
        this.bridge.sendEvent('vibe.error', { message: this.detachAbortMessage }, target);
      } else {
        // Stash a failure so the panel can offer "fix it"; clear on success.
        this.lastFailedReport = report.verdict === 'pass' ? null : report;
        this.bridge.sendEvent('vibe.done', {
          ...slimReport(report),
          plainReport: renderPlainReport(report),
          fixPrompt: buildFixPrompt(report),
          durationMs: report.durationMs,
          ...(clipPath ? { clipPath } : {}),
        }, target);
      }
    } catch (e) {
      // A run failure must not leave a recorder running in the offscreen doc.
      if (recording) { try { await this.bridge.call('rec.stop', {}, 25_000, target); } catch { /* best effort */ } }
      this.bridge.sendEvent('vibe.error', {
        message: this.detachAbortMessage ?? (e instanceof Error ? e.message : String(e)),
      }, target);
    } finally {
      this.busy = false;
      this.activeRun = null;
      this.activeRunTabId = null;
      this.detachAbortMessage = null;
    }
  }

  /** Stop the extension recorder, decode the clip, write artifacts/<runId>/replay.<ext>.
   * The extension reports the chosen mime (mp4 where the platform records H.264,
   * else webm) → we pick the matching extension so the file previews correctly.
   * Returns the path on success, undefined otherwise. Never throws. */
  private async stopAndSaveClip(runId: string, progress: (line: string) => void, target?: { clientId: number }): Promise<string | undefined> {
    try {
      const stop = await this.bridge.call<RecStopResult>('rec.stop', {}, 30_000, target);
      if (!stop || !stop.ok || !stop.webmBase64) {
        progress(`clip unavailable: ${stop?.reason ?? 'recorder returned no data'}`);
        return undefined;
      }
      const buf = Buffer.from(stop.webmBase64, 'base64');
      const isMp4 = typeof stop.mime === 'string' && stop.mime.includes('mp4');
      if (!isMp4) {
        // sanity: webm/Matroska EBML magic 0x1A45DFA3 (only meaningful for webm)
        if (buf.length < 4 || !(buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3)) {
          progress('clip unavailable: recorded bytes are not a valid webm');
          return undefined;
        }
      } else if (buf.length < 4) {
        progress('clip unavailable: recorded mp4 is empty');
        return undefined;
      }
      const dir = path.join(loadConfig({}).artifactsDir, runId);
      fs.mkdirSync(dir, { recursive: true });
      const clipPath = path.join(dir, isMp4 ? 'replay.mp4' : 'replay.webm');
      fs.writeFileSync(clipPath, buf);
      this.lastClipPath = clipPath;
      progress(`replay clip: ${clipPath} (${Math.round(buf.length / 1024)} KB)`);
      return clipPath;
    } catch (e) {
      progress(`clip unavailable: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
  }

  private async dispatch(report: Report, clientId?: number, confirmed?: boolean): Promise<void> {
    const target = clientId !== undefined ? { clientId } : undefined;
    try {
      const res = await dispatchFix(report, {
        onProgress: (line) => this.bridge.sendEvent('vibe.fix-progress', { line }, target),
        confirmed,
      });
      this.bridge.sendEvent('vibe.fix-done', { ok: res.ok, agent: res.agent }, target);
    } catch (e) {
      this.bridge.sendEvent('vibe.fix-done', {
        ok: false,
        message: e instanceof Error ? e.message : String(e),
      }, target);
    } finally {
      this.fixing = false;
    }
  }
}
