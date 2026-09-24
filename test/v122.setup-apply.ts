/* V122 — `spike setup` per-agent writers, user scope (A2). Temp home, stubbed runner. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planSetup, applyOps, type SetupEnv } from '../src/setup/apply.js';
import type { AgentId } from '../src/setup/detect.js';

const checks: [string, boolean][] = [];
const check = (l: string, ok: boolean) => { checks.push([l, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}`); };

function mkEnv(over: Partial<SetupEnv> & { calls?: string[][] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spike-apply-'));
  const home = path.join(dir, 'home'); const cwd = path.join(dir, 'proj');
  fs.mkdirSync(home); fs.mkdirSync(cwd);
  const calls: string[][] = over.calls ?? [];
  const env: SetupEnv = {
    home, cwd, hasBinary: () => true, now: () => 1700000000000,
    run: (f, a) => { calls.push([f, ...a]); return { ok: a[1] === 'get' ? false : true, stdout: '' }; },
    ...over,
  };
  return { env, home, calls };
}
const go = (env: SetupEnv, agent: AgentId, extra: object = {}) => applyOps(planSetup({ env, agents: [agent], ...extra }));
const actions = (r: { action: string }[]) => r.map((x) => x.action).join(',');
const rd = (p: string) => fs.readFileSync(p, 'utf8');

// Claude Code
{
  const { env, home, calls } = mkEnv();
  const r = go(env, 'claude');
  check('claude: create registers via the official CLI with exact argv', calls.some((c) => c.join(' ') === 'claude mcp add --scope user spike -- spike mcp'));
  check('claude: probes with `claude mcp get spike` first', calls[0].join(' ') === 'claude mcp get spike');
  check('claude: skill written', /^---\nname: spike/.test(rd(path.join(home, '.claude/skills/spike/SKILL.md'))));
  check('claude: plan is create,create', actions(r) === 'create,create');
  const { env: e2, calls: c2 } = mkEnv({ run: (f, a) => ({ ok: true, stdout: '' }) });
  const r2 = go(e2, 'claude');
  check('claude: already registered -> no add call', actions(r2) === 'skip,create');
  const r3 = go(e2, 'claude');
  check('claude: idempotent second run is all skip', actions(r3) === 'skip,skip');
  const { env: e3 } = mkEnv({ hasBinary: () => false });
  check('claude: no binary -> skip with reason, skill still written', actions(go(e3, 'claude')) === 'skip,create');
}

// JSON agents
for (const [agent, rel] of [['cursor', '.cursor/mcp.json'], ['windsurf', '.codeium/windsurf/mcp_config.json'], ['gemini', '.gemini/settings.json']] as const) {
  const { env, home } = mkEnv();
  const f = path.join(home, rel);
  check(`${agent}: create`, actions(go(env, agent)) === 'create' && JSON.parse(rd(f)).mcpServers.spike.command === 'spike');
  check(`${agent}: idempotent`, actions(go(env, agent)) === 'skip');

  const m = mkEnv(); const mf = path.join(m.home, rel);
  fs.mkdirSync(path.dirname(mf), { recursive: true });
  const orig = JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'x' } } }, null, 2) + '\n';
  fs.writeFileSync(mf, orig);
  check(`${agent}: merge keeps other entries`, actions(go(m.env, agent)) === 'merge' && JSON.parse(rd(mf)).mcpServers.other.command === 'x' && JSON.parse(rd(mf)).theme === 'dark');
  const bak = fs.readdirSync(path.dirname(mf)).find((n) => n.includes('.spike-backup-1700000000000'));
  check(`${agent}: backup written with original bytes`, !!bak && rd(path.join(path.dirname(mf), bak)) === orig);

  const c = mkEnv(); const cf = path.join(c.home, rel);
  fs.mkdirSync(path.dirname(cf), { recursive: true });
  const diff = JSON.stringify({ mcpServers: { spike: { command: 'node', args: ['x'] } } }, null, 2);
  fs.writeFileSync(cf, diff);
  check(`${agent}: differing entry is a conflict, untouched`, actions(go(c.env, agent)) === 'conflict' && rd(cf) === diff);
  check(`${agent}: --force replaces it`, actions(go(c.env, agent, { force: true })) === 'merge' && JSON.parse(rd(cf)).mcpServers.spike.command === 'spike');

  const b = mkEnv(); const bf = path.join(b.home, rel);
  fs.mkdirSync(path.dirname(bf), { recursive: true });
  fs.writeFileSync(bf, '{ nope');
  check(`${agent}: malformed JSON is skipped and untouched`, actions(go(b.env, agent)) === 'skip' && rd(bf) === '{ nope');
}

// Codex
{
  const { env, home } = mkEnv();
  const cfg = path.join(home, '.codex/config.toml'), ag = path.join(home, '.codex/AGENTS.md');
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  fs.writeFileSync(cfg, 'model = "gpt"\n');
  fs.writeFileSync(ag, '# mine\n');
  check('codex: merge both files', actions(go(env, 'codex')) === 'merge,merge');
  check('codex: toml block appended, existing kept', /model = "gpt"/.test(rd(cfg)) && /\[mcp_servers\.spike\]\ncommand = "spike"\nargs = \["mcp"\]/.test(rd(cfg)));
  check('codex: AGENTS block fenced', /<!-- spike:begin -->[\s\S]*<!-- spike:end -->/.test(rd(ag)) && rd(ag).startsWith('# mine'));
  check('codex: idempotent', actions(go(env, 'codex')) === 'skip,skip');
  check('codex: backups exist', fs.readdirSync(path.dirname(cfg)).some((n) => n.startsWith('config.toml.spike-backup-')));
  const c = mkEnv(); const cc = path.join(c.home, '.codex/config.toml');
  fs.mkdirSync(path.dirname(cc), { recursive: true });
  fs.writeFileSync(cc, '[mcp_servers.spike]\ncommand = "other"\n');
  check('codex: hand-written spike table is a conflict', actions(go(c.env, 'codex')).startsWith('conflict') && rd(cc) === '[mcp_servers.spike]\ncommand = "other"\n');
}

const failed = checks.filter(([, ok]) => !ok);
console.log(`\nv122: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) { console.error('FAILED: ' + failed.map(([l]) => l).join(', ')); process.exit(1); }
