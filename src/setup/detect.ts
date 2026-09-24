/* Agent detection for `spike setup` (A2). Pure over an injected home dir and
 * PATH lookup, so tests run against a temp home and never see real configs. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type AgentId = 'claude' | 'cursor' | 'windsurf' | 'codex' | 'gemini';
export const ALL_AGENTS: AgentId[] = ['claude', 'cursor', 'windsurf', 'codex', 'gemini'];

export interface DetectedAgent {
  agent: AgentId;
  installed: boolean;
  /** Where the user-scope MCP registration lives (undefined when a CLI owns it). */
  userConfigPath: string;
  /** Project-scope MCP config relative to the project root, or null when the agent has none. */
  projectConfigPath: string | null;
  supportsSkills: boolean;
}

export interface DetectEnv {
  home: string;
  /** True when `bin` resolves on PATH. */
  hasBinary: (bin: string) => boolean;
}

export function realHasBinary(bin: string, pathVar = process.env.PATH ?? ''): boolean {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        fs.accessSync(path.join(dir, bin + ext), fs.constants.X_OK);
        return true;
      } catch { /* keep looking */ }
    }
  }
  return false;
}

export function defaultDetectEnv(): DetectEnv {
  return { home: os.homedir(), hasBinary: (b) => realHasBinary(b) };
}

const isDir = (p: string): boolean => {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
};

export function detectAgents(env: DetectEnv = defaultDetectEnv()): DetectedAgent[] {
  const h = env.home;
  return [
    {
      agent: 'claude',
      installed: env.hasBinary('claude') || isDir(path.join(h, '.claude')),
      userConfigPath: path.join(h, '.claude', 'skills', 'spike', 'SKILL.md'),
      projectConfigPath: '.mcp.json',
      supportsSkills: true,
    },
    {
      agent: 'cursor',
      installed: isDir(path.join(h, '.cursor')),
      userConfigPath: path.join(h, '.cursor', 'mcp.json'),
      projectConfigPath: path.join('.cursor', 'mcp.json'),
      supportsSkills: false,
    },
    {
      agent: 'windsurf',
      installed: isDir(path.join(h, '.codeium', 'windsurf')),
      userConfigPath: path.join(h, '.codeium', 'windsurf', 'mcp_config.json'),
      projectConfigPath: null,
      supportsSkills: false,
    },
    {
      agent: 'codex',
      installed: env.hasBinary('codex') || isDir(path.join(h, '.codex')),
      userConfigPath: path.join(h, '.codex', 'config.toml'),
      projectConfigPath: null,
      supportsSkills: false,
    },
    {
      agent: 'gemini',
      installed: isDir(path.join(h, '.gemini')),
      userConfigPath: path.join(h, '.gemini', 'settings.json'),
      projectConfigPath: null,
      supportsSkills: false,
    },
  ];
}
