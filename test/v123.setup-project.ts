/* V123 — `spike setup --project` writes into the project dir only (A2). */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planSetup, applyOps, type SetupEnv } from '../src/setup/apply.js';

const checks: [string, boolean][] = [];
const check = (l: string, ok: boolean) => { checks.push([l, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}`); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spike-proj-'));
const home = path.join(dir, 'home'), cwd = path.join(dir, 'proj');
fs.mkdirSync(home); fs.mkdirSync(cwd);
const calls: string[][] = [];
const env: SetupEnv = { home, cwd, hasBinary: () => true, now: () => 5, run: (f, a) => { calls.push([f, ...a]); return { ok: true, stdout: '' }; } };
const rd = (p: string) => fs.readFileSync(p, 'utf8');
const run = () => applyOps(planSetup({ env, agents: ['claude', 'cursor', 'codex'], project: true }));

const r = run();
check('project: nothing touches the home dir', fs.readdirSync(home).length === 0);
check('project: never shells out', calls.length === 0);
check('project: .mcp.json', JSON.parse(rd(path.join(cwd, '.mcp.json'))).mcpServers.spike.args[0] === 'mcp');
check('project: cursor mcp + rule', JSON.parse(rd(path.join(cwd, '.cursor/mcp.json'))).mcpServers.spike.command === 'spike' && /alwaysApply: false/.test(rd(path.join(cwd, '.cursor/rules/spike.mdc'))));
check('project: AGENTS.md fenced block', /<!-- spike:begin -->/.test(rd(path.join(cwd, 'AGENTS.md'))));
check('project: claude skill', /name: spike/.test(rd(path.join(cwd, '.claude/skills/spike/SKILL.md'))));
check('project: 5 files created', r.filter((x) => x.action === 'create').length === 5);
check('project: idempotent', run().every((x) => x.action === 'skip'));

fs.writeFileSync(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { a: { command: 'a' } } }, null, 2));
fs.rmSync(path.join(cwd, 'AGENTS.md'));
fs.writeFileSync(path.join(cwd, 'AGENTS.md'), '# Project rules\n');
const r2 = run();
check('project: merges into existing .mcp.json and AGENTS.md', r2.filter((x) => x.action === 'merge').length === 2 && JSON.parse(rd(path.join(cwd, '.mcp.json'))).mcpServers.a.command === 'a');

const failed = checks.filter(([, ok]) => !ok);
console.log(`\nv123: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) { console.error('FAILED: ' + failed.map(([l]) => l).join(', ')); process.exit(1); }
