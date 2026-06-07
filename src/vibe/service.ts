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
 *
 * Events emitted (via bridge.sendEvent):
 *   vibe.progress {line}
 *   vibe.done     {verdict, reason, console_error, failing_step, evidence_paths,
 *                  plainReport, fixPrompt, durationMs}
 *   vibe.error    {message}
 *
 * Single-run invariant: only one QA run at a time (one attached Chrome, one tab).
 * A second vibe.run while busy is rejected with an error result, not queued. */

import type { BridgeServer } from '../bridge/bridge-server.js';
import { qaRun } from '../engine.js';
import { slimReport } from '../report/report.js';
import { renderPlainReport, buildFixPrompt } from './fix-prompt.js';

export class VibeService {
  private busy = false;

  constructor(private readonly bridge: BridgeServer) {}

  start(): void {
    this.bridge.onRequest('vibe.status', async () => ({ busy: this.busy }));
    this.bridge.onRequest('vibe.run', async (params) => {
      if (this.busy) throw new Error('a run is already in progress');
      const task = String((params as { task?: unknown }).task ?? '');
      const url = String((params as { url?: unknown }).url ?? '');
      if (!task || !url) throw new Error('vibe.run requires { task, url }');
      this.busy = true;
      // Fire-and-forget the actual run; the request returns immediately.
      void this.execute(task, url);
      return { accepted: true };
    });
  }

  private async execute(task: string, url: string): Promise<void> {
    try {
      const report = await qaRun(task, url, {
        bridge: this.bridge,
        config: { via: 'extension' },
        record: false,
        onProgress: (line) => this.bridge.sendEvent('vibe.progress', { line }),
      });
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
    }
  }
}
