import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Report } from '../report/report.js';
import { isSafeRunId, listRunSummaries } from '../report/run-store.js';
import { layout, renderRunDetail, renderRunsTable } from './pages.js';

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

/** Start the dashboard and resolve once it is listening. Binds loopback unless a host is given. */
export function startDashboard(artifactsDir: string, port: number, opts: DashboardOptions = {}): Promise<http.Server> {
  const host = opts.host ?? DASHBOARD_DEFAULT_HOST;
  const token = opts.token ?? crypto.randomBytes(24).toString('hex');
  const server = http.createServer((req, res) => {
    try {
      const bound = server.address() as AddressInfo | null;
      const allowed = allowedHostHeaders(bound?.port ?? port, host);
      if (allowed !== 'any' && !allowed.has(String(req.headers.host ?? '').toLowerCase())) {
        send(res, 403, 'text/plain', 'forbidden: unexpected Host header');
        return;
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        send(res, 405, 'text/plain', 'method not allowed');
        return;
      }
      if (url.pathname === '/api/ping') {
        send(res, 200, 'application/json', JSON.stringify({ spike: 'home' }));
        return;
      }
      if (url.pathname === '/') {
        send(res, 200, 'text/html; charset=utf-8', layout('Home', renderRunsTable(listRunSummaries(artifactsDir), artifactsDir), { token, active: 'home' }));
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
        send(res, 200, 'text/html; charset=utf-8', layout(report.runId, renderRunDetail(report), { token, active: 'home' }));
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
