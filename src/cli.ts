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
import { allocateIsolatedSession, createPlanningRouter, isQuarantined, qaReplay, qaRun, type QaReplayResult } from './engine.js';
import { decomposeSpec, renderFlowTable, runFlows } from './driver/spec-decompose.js';
import { slimReport, type Report } from './report/report.js';
import { findChrome } from './chrome/launch.js';
import { buildDoctorReport, doctorExitCode, renderDoctorReport, type DoctorRoleProbe } from './doctor.js';
import type { Capability } from './router/adapter.js';
import type { LadderStatus } from './router/model-router.js';
import { applyExpectation, resolveSuite, skipsForMissingAuth, SUITE_CONFIG_FILENAME, type SuiteCase, type SuiteEntry } from './suite/config.js';
import { runSuite, filterByTags, filterByString, parseShard, shardEntries, type RunOneResult, type SuiteScriptResult } from './suite/runner.js';
import { isSuiteReporter, writeSuiteReport, SUITE_REPORTERS } from './suite/reporters.js';
import { DEFAULT_BASELINE_DIR, blessBaseline } from './assertions/differential.js';
import { coverageReport, diffAppModel, discoverApp, emptyAppModel, loadAppModel, saveAppModel, type Fetched } from './discovery/index.js';
import { BridgeServer } from './bridge/bridge-server.js';
import { VibeService } from './vibe/service.js';
import { installService, uninstallService } from './service/install-service.js';
import { buildFixPrompt } from './vibe/fix-prompt.js';
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
): Partial<QaConfig> | undefined {
  const config: Partial<QaConfig> = {};
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
  .option('--yes-auto-fix', 'pre-accept the one-time per-project auto-fix consent for this non-interactive run', false)
  .option('--json', 'print the slim JSON verdict only', false)
  .action(async (task: string | undefined, opts: { url: string; spec?: string; maxSteps?: number; via?: 'cdp' | 'extension' | 'playwright'; allowHost: string[]; actionCache?: boolean; readOnly: boolean; record: boolean; replay: boolean; headless: boolean; storageState?: string; saveStorageState?: string; fix: boolean; maxFixAttempts?: number; yesAutoFix: boolean; json: boolean }) => {
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
    const config = mergeConfig(opts.via, opts.allowHost, opts.actionCache);
    const qaRunOpts = {
      maxSteps: opts.maxSteps,
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
    const runOneTask = async (t: string) =>
      opts.fix
        ? (await runWithAutoFix(t, opts.url, {
            maxAttempts: opts.maxFixAttempts ?? 2,
            config: qaRunOpts.config,
            onProgress,
            qaRunOpts,
            // A11: on the command line the directory the user typed the command
            // in IS the explicit choice of project, so it stands in for an
            // unset project folder. The panel gets no such fallback.
            defaultCwd: process.cwd(),
            yesAutoFix: opts.yesAutoFix,
          })).finalReport
        : await qaRun(t, opts.url, qaRunOpts);

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
      const outcome = await runFlows(flows, {
        runFlow: (flow) => runOneTask(flow.task),
        onProgress,
      });
      if (opts.json) {
        console.log(JSON.stringify(outcome, null, 2));
      } else {
        console.log(`\n${renderFlowTable(outcome)}`);
      }
      process.exit(exitCodeForVerdict(outcome.verdict));
    }

    const report = await runOneTask(task as string);
    console.log(JSON.stringify(slimReport(report), null, 2));
    if (!opts.json) console.log(`full report: ${report.evidence_paths[0]}`);
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
const httpFetcher = async (url: string): Promise<Fetched | null> => {
  try {
    const res = await fetch(url, { redirect: 'follow' });
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('html')) return { url: res.url || url, status: res.status, html: '' };
    return { url: res.url || url, status: res.status, html: await res.text() };
  } catch {
    return null; // a dead end, not a crash — the crawler moves on
  }
};

function collectAppDirFiles(root: string): { files: string[]; routerKind: 'app' | 'pages' } | undefined {
  for (const [dir, routerKind] of [['app', 'app'], ['src/app', 'app'], ['pages', 'pages'], ['src/pages', 'pages']] as const) {
    const abs = path.resolve(root, dir);
    if (!fs.existsSync(abs)) continue;
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p2 = path.join(d, e.name);
        if (e.isDirectory()) walk(p2);
        else files.push(path.relative(abs, p2));
      }
    };
    walk(abs);
    if (files.length) return { files, routerKind };
  }
  return undefined;
}

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

program
  .command('map')
  .description('discover the app: routes + states + interactive elements, into .spike/app-model.json ($0, no browser)')
  .argument('<url>', 'seed URL — also fixes the same-origin crawl boundary')
  .option('--max-depth <n>', 'link-hops to follow', (v) => parseInt(v, 10))
  .option('--max-pages <n>', 'hard cap on pages fetched', (v) => parseInt(v, 10))
  .option('--diff', 'compare against the stored model and print what changed', false)
  .option('--json', 'machine-readable output', false)
  .action(async (url: string, opts: { maxDepth?: number; maxPages?: number; diff: boolean; json: boolean }) => {
    const root = process.cwd();
    const previousModel = loadAppModel(root);
    const src = collectAppDirFiles(root);
    const model = await discoverApp({
      baseUrl: url,
      fetcher: httpFetcher,
      ...(src && { appDirFiles: src.files, routerKind: src.routerKind }),
      previousModel,
      crawl: {
        ...(opts.maxDepth !== undefined && { maxDepth: opts.maxDepth }),
        ...(opts.maxPages !== undefined && { maxPages: opts.maxPages }),
      },
    });
    saveAppModel(model, root);
    const cov = coverageReport(model);
    if (opts.diff) {
      const d = diffAppModel(previousModel ?? emptyAppModel(url), model);
      if (opts.json) {
        console.log(JSON.stringify({ coverage: cov, diff: d }, null, 2));
      } else {
        console.log(`mapped ${cov.routes.total} route(s) — ${d.newRoutes.length} new, ${d.changedRoutes.length} changed, ${d.removedRoutes.length} removed`);
        for (const e of d.prioritized.slice(0, 20)) console.log(`  ${e.kind.padEnd(9)} ${e.route}`);
      }
      process.exit(0);
    }
    if (opts.json) console.log(JSON.stringify({ coverage: cov }, null, 2));
    else console.log(`mapped ${cov.routes.total} route(s), ${cov.interactiveElements.total} interactive element(s) → .spike/app-model.json`);
    process.exit(0);
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
  .option('--debug-mode <d>', 'prompt|auto')
  .option('--debug-agent <a>', 'auto|claude|codex|gemini')
  .action((action: string, opts: { provider?: string; mode?: string; model?: string; navigatorProvider?: string; navigatorMode?: string; navigatorModel?: string; strictOracles?: string; debugMode?: string; debugAgent?: string }) => {
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
        'nothing to set — pass at least one of: --provider --mode --model --navigator-provider --navigator-mode --navigator-model --strict-oracles --debug-mode --debug-agent',
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
  .option('--auth-fixture', 'with --all + a configured suite setup script: run setup once, capture the storage state it produces, and inject it into every entry — "log in once, reuse everywhere"', false)
  .action(
    async (
      name: string | undefined,
      opts: {
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
      },
    ) => {
      const config = mergeConfig(opts.via, opts.allowHost);

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
        const perCallConfig = isolation ? { ...config, ...isolation } : config;
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
      const outcome = await runSuite(entries, runOne, {
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

type SuiteItem = { kind: 'case'; value: SuiteCase } | { kind: 'entry'; value: SuiteEntry };

/** Give every case and entry a unique display label — this is what the
 * runner, the reporters and the exit-code roll-up all key on. A case whose
 * name collides with a recorded script's gets a `case: ` prefix rather than
 * silently shadowing it. */
function labelSuiteItems(cases: SuiteCase[], entries: SuiteEntry[]): Map<string, SuiteItem> {
  const items = new Map<string, SuiteItem>();
  const scriptNames = new Set(entries.map((e) => e.script));
  for (const c of cases) {
    let label = scriptNames.has(c.name) || items.has(c.name) ? `case: ${c.name}` : c.name;
    while (items.has(label)) label = `${label}'`;
    items.set(label, { kind: 'case', value: c });
  }
  for (const e of entries) {
    let label = e.script;
    while (items.has(label)) label = `${label}'`;
    items.set(label, { kind: 'entry', value: e });
  }
  return items;
}

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
  .option('--json', 'print slim JSON verdicts only', false)
  .action(
    async (opts: {
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
      json: boolean;
    }) => {
      const config = mergeConfig(opts.via, opts.allowHost);
      const say = (line: string) => { if (!opts.json) console.log(line); };

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
            ...(config && { config }),
            onProgress: opts.json ? undefined : (l) => console.log(l),
            headless: opts.headless,
            storageStatePath: opts.storageState,
          });
          return { verdict: report.verdict, report };
        }
        const c = item.value;
        const report = await qaRun(c.task, c.url, {
          maxSteps: opts.maxSteps,
          ...(opts.readOnly && { readOnly: true }),
          record: opts.record,
          headless: opts.headless,
          storageStatePath: opts.storageState,
          ...(config && { config }),
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

      const outcome = await runSuite(list, runOne, {
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
    console.log(`vibe daemon listening on ws://localhost:${port} — open the extension side panel`);
    // stay alive; the bridge owns the WS server from here
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
  .description('start the MCP stdio server (register in a coding agent as: command "spike", args ["mcp"])')
  .action(async () => {
    const { startMcpServer } = await import('./mcp-server.js');
    await startMcpServer();
    // keep the process alive; the transport owns stdin/stdout from here
    await new Promise(() => {});
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
  .description('serve a local read-only dashboard over artifacts/<runId> reports — model_trace, token accounting, cache/replay stats; $0, no backend, no external calls')
  .option('--port <n>', 'HTTP port (default 9420, or SPIKE_DASHBOARD_PORT)', (v) => parseInt(v, 10))
  .action((opts: { port?: number }) => {
    const cfg = loadConfig();
    const port = opts.port ?? Number(process.env.SPIKE_DASHBOARD_PORT ?? 9420);
    startDashboard(cfg.artifactsDir, port);
    console.log(`dashboard on http://localhost:${port} — reading ${cfg.artifactsDir}`);
    // stay alive; the http.Server owns the process from here
    return new Promise<void>(() => {});
  });

/* ---------------------------------------------------------------------------
 * `spike dashboard` — a read-only, $0, no-backend localhost view over
 * artifacts/<runId>/report.json files. Hand-rolled HTML (no template engine,
 * no client-side JS, no external fonts/scripts — the CLI has zero non-Node
 * dependencies for this and it stays that way). Never mutates artifacts/. */

interface DashboardRunSummary {
  runId: string;
  task: string;
  url: string;
  verdict: string;
  durationMs: number;
  steps: number;
  tokenEstimate: number;
  navigatorCalls?: number;
  brainCalls?: number;
  visualCalls?: number;
  actionCache?: Report['action_cache'];
  replayMatch?: { name: string; score: number };
  healed?: boolean;
  mtimeMs: number;
}

/** Only alphanumerics/-/_ — ArtifactStore mints runIds from an ISO timestamp
 * + a short random suffix, so this also doubles as a path-traversal guard on
 * the `/run/:id` route (the id comes straight off the URL). */
const SAFE_RUN_ID = /^[A-Za-z0-9_-]+$/;

function listDashboardRuns(artifactsDir: string): DashboardRunSummary[] {
  if (!fs.existsSync(artifactsDir)) return [];
  const runs: DashboardRunSummary[] = [];
  for (const entry of fs.readdirSync(artifactsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !SAFE_RUN_ID.test(entry.name)) continue;
    const reportPath = path.join(artifactsDir, entry.name, 'report.json');
    try {
      const stat = fs.statSync(reportPath);
      const r = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as Report & { replayMatch?: { name: string; score: number }; healed?: boolean };
      runs.push({
        runId: r.runId ?? entry.name,
        task: r.task ?? '',
        url: r.url ?? '',
        verdict: r.verdict ?? 'uncertain',
        durationMs: r.durationMs ?? 0,
        steps: Array.isArray(r.steps) ? r.steps.length : 0,
        tokenEstimate: r.tokenEstimate ?? 0,
        navigatorCalls: r.tokens?.navigatorCalls,
        brainCalls: r.tokens?.brainCalls,
        visualCalls: r.tokens?.visualCalls,
        actionCache: r.action_cache,
        replayMatch: r.replayMatch,
        healed: r.healed,
        mtimeMs: stat.mtimeMs,
      });
    } catch {
      /* missing/corrupt report.json — skip, never break the whole dashboard */
    }
  }
  return runs.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

const DASHBOARD_STYLE = `
  body { font: 14px/1.5 -apple-system, Segoe UI, sans-serif; margin: 0; padding: 24px; background: #0b0d12; color: #e6e8ee; }
  a { color: #7cb7ff; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: #8b93a7; margin-bottom: 20px; font-size: 12px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #232838; font-size: 13px; vertical-align: top; }
  th { color: #8b93a7; font-weight: 600; text-transform: uppercase; font-size: 11px; letter-spacing: 0.04em; }
  tr:hover td { background: #12151e; }
  .pass { color: #5fd08a; font-weight: 600; }
  .fail { color: #f27878; font-weight: 600; }
  .uncertain { color: #e6c15c; font-weight: 600; }
  .pill { display: inline-block; padding: 1px 6px; border-radius: 10px; background: #1c2131; font-size: 11px; margin-right: 4px; }
  code, pre { font: 12px/1.5 ui-monospace, Consolas, monospace; }
  pre { background: #12151e; padding: 10px; border-radius: 6px; overflow: auto; white-space: pre-wrap; word-break: break-word; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; margin: 12px 0 20px; }
  .stat { background: #12151e; border-radius: 8px; padding: 10px 12px; }
  .stat .n { font-size: 20px; font-weight: 700; }
  .stat .l { color: #8b93a7; font-size: 11px; text-transform: uppercase; }
  .back { display: inline-block; margin-bottom: 14px; }
`;

function verdictClass(v: string): string {
  return v === 'pass' ? 'pass' : v === 'fail' ? 'fail' : 'uncertain';
}

function renderDashboardIndex(runs: DashboardRunSummary[], artifactsDir: string): string {
  const rows = runs
    .map((r) => {
      const source = r.replayMatch
        ? `<span class="pill">$0 replay (${(r.replayMatch.score * 100).toFixed(0)}%)</span>`
        : r.healed
          ? '<span class="pill">healed</span>'
          : '<span class="pill">AI run</span>';
      const cache = r.actionCache?.enabled ? `<span class="pill">cache ${r.actionCache.hits}/${r.actionCache.hits + r.actionCache.misses}</span>` : '';
      return `<tr>
        <td><a href="/run/${encodeURIComponent(r.runId)}">${escapeHtml(r.runId)}</a></td>
        <td class="${verdictClass(r.verdict)}">${escapeHtml(r.verdict)}</td>
        <td>${escapeHtml(r.task).slice(0, 90)}</td>
        <td>${escapeHtml(r.url)}</td>
        <td>${r.steps}</td>
        <td>${(r.durationMs / 1000).toFixed(1)}s</td>
        <td>${source}${cache}</td>
      </tr>`;
    })
    .join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>spike dashboard</title><style>${DASHBOARD_STYLE}</style></head><body>
    <h1>Spike — run dashboard</h1>
    <div class="sub">${runs.length} run(s) in ${escapeHtml(artifactsDir)} — read-only, local only, no external calls</div>
    <table>
      <tr><th>run</th><th>verdict</th><th>task</th><th>url</th><th>steps</th><th>duration</th><th>source</th></tr>
      ${rows || '<tr><td colspan="7">no runs yet — \`spike run\` writes one here on completion</td></tr>'}
    </table>
  </body></html>`;
}

function renderDashboardRun(report: Report & { replayMatch?: { name: string; score: number }; healed?: boolean }): string {
  const t = report.tokens;
  const stats = [
    ['verdict', report.verdict],
    ['duration', `${(report.durationMs / 1000).toFixed(1)}s`],
    ['steps', String(report.steps?.length ?? 0)],
    ['verdict payload (tokens)', String(report.tokenEstimate ?? 0)],
    ['navigator calls', String(t?.navigatorCalls ?? 0)],
    ['brain calls', String(t?.brainCalls ?? 0)],
    ['visual calls', String(t?.visualCalls ?? 0)],
    ['cheap model total', String(t?.cheapModelTotal ?? 0)],
  ];
  const statHtml = stats.map(([l, n]) => `<div class="stat"><div class="n">${escapeHtml(n)}</div><div class="l">${escapeHtml(l)}</div></div>`).join('');

  const source = report.replayMatch
    ? `matched $0 replay: <code>${escapeHtml(report.replayMatch.name)}</code> (score ${report.replayMatch.score.toFixed(2)})`
    : report.healed !== undefined
      ? `self-heal: ${report.healed ? 'succeeded' : 'failed'}`
      : 'fresh AI run';

  const cache = report.action_cache
    ? `<p>action cache: ${report.action_cache.enabled ? `hits ${report.action_cache.hits}, misses ${report.action_cache.misses}, stale ${report.action_cache.stale}, stored ${report.action_cache.stored}` : 'disabled'}</p>`
    : '';

  const traceRows = (report.model_trace ?? [])
    .map((m) => `<tr><td>${m.step}</td><td>${escapeHtml(m.capability)}</td><td>${m.rung}</td><td>${escapeHtml(m.adapter)}</td><td>${m.ms}ms</td><td>${escapeHtml(m.note ?? '')}</td></tr>`)
    .join('\n');

  const assertionRows = (report.assertion_trace ?? [])
    .map((a) => `<tr><td>${a.step}</td><td>${escapeHtml(a.policy)}</td><td class="${verdictClass(a.verdict)}">${escapeHtml(a.verdict)}</td><td>${a.disagreement ? 'yes' : 'no'}</td><td>${escapeHtml(a.summary).slice(0, 120)}</td></tr>`)
    .join('\n');

  const stepRows = (report.steps ?? [])
    .map((s) => `<tr><td>${s.index}</td><td>${s.ok ? 'ok' : 'FAIL'}</td><td>${escapeHtml(s.description)}</td><td>${escapeHtml(s.error ?? '')}</td></tr>`)
    .join('\n');

  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(report.runId)} — spike dashboard</title><style>${DASHBOARD_STYLE}</style></head><body>
    <a class="back" href="/">&larr; all runs</a>
    <h1 class="${verdictClass(report.verdict)}">${escapeHtml(report.runId)} — ${escapeHtml(report.verdict)}</h1>
    <div class="sub">${escapeHtml(report.task)}<br>${escapeHtml(report.url)}<br>${source}</div>
    <div class="grid">${statHtml}</div>
    ${cache}
    <h2>model_trace</h2>
    <table><tr><th>step</th><th>capability</th><th>rung</th><th>adapter</th><th>latency</th><th>note</th></tr>${traceRows || '<tr><td colspan="6">(empty — deterministic replay, no planner calls)</td></tr>'}</table>
    ${report.assertion_trace ? `<h2>assertion_trace</h2><table><tr><th>step</th><th>policy</th><th>verdict</th><th>disagreement</th><th>summary</th></tr>${assertionRows}</table>` : ''}
    <h2>steps</h2>
    <table><tr><th>#</th><th>ok</th><th>description</th><th>error</th></tr>${stepRows}</table>
    <h2>reason</h2>
    <pre>${escapeHtml(report.reason)}</pre>
  </body></html>`;
}

function startDashboard(artifactsDir: string, port: number): void {
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(renderDashboardIndex(listDashboardRuns(artifactsDir), artifactsDir));
        return;
      }
      const m = url.pathname.match(/^\/run\/([^/]+)$/);
      if (m) {
        const runId = decodeURIComponent(m[1]);
        if (!SAFE_RUN_ID.test(runId)) {
          res.writeHead(400, { 'content-type': 'text/plain' });
          res.end('invalid run id');
          return;
        }
        const reportPath = path.join(artifactsDir, runId, 'report.json');
        if (!fs.existsSync(reportPath)) {
          res.writeHead(404, { 'content-type': 'text/plain' });
          res.end(`no report.json for run ${runId}`);
          return;
        }
        const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as Report;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(renderDashboardRun(report));
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(e instanceof Error ? e.message : String(e));
    }
  });
  server.listen(port);
}

program.parseAsync().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  // A47 (P2): anything that escapes an action handler unhandled here is an
  // infra/tool failure (Chrome didn't launch, a config file was unreadable, a
  // bug) — never a verdict. Exit 3 keeps that distinguishable from exit 1
  // (verdict fail) and exit 2 (verdict uncertain), both of which already
  // exit directly from inside their action before ever reaching this catch.
  process.exit(INFRA_ERROR_EXIT_CODE);
});
