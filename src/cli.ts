/* `spike` CLI — thin wrapper over the engine; the MCP server shares the same core.
 * Subcommands grow with the milestones: run, mcp, nano, fixture. */

import './env-compat.js'; // aliases legacy QA_* env vars onto SPIKE_* — must precede any env read
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import readline from 'node:readline';
import { Command } from 'commander';
import os from 'node:os';
import { loadConfig, type QaConfig } from './config.js';
import { exitCodeForVerdict, INFRA_ERROR_EXIT_CODE } from './cli-exit-codes.js';
import { NanoRunnerPage } from './ports/nano-runner-page.js';
import { allocateIsolatedSession, createPlanningRouter, injectStorageState, isQuarantined, loadStorageStateFile, openBrowserSession, qaReplay, qaRun, type QaReplayResult } from './engine.js';
import { decomposeSpec, flowsFromRoutes, renderFlowTable, runFanOut, runFlows } from './driver/spec-decompose.js';
import { batchLoginOnce, renderSpendLine, runOptionsFromContext, type FanOutContext } from './orchestrator/fan-out.js';
import { SpendBudget, formatUsd, guardRuns, parseBudgetFlag, resolveCiBudget, resolveUnattendedBudget, withSpendCap } from './orchestrator/budget.js';
import { startDashboard, isLoopbackHost, DASHBOARD_DEFAULT_PORT } from './dashboard/server.js';
import { openInBrowser } from './dashboard/open.js';
import { headlineScreenshot, slimReport, type Report } from './report/report.js';
import { findChrome } from './chrome/launch.js';
import { buildDoctorReport, doctorExitCode, renderDoctorReport, type DoctorRoleProbe } from './doctor.js';
import type { Capability } from './router/adapter.js';
import type { LadderStatus } from './router/model-router.js';
import { applyExpectation, resolveSuite, skipsForMissingAuth, SUITE_CONFIG_FILENAME, type SuiteCase, type SuiteEntry } from './suite/config.js';
import { runSuite, filterByTags, filterByString, parseShard, shardEntries, type RunOneResult, type SuiteScriptResult } from './suite/runner.js';
import { isSuiteReporter, writeSuiteReport, SUITE_REPORTERS } from './suite/reporters.js';
import { DEFAULT_BASELINE_DIR, blessBaseline } from './assertions/differential.js';
import { runChangedPages } from './discovery/run-changed.js';
import { acceptHeal, listHealCandidates, listSavedTests, quarantineTest, rejectHeal, releaseTest } from './recorder/tests-admin.js';
import { JobStore } from './schedule/store.js';
import { isDue, nextDue } from './schedule/when.js';
import { runJob, startScheduler } from './schedule/scheduler.js';
import { childRunner } from './schedule/job-runner.js';
import { notifyIfFlipped } from './schedule/notify.js';
import { WatchController, startFsWatch } from './schedule/watch.js';
import { browserFetcher, checkInstruction, checkTargets, coverageReport, DEFAULT_CHECK_PAGES, diffAppModel, discoverApp, emptyAppModel, explorationOptions, hasBlockingFindings, loadAppModel, renderCheckSummary, saveAppModel, type AppModel, type AppModelFinding, type Fetched } from './discovery/index.js';
import { labelSuiteItems } from './suite/run-tests.js';
import { buildSiteMap, runSiteCheck, SiteCheckError } from './discovery/run-check.js';
import { BridgeServer } from './bridge/bridge-server.js';
import { VibeService } from './vibe/service.js';
import { installService, uninstallService } from './service/install-service.js';
import { buildFixPrompt, renderPlainReport } from './vibe/fix-prompt.js';
import { dispatchFix, runWithAutoFix } from './vibe/auto-fix.js';
import { Vault } from './vault/vault.js';
import { SettingsStore, defaultModelFor, type ProviderId, type PlannerMode, type DebugMode, type DebugAgent, type QaSettings, type PlannerSelection } from './vibe/settings.js';
import { startFixture } from '../fixture/server.js';

const PROVIDERS: ProviderId[] = ['nano', 'gemini', 'claude', 'gpt', 'ollama', 'openrouter', 'glm'];
const PLANNER_MODES: PlannerMode[] = ['api', 'cli'];
/** The navigator may additionally be the on-device model, which the brain can
 * never be (Nano does visual verdicts + plan-step, never plan-goals). */
const NAVIGATOR_MODES: PlannerMode[] = ['api', 'cli', 'ondevice'];
const DEBUG_MODES: DebugMode[] = ['prompt', 'auto'];
const DEBUG_AGENTS: DebugAgent[] = ['auto', 'claude', 'codex', 'gemini'];

/** Provider → encrypted-vault secret name for its API key. */
const VAULT_KEY_NAMES: Partial<Record<ProviderId, string>> = {
  gemini: 'gemini',
  claude: 'anthropic',
  gpt: 'openai',
  openrouter: 'openrouter',
  glm: 'glm',
};

/** One model role as `config show` prints it. A21: both roles are shown, by
 * their real names — the old output printed only the brain, under a heading
 * ("Browsing-control AI (planner)") that described the NAVIGATOR's job. */
function printRole(title: string, sel: PlannerSelection, role: 'navigator' | 'brain'): void {
  const { provider, mode, model } = sel;
  const modelLine = model && model.length ? model : `(default: ${defaultModelFor(provider, mode, role) || 'none'})`;
  console.log(`${title}:`);
  console.log(`  provider:   ${provider}`);
  console.log(`  mode:       ${mode}`);
  console.log(`  model:      ${modelLine}`);
}

/** Render the settings (both model roles + debug prefs + which API keys are
 * configured + the RESOLVED run config) as a readable block. Shared by
 * `config show` and `config set`. Never prints key values.
 *
 * "Navigator"/"Brain" are the literal headings on purpose: this is the expert
 * CLI surface, which already uses that vocabulary everywhere, not the panel
 * copy the §1.5 jargon ban is about. */
function printSettings(s: QaSettings): void {
  const vault = new Vault();
  printRole('Navigator (the model that clicks)', s.navigator, 'navigator');
  printRole('Brain (the model that plans)', s.planner, 'brain');
  console.log('Debugging:');
  console.log(`  debugMode:  ${s.debugMode}`);
  console.log(`  debugAgent: ${s.debugAgent}`);
  // A21: the effective run config — flags > env > settings.json >
  // spike.config.json > defaults, all five layers already collapsed by
  // loadConfig(). Without this there was no single place to see what a run
  // would actually be allowed to do.
  const cfg = loadConfig();
  console.log('What a run would do (effective config):');
  console.log(`  look-only mode:   ${cfg.readOnly ? 'on — never clicks or types' : 'off — may click and type'}`);
  console.log(`  drives Chrome by: ${cfg.via}`);
  console.log(`  sites allowed:    ${cfg.allowedHosts.join(', ') || '(none)'} — plus whatever host you name with --url`);
  console.log(`  strict checks:    ${cfg.strictOracles ? 'on — a failed check forces a fail verdict' : 'off — the model alone decides'}`);
  console.log(`  email codes:      ${cfg.emailProvider === 'imap' ? `inbox at ${cfg.imapHost ?? '(no host set)'}` : cfg.emailProvider === 'none' ? 'off' : cfg.emailProvider}`);
  console.log('API keys (in encrypted vault):');
  for (const p of PROVIDERS) {
    const name = VAULT_KEY_NAMES[p];
    if (!name) continue;
    const status = vault.get(name) !== undefined ? 'set' : 'not set';
    console.log(`  ${p} (${name}): ${status}`);
  }
}

/** Shared `--reporter <type> --out <path>` handling for `spike suite` and
 * `spike replay --all`. Exits 2 on a bad/incomplete flag combination rather
 * than carrying on: the whole point of A22 is that asking for a CI artifact
 * and not getting one must never pass quietly. */
function emitSuiteReport(outcome: Parameters<typeof writeSuiteReport>[0], reporter: string | undefined, out: string | undefined, suiteName: string): void {
  if (!reporter) return;
  if (!isSuiteReporter(reporter)) {
    console.error(`unknown --reporter "${reporter}" — expected one of: ${SUITE_REPORTERS.join(', ')}`);
    process.exit(2);
  }
  if (!out) {
    console.error(`--reporter ${reporter} requires --out <path>`);
    process.exit(2);
  }
  console.error(`wrote ${reporter} report to ${writeSuiteReport(outcome, reporter, out, suiteName)}`);
}

/* ---------------------------------------------------------------------------
 * `spike doctor` (A21) — the preflight. Everything that has to touch the real
 * machine happens HERE; src/doctor.ts turns the resulting snapshot into ✓/✗
 * lines and is unit-tested on its own with stubbed probes.
 * ------------------------------------------------------------------------ */

/** On-device model availability, best-effort and time-boxed. Starting the
 * runner page launches Chrome, so a machine with no Chrome (or a slow cold
 * start) must degrade to "couldn't check" rather than hanging the preflight. */
async function probeNano(cfg: QaConfig, timeoutMs = 45_000): Promise<{ availability?: string; error?: string }> {
  const nano = new NanoRunnerPage({ cdpPort: cfg.cdpPort, runnerPort: cfg.runnerPort, profileDir: cfg.chromeProfile });
  let timer: NodeJS.Timeout | undefined;
  try {
    const availability = await Promise.race([
      (async () => {
        await nano.start();
        return nano.availability();
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
      }),
    ]);
    return { availability };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  } finally {
    if (timer) clearTimeout(timer);
    await nano.close().catch(() => {});
  }
}

/** Turn the configured roles + a live ladder probe into the three role rows
 * `spike doctor` prints. Pure enough to follow at a glance; the ✓/✗ decisions
 * themselves all live in src/doctor.ts. */
function buildRoleProbes(cfg: QaConfig, ladder: LadderStatus, nanoAvailable: boolean): DoctorRoleProbe[] {
  const byName = new Map(ladder.adapters.map((a) => [a.name, a]));
  const roleProbe = (role: 'navigator' | 'brain', sel: PlannerSelection, pinName: string | undefined, cap: Capability): DoctorRoleProbe => {
    const pin = `${sel.provider}:${sel.mode}`;
    const model = sel.model || defaultModelFor(sel.provider, sel.mode, role) || undefined;
    const adapter = pinName ? byName.get(pinName) : undefined;
    // An on-device pin is not a ladder adapter at all — its availability is the
    // Nano probe's answer, not an adapter's available().
    const onDevice = sel.provider === 'nano';
    const available = onDevice ? nanoAvailable : Boolean(adapter?.available);
    if (available) return { role, pin, adapter: pinName, ...(model && { model }), available: true };
    const fallback = ladder.adapters.find((a) => a.available && a.capabilities.includes(cap) && a.name !== pinName);
    return {
      role,
      pin,
      adapter: pinName,
      ...(model && { model }),
      available: false,
      reason: onDevice ? 'the on-device model is not ready' : adapter ? 'not reachable (no key, or the CLI is not on your PATH)' : 'not configured',
      ...(fallback && { fallback: fallback.name }),
    };
  };

  const visualLadder = ladder.adapters.filter((a) => a.capabilities.includes('visual-verdict'));
  const visualLive = visualLadder.find((a) => a.available);
  const visual: DoctorRoleProbe = nanoAvailable
    ? { role: 'visual', pin: 'the on-device model', available: true }
    : visualLive
      ? { role: 'visual', pin: visualLive.name, available: true }
      : { role: 'visual', pin: 'none configured', available: false, reason: 'no vision model is reachable' };

  return [
    roleProbe('navigator', cfg.navigator, ladder.navigatorPin, 'plan-step'),
    roleProbe('brain', cfg.planner, ladder.brainPin, 'plan-goals'),
    visual,
  ];
}

const program = new Command();
program.name('spike').description('Spike — a cheap-model ladder tests your app in a real Chrome and reports a verdict');

/** Commander collector for a repeatable string flag (--allow-host, --tag). */
function collectRepeatable(value: string, previous: string[]): string[] {
  return previous.concat(value);
}

/** Build the QaConfig override from the run/replay flags. Returns undefined when
 * nothing was supplied (so callers can `...(config && { config })`).
 *  - --via sets the transport.
 *  - --allow-host appends to (does NOT replace) the configured allowedHosts, so
 *    the localhost/127.0.0.1 defaults stay in place and the flag opens up extra
 *    hosts for click/type just for this run. */
function mergeConfig(
  via: 'cdp' | 'extension' | 'playwright' | undefined,
  hosts: string[],
  actionCache?: boolean,
  baseline?: { baseline?: boolean; failOnRegression?: boolean },
): Partial<QaConfig> | undefined {
  const config: Partial<QaConfig> = {};
  // A10: --baseline turns the differential check on; --fail-on-regression
  // needs it, so it implies it.
  if (baseline?.baseline || baseline?.failOnRegression) config.differential = true;
  if (baseline?.failOnRegression) config.failOnRegression = true;
  if (via) config.via = via;
  if (hosts.length) config.allowedHosts = [...loadConfig().allowedHosts, ...hosts];
  if (actionCache !== undefined) config.actionCache = actionCache;
  return Object.keys(config).length ? config : undefined;
}

program
  .command('run')
  .description('run a QA task against a URL; exit 0 pass / 1 verdict fail / 2 uncertain / 3 infra or tool error')
  .argument('[task]', 'what to test, in plain English (omit it when you pass --spec)')
  .requiredOption('--url <url>', 'page to start on')
  .option('--spec <path>', 'test a document instead of one sentence: reads a markdown/text file (a spec, a PRD, a list of user stories), works out the flows it describes, and tests each one as its own run')
  .option('--max-steps <n>', 'driver step budget', (v) => parseInt(v, 10))
  // A36: the per-goal budget was reachable only from the config file or the
  // environment. It is the knob that decides how long one part of a task may
  // grind before the smarter model is asked to re-think, so it belongs next to
  // --max-steps where anyone tuning a run will look.
  .option('--per-goal-max-steps <n>', 'how many steps one part of the task may take before the smarter model is asked to re-plan (default 12, never more than --max-steps)', (v) => parseInt(v, 10))
  .option('--expect <text>', 'what should be true once the task is done, in plain English (e.g. "the cart shows 2 items and the total reads $49.99"). Each one is checked against the page instead of being eyeballed, so the verdict is about your wording, not a general look at the page')
  .option('--via <transport>', 'cdp (default) | extension | playwright — how to drive Chrome')
  .option('--allow-host <host>', 'permit clicks/typing on an EXTRA host beyond --url\'s own (repeatable) — --url\'s host is trusted automatically. Matches the exact host or its www. sibling only; prefix with "." (e.g. ".example.com") to also trust every subdomain', collectRepeatable, [])
  .option('--action-cache', 'enable the verified file-backed action cache for this run')
  .option('--no-action-cache', 'bypass the verified action cache for this run')
  .option('--read-only', 'look-only mode: navigate and check the page, but never click, type, or submit. Off by default when you name a --url (naming the target is your go-ahead to drive it)', false)
  .option('--no-record', 'do not record a passing run to generated-tests/')
  .option('--no-replay', 'skip the pre-run replay matcher — always run a fresh AI pass, even if a recorded script confidently matches this task+url')
  .option('--headless', 'run Chrome headless — skips the opportunistic $0 Nano rung for this run (see CLAUDE.md); replay is the well-tested headless path', false)
  .option('--storage-state <path>', 'load cookies + localStorage from this file before running (auth reuse — see `spike replay --save-storage-state`)')
  .option('--save-storage-state <path>', 'on a PASSING run, save cookies + localStorage to this file')
  .option('--fix', 'on failure, hand the fix prompt to your coding agent (claude/codex/gemini) and re-test', false)
  .option('--max-fix-attempts <n>', 'test→fix→retest rounds with --fix (default 2)', (v) => parseInt(v, 10))
  .option('--fix-on-uncertain', 'with --fix: also hand the fix prompt over when the result is "uncertain" (default: only when the test failed)', false)
  .option('--rebuild-timeout <seconds>', 'with --fix, a site that is not on localhost: how long to wait for your change to show up before re-testing (default 180)', (v) => parseInt(v, 10))
  .option('--wait-for-url <url>', 'with --fix: after your coding agent finishes, wait until this address answers before re-testing (e.g. a deploy health check)')
  .option('--yes-auto-fix', 'pre-accept the one-time per-project auto-fix consent for this non-interactive run', false)
  .option('--baseline', 'compare the finished page against this flow\'s stored baseline (the first run stores it); differences are reported as evidence, the verdict is unchanged', false)
  .option('--fail-on-regression', 'with --baseline: a difference from the accepted baseline turns a pass into a fail (accept intended changes with `spike bless`)', false)
  .option('--budget <usd>', 'with --spec: stop once about this much has been spent (remaining flows are skipped and the result is "not sure"); each flow also gets the money left as its own limit')
  .option('--stop-on-fail', 'with --spec: stop at the first flow that fails instead of testing them all', false)
  .option('--steps-per-flow <n>', 'with --spec: how many steps each flow may take (default: --max-steps)', (v) => parseInt(v, 10))
  .option('--json', 'print the slim JSON verdict only', false)
  .action(async (task: string | undefined, opts: { budget?: string; stopOnFail: boolean; stepsPerFlow?: number; baseline: boolean; failOnRegression: boolean; url: string; spec?: string; maxSteps?: number; perGoalMaxSteps?: number; expect?: string; via?: 'cdp' | 'extension' | 'playwright'; allowHost: string[]; actionCache?: boolean; readOnly: boolean; record: boolean; replay: boolean; headless: boolean; storageState?: string; saveStorageState?: string; fix: boolean; maxFixAttempts?: number; fixOnUncertain: boolean; rebuildTimeout?: number; waitForUrl?: string; yesAutoFix: boolean; json: boolean }) => {
    // A7 (P0): exactly one input — a sentence or a document, never neither.
    if (!task && !opts.spec) {
      console.error('Tell me what to test: either a sentence in quotes, or --spec <file> with a document describing the flows.');
      process.exit(INFRA_ERROR_EXIT_CODE);
    }
    if (task && opts.spec) {
      console.error('Pass either a sentence or --spec <file>, not both.');
      process.exit(INFRA_ERROR_EXIT_CODE);
    }
    const onProgress = opts.json ? undefined : (l: string) => console.log(l);
    const config = mergeConfig(opts.via, opts.allowHost, opts.actionCache, opts);
    const qaRunOpts = {
      maxSteps: opts.maxSteps,
      perGoalMaxSteps: opts.perGoalMaxSteps,
      // A17 (P1): --expect turns "have a look at this page" into "prove this
      // sentence is true of it". Blank/absent leaves the run as it was.
      ...(opts.expect?.trim() && { expectations: opts.expect.trim() }),
      // A1 (P0): only an explicit --read-only turns look-only mode on here —
      // naming --url is itself the go-ahead to drive that page, so the flag's
      // absence must NOT re-impose the safe-by-default config value.
      ...(opts.readOnly && { readOnly: true }),
      record: opts.record,
      replay: opts.replay,
      headless: opts.headless,
      storageStatePath: opts.storageState,
      saveStorageStatePath: opts.saveStorageState,
      ...(config && { config }),
      onProgress,
    };
    /** One task → one run, with --fix applied the same way in both modes. */
    const runOneTask = async (t: string, ctx?: FanOutContext) => {
      // A8/A11: inside a batch, the run inherits the shared session, the money
      // left in the batch budget, and the per-flow step limit.
      const ctxOpts = ctx ? runOptionsFromContext(ctx) : {};
      const runOpts = ctx
        ? {
            ...qaRunOpts,
            ...(ctx.maxSteps !== undefined && { maxSteps: ctx.maxSteps }),
            storageStatePath: ctxOpts.storageStatePath,
            saveStorageStatePath: ctxOpts.saveStorageStatePath ?? (opts.storageState ? qaRunOpts.saveStorageStatePath : undefined),
            ...((qaRunOpts.config || ctxOpts.config) && { config: { ...qaRunOpts.config, ...ctxOpts.config } }),
          }
        : qaRunOpts;
      return opts.fix
        ? (await runWithAutoFix(t, opts.url, {
            maxAttempts: opts.maxFixAttempts ?? 2,
            config: runOpts.config,
            onProgress,
            qaRunOpts: runOpts,
            // A11: on the command line the directory the user typed the command
            // in IS the explicit choice of project, so it stands in for an
            // unset project folder. The panel gets no such fallback.
            defaultCwd: process.cwd(),
            yesAutoFix: opts.yesAutoFix,
            // A6: fix a confirmed failure only; wait for the change to show up.
            fixOnUncertain: opts.fixOnUncertain,
            rebuild: {
              ...(opts.rebuildTimeout && opts.rebuildTimeout > 0 && { timeoutMs: opts.rebuildTimeout * 1000 }),
              ...(opts.waitForUrl && { waitForUrl: opts.waitForUrl }),
              onProgress,
            },
          })).finalReport
        : await qaRun(t, opts.url, runOpts);
    };

    // A7 (P0): document mode — work out the flows once, then test each one as
    // its own run, sharing whatever sign-in state --storage-state supplies.
    if (opts.spec) {
      const specPath = path.resolve(opts.spec);
      if (!fs.existsSync(specPath)) {
        console.error(`I couldn't find that document: ${specPath}`);
        process.exit(INFRA_ERROR_EXIT_CODE);
      }
      const specText = fs.readFileSync(specPath, 'utf8');
      onProgress?.('Reading your document and working out what to test…');
      const router = createPlanningRouter(config ?? {});
      const flows = await decomposeSpec(specText, {
        planFlows: (prompt, schema, step) => router.planGoals(prompt, schema, step),
        url: opts.url,
      });
      if (!opts.json) {
        console.log(`\nI'll test ${flows.length} flow${flows.length === 1 ? '' : 's'}:`);
        flows.forEach((f, i) => console.log(`${String(i + 1).padStart(2)}. ${f.name} — ${f.task}`));
        console.log('');
      }
      let budgetUsd: number | undefined;
      try {
        budgetUsd = parseBudgetFlag(opts.budget);
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        process.exit(INFRA_ERROR_EXIT_CODE);
      }
      // A11: log in once per batch — kept on disk only if --save-storage-state was given.
      const loginOnce = opts.storageState ? undefined : batchLoginOnce(loadConfig().artifactsDir, opts.saveStorageState);
      const outcome = await runFlows(flows, {
        runFlow: (flow, _i, ctx) => runOneTask(flow.task, ctx),
        onProgress,
        ...(opts.storageState && { storageStatePath: opts.storageState }),
        ...(loginOnce && { loginOnce }),
        ...(budgetUsd !== undefined && { budgetUsd }),
        ...(opts.stopOnFail && { stopOnFirstFailure: true }),
        ...((opts.stepsPerFlow ?? opts.maxSteps) !== undefined && { maxStepsPerFlow: opts.stepsPerFlow ?? opts.maxSteps }),
      });
      if (opts.json) {
        console.log(JSON.stringify(outcome, null, 2));
      } else {
        console.log(`\n${renderFlowTable(outcome)}`);
      }
      process.exit(exitCodeForVerdict(outcome.verdict));
    }

    const report = await runOneTask(task as string);
    // A30: the default reader of `spike run` is a person, so print the same
    // plain-English report the panel shows. The machine-readable shape is
    // still exactly one flag away (`--json`), and its contract — fields,
    // schemaVersion, exit codes — is documented in the README.
    if (opts.json) {
      console.log(JSON.stringify(slimReport(report), null, 2));
    } else {
      console.log(`\n${renderPlainReport(report)}`);
      console.log(`full report: ${report.evidence_paths[0]}`);
    }
    // A47 (P2): 0 pass / 1 verdict fail / 2 uncertain — see cli-exit-codes.ts.
    process.exit(exitCodeForVerdict(report.verdict));
  });

/* A23/A25: discovery + coverage. `map` answers "what does this app contain?"
 * and `coverage` answers "what haven't we tested?" — the pair that separates
 * autonomous QA from a human writing 200 task strings.
 *
 * The crawler takes an injected fetcher (see src/discovery/crawler.ts) so the
 * module stays browser-agnostic and unit-testable. Here that is a plain HTTP
 * fetch: it is $0, needs no Chrome, and reaches every link-reachable route.
 * Interaction-gated state (modals, wizards) is deliberately NOT reached this
 * way — discoverApp exposes a seam for an AI exploration pass, which is a
 * separate, budgeted concern. */
/* A30: the blessing half of the differential oracle. A baseline diff is only
 * meaningful if someone can say "yes, that change was intentional" — otherwise
 * every deliberate UI edit reads as a regression forever and the signal is
 * abandoned. This is deliberately a separate, explicit human act: nothing in a
 * run ever blesses a baseline for you.
 *
 * (The escape from needing this at all is comparing two ENVIRONMENTS rather
 * than two points in time — see compareEnvironments in assertions/
 * differential.ts, which needs no blessing because divergence itself is the
 * signal.) */
program
  .command('bless')
  .description('accept the CURRENT stored baseline for a flow as intentional — the baseline-diff check stops reporting it as a regression')
  .argument('[flow]', 'flow name (defaults to every stored baseline)')
  .option('--list', 'show stored baselines and whether each has been blessed', false)
  .action(async (flow: string | undefined, opts: { list: boolean }) => {
    const dir = DEFAULT_BASELINE_DIR;
    if (!fs.existsSync(dir)) {
      console.error(`no baselines yet at ${dir} — run with SPIKE_DIFFERENTIAL=1 to create one`);
      process.exit(2);
    }
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    if (opts.list) {
      for (const f of files) {
        const b = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as { flow: string; blessedAt?: string; createdAt: string };
        console.log(`${b.blessedAt ? 'blessed' : 'UNBLESSED'}  ${b.flow}  (created ${b.createdAt}${b.blessedAt ? `, blessed ${b.blessedAt}` : ''})`);
      }
      process.exit(0);
    }
    const targets = flow ? files.filter((f) => f === `${flow}.json` || f.includes(flow)) : files;
    if (!targets.length) {
      console.error(`no stored baseline matching "${flow ?? ''}"`);
      process.exit(2);
    }
    for (const f of targets) {
      const p2 = path.join(dir, f);
      const b = JSON.parse(fs.readFileSync(p2, 'utf8')) as { flow: string; ax: unknown; network: unknown; blessedAt?: string };
      // Bless what is ALREADY stored — this command never re-drives the app.
      // Re-capturing here would bless whatever the site happens to look like
      // right now, which is not what "I reviewed this diff" means.
      await blessBaseline(b.flow, { ax: b.ax as never, network: b.network as never }, { dir });
      console.log(`blessed ${b.flow}`);
    }
    process.exit(0);
  });

/* A10: saved tests — list them, park a flaky one, review self-healed changes.
 * All file logic lives in recorder/tests-admin.ts (tested against a temp dir). */
const testsCmd = program.command('tests').description('saved tests: list them, park a flaky one, and review changes a self-heal proposed');
testsCmd
  .command('list')
  .description('every saved test with its last result and whether it is parked (a parked test still runs but cannot fail the suite)')
  .option('--json', 'print JSON', false)
  .action((opts: { json: boolean }) => {
    const rows = listSavedTests();
    // Fold in the old `bless --list` view: which stored baselines are accepted.
    const baselines: { flow: string; blessed: boolean }[] = [];
    if (fs.existsSync(DEFAULT_BASELINE_DIR)) {
      for (const f of fs.readdirSync(DEFAULT_BASELINE_DIR).filter((x) => x.endsWith('.json'))) {
        try {
          const b = JSON.parse(fs.readFileSync(path.join(DEFAULT_BASELINE_DIR, f), 'utf8')) as { flow: string; blessedAt?: string };
          baselines.push({ flow: b.flow, blessed: Boolean(b.blessedAt) });
        } catch { /* skip */ }
      }
    }
    if (opts.json) {
      console.log(JSON.stringify({ tests: rows, baselines }, null, 2));
      return;
    }
    if (!rows.length) console.log('No saved tests yet. A passing `spike run` saves one.');
    for (const r of rows) {
      const flags = [r.quarantined ? `parked${r.quarantineReason ? ` (${r.quarantineReason})` : ''}` : '', r.hasHealCandidate ? 'change waiting for review' : ''].filter(Boolean);
      console.log(`${(r.lastResult ?? 'not run yet').padEnd(12)} ${r.name}  ${r.url}${flags.length ? `  [${flags.join('; ')}]` : ''}`);
    }
    if (baselines.length) {
      console.log('\nBaselines:');
      for (const b of baselines) console.log(`  ${b.blessed ? 'accepted' : 'not yet accepted'}  ${b.flow}`);
    }
  });
testsCmd
  .command('quarantine')
  .description('park a flaky test: it still runs and reports, but no longer decides the suite exit code')
  .argument('<name>', 'saved test name')
  .option('--reason <text>', 'why (shown in `tests list`)')
  .action((name: string, opts: { reason?: string }) => {
    try {
      quarantineTest(name, opts.reason);
      console.log(`Parked "${name}". It still runs, but it can no longer fail the suite. Undo with: spike tests release ${name}`);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(INFRA_ERROR_EXIT_CODE);
    }
  });
testsCmd
  .command('release')
  .description('un-park a test so it decides the suite exit code again')
  .argument('<name>', 'saved test name')
  .action((name: string) => {
    try {
      console.log(releaseTest(name) ? `"${name}" counts again.` : `"${name}" was not parked.`);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(INFRA_ERROR_EXIT_CODE);
    }
  });
testsCmd
  .command('review')
  .description('list changes a self-heal proposed but held back for your review (the old test stays active until you accept)')
  .action(() => {
    const items = listHealCandidates();
    if (!items.length) {
      console.log('Nothing waiting for review.');
      return;
    }
    for (const c of items) {
      console.log(`${c.name}  (${c.tier})`);
      for (const r of c.reasons) console.log(`  why held: ${r}`);
      console.log(c.changes.split('\n').map((l) => `  ${l}`).join('\n'));
      for (const e of c.evidencePaths) console.log(`  evidence: ${e}`);
      console.log(`  accept: spike tests accept ${c.name}    discard: spike tests reject ${c.name}`);
    }
  });
testsCmd
  .command('accept')
  .description('apply a held-back heal: the saved test (and its Playwright copy) is rewritten')
  .argument('<name>', 'saved test name')
  .action((name: string) => {
    try {
      const p = acceptHeal(name);
      console.log(`Applied. Updated ${p.jsonPath}`);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(INFRA_ERROR_EXIT_CODE);
    }
  });
testsCmd
  .command('reject')
  .description('discard a held-back heal; the saved test stays exactly as it was')
  .argument('<name>', 'saved test name')
  .action((name: string) => {
    try {
      rejectHeal(name);
      console.log(`Discarded. "${name}" is unchanged.`);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(INFRA_ERROR_EXIT_CODE);
    }
  });

/** The findings block a person reads after a map. Problems first, then
 * warnings, capped so one broken page does not bury the summary. */
function renderFindings(findings: AppModelFinding[]): string[] {
  if (!findings.length) return ['Nothing looked broken on the pages I saw.'];
  const problems = findings.filter((f) => f.severity === 'problem');
  const warnings = findings.filter((f) => f.severity === 'warning');
  const lines: string[] = [];
  const word = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;
  lines.push(
    problems.length
      ? `Found ${word(problems.length, 'problem')}${warnings.length ? ` and ${word(warnings.length, 'thing')} worth a look` : ''}:`
      : `Found ${word(warnings.length, 'thing')} worth a look:`,
  );
  for (const f of [...problems, ...warnings].slice(0, 25)) {
    lines.push(`  ${f.severity === 'problem' ? '✗' : '·'} ${f.route}`);
    lines.push(`    ${f.detail}`);
  }
  const shown = Math.min(25, findings.length);
  if (findings.length > shown) lines.push(`  …and ${findings.length - shown} more.`);
  return lines;
}

program
  .command('map')
  .description('walk the site in a real Chrome and report what is there and what is broken, into .spike/app-model.json; exit 1 if any page is broken')
  .argument('<url>', 'address to start from — also fixes the boundary of the crawl (same site only)')
  .option('--max-depth <n>', 'link-hops to follow', (v) => parseInt(v, 10))
  .option('--max-pages <n>', 'hard cap on pages visited', (v) => parseInt(v, 10))
  .option('--storage-state <path>', 'load a saved sign-in (cookies + browser storage) first, so the walk sees the pages a signed-in person sees')
  .option('--via <transport>', 'cdp (default) | extension | playwright — how to drive Chrome')
  .option('--no-browser', 'fetch pages over the network instead of opening them in Chrome: faster, but it cannot sign in and cannot see a page that draws itself with JavaScript')
  .option('--headless', 'run Chrome without a window', false)
  .option('--no-explore', 'skip opening pop-ups, tabs and "show more" sections after the walk — faster and free, but the map then only covers what a link leads to')
  .option('--diff', 'compare against the stored map and print what changed', false)
  .option('--run-changed', 'with --diff: check the pages that are new or changed, without asking', false)
  .option('--json', 'machine-readable output', false)
  .action(async (url: string, opts: { maxDepth?: number; maxPages?: number; storageState?: string; via?: 'cdp' | 'extension' | 'playwright'; browser: boolean; headless: boolean; explore: boolean; diff: boolean; runChanged: boolean; json: boolean }) => {
    const root = process.cwd();
    const previousModel = loadAppModel(root);
    const progress = opts.json ? undefined : (l: string) => console.error(l);
    let model: AppModel;
    try {
      model = await buildSiteMap(
        url,
        {
          maxDepth: opts.maxDepth,
          maxPages: opts.maxPages,
          browser: opts.browser,
          via: opts.via,
          storageState: opts.storageState,
          headless: opts.headless,
          // Only a real Chrome can open anything; over the network there is
          // nothing to click, so the flag is quietly irrelevant there.
          explore: opts.explore !== false && opts.browser,
        },
        progress,
      );
    } catch (e) {
      console.error(`I could not walk that site: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(INFRA_ERROR_EXIT_CODE);
    }
    saveAppModel(model, root);
    const cov = coverageReport(model);
    const findings = model.findings ?? [];
    const broken = hasBlockingFindings(findings);

    if (opts.diff) {
      const d = diffAppModel(previousModel ?? emptyAppModel(url), model);
      if (opts.json) {
        console.log(JSON.stringify({ coverage: cov, diff: d, findings }, null, 2));
      } else {
        console.log(`mapped ${cov.routes.total} route(s) — ${d.newRoutes.length} new, ${d.changedRoutes.length} changed, ${d.removedRoutes.length} removed`);
        for (const e of d.prioritized.slice(0, 20)) console.log(`  ${e.kind.padEnd(9)} ${e.route}`);
        for (const line of renderFindings(findings)) console.log(line);
      }
      const changedCount = d.newRoutes.length + d.changedRoutes.length;
      // A7: offer the next step instead of printing a list and stopping.
      let runNow = opts.runChanged && changedCount > 0;
      if (!runNow && changedCount > 0 && !opts.json && process.stdin.isTTY && process.stdout.isTTY) {
        const answer = await new Promise<string>((resolve) => {
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          rl.question(`Check the ${changedCount} changed page${changedCount === 1 ? '' : 's'} now? [y/N] `, (a) => { rl.close(); resolve(a); });
        });
        runNow = /^y/i.test(answer.trim());
      }
      if (runNow) {
        const { targets, result } = await runChangedPages(model, d, url, (targets) =>
          runFanOut(
            flowsFromRoutes(targets.map((t) => ({ url: t.url, name: t.name })), { baseUrl: url, maxFlows: targets.length, instruction: (_r, address) => checkInstruction(address) }),
            {
              runFlow: (flow, i) => qaRun(flow.task, targets[i]?.url ?? url, {
                readOnly: true, record: false, replay: false, headless: opts.headless,
                storageStatePath: opts.storageState,
                ...(opts.via && { config: { via: opts.via } }),
              }),
              ...(opts.storageState && { storageStatePath: opts.storageState }),
              onProgress: progress,
            },
          ),
        );
        if (result) {
          if (opts.json) console.log(JSON.stringify({ changedChecked: targets.map((t) => t.url), verdict: result.verdict, flows: result.flows }, null, 2));
          else { console.log(''); console.log(renderFlowTable(result)); }
          process.exit(broken ? 1 : exitCodeForVerdict(result.verdict));
        }
      }
      process.exit(broken ? 1 : 0);
    }

    if (opts.json) {
      console.log(JSON.stringify({ coverage: cov, findings }, null, 2));
    } else {
      console.log(`Mapped ${cov.routes.total} page(s) and ${cov.interactiveElements.total} control(s) → .spike/app-model.json`);
      for (const line of renderFindings(findings)) console.log(line);
    }
    process.exit(broken ? 1 : 0);
  });

/* A24 (second half) — `spike check <url>`: the zero-input level.
 *
 * Every other entry point asks the user to say what to test. This one asks
 * nothing: walk the site, then look at each page it found, and answer "is any
 * of this broken?". The per-page runs go through the SAME fan-out orchestrator
 * a document run uses — one budgeted run each, one aggregated verdict — rather
 * than a second loop with its own aggregation rule. */
program
  .command('check')
  .description('page health scan with no instructions: walk every page it can reach, look at each one without clicking anything, and say what is broken (add --try-controls to press buttons too)')
  .argument('<url>', 'address to start from — the check stays on this site')
  .option('--max-pages <n>', `how many pages to look at (default ${DEFAULT_CHECK_PAGES})`, (v) => parseInt(v, 10))
  .option('--storage-state <path>', 'load a saved sign-in first, so the check sees the pages a signed-in person sees')
  .option('--via <transport>', 'cdp (default) | extension | playwright — how to drive Chrome')
  .option('--no-browser', 'find the pages over the network instead of opening them in Chrome: faster, but it cannot sign in and cannot see a page that draws itself with JavaScript')
  .option('--headless', 'run Chrome without a window', false)
  .option('--explore', 'while finding the pages, also open pop-ups, tabs and "show more" sections so what is behind them gets checked too — this does press a few things on your site', false)
  .option('--try-controls', 'also press ordinary buttons on each page so a button that does nothing shows up; never presses anything that buys, pays, deletes, cancels, sends or signs out, and never submits a form with a password or payment field. Pages that pass are saved as tests tagged "check"', false)
  .option('--budget <usd>', 'stop once about this much has been spent: the pages not yet looked at are skipped and the result is "not sure"')
  .option('--stop-on-fail', 'stop at the first page that looks broken', false)
  .option('--steps-per-flow <n>', 'how many steps looking at one page may take', (v) => parseInt(v, 10))
  .option('--json', 'machine-readable output', false)
  .action(async (url: string, opts: { budget?: string; stopOnFail: boolean; stepsPerFlow?: number; maxPages?: number; storageState?: string; via?: 'cdp' | 'extension' | 'playwright'; browser: boolean; headless: boolean; explore: boolean; tryControls: boolean; json: boolean }) => {
    const progress = opts.json ? undefined : (l: string) => console.error(l);

    // Same code path as the MCP `site_check` tool (src/discovery/run-check.ts).
    let checked;
    try {
      checked = await runSiteCheck(url, {
        budgetUsd: parseBudgetFlag(opts.budget),
        stopOnFail: opts.stopOnFail,
        stepsPerPage: opts.stepsPerFlow,
        maxPages: opts.maxPages,
        storageState: opts.storageState,
        via: opts.via,
        browser: opts.browser,
        headless: opts.headless,
        explore: opts.explore,
        tryControls: opts.tryControls,
        lookedHint: true,
        progress,
      });
    } catch (e) {
      if (e instanceof Error && /^--budget /.test(e.message)) { console.error(e.message); process.exit(INFRA_ERROR_EXIT_CODE); }
      if (!(e instanceof SiteCheckError)) throw e;
      console.error(e.message);
      process.exit(INFRA_ERROR_EXIT_CODE);
    }
    const { outcome, findings, summary } = checked;

    if (opts.json) {
      console.log(JSON.stringify({ summary, verdict: outcome.verdict, flows: outcome.flows, coverage: outcome.coverage, ...(outcome.spend && { spend: outcome.spend }), findings }, null, 2));
    } else {
      console.log('');
      console.log(renderFlowTable(outcome));
      console.log('');
      console.log(summary);
      for (const line of renderFindings(findings)) console.log(line);
    }
    process.exit(hasBlockingFindings(findings) ? 1 : exitCodeForVerdict(outcome.verdict));
  });

/* A9 — `spike ci`: the pull-request front door. Headless, waits for the preview
 * address, runs the saved tests and/or a site check, writes a Markdown summary
 * (also to $GITHUB_STEP_SUMMARY) and exits 0 pass / 1 fail / 2 not sure / 3 could
 * not run. Logic lives in src/ci/ so a test can import it. */
program
  .command('ci')
  .description('run your saved tests and/or a site check against a preview address, for a pull request: waits for it to come up, writes a summary, and exits with the result')
  .requiredOption('--url <url>', 'the preview address to test')
  .option('--suite', 'run every saved test', false)
  .option('--check', 'also walk the site and look at each page', false)
  .option('--max-pages <n>', 'how many pages the site check looks at', (v) => parseInt(v, 10))
  .option('--budget <usd>', 'stop once about this much has been spent (default $2, or ciBudgetUsd / SPIKE_CI_BUDGET_USD)', (v) => parseFloat(v))
  .option('--storage-state <path>', 'load a saved sign-in first')
  .option('--wait-for-url <url>', 'wait for this address to answer before starting (default: the preview address)')
  .option('--wait <seconds>', 'how long to wait for the address (default 180)', (v) => parseInt(v, 10))
  .option('--summary <file>', 'write the Markdown summary here')
  .option('--junit <file>', 'write a JUnit XML report here')
  .option('--comment <file>', 'write the pull-request comment body here')
  .option('--changed-since <ref>', 'only test what changed since this branch or commit (skips the run when only docs or tests changed)')
  .option('--webhook <url>', 'also post the result to this Slack, Discord or other web address')
  .option('--json', 'machine-readable output', false)
  .action(async (opts: { url: string; suite: boolean; check: boolean; maxPages?: number; budget?: number; storageState?: string; waitForUrl?: string; wait?: number; summary?: string; junit?: string; comment?: string; webhook?: string; changedSince?: string; json: boolean }) => {
    const { runCi, writeCiOutputs, renderCiSummary } = await import('./ci/ci.js');
    const { buildPrComment } = await import('./ci/pr-comment.js');
    const result = await runCi({
      url: opts.url,
      suite: opts.suite,
      check: opts.check,
      maxPages: opts.maxPages,
      budgetUsd: resolveCiBudget(opts.budget && opts.budget > 0 ? opts.budget : undefined, loadConfig()),
      storageState: opts.storageState,
      waitForUrl: opts.waitForUrl,
      ...(opts.wait && { waitMs: opts.wait * 1000 }),
      ...(opts.changedSince && { changedSince: opts.changedSince }),
      headless: true,
      progress: opts.json ? undefined : (l: string) => console.error(l),
    });
    writeCiOutputs(result, { summary: opts.summary, junit: opts.junit });
    if (opts.comment) {
      fs.mkdirSync(path.dirname(path.resolve(opts.comment)), { recursive: true });
      fs.writeFileSync(opts.comment, buildPrComment(renderCiSummary(result), { runUrl: process.env.SPIKE_CI_RUN_URL }));
    }
    if (opts.webhook) {
      const { postWebhook, ciStatusChange } = await import('./schedule/notify.js');
      await postWebhook(opts.webhook, { ...ciStatusChange(result), ...(process.env.SPIKE_CI_RUN_URL && { runId: process.env.SPIKE_CI_RUN_URL }) });
    }
    console.log(opts.json ? JSON.stringify(result, null, 2) : renderCiSummary(result));
    process.exit(result.exitCode);
  });

program
  .command('coverage')
  .description('report what has and has NOT been tested, from .spike/app-model.json')
  .option('--json', 'machine-readable output', false)
  .action((opts: { json: boolean }) => {
    const model = loadAppModel(process.cwd());
    if (!model) {
      console.error('no app model yet — run `spike map <url>` first');
      process.exit(2);
    }
    const cov = coverageReport(model);
    if (opts.json) {
      console.log(JSON.stringify(cov, null, 2));
      process.exit(0);
    }
    const pct = (n: number) => `${Math.round(n * 100)}%`;
    console.log(`routes    ${cov.routes.exercised}/${cov.routes.total} exercised (${pct(cov.routes.ratio)})`);
    console.log(`elements  ${cov.interactiveElements.touched}/${cov.interactiveElements.total} touched   (${pct(cov.interactiveElements.ratio)})`);
    const untested = cov.perRoute.filter((r) => !r.exercised);
    if (untested.length) {
      console.log(`\nuntested routes (${untested.length}):`);
      for (const r of untested.slice(0, 30)) console.log(`  ${r.route}`);
    }
    process.exit(0);
  });

program
program
  .command('login')
  .description('open a browser window on your site, sign in yourself (any way you like), and save the sign-in for later runs')
  .argument('<url>', 'the sign-in page or your site address')
  .option('--out <file>', 'where to save the sign-in (default: a per-site file under ~/.spike/sessions)')
  .action(async (url: string, opts: { out?: string }) => {
    const { runLogin, defaultSessionPath, createRealLoginBrowser, waitForEnter, LoginError } = await import('./login/login.js');
    try {
      const file = opts.out ?? defaultSessionPath(url);
      const r = await runLogin(url, file, {
        browser: await createRealLoginBrowser(),
        waitForDone: async () => { console.error('When you are signed in, press Enter here.'); await waitForEnter(); },
        progress: (l) => console.error(l),
      });
      console.log(`Saved your sign-in (${r.cookies} cookie${r.cookies === 1 ? '' : 's'}) to ${r.file}`);
      console.log(`Use it with: spike run "<task>" --url ${url} --storage-state ${r.file}`);
      process.exit(0);
    } catch (e) {
      console.error(e instanceof LoginError ? e.message : `Could not save a sign-in: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(e instanceof LoginError ? 2 : 3);
    }
  });

  .command('fixture')
  .description('start the dogfood fixture app (login → products → cart → checkout)')
  .option('--bug <mode>', 'on|off — toggle the intentional checkout bug', 'off')
  .option('--port <n>', 'port', (v) => parseInt(v, 10))
  .action((opts: { bug: string; port?: number }) => {
    const cfg = loadConfig();
    const port = opts.port ?? cfg.fixturePort;
    const bug = opts.bug === 'on';
    startFixture(port, bug);
    console.log(`fixture app on http://localhost:${port}/login  (bug ${bug ? 'ON — checkout breaks' : 'off'})`);
  });

program
  .command('bench <what> <model>')
  .description('compare a model for clicking through pages against your current one on a fixed set of flows (spends real money; needs --yes). Example: spike bench navigator gemini:gemini-3-flash')
  .option('--baseline <model>', 'model to compare against, as provider:model (default: your current one)')
  .option('--repeats <n>', 'times to run each flow per model', (v) => parseInt(v, 10), 1)
  .option('--yes', 'confirm that this uses real models and real money', false)
  .option('--json', 'machine-readable output', false)
  .action(async (what: string, model: string, opts: { baseline?: string; repeats: number; yes: boolean; json: boolean }) => {
    const b = await import('./bench/navigator.js');
    if (what !== 'navigator') { console.error('only "navigator" is supported: spike bench navigator <provider:model>'); process.exit(2); }
    const candidate = b.parseModelPin(model);
    if (!candidate) { console.error(`unknown model "${model}" - use provider:model, for example gemini:gemini-3-flash`); process.exit(2); }
    const cfg = loadConfig();
    const cur = cfg.navigator;
    const baseline = opts.baseline
      ? b.parseModelPin(opts.baseline)
      : { provider: cur.provider, mode: cur.mode, ...(cur.model && { model: cur.model }), label: `${cur.provider}${cur.model ? `:${cur.model}` : ''}` };
    if (!baseline) { console.error(`unknown baseline "${opts.baseline}"`); process.exit(2); }
    if (!opts.yes) {
      console.error('This runs every bench flow with both models in a real browser and spends real money. Re-run with --yes to go ahead.');
      process.exit(2);
    }
    const fixture = startFixture(cfg.fixturePort, false);
    try {
      const result = await b.runNavigatorBench({
        candidate, baseline: baseline as import('./bench/navigator.js').ModelPin,
        repeats: opts.repeats,
        progress: (l) => console.error(l),
        runFlow: async (flow, pin) => {
          const url = flow.url.replace('{fixture}', `http://localhost:${cfg.fixturePort}`);
          const r = await qaRun(flow.task, url, {
            record: false, replay: false, headless: true,
            config: { navigator: { provider: pin.provider, mode: pin.mode, model: pin.model ?? '' } as QaConfig['navigator'] },
          });
          return b.outcomeFromReport(r);
        },
      });
      console.log(opts.json ? JSON.stringify(result, null, 2) : b.renderBenchReport(result));
      process.exit(result.decision.decision === 'GO' ? 0 : 1);
    } finally { fixture.close(); }
  });

program
  .command('doctor')
  .description('preflight this machine: is Chrome there, are the configured models reachable, and what would a run actually be allowed to do')
  .option('--skip-nano', 'skip the on-device model probe (it launches Chrome and can take a few seconds)', false)
  .action(async (opts: { skipNano: boolean }) => {
    const cfg = loadConfig();

    let chrome: { path?: string; error?: string };
    try {
      chrome = { path: findChrome(cfg.chromePath) };
    } catch (e) {
      chrome = { error: e instanceof Error ? e.message.split('\n')[1]?.trim() || e.message : String(e) };
    }

    const nano = opts.skipNano
      ? { error: 'skipped (--skip-nano)' }
      : chrome.path
        ? await probeNano(cfg)
        : { error: 'Chrome was not found, so the on-device model could not be checked' };

    const ladder = await createPlanningRouter().probeLadder();
    const roles = buildRoleProbes(cfg, ladder, nano.availability === 'available');

    const sections = buildDoctorReport({
      chrome,
      nano,
      roles,
      run: { readOnly: cfg.readOnly, via: cfg.via, allowedHosts: cfg.allowedHosts, strictOracles: cfg.strictOracles },
      email: {
        provider: cfg.emailProvider,
        host: cfg.imapHost,
        user: cfg.imapUser,
        hasPassword: (() => { const v = new Vault(); return Boolean(v.get('imap') ?? v.get('SPIKE_IMAP_PASS') ?? process.env.SPIKE_IMAP_PASS); })(),
      },
    });
    for (const line of renderDoctorReport(sections)) console.log(line);
    process.exit(doctorExitCode(sections));
  });

program
  .command('config')
  .description('view or change which models are used + how debugging is handled (shared with the extension panel)')
  .argument('<action>', 'show | set')
  .option('--provider <p>', 'BRAIN (the model that plans): nano|gemini|claude|gpt|ollama|openrouter|glm')
  .option('--mode <m>', 'BRAIN: api|cli')
  .option('--model <m>', 'BRAIN model id (blank = provider default)')
  .option('--navigator-provider <p>', 'NAVIGATOR (the model that clicks): nano|gemini|claude|gpt|ollama|openrouter|glm')
  .option('--navigator-mode <m>', 'NAVIGATOR: api|cli|ondevice')
  .option('--navigator-model <m>', 'NAVIGATOR model id (blank = provider default)')
  .option('--strict-oracles <on|off>', 'on: a failed safety check forces a fail verdict whatever the model says')
  .option('--email-provider <p>', 'where sign-in emails are read from: none | imap | fake-local (the password is never a flag — use `spike secret set SPIKE_IMAP_PASS`)')
  .option('--imap-host <host>', 'mail server for --email-provider imap')
  .option('--imap-user <user>', 'mail account for --email-provider imap (usually the full address)')
  .option('--debug-mode <d>', 'prompt|auto')
  .option('--debug-agent <a>', 'auto|claude|codex|gemini')
  .action((action: string, opts: { provider?: string; mode?: string; model?: string; navigatorProvider?: string; navigatorMode?: string; navigatorModel?: string; strictOracles?: string; emailProvider?: string; imapHost?: string; imapUser?: string; debugMode?: string; debugAgent?: string }) => {
    const store = new SettingsStore();
    if (action === 'show') {
      printSettings(store.read());
      return;
    }
    if (action !== 'set') {
      console.error('usage: spike config <show|set>');
      process.exit(2);
    }
    // action === 'set'
    const patch: Partial<QaSettings> = {};
    const planner: Partial<PlannerSelection> = {};
    if (opts.provider !== undefined) {
      if (!PROVIDERS.includes(opts.provider as ProviderId)) {
        console.error(`invalid --provider "${opts.provider}" — choose one of: ${PROVIDERS.join(', ')}`);
        process.exit(2);
      }
      planner.provider = opts.provider as ProviderId;
    }
    if (opts.mode !== undefined) {
      if (!PLANNER_MODES.includes(opts.mode as PlannerMode)) {
        console.error(`invalid --mode "${opts.mode}" — choose one of: ${PLANNER_MODES.join(', ')}`);
        process.exit(2);
      }
      planner.mode = opts.mode as PlannerMode;
    }
    if (opts.model !== undefined) {
      // blank model is allowed — it means "use the provider/mode default"
      planner.model = opts.model;
    }
    // A21: the navigator is the role that actually drives the page on every
    // step, and until now it could only be set by editing settings.json or
    // exporting SPIKE_NAVIGATOR_* — the one role with no CLI switch.
    const navigator: Partial<PlannerSelection> = {};
    if (opts.navigatorProvider !== undefined) {
      if (!PROVIDERS.includes(opts.navigatorProvider as ProviderId)) {
        console.error(`invalid --navigator-provider "${opts.navigatorProvider}" — choose one of: ${PROVIDERS.join(', ')}`);
        process.exit(2);
      }
      navigator.provider = opts.navigatorProvider as ProviderId;
    }
    if (opts.navigatorMode !== undefined) {
      if (!NAVIGATOR_MODES.includes(opts.navigatorMode as PlannerMode)) {
        console.error(`invalid --navigator-mode "${opts.navigatorMode}" — choose one of: ${NAVIGATOR_MODES.join(', ')}`);
        process.exit(2);
      }
      navigator.mode = opts.navigatorMode as PlannerMode;
    }
    if (opts.navigatorModel !== undefined) navigator.model = opts.navigatorModel;
    if (opts.strictOracles !== undefined) {
      const on = ['on', 'true', '1', 'yes'].includes(opts.strictOracles.toLowerCase());
      const off = ['off', 'false', '0', 'no'].includes(opts.strictOracles.toLowerCase());
      if (!on && !off) {
        console.error(`invalid --strict-oracles "${opts.strictOracles}" — use "on" or "off"`);
        process.exit(2);
      }
      patch.strictOracles = on;
    }
    if (opts.emailProvider !== undefined) {
      if (!['none', 'imap', 'fake-local'].includes(opts.emailProvider)) {
        console.error(`invalid --email-provider "${opts.emailProvider}" — choose one of: none, imap, fake-local`);
        process.exit(2);
      }
      patch.emailProvider = opts.emailProvider as 'none' | 'imap' | 'fake-local';
    }
    if (opts.imapHost !== undefined) patch.imapHost = opts.imapHost.trim() || undefined;
    if (opts.imapUser !== undefined) patch.imapUser = opts.imapUser.trim() || undefined;
    if (opts.debugMode !== undefined) {
      if (!DEBUG_MODES.includes(opts.debugMode as DebugMode)) {
        console.error(`invalid --debug-mode "${opts.debugMode}" — choose one of: ${DEBUG_MODES.join(', ')}`);
        process.exit(2);
      }
      patch.debugMode = opts.debugMode as DebugMode;
    }
    if (opts.debugAgent !== undefined) {
      if (!DEBUG_AGENTS.includes(opts.debugAgent as DebugAgent)) {
        console.error(`invalid --debug-agent "${opts.debugAgent}" — choose one of: ${DEBUG_AGENTS.join(', ')}`);
        process.exit(2);
      }
      patch.debugAgent = opts.debugAgent as DebugAgent;
    }
    if (Object.keys(planner).length) patch.planner = planner as PlannerSelection;
    if (Object.keys(navigator).length) patch.navigator = navigator as PlannerSelection;
    if (Object.keys(patch).length === 0) {
      console.error(
        'nothing to set — pass at least one of: --provider --mode --model --navigator-provider --navigator-mode --navigator-model --strict-oracles --email-provider --imap-host --imap-user --debug-mode --debug-agent',
      );
      process.exit(2);
    }
    printSettings(store.write(patch));
  });

program
  .command('replay')
  .description('replay recorded scripts deterministically — no planner, $0; exit 0 pass / 1 verdict fail / 2 uncertain / 3 infra or tool error')
  .argument('[name]', 'script name (or path to a generated-tests/*.json)')
  .option('--all', 'replay the suite (spike.suite.json if present, else every script in generated-tests/, sorted)', false)
  .option('--heal', 'on failure, re-engage the AI driver and re-emit the script', false)
  .option('--read-only', 'look-only mode: refuse to run a saved test that clicks or types (it reports why instead of interacting)', false)
  .option('--via <transport>', 'cdp (default) | extension | playwright — how to drive Chrome')
  .option('--allow-host <host>', 'permit clicks/typing on an EXTRA host beyond the script\'s own (repeatable) — the recorded url\'s host is trusted automatically. Matches the exact host or its www. sibling only; prefix with "." (e.g. ".example.com") to also trust every subdomain', collectRepeatable, [])
  .option('--baseline', 'compare the finished page against this flow\'s stored baseline (the first run stores it); differences are reported as evidence, the verdict is unchanged', false)
  .option('--fail-on-regression', 'with --baseline: a difference from the accepted baseline turns a pass into a fail (accept intended changes with `spike bless`)', false)
  .option('--json', 'print slim JSON verdicts only', false)
  .option('--workers <n>', 'with --all: concurrent scripts in flight (default 1 — today\'s serial behaviour). With --via playwright this is the cheap path (one shared Chrome, one isolated BrowserContext per script); otherwise each concurrent script gets its OWN fully isolated Chrome', (v) => parseInt(v, 10))
  .option('--tag <tag>', 'with --all + spike.suite.json: run only entries tagged with this (repeatable, OR match)', collectRepeatable, [])
  .option('--filter <substr>', 'with --all: run only scripts whose name/path contains this substring')
  .option('--shard <i/N>', 'with --all: run only shard i of N, deterministically partitioned by sorted script name (1-based i)')
  .option('--retries <n>', 'A11 flake control: re-run a FAILED script up to n times; a flow that fails then passes is reported flaky rather than red (default 0 — no retries, unchanged behaviour)', (v) => parseInt(v, 10))
  .option('--reporter <type>', `with --all: also write a report in this format — ${SUITE_REPORTERS.join(' | ')} (requires --out)`)
  .option('--out <path>', 'with --reporter: file path to write the report to')
  .option('--headless', 'run Chrome headless — a script needing assert_visual still gets Nano on its own split-off headed Chrome', false)
  .option('--storage-state <path>', 'load cookies + localStorage from this file before replaying (auth reuse)')
  .option('--save-storage-state <path>', 'single-script replay only: on a PASSING replay, save storage state to this file (with --all, use --auth-fixture instead)')
  .option('--budget <usd>', 'with --all: stop once about this much has been spent (only re-engaged --heal runs cost money); the tests not yet run are skipped and the result is "not sure"')
  .option('--auth-fixture', 'with --all + a configured suite setup script: run setup once, capture the storage state it produces, and inject it into every entry — "log in once, reuse everywhere"', false)
  .action(
    async (
      name: string | undefined,
      opts: {
        baseline: boolean;
        failOnRegression: boolean;
        all: boolean;
        heal: boolean;
        readOnly: boolean;
        via?: 'cdp' | 'extension' | 'playwright';
        allowHost: string[];
        json: boolean;
        workers?: number;
        tag: string[];
        filter?: string;
        shard?: string;
        reporter?: string;
        out?: string;
        headless: boolean;
        storageState?: string;
        saveStorageState?: string;
        authFixture: boolean;
        retries?: number;
        budget?: string;
      },
    ) => {
      const config = mergeConfig(opts.via, opts.allowHost, undefined, opts);
      let replayBudgetUsd: number | undefined;
      try { replayBudgetUsd = parseBudgetFlag(opts.budget); } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(2); }
      const replayBudget = new SpendBudget(replayBudgetUsd);

      if (!opts.all) {
        // Single-script path — unchanged from before the suite runner existed.
        if (!name) {
          console.error('give a script name or --all');
          process.exit(2);
        }
        const report = await qaReplay(name, {
          ...(opts.retries !== undefined && { retries: opts.retries }),
          heal: opts.heal,
          // A1 (P0): look-only mode — a saved test is clicks and typing, so the
          // replay refuses up front and says why instead of interacting.
          ...(opts.readOnly && { readOnly: true }),
          ...(config && { config }),
          onProgress: opts.json ? undefined : (l) => console.log(l),
          headless: opts.headless,
          storageStatePath: opts.storageState,
          saveStorageStatePath: opts.saveStorageState,
        });
        const out = { script: name, healed: report.healed, ...slimReport(report) };
        console.log(JSON.stringify(out, null, 2));
        // A47 (P2): 0 pass / 1 verdict fail / 2 uncertain — see cli-exit-codes.ts.
        process.exit(exitCodeForVerdict(report.verdict));
      }

      // --all: the suite runner (A12/A15) — ordering (config or sorted
      // default), tag/filter/shard selection, --workers concurrency, and an
      // optional JUnit/JSON report on top of the existing --json stdout
      // contract, which is preserved byte-for-byte below.
      let suiteConfig;
      try {
        suiteConfig = resolveSuite();
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        process.exit(2);
      }
      if (suiteConfig.entries.length === 0) {
        console.error('no recorded scripts in generated-tests/');
        process.exit(2);
      }
      let entries = suiteConfig.entries;
      entries = filterByTags(entries, opts.tag);
      entries = filterByString(entries, opts.filter);
      if (opts.shard) {
        let shard;
        try {
          shard = parseShard(opts.shard);
        } catch (e) {
          console.error(e instanceof Error ? e.message : String(e));
          process.exit(2);
        }
        entries = shardEntries(entries, shard);
      }

      // A6 (P1): "log in once, reuse everywhere" suite fixture. When asked,
      // run the suite's own `setup` script ourselves FIRST (outside runSuite,
      // so we control its options), capture the storage state it leaves
      // behind, and feed that state into every entry's runOne call below —
      // then tell runSuite to skip running setup a second time. Falling back
      // to `opts.storageState` when there's no setup (or it failed) means
      // `--storage-state` alone still works as a plain "use this pre-captured
      // file" flag, same as the single-script path above.
      let authStatePath: string | undefined = opts.storageState;
      let suiteSetup = suiteConfig.setup;
      if (opts.authFixture) {
        if (!suiteConfig.setup) {
          console.error('--auth-fixture has no effect: no setup script configured for this suite (see spike.suite.json)');
        } else {
          console.error(`auth fixture: running setup "${suiteConfig.setup}" once and capturing its storage state`);
          const capturedPath = path.join(os.tmpdir(), `spike-auth-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
          const setupReport = await qaReplay(suiteConfig.setup, {
            heal: opts.heal,
            ...(config && { config }),
            onProgress: opts.json ? undefined : (l) => console.log(l),
            headless: opts.headless,
            saveStorageStatePath: capturedPath,
          });
          if (setupReport.verdict === 'pass' && fs.existsSync(capturedPath)) {
            authStatePath = capturedPath;
            suiteSetup = undefined; // already ran it — don't let runSuite run it again
            console.error(`auth fixture: captured storage state to ${capturedPath}`);
          } else {
            console.error(`auth fixture: setup did not pass (${setupReport.verdict}) — continuing without shared storage state (setup will still run again per runSuite's own semantics)`);
          }
        }
      }

      // A3 (P0): the resolved `via` for this invocation — needed to decide
      // whether concurrent entries get the cheap isolation path (playwright:
      // one shared Chrome, one BrowserContext per script — free, nothing to
      // allocate here) or the expensive one (a fully separate Chrome per
      // concurrent script — see engine.ts's allocateIsolatedSession).
      const resolvedVia = config?.via ?? loadConfig().via;
      const parallel = (opts.workers ?? 1) > 1;
      const baseProfileDir = loadConfig(config).chromeProfile;

      const jsonResults: unknown[] = [];
      const runOne = async (scriptId: string): Promise<RunOneResult> => {
        // A3: only pay for a brand-new isolated Chrome when concurrency was
        // actually requested AND the transport can't isolate more cheaply
        // (playwright already gets a fresh BrowserContext per session for
        // free — see openBrowserSession's 'playwright' branch). workers=1
        // (the default) never allocates anything extra, so this is a no-op
        // for every existing caller.
        const isolation = parallel && resolvedVia !== 'playwright' ? await allocateIsolatedSession(baseProfileDir) : undefined;
        const perCallConfig = withSpendCap(isolation ? { ...config, ...isolation } : config, replayBudget);
        const report = await qaReplay(scriptId, {
          heal: opts.heal,
          ...(opts.readOnly && { readOnly: true }), // A1 (P0): look-only mode, suite-wide
          // A31: qaReplay has accepted `retries` since A11, but nothing ever
          // passed it — so flake control was unreachable from `replay --all`,
          // the only place a suite owner would use it.
          ...(opts.retries !== undefined && { retries: opts.retries }),
          ...(perCallConfig && { config: perCallConfig }),
          onProgress: opts.json ? undefined : (l) => console.log(l),
          headless: opts.headless,
          storageStatePath: authStatePath,
        });
        return { verdict: report.verdict, report };
      };
      const onResult = (r: SuiteScriptResult) => {
        const report = (r.result?.report as QaReplayResult | undefined) ?? undefined;
        const out = report ? { script: r.script, healed: report.healed, ...slimReport(report) } : { script: r.script, verdict: r.verdict, error: r.error };
        if (opts.json) jsonResults.push(out);
        else console.log(JSON.stringify(out, null, 2));
      };

      if (suiteSetup) console.error(`setup: ${suiteSetup}`);
      const outcome = await runSuite(entries, guardRuns(runOne, { budget: replayBudget, log: (l) => console.error(l) }), {
        workers: opts.workers,
        setup: suiteSetup,
        teardown: suiteConfig.teardown,
        onResult,
        // A11: quarantined flows still run and still report — they are only
        // excluded from the aggregate exit code, so a known-flaky flow cannot
        // redden CI while remaining visible in the output and reporters.
        isQuarantined: (script) => isQuarantined(script),
      });
      if (outcome.setup) console.error(`setup ${outcome.setup.verdict === 'pass' ? 'passed' : `${outcome.setup.verdict} — skipping ${entries.length} suite entr${entries.length === 1 ? 'y' : 'ies'}`}`);
      if (suiteConfig.teardown && outcome.teardown) console.error(`teardown: ${suiteConfig.teardown} — ${outcome.teardown.verdict}`);

      if (opts.json) console.log(JSON.stringify(jsonResults, null, 2));

      // A22: `--reporter json` used to be accepted and wired to NOTHING — a CI
      // job asking for a JSON artifact got no file and a green step. Both
      // reporters now go through the same writer.
      emitSuiteReport(outcome, opts.reporter, opts.out, 'spike replay');

      process.exit(outcome.worst);
    },
  );

/* ---------------------------------------------------------------------------
 * `spike suite` (A22) — the command a suite was always missing.
 *
 * Until now a "suite" was `spike replay --all`: recorded scripts only. You
 * could not write a test down. `spike.suite.json` gains `cases` — {name, url,
 * task} in plain English — which run through the ordinary AI pass (`qaRun`),
 * alongside the existing `entries`, which still run through deterministic $0
 * replay. One ordered list, one storage state, one exit code.
 * ------------------------------------------------------------------------ */

program
  .command('suite')
  .description(`run the whole suite from ${SUITE_CONFIG_FILENAME}: plain-English cases (a real AI pass) plus recorded scripts ($0 replay), rolled up into one exit code`)
  .option('--storage-state <path>', 'load cookies + localStorage from this file before each test (auth reuse — see `spike replay --save-storage-state`). Tests marked "needsAuth" are skipped without it')
  .option('--tag <tag>', 'run only tests tagged with this (repeatable, OR match)', collectRepeatable, [])
  .option('--filter <substr>', 'run only tests whose name contains this substring')
  .option('--shard <i/N>', 'run only shard i of N, deterministically partitioned by sorted name (1-based i)')
  .option('--workers <n>', 'concurrent tests in flight (default 1)', (v) => parseInt(v, 10))
  .option('--reporter <type>', `also write a report in this format — ${SUITE_REPORTERS.join(' | ')} (requires --out)`)
  .option('--out <path>', 'with --reporter: file path to write the report to')
  .option('--via <transport>', 'cdp (default) | extension | playwright — how to drive Chrome')
  .option('--allow-host <host>', 'permit clicks/typing on an EXTRA host beyond each test\'s own (repeatable)', collectRepeatable, [])
  .option('--read-only', 'look-only mode: navigate and check, but never click, type or submit', false)
  .option('--no-record', 'do not record a passing case to generated-tests/')
  .option('--headless', 'run Chrome headless', false)
  .option('--max-steps <n>', 'per-case driver step budget', (v) => parseInt(v, 10))
  .option('--steps-per-flow <n>', 'same as --max-steps: how many steps one test may take', (v) => parseInt(v, 10))
  .option('--budget <usd>', 'stop once about this much has been spent: the tests not yet run are skipped and the result is "not sure"')
  .option('--stop-on-fail', 'stop at the first test that fails instead of running them all', false)
  .option('--baseline', 'compare the finished page against this flow\'s stored baseline (the first run stores it); differences are reported as evidence, the verdict is unchanged', false)
  .option('--fail-on-regression', 'with --baseline: a difference from the accepted baseline turns a pass into a fail (accept intended changes with `spike bless`)', false)
  .option('--json', 'print slim JSON verdicts only', false)
  .action(
    async (opts: {
      baseline: boolean;
      failOnRegression: boolean;
      storageState?: string;
      tag: string[];
      filter?: string;
      shard?: string;
      workers?: number;
      reporter?: string;
      out?: string;
      via?: 'cdp' | 'extension' | 'playwright';
      allowHost: string[];
      readOnly: boolean;
      record: boolean;
      headless: boolean;
      maxSteps?: number;
      stepsPerFlow?: number;
      budget?: string;
      stopOnFail: boolean;
      json: boolean;
    }) => {
      const config = mergeConfig(opts.via, opts.allowHost, undefined, opts);
      const say = (line: string) => { if (!opts.json) console.log(line); };
      let suiteBudgetUsd: number | undefined;
      try { suiteBudgetUsd = parseBudgetFlag(opts.budget); } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(2); }
      const suiteBudget = new SpendBudget(suiteBudgetUsd);

      let suiteConfig;
      try {
        suiteConfig = resolveSuite();
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        process.exit(2);
      }

      // needsAuth is finally CONSUMED (it was validated and read by nothing):
      // a test that only makes sense signed in is skipped, out loud, rather
      // than run into a guaranteed failure.
      const hasAuth = Boolean(opts.storageState);
      const casePick = skipsForMissingAuth(suiteConfig.cases, hasAuth);
      const entryPick = skipsForMissingAuth(suiteConfig.entries, hasAuth);
      const skipped = casePick.skipped.length + entryPick.skipped.length;
      if (skipped) {
        console.error(
          `skipping ${skipped} test${skipped === 1 ? '' : 's'} that need a signed-in session — pass --storage-state <file> to include ${skipped === 1 ? 'it' : 'them'}: ` +
            [...casePick.skipped.map((c) => c.name), ...entryPick.skipped.map((e) => e.script)].join(', '),
        );
      }

      const items = labelSuiteItems(casePick.run, entryPick.run);
      // The runner speaks SuiteEntry; `script` here is the display label and
      // `items` says what actually runs behind it.
      let list: SuiteEntry[] = [...items].map(([label, item]) => ({ script: label, ...(item.value.tags && { tags: item.value.tags }) }));
      list = filterByTags(list, opts.tag);
      list = filterByString(list, opts.filter);
      if (opts.shard) {
        let shard;
        try {
          shard = parseShard(opts.shard);
        } catch (e) {
          console.error(e instanceof Error ? e.message : String(e));
          process.exit(2);
        }
        list = shardEntries(list, shard);
      }
      if (list.length === 0) {
        console.error(`nothing to run — ${SUITE_CONFIG_FILENAME} has no matching tests (check --tag/--filter/--shard, and whether everything needs a signed-in session)`);
        process.exit(2);
      }
      say(`running ${list.length} test${list.length === 1 ? '' : 's'} from ${SUITE_CONFIG_FILENAME}`);

      const jsonResults: unknown[] = [];
      const runOne = async (label: string): Promise<RunOneResult> => {
        const item = items.get(label);
        // A label always resolves — it came out of `items` — but a suite/setup
        // script named in the config does not, so fall back to replaying it.
        if (!item || item.kind === 'entry') {
          const report = await qaReplay(item ? (item.value as SuiteEntry).script : label, {
            heal: false,
            ...(opts.readOnly && { readOnly: true }),
            ...(withSpendCap(config, suiteBudget) && { config: withSpendCap(config, suiteBudget) }),
            onProgress: opts.json ? undefined : (l) => console.log(l),
            headless: opts.headless,
            storageStatePath: opts.storageState,
          });
          return { verdict: report.verdict, report };
        }
        const c = item.value;
        const report = await qaRun(c.task, c.url, {
          maxSteps: opts.stepsPerFlow ?? opts.maxSteps,
          ...(opts.readOnly && { readOnly: true }),
          record: opts.record,
          headless: opts.headless,
          storageStatePath: opts.storageState,
          ...(withSpendCap(config, suiteBudget) && { config: withSpendCap(config, suiteBudget) }),
          onProgress: opts.json ? undefined : (l) => console.log(l),
        });
        // `expect: 'fail'` flips the polarity — see applyExpectation.
        return { verdict: applyExpectation(report.verdict, c.expect), report, actualVerdict: report.verdict };
      };

      const onResult = (r: SuiteScriptResult) => {
        const report = r.result?.report as Report | undefined;
        const out = report ? { test: r.script, ...slimReport(report), ...(r.verdict !== report.verdict && { expectedVerdict: r.verdict }) } : { test: r.script, verdict: r.verdict, error: r.error };
        if (opts.json) jsonResults.push(out);
        else console.log(JSON.stringify(out, null, 2));
      };

      const outcome = await runSuite(list, guardRuns(runOne, { budget: suiteBudget, stopOnFail: opts.stopOnFail, log: (l) => console.error(l) }), {
        workers: opts.workers,
        setup: suiteConfig.setup,
        teardown: suiteConfig.teardown,
        onResult,
        isQuarantined: (script) => isQuarantined(script),
      });
      if (outcome.setup) console.error(`setup ${outcome.setup.verdict === 'pass' ? 'passed' : `${outcome.setup.verdict} — skipping ${list.length} test${list.length === 1 ? '' : 's'}`}`);
      if (suiteConfig.teardown && outcome.teardown) console.error(`teardown: ${suiteConfig.teardown} — ${outcome.teardown.verdict}`);

      if (opts.json) console.log(JSON.stringify(jsonResults, null, 2));
      else {
        const failedTests = outcome.results.filter((r) => r.verdict !== 'pass');
        say(`\n${outcome.results.length - failedTests.length}/${outcome.results.length} passed${failedTests.length ? ` — ${failedTests.map((r) => r.script).join(', ')}` : ''}`);
        if (suiteBudget.capUsd !== undefined) say(renderSpendLine(suiteBudget.totals()).trim());
      }

      emitSuiteReport(outcome, opts.reporter, opts.out, 'spike suite');
      process.exit(outcome.worst);
    },
  );

program
  .command('daemon')
  .description('start the vibe-mode daemon: a bridge the extension side panel connects to, driving QA runs from the GUI')
  .option('--bridge-port <n>', 'WebSocket port the extension connects to', (v) => parseInt(v, 10))
  .option('--install-service', 'register the daemon to auto-start on login (then exit), so the extension connects with no terminal', false)
  .option('--uninstall-service', 'remove the auto-start service registered by --install-service (then exit)', false)
  .action((opts: { bridgePort?: number; installService?: boolean; uninstallService?: boolean }) => {
    const cfg = loadConfig();
    const port = opts.bridgePort ?? cfg.bridgePort;

    // --install-service / --uninstall-service are one-shot: register (or remove)
    // the OS autostart entry and exit, rather than running the daemon inline.
    if (opts.installService || opts.uninstallService) {
      const res = opts.uninstallService
        ? uninstallService()
        : installService({ bridgePort: port });
      console.log(res.message);
      process.exit(res.ok ? 0 : 1);
    }

    const bridge = new BridgeServer(port, cfg.bridgeHost);
    const vibe = new VibeService(bridge);
    vibe.start();
    // A7: the daemon also owns the job list — tick every 60 s, one job at a time.
    startScheduler({ store: new JobStore(), run: childRunner(process.argv[1]), defaultBudgetUsd: loadConfig().unattendedBudgetUsd });
    console.log(`vibe daemon listening on ws://localhost:${port} — open the extension side panel`);
    // A12: the daemon also serves Spike home (loopback only). A busy port just means one is already up.
    const homePort = Number(process.env.SPIKE_DASHBOARD_PORT ?? DASHBOARD_DEFAULT_PORT);
    startDashboard(cfg.artifactsDir, homePort).then(
      () => console.log(`Spike home: http://127.0.0.1:${homePort}/`),
      (e: unknown) => console.warn(`Spike home is not available (${e instanceof Error ? e.message : String(e)}).`),
    );
    // stay alive; the bridge owns the WS server from here
    return new Promise<void>(() => {});
  });

/* A7 — scheduled and watched runs. Jobs live in ~/.spike/jobs.json; the daemon runs them. */
const schedule = program.command('schedule').description('run tests on a timer while Spike Core is running');
schedule
  .command('add')
  .description('save a scheduled test: when is e.g. "every 30m", "hourly", "daily 09:00", "weekdays 09:00" (local time)')
  .argument('<when>', 'every <N>m|h | hourly | daily HH:MM | weekdays HH:MM')
  .argument('<what>', 'suite | tag:<name> | check | spec:<file>')
  .requiredOption('--url <url>', 'the site to test')
  .option('--budget <usd>', 'most this test may spend in 24 hours; once reached it pauses until the window passes (default: the unattended limit, $1 unless you changed it)', (v) => parseFloat(v))
  .option('--webhook <url>', 'also POST here when a test starts or stops failing')
  .action((when: string, what: string, opts: { url: string; budget?: number; webhook?: string }) => {
    try {
      const job = new JobStore().add({ target: what, url: opts.url, when, budgetUsd: opts.budget, webhook: opts.webhook });
      console.log(`Scheduled ${what} ${when} (id ${job.id}).`);
      console.log(`It will spend at most ${formatUsd(job.budgetUsd ?? loadConfig().unattendedBudgetUsd)} in any 24 hours.`);
      console.log('Scheduled tests run while Spike Core is running — start it with `spike daemon --install-service`');
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(2);
    }
  });
schedule
  .command('list')
  .description('show scheduled tests and how the last one went')
  .action(() => {
    const jobs = new JobStore().list();
    if (!jobs.length) { console.log('Nothing scheduled.'); return; }
    for (const j of jobs) {
      let nextTxt = '?';
      try { nextTxt = isDue(j, Date.now()) ? 'due now' : new Date(nextDue(j, Date.now())).toLocaleString(); } catch { /* keep ? */ }
      console.log(`${j.id}  ${j.when.padEnd(14)} ${j.kind}${j.target ? ':' + j.target : ''}  ${j.url}  last: ${j.lastVerdict ?? 'never run'}  next: ${nextTxt}`);
    }
  });
schedule
  .command('remove')
  .argument('<id>')
  .description('stop a scheduled test')
  .action((id: string) => {
    if (!new JobStore().remove(id)) { console.error(`No scheduled test with id ${id}.`); process.exit(2); }
    console.log(`Removed ${id}.`);
  });
schedule
  .command('run-now')
  .argument('<id>')
  .description('run a scheduled test right now and record the result')
  .action(async (id: string) => {
    const store = new JobStore();
    const job = store.get(id);
    if (!job) { console.error(`No scheduled test with id ${id}.`); process.exit(2); }
    const r = await runJob(job, { store, run: childRunner(process.argv[1]), defaultBudgetUsd: loadConfig().unattendedBudgetUsd });
    console.log(`${id}: ${r.verdict}${r.summary ? ' — ' + r.summary : ''}`);
    process.exit(exitCodeForVerdict(r.verdict));
  });

program
  .command('watch')
  .description('re-run your saved tests whenever your code changes (stays in the foreground)')
  .requiredOption('--url <url>', 'your dev server address')
  .option('--tag <tag>', 'run only tests with this tag')
  .option('--suite <file>', 'run the suite in this file (spike.suite.json) instead of the one in this folder')
  .option('--on <when>', 'save (default) | commit', 'save')
  .option('--paths <glob>', 'only react to changes to files matching this pattern')
  .option('--webhook <url>', 'also POST here when a test starts or stops failing')
  .option('--budget <usd>', 'most the watched runs may spend in 24 hours (default: the unattended limit, $1 unless you changed it)')
  .option('--changed', 'skip a run when only docs or tests changed, and say which pages the change touches', false)
  .action((opts: { url: string; tag?: string; suite?: string; on: string; paths?: string; webhook?: string; budget?: string; changed: boolean }) => {
    let watchCap: number;
    try { watchCap = resolveUnattendedBudget(parseBudgetFlag(opts.budget), loadConfig()) ?? Infinity; } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(2); }
    const spendLog: Array<{ at: number; usd: number }> = [];
    if (opts.on !== 'save' && opts.on !== 'commit') { console.error('--on must be save or commit'); process.exit(2); }
    const cli = process.argv[1];
    // the suite command reads spike.suite.json from its working directory
    const suiteDir = opts.suite ? path.dirname(path.resolve(opts.suite)) : undefined;
    let last: 'pass' | 'fail' | 'uncertain' | null = null;
    const controller = new WatchController({
      run: async () => {
        if (opts.changed) {
          try {
            const { computeChangeScope, realGit } = await import('./change-scope/change-scope.js');
            const scope = computeChangeScope(realGit(), opts.on === 'commit' ? 'HEAD~1' : undefined);
            if (scope.skip) { console.log(`Skipped: ${scope.reason}`); return; }
            console.log(scope.reason);
          } catch (e) { console.log(e instanceof Error ? e.message : String(e)); }
        }
        console.log('Change noticed — running your tests…');
        const job = { id: 'watch', kind: opts.tag ? 'tag' : 'suite', target: opts.tag ?? '', url: opts.url, when: 'watch', createdAt: 0, lastRunAt: null, lastVerdict: null, spentTodayUsd: 0 } as const;
        const nowMs = Date.now();
        while (spendLog.length && nowMs - spendLog[0].at >= 24 * 3_600_000) spendLog.shift();
        const spent = spendLog.reduce((a, e) => a + e.usd, 0);
        if (spent >= watchCap) {
          console.log(`Skipped: spending limit reached (${formatUsd(spent)} of ${formatUsd(watchCap)} in the last 24 hours). Raise it with --budget.`);
          return;
        }
        const r = await childRunner(cli, suiteDir)(job, { budgetUsd: Number.isFinite(watchCap) ? watchCap - spent : undefined });
        spendLog.push({ at: nowMs, usd: r.costUsd ?? 0 });
        console.log(`Result: ${r.verdict}`);
        await notifyIfFlipped(last, { job: 'watch', verdict: r.verdict, url: opts.url, summary: r.summary ?? r.verdict }, opts.webhook);
        last = r.verdict;
      },
    });
    console.log(`Watching for ${opts.on === 'commit' ? 'commits' : 'changes'} in ${process.cwd()} — press Ctrl-C to stop.`);
    startFsWatch({ root: process.cwd(), on: opts.on, paths: opts.paths, onChange: () => controller.event() });
    return new Promise<void>(() => {});
  });

program
  .command('fix')
  .description('print the fix prompt for a finished run — or with --apply, hand it to your coding agent headlessly')
  .argument('<runIdOrPath>', 'a runId under artifacts/, or a path to a report.json')
  .option('--apply', 'dispatch the prompt to the configured coding agent (claude/codex/gemini auto-detected)', false)
  .option('--yes-auto-fix', 'pre-accept the one-time per-project auto-fix consent for this non-interactive run', false)
  .action(async (runIdOrPath: string, opts: { apply: boolean; yesAutoFix: boolean }) => {
    const cfg = loadConfig();
    const candidates = [
      runIdOrPath,
      path.join(cfg.artifactsDir, runIdOrPath, 'report.json'),
      path.join(cfg.artifactsDir, runIdOrPath), // in case they passed artifacts/<runId>
    ];
    const found = candidates.find((p) => {
      try { return fs.statSync(p).isFile(); } catch { return false; }
    });
    if (!found) {
      console.error(`no report.json found for "${runIdOrPath}" (looked in artifacts/<runId>/report.json and as a path)`);
      process.exit(2);
    }
    let report: Report;
    try {
      report = JSON.parse(fs.readFileSync(found, 'utf8')) as Report;
    } catch (e) {
      console.error(`could not parse ${found}: ${e instanceof Error ? e.message : e}`);
      process.exit(2);
    }
    const prompt = buildFixPrompt(report);
    if (!prompt) {
      console.log(`run ${report.runId} passed (${report.verdict}) — no fix prompt needed.`);
      return;
    }
    if (opts.apply) {
      // A11: see the --fix path above — the command line's own working
      // directory is the explicit project choice when none is configured.
      const result = await dispatchFix(report, { onProgress: (l) => console.log(l), defaultCwd: process.cwd(), yesAutoFix: opts.yesAutoFix });
      console.log(result.ok ? `fix applied by ${result.agent} — re-run the test to verify` : `fix agent failed`);
      process.exit(result.ok ? 0 : 1);
    }
    console.log(prompt);
  });

/** A5 (P0): read one line from stdin without echoing it.
 *
 * `spike secret set <name> <value>` put the value in the shell's history and on
 * screen. Omitting the value now prompts for it instead: keystrokes are
 * swallowed while typing (a paste included), so nothing is left behind in the
 * scrollback or in ~/.bash_history.
 *
 * Two paths, because both are real: an interactive terminal gets the muted
 * prompt; a piped stdin (`echo … | spike secret set NAME`) just reads the line,
 * which is how a script or a password manager would feed it.
 */
function readSecretFromStdin(promptText: string): Promise<string> {
  const input = process.stdin;
  const output = process.stdout;
  const interactive = Boolean(input.isTTY && output.isTTY);
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input, output, terminal: interactive });
    if (interactive) {
      // readline writes every keystroke back to the terminal; replace that with
      // nothing for everything after the prompt itself.
      let shown = false;
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
        if (!shown) {
          output.write(promptText);
          shown = true;
        }
      };
    }
    let answered = false;
    rl.question(interactive ? promptText : '', (answer) => {
      answered = true;
      rl.close();
      if (interactive) output.write('\n');
      resolve(answer.trim());
    });
    // stdin ended without a line (an empty pipe, or Ctrl-D): resolve empty so
    // the caller reports "nothing entered" instead of hanging forever.
    rl.on('close', () => {
      if (!answered) {
        if (interactive) output.write('\n');
        resolve('');
      }
    });
    rl.on('error', reject);
  });
}

program
  .command('secret')
  .description('manage the local encrypted vault — secrets are typed via {{secret:NAME}} and never reach any model')
  .argument('<action>', 'set | get | list | delete')
  .argument('[name]', 'secret name')
  .argument('[value]', 'secret value (for set) — omit it to be prompted, hidden as you type')
  .option('--reveal', 'with get: print the value (default only confirms existence)', false)
  .action(async (action: string, name?: string, value?: string, opts?: { reveal: boolean }) => {
    const vault = new Vault();
    switch (action) {
      case 'set': {
        if (!name) {
          console.error('usage: spike secret set <name> [value]   (omit the value to type it hidden)');
          process.exit(2);
        }
        // A5: no value on the command line → ask for it with echo off, so a
        // password is never written into the shell's history or left on screen.
        const secret = value !== undefined ? value : await readSecretFromStdin(`Value for ${name} (hidden): `);
        if (!secret) {
          console.error('nothing entered — no secret was saved');
          process.exit(2);
        }
        vault.set(name, secret);
        console.log(`set "${name}" — use it in tasks as {{secret:${name}}}`);
        break;
      }
      case 'get': {
        if (!name) { console.error('usage: spike secret get <name> [--reveal]'); process.exit(2); }
        const v = vault.get(name);
        if (v === undefined) { console.error(`no secret "${name}"`); process.exit(1); }
        console.log(opts?.reveal ? v : `"${name}" exists (use --reveal to print)`);
        break;
      }
      case 'list':
        console.log(vault.list().join('\n') || '(no secrets)');
        break;
      case 'delete':
        if (!name) { console.error('usage: spike secret delete <name>'); process.exit(2); }
        console.log(vault.delete(name) ? `deleted "${name}"` : `no secret "${name}"`);
        break;
      default:
        console.error('usage: spike secret <set|get|list|delete>');
        process.exit(2);
    }
  });

program
  .command('mcp')
  .description('start the MCP stdio server — register it in your coding agent as command "spike", args ["mcp"] (or command "node", args ["<repo>/dist/mcp-server.js"] from a source checkout); see the README for Claude Code / Cursor / Codex / Windsurf')
  .action(async () => {
    const { startMcpServer } = await import('./mcp-server.js');
    await startMcpServer();
    // keep the process alive; the transport owns stdin/stdout from here
    await new Promise(() => {});
  });

program
  .command('setup')
  .description('connect Spike to the coding agents on this machine (Claude Code, Cursor, Windsurf, Codex, Gemini) so they can call it; shows what changes and asks once')
  .option('--yes', 'apply without asking', false)
  .option('--dry-run', 'show what would change and write nothing', false)
  .option('--project', 'write into the current project folder instead of your user account', false)
  .option('--only <agents>', 'comma-separated: claude,cursor,codex,windsurf,gemini')
  .option('--force', 'replace a different existing "spike" entry', false)
  .option('--uninstall', 'remove exactly what setup added (backups are kept)', false)
  .option('--no-verify', 'skip the quick health check at the end')
  .action(async (opts: { yes: boolean; dryRun: boolean; project: boolean; only?: string; force: boolean; uninstall: boolean; verify: boolean }) => {
    const { runSetup, defaultSetupEnv, probeMcpTools } = await import('./setup/command.js');
    const code = await runSetup(opts, {
      env: defaultSetupEnv(),
      isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
      confirm: () => new Promise<boolean>((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question('Apply these changes? [y/N] ', (a) => { rl.close(); resolve(/^y(es)?$/i.test(a.trim())); });
      }),
      out: (l) => console.log(l),
      verify: async () => {
        const cfg = loadConfig();
        const lines: string[] = [];
        let ok = true;
        try { lines.push(`  ok  Chrome found (${findChrome(cfg.chromePath)})`); }
        catch { ok = false; lines.push('  !!  Chrome was not found: install Chrome or set SPIKE_CHROME_PATH'); }
        try {
          const ladder = await createPlanningRouter().probeLadder();
          const roles = buildRoleProbes(cfg, ladder, false).filter((r) => r.role !== 'visual');
          for (const r of roles) {
            const name = r.role === 'navigator' ? 'the model that clicks' : 'the model that plans';
            if (r.available || r.fallback) lines.push(`  ok  ${name} is reachable`);
            else { ok = false; lines.push(`  !!  ${name} is not reachable: add an AI key or sign in to your AI CLI (see: spike doctor)`); }
          }
        } catch (e) { ok = false; lines.push(`  !!  could not check models: ${e instanceof Error ? e.message : String(e)}`); }
        const mcp = await probeMcpTools(process.argv[1]);
        if (mcp.ok) lines.push(`  ok  the agent connection answers (${mcp.tools} tool${mcp.tools === 1 ? '' : 's'})`);
        else { ok = false; lines.push(`  !!  the agent connection did not answer${mcp.error ? `: ${mcp.error}` : ''}`); }
        return { ok, lines };
      },
    });
    process.exit(code);
  });

program
  .command('nano')
  .description('check or set up the on-device Gemini Nano model (rung 0)')
  .option('--check', 'report availability', false)
  .option('--download', 'trigger the ~2GB model download if needed', false)
  .action(async (opts: { check: boolean; download: boolean }) => {
    const cfg = loadConfig();
    const nano = new NanoRunnerPage({
      cdpPort: cfg.cdpPort,
      runnerPort: cfg.runnerPort,
      profileDir: cfg.chromeProfile,
    });
    await nano.start();
    try {
      if (opts.download) {
        const a = await nano.ensureModel((s) => console.log('  ' + s));
        console.log('availability:', a);
      } else {
        console.log('availability:', await nano.availability());
      }
    } finally {
      await nano.close(); // Chrome + runner tab stay alive (warm model)
    }
  });

program
  .command('dashboard')
  .description('open Spike home: your past runs, saved tests, site map and schedules, on this computer only ($0, no outside requests); Spike Core serves the same page')
  .option('--port <n>', 'HTTP port (default 9420, or SPIKE_DASHBOARD_PORT)', (v) => parseInt(v, 10))
  .option('--no-open', 'do not open the browser')
  .option('--host <addr>', 'interface to listen on (default 127.0.0.1 — this machine only)')
  .action(async (opts: { port?: number; host?: string; open: boolean }) => {
    const cfg = loadConfig();
    const port = opts.port ?? Number(process.env.SPIKE_DASHBOARD_PORT ?? DASHBOARD_DEFAULT_PORT);
    if (opts.host && !isLoopbackHost(opts.host)) {
      console.warn(`warning: --host ${opts.host} lets other machines on your network read your past reports, including screenshots of pages you were logged in to.`);
    }
    const server = await startDashboard(cfg.artifactsDir, port, { host: opts.host });
    const addr = server.address();
    const bound = addr && typeof addr === 'object' ? `${addr.address.includes(':') ? `[${addr.address}]` : addr.address}:${addr.port}` : `${opts.host ?? '127.0.0.1'}:${port}`;
    console.log(`dashboard on http://${bound} — reading ${cfg.artifactsDir}`);
    if (opts.open) openInBrowser(`http://${bound}/`);
    // stay alive; the http.Server owns the process from here
    return new Promise<void>(() => {});
  });

program.parseAsync().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  // A47 (P2): anything that escapes an action handler unhandled here is an
  // infra/tool failure (Chrome didn't launch, a config file was unreadable, a
  // bug) — never a verdict. Exit 3 keeps that distinguishable from exit 1
  // (verdict fail) and exit 2 (verdict uncertain), both of which already
  // exit directly from inside their action before ever reaching this catch.
  process.exit(INFRA_ERROR_EXIT_CODE);
});
