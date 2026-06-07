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

import type { BridgeServer } from '../bridge/bridge-server.js';
import { qaRun, type QaRunOptions } from '../engine.js';
import { slimReport, type Report } from '../report/report.js';
import { renderPlainReport, buildFixPrompt } from './fix-prompt.js';
import { dispatchFix } from './auto-fix.js';

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
    try {
      // The engine agent is adding QaRunOptions.signal; until that lands the
      // structural cast keeps this typechecking. TODO: drop the cast once
      // QaRunOptions.signal is declared.
      const runOpts = {
        bridge: this.bridge,
        tabId,
        config: { via: 'extension' as const },
        record: false,
        onProgress: (line: string) => this.bridge.sendEvent('vibe.progress', { line }),
        onStep: (info) => this.bridge.sendEvent('vibe.step', info),
        signal: controller.signal,
      } as QaRunOptions & { signal?: AbortSignal };
      const report = await qaRun(task, url, runOpts);
      // Stash a failure so the panel can offer "fix it"; clear on success.
      this.lastFailedReport = report.verdict === 'pass' ? null : report;
      this.bridge.sendEvent('vibe.done', {
        ...slimReport(report),
        plainReport: renderPlainReport(report),
        fixPrompt: buildFixPrompt(report),
        durationMs: report.durationMs,
      });
    } catch (e) {
      this.bridge.sendEvent('vibe.error', {
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      this.busy = false;
      this.activeRun = null;
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
