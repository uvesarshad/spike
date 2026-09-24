import fs from 'node:fs';
import { headlineScreenshot, type Report } from '../report/report.js';
import type { RunSummary } from '../report/run-store.js';

/* Hand-rolled HTML for Spike home (A12): no template engine, no framework, no
 * external requests. Copy follows the vocabulary rules in
 * docs/plan/26-09-12-audit-usability-autonomy.md section 1.5. */

export function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

export const DASHBOARD_STYLE = `
  nav { margin-bottom: 18px; } nav a { margin-right: 14px; text-decoration: none; padding-bottom: 2px; } nav a.on { border-bottom: 2px solid #7cb7ff; }
  button { font: inherit; background: #1c2131; color: #e6e8ee; border: 1px solid #2c3350; border-radius: 6px; padding: 4px 10px; cursor: pointer; margin-right: 6px; }
  button:hover { background: #262d45; }
  input[type=text], input[type=url] { font: inherit; background: #12151e; color: #e6e8ee; border: 1px solid #232838; border-radius: 6px; padding: 5px 8px; min-width: 260px; }
  .note { color: #8b93a7; font-size: 12px; } .box { background: #12151e; border-radius: 8px; padding: 12px; margin: 12px 0; }

  body { font: 14px/1.5 -apple-system, Segoe UI, sans-serif; margin: 0; padding: 24px; background: #0b0d12; color: #e6e8ee; }
  a { color: #7cb7ff; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: #8b93a7; margin-bottom: 20px; font-size: 12px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #232838; font-size: 13px; vertical-align: top; }
  th { color: #8b93a7; font-weight: 600; text-transform: uppercase; font-size: 11px; letter-spacing: 0.04em; }
  tr:hover td { background: #12151e; }
  .pass { color: #5fd08a; font-weight: 600; }
  .fail { color: #f27878; font-weight: 600; }
  .uncertain { color: #e6c15c; font-weight: 600; }
  .pill { display: inline-block; padding: 1px 6px; border-radius: 10px; background: #1c2131; font-size: 11px; margin-right: 4px; }
  code, pre { font: 12px/1.5 ui-monospace, Consolas, monospace; }
  pre { background: #12151e; padding: 10px; border-radius: 6px; overflow: auto; white-space: pre-wrap; word-break: break-word; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; margin: 12px 0 20px; }
  .stat { background: #12151e; border-radius: 8px; padding: 10px 12px; }
  .stat .n { font-size: 20px; font-weight: 700; }
  .stat .l { color: #8b93a7; font-size: 11px; text-transform: uppercase; }
  .back { display: inline-block; margin-bottom: 14px; }
`;

export function verdictClass(v: string): string {
  return v === 'pass' ? 'pass' : v === 'fail' ? 'fail' : 'uncertain';
}

/** The runs table (body only — `layout()` wraps it). */
export function renderRunsTable(runs: RunSummary[], artifactsDir: string): string {
  const rows = runs
    .map((r) => {
      const source = r.replayMatch
        ? `<span class="pill">$0 replay (${(r.replayMatch.score * 100).toFixed(0)}%)</span>`
        : r.healed
          ? '<span class="pill">healed</span>'
          : '<span class="pill">AI run</span>';
      const cache = r.actionCache?.enabled ? `<span class="pill">cache ${r.actionCache.hits}/${r.actionCache.hits + r.actionCache.misses}</span>` : '';
      return `<tr>
        <td><a href="/run/${encodeURIComponent(r.runId)}">${escapeHtml(r.runId)}</a></td>
        <td class="${verdictClass(r.verdict)}">${escapeHtml(r.verdict)}</td>
        <td>${escapeHtml(r.task).slice(0, 90)}</td>
        <td>${escapeHtml(r.url)}</td>
        <td>${r.steps}</td>
        <td>${(r.durationMs / 1000).toFixed(1)}s</td>
        <td>${source}${cache}</td>
      </tr>`;
    })
    .join('\n');
  return `<h1>Your test runs</h1>
    <div class="sub">${runs.length} run(s) in ${escapeHtml(artifactsDir)} — stays on this computer, no outside requests</div>
    <table>
      <tr><th>run</th><th>result</th><th>what was tested</th><th>site</th><th>steps</th><th>time</th><th>how</th></tr>
      ${rows || '<tr><td colspan="7">no runs yet — running a test writes one here when it finishes</td></tr>'}
    </table>`;
}

/** One run's detail (body only — `layout()` wraps it). */
export function renderRunDetail(report: Report & { replayMatch?: { name: string; score: number }; healed?: boolean }): string {
  const t = report.tokens;
  const stats = [
    ['verdict', report.verdict],
    ['duration', `${(report.durationMs / 1000).toFixed(1)}s`],
    ['steps', String(report.steps?.length ?? 0)],
    ['verdict payload (tokens)', String(report.tokenEstimate ?? 0)],
    ['clicking-model calls', String(t?.navigatorCalls ?? 0)],
    ['planning-model calls', String(t?.brainCalls ?? 0)],
    ['visual calls', String(t?.visualCalls ?? 0)],
    ['cheap-model total', String(t?.cheapModelTotal ?? 0)],
  ];
  const statHtml = stats.map(([l, n]) => `<div class="stat"><div class="n">${escapeHtml(n)}</div><div class="l">${escapeHtml(l)}</div></div>`).join('');

  const source = report.replayMatch
    ? `matched a saved test ($0): <code>${escapeHtml(report.replayMatch.name)}</code> (score ${report.replayMatch.score.toFixed(2)})`
    : report.healed !== undefined
      ? `auto-repair: ${report.healed ? 'succeeded' : 'failed'}`
      : 'fresh run';

  const cache = report.action_cache
    ? `<p>shortcut cache: ${report.action_cache.enabled ? `hits ${report.action_cache.hits}, misses ${report.action_cache.misses}, stale ${report.action_cache.stale}, stored ${report.action_cache.stored}` : 'disabled'}</p>`
    : '';

  const traceRows = (report.model_trace ?? [])
    .map((m) => `<tr><td>${m.step}</td><td>${escapeHtml(m.capability)}</td><td>${m.rung}</td><td>${escapeHtml(m.adapter)}</td><td>${m.ms}ms</td><td>${escapeHtml(m.note ?? '')}</td></tr>`)
    .join('\n');

  const assertionRows = (report.assertion_trace ?? [])
    .map((a) => `<tr><td>${a.step}</td><td>${escapeHtml(a.policy)}</td><td class="${verdictClass(a.verdict)}">${escapeHtml(a.verdict)}</td><td>${a.disagreement ? 'yes' : 'no'}</td><td>${escapeHtml(a.summary).slice(0, 120)}</td></tr>`)
    .join('\n');

  const stepRows = (report.steps ?? [])
    .map((s) => `<tr><td>${s.index}</td><td>${s.ok ? 'ok' : 'FAIL'}</td><td>${escapeHtml(s.description)}</td><td>${escapeHtml(s.error ?? '')}</td></tr>`)
    .join('\n');

  // A15 (P1): the dashboard showed model traces and step tables but never a
  // picture, even though the run had already taken one of the exact moment it
  // broke. Inlined as a data URI so the server stays a single read-only route
  // with no static-file handler and no path off the report's own evidence list.
  const shotHtml = dashboardScreenshotHtml(report);

  return `    <a class="back" href="/">&larr; all runs</a>
    <h1 class="${verdictClass(report.verdict)}">${escapeHtml(report.runId)} — ${escapeHtml(report.verdict)}</h1>
    <div class="sub">${escapeHtml(report.task)}<br>${escapeHtml(report.url)}<br>${source}</div>
    <div class="grid">${statHtml}</div>
    ${cache}
    <h2>Which models were asked</h2>
    <table><tr><th>step</th><th>job</th><th>tier</th><th>model</th><th>latency</th><th>note</th></tr>${traceRows || '<tr><td colspan="6">(empty — deterministic replay, no planner calls)</td></tr>'}</table>
    ${report.assertion_trace ? `<h2>Checks the page had to pass</h2><table><tr><th>step</th><th>policy</th><th>verdict</th><th>disagreement</th><th>summary</th></tr>${assertionRows}</table>` : ''}
    ${shotHtml}
    <h2>What it did</h2>
    <table><tr><th>#</th><th>ok</th><th>description</th><th>error</th></tr>${stepRows}</table>
    <h2>Why</h2>
    <pre>${escapeHtml(report.reason)}</pre>`;
}

/** A15: the failing step's screenshot (or, on a pass, the final frame) as an
 * inline <img>, or '' when there isn't one / it can't be read. Capped so a
 * multi-megabyte full-page PNG doesn't make the page unusable — past the cap
 * the filename is named instead, which is useful here because the reader is
 * already on the machine holding the file. */
const DASHBOARD_MAX_IMAGE_BYTES = 3 * 1024 * 1024;

function dashboardScreenshotHtml(report: Report): string {
  const p = headlineScreenshot(report);
  if (!p) return '';
  const failed = report.verdict !== 'pass';
  const caption = failed ? 'The page where it broke' : 'How the page looked at the end';
  try {
    if (fs.statSync(p).size > DASHBOARD_MAX_IMAGE_BYTES) {
      return `<h2>Screenshot</h2><div class="sub">${escapeHtml(caption)} — too large to inline: ${escapeHtml(p)}</div>`;
    }
    const b64 = fs.readFileSync(p).toString('base64');
    return (
      `<h2>Screenshot</h2><div class="sub">${escapeHtml(caption)}</div>` +
      `<img src="data:image/png;base64,${b64}" alt="${escapeHtml(caption)}" ` +
      'style="max-width:100%;border:1px solid #232838;border-radius:6px;display:block;margin-top:8px" />'
    );
  } catch {
    return '';
  }
}


export interface LayoutCtx {
  /** Per-process token every POST must echo (A12). */
  token: string;
  active?: 'home' | 'tests' | 'site' | 'schedules' | 'setup';
}

const NAV: Array<[NonNullable<LayoutCtx['active']>, string, string]> = [
  ['home', '/', 'Home'],
  ['tests', '/tests', 'Tests'],
  ['site', '/site', 'Site'],
  ['schedules', '/schedules', 'Schedules'],
  ['setup', '/setup', 'Setup'],
];

export const DASHBOARD_SCRIPT = `
const TOKEN = document.querySelector('meta[name=spike-token]').content;
async function spikePost(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-spike-token': TOKEN }, body: JSON.stringify(body || {}) });
  let j = {}; try { j = await r.json(); } catch (e) {}
  if (!r.ok) throw new Error(j.error || ('request failed (' + r.status + ')'));
  return j;
}
`;

export function layout(title: string, body: string, ctx: LayoutCtx): string {
  const nav = NAV.map(([k, href, label]) => `<a href="${href}"${ctx.active === k ? ' class="on"' : ''}>${label}</a>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="spike-token" content="${escapeHtml(ctx.token)}"><title>${escapeHtml(title)} — Spike</title><style>${DASHBOARD_STYLE}</style></head><body>
    <nav>${nav}</nav>
    ${body}
    <script>${DASHBOARD_SCRIPT}</script>
  </body></html>`;
}
