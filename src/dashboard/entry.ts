import { DASHBOARD_DEFAULT_PORT, dashboardReachable } from './server.js';
import { openInBrowser } from './open.js';

/* Entry points to Spike home (A12): bare `spike`, and the "details:" line at the
 * end of a CLI run result. Both depend on a reachability probe that tests stub. */

export interface EntryDeps {
  port?: number;
  reachable?: (port: number) => Promise<boolean>;
  open?: (url: string) => void;
  /** Prints the normal command help. */
  help: () => void;
  print?: (line: string) => void;
}

export const homePort = (): number => Number(process.env.SPIKE_DASHBOARD_PORT ?? DASHBOARD_DEFAULT_PORT);

/** `spike` with no arguments: open Spike home when Spike Core is serving it, else help plus a one-line tip. */
export async function noArgEntry(deps: EntryDeps): Promise<'opened' | 'help'> {
  const port = deps.port ?? homePort();
  const print = deps.print ?? ((l: string) => console.log(l));
  if (await (deps.reachable ?? dashboardReachable)(port)) {
    const url = `http://127.0.0.1:${port}/`;
    (deps.open ?? ((u: string) => openInBrowser(u)))(url);
    print(`Opening Spike home: ${url}`);
    return 'opened';
  }
  deps.help();
  print('');
  print('Tip: `spike daemon` gives you a home page for your test runs.');
  return 'help';
}

/** "details: http://127.0.0.1:9420/run/<id>" when Spike home is reachable, else null. */
export async function detailsLine(runId: string | undefined, deps: Pick<EntryDeps, 'port' | 'reachable'> = {}): Promise<string | null> {
  if (!runId) return null;
  const port = deps.port ?? homePort();
  if (!(await (deps.reachable ?? dashboardReachable)(port))) return null;
  return `details: http://127.0.0.1:${port}/run/${encodeURIComponent(runId)}`;
}
