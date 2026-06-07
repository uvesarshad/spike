/* Artifacts on disk: artifacts/<runId>/report.json + screenshots/step-NN.png +
 * audit.log (one JSON line per executed action — Tier-4 audit trail). */

import fs from 'node:fs';
import path from 'node:path';
import type { Report } from './report.js';

/** One line in audit.log. Values are already REDACTED by the caller: target
 * carries placeholders (e.g. {{secret:NAME}}), never resolved secret values. */
export interface AuditEntry {
  ts: number;
  runId: string;
  /** Action type executed (click | type | navigate | …). */
  action: string;
  /** Role+name or url of the touched node, redacted. Optional for typeless actions. */
  target?: string;
  url: string;
  ok: boolean;
}

export class ArtifactStore {
  readonly runId: string;
  readonly dir: string;

  constructor(artifactsRoot: string) {
    this.runId =
      new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19) +
      '-' +
      Math.random().toString(36).slice(2, 6);
    this.dir = path.join(artifactsRoot, this.runId);
    fs.mkdirSync(path.join(this.dir, 'screenshots'), { recursive: true });
  }

  saveScreenshot(stepIndex: number, png: Buffer): string {
    const p = path.join(this.dir, 'screenshots', `step-${String(stepIndex).padStart(2, '0')}.png`);
    fs.writeFileSync(p, png);
    return p;
  }

  saveReport(report: Report): string {
    const p = path.join(this.dir, 'report.json');
    fs.writeFileSync(p, JSON.stringify(report, null, 2));
    return p;
  }

  /** Append one JSON line per EXECUTED action. Caller must pass redacted values
   * (placeholders, never resolved secrets). */
  appendAudit(entry: AuditEntry): void {
    fs.appendFileSync(path.join(this.dir, 'audit.log'), JSON.stringify(entry) + '\n');
  }
}
