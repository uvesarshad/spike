/* VibeService — the daemon side of vibe mode.
 *
 * The side panel (parallel agent's work) speaks the bridge's reverse-RPC channel
 * to ask the daemon to run a QA task and to poll busy-state. The daemon answers
 * the request immediately ({accepted:true}) and then streams progress lines,
 * a final plain-English report, and a paste-ready fix prompt back over the bridge
 * as `vibe.*` events.
 *
 * Reverse-RPC methods registered here:
 *   vibe.run    {task, url, allowHost?, allowHosts?, expect?} → {accepted:true}
 *                             (then async vibe.progress/done/error events;
 *                             allowHosts = A14's already-consented extra sites)
 *   vibe.status {}          → {busy:boolean}
 *   vibe.fix    {confirmed?} → {accepted:true} | {needsProjectFolder:true, message}
 *                             | {needsConfirmation:true, projectDir}
 *                             (A11: a bridge caller has no terminal, so an
 *                             unconfirmed first fix for a project is ANSWERED
 *                             with the question rather than prompting; then
 *                             async vibe.fix-progress/-done events)
 *   vibe.cancel {}          → {cancelled:boolean}  (aborts the active run)
 *   vibe.clip   {}          → {name, mime, dataBase64}  (last saved replay clip)
 *   vibe.bundle.get {}      → {name, mime, dataBase64}  (A15: the last run's
 *                             whole artifacts/<runId>/ folder + its clip, zipped)
 *   vibe.artifact.get {path} → {name, mime, dataBase64}  (A15: one screenshot
 *                             from the LAST run — the path must be one that run
 *                             produced, so this is not a read-any-file method)
 *   vibe.map.get      {host?} → {present:false} | {present:true, baseUrl?, routeCount,
 *                                stateCount, lastMappedAt}  (A51: read-only summary of
 *                                .spike/app-model.json for `host`, when it matches the
 *                                model's mapped host)
 *   vibe.coverage.get {host?} → {present:false} | {present:true, routes, interactiveElements,
 *                                perRoute}  (A51: read-only coverageReport() for `host`)
 *   vibe.tests.list   {host?} → {tests:[{name, task, url, host, createdAt, steps,
 *                                repairedAt?}]}  (A19: the saved tests recorded for
 *                                this site, newest first)
 *   vibe.replay {name, heal?, tabId?} → {accepted:true}  (A19: re-run one saved
 *                                test with no AI calls — same progress/done/error
 *                                events as vibe.run; heal re-records it on failure)
 *   vibe.spec.decompose {spec, url?, maxFlows?} → {flows:[{name, task}]}
 *                             (A7: one planning call that turns a pasted
 *                             document into the flow checklist the panel shows
 *                             before running anything)
 *
 * Events emitted (via bridge.sendEvent):
 *   vibe.progress     {line}
 *   vibe.done         {verdict, reason, console_error, failing_step, evidence_paths,
 *                      plainReport, fixPrompt, durationMs}
 *   vibe.error        {message}
 *   vibe.fix-progress {line}
 *   vibe.fix-done     {ok, agent?} | {ok:false, message} | (after the automatic re-test)
 *                     {ok, verdict, attempts, note?} — the re-test's verdict, how many
 *                     test runs it took, and a note when the rebuild was not confirmed
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
import os from 'node:os';
import path from 'node:path';
import type { BridgeServer } from '../bridge/bridge-server.js';
import { createPlanningRouter, openBrowserSession, qaReplay, qaRun, type QaReplayOptions, type QaRunOptions } from '../engine.js';
import { listScripts, loadScript } from '../recorder/script.js';
import { loadConfig } from '../config.js';
import { decomposeSpec } from '../driver/spec-decompose.js';
import { headlineScreenshot, slimReport, type Report } from '../report/report.js';
import { makeZip, type ZipEntry } from '../report/zip.js';
import { renderPlainReport, buildFixPrompt, dataUri, MAX_FIX_PROMPT_IMAGE_BYTES } from './fix-prompt.js';
import { explainReason } from './reason-text.js';
import { dispatchFix, isAutoFixAcceptedFor, detectFixAgent, runWithAutoFix, NO_PROJECT_FOLDER_MESSAGE, type RunFn, type RunWithAutoFixOptions } from './auto-fix.js';
import {
  loadAppModel,
  saveAppModel,
  coverageReport,
  discoverApp,
  browserFetcher,
  checkTargets,
  checkInstruction,
  explorationOptions,
  DEFAULT_CHECK_PAGES,
  type AppModel,
} from '../discovery/index.js';
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

/* A5 (P0): the ONLY two vault names the side panel may write.
 *
 * The panel's "Test login (optional)" card exists so a person stops typing a
 * real password into the task box. That means the panel now needs to put a
 * value into the vault — but it must never become a general-purpose vault
 * writer: the same store holds the user's API keys, and a compromised or buggy
 * page could otherwise overwrite one. Exactly like vibe.key.*, the name is
 * looked up in a fixed table and anything else is refused. */
const TEST_LOGIN_SECRET_NAMES = ['TEST_USER', 'TEST_PASSWORD'] as const;
export type TestLoginSecretName = (typeof TEST_LOGIN_SECRET_NAMES)[number];

/** True only for the two test-login field names. */
export function isTestLoginSecretName(name: unknown): name is TestLoginSecretName {
  return typeof name === 'string' && (TEST_LOGIN_SECRET_NAMES as readonly string[]).includes(name);
}

/** Narrow an incoming name to a test-login field, or refuse. Thrown before any
 * vault read or write happens. */
function requireTestLoginSecretName(method: string, name: unknown): TestLoginSecretName {
  if (!isTestLoginSecretName(name)) {
    throw new Error(`${method}: only the test-login fields can be stored here, not "${String(name)}"`);
  }
  return name;
}

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

/** A25: where a remembered sign-in for one site is kept — `~/.spike/state/
 * <host>.json`, one file per site, written owner-only by saveStorageStateFile.
 * The host is sanitised because it becomes a filename (a port's colon is not
 * legal on Windows, and nothing from a URL should ever steer a path). */
export function savedLoginPath(host: string): string {
  const safe = host
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '_')
    .replace(/\.{2,}/g, '.') // no `..` segment survives, belt-and-braces
    .replace(/^[.-]+/, '');
  return path.join(os.homedir(), '.spike', 'state', `${safe || 'site'}.json`);
}

/** A19: `www.shop.com` and `shop.com` are the same site to a user, and a saved
 * test recorded on one must still be offered on the other — the same apex↔www
 * equivalence the run-time host guard already applies. */
function stripWww(host: string): string {
  return host.startsWith('www.') ? host.slice(4) : host;
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
/** A15: the failing screenshot as a data URI for the fix prompt, or undefined
 * when there isn't one or it is too big to be worth pasting into a chat box.
 * Reads the file eagerly only when it is small enough — the size check is done
 * on disk first so a 3 MB full-page PNG is never loaded just to be discarded. */
function fixPromptThumbnail(report: Report): string | undefined {
  const p = headlineScreenshot(report);
  if (!p) return undefined;
  try {
    // base64 is 4/3 of the byte length, plus the short "data:image/png;base64,"
    // prefix — so bail before reading anything that obviously cannot fit.
    if (fs.statSync(p).size * (4 / 3) > MAX_FIX_PROMPT_IMAGE_BYTES) return undefined;
    return dataUri(fs.readFileSync(p).toString('base64'), 'image/png');
  } catch {
    return undefined;
  }
}

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
  /** A6: what it takes to re-test the run that just failed — the same task, url
   * and run options — so an auto-fix can dispatch → wait → re-run like the CLI. */
  private lastRerun: { task: string; url: string; runOpts: QaRunOptions } | null = null;
  /** TEST SEAM ONLY: stand-ins for the real coding agent and the real run. */
  private fixLoopOverrides: { runFn?: RunFn; dispatchFn?: RunWithAutoFixOptions['dispatchFn']; rebuild?: RunWithAutoFixOptions['rebuild'] } = {};
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
  /** A15: the evidence the LAST run produced. vibe.artifact.get will serve a
   * file only if it is in here — the panel can therefore ask for a screenshot
   * by path without that method becoming a read-anything-on-disk hole. */
  private lastEvidencePaths = new Set<string>();
  /** A15: the artifacts/<runId>/ folder of the last finished run — everything
   * vibe.bundle.get is allowed to put in the zip. Null until a run finishes. */
  private lastRunDir: string | null = null;

  constructor(private readonly bridge: BridgeServer) {}

  /** TEST SEAM ONLY: let v22.clip-share point lastClipPath at a temp file without
   * spawning Chrome. Not used in production (real runs set it via stopAndSaveClip). */
  noteClipForTest(p: string): void {
    this.lastClipPath = p;
  }

  /** TEST SEAM ONLY: let v85.autofix-consent exercise the vibe.fix consent gate
   * without running a real (failing) QA run first. Production sets this in
   * execute() when a run comes back failed. */
  noteFailedReportForTest(report: Report): void {
    this.lastFailedReport = report;
  }

  /** TEST SEAM ONLY (A6): give vibe.fix a run to re-test, and stub agent/run. */
  noteRerunForTest(task: string, url: string, overrides: VibeService['fixLoopOverrides'] = {}): void {
    this.lastRerun = { task, url, runOpts: {} };
    this.fixLoopOverrides = overrides;
  }

  /** The project directory an auto-fix would edit, or undefined when the user
   * hasn't chosen one. A11: deliberately NO process.cwd() fallback — the
   * desktop helper starts at login from an arbitrary directory. */
  private fixProjectDir(): string | undefined {
    return loadConfig({}).fixAgentCwd;
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
      // A14: extra hosts the user has already consented to for this site (the
      // panel's "Allow <site> and run again" button, remembered per pair of
      // sites). Validated exactly like allowHost — an authenticated caller is
      // still not a reason to fold arbitrary strings into allowedHosts — and
      // only honoured alongside a consented allowHost, so this can never widen
      // a look-only run.
      const rawAllowHosts = (params as { allowHosts?: unknown }).allowHosts;
      const extraHosts: string[] = [];
      if (Array.isArray(rawAllowHosts)) {
        for (const h of rawAllowHosts) {
          const t = typeof h === 'string' ? h.trim() : '';
          if (!t) continue;
          if (!isPlainHostname(t)) throw new Error('vibe.run: invalid allowHosts entry');
          extraHosts.push(t);
        }
      }
      // A1 (P0): readOnly (look-only mode) for THIS run. The panel derives it
      // from the same per-site "Allow the agent to click & type" checkbox that
      // produces allowHost, so the one control the user sees is the real switch.
      // Absent (an older panel) → undefined, and the stored setting still wins.
      const rawReadOnly = (params as { readOnly?: unknown }).readOnly;
      const readOnly = typeof rawReadOnly === 'boolean' ? rawReadOnly : undefined;
      // A25: "Remember my login for tests" — when on, a passing run's signed-in
      // state is saved for this site and handed to later tests against it, so a
      // test doesn't have to sign in again every time.
      const rememberLogin = Boolean((params as { rememberLogin?: unknown }).rememberLogin);
      // A17: the panel's "What should be true at the end?" text. Free-form by
      // design — it is shown to the models as the run's success condition, never
      // executed — so it is only trimmed and length-capped.
      const rawExpect = (params as { expect?: unknown }).expect;
      const expectations = typeof rawExpect === 'string' && rawExpect.trim()
        ? rawExpect.trim().slice(0, 2000)
        : undefined;
      if (!task || !url) throw new Error('vibe.run requires { task, url }');
      this.busy = true;
      // Fire-and-forget the actual run; the request returns immediately.
      // ctx.clientId binds the whole run (browser calls + UI events) to the
      // Chrome whose panel asked — a second connected Chrome stays untouched.
      void this.execute(task, url, tabId, allowHost, ctx?.clientId, readOnly, extraHosts, rememberLogin, expectations);
      return { accepted: true };
    });

    // vibe.fix — hand the last failed run's fix prompt to a CLI coding agent.
    this.bridge.onRequest('vibe.fix', async (params, ctx) => {
      // A3: only the paired bridge client (A2) may dispatch an auto-fix.
      if (!this.bridge.isAuthenticated(ctx.clientId)) throw new Error('vibe.fix: unauthenticated client');
      if (!this.lastFailedReport) throw new Error('vibe.fix: no failed run to fix yet');
      if (this.fixing) throw new Error('vibe.fix: a fix is already in progress');
      const report = this.lastFailedReport;
      // A16: the panel's explicit "confirm auto-fix" control is the only way
      // a bridge caller vouches for the one-time per-project consent gate.
      const confirmed = (params as { confirmed?: boolean } | undefined)?.confirmed === true;
      // A11 (P0): a request that arrived over the bridge has NO terminal behind
      // it, so the consent gate can never be answered with a y/N prompt here —
      // under a login-installed helper that prompt has no reader at all, and in
      // a real terminal it would hang the panel's button forever on a keypress
      // nobody sees. Instead we answer the question as DATA: the panel gets the
      // project folder back, shows its own confirm dialog, and re-sends the
      // request with confirmed:true. Acceptance is then remembered per project
      // directory by ensureAutoFixConfirmed, so this asks at most once.
      const projectDir = this.fixProjectDir();
      // A11 (P0): with no project folder chosen there is nothing safe to edit —
      // say so plainly rather than pointing a coding agent at whatever folder
      // this helper happened to start in.
      if (!projectDir) {
        return { needsProjectFolder: true, message: NO_PROJECT_FOLDER_MESSAGE };
      }
      if (!confirmed && !isAutoFixAcceptedFor(projectDir)) {
        return { needsConfirmation: true, projectDir };
      }
      // A6: fix a confirmed failure only. An uncertain run may not be a bug at
      // all, and editing code that was not broken is worse than doing nothing.
      if (report.verdict !== 'fail') {
        throw new Error('vibe.fix: the result was not a confirmed failure, so there is nothing to fix');
      }
      const rawMax = (params as { maxFixAttempts?: unknown } | undefined)?.maxFixAttempts;
      const maxFixAttempts = typeof rawMax === 'number' && Number.isFinite(rawMax) ? Math.min(5, Math.max(1, Math.floor(rawMax))) : 2;
      this.fixing = true;
      void this.dispatch(report, ctx?.clientId, confirmed, maxFixAttempts);
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

    // vibe.artifact.get — A15: one file from the LAST run, as bytes, so the
    // result card can show the failing screenshot inline instead of naming it.
    // The path must be one this run actually produced (lastEvidencePaths): the
    // panel is a trusted client, but a method that reads an arbitrary path off
    // the user's disk on request is not something to leave lying on a
    // localhost socket.
    this.bridge.onRequest('vibe.artifact.get', async (params, ctx) => {
      if (!this.bridge.isAuthenticated(ctx.clientId)) {
        throw new Error('vibe.artifact.get: unauthenticated client');
      }
      const raw = (params as { path?: unknown }).path;
      const p = typeof raw === 'string' ? raw : '';
      if (!p || !this.lastEvidencePaths.has(p)) throw new Error('that file is not part of the last run');
      const ext = path.extname(p).toLowerCase();
      const mime = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : '';
      if (!mime) throw new Error('only screenshots can be fetched this way');
      let buf: Buffer;
      try {
        buf = fs.readFileSync(p);
      } catch {
        throw new Error('that file is no longer on disk');
      }
      return { name: path.basename(p), mime, dataBase64: buf.toString('base64') };
    });

    // vibe.bundle.get — A15: the whole of the last run's artifacts/<runId>/
    // folder (report.json + every screenshot) plus its replay clip, as ONE zip,
    // so "Send to my developer" is a single file rather than six downloads.
    // Scoped to that one directory: it is read by listing the run folder, never
    // by taking a path from the caller.
    this.bridge.onRequest('vibe.bundle.get', async (params, ctx) => {
      if (!this.bridge.isAuthenticated(ctx.clientId)) {
        throw new Error('vibe.bundle.get: unauthenticated client');
      }
      void params;
      const dir = this.lastRunDir;
      if (!dir) throw new Error('no test has finished yet');
      const entries: ZipEntry[] = [];
      const walk = (abs: string, rel: string): void => {
        let stat: fs.Stats;
        try {
          stat = fs.statSync(abs);
        } catch {
          return;
        }
        if (stat.isDirectory()) {
          for (const name of fs.readdirSync(abs)) walk(path.join(abs, name), rel ? `${rel}/${name}` : name);
          return;
        }
        try {
          entries.push({ path: rel, data: new Uint8Array(fs.readFileSync(abs)) });
        } catch {
          /* a file that vanished mid-zip is not worth failing the whole bundle for */
        }
      };
      walk(dir, '');
      // The clip lives outside the run folder, so it is added by hand.
      if (this.lastClipPath) {
        try {
          entries.push({ path: path.basename(this.lastClipPath), data: new Uint8Array(fs.readFileSync(this.lastClipPath)) });
        } catch {
          /* no clip on disk — the rest of the bundle still goes */
        }
      }
      if (!entries.length) throw new Error('that test left nothing to send');
      const zip = makeZip(entries);
      return {
        name: `spike-${path.basename(dir)}.zip`,
        mime: 'application/zip',
        dataBase64: Buffer.from(zip).toString('base64'),
      };
    });

    // vibe.tests.list — A19: the saved tests this machine has recorded, for the
    // panel's "Saved tests" card. Read-only: it loads the scripts already on
    // disk in generated-tests/ and reports what they are. `host` (the panel's
    // current-tab hostname) scopes the list to the site being looked at —
    // without it every saved test on the machine would be offered for a site
    // it was never recorded against. A malformed/hand-edited script is skipped
    // rather than failing the whole list.
    this.bridge.onRequest('vibe.tests.list', async (params) => {
      const rawHost = (params as { host?: unknown } | undefined)?.host;
      const host = typeof rawHost === 'string' ? rawHost.trim().toLowerCase() : '';
      const tests: Array<Record<string, unknown>> = [];
      for (const file of listScripts()) {
        let script;
        try {
          script = loadScript(file);
        } catch {
          continue; // a malformed script is not a reason to show the user nothing
        }
        let scriptHost = '';
        try {
          scriptHost = new URL(script.url).hostname.toLowerCase();
        } catch {
          /* a script with an unparseable url simply has no host to match */
        }
        if (host && scriptHost && scriptHost !== host && stripWww(scriptHost) !== stripWww(host)) continue;
        tests.push({
          name: script.name,
          task: script.task,
          url: script.url,
          host: scriptHost,
          createdAt: script.createdAt,
          steps: script.steps.length,
          ...(script.healedFrom && { repairedAt: script.healedFrom.healedAt }),
        });
      }
      tests.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      return { tests };
    });

    // vibe.replay — A19: re-run one saved test with no AI calls at all ($0),
    // optionally repairing it (heal) when the page has moved on. Same
    // single-run lock, the same progress/done/error events and the same
    // consent contract as vibe.run: the script's own site is trusted (it is
    // what was recorded), nothing else is.
    this.bridge.onRequest('vibe.replay', async (params, ctx) => {
      // A3: replaying drives the user's browser — and healing spends model
      // budget — so the same authentication gate as vibe.run applies.
      if (!this.bridge.isAuthenticated(ctx.clientId)) throw new Error('vibe.replay: unauthenticated client');
      if (this.busy) throw new Error('a run is already in progress');
      const name = String((params as { name?: unknown }).name ?? '').trim();
      if (!name) throw new Error('vibe.replay requires { name }');
      // the name addresses a file we wrote in generated-tests/ — never a path
      if (!/^[A-Za-z0-9._-]+$/.test(name) || name.includes('..')) throw new Error('vibe.replay: invalid test name');
      const heal = Boolean((params as { heal?: unknown }).heal);
      const rawTabId = (params as { tabId?: unknown }).tabId;
      const tabId = typeof rawTabId === 'number' ? rawTabId : undefined;
      this.busy = true;
      void this.executeReplay(name, heal, tabId, ctx?.clientId);
      return { accepted: true };
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

    // vibe.check.site — A24: the "Check this site" button's first half.
    //
    // Walks the site in the user's own Chrome (their sign-in comes along, and
    // a page that draws itself with JavaScript is seen as it really is), then
    // hands back the list of pages to look at and what to ask about each one.
    // The panel then runs them through the very machinery it already uses for
    // a document's flow list — one budgeted run per page, one verdict — so
    // there is no second runner and no second aggregation rule to disagree.
    //
    // Nothing is driven beyond the walk itself: the check is look-only, and
    // the pages open in a tab of their own rather than steering the tab the
    // user is reading.
    this.bridge.onRequest('vibe.check.site', async (params, ctx) => {
      if (!this.bridge.isAuthenticated(ctx.clientId)) throw new Error('vibe.check.site: unauthenticated client');
      if (this.busy) throw new Error('a test is already running');
      const url = String((params as { url?: unknown }).url ?? '');
      if (!url) throw new Error('vibe.check.site requires { url }');
      const rawMax = (params as { maxPages?: unknown }).maxPages;
      const maxPages = typeof rawMax === 'number' && Number.isFinite(rawMax) && rawMax > 0 ? Math.floor(rawMax) : DEFAULT_CHECK_PAGES;
      const target = ctx?.clientId !== undefined ? { clientId: ctx.clientId } : undefined;
      const progress = (line: string) => this.bridge.sendEvent('vibe.progress', { line }, target);

      this.busy = true;
      try {
        progress('Looking around your site…');
        // E7: `explore` comes from the panel's "allow click & type on this
        // site" switch. Absent (an older panel) → link-following only, exactly
        // as before.
        const explore = (params as { explore?: unknown }).explore === true;
        const model = await this.crawlSite(url, maxPages * 2, {
          explore,
          ...(ctx?.clientId !== undefined && { clientId: ctx.clientId }),
          onProgress: progress,
        });
        saveAppModel(model, process.cwd());
        const targets = checkTargets(model, url, maxPages);
        const everything = checkTargets(model, url, Number.MAX_SAFE_INTEGER);
        const cov = coverageReport(model);
        return {
          pages: targets.map((t) => ({ url: t.url, name: t.name, task: checkInstruction(t.url) })),
          controlsFound: cov.interactiveElements.total,
          capped: targets.length < everything.length,
          findings: model.findings ?? [],
        };
      } finally {
        this.busy = false;
      }
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

    // vibe.spec.decompose — A7: the panel's "Paste a document" mode. ONE call
    // to the model that plans turns a spec / PRD / story list into a short list
    // of independent flows; the panel then shows them as a checklist and runs
    // the ticked ones one after another as ordinary vibe.run calls. Nothing is
    // driven here — no Chrome, no artifacts, just the planning call — so this
    // deliberately does NOT take the single-run `busy` lock.
    this.bridge.onRequest('vibe.spec.decompose', async (params, ctx) => {
      // A3: same gate as vibe.run — decomposing spends model budget.
      if (!this.bridge.isAuthenticated(ctx.clientId)) {
        throw new Error('vibe.spec.decompose: unauthenticated client');
      }
      const spec = String((params as { spec?: unknown }).spec ?? '');
      const rawUrl = (params as { url?: unknown }).url;
      const url = typeof rawUrl === 'string' && rawUrl.trim() ? rawUrl.trim() : undefined;
      const rawMax = (params as { maxFlows?: unknown }).maxFlows;
      const maxFlows =
        typeof rawMax === 'number' && Number.isFinite(rawMax) ? Math.max(1, Math.floor(rawMax)) : undefined;
      const router = createPlanningRouter({});
      const flows = await decomposeSpec(spec, {
        planFlows: (prompt, schema, step) => router.planGoals(prompt, schema, step),
        url,
        maxFlows,
      });
      return { flows };
    });

    // vibe.config.get — the panel's settings screen reads the user's current
    // non-secret picks (planner / debug mode / debug agent) plus, per provider,
    // the transports it supports, the default models, and WHETHER a key is on
    // file. Key VALUES never cross the bridge — only presence (hasKey).
    this.bridge.onRequest('vibe.config.get', async () => {
      const settings = new SettingsStore().read();
      const vault = new Vault();
      // A11: probe PATH for claude/codex/gemini (cached process-wide by
      // detectFixAgent) so the panel can decide client-side whether to offer
      // auto-fix at all.
      const fixAgentAvailable = Boolean(await detectFixAgent());
      // A13: the panel used to echo the user's pin for the model that clicks,
      // which is a lie whenever that pin can't actually run here (no key, CLI
      // not installed, the on-device model on a machine that can't host it) —
      // the ladder quietly falls through to something else, often a paid
      // model, and nothing said so. Ask the router which adapter really leads
      // the per-step role. Never fatal: an unanswerable probe just omits it.
      let resolvedNavigatorName: string | undefined;
      try {
        resolvedNavigatorName = await createPlanningRouter({}).resolveLead('plan-step');
      } catch {
        resolvedNavigatorName = undefined;
      }
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
        // A13: same field (and same meaning) the browser-only path already
        // reports — what will ACTUALLY drive the per-step role.
        resolvedNavigatorName,
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
        // A11: the project folder auto-fix edits (empty = not chosen yet), and
        // whether a coding agent capable of applying a fix is actually
        // installed on this machine — the panel hides auto-fix outright when it
        // isn't, rather than offering a button that can only fail.
        fixAgentCwd: settings.fixAgentCwd ?? '',
        fixAgentAvailable,
        // A5: whether a test login has been saved. Presence only — the values
        // stay on this machine and never cross this connection.
        testLogin: {
          user: Boolean(vault.get('TEST_USER')),
          password: Boolean(vault.get('TEST_PASSWORD')),
        },
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
      // A11: the project folder auto-fix edits. Stored verbatim (trimmed) — it
      // is a path on the user's own machine, never interpolated into a shell
      // command (dispatchFix passes it to spawn as `cwd`, not as an argument).
      // Blank clears it, which puts auto-fix back into "ask me first".
      if (p.fixAgentCwd !== undefined) {
        const dir = String(p.fixAgentCwd).trim();
        patch.fixAgentCwd = dir || undefined;
      }
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

    // A5 (P0) — vibe.secret.set: store one test-login field (the username or
    // the password the panel's "Test login (optional)" card collected) in the
    // encrypted store on this machine. The value is referenced from a task as
    // {{secret:NAME}} and is only ever swapped in at the moment it is typed
    // into the page — no model, no report, no recorded test ever sees it.
    // Names are restricted to the two test-login fields; the value is never
    // echoed back, only its presence.
    this.bridge.onRequest('vibe.secret.set', async (params, ctx) => {
      if (!this.bridge.isAuthenticated(ctx.clientId)) throw new Error('vibe.secret.set: unauthenticated client');
      const p = (params ?? {}) as { name?: unknown; value?: unknown };
      const name = requireTestLoginSecretName('vibe.secret.set', p.name);
      const value = typeof p.value === 'string' ? p.value : '';
      if (!value) throw new Error(`vibe.secret.set: a non-empty { value } is required for ${name}`);
      new Vault().set(name, value);
      return { ok: true, name };
    });

    // vibe.secret.clear — forget one test-login field. `cleared:false` means
    // there was nothing stored under that name.
    this.bridge.onRequest('vibe.secret.clear', async (params, ctx) => {
      if (!this.bridge.isAuthenticated(ctx.clientId)) throw new Error('vibe.secret.clear: unauthenticated client');
      const p = (params ?? {}) as { name?: unknown };
      const name = requireTestLoginSecretName('vibe.secret.clear', p.name);
      const cleared = new Vault().delete(name);
      return { ok: true, name, cleared };
    });
  }

  /** A19: re-run one saved test deterministically — no AI calls, so free —
   * streaming the same progress/done/error events a fresh run does, so the
   * panel renders the result card it already knows how to render. `heal`
   * re-engages the driver on the original task when the replay fails and
   * re-emits the script (that part DOES spend model budget, which is why the
   * panel calls it "Repair" and keeps it a separate button). */
  /** A24: walk a site in the user's attached Chrome. Opens a tab of its own
   * (the user's cookies still apply — they are the profile's, not the tab's)
   * so the page they are reading is never steered out from under them. */
  private async crawlSite(url: string, maxPages: number, opts: { explore: boolean; clientId?: number; onProgress?: (line: string) => void }): Promise<AppModel> {
    const clientId = opts.clientId;
    const session = await openBrowserSession(
      { via: 'extension' as const },
      { bridge: this.bridge, ...(clientId !== undefined && { clientId }) },
    );
    try {
      return await discoverApp({
        baseUrl: url,
        fetcher: browserFetcher(session.browser, { sameOrigin: new URL(url).origin }),
        previousModel: loadAppModel(process.cwd()),
        crawl: { maxPages },
        // E7: the walk itself only follows links. When the user has allowed
        // clicking on this site, a small capped pass afterwards also opens
        // pop-ups, tabs and "show more" sections so what is behind them is in
        // the map — and therefore gets checked — too.
        ...explorationOptions({
          enabled: opts.explore,
          browser: session.browser,
          planner: createPlanningRouter({}),
          allowedOrigin: new URL(url).origin,
          ...(opts.onProgress && { onProgress: opts.onProgress }),
        }),
      });
    } finally {
      await session.close().catch(() => {});
    }
  }

  private async executeReplay(name: string, heal: boolean, tabId?: number, clientId?: number): Promise<void> {
    const controller = new AbortController();
    this.activeRun = controller;
    this.activeRunTabId = typeof tabId === 'number' ? tabId : null;
    this.detachAbortMessage = null;
    const target = clientId !== undefined ? { clientId } : undefined;
    const progress = (line: string) => this.bridge.sendEvent('vibe.progress', { line }, target);
    try {
      const opts: QaReplayOptions = {
        heal,
        bridge: this.bridge,
        ...(tabId !== undefined && { tabId }),
        ...(clientId !== undefined && { clientId }),
        config: { via: 'extension' as const },
        onProgress: progress,
      };
      const report = await qaReplay(name, opts);
      if (this.detachAbortMessage) {
        this.bridge.sendEvent('vibe.error', { message: this.detachAbortMessage }, target);
        return;
      }
      this.lastFailedReport = report.verdict === 'pass' ? null : report;
      this.lastEvidencePaths = new Set(report.evidence_paths ?? []);
      this.lastRunDir = report.evidence_paths?.[0] ? path.dirname(report.evidence_paths[0]) : null;
      this.bridge.sendEvent('vibe.done', {
        ...slimReport(report),
        plainReport: renderPlainReport(report),
        reasonExplained: explainReason(report.reason),
        screenshotPath: headlineScreenshot(report),
        fixPrompt: buildFixPrompt(report, { screenshotDataUri: fixPromptThumbnail(report) }),
        durationMs: report.durationMs,
        // the panel labels a saved-test result differently from a fresh AI pass
        // — it cost nothing, and "Repair" is the follow-up, not "fix my code".
        savedTest: name,
        ...(report.healed ? { repaired: true } : {}),
      }, target);
    } catch (e) {
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

  private async execute(
    task: string,
    url: string,
    tabId?: number,
    allowHost?: string,
    clientId?: number,
    readOnly?: boolean,
    /** A14: extra sites already consented to for this one. Only applied when
     * `allowHost` is present — they widen a consented run, never a look-only one. */
    extraHosts: string[] = [],
    /** A25: reuse (and refresh) this site's remembered sign-in. */
    rememberLogin = false,
    /** A17: what the user said must be true once the test is done, in their own
     * words. Absent → the run is the general page check it always was. */
    expectations?: string,
  ): Promise<void> {
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
      // A1 (P0): look-only mode for THIS run comes from the panel's checkbox,
      // not from the stored setting — the switch the user can see is the one
      // that decides. Omitted → no override, so the stored/env value stands.
      const config = {
        via: 'extension' as const,
        ...(allowHost && { allowedHosts: [...loadConfig().allowedHosts, allowHost, ...extraHosts] }),
        ...(readOnly !== undefined && { readOnly }),
      };
      // A25: the remembered sign-in for THIS site. Loading it only when the file
      // is already there means the first run signs in normally and saves the
      // result; every later one starts already signed in. The save half is
      // engine-side and only fires on a PASS, so a half-logged-in failure never
      // overwrites a good state.
      let loginStatePath: string | undefined;
      if (rememberLogin) {
        try {
          loginStatePath = savedLoginPath(new URL(url).host);
        } catch {
          /* an unparseable url has no site to remember a login for */
        }
      }
      const haveSavedLogin = Boolean(loginStatePath && fs.existsSync(loginStatePath));
      if (loginStatePath) {
        progress(
          haveSavedLogin
            ? 'Using the sign-in remembered for this site.'
            : 'If this test signs in and passes, the sign-in will be remembered for this site.',
        );
      }
      const runOpts = {
        bridge: this.bridge,
        tabId,
        clientId,
        config,
        ...(haveSavedLogin && { storageStatePath: loginStatePath }),
        ...(loginStatePath && { saveStorageStatePath: loginStatePath }),
        trustTargetHost: Boolean(allowHost),
        // A19: a passing panel run becomes a saved test, exactly as a run
        // started from a terminal does. Without this the panel could only ever
        // pay for a fresh AI pass — it consumed saved tests (the pre-run
        // matcher) but never produced one.
        record: true,
        // A17: the user's own success sentence, proved against the page.
        ...(expectations && { expectations }),
        onProgress: progress,
        onStep: (info) => this.bridge.sendEvent('vibe.step', info as unknown as Record<string, unknown>, target),
        signal: controller.signal,
      } as QaRunOptions & { signal?: AbortSignal };
      this.lastRerun = { task, url, runOpts: { ...runOpts, signal: undefined } as QaRunOptions };
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
        // A15: exactly this run's files become fetchable, and the previous
        // run's stop being so.
        this.lastEvidencePaths = new Set(report.evidence_paths ?? []);
        // evidence_paths[0] is report.json inside artifacts/<runId>/ — its
        // folder is the whole of what this run produced.
        this.lastRunDir = report.evidence_paths?.[0] ? path.dirname(report.evidence_paths[0]) : null;
        this.bridge.sendEvent('vibe.done', {
          ...slimReport(report),
          plainReport: renderPlainReport(report),
          // A14: the panel can't import the translation table (it's a plain
          // page script), so the verdict card is handed the already-translated
          // headline / attribution / next step. Null when the table doesn't
          // know this reason — the panel then shows the raw text, as before.
          reasonExplained: explainReason(report.reason),
          // A15: which picture the result card should show — the failing step's
          // when there is one, otherwise the final frame. The panel asks for the
          // bytes separately (vibe.artifact.get) so a passing run's payload
          // doesn't carry a megabyte of base64 nobody looks at.
          screenshotPath: headlineScreenshot(report),
          fixPrompt: buildFixPrompt(report, { screenshotDataUri: fixPromptThumbnail(report) }),
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

  private async dispatch(report: Report, clientId?: number, confirmed?: boolean, maxAttempts = 2): Promise<void> {
    const target = clientId !== undefined ? { clientId } : undefined;
    const onProgress = (line: string) => this.bridge.sendEvent('vibe.fix-progress', { line }, target);
    try {
      const rerun = this.lastRerun;
      if (rerun) {
        // A6: the SAME loop as `spike run --fix` — dispatch, wait for the change
        // to show up, re-run — capped by maxAttempts, and the panel is told what
        // the re-test said.
        this.busy = true;
        const controller = new AbortController();
        this.activeRun = controller;
        let dispatchFailure: string | undefined;
        const loopProgress = (line: string) => {
          const m = /fix dispatch failed: (.*)$/.exec(line);
          if (m) dispatchFailure = m[1];
          onProgress(line);
        };
        try {
          const result = await runWithAutoFix(rerun.task, rerun.url, {
            maxAttempts: Math.max(2, maxAttempts),
            initialReport: report as never,
            qaRunOpts: { ...rerun.runOpts, signal: controller.signal } as QaRunOptions,
            runFn: this.fixLoopOverrides.runFn ?? qaRun,
            ...(this.fixLoopOverrides.dispatchFn && { dispatchFn: this.fixLoopOverrides.dispatchFn }),
            ...(this.fixLoopOverrides.rebuild && { rebuild: this.fixLoopOverrides.rebuild }),
            onProgress: loopProgress,
            confirmed,
            // A11: no terminal behind a bridge request — see the comment below.
            interactive: false,
          });
          const final = result.finalReport;
          this.lastFailedReport = final.verdict === 'pass' ? null : final;
          this.lastEvidencePaths = new Set(final.evidence_paths ?? []);
          this.lastRunDir = final.evidence_paths?.[0] ? path.dirname(final.evidence_paths[0]) : null;
          const fixed = result.attempts.some((a) => a.fixed);
          this.bridge.sendEvent('vibe.fix-done', {
            ok: fixed,
            verdict: final.verdict,
            attempts: result.attempts.length,
            ...(result.rebuildNote && { note: result.rebuildNote }),
            ...(!fixed && { message: dispatchFailure ?? 'The coding agent could not be started, so nothing was changed.' }),
          }, target);
        } finally {
          this.busy = false;
          this.activeRun = null;
        }
        return;
      }
      const res = await dispatchFix(report, {
        onProgress,
        confirmed,
        // A11: the request came over the bridge, so there is no terminal to ask
        // in — force the non-interactive branch of the consent gate regardless
        // of whether the process that happens to host the helper has a TTY.
        interactive: false,
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
