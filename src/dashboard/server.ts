import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Report } from '../report/report.js';
import { isSafeRunId, listRunSummaries } from '../report/run-store.js';
import { loadAppModel } from '../discovery/app-model.js';
import { listHealCandidates, listSavedTests } from '../recorder/tests-admin.js';
import { JobStore } from '../schedule/store.js';
import { buildFixPrompt } from '../vibe/fix-prompt.js';
import { Activity, ActionError, defaultActions, realCliRunner, type CliRunner, type DashboardActions } from './actions.js';
import { layout, renderRunDetail, renderRunsTable, renderTestSomething } from './pages.js';
import { renderSchedulesPage, renderSetupPage, renderSitePage, renderTestsPage, type SetupData } from './read-pages.js';
import { realSetupData } from './setup-info.js';

/* ---------------------------------------------------------------------------
 * Spike home (A12) — a $0, no-backend localhost page over artifacts/<runId>
 * reports. Hand-rolled HTML, no framework, no external requests. Served by
 * `spike daemon` on 127.0.0.1:9420, or standalone by `spike dashboard`.
 *
 * Guards (an actionable page on localhost is a remote-control surface):
 *  - binds loopback by default (A1);
 *  - every request's Host header must be 127.0.0.1:<port> / localhost:<port>
 *    (DNS-rebinding guard) — 403 otherwise;
 *  - every POST also needs this process's random token (embedded in each page
 *    it serves) in `x-spike-token` — 403 otherwise. */

/** Kept as the old name: a dashboard listing IS the shared run-store listing. */
export const listDashboardRuns = listRunSummaries;
export type { RunSummary as DashboardRunSummary } from '../report/run-store.js';

export interface DashboardOptions {
  /** Interface to bind. Default loopback: past reports include screenshots of logged-in pages. */
  host?: string;
  /** Per-process POST token; random by default. */
  token?: string;
  /** Project folder holding generated-tests/ and .spike/ (default: cwd). */
  root?: string;
  /** Scheduled-job store (default: the real ~/.spike one). */
  jobStore?: Pick<JobStore, 'list' | 'get' | 'remove'>;
  /** Cap for a job with no limit of its own (config unattendedBudgetUsd). */
  defaultBudgetUsd?: number;
  /** Setup page data (default: detect agents / read config / list key names). */
  setup?: () => SetupData;
  /** Override any action (tests inject stubs; the defaults do the real work). */
  actions?: Partial<DashboardActions>;
  /** Path of the `spike` CLI entry — lets the page start runs as child processes. Without it, run buttons say "use the command line". */
  cliPath?: string;
  /** Test seam: replaces the child-process runner. */
  cli?: CliRunner;
  /** True when Spike Core is the one serving this page (default false). */
  helperRunning?: boolean;
}

export const DASHBOARD_DEFAULT_HOST = '127.0.0.1';
export const DASHBOARD_DEFAULT_PORT = 9420;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host) || /^127\./.test(host);
}

/** Host header values this server answers to for a given bound port. */
export function allowedHostHeaders(port: number, boundHost: string): Set<string> | 'any' {
  if (boundHost === '0.0.0.0' || boundHost === '::') return 'any'; // explicit wildcard bind: the user was warned
  const set = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  if (!isLoopbackHost(boundHost)) set.add(`${boundHost}:${port}`);
  return set;
}

function send(res: http.ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

/** The paste-ready fix prompt, or '' when an old/hand-made report can't produce one — never a 500. */
function safeFixPrompt(report: Report): string {
  try { return buildFixPrompt(report); } catch { return ''; }
}

/** Start the dashboard and resolve once it is listening. Binds loopback unless a host is given. */
export function startDashboard(artifactsDir: string, port: number, opts: DashboardOptions = {}): Promise<http.Server> {
  const host = opts.host ?? DASHBOARD_DEFAULT_HOST;
  const root = opts.root ?? process.cwd();
  const jobStore = opts.jobStore ?? new JobStore();
  const setup = opts.setup ?? (() => realSetupData(opts.helperRunning ?? false));
  const activity = new Activity();
  const cli = opts.cli ?? (opts.cliPath ? realCliRunner(opts.cliPath, root) : undefined);
  const actions: DashboardActions = { ...defaultActions({ root, artifactsDir, jobStore: jobStore as JobStore, defaultBudgetUsd: opts.defaultBudgetUsd, activity, cli, cliPath: opts.cliPath }), ...opts.actions };
  const token = opts.token ?? crypto.randomBytes(24).toString('hex');
  const json = (res: http.ServerResponse, status: number, body: unknown): void => send(res, status, 'application/json', JSON.stringify(body));
  async function handlePost(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<void> {
    try {
      const sent = String(req.headers['x-spike-token'] ?? '');
      const a = Buffer.from(sent), b = Buffer.from(token);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return json(res, 403, { error: 'forbidden: missing or wrong token' });
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return json(res, 415, { error: 'expected JSON' });
      const m = pathname.match(/^\/api\/([a-z-]+)$/);
      const handler = m && Object.hasOwn(actions, m[1]) ? actions[m[1] as keyof DashboardActions] : undefined;
      if (!handler) return json(res, 404, { error: 'unknown action' });
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 1_000_000) return json(res, 413, { error: 'too large' });
      }
      let body: Record<string, unknown> = {};
      try { body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}; } catch { return json(res, 400, { error: 'invalid JSON' }); }
      json(res, 200, await (handler as (b: Record<string, unknown>) => unknown)(body));
    } catch (e) {
      json(res, e instanceof ActionError ? e.status : 400, { error: e instanceof Error ? e.message : String(e) });
    }
  }
  const server = http.createServer((req, res) => {
    try {
      const bound = server.address() as AddressInfo | null;
      const allowed = allowedHostHeaders(bound?.port ?? port, host);
      if (allowed !== 'any' && !allowed.has(String(req.headers.host ?? '').toLowerCase())) {
        send(res, 403, 'text/plain', 'forbidden: unexpected Host header');
        return;
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'POST') {
        void handlePost(req, res, url.pathname);
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        send(res, 405, 'text/plain', 'method not allowed');
        return;
      }
      if (url.pathname === '/api/activity') {
        send(res, 200, 'application/json', JSON.stringify({ activity: activity.list() }));
        return;
      }
      if (url.pathname === '/api/ping') {
        send(res, 200, 'application/json', JSON.stringify({ spike: 'home' }));
        return;
      }
      if (url.pathname === '/') {
        send(res, 200, 'text/html; charset=utf-8', layout('Home', renderTestSomething() + renderRunsTable(listRunSummaries(artifactsDir), artifactsDir), { token, active: 'home' }));
        return;
      }
      const page = (title: string, active: 'tests' | 'site' | 'schedules' | 'setup', body: string): void =>
        send(res, 200, 'text/html; charset=utf-8', layout(title, body, { token, active }));
      if (url.pathname === '/tests') {
        page('Tests', 'tests', renderTestsPage({ tests: listSavedTests(root, artifactsDir), candidates: listHealCandidates(root, artifactsDir) }, true));
        return;
      }
      if (url.pathname === '/site') {
        page('Site', 'site', renderSitePage(loadAppModel(root)));
        return;
      }
      if (url.pathname === '/schedules') {
        page('Schedules', 'schedules', renderSchedulesPage(jobStore.list(), Date.now(), opts.defaultBudgetUsd, true));
        return;
      }
      if (url.pathname === '/setup') {
        page('Setup', 'setup', renderSetupPage(setup()));
        return;
      }
      const m = url.pathname.match(/^\/run\/([^/]+)$/);
      if (m) {
        const runId = decodeURIComponent(m[1]);
        if (!isSafeRunId(runId)) {
          send(res, 400, 'text/plain', 'invalid run id');
          return;
        }
        const reportPath = path.join(artifactsDir, runId, 'report.json');
        if (!fs.existsSync(reportPath)) {
          send(res, 404, 'text/plain', `no report.json for run ${runId}`);
          return;
        }
        const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as Report;
        send(res, 200, 'text/html; charset=utf-8', layout(report.runId, renderRunDetail(report, safeFixPrompt(report)), { token, active: 'home' }));
        return;
      }
      send(res, 404, 'text/plain', 'not found');
    } catch (e) {
      send(res, 500, 'text/plain', e instanceof Error ? e.message : String(e));
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

/** True when Spike home answers on this port (used by `spike` and run results). */
export async function dashboardReachable(port: number = DASHBOARD_DEFAULT_PORT, timeoutMs = 400): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok && ((await r.json()) as { spike?: string }).spike === 'home';
  } catch {
    return false;
  }
}
