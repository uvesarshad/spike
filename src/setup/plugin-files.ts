/* Claude Code plugin package (E2): the same skill + MCP registration `spike setup`
 * writes, laid out as a plugin so it can be installed from a plugin marketplace
 * (`/plugin marketplace add uvesarshad/spike` then `/plugin install spike@spike`).
 * Content comes from skill-content.ts so it can never drift; `npm run build:plugin`
 * writes these files and test v152 fails if the checked-in copies are stale. */

import { renderSkillMd } from './skill-content.js';

const MCP = { mcpServers: { spike: { command: 'spike', args: ['mcp'] } } };
const DESCRIPTION = 'Browser QA for your coding agent: checks in a real browser that a web change works and returns a short pass/fail verdict.';

/** Relative path (from the repo root) -> file text. */
export function pluginFiles(version: string): Record<string, string> {
  const json = (o: unknown) => JSON.stringify(o, null, 2) + '\n';
  return {
    'plugin/.claude-plugin/plugin.json': json({
      name: 'spike',
      version,
      description: DESCRIPTION,
      author: { name: 'Uves Arshad' },
      homepage: 'https://github.com/uvesarshad/spike#readme',
      repository: 'https://github.com/uvesarshad/spike',
      license: 'Apache-2.0',
      keywords: ['browser', 'qa', 'testing', 'mcp'],
    }),
    'plugin/.mcp.json': json(MCP),
    'plugin/skills/spike/SKILL.md': renderSkillMd(),
    '.claude-plugin/marketplace.json': json({
      name: 'spike',
      owner: { name: 'Uves Arshad' },
      plugins: [{ name: 'spike', source: './plugin', description: DESCRIPTION }],
    }),
  };
}
