/* A10: the switches for saved tests — list, quarantine/release, and heal
 * review (accept/reject a quarantined heal candidate). Pure file logic with an
 * explicit `root`/`artifactsDir` so tests run against a temp dir; cli.ts only
 * prints. Quarantine bookkeeping lives in engine.ts (`addToQuarantine` …) —
 * this module calls those functions, never re-implements them. */

import fs from 'node:fs';
import path from 'node:path';
import { addToQuarantine, isQuarantined, loadQuarantineList, removeFromQuarantine } from '../engine.js';
import { listRunSummaries } from '../report/run-store.js';
import { classifyHeal, type HealTier } from './heal-policy.js';
import { diffScripts, listScripts, loadScript, saveScript, scriptsDir, type QaScript } from './script.js';

export interface SavedTestRow {
  name: string;
  task: string;
  url: string;
  steps: number;
  quarantined: boolean;
  quarantineReason?: string;
  /** Verdict of the newest run matching this test's task+url; absent when none is on disk. */
  lastResult?: string;
  lastRunId?: string;
  hasHealCandidate: boolean;
}

function newestRunFor(script: QaScript, artifactsDir: string): { verdict: string; runId: string } | undefined {
  const runs = listRunSummaries(artifactsDir)
    .filter((r) => r.runId === script.sourceRunId || (r.task === script.task && r.url === script.url))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return runs[0] && { verdict: runs[0].verdict, runId: runs[0].runId };
}

export function candidatePath(name: string, root = process.cwd()): string {
  return path.join(scriptsDir(root), `${name}.candidate.json`);
}

export function listSavedTests(root = process.cwd(), artifactsDir = path.join(root, 'artifacts')): SavedTestRow[] {
  const q = new Map(loadQuarantineList(root).map((e) => [e.name, e]));
  const rows: SavedTestRow[] = [];
  for (const file of listScripts(root)) {
    let script: QaScript;
    try {
      script = loadScript(file, root);
    } catch {
      continue; // an invalid script is `replay`'s problem to report, not the list's
    }
    const last = newestRunFor(script, artifactsDir);
    rows.push({
      name: script.name,
      task: script.task,
      url: script.url,
      steps: script.steps.length,
      quarantined: q.has(script.name),
      quarantineReason: q.get(script.name)?.reason,
      lastResult: last?.verdict,
      lastRunId: last?.runId,
      hasHealCandidate: fs.existsSync(candidatePath(script.name, root)),
    });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/** Both throw when no saved test has this name, so a typo can't silently
 * "quarantine" nothing. */
export function quarantineTest(name: string, reason: string | undefined, root = process.cwd()): void {
  const s = loadScript(name, root);
  addToQuarantine(s.name, reason, root);
}

export function releaseTest(name: string, root = process.cwd()): boolean {
  const s = loadScript(name, root);
  const was = isQuarantined(s.name, root);
  removeFromQuarantine(s.name, root);
  return was;
}

export interface HealCandidateView {
  name: string;
  tier: HealTier;
  reasons: string[];
  /** One line per changed step, old → new. */
  changes: string;
  evidencePaths: string[];
  candidatePath: string;
}

function readCandidate(p: string): QaScript {
  return JSON.parse(fs.readFileSync(p, 'utf8')) as QaScript;
}

export function listHealCandidates(root = process.cwd(), artifactsDir = path.join(root, 'artifacts')): HealCandidateView[] {
  const dir = scriptsDir(root);
  if (!fs.existsSync(dir)) return [];
  const out: HealCandidateView[] = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.candidate.json')).sort()) {
    const p = path.join(dir, f);
    try {
      const cand = readCandidate(p);
      const old = loadScript(cand.name, root);
      const { tier, reasons } = classifyHeal(old, cand);
      const runId = cand.healedFrom?.runId;
      const evidence = runId ? [path.join(artifactsDir, runId, 'report.json')].filter((e) => fs.existsSync(e)) : [];
      out.push({ name: cand.name, tier, reasons, changes: diffScripts(old, cand), evidencePaths: evidence, candidatePath: p });
    } catch {
      /* unreadable candidate — skip, never break the review list */
    }
  }
  return out;
}

/** Applies the candidate over the script (re-emitting the .spec.ts twin) and
 * removes the candidate file. Quarantine is a flake decision, separate from a
 * heal decision, so it is left as is. */
export function acceptHeal(name: string, root = process.cwd()): { jsonPath: string; specPath: string } {
  const p = candidatePath(name, root);
  if (!fs.existsSync(p)) throw new Error(`no heal candidate waiting for "${name}"`);
  const paths = saveScript(readCandidate(p), root);
  fs.unlinkSync(p);
  return paths;
}

/** Discards the candidate; the saved test is not touched. */
export function rejectHeal(name: string, root = process.cwd()): void {
  const p = candidatePath(name, root);
  if (!fs.existsSync(p)) throw new Error(`no heal candidate waiting for "${name}"`);
  fs.unlinkSync(p);
}
