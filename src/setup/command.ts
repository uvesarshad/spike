/* `spike setup` orchestration (A2): detect -> plan table -> confirm once -> apply -> verify.
 * Everything with side effects is injected so the fast suite drives it with a
 * temp home, a stubbed runner and stubbed verify. */

import { spawnSync } from 'node:child_process';
import { applyOps, planSetup, type ApplyResult, type PlanItem, type SetupEnv } from './apply.js';
import { ALL_AGENTS, detectAgents, defaultDetectEnv, realHasBinary, type AgentId } from './detect.js';

export interface SetupFlags {
  yes?: boolean;
  dryRun?: boolean;
  project?: boolean;
  only?: string;
  force?: boolean;
  uninstall?: boolean;
  /** Also install the optional "did you check?" reminder for Claude Code. */
  strict?: boolean;
  /** commander turns --no-verify into verify:false */
  verify?: boolean;
}

export interface VerifyResult { ok: boolean; lines: string[] }

export interface SetupDeps {
  env: SetupEnv;
  isTTY: boolean;
  confirm: () => Promise<boolean>;
  /** Doctor quick checks + an MCP tools/list round trip. */
  verify: () => Promise<VerifyResult>;
  out: (line: string) => void;
}

const AGENT_NAME: Record<AgentId, string> = {
  claude: 'Claude Code', cursor: 'Cursor', windsurf: 'Windsurf', codex: 'Codex', gemini: 'Gemini / Antigravity CLI',
};
export const NEXT_STEP = `Ask your agent: "check the signup page works on localhost:3000"`;

export function defaultSetupEnv(): SetupEnv {
  const d = defaultDetectEnv();
  return {
    home: d.home,
    cwd: process.cwd(),
    hasBinary: d.hasBinary,
    now: () => Date.now(),
    run: (file, args) => {
      const r = spawnSync(file, args, { encoding: 'utf8', timeout: 30_000, shell: process.platform === 'win32' && !realHasBinary(file) });
      return { ok: r.status === 0, stdout: r.stdout ?? '' };
    },
  };
}

export function parseOnly(only: string | undefined): { agents: AgentId[] | null; bad: string[] } {
  if (!only) return { agents: null, bad: [] };
  const parts = only.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const bad = parts.filter((p) => !(ALL_AGENTS as string[]).includes(p));
  return { agents: parts.filter((p) => !bad.includes(p)) as AgentId[], bad };
}

function table(rows: PlanItem[], uninstall: boolean): string[] {
  const verb = (r: PlanItem): string => {
    if (r.action === 'skip') return `nothing to do (${r.reason})`;
    if (r.action === 'conflict') return `left alone (${r.reason})`;
    return `${r.action === 'create' ? (uninstall ? 'remove' : 'add') : r.action === 'remove' ? 'remove' : 'update'}: ${r.reason}`;
  };
  const name = (r: PlanItem) => (r.agent === 'project' ? 'Project' : AGENT_NAME[r.agent]);
  const w = Math.max(...rows.map((r) => name(r).length), 5);
  return rows.map((r) => `  ${name(r).padEnd(w)}  ${verb(r)}\n  ${' '.repeat(w)}  ${r.file}`);
}

/** Returns the process exit code. */
export async function runSetup(flags: SetupFlags, deps: SetupDeps): Promise<number> {
  const { out, env } = deps;
  const { agents: onlyList, bad } = parseOnly(flags.only);
  if (bad.length) { out(`Unknown agent: ${bad.join(', ')}. Choose from: ${ALL_AGENTS.join(', ')}.`); return 2; }

  const detected = detectAgents({ home: env.home, hasBinary: env.hasBinary });
  const chosen = detected.filter((d) => d.installed && (!onlyList || onlyList.includes(d.agent))).map((d) => d.agent);
  // --only names an agent explicitly: honour it even when we couldn't detect it.
  const agents = onlyList ? Array.from(new Set([...chosen, ...onlyList])) : chosen;
  if (!agents.length) {
    out('No coding agents found on this machine (looked for Claude Code, Cursor, Windsurf, Codex, Gemini).');
    out('If yours is installed somewhere unusual, name it: spike setup --only claude,cursor');
    return 0;
  }

  const uninstall = !!flags.uninstall;
  const ops = planSetup({ env, agents, project: flags.project, force: flags.force, uninstall, strict: flags.strict });
  const scope = flags.project ? `this project (${env.cwd})` : 'your user account';
  out(`${uninstall ? 'Removing Spike from' : 'Connecting Spike to'} ${agents.map((a) => AGENT_NAME[a]).join(', ')} for ${scope}:`);
  out('');
  for (const l of table(ops, uninstall)) out(l);
  out('');

  const changes = ops.filter((o) => o.action !== 'skip' && o.action !== 'conflict');
  if (!changes.length) {
    out(uninstall ? 'Nothing to remove.' : ops.some((o) => o.action === 'conflict') ? 'Nothing was changed. Use --force to replace the entries listed above.' : 'Already set up. Nothing to change.');
    return 0;
  }
  if (flags.dryRun) { out('Dry run: nothing was written.'); return 0; }
  if (!flags.yes) {
    if (!deps.isTTY) {
      out('Nothing was written (no terminal to confirm on). Re-run with --yes to apply this.');
      return 0;
    }
    if (!(await deps.confirm())) { out('Cancelled. Nothing was written.'); return 0; }
  }

  const results = applyOps(ops);
  const failed = results.filter((r) => r.error);
  for (const r of results) {
    if (r.error) out(`  could not update ${r.file}: ${r.error}`);
  }
  out(uninstall ? 'Removed.' : `Done. ${results.filter((r) => r.done).length} change(s) written; backups end in .spike-backup-<time>.`);
  if (uninstall) return failed.length ? 1 : 0;

  const connected = connectedAgents(results);
  let verifyOk = true;
  if (flags.verify !== false) {
    const v = await deps.verify();
    verifyOk = v.ok;
    for (const l of v.lines) out(l);
  }
  out('');
  out(connected.length ? `Connected: ${connected.map((a) => AGENT_NAME[a]).join(', ')}` : 'No agent was connected.');
  if (connected.length && verifyOk) out(`Next: ${NEXT_STEP}`);
  return failed.length || !verifyOk ? 1 : 0;
}

function connectedAgents(results: ApplyResult[]): AgentId[] {
  const set = new Set<AgentId>();
  for (const r of results) {
    if (r.agent === 'project' || r.error) continue;
    if (r.action === 'create' || r.action === 'merge' || (r.action === 'skip' && r.reason === 'already set up')) set.add(r.agent);
  }
  return [...set];
}

/** The real MCP probe: start `spike mcp` and list its tools over stdio. */
export async function probeMcpTools(entry: string, timeoutMs = 20_000): Promise<{ ok: boolean; tools: number; error?: string }> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const client = new Client({ name: 'spike-setup', version: '0.0.1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry, 'mcp'] });
  try {
    const list = await Promise.race([
      (async () => { await client.connect(transport); return client.listTools(); })(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timed out')), timeoutMs)),
    ]);
    return { ok: list.tools.length > 0, tools: list.tools.length };
  } catch (e) {
    return { ok: false, tools: 0, error: e instanceof Error ? e.message : String(e) };
  } finally {
    try { await client.close(); } catch { /* already gone */ }
  }
}
