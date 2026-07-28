/* `spike` CLI — thin wrapper over the engine; the MCP server shares the same core.
 * Subcommands grow with the milestones: run, mcp, nano, fixture. */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { Command } from 'commander';
import { loadConfig, type QaConfig } from './config.js';
import { NanoRunnerPage } from './ports/nano-runner-page.js';
import { qaReplay, qaRun } from './engine.js';
import { slimReport, type Report } from './report/report.js';
import { listScripts } from './recorder/script.js';
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

/** Render the settings (planner + debug + which API keys are configured) as a
 * readable block. Shared by `config show` and `config set`. Never prints key values. */
function printSettings(s: QaSettings): void {
  const { provider, mode, model } = s.planner;
  const modelLine = model && model.length ? model : `(default: ${defaultModelFor(provider, mode) || 'none'})`;
  const vault = new Vault();
  console.log('Browsing-control AI (planner):');
  console.log(`  provider:   ${provider}`);
  console.log(`  mode:       ${mode}`);
  console.log(`  model:      ${modelLine}`);
  console.log('Debugging:');
  console.log(`  debugMode:  ${s.debugMode}`);
  console.log(`  debugAgent: ${s.debugAgent}`);
  console.log('API keys (in encrypted vault):');
  for (const p of PROVIDERS) {
    const name = VAULT_KEY_NAMES[p];
    if (!name) continue;
    const status = vault.get(name) !== undefined ? 'set' : 'not set';
    console.log(`  ${p} (${name}): ${status}`);
  }
}

const program = new Command();
program.name('spike').description('Spike — a cheap-model ladder tests your app in a real Chrome and reports a verdict');

/** Commander collector for the repeatable --allow-host flag. */
function collectHost(value: string, previous: string[]): string[] {
  return previous.concat(value);
}

/** Build the QaConfig override from the run/replay flags. Returns undefined when
 * nothing was supplied (so callers can `...(config && { config })`).
 *  - --via sets the transport.
 *  - --allow-host appends to (does NOT replace) the configured allowedHosts, so
 *    the localhost/127.0.0.1 defaults stay in place and the flag opens up extra
 *    hosts for click/type just for this run. */
function mergeConfig(
  via: 'cdp' | 'extension' | undefined,
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
  .description('run a QA task against a URL; exit 0 pass / 1 fail / 2 uncertain')
  .argument('<task>', 'what to test, in plain English')
  .requiredOption('--url <url>', 'page to start on')
  .option('--max-steps <n>', 'driver step budget', (v) => parseInt(v, 10))
  .option('--via <transport>', 'cdp (default) | extension — how to drive Chrome')
  .option('--allow-host <host>', 'permit clicks/typing on an EXTRA host beyond --url\'s own (repeatable) — --url\'s host is trusted automatically', collectHost, [])
  .option('--action-cache', 'enable the verified file-backed action cache for this run')
  .option('--no-action-cache', 'bypass the verified action cache for this run')
  .option('--no-record', 'do not record a passing run to generated-tests/')
  .option('--no-replay', 'skip the pre-run replay matcher — always run a fresh AI pass, even if a recorded script confidently matches this task+url')
  .option('--fix', 'on failure, hand the fix prompt to your coding agent (claude/codex/gemini) and re-test', false)
  .option('--max-fix-attempts <n>', 'test→fix→retest rounds with --fix (default 2)', (v) => parseInt(v, 10))
  .option('--json', 'print the slim JSON verdict only', false)
  .action(async (task: string, opts: { url: string; maxSteps?: number; via?: 'cdp' | 'extension'; allowHost: string[]; actionCache?: boolean; record: boolean; replay: boolean; fix: boolean; maxFixAttempts?: number; json: boolean }) => {
    const onProgress = opts.json ? undefined : (l: string) => console.log(l);
    const config = mergeConfig(opts.via, opts.allowHost, opts.actionCache);
    const qaRunOpts = {
      maxSteps: opts.maxSteps,
      record: opts.record,
      replay: opts.replay,
      ...(config && { config }),
      onProgress,
    };
    const report = opts.fix
      ? (await runWithAutoFix(task, opts.url, {
          maxAttempts: opts.maxFixAttempts ?? 2,
          config: qaRunOpts.config,
          onProgress,
          qaRunOpts,
        })).finalReport
      : await qaRun(task, opts.url, qaRunOpts);
    console.log(JSON.stringify(slimReport(report), null, 2));
    if (!opts.json) console.log(`full report: ${report.evidence_paths[0]}`);
    process.exit(report.verdict === 'pass' ? 0 : report.verdict === 'fail' ? 1 : 2);
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
  .command('config')
  .description('view or change the browsing-control AI + debugging settings (shared with the extension panel)')
  .argument('<action>', 'show | set')
  .option('--provider <p>', 'nano|gemini|claude|gpt|ollama|openrouter|glm')
  .option('--mode <m>', 'api|cli')
  .option('--model <m>', 'model id (blank = provider default)')
  .option('--debug-mode <d>', 'prompt|auto')
  .option('--debug-agent <a>', 'auto|claude|codex|gemini')
  .action((action: string, opts: { provider?: string; mode?: string; model?: string; debugMode?: string; debugAgent?: string }) => {
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
    if (Object.keys(patch).length === 0) {
      console.error('nothing to set — pass at least one of: --provider --mode --model --debug-mode --debug-agent');
      process.exit(2);
    }
    printSettings(store.write(patch));
  });

program
  .command('replay')
  .description('replay recorded scripts deterministically — no planner, $0; exit 0 pass / 1 fail / 2 uncertain')
  .argument('[name]', 'script name (or path to a generated-tests/*.json)')
  .option('--all', 'replay every script in generated-tests/ (the regression suite)', false)
  .option('--heal', 'on failure, re-engage the AI driver and re-emit the script', false)
  .option('--via <transport>', 'cdp (default) | extension — how to drive Chrome')
  .option('--allow-host <host>', 'permit clicks/typing on an EXTRA host beyond the script\'s own (repeatable) — the recorded url\'s host is trusted automatically', collectHost, [])
  .option('--json', 'print slim JSON verdicts only', false)
  .action(async (name: string | undefined, opts: { all: boolean; heal: boolean; via?: 'cdp' | 'extension'; allowHost: string[]; json: boolean }) => {
    const targets = opts.all ? listScripts() : name ? [name] : [];
    if (targets.length === 0) {
      console.error(opts.all ? 'no recorded scripts in generated-tests/' : 'give a script name or --all');
      process.exit(2);
    }
    const config = mergeConfig(opts.via, opts.allowHost);
    let worst = 0;
    const jsonResults: unknown[] = [];
    for (const t of targets) {
      const report = await qaReplay(t, {
        heal: opts.heal,
        ...(config && { config }),
        onProgress: opts.json ? undefined : (l) => console.log(l),
      });
      const out = { script: t, healed: report.healed, ...slimReport(report) };
      if (opts.json && opts.all) jsonResults.push(out);
      else console.log(JSON.stringify(out, null, 2));
      worst = Math.max(worst, report.verdict === 'pass' ? 0 : report.verdict === 'fail' ? 1 : 2);
    }
    if (opts.json && opts.all) console.log(JSON.stringify(jsonResults, null, 2));
    process.exit(worst);
  });

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
  .action(async (runIdOrPath: string, opts: { apply: boolean }) => {
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
      const result = await dispatchFix(report, { onProgress: (l) => console.log(l) });
      console.log(result.ok ? `fix applied by ${result.agent} — re-run the test to verify` : `fix agent failed`);
      process.exit(result.ok ? 0 : 1);
    }
    console.log(prompt);
  });

program
  .command('secret')
  .description('manage the local encrypted vault — secrets are typed via {{secret:NAME}} and never reach any model')
  .argument('<action>', 'set | get | list | delete')
  .argument('[name]', 'secret name')
  .argument('[value]', 'secret value (for set)')
  .option('--reveal', 'with get: print the value (default only confirms existence)', false)
  .action((action: string, name?: string, value?: string, opts?: { reveal: boolean }) => {
    const vault = new Vault();
    switch (action) {
      case 'set':
        if (!name || value === undefined) {
          console.error('usage: spike secret set <name> <value>');
          process.exit(2);
        }
        vault.set(name, value);
        console.log(`set "${name}" — use it in tasks as {{secret:${name}}}`);
        break;
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
  .option('--port <n>', 'HTTP port (default 9420, or QA_DASHBOARD_PORT)', (v) => parseInt(v, 10))
  .action((opts: { port?: number }) => {
    const cfg = loadConfig();
    const port = opts.port ?? Number(process.env.QA_DASHBOARD_PORT ?? 9420);
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
  process.exit(1);
});
