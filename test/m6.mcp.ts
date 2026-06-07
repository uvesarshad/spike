/* M6 verification — MCP stdio smoke test using the SDK's own client against
 * the BUILT server (dist/mcp-server.js — run `npm run build` first).
 * Lists tools, then calls qa_run against the bug-on fixture and asserts the
 * slim verdict contract. One full driver run ≈ a few minutes on free quota. */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadConfig } from '../src/config.js';
import { startFixture, stopFixture } from '../fixture/server.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

const cfg = loadConfig();
const fixture = startFixture(cfg.fixturePort, true); // bug ON → expect a fail verdict

const client = new Client({ name: 'm6-smoke', version: '0.0.1' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/mcp-server.js'],
});

try {
  await client.connect(transport);

  const tools = await client.listTools();
  check('server lists qa_run', tools.tools.some((t) => t.name === 'qa_run'));

  console.log('calling qa_run over MCP (full driver run — takes a few minutes)…');
  const result = await client.callTool(
    { name: 'qa_run', arguments: { task: 'Log in as test@test.com with password pw, add the Widget to the cart, go to the cart, check out, and place the order. The order must end on a confirmation page.', url: `http://localhost:${cfg.fixturePort}/login` } },
    undefined,
    { timeout: 15 * 60 * 1000 },
  );

  const text = (result.content as { type: string; text: string }[])[0]?.text ?? '{}';
  console.log('qa_run returned:\n' + text);
  const verdict = JSON.parse(text) as Record<string, unknown>;

  check('verdict is fail (bug-on fixture)', verdict.verdict === 'fail');
  check(
    'slim contract fields present',
    ['verdict', 'failing_step', 'console_error', 'evidence_paths', 'reason'].every((k) => k in verdict),
  );
  check('payload is ~2K tokens, not a transcript', text.length < 8000);
} finally {
  await client.close().catch(() => {});
  await stopFixture(fixture);
}

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} MCP checks passed`);
process.exit(failed.length ? 1 : 0);
