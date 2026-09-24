/* `spike setup` writers (A2): plan first, then apply. Rules for everything here:
 *   - merge, never clobber: other entries in a user's agent config are untouched;
 *   - back up any existing file to <file>.spike-backup-<timestamp> before modifying it;
 *   - an existing `spike` entry that differs from ours is a `conflict`, left alone unless force;
 *   - unparseable JSON / TOML-looking surprises are `skip` with a plain reason;
 *   - idempotent: a second run is all `skip`;
 *   - uninstall removes exactly what we added and never deletes a backup.
 * All I/O goes through an injected SetupEnv (home, cwd, PATH lookup, command
 * runner, clock) so tests use a temp dir and a stubbed runner. */

import fs from 'node:fs';
import path from 'node:path';
import type { AgentId } from './detect.js';
import { BLOCK_BEGIN, BLOCK_END, renderAgentsBlock, renderCursorRule, renderSkillMd } from './skill-content.js';

export interface RunResult { ok: boolean; stdout: string }
export interface SetupEnv {
  home: string;
  cwd: string;
  hasBinary: (bin: string) => boolean;
  /** Runs an external command. Must never throw. */
  run: (file: string, args: string[]) => RunResult;
  now: () => number;
}

export type PlanAction = 'create' | 'merge' | 'skip' | 'conflict' | 'remove';
export interface PlanItem {
  agent: AgentId | 'project';
  /** A file path, or a short label when a CLI owns the change. */
  file: string;
  action: PlanAction;
  reason: string;
}
export interface Op extends PlanItem { apply: () => void }

export interface SetupOptions {
  env: SetupEnv;
  agents: AgentId[];
  project?: boolean;
  force?: boolean;
  uninstall?: boolean;
}

export const OUR_ENTRY = { command: 'spike', args: ['mcp'] } as const;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const TOML_BEGIN = '# spike:begin';
const TOML_END = '# spike:end';
export const TOML_BLOCK = `${TOML_BEGIN}\n[mcp_servers.spike]\ncommand = "spike"\nargs = ["mcp"]\n${TOML_END}\n`;

function readText(file: string): string | null {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function backup(env: SetupEnv, file: string): void {
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.spike-backup-${env.now()}`);
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function detectIndent(text: string): string | number {
  const m = /^([ \t]+)\S/m.exec(text);
  return m ? m[1] : 2;
}

// ---------- JSON mcpServers merge ----------

function jsonAdd(agent: Op['agent'], file: string, env: SetupEnv, force: boolean): Op {
  const mk = (action: PlanAction, reason: string, apply: () => void = () => {}): Op => ({ agent, file, action, reason, apply });
  const text = readText(file);
  if (text === null) {
    return mk('create', 'adds Spike to a new MCP config', () => write(file, JSON.stringify({ mcpServers: { spike: OUR_ENTRY } }, null, 2) + '\n'));
  }
  let obj: any;
  try { obj = text.trim() === '' ? {} : JSON.parse(text); } catch { return mk('skip', "the file isn't valid JSON, so it was left alone"); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return mk('skip', "the file isn't a JSON object, so it was left alone");
  if (obj.mcpServers !== undefined && (typeof obj.mcpServers !== 'object' || obj.mcpServers === null || Array.isArray(obj.mcpServers))) {
    return mk('skip', "its mcpServers section isn't an object, so it was left alone");
  }
  const existing = obj.mcpServers?.spike;
  if (existing !== undefined && same(existing, OUR_ENTRY)) return mk('skip', 'already set up');
  if (existing !== undefined && !force) return mk('conflict', 'a different "spike" entry is already there (use --force to replace it)');
  const indent = detectIndent(text);
  const nl = text.endsWith('\n') || text.trim() === '' ? '\n' : '';
  return mk('merge', existing !== undefined ? 'replaces the existing "spike" entry' : 'adds Spike alongside your other servers', () => {
    backup(env, file);
    obj.mcpServers = { ...(obj.mcpServers ?? {}), spike: OUR_ENTRY };
    write(file, JSON.stringify(obj, null, indent) + nl);
  });
}

function jsonRemove(agent: Op['agent'], file: string, env: SetupEnv): Op {
  const mk = (action: PlanAction, reason: string, apply: () => void = () => {}): Op => ({ agent, file, action, reason, apply });
  const text = readText(file);
  if (text === null) return mk('skip', 'nothing to remove');
  let obj: any;
  try { obj = JSON.parse(text); } catch { return mk('skip', "the file isn't valid JSON, so it was left alone"); }
  const existing = obj?.mcpServers?.spike;
  if (existing === undefined) return mk('skip', 'Spike is not in this file');
  if (!same(existing, OUR_ENTRY)) return mk('skip', 'the "spike" entry was changed by you, so it was left alone');
  const indent = detectIndent(text);
  const nl = text.endsWith('\n') ? '\n' : '';
  return mk('remove', 'removes only the Spike entry', () => {
    delete obj.mcpServers.spike;
    if (Object.keys(obj.mcpServers).length === 0) delete obj.mcpServers;
    if (Object.keys(obj).length === 0) fs.rmSync(file);
    else write(file, JSON.stringify(obj, null, indent) + nl);
  });
}

// ---------- fenced blocks (AGENTS.md markdown, config.toml) ----------

function blockRegion(text: string, begin: string, end: string): { start: number; stop: number } | null {
  const s = text.indexOf(begin);
  if (s < 0) return null;
  const e = text.indexOf(end, s);
  if (e < 0) return null;
  let stop = e + end.length;
  if (text[stop] === '\n') stop++;
  return { start: s, stop };
}

function blockAdd(agent: Op['agent'], file: string, env: SetupEnv, block: string, begin: string, end: string, force: boolean, tomlSpikeTable = false): Op {
  const mk = (action: PlanAction, reason: string, apply: () => void = () => {}): Op => ({ agent, file, action, reason, apply });
  const text = readText(file);
  if (text === null) return mk('create', 'adds a new file with the Spike block', () => write(file, block));
  const region = blockRegion(text, begin, end);
  if (region) {
    const current = text.slice(region.start, region.stop);
    if (current === block) return mk('skip', 'already set up');
    if (tomlSpikeTable && !force) return mk('conflict', 'the Spike block was edited (use --force to replace it)');
    return mk('merge', 'refreshes the Spike block', () => {
      backup(env, file);
      write(file, text.slice(0, region.start) + block + text.slice(region.stop));
    });
  }
  if (tomlSpikeTable && /^\s*\[mcp_servers\.spike\]/m.test(text)) {
    if (!force) return mk('conflict', 'a "spike" server is already defined here by hand (use --force to add ours anyway)');
    return mk('skip', 'a hand-written "spike" server exists; replacing it automatically is not supported');
  }
  return mk('merge', 'adds a Spike block at the end', () => {
    backup(env, file);
    const sep = text === '' ? '' : text.endsWith('\n') ? '\n' : '\n\n';
    write(file, text + sep + block);
  });
}

function blockRemove(agent: Op['agent'], file: string, begin: string, end: string, ours?: string): Op {
  const mk = (action: PlanAction, reason: string, apply: () => void = () => {}): Op => ({ agent, file, action, reason, apply });
  const text = readText(file);
  if (text === null) return mk('skip', 'nothing to remove');
  const region = blockRegion(text, begin, end);
  if (!region) return mk('skip', 'Spike is not in this file');
  if (ours !== undefined && text.slice(region.start, region.stop) !== ours) return mk('skip', 'the Spike block was edited by you, so it was left alone');
  return mk('remove', 'removes only the Spike block', () => {
    let start = region.start;
    if (start > 0 && text[start - 1] === '\n' && text[start - 2] === '\n') start--; // the blank separator we added
    const rest = text.slice(0, start) + text.slice(region.stop);
    if (rest.trim() === '') fs.rmSync(file);
    else write(file, rest);
  });
}

// ---------- whole files we own (SKILL.md, spike.mdc) ----------

function fileAdd(agent: Op['agent'], file: string, env: SetupEnv, content: string): Op {
  const mk = (action: PlanAction, reason: string, apply: () => void = () => {}): Op => ({ agent, file, action, reason, apply });
  const text = readText(file);
  if (text === null) return mk('create', 'adds the Spike instructions', () => write(file, content));
  if (text === content) return mk('skip', 'already set up');
  return mk('merge', 'updates the Spike instructions', () => { backup(env, file); write(file, content); });
}

function fileRemove(agent: Op['agent'], file: string, removeDir: boolean): Op {
  const mk = (action: PlanAction, reason: string, apply: () => void = () => {}): Op => ({ agent, file, action, reason, apply });
  if (!fs.existsSync(file)) return mk('skip', 'nothing to remove');
  return mk('remove', 'removes the Spike instructions', () => {
    fs.rmSync(file);
    if (removeDir) { try { fs.rmdirSync(path.dirname(file)); } catch { /* not empty (e.g. a backup) — keep */ } }
  });
}

// ---------- Claude Code's own CLI ----------

function claudeCli(env: SetupEnv, uninstall: boolean): Op {
  const label = 'claude mcp (user scope)';
  const mk = (action: PlanAction, reason: string, apply: () => void = () => {}): Op => ({ agent: 'claude', file: label, action, reason, apply });
  if (!env.hasBinary('claude')) return mk('skip', "the claude command wasn't found, so its MCP list wasn't changed (run: claude mcp add --scope user spike -- spike mcp)");
  const registered = env.run('claude', ['mcp', 'get', 'spike']).ok;
  if (uninstall) {
    if (!registered) return mk('skip', 'Spike is not registered');
    return mk('remove', 'removes the Spike server', () => {
      const r = env.run('claude', ['mcp', 'remove', '--scope', 'user', 'spike']);
      if (!r.ok) throw new Error('claude mcp remove failed');
    });
  }
  if (registered) return mk('skip', 'already set up');
  return mk('create', 'registers the Spike server', () => {
    const r = env.run('claude', ['mcp', 'add', '--scope', 'user', 'spike', '--', 'spike', 'mcp']);
    if (!r.ok) throw new Error('claude mcp add failed');
  });
}

// ---------- planning ----------

export function planSetup(o: SetupOptions): Op[] {
  const { env, agents } = o;
  const force = !!o.force;
  const has = (a: AgentId) => agents.includes(a);
  const ops: Op[] = [];
  const h = env.home, c = env.cwd;
  const add = (json: Op | null, rm: Op | null) => ops.push((o.uninstall ? rm : json) as Op);

  if (o.project) {
    if (has('claude')) {
      add(jsonAdd('claude', path.join(c, '.mcp.json'), env, force), jsonRemove('claude', path.join(c, '.mcp.json'), env));
      add(fileAdd('claude', path.join(c, '.claude', 'skills', 'spike', 'SKILL.md'), env, renderSkillMd()),
          fileRemove('claude', path.join(c, '.claude', 'skills', 'spike', 'SKILL.md'), true));
    }
    if (has('cursor')) {
      add(jsonAdd('cursor', path.join(c, '.cursor', 'mcp.json'), env, force), jsonRemove('cursor', path.join(c, '.cursor', 'mcp.json'), env));
      add(fileAdd('cursor', path.join(c, '.cursor', 'rules', 'spike.mdc'), env, renderCursorRule()),
          fileRemove('cursor', path.join(c, '.cursor', 'rules', 'spike.mdc'), false));
    }
    if (has('codex') || has('windsurf') || has('cursor')) {
      const f = path.join(c, 'AGENTS.md');
      const who = has('codex') ? 'codex' : has('windsurf') ? 'windsurf' : 'cursor';
      add(blockAdd(who, f, env, renderAgentsBlock(), BLOCK_BEGIN, BLOCK_END, force),
          blockRemove(who, f, BLOCK_BEGIN, BLOCK_END));
    }
    return ops;
  }

  if (has('claude')) {
    ops.push(claudeCli(env, !!o.uninstall));
    const f = path.join(h, '.claude', 'skills', 'spike', 'SKILL.md');
    add(fileAdd('claude', f, env, renderSkillMd()), fileRemove('claude', f, true));
  }
  if (has('cursor')) {
    const f = path.join(h, '.cursor', 'mcp.json');
    add(jsonAdd('cursor', f, env, force), jsonRemove('cursor', f, env));
  }
  if (has('windsurf')) {
    const f = path.join(h, '.codeium', 'windsurf', 'mcp_config.json');
    add(jsonAdd('windsurf', f, env, force), jsonRemove('windsurf', f, env));
  }
  if (has('codex')) {
    const t = path.join(h, '.codex', 'config.toml');
    add(blockAdd('codex', t, env, TOML_BLOCK, TOML_BEGIN, TOML_END, force, true), blockRemove('codex', t, TOML_BEGIN, TOML_END, TOML_BLOCK));
    const a = path.join(h, '.codex', 'AGENTS.md');
    add(blockAdd('codex', a, env, renderAgentsBlock(), BLOCK_BEGIN, BLOCK_END, force), blockRemove('codex', a, BLOCK_BEGIN, BLOCK_END));
  }
  if (has('gemini')) {
    const f = path.join(h, '.gemini', 'settings.json');
    add(jsonAdd('gemini', f, env, force), jsonRemove('gemini', f, env));
  }
  return ops;
}

export interface ApplyResult extends PlanItem { done: boolean; error?: string }

/** Runs the ops whose action changes something; skip/conflict are reported untouched. */
export function applyOps(ops: Op[]): ApplyResult[] {
  return ops.map((op) => {
    const { apply, ...item } = op;
    if (op.action === 'skip' || op.action === 'conflict') return { ...item, done: false };
    try { apply(); return { ...item, done: true }; }
    catch (e) { return { ...item, done: false, error: e instanceof Error ? e.message : String(e) }; }
  });
}
