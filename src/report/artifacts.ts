/* Artifacts on disk: artifacts/<runId>/report.json + screenshots/step-NN.png */

import fs from 'node:fs';
import path from 'node:path';
import type { Report } from './report.js';

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
}
