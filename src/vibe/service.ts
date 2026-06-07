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

/** Shape of the extension's rec.start / rec.stop bridge responses. */
interface RecStartResult { ok: boolean; reason?: string; mime?: string }
interface RecStopResult { ok: boolean; reason?: string; webmBase64?: string; bytes?: number; mime?: string }

export class VibeService {
  private busy = false;
  /** The last failed Report — the source for vibe.fix's dispatch. Cleared on a
   * passing run (nothing to fix) so vibe.fix can't re-dispatch a stale failure. */
  private lastFailedReport: Report | null = null;
  /** Guards against overlapping fix dispatches. */
  private fixing = false;
  /** Aborts the active qaRun (vibe.cancel). Null when no run is in flight. */
  private activeRun: AbortController | null = null;

  constructor(private readonly bridge: BridgeServer) {}

  start(): void {
    this.bridge.onRequest('vibe.status', async () => ({ busy: this.busy }));
    this.bridge.onRequest('vibe.run', async (params) => {
      if (this.busy) throw new Error('a run is already in progress');
      const task = String((params as { task?: unknown }).task ?? '');
      const url = String((params as { url?: unknown }).url ?? '');
      // tabId (the panel's current tab) is optional — absent → create-a-tab path.
      const rawTabId = (params as { tabId?: unknown }).tabId;
      const tabId = typeof rawTabId === 'number' ? rawTabId : undefined;
      if (!task || !url) throw new Error('vibe.run requires { task, url }');
      this.busy = true;
      // Fire-and-forget the actual run; the request returns immediately.
      void this.execute(task, url, tabId);
      return { accepted: true };
    });

    // vibe.fix — hand the last failed run's fix prompt to a CLI coding agent.
    this.bridge.onRequest('vibe.fix', async () => {
      if (!this.lastFailedReport) throw new Error('vibe.fix: no failed run to fix yet');
      if (this.fixing) throw new Error('vibe.fix: a fix is already in progress');
      this.fixing = true;
      const report = this.lastFailedReport;
      void this.dispatch(report);
      return { accepted: true };
    });

    // vibe.cancel — abort the in-flight run.
    this.bridge.onRequest('vibe.cancel', async () => {
      if (!this.activeRun) return { cancelled: false };
      this.activeRun.abort();
      return { cancelled: true };
    });
  }

  private async execute(task: string, url: string, tabId?: number): Promise<void> {
    const controller = new AbortController();
    this.activeRun = controller;
    const progress = (line: string) => this.bridge.sendEvent('vibe.progress', { line });

    // Replay recording brackets the run. Only attempt it on REAL panel runs
    // (tabId present): tabCapture needs the extension to have been invoked on a
    // real tab — there's no clip for the create-a-tab/test path. Every recorder
    // call is failure-tolerant; the clip is a nice-to-have, never a run blocker.
    let recording = false;
    if (typeof tabId === 'number') {
      try {
        const start = await this.bridge.call<RecStartResult>('rec.start', { tabId }, 20_000);
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
      const runOpts = {
        bridge: this.bridge,
        tabId,
        config: { via: 'extension' as const },
        record: false,
        onProgress: progress,
        onStep: (info) => this.bridge.sendEvent('vibe.step', info),
        signal: controller.signal,
      } as QaRunOptions & { signal?: AbortSignal };
      const report = await qaRun(task, url, runOpts);

      // Stop recording and persist the webm (failure-tolerant — a missing clip
      // never changes the verdict). Keyed by the report's runId so it lands
      // alongside report.json + screenshots.
      const clipPath = recording ? await this.stopAndSaveClip(report.runId, progress) : undefined;

      // Stash a failure so the panel can offer "fix it"; clear on success.
      this.lastFailedReport = report.verdict === 'pass' ? null : report;
      this.bridge.sendEvent('vibe.done', {
        ...slimReport(report),
        plainReport: renderPlainReport(report),
        fixPrompt: buildFixPrompt(report),
        durationMs: report.durationMs,
        ...(clipPath ? { clipPath } : {}),
      });
    } catch (e) {
      // A run failure must not leave a recorder running in the offscreen doc.
      if (recording) { try { await this.bridge.call('rec.stop', {}, 25_000); } catch { /* best effort */ } }
      this.bridge.sendEvent('vibe.error', {
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      this.busy = false;
      this.activeRun = null;
    }
  }

  /** Stop the extension recorder, decode the webm, write artifacts/<runId>/replay.webm.
   * Returns the path on success, undefined otherwise. Never throws. */
  private async stopAndSaveClip(runId: string, progress: (line: string) => void): Promise<string | undefined> {
    try {
      const stop = await this.bridge.call<RecStopResult>('rec.stop', {}, 30_000);
      if (!stop || !stop.ok || !stop.webmBase64) {
        progress(`clip unavailable: ${stop?.reason ?? 'recorder returned no data'}`);
        return undefined;
      }
      const buf = Buffer.from(stop.webmBase64, 'base64');
      // sanity: webm/Matroska EBML magic 0x1A45DFA3
      if (buf.length < 4 || !(buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3)) {
        progress('clip unavailable: recorded bytes are not a valid webm');
        return undefined;
      }
      const dir = path.join(loadConfig({}).artifactsDir, runId);
      fs.mkdirSync(dir, { recursive: true });
      const clipPath = path.join(dir, 'replay.webm');
      fs.writeFileSync(clipPath, buf);
      progress(`replay clip: ${clipPath} (${Math.round(buf.length / 1024)} KB)`);
      return clipPath;
    } catch (e) {
      progress(`clip unavailable: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
  }

  private async dispatch(report: Report): Promise<void> {
    try {
      const res = await dispatchFix(report, {
        onProgress: (line) => this.bridge.sendEvent('vibe.fix-progress', { line }),
      });
      this.bridge.sendEvent('vibe.fix-done', { ok: res.ok, agent: res.agent });
    } catch (e) {
      this.bridge.sendEvent('vibe.fix-done', {
        ok: false,
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      this.fixing = false;
    }
  }
}
