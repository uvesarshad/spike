/* V154 — `spike setup --strict` Stop hook (E4): temp home, stubbed runner, transcript fixtures. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planSetup, applyOps, type SetupEnv } from '../src/setup/apply.js';
import { evaluateStop, hookStopOutput, STOP_HOOK_COMMAND } from '../src/setup/strict-hook.js';

const check = (l: string, ok: boolean) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}`); if (!ok) process.exitCode = 1; };
const mk = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spike-strict-'));
  const home = path.join(dir, 'home'), cwd = path.join(dir, 'proj');
  fs.mkdirSync(home); fs.mkdirSync(cwd);
  const env: SetupEnv = { home, cwd, hasBinary: () => true, now: () => 5, run: () => ({ ok: true, stdout: '' }) };
  return { env, home, cwd };
};
const rd = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8'));

// not strict: no settings file touched
{
  const { env, home } = mk();
  applyOps(planSetup({ env, agents: ['claude'] }));
  check('without --strict no settings.json is written', !fs.existsSync(path.join(home, '.claude/settings.json')));
}
// strict create / idempotent / merge / uninstall
{
  const { env, home } = mk();
  const f = path.join(home, '.claude/settings.json');
  applyOps(planSetup({ env, agents: ['claude'], strict: true }));
  check('strict creates the Stop hook', rd(f).hooks.Stop[0].hooks[0].command === STOP_HOOK_COMMAND);
  const again = planSetup({ env, agents: ['claude'], strict: true }).filter((o) => o.file === f);
  check('second run is a skip', again[0].action === 'skip');
  const un = applyOps(planSetup({ env, agents: ['claude'], uninstall: true }));
  check('uninstall removes the hook and the now-empty file', un.some((r) => r.file === f && r.action === 'remove') && !fs.existsSync(f));
}
{
  const { env, home } = mk();
  const f = path.join(home, '.claude/settings.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const orig = JSON.stringify({ model: 'x', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine' }] }], PreToolUse: [] } }, null, 2) + '\n';
  fs.writeFileSync(f, orig);
  applyOps(planSetup({ env, agents: ['claude'], strict: true }));
  const j = rd(f);
  check('merge keeps the user\'s own Stop hook and other settings', j.model === 'x' && j.hooks.Stop.length === 2 && j.hooks.Stop[0].hooks[0].command === 'mine' && Array.isArray(j.hooks.PreToolUse));
  check('backup written with original bytes', fs.readFileSync(`${f}.spike-backup-5`, 'utf8') === orig);
  applyOps(planSetup({ env, agents: ['claude'], uninstall: true }));
  check('uninstall restores the original content', fs.readFileSync(f, 'utf8') === orig);
}
{
  const { env, home } = mk();
  const f = path.join(home, '.claude/settings.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '{ not json');
  const r = applyOps(planSetup({ env, agents: ['claude'], strict: true })).find((x) => x.file === f)!;
  check('invalid JSON is left alone', r.action === 'skip' && fs.readFileSync(f, 'utf8') === '{ not json');
}
{
  const { env, cwd } = mk();
  applyOps(planSetup({ env, agents: ['claude'], strict: true, project: true }));
  check('--project writes the hook into the project settings', fs.existsSync(path.join(cwd, '.claude/settings.json')));
}

// decision logic
const line = (o: unknown) => JSON.stringify(o);
const prompt = line({ type: 'user', message: { role: 'user', content: 'fix the button' } });
const edit = (file: string) => line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: file } }] } });
const toolResult = line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } });
const T = (...l: string[]) => l.join('\n');
check('edited a UI file, no check -> block', evaluateStop({}, T(prompt, edit('/a/Button.tsx'), toolResult)).block === true);
check('edited only a server file -> allow', evaluateStop({}, T(prompt, edit('/a/server.ts'))).block === false);
check('ran the MCP tool -> allow', evaluateStop({}, T(prompt, edit('/a/x.css'), line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__spike__qa_run', input: {} }] } }))).block === false);
check('ran spike via Bash -> allow', evaluateStop({}, T(prompt, edit('/a/x.vue'), line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'spike run "x" --url http://localhost:3000 --json' } }] } }))).block === false);
check('an edit from an earlier turn does not count', evaluateStop({}, T(prompt, edit('/a/x.tsx'), line({ type: 'user', message: { content: 'thanks, now explain it' } }))).block === false);
check('stop_hook_active never blocks again', evaluateStop({ stop_hook_active: true }, T(prompt, edit('/a/x.tsx'))).block === false);
check('missing transcript allows', evaluateStop({}, null).block === false);
check('torn line is skipped', evaluateStop({}, T(prompt, '{oops', edit('/a/x.tsx'))).block === true);
check('output is Claude Code block JSON, or empty', JSON.parse(hookStopOutput({ block: true, reason: 'r' })).decision === 'block' && hookStopOutput({ block: false }) === '');
