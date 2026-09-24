/* V121 — the agent instruction renderings (A2). */
import { renderSkillMd, renderAgentsBlock, renderCursorRule, skillBody, BLOCK_BEGIN, BLOCK_END } from '../src/setup/skill-content.js';

const checks: [string, boolean][] = [];
const check = (l: string, ok: boolean) => { checks.push([l, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}`); };

const skill = renderSkillMd(), block = renderAgentsBlock(), rule = renderCursorRule();
check('SKILL.md has name: spike frontmatter', /^---\nname: spike\ndescription: .+\n---/.test(skill));
check('description is trigger-rich', /real browser/.test(skill) && /before you say it is done/.test(skill));
check('AGENTS block is fenced', block.startsWith(BLOCK_BEGIN) && block.trimEnd().endsWith(BLOCK_END));
check('cursor rule is description-triggered (alwaysApply false)', /alwaysApply: false/.test(rule) && /^---\ndescription: /.test(rule));
for (const [n, t] of [['skill', skill], ['block', block], ['rule', rule]] as const) {
  check(`${n} has the secret rule`, /spike secret set/.test(t) && /\{\{secret:NAME\}\}/.test(t));
  check(`${n} has no inline credential example`, !/\S+@\S+\s*\/\s*\S+/.test(t) && !/password\s*[:=]\s*\S/i.test(t));
  check(`${n} covers both MCP and CLI paths`, /qa_run/.test(t) && /spike run "<one-sentence task>" --url <url> --json/.test(t));
  check(`${n} covers fail + uncertain handling`, /fix_hint/.test(t) && /Never claim success/.test(t));
}
check('body under 400 words', skillBody().split(/\s+/).length < 400);

const failed = checks.filter(([, ok]) => !ok);
console.log(`\nv121: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) { console.error('FAILED: ' + failed.map(([l]) => l).join(', ')); process.exit(1); }
