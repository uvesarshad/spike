/* BrowserArtifactStore — LITE-mode replacement for src/report/artifacts.ts.
 * Same PUBLIC surface the driver loop calls (runId, dir, saveScreenshot,
 * saveReport, appendAudit) so it is structurally assignable wherever the engine
 * expects an ArtifactStore — loop.ts and the report types are untouched.
 *
 * There is no filesystem in a service worker, so everything lives in memory:
 * screenshots as base64 strings, the latest Report, an audit array. exportBundle()
 * hands the panel what it needs to offer a "download report.json + screenshots"
 * affordance. Screenshots are session-only (never persisted to chrome.storage —
 * a single full-page PNG is ~2.7 MB, far past the 10 MB quota). */

import type { Report } from '../report/report.js';
import type { AuditEntry } from '../report/artifacts.js'; // type-only → no fs bundled

export interface ArtifactBundle {
  runId: string;
  reportJson: string;
  screenshots: { name: string; base64: string }[];
  audit: AuditEntry[];
}

export class BrowserArtifactStore {
  readonly runId: string;
  readonly dir: string;
  /** synthetic path → base64 PNG (download-only, in memory for this session). */
  private readonly screenshots = new Map<string, string>();
  private report: Report | null = null;
  private readonly audit: AuditEntry[] = [];

  constructor() {
    // Same id scheme as ArtifactStore (ISO timestamp + random suffix).
    this.runId =
      new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19) +
      '-' +
      Math.random().toString(36).slice(2, 6);
    this.dir = `artifacts/${this.runId}`;
  }

  /** The returned path string only flows into report.evidence_paths/screenshot
   * fields — it is never opened by the engine, so a synthetic path is fine. */
  saveScreenshot(stepIndex: number, png: Buffer): string {
    const name = `screenshots/step-${String(stepIndex).padStart(2, '0')}.png`;
    this.screenshots.set(name, png.toString('base64'));
    return `${this.dir}/${name}`;
  }

  saveReport(report: Report): string {
    this.report = report;
    return `${this.dir}/report.json`;
  }

  /** Append one entry per executed action (already redacted by the caller). */
  appendAudit(entry: AuditEntry): void {
    this.audit.push(entry);
  }

  /** Everything the panel needs to offer downloads (report.json + screenshots). */
  exportBundle(): ArtifactBundle {
    return {
      runId: this.runId,
      reportJson: this.report ? JSON.stringify(this.report, null, 2) : '{}',
      screenshots: [...this.screenshots].map(([name, base64]) => ({ name, base64 })),
      audit: this.audit,
    };
  }
}
