/* A12 — entry points: bare `spike` and the "details:" line, with a stubbed reachability probe. */
import { detailsLine, noArgEntry } from '../src/dashboard/entry.js';

let failed = 0;
function check(name: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failed++;
}

{
  const out: string[] = []; const opened: string[] = []; let helped = 0;
  const r = await noArgEntry({ port: 9420, reachable: async () => true, open: (u) => opened.push(u), help: () => helped++, print: (l) => out.push(l) });
  check('reachable -> opens the home page, no help', r === 'opened' && opened[0] === 'http://127.0.0.1:9420/' && helped === 0);
}
{
  const out: string[] = []; const opened: string[] = []; let helped = 0;
  const r = await noArgEntry({ port: 9420, reachable: async () => false, open: (u) => opened.push(u), help: () => helped++, print: (l) => out.push(l) });
  check('unreachable -> help plus the tip, nothing opened', r === 'help' && helped === 1 && opened.length === 0 && out.some((l) => l.includes('Tip: `spike daemon` gives you a home page for your test runs')));
}
check('details line when reachable', (await detailsLine('run-1', { port: 9420, reachable: async () => true })) === 'details: http://127.0.0.1:9420/run/run-1');
check('no details line when unreachable', (await detailsLine('run-1', { port: 9420, reachable: async () => false })) === null);
check('no details line without a run id', (await detailsLine(undefined, { reachable: async () => true })) === null);
process.exit(failed ? 1 : 0);
