/* Artifacts on disk: artifacts/<runId>/report.json + screenshots/step-NN.png +
 * audit.log (one JSON line per executed action — Tier-4 audit trail). */

import fs from 'node:fs';
import path from 'node:path';
import type { Report } from './report.js';
import { redactTaskText } from './redact.js';

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

  async saveScreenshot(stepIndex: number, png: Buffer): Promise<string> {
    const p = path.join(this.dir, 'screenshots', `step-${String(stepIndex).padStart(2, '0')}.png`);
    await fs.promises.writeFile(p, png);
    return p;
  }

  /** A5 (P0): the task is the one string a person writes by hand, so it is the
   * one place a credential can still arrive in the clear ("log in with
   * me@x.com / hunter2"). The live prompts keep the original — the model needs
   * it to log in — but the copy that lands on disk does not. */
  async saveReport(report: Report): Promise<string> {
    const p = path.join(this.dir, 'report.json');
    const safe: Report = { ...report, task: redactTaskText(report.task) };
    await fs.promises.writeFile(p, JSON.stringify(safe, null, 2));
    return p;
  }

  /** Append one JSON line per EXECUTED action. Caller must pass redacted values
   * (placeholders, never resolved secrets). */
  async appendAudit(entry: AuditEntry): Promise<void> {
    await fs.promises.appendFile(path.join(this.dir, 'audit.log'), JSON.stringify(entry) + '\n');
  }
}
