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
import { createPlanningRouter, qaRun } from './engine.js';
import { decomposeSpec, normalizeFlows, runFlows, MAX_FLOWS, type SpecFlow } from './driver/spec-decompose.js';
import { slimReport } from './report/report.js';

export async function startMcpServer(): Promise<void> {
  const server = new McpServer({ name: 'spike-agent', version: '0.0.1' });

  server.tool(
    'qa_run',
    'Run an autonomous browser QA test: a cheap-model ladder drives a real Chrome against the URL, ' +
      'performs the task, and returns a compact verdict with evidence file paths. ' +
      'Use it to verify UI changes actually work (login flows, forms, checkouts, rendering). ' +
      'For more than one thing at once, pass `flows` (an array of instructions you split yourself) or `spec` ' +
      '(the raw text of a spec/PRD/story list, which is split into flows for you); each flow is tested as its own ' +
      'run and the result carries a per-flow verdict plus one overall verdict. ' +
      "Security note: naming a URL here grants real click/type authority on it for this run — the URL's host " +
      '(plus its www./bare-domain sibling) is automatically trusted for mutation with no further confirmation. ' +
      'Other hosts (ad iframes, OAuth redirects, surprise 3rd-party redirects) default-deny mutation unless ' +
      'separately allow-listed via the allowHost config option or the SPIKE_ALLOWED_HOSTS env var.',
    {
      task: z
        .string()
        .optional()
        .describe(
          'what to test, in plain English (e.g. "log in as x@y.z / pw and complete checkout"). ' +
            'Supply exactly one of task, flows, or spec.',
        ),
      flows: z
        .array(z.string())
        .min(1)
        .max(MAX_FLOWS)
        .optional()
        .describe(
          'several flows you have already split yourself — each string is one self-contained task, tested as its own run ' +
            `against the same url (max ${MAX_FLOWS}). The result carries a per-flow verdict plus one overall verdict.`,
        ),
      spec: z
        .string()
        .optional()
        .describe(
          'the raw text of a document (a spec, a PRD, a list of user stories). It is turned into a list of flows in one ' +
            'model call, and each flow is then tested as its own run against the same url.',
        ),
      url: z.string().url().describe('page to start on'),
      maxSteps: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe(
          'how many actions the test may take before it gives up (default 40, max 200). ' +
            'One realistic flow costs 5-10 actions, so raise this for a long or multi-page journey ' +
            '— or split the work across `flows`, which gives each flow its own budget.',
        ),
      readOnly: z
        .boolean()
        .optional()
        .describe(
          'look-only mode: navigate and check the page but never click, type, or submit. ' +
            'Defaults to false because naming a url here already grants click/type authority on it; ' +
            'set true to inspect a page without changing anything.',
        ),
    },
    async ({ task, url, flows, spec, maxSteps, readOnly }) => {
      const runOpts = { maxSteps, ...(readOnly !== undefined && { readOnly }) };
      const given = [task, flows, spec].filter((v) => v !== undefined).length;
      if (given !== 1) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Supply exactly one of: task (one plain-English instruction), flows (an array of instructions), or spec (the text of a document).',
            },
          ],
          isError: true,
        };
      }

      // A7 (P0): many flows — pre-split by the caller, or derived from a
      // document in ONE planning call — each tested as its own budgeted run,
      // then rolled into a single verdict (fail beats uncertain beats pass).
      if (flows || spec) {
        let list: SpecFlow[];
        if (flows) {
          list = normalizeFlows(flows);
        } else {
          const router = createPlanningRouter();
          list = await decomposeSpec(spec as string, {
            planFlows: (prompt, schema, step) => router.planGoals(prompt, schema, step),
            url,
          });
        }
        const outcome = await runFlows(list, {
          runFlow: (flow) => qaRun(flow.task, url, runOpts),
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(outcome, null, 2) }],
          isError: undefined, // a failing TEST is a successful TOOL call
        };
      }

      const report = await qaRun(task as string, url, runOpts);
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
