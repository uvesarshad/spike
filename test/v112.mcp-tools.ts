/* v112 — A4/A5: the MCP surface is exactly five tools, each described in <= 60
 * words, no description teaches inline credentials, and the run/site/test tools
 * return slim, bounded shapes. Exercised in-process (stubs, no Chrome). */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp-server.js';
import { isSafeRunId, listRuns } from '../src/report/run-store.js';
import { validateTestsRunInput } from '../src/suite/run-tests.js';
import type { AppModel } from '../src/discovery/index.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spike-v112-'));
function writeRun(id: string, verdict: string, mtime: number, extra: Record<string, unknown> = {}) {
  fs.mkdirSync(path.join(dir, id), { recursive: true });
  const p = path.join(dir, id, 'report.json');
  fs.writeFileSync(
    p,
    JSON.stringify({
      runId: id, task: 'log in with password: hunter2 and buy', url: 'http://x.test', verdict, reason: 'boom',
      console_error: 'TypeError: nope', evidence_paths: [p], steps: [], failing_step: undefined, ...extra,
    }),
  );
  fs.utimesSync(p, mtime / 1000, mtime / 1000);
}
writeRun('run-a', 'pass', 1_000_000);
writeRun('run-b', 'fail', 3_000_000);
writeRun('run-c', 'uncertain', 2_000_000);

async function connect(deps: Parameters<typeof createMcpServer>[0]) {
  const server = createMcpServer(deps);
  const client = new Client({ name: 't', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}
const call = async (c: Client, name: string, args: Record<string, unknown>) => {
  const r = (await c.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  return { text: r.content[0].text, isError: r.isError === true };
};

(async () => {
  const siteRoutes = Array.from({ length: 25 }, (_, i) => ({ route: `/p${i}`, exercised: false, states: [], coveredByScripts: [], discoveredAt: '' }));
  const model = { version: 1, generatedAt: '', routes: siteRoutes, findings: [] } as unknown as AppModel;
  const client = await connect({
    qaRun: (async () => ({ verdict: 'pass' })) as never,
    artifactsDir: () => dir,
    siteCheckDeps: {
      buildMap: async () => model,
      saveModel: () => {},
      runPage: async () => ({ verdict: 'fail', reason: 'the page shows an error banner '.repeat(20) }),
    },
    testsRunDeps: {
      suite: () => ({ entries: [{ script: 'good', tags: ['smoke'] }, { script: 'bad', tags: ['smoke'] }], cases: [] }),
      replay: async (s) => ({ verdict: s === 'bad' ? 'fail' : 'pass', reason: s === 'bad' ? 'broke' : '', steps: [], evidence_paths: [] }) as never,
      runCase: (async () => ({ verdict: 'pass' })) as never,
    },
  });

  // tools/list
  const { tools } = await client.listTools();
  check('exactly 5 tools', tools.length === 5);
  check('the five names', ['qa_run', 'site_check', 'tests_run', 'runs_list', 'run_get'].every((n) => tools.some((t) => t.name === n)));
  const words = (s: string) => s.trim().split(/\s+/).length;
  check('every tool description <= 60 words', tools.every((t) => words(t.description ?? '') <= 60));
  // A5: nothing in any description or input description looks like `user@host / password`.
  const allDescriptions: string[] = [];
  for (const t of tools) {
    allDescriptions.push(t.description ?? '');
    const props = (t.inputSchema as { properties?: Record<string, { description?: string }> }).properties ?? {};
    for (const p of Object.values(props)) allDescriptions.push(p.description ?? '');
  }
  check('no description teaches inline credentials', allDescriptions.every((d) => !/\S+@\S+\s*\/\s*\S+/.test(d)));
  const qa = tools.find((t) => t.name === 'qa_run')!;
  const taskDesc = (qa.inputSchema as { properties: Record<string, { description: string }> }).properties.task.description;
  check('task example uses secret placeholders + spike secret set', taskDesc.includes('{{secret:TEST_USER}}') && taskDesc.includes('spike secret set'));
  const qaProps = Object.keys((qa.inputSchema as { properties: object }).properties);
  check('qa_run has storageState + allowHosts', qaProps.includes('storageState') && qaProps.includes('allowHosts'));

  // runs_list
  const list = JSON.parse((await call(client, 'runs_list', {})).text) as { runId: string; verdict: string; task: string }[];
  check('runs_list newest first', list.map((r) => r.runId).join() === 'run-b,run-c,run-a');
  check('runs_list task is redacted', !list[0].task.includes('hunter2'));
  check('runs_list honours limit', (JSON.parse((await call(client, 'runs_list', { limit: 1 })).text) as unknown[]).length === 1);
  check('runs_list rejects limit > 20', (await call(client, 'runs_list', { limit: 99 })).isError);

  // run_get
  for (const bad of ['../etc/passwd', '..', 'a/b', 'a\\b', '']) {
    check(`run_get rejects ${JSON.stringify(bad)}`, (await call(client, 'run_get', { runId: bad })).isError);
  }
  check('isSafeRunId', isSafeRunId('run-a') && !isSafeRunId('../x'));
  const got = JSON.parse((await call(client, 'run_get', { runId: 'run-b' })).text) as Record<string, unknown>;
  check('run_get slim shape', got.verdict === 'fail' && 'schemaVersion' in got && !('steps' in got));
  check('run_get carries fix_hint on fail', typeof got.fix_hint === 'string');
  const pass = JSON.parse((await call(client, 'run_get', { runId: 'run-a' })).text) as Record<string, unknown>;
  check('run_get has no fix_hint on pass', !('fix_hint' in pass));
  check('run_get unknown id is an error', (await call(client, 'run_get', { runId: 'nope' })).isError);
  check('listRuns limit', listRuns(dir, 2).length === 2);

  // site_check
  const sc = await call(client, 'site_check', { url: 'http://x.test' });
  const scj = JSON.parse(sc.text) as { verdict: string; pagesChecked: number; problems: unknown[]; summary: string };
  check('site_check verdict + pages', scj.verdict === 'fail' && scj.pagesChecked === 20);
  check('site_check caps problems at 20', scj.problems.length === 20);
  check('site_check under 2K tokens', JSON.stringify(scj).length / 4 < 2000);

  // tests_run
  check('tests_run needs exactly one selector', validateTestsRunInput({}) !== undefined && validateTestsRunInput({ name: 'a', all: true }) !== undefined && validateTestsRunInput({ tag: 't' }) === undefined);
  check('tests_run none => error', (await call(client, 'tests_run', {})).isError);
  check('tests_run two => error', (await call(client, 'tests_run', { name: 'x', all: true })).isError);
  const tr = JSON.parse((await call(client, 'tests_run', { tag: 'smoke' })).text) as { verdict: string; passed: number; total: number; tests: { test: string; verdict: string }[] };
  check('tests_run aggregate', tr.verdict === 'fail' && tr.passed === 1 && tr.total === 2);
  check('tests_run failures first', tr.tests[0].test === 'bad');
  const one = JSON.parse((await call(client, 'tests_run', { name: 'good' })).text) as { verdict: string; total: number };
  check('tests_run by name', one.verdict === 'pass' && one.total === 1);

  fs.rmSync(dir, { recursive: true, force: true });
  if (checks.some(([, ok]) => !ok)) process.exit(1);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
