/* Shared reader for past runs under artifacts/<runId>/report.json — used by the
 * dashboard and the MCP `runs_list` / `run_get` tools so both agree on what a
 * valid run id is and how the folder is listed (A4). */

import fs from 'node:fs';
import path from 'node:path';
import type { Report } from './report.js';
import { redactTaskText } from './redact.js';

/** Only alphanumerics/-/_ — ArtifactStore mints runIds from an ISO timestamp
 * + a short random suffix, so this also doubles as a path-traversal guard
 * wherever an id arrives from outside (URL path, MCP tool input). */
export const SAFE_RUN_ID = /^[A-Za-z0-9_-]+$/;

export function isSafeRunId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= 200 && SAFE_RUN_ID.test(id);
}

export interface RunListEntry {
  runId: string;
  /** ISO timestamp of the report file. */
  when: string;
  url: string;
  /** Already redacted — a password typed into a task never leaves the machine. */
  task: string;
  verdict: Report['verdict'];
  mtimeMs: number;
}

/** Every readable run, newest first. A missing/corrupt report is skipped. */
export function listRuns(artifactsDir: string, limit = Number.MAX_SAFE_INTEGER): RunListEntry[] {
  if (!fs.existsSync(artifactsDir)) return [];
  const out: RunListEntry[] = [];
  for (const entry of fs.readdirSync(artifactsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !SAFE_RUN_ID.test(entry.name)) continue;
    const reportPath = path.join(artifactsDir, entry.name, 'report.json');
    try {
      const stat = fs.statSync(reportPath);
      const r = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as Partial<Report>;
      out.push({
        runId: r.runId ?? entry.name,
        when: new Date(stat.mtimeMs).toISOString(),
        url: r.url ?? '',
        task: redactTaskText(r.task ?? ''),
        verdict: r.verdict ?? 'uncertain',
        mtimeMs: stat.mtimeMs,
      });
    } catch {
      /* skip */
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.slice(0, limit);
}

/** The full report for one run, or undefined when the id is unsafe/unknown. */
export function loadRunReport(artifactsDir: string, runId: string): Report | undefined {
  if (!isSafeRunId(runId)) return undefined;
  const p = path.join(artifactsDir, runId, 'report.json');
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as Report;
  } catch {
    return undefined;
  }
}
