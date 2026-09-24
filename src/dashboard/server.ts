import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { headlineScreenshot, type Report } from '../report/report.js';

/* ---------------------------------------------------------------------------
 * `spike dashboard` — a read-only, $0, no-backend localhost view over
 * artifacts/<runId>/report.json files. Hand-rolled HTML (no template engine,
 * no client-side JS, no external fonts/scripts — the CLI has zero non-Node
 * dependencies for this and it stays that way). Never mutates artifacts/. */

export interface DashboardRunSummary {
  runId: string;
  task: string;
  url: string;
  verdict: string;
  durationMs: number;
  steps: number;
  tokenEstimate: number;
  navigatorCalls?: number;
  brainCalls?: number;
  visualCalls?: number;
  actionCache?: Report['action_cache'];
  replayMatch?: { name: string; score: number };
  healed?: boolean;
  mtimeMs: number;
}

/** Only alphanumerics/-/_ — ArtifactStore mints runIds from an ISO timestamp
 * + a short random suffix, so this also doubles as a path-traversal guard on
 * the `/run/:id` route (the id comes straight off the URL). */
const SAFE_RUN_ID = /^[A-Za-z0-9_-]+$/;

export function listDashboardRuns(artifactsDir: string): DashboardRunSummary[] {
  if (!fs.existsSync(artifactsDir)) return [];
  const runs: DashboardRunSummary[] = [];
  for (const entry of fs.readdirSync(artifactsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !SAFE_RUN_ID.test(entry.name)) continue;
    const reportPath = path.join(artifactsDir, entry.name, 'report.json');
    try {
      const stat = fs.statSync(reportPath);
      const r = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as Report & { replayMatch?: { name: string; score: number }; healed?: boolean };
      runs.push({
        runId: r.runId ?? entry.name,
        task: r.task ?? '',
        url: r.url ?? '',
        verdict: r.verdict ?? 'uncertain',
        durationMs: r.durationMs ?? 0,
        steps: Array.isArray(r.steps) ? r.steps.length : 0,
        tokenEstimate: r.tokenEstimate ?? 0,
        navigatorCalls: r.tokens?.navigatorCalls,
        brainCalls: r.tokens?.brainCalls,
        visualCalls: r.tokens?.visualCalls,
        actionCache: r.action_cache,
        replayMatch: r.replayMatch,
        healed: r.healed,
        mtimeMs: stat.mtimeMs,
      });
    } catch {
      /* missing/corrupt report.json — skip, never break the whole dashboard */
    }
  }
  return runs.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

const DASHBOARD_STYLE = `
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

function verdictClass(v: string): string {
  return v === 'pass' ? 'pass' : v === 'fail' ? 'fail' : 'uncertain';
}

function renderDashboardIndex(runs: DashboardRunSummary[], artifactsDir: string): string {
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
  return `<!doctype html><html><head><meta charset="utf-8"><title>spike dashboard</title><style>${DASHBOARD_STYLE}</style></head><body>
    <h1>Spike — run dashboard</h1>
    <div class="sub">${runs.length} run(s) in ${escapeHtml(artifactsDir)} — read-only, local only, no external calls</div>
    <table>
      <tr><th>run</th><th>verdict</th><th>task</th><th>url</th><th>steps</th><th>duration</th><th>source</th></tr>
      ${rows || '<tr><td colspan="7">no runs yet — \`spike run\` writes one here on completion</td></tr>'}
    </table>
  </body></html>`;
}

function renderDashboardRun(report: Report & { replayMatch?: { name: string; score: number }; healed?: boolean }): string {
  const t = report.tokens;
  const stats = [
    ['verdict', report.verdict],
    ['duration', `${(report.durationMs / 1000).toFixed(1)}s`],
    ['steps', String(report.steps?.length ?? 0)],
    ['verdict payload (tokens)', String(report.tokenEstimate ?? 0)],
    ['navigator calls', String(t?.navigatorCalls ?? 0)],
    ['brain calls', String(t?.brainCalls ?? 0)],
    ['visual calls', String(t?.visualCalls ?? 0)],
    ['cheap model total', String(t?.cheapModelTotal ?? 0)],
  ];
  const statHtml = stats.map(([l, n]) => `<div class="stat"><div class="n">${escapeHtml(n)}</div><div class="l">${escapeHtml(l)}</div></div>`).join('');

  const source = report.replayMatch
    ? `matched $0 replay: <code>${escapeHtml(report.replayMatch.name)}</code> (score ${report.replayMatch.score.toFixed(2)})`
    : report.healed !== undefined
      ? `self-heal: ${report.healed ? 'succeeded' : 'failed'}`
      : 'fresh AI run';

  const cache = report.action_cache
    ? `<p>action cache: ${report.action_cache.enabled ? `hits ${report.action_cache.hits}, misses ${report.action_cache.misses}, stale ${report.action_cache.stale}, stored ${report.action_cache.stored}` : 'disabled'}</p>`
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

  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(report.runId)} — spike dashboard</title><style>${DASHBOARD_STYLE}</style></head><body>
    <a class="back" href="/">&larr; all runs</a>
    <h1 class="${verdictClass(report.verdict)}">${escapeHtml(report.runId)} — ${escapeHtml(report.verdict)}</h1>
    <div class="sub">${escapeHtml(report.task)}<br>${escapeHtml(report.url)}<br>${source}</div>
    <div class="grid">${statHtml}</div>
    ${cache}
    <h2>model_trace</h2>
    <table><tr><th>step</th><th>capability</th><th>rung</th><th>adapter</th><th>latency</th><th>note</th></tr>${traceRows || '<tr><td colspan="6">(empty — deterministic replay, no planner calls)</td></tr>'}</table>
    ${report.assertion_trace ? `<h2>assertion_trace</h2><table><tr><th>step</th><th>policy</th><th>verdict</th><th>disagreement</th><th>summary</th></tr>${assertionRows}</table>` : ''}
    ${shotHtml}
    <h2>steps</h2>
    <table><tr><th>#</th><th>ok</th><th>description</th><th>error</th></tr>${stepRows}</table>
    <h2>reason</h2>
    <pre>${escapeHtml(report.reason)}</pre>
  </body></html>`;
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
      return `<h2>screenshot</h2><div class="sub">${escapeHtml(caption)} — too large to inline: ${escapeHtml(p)}</div>`;
    }
    const b64 = fs.readFileSync(p).toString('base64');
    return (
      `<h2>screenshot</h2><div class="sub">${escapeHtml(caption)}</div>` +
      `<img src="data:image/png;base64,${b64}" alt="${escapeHtml(caption)}" ` +
      'style="max-width:100%;border:1px solid #232838;border-radius:6px;display:block;margin-top:8px" />'
    );
  } catch {
    return '';
  }
}

export interface DashboardOptions {
  /** Interface to bind. Default loopback: past reports include screenshots of logged-in pages. */
  host?: string;
}

export const DASHBOARD_DEFAULT_HOST = '127.0.0.1';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host) || /^127\./.test(host);
}

/** Start the dashboard and resolve once it is listening. Binds loopback unless a host is given. */
export function startDashboard(artifactsDir: string, port: number, opts: DashboardOptions = {}): Promise<http.Server> {
  const host = opts.host ?? DASHBOARD_DEFAULT_HOST;
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(renderDashboardIndex(listDashboardRuns(artifactsDir), artifactsDir));
        return;
      }
      const m = url.pathname.match(/^\/run\/([^/]+)$/);
      if (m) {
        const runId = decodeURIComponent(m[1]);
        if (!SAFE_RUN_ID.test(runId)) {
          res.writeHead(400, { 'content-type': 'text/plain' });
          res.end('invalid run id');
          return;
        }
        const reportPath = path.join(artifactsDir, runId, 'report.json');
        if (!fs.existsSync(reportPath)) {
          res.writeHead(404, { 'content-type': 'text/plain' });
          res.end(`no report.json for run ${runId}`);
          return;
        }
        const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as Report;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(renderDashboardRun(report));
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(e instanceof Error ? e.message : String(e));
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

