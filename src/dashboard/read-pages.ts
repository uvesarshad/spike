import type { AppModel } from '../discovery/app-model.js';
import { coverageReport } from '../discovery/coverage.js';
import { formatUsd } from '../orchestrator/budget.js';
import type { HealCandidateView, SavedTestRow } from '../recorder/tests-admin.js';
import { isDue, nextDue } from '../schedule/when.js';
import { spentInWindow, type Job } from '../schedule/store.js';
import type { DetectedAgent } from '../setup/detect.js';
import { escapeHtml, verdictClass } from './pages.js';

/* The Tests / Site / Schedules / Setup pages of Spike home (A12). Pure
 * renderers over already-gathered data (the server gathers it from tests-admin,
 * the app model, the job store and the setup detector), so each page is
 * testable against an empty and a populated fixture dir. Vocabulary follows
 * 26-09-12 audit section 1.5 — no "daemon", "navigator", "brain", "BYOK". */

const pct = (r: number): string => `${Math.round(r * 100)}%`;
const table = (head: string[], rows: string[], empty: string): string =>
  `<table><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr>${rows.join('\n') || `<tr><td colspan="${head.length}">${empty}</td></tr>`}</table>`;

/* ---- Tests ------------------------------------------------------------ */

export interface TestsData {
  tests: SavedTestRow[];
  candidates: HealCandidateView[];
}

export function renderTestsPage(d: TestsData, actions: boolean): string {
  const rows = d.tests.map((t) => {
    const status = t.lastResult ? `<span class="${verdictClass(t.lastResult)}">${escapeHtml(t.lastResult)}</span>` : '<span class="note">not run yet</span>';
    const flags = [t.quarantined ? `<span class="pill">parked${t.quarantineReason ? `: ${escapeHtml(t.quarantineReason)}` : ''}</span>` : '', t.hasHealCandidate ? '<span class="pill">change waiting for review</span>' : ''].join('');
    const btn = actions
      ? t.quarantined
        ? `<button data-act="release" data-name="${escapeHtml(t.name)}">Count again</button>`
        : `<button data-act="quarantine" data-name="${escapeHtml(t.name)}">Park (flaky)</button>`
      : '';
    return `<tr><td>${escapeHtml(t.name)}</td><td>${escapeHtml(t.task).slice(0, 80)}</td><td>${escapeHtml(t.url)}</td><td>${t.steps}</td><td>${status}${t.lastRunId ? ` <a href="/run/${encodeURIComponent(t.lastRunId)}">details</a>` : ''}</td><td>${flags}</td><td>${btn}</td></tr>`;
  });
  const heals = d.candidates.map((c) => {
    const btn = actions ? `<button data-act="accept-heal" data-name="${escapeHtml(c.name)}">Accept change</button><button data-act="reject-heal" data-name="${escapeHtml(c.name)}">Reject</button>` : '';
    return `<div class="box"><b>${escapeHtml(c.name)}</b> <span class="pill">${escapeHtml(c.tier)}</span>
      ${c.reasons.map((r) => `<div class="note">why it was held back: ${escapeHtml(r)}</div>`).join('')}
      <pre>${escapeHtml(c.changes)}</pre>${btn}</div>`;
  });
  return `<h1>Saved tests</h1>
    <div class="sub">${d.tests.length} saved test(s) — each replays for $0, with no AI calls</div>
    ${actions && d.tests.length ? '<p><button id="run-all">Run all saved tests</button><span id="run-all-note" class="note"></span></p>' : ''}
    ${table(['name', 'what it checks', 'site', 'steps', 'last result', 'notes', ''], rows, 'no saved tests yet — a passing run is saved automatically')}
    <h2>Changes waiting for your review</h2>
    <div class="sub">When a saved test stops matching the page, Spike proposes a repaired version and keeps the old one until you accept.</div>
    ${heals.join('') || '<p class="note">Nothing waiting.</p>'}`;
}

/* ---- Site ------------------------------------------------------------- */

export function renderSitePage(model: AppModel | null): string {
  if (!model) {
    return `<h1>Your site</h1><p class="note">Spike has not looked at your site yet. Run <code>spike map &lt;your site address&gt;</code> to walk it and see what is on each page.</p>`;
  }
  const cov = coverageReport(model);
  const findings = model.findings ?? [];
  const problems = findings.filter((f) => f.severity === 'problem');
  const warnings = findings.filter((f) => f.severity !== 'problem');
  const frows = [...problems, ...warnings].slice(0, 50).map((f) => `<tr><td class="${f.severity === 'problem' ? 'fail' : 'uncertain'}">${f.severity === 'problem' ? 'broken' : 'worth a look'}</td><td>${escapeHtml(f.route)}</td><td>${escapeHtml(f.detail)}</td></tr>`);
  const untested = model.routes.filter((r) => !r.exercised).slice(0, 50).map((r) => `<tr><td>${escapeHtml(r.route)}</td><td>${r.source === 'run' ? 'reached during a test' : 'found on the site'}</td></tr>`);
  return `<h1>Your site</h1>
    <div class="sub">${escapeHtml(model.baseUrl ?? '')} — last looked at ${escapeHtml(model.generatedAt)}</div>
    <div class="grid">
      <div class="stat"><div class="n">${cov.routes.total}</div><div class="l">pages found</div></div>
      <div class="stat"><div class="n">${pct(cov.routes.ratio)}</div><div class="l">pages tested</div></div>
      <div class="stat"><div class="n">${pct(cov.interactiveElements.ratio)}</div><div class="l">buttons and fields tested</div></div>
      <div class="stat"><div class="n">${problems.length}</div><div class="l">broken pages</div></div>
    </div>
    <h2>Last check</h2>
    ${table(['', 'page', 'what happened'], frows, 'nothing broken in the last check')}
    <h2>Pages not tested yet</h2>
    <div class="sub">To see which pages are new or changed since the last look, run <code>spike map &lt;address&gt; --diff</code>.</div>
    ${table(['page', 'how Spike knows about it'], untested, 'every page has been tested')}`;
}

/* ---- Schedules -------------------------------------------------------- */

export function renderSchedulesPage(jobs: Job[], now: number, defaultBudgetUsd: number | undefined, actions: boolean): string {
  const rows = jobs.map((j) => {
    let next = '?';
    try { next = isDue(j, now) ? 'due now' : new Date(nextDue(j, now)).toLocaleString(); } catch { /* keep ? */ }
    const cap = j.budgetUsd ?? defaultBudgetUsd;
    const spend = `${formatUsd(spentInWindow(j, now))} of ${cap !== undefined ? formatUsd(cap) : 'no limit'}`;
    const btn = actions ? `<button data-act="run-now" data-id="${escapeHtml(j.id)}">Run now</button><button data-act="remove-job" data-id="${escapeHtml(j.id)}">Remove</button>` : '';
    return `<tr><td>${escapeHtml(j.id)}</td><td>${escapeHtml(j.when)}</td><td>${escapeHtml(j.kind + (j.target ? `: ${j.target}` : ''))}</td><td>${escapeHtml(j.url)}</td><td>${j.lastVerdict ? `<span class="${verdictClass(j.lastVerdict)}">${j.lastVerdict}</span>${j.lastRunId ? ` <a href="/run/${encodeURIComponent(j.lastRunId)}">details</a>` : ''}` : '<span class="note">never run</span>'}</td><td>${escapeHtml(next)}</td><td>${escapeHtml(spend)}</td><td>${btn}</td></tr>`;
  });
  return `<h1>Scheduled tests</h1>
    <div class="sub">Scheduled tests run while Spike Core (the optional desktop helper) is running. The spend column is the last 24 hours against the limit.</div>
    ${table(['id', 'when', 'what', 'site', 'last result', 'next', 'spent / limit', ''], rows, 'nothing scheduled — add one with <code>spike schedule add</code>')}`;
}

/* ---- Setup ------------------------------------------------------------ */

export interface SetupData {
  agents: DetectedAgent[];
  /** Plain-words description of the model that clicks / the model that plans. */
  clicker: string;
  planner: string;
  /** AI providers a key is present for — names only, never values. */
  keysPresent: string[];
  /** Spike Core (the optional desktop helper) is running — true when Spike home is served by it. */
  helperRunning: boolean;
}

const AGENT_NAMES: Record<string, string> = { claude: 'Claude Code', cursor: 'Cursor', windsurf: 'Windsurf', codex: 'Codex', gemini: 'Gemini / Antigravity CLI' };

export function renderSetupPage(d: SetupData): string {
  const agentRows = d.agents.map((a) => `<tr><td>${escapeHtml(AGENT_NAMES[a.agent] ?? a.agent)}</td><td>${a.installed ? '<span class="pass">found</span>' : '<span class="note">not found</span>'}</td></tr>`);
  return `<h1>Setup</h1>
    <h2>Coding assistants on this computer</h2>
    <div class="sub">Run <code>spike setup</code> to connect the ones marked found, so they can ask Spike to check their changes.</div>
    ${table(['assistant', 'status'], agentRows, 'none checked')}
    <h2>Which AI does what</h2>
    ${table(['job', 'model'], [`<tr><td>Clicks through your site, step by step</td><td>${escapeHtml(d.clicker)}</td></tr>`, `<tr><td>Plans the test and makes the tough calls</td><td>${escapeHtml(d.planner)}</td></tr>`], '')}
    <h2>Your AI keys</h2>
    <div class="sub">Only whether a key exists is shown — never the key itself.</div>
    ${d.keysPresent.length ? `<p>${d.keysPresent.map((k) => `<span class="pill">${escapeHtml(k)}</span>`).join('')}</p>` : '<p class="note">No AI key found. Spike can still use a coding-assistant login you already have.</p>'}
    <h2>Spike Core</h2>
    <p>${d.helperRunning ? '<span class="pass">running</span> — scheduled tests and saved-login replays work.' : '<span class="uncertain">not running here</span> — start it with <code>spike daemon</code> to run scheduled tests.'}</p>`;
}
