/* MCP stdio server — the dev-mode front door. One tool, qa_run, returning the
 * slim verdict (verdict / failing_step / console_error / evidence_paths /
 * reason — ~2K tokens). The calling agent reads report.json from
 * evidence_paths when it wants the full step-by-step evidence.
 *
 * Register in a coding agent as: command "spike", args ["mcp"]
 * (or: npx tsx src/mcp-server.ts during development). */

import './env-compat.js'; // aliases legacy QA_* env vars onto SPIKE_* — must precede any env read
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
// audit-note (A37): `npm audit` flags transitive vulns in this SDK's HTTP-transport deps.
// We only import/use the stdio transport below (StdioServerTransport) — that code path is
// never loaded, so those findings are unreachable at runtime. See SECURITY.md.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { qaRun } from './engine.js';
import { slimReport } from './report/report.js';

export async function startMcpServer(): Promise<void> {
  const server = new McpServer({ name: 'spike-agent', version: '0.0.1' });

  server.tool(
    'qa_run',
    'Run an autonomous browser QA test: a cheap-model ladder drives a real Chrome against the URL, ' +
      'performs the task, and returns a compact verdict with evidence file paths. ' +
      'Use it to verify UI changes actually work (login flows, forms, checkouts, rendering). ' +
      "Security note: naming a URL here grants real click/type authority on it for this run — the URL's host " +
      '(plus its www./bare-domain sibling) is automatically trusted for mutation with no further confirmation. ' +
      'Other hosts (ad iframes, OAuth redirects, surprise 3rd-party redirects) default-deny mutation unless ' +
      'separately allow-listed via the allowHost config option or the SPIKE_ALLOWED_HOSTS env var.',
    {
      task: z.string().describe('what to test, in plain English (e.g. "log in as x@y.z / pw and complete checkout")'),
      url: z.string().url().describe('page to start on'),
      maxSteps: z.number().int().min(1).max(30).optional().describe('driver step budget (default 12)'),
      readOnly: z
        .boolean()
        .optional()
        .describe(
          'look-only mode: navigate and check the page but never click, type, or submit. ' +
            'Defaults to false because naming a url here already grants click/type authority on it; ' +
            'set true to inspect a page without changing anything.',
        ),
    },
    async ({ task, url, maxSteps, readOnly }) => {
      const report = await qaRun(task, url, { maxSteps, ...(readOnly !== undefined && { readOnly }) });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(slimReport(report), null, 2) }],
        isError: report.verdict === 'fail' ? false : undefined, // a failing TEST is a successful TOOL call
      };
    },
  );

  await server.connect(new StdioServerTransport());
}

// started directly (not imported by the CLI)
const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('mcp-server.js') ||
  process.argv[1]?.replace(/\\/g, '/').endsWith('mcp-server.ts');
if (isMain) {
  startMcpServer().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
