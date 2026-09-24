/* A1 — the run dashboard binds loopback by default, never every interface.
 * Past reports include screenshots of logged-in pages. Port 0, temp dir, no Chrome. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { startDashboard, isLoopbackHost, listDashboardRuns, dashboardReachable } from '../src/dashboard/server.js';

let failed = 0;
function check(name: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failed++;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spike-dash-'));
fs.mkdirSync(path.join(dir, 'run-1'));
fs.writeFileSync(path.join(dir, 'run-1', 'report.json'), JSON.stringify({ runId: 'run-1', task: 't', url: 'u', verdict: 'pass', steps: [] }));

const server = await startDashboard(dir, 0);
try {
  const addr = server.address() as AddressInfo;
  check('default bind is 127.0.0.1', addr.address === '127.0.0.1');
  const res = await fetch(`http://127.0.0.1:${addr.port}/`);
  check('index served over loopback', res.status === 200 && (await res.text()).includes('run-1'));
} finally {
  server.close();
}
check('listDashboardRuns finds the run', listDashboardRuns(dir).length === 1);
check('loopback detection', isLoopbackHost('127.0.0.1') && isLoopbackHost('::1') && !isLoopbackHost('0.0.0.0') && !isLoopbackHost('192.168.1.5'));
fs.rmSync(dir, { recursive: true, force: true });

// A12: Host guard (DNS rebinding) — a foreign Host header is refused.
const server2 = await startDashboard(dir, 0);
try {
  const port = (server2.address() as AddressInfo).port;
  const status = (hostHeader: string) =>
    new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/', headers: { Host: hostHeader } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
  check('bad Host header -> 403', (await status('evil.example.com')) === 403);
  check('bad Host with right name, wrong port -> 403', (await status('localhost:1')) === 403);
  check('localhost:<port> -> 200', (await status(`localhost:${port}`)) === 200);
  check('dashboardReachable finds it', await dashboardReachable(port));
} finally {
  server2.close();
}
check('dashboardReachable false on a dead port', !(await dashboardReachable(1, 200)));
process.exit(failed ? 1 : 0);
