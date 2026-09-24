/* A12 — Spike home actions: POST without the token -> 403, with it -> the handler
 * runs. Direct actions run against a temp project; runs use a stubbed CLI runner
 * (nothing is spawned). Port 0 on loopback. */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { startDashboard } from '../src/dashboard/server.js';
import { JobStore } from '../src/schedule/store.js';

let failed = 0;
function check(name: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failed++;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spike-a12a-'));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spike-a12ah-'));
const artifacts = path.join(root, 'artifacts');
fs.mkdirSync(path.join(artifacts, 'run-1'), { recursive: true });
fs.writeFileSync(path.join(artifacts, 'run-1', 'report.json'), JSON.stringify({ runId: 'run-1', task: 'look around', url: 'https://x.example/', verdict: 'fail', reason: 'button broke', steps: [], evidence_paths: [] }));
const scripts = path.join(root, 'generated-tests');
fs.mkdirSync(scripts, { recursive: true });
const base = { version: 1, name: 'checkout', task: 'buy', url: 'https://x.example/', sourceRunId: 'run-1', createdAt: '2026-09-10T10:00:00.000Z', steps: [{ type: 'navigate', url: 'https://x.example/' }] };
fs.writeFileSync(path.join(scripts, 'checkout.json'), JSON.stringify(base));
fs.writeFileSync(path.join(scripts, 'checkout.candidate.json'), JSON.stringify({ ...base, steps: [{ type: 'navigate', url: 'https://x.example/new' }], healedFrom: { runId: 'run-1', failedStep: 0, healedAt: 'x' } }));
const store = new JobStore({ home });
const job = store.add({ target: 'suite', url: 'https://x.example/', when: 'hourly' });

const cliCalls: string[][] = [];
let release!: () => void;
const gate = new Promise<void>((r) => (release = r));
const TOKEN = 'test-token-123';
const server = await startDashboard(artifacts, 0, {
  root, jobStore: store, token: TOKEN, setup: () => ({ agents: [], clicker: '', planner: '', keysPresent: [], helperRunning: false }),
  cli: async (args) => { cliCalls.push(args); await gate; return { code: 1 }; },
});
const port = (server.address() as AddressInfo).port;
const post = (p: string, body: unknown, token?: string): Promise<{ status: number; json: Record<string, unknown> }> =>
  new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...(token && { 'x-spike-token': token }) } }, (res) => {
      let t = '';
      res.on('data', (c) => (t += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: t ? JSON.parse(t) : {} }));
    });
    req.on('error', reject);
    req.end(data);
  });

try {
  check('POST without token -> 403', (await post('/api/quarantine', { name: 'checkout' })).status === 403);
  check('POST with a wrong token -> 403', (await post('/api/quarantine', { name: 'checkout' }, 'nope')).status === 403);
  check('403 did not run the handler', !fs.existsSync(path.join(root, '.spike-quarantine.json')));
  const home1 = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  check('pages embed the token and the Test something box', home1.includes(TOKEN) && home1.includes('Test something'));

  check('quarantine with token -> handler ran', (await post('/api/quarantine', { name: 'checkout' }, TOKEN)).status === 200 && fs.readFileSync(path.join(root, '.spike-quarantine.json'), 'utf8').includes('checkout'));
  check('release with token', (await post('/api/release', { name: 'checkout' }, TOKEN)).status === 200 && !fs.readFileSync(path.join(root, '.spike-quarantine.json'), 'utf8').includes('"checkout"'));
  check('unknown test name -> 400, not a crash', (await post('/api/quarantine', { name: 'nope' }, TOKEN)).status === 400);
  check('reject heal removes the candidate', (await post('/api/reject-heal', { name: 'checkout' }, TOKEN)).status === 200 && !fs.existsSync(path.join(scripts, 'checkout.candidate.json')));
  check('unknown action -> 404', (await post('/api/format-disk', {}, TOKEN)).status === 404);
  check('prototype names are not actions', (await post('/api/constructor', {}, TOKEN)).status === 404);

  check('save-as-test refuses a failing run', (await post('/api/save-test', { runId: 'run-1' }, TOKEN)).status === 400);
  check('run id path traversal is refused', (await post('/api/rerun', { runId: '../../etc' }, TOKEN)).status === 404);

  check('test-something rejects a non-http address', (await post('/api/test-something', { url: 'file:///etc/passwd', task: 'x' }, TOKEN)).status === 400);
  check('test-something rejects a task that looks like a flag', (await post('/api/test-something', { url: 'https://x.example/', task: '--json' }, TOKEN)).status === 400);
  const t1 = await post('/api/test-something', { url: 'https://x.example/', task: 'check the pricing page' }, TOKEN);
  check('test-something starts a run through the runner', t1.status === 200 && cliCalls.length === 1 && cliCalls[0][0] === 'run' && cliCalls[0].includes('check the pricing page'));
  check('a second run is refused while one is running', (await post('/api/run-all', {}, TOKEN)).status === 409);
  const act = (await (await fetch(`http://127.0.0.1:${port}/api/activity`)).json()) as { activity: Array<{ state: string }> };
  check('activity shows the running job', act.activity[0]?.state === 'running');
  release();
  await new Promise((r) => setTimeout(r, 50));
  const act2 = (await (await fetch(`http://127.0.0.1:${port}/api/activity`)).json()) as { activity: Array<{ state: string; verdict?: string }> };
  check('activity finishes with a verdict from the exit code', act2.activity[0]?.state === 'done' && act2.activity[0]?.verdict === 'fail');

  const spec = await post('/api/test-something', { url: 'https://x.example/', spec: '# flows\n- log in' }, TOKEN);
  check('a dropped spec file is written under .spike and run with --spec', spec.status === 200 && cliCalls[1][1] === '--spec' && fs.existsSync(cliCalls[1][2]));
  await new Promise((r) => setTimeout(r, 50));
  check('rerun starts the same task again', (await post('/api/rerun', { runId: 'run-1' }, TOKEN)).status === 200 && cliCalls[2].includes('look around'));
  await new Promise((r) => setTimeout(r, 50));
  check('remove-job removes it', (await post('/api/remove-job', { id: job.id }, TOKEN)).status === 200 && store.list().length === 0);

  const detail = await (await fetch(`http://127.0.0.1:${port}/run/run-1`)).text();
  check('run detail has Copy fix prompt (client-side) and Re-run, no Save as test on a fail', detail.includes('Copy fix prompt') && detail.includes('data-act="rerun"') && !detail.includes('Save as test'));
} finally {
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
