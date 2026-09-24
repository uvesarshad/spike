/* V125 — `spike setup` flow: non-TTY / dry-run write nothing, --yes applies, verify stubbed (A2). */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSetup, parseOnly, type SetupDeps } from '../src/setup/command.js';

const checks: [string, boolean][] = [];
const check = (l: string, ok: boolean) => { checks.push([l, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}`); };

function fresh(over: Partial<SetupDeps> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spike-cmd-'));
  const home = path.join(dir, 'home'), cwd = path.join(dir, 'proj');
  fs.mkdirSync(path.join(home, '.cursor'), { recursive: true }); fs.mkdirSync(cwd);
  const lines: string[] = []; let verifies = 0; let confirms = 0;
  const deps: SetupDeps = {
    env: { home, cwd, hasBinary: () => false, now: () => 1, run: () => ({ ok: false, stdout: '' }) },
    isTTY: false,
    confirm: async () => { confirms++; return true; },
    verify: async () => { verifies++; return { ok: true, lines: ['  ok  stub verify'] }; },
    out: (l) => lines.push(l),
    ...over,
  };
  return { deps, lines, home, cwd, counts: () => ({ verifies, confirms }) };
}
const cursorCfg = (home: string) => path.join(home, '.cursor', 'mcp.json');

{
  const t = fresh();
  const code = await runSetup({}, t.deps);
  check('non-TTY without --yes exits 0 and writes nothing', code === 0 && !fs.existsSync(cursorCfg(t.home)) && t.lines.some((l) => /Nothing was written/.test(l)));
  check('plan table shows agent and file', t.lines.some((l) => /Cursor/.test(l)) && t.lines.some((l) => l.includes('mcp.json')));
}
{
  const t = fresh({ isTTY: true });
  await runSetup({ dryRun: true, yes: true }, t.deps);
  check('--dry-run writes nothing and never asks', !fs.existsSync(cursorCfg(t.home)) && t.counts().confirms === 0);
}
{
  const t = fresh({ isTTY: true, confirm: async () => false });
  await runSetup({}, t.deps);
  check('declining the confirmation writes nothing', !fs.existsSync(cursorCfg(t.home)));
}
{
  const t = fresh({ isTTY: true });
  const code = await runSetup({}, t.deps);
  check('TTY: confirmed once, writes, verifies, prints next step', code === 0 && fs.existsSync(cursorCfg(t.home)) && t.counts().confirms === 1 && t.counts().verifies === 1 && t.lines.some((l) => /Connected: Cursor/.test(l)) && t.lines.some((l) => /^Next: Ask your agent/.test(l)));
}
{
  const t = fresh();
  await runSetup({ yes: true, verify: false }, t.deps);
  check('--yes applies without a TTY; --no-verify skips verify', fs.existsSync(cursorCfg(t.home)) && t.counts().verifies === 0);
  const code = await runSetup({ yes: true, uninstall: true }, t.deps);
  check('--uninstall removes what was added', code === 0 && !fs.existsSync(cursorCfg(t.home)));
}
{
  const t = fresh({ verify: async () => ({ ok: false, lines: ['  !!  broken'] }) });
  check('failed verify gives a non-zero exit and no next step', (await runSetup({ yes: true }, t.deps)) === 1 && !t.lines.some((l) => /^Next:/.test(l)));
}
{
  const t = fresh();
  fs.rmSync(path.join(t.home, '.cursor'), { recursive: true });
  check('no agents found -> friendly message, exit 0', (await runSetup({ yes: true }, t.deps)) === 0 && t.lines.some((l) => /No coding agents found/.test(l)));
  check('unknown --only agent -> exit 2', (await runSetup({ only: 'vim' }, t.deps)) === 2);
  const t2 = fresh();
  await runSetup({ yes: true, only: 'cursor', project: true }, t2.deps);
  check('--project + --only writes into cwd, not home', fs.existsSync(path.join(t2.cwd, '.cursor/mcp.json')) && !fs.existsSync(cursorCfg(t2.home)));
}
check('parseOnly splits and flags unknown', JSON.stringify(parseOnly('claude, cursor,x')) === JSON.stringify({ agents: ['claude', 'cursor'], bad: ['x'] }));

const failed = checks.filter(([, ok]) => !ok);
console.log(`\nv125: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) { console.error('FAILED: ' + failed.map(([l]) => l).join(', ')); process.exit(1); }
