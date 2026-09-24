/* MCP stdio server — the dev-mode front door. Five tools (qa_run, site_check,
 * tests_run, runs_list, run_get), each returning a slim result (qa_run:
 * verdict / failing_step / console_error / fix_hint / evidence_paths / reason —
 * ~2K tokens). The calling agent reads report.json from
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
import { createPlanningRouter, qaReplay, qaRun } from './engine.js';
import { batchLoginOnce, runOptionsFromContext } from './orchestrator/fan-out.js';
import { decomposeSpec, normalizeFlows, runFlows, MAX_FLOWS, type SpecFlow } from './driver/spec-decompose.js';
import { slimReport, type Report } from './report/report.js';
import { buildFixHint } from './vibe/fix-prompt.js';
import { isSafeRunId, listRuns, loadRunReport } from './report/run-store.js';
import { loadConfig, type QaConfig } from './config.js';
import { runSiteCheck, SiteCheckError, slimSiteCheck, type SiteCheckDeps } from './discovery/run-check.js';
import { runTests, validateTestsRunInput, type TestsRunDeps } from './suite/run-tests.js';

const text = (t: unknown, isError?: boolean) => ({
  content: [{ type: 'text' as const, text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }],
  ...(isError && { isError: true }),
});

/** Everything the tools touch outside this file, injectable so the tool surface
 * can be exercised in-process with stubs (no Chrome, no model calls). */
export interface McpDeps {
  qaRun: typeof qaRun;
  artifactsDir: () => string;
  siteCheckDeps?: SiteCheckDeps;
  testsRunDeps?: Partial<TestsRunDeps>;
}

/** Merge the caller's extra hosts onto the configured allow-list — same rule as
 * `--allow-host` on the CLI (extends, never replaces, the localhost defaults). */
function withAllowHosts(hosts: string[] | undefined): Partial<QaConfig> | undefined {
  if (!hosts?.length) return undefined;
  return { allowedHosts: [...loadConfig().allowedHosts, ...hosts] };
}

/** Builds the server with its five tools. Kept to five on purpose — every
 * tool's schema costs the calling agent context in every session. */
export function createMcpServer(deps: McpDeps = { qaRun, artifactsDir: () => loadConfig().artifactsDir }): McpServer {
  const server = new McpServer({ name: 'spike-agent', version: '0.0.1' });

  server.tool(
    'qa_run',
    'Run a browser test in real Chrome and get a compact verdict (pass/fail/uncertain, failing step, console error, ' +
      'fix_hint on fail). Verify UI changes: logins, forms, checkouts. Pass one of task, flows (array) or spec (document text). ' +
      "Naming url grants click/type authority on that site's host for this run; other hosts stay look-only unless listed in allowHosts.",
    {
      task: z
        .string()
        .optional()
        .describe(
          'what to test, in plain English (e.g. "log in with {{secret:TEST_USER}} / {{secret:TEST_PASSWORD}} and complete checkout"). ' +
            'Store passwords with `spike secret set`, never inline. Supply exactly one of task, flows, or spec.',
        ),
      flows: z
        .array(z.string())
        .min(1)
        .max(MAX_FLOWS)
        .optional()
        .describe(`several self-contained tasks you already split, each run separately against the same url (max ${MAX_FLOWS}).`),
      spec: z
        .string()
        .optional()
        .describe('raw text of a spec, PRD or story list; split into flows in one model call, each tested as its own run.'),
      url: z.string().url().describe('page to start on'),
      maxSteps: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe('actions allowed before giving up (default 40, max 200); a realistic flow costs 5-10. For long journeys prefer `flows`.'),
      expect: z
        .string()
        .optional()
        .describe('what should be true when done, in plain English (e.g. "the cart shows 2 items"); checked against the page; it applies to every flow.'),
      readOnly: z
        .boolean()
        .optional()
        .describe('look-only: navigate and check but never click, type or submit. Default false.'),
      storageState: z
        .string()
        .optional()
        .describe('path to a saved signed-in session file, loaded before the run so it starts logged in.'),
      allowHosts: z
        .array(z.string())
        .optional()
        .describe('extra hosts the run may click/type on beyond the url host (OAuth or checkout domains).'),
      budgetUsd: z
        .number()
        .positive()
        .optional()
        .describe('with flows or spec: stop once this much is spent; remaining flows are skipped (result uncertain).'),
    },
    async ({ task, url, flows, spec, maxSteps, readOnly, expect, storageState, allowHosts, budgetUsd }) => {
      const config = withAllowHosts(allowHosts);
      const runOpts = {
        maxSteps,
        ...(readOnly !== undefined && { readOnly }),
        // A17 (P1): the caller's own success sentence, checked rather than eyeballed.
        ...(expect?.trim() && { expectations: expect.trim() }),
        ...(storageState?.trim() && { storageStatePath: storageState.trim() }),
        ...(config && { config }),
      };
      const given = [task, flows, spec].filter((v) => v !== undefined).length;
      if (given !== 1) {
        return text('Supply exactly one of: task (one plain-English instruction), flows (an array of instructions), or spec (the text of a document).', true);
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
        // A11: log in once per batch when the caller supplied no session.
        const loginOnce = storageState?.trim() ? undefined : batchLoginOnce(deps.artifactsDir());
        const outcome = await runFlows(list, {
          runFlow: (flow, _i, ctx) => {
            const c = runOptionsFromContext(ctx);
            return deps.qaRun(flow.task, url, {
              ...runOpts,
              ...(c.storageStatePath && { storageStatePath: c.storageStatePath }),
              ...(c.saveStorageStatePath && { saveStorageStatePath: c.saveStorageStatePath }),
              ...(c.config && { config: { ...runOpts.config, ...c.config } }),
            });
          },
          ...(storageState?.trim() && { storageStatePath: storageState.trim() }),
          ...(loginOnce && { loginOnce }),
          ...(budgetUsd !== undefined && { budgetUsd }),
        });
        return text(outcome); // a failing TEST is a successful TOOL call
      }

      const report = await deps.qaRun(task as string, url, runOpts);
      return text(slimReport(report));
    },
  );

  server.tool(
    'site_check',
    'Check a whole site with no instructions: walks the pages it can reach, looks at each (look-only, never clicks), ' +
      'and returns verdict, pages checked and up to 20 problems. Use after a change to catch broken pages.',
    {
      url: z.string().url().describe('address to start from; the check stays on this site'),
      maxPages: z.number().int().min(1).max(50).optional().describe('how many pages to look at (default 20)'),
      storageState: z.string().optional().describe('path to a saved signed-in session, so signed-in pages are checked'),
      budgetUsd: z.number().positive().optional().describe('spend cap in USD for the whole check; remaining pages are skipped once it is reached'),
    },
    async ({ url, maxPages, storageState, budgetUsd }) => {
      try {
        const r = await runSiteCheck(
          url,
          { maxPages, storageState: storageState?.trim() || undefined, budgetUsd },
          deps.siteCheckDeps,
        );
        return text(slimSiteCheck(r));
      } catch (e) {
        if (e instanceof SiteCheckError) return text(e.message, true);
        throw e;
      }
    },
  );

  server.tool(
    'tests_run',
    'Re-run saved tests: recorded scripts replay at $0, plain-English cases get an AI pass. Give exactly one of name, tag or all. ' +
      'Returns per-test verdicts (failures first) and one aggregate. heal re-engages the AI on a failing recorded script.',
    {
      name: z.string().optional().describe('one saved test by name'),
      tag: z.string().optional().describe('every test carrying this tag'),
      all: z.boolean().optional().describe('every test in the suite'),
      url: z.string().url().optional().describe('override the address plain-English cases run against'),
      heal: z.boolean().optional().describe('on failure, let the AI repair and re-save the script'),
      budgetUsd: z.number().positive().optional().describe('stop the batch (remaining tests uncertain) once this much is spent'),
    },
    async (input) => {
      const bad = validateTestsRunInput(input);
      if (bad) return text(bad, true);
      const real: TestsRunDeps = {
        replay: (script, o) =>
          qaReplay(script, { heal: o.heal, ...(o.spendCapUsd && { config: { spendCapUsd: o.spendCapUsd } }) }),
        runCase: (c, o) =>
          deps.qaRun(c.task, o.url, { ...(o.spendCapUsd && { config: { spendCapUsd: o.spendCapUsd } }) }),
        ...deps.testsRunDeps,
      };
      try {
        return text(await runTests(input, real, buildFixHint));
      } catch (e) {
        return text(e instanceof Error ? e.message : String(e), true);
      }
    },
  );

  server.tool(
    'runs_list',
    'List recent test runs, newest first: runId, when, url, task, verdict. Use to find a run to open with run_get.',
    { limit: z.number().int().min(1).max(20).optional().describe('how many runs (default 10, max 20)') },
    async ({ limit }) => {
      const runs = listRuns(deps.artifactsDir(), limit ?? 10).map(({ runId, when, url, task, verdict }) => ({ runId, when, url, task, verdict }));
      return text(runs);
    },
  );

  server.tool(
    'run_get',
    'Get the compact result of one past run by runId (verdict, failing step, console error, fix_hint on fail, evidence paths).',
    { runId: z.string().describe('a runId from runs_list') },
    async ({ runId }) => {
      if (!isSafeRunId(runId)) return text('That is not a valid run id.', true);
      const report = loadRunReport(deps.artifactsDir(), runId) as Report | undefined;
      if (!report) return text(`No run found with id ${runId}.`, true);
      return text(slimReport(report));
    },
  );

  return server;
}

export async function startMcpServer(): Promise<void> {
  const server = createMcpServer();
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
