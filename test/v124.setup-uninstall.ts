/* V124 — install -> uninstall round trip leaves original files byte-identical (A2). */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planSetup, applyOps, type SetupEnv } from '../src/setup/apply.js';
import type { AgentId } from '../src/setup/detect.js';

const checks: [string, boolean][] = [];
const check = (l: string, ok: boolean) => { checks.push([l, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}`); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spike-un-'));
const home = path.join(dir, 'home'), cwd = path.join(dir, 'proj');
fs.mkdirSync(home); fs.mkdirSync(cwd);
const calls: string[][] = [];
let registered = false;
const env: SetupEnv = {
  home, cwd, hasBinary: () => true, now: () => 9,
  run: (f, a) => {
    calls.push([f, ...a]);
    if (a[1] === 'get') return { ok: registered, stdout: '' };
    if (a[1] === 'add') registered = true;
    if (a[1] === 'remove') registered = false;
    return { ok: true, stdout: '' };
  },
};
const agents: AgentId[] = ['claude', 'cursor', 'windsurf', 'codex', 'gemini'];
const fixtures: Record<string, string> = {
  '.cursor/mcp.json': JSON.stringify({ mcpServers: { other: { command: 'x' } } }, null, 2) + '\n',
  '.codeium/windsurf/mcp_config.json': JSON.stringify({ keep: 1, mcpServers: { z: { command: "z" } } }, null, 4) + '\n',
  '.gemini/settings.json': '{\n\t"theme": "dark"\n}\n',
  '.codex/config.toml': 'model = "gpt"\n\n[other]\na = 1\n',
  '.codex/AGENTS.md': '# mine\n\nsome text\n',
};
for (const [rel, text] of Object.entries(fixtures)) {
  fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
  fs.writeFileSync(path.join(home, rel), text);
}
applyOps(planSetup({ env, agents }));
check('install changed the fixtures', fs.readFileSync(path.join(home, '.cursor/mcp.json'), 'utf8') !== fixtures['.cursor/mcp.json']);
const un = applyOps(planSetup({ env, agents, uninstall: true }));
for (const [rel, text] of Object.entries(fixtures)) {
  const got = fs.readFileSync(path.join(home, rel), 'utf8');
  check(`round trip byte-identical: ${rel}`, got === text);
  if (got !== text) console.error(JSON.stringify(got));
}
check('skill dir removed', !fs.existsSync(path.join(home, '.claude/skills/spike')));
check('claude mcp remove via runner', calls.some((c) => c.join(' ') === 'claude mcp remove --scope user spike'));
check('backups are never deleted', fs.readdirSync(path.join(home, '.cursor')).some((n) => n.includes('.spike-backup-')));
check('second uninstall is all skip', applyOps(planSetup({ env, agents, uninstall: true })).every((x) => x.action === 'skip'));

// created-from-nothing files are removed again
const h2 = path.join(dir, 'h2'); fs.mkdirSync(h2);
const env2 = { ...env, home: h2 };
applyOps(planSetup({ env: env2, agents: ['cursor', 'codex'] }));
applyOps(planSetup({ env: env2, agents: ['cursor', 'codex'], uninstall: true }));
check('files we created are removed on uninstall', !fs.existsSync(path.join(h2, '.cursor/mcp.json')) && !fs.existsSync(path.join(h2, '.codex/config.toml')) && !fs.existsSync(path.join(h2, '.codex/AGENTS.md')));

// an edited entry is left alone
fs.writeFileSync(path.join(home, '.cursor/mcp.json'), JSON.stringify({ mcpServers: { spike: { command: 'mine' } } }));
check('edited spike entry is not removed', applyOps(planSetup({ env, agents: ['cursor'], uninstall: true }))[0].action === 'skip' && /mine/.test(fs.readFileSync(path.join(home, '.cursor/mcp.json'), 'utf8')));

// project scope round trip
const pfix = '# Project\n';
fs.writeFileSync(path.join(cwd, 'AGENTS.md'), pfix);
applyOps(planSetup({ env, agents: ['claude', 'cursor', 'codex'], project: true }));
applyOps(planSetup({ env, agents: ['claude', 'cursor', 'codex'], project: true, uninstall: true }));
check('project uninstall restores AGENTS.md and removes created files', fs.readFileSync(path.join(cwd, 'AGENTS.md'), 'utf8') === pfix && !fs.existsSync(path.join(cwd, '.mcp.json')) && !fs.existsSync(path.join(cwd, '.cursor/rules/spike.mdc')));

const failed = checks.filter(([, ok]) => !ok);
console.log(`\nv124: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) { console.error('FAILED: ' + failed.map(([l]) => l).join(', ')); process.exit(1); }
