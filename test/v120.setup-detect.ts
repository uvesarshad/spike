/* V120 — agent detection for `spike setup` (A2). Temp home per agent; no real configs. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectAgents } from '../src/setup/detect.js';

const checks: [string, boolean][] = [];
const check = (l: string, ok: boolean) => { checks.push([l, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}`); };

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'spike-detect-'));
const installed = (home: string, bins: string[] = []) =>
  detectAgents({ home, hasBinary: (b) => bins.includes(b) }).filter((a) => a.installed).map((a) => a.agent);

const empty = mk();
check('empty home + no binaries detects nothing', installed(empty).length === 0);

for (const [dir, agent] of [['.claude', 'claude'], ['.cursor', 'cursor'], ['.codeium/windsurf', 'windsurf'], ['.codex', 'codex'], ['.gemini', 'gemini']] as const) {
  const h = mk();
  fs.mkdirSync(path.join(h, dir), { recursive: true });
  const got = installed(h);
  check(`${dir} alone detects only ${agent}`, got.length === 1 && got[0] === agent);
}
check('claude binary on PATH is enough', installed(mk(), ['claude']).join() === 'claude');
check('codex binary on PATH is enough', installed(mk(), ['codex']).join() === 'codex');
check('.codeium without windsurf is not windsurf', (() => { const h = mk(); fs.mkdirSync(path.join(h, '.codeium')); return installed(h).length === 0; })());

const all = detectAgents({ home: '/h', hasBinary: () => false });
check('claude supports skills, others do not', all.filter((a) => a.supportsSkills).map((a) => a.agent).join() === 'claude');
check('user config paths live under the injected home', all.every((a) => a.userConfigPath.startsWith('/h')));
check('cursor and claude have project config paths', all.filter((a) => a.projectConfigPath).map((a) => a.agent).join() === 'claude,cursor');

const failed = checks.filter(([, ok]) => !ok);
console.log(`\nv120: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) { console.error('FAILED: ' + failed.map(([l]) => l).join(', ')); process.exit(1); }
