/* V152 — Claude Code plugin package (E2): checked-in files match the generator and reuse the skill text. */
import fs from 'node:fs';
import { pluginFiles } from '../src/setup/plugin-files.js';
import { renderSkillMd } from '../src/setup/skill-content.js';

const check = (l: string, ok: boolean) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}`); if (!ok) process.exitCode = 1; };
const root = new URL('../', import.meta.url);
const version = JSON.parse(fs.readFileSync(new URL('package.json', root), 'utf8')).version;
const files = pluginFiles(version);

for (const [rel, text] of Object.entries(files)) {
  let onDisk: string | null = null;
  try { onDisk = fs.readFileSync(new URL(rel, root), 'utf8'); } catch { /* missing */ }
  check(`${rel} is up to date (run: npm run build:plugin)`, onDisk === text);
}
check('the plugin skill is exactly the setup skill', files['plugin/skills/spike/SKILL.md'] === renderSkillMd());
check('the plugin skill keeps the secrets rule', /\{\{secret:NAME\}\}/.test(files['plugin/skills/spike/SKILL.md']));
const mcp = JSON.parse(files['plugin/.mcp.json']);
check('MCP registration runs `spike mcp`', mcp.mcpServers.spike.command === 'spike' && mcp.mcpServers.spike.args[0] === 'mcp');
const manifest = JSON.parse(files['plugin/.claude-plugin/plugin.json']);
check('plugin version tracks package.json', manifest.version === version);
const market = JSON.parse(files['.claude-plugin/marketplace.json']);
check('marketplace points at the plugin folder', market.plugins[0].source === './plugin' && market.plugins[0].name === manifest.name);
const pkg = JSON.parse(fs.readFileSync(new URL('package.json', root), 'utf8'));
check('plugin folders ship in the package', pkg.files.includes('plugin') && pkg.files.includes('.claude-plugin'));
