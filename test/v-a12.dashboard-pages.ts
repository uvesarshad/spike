/* A12 — Spike home read pages: Tests, Site, Schedules, Setup each render with an
 * empty and a populated fixture dir. Temp dirs, injected job store / setup data,
 * port 0 on loopback — no real home dir, no Chrome, no network. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { startDashboard } from '../src/dashboard/server.js';
import { emptyAppModel, saveAppModel } from '../src/discovery/app-model.js';
import { describeModel, keysPresent } from '../src/dashboard/setup-info.js';
import { JobStore } from '../src/schedule/store.js';
import { detectAgents } from '../src/setup/detect.js';

let failed = 0;
function check(name: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failed++;
}

const mk = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

async function pages(root: string, home: string, keys: string[]): Promise<Record<string, { status: number; text: string }>> {
  const artifacts = path.join(root, 'artifacts');
  const server = await startDashboard(artifacts, 0, {
    root,
    jobStore: new JobStore({ home }),
    defaultBudgetUsd: 1,
    setup: () => ({
      agents: detectAgents({ home, hasBinary: () => false }),
      clicker: describeModel({ provider: 'claude', mode: 'cli', model: 'claude-haiku-4-5' }),
      planner: describeModel({ provider: 'claude', mode: 'cli' }),
      keysPresent: keys,
      helperRunning: false,
    }),
  });
  try {
    const port = (server.address() as AddressInfo).port;
    const out: Record<string, { status: number; text: string }> = {};
    for (const p of ['/', '/tests', '/site', '/schedules', '/setup']) {
      const r = await fetch(`http://127.0.0.1:${port}${p}`);
      out[p] = { status: r.status, text: await r.text() };
    }
    return out;
  } finally {
    server.close();
  }
}

// ---- empty fixture
{
  const root = mk('spike-a12-e-');
  const home = mk('spike-a12-eh-');
  const r = await pages(root, home, []);
  check('every page renders 200 on an empty project', Object.values(r).every((x) => x.status === 200));
  check('tests: empty message', r['/tests'].text.includes('no saved tests yet'));
  check('site: not looked at yet', r['/site'].text.includes('has not looked at your site yet'));
  check('schedules: empty message', r['/schedules'].text.includes('nothing scheduled'));
  check('setup: no key message', r['/setup'].text.includes('No AI key found'));
  check('nav on every page', Object.values(r).every((x) => x.text.includes('href="/setup"')));
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
}

// ---- populated fixture
{
  const root = mk('spike-a12-p-');
  const home = mk('spike-a12-ph-');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const dir = path.join(root, 'generated-tests');
  fs.mkdirSync(dir, { recursive: true });
  const script = (url: string) => ({ version: 1, name: 'checkout', task: 'buy a thing', url: 'https://shop.example.com/', sourceRunId: 'run-1', createdAt: '2026-09-10T10:00:00.000Z', steps: [{ type: 'navigate', url }] });
  fs.writeFileSync(path.join(dir, 'checkout.json'), JSON.stringify(script('https://shop.example.com/')));
  fs.writeFileSync(path.join(dir, 'checkout.candidate.json'), JSON.stringify({ ...script('https://shop.example.com/new'), healedFrom: { runId: 'run-1', failedStep: 0, healedAt: '2026-09-11T10:00:00.000Z' } }));
  fs.mkdirSync(path.join(root, 'artifacts', 'run-1'), { recursive: true });
  fs.writeFileSync(path.join(root, 'artifacts', 'run-1', 'report.json'), JSON.stringify({ runId: 'run-1', task: 'buy a thing', url: 'https://shop.example.com/', verdict: 'fail', steps: [] }));
  const model = emptyAppModel('https://shop.example.com/');
  model.routes.push({ route: '/cart', source: 'crawl', discoveredAt: 'x', exercised: false, states: [], coveredByScripts: [] });
  model.findings = [{ kind: 'page-error', severity: 'problem', route: '/cart', detail: 'it threw an error', foundAt: 'x' } as never];
  saveAppModel(model, root);
  const store = new JobStore({ home });
  store.add({ target: 'suite', url: 'https://shop.example.com/', when: 'hourly' });
  const r = await pages(root, home, ['Gemini']);
  check('populated pages render 200', Object.values(r).every((x) => x.status === 200));
  check('tests: lists the saved test, its last result and the waiting change', r['/tests'].text.includes('checkout') && r['/tests'].text.includes('fail') && r['/tests'].text.includes('change waiting for review') && r['/tests'].text.includes('Changes waiting'));
  check('site: shows the broken page from the last check', r['/site'].text.includes('/cart') && r['/site'].text.includes('it threw an error'));
  check('schedules: shows the job with spend vs limit', r['/schedules'].text.includes('hourly') && r['/schedules'].text.includes('of $1'));
  check('setup: found agent, key name, no key value', r['/setup'].text.includes('Claude Code') && r['/setup'].text.includes('Gemini') && !r['/setup'].text.includes('sk-'));
  check('vocabulary: setup page avoids dev words', !/navigator|brain|daemon|BYOK|CDP/i.test(r['/setup'].text.replace(/spike daemon/g, '')));
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
}

check('keysPresent reports names from env and vault, never values', JSON.stringify(keysPresent({ GEMINI_API_KEY: 'secret-value' }, ['ANTHROPIC_API_KEY'])) === JSON.stringify(['Claude', 'Gemini']));
process.exit(failed ? 1 : 0);
