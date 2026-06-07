/* `qa` CLI — thin wrapper over the engine; the MCP server shares the same core.
 * Subcommands grow with the milestones: run, mcp, nano, fixture. */

import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { loadConfig, type QaConfig } from './config.js';
import { NanoRunnerPage } from './ports/nano-runner-page.js';
import { qaReplay, qaRun } from './engine.js';
import { slimReport, type Report } from './report/report.js';
import { listScripts } from './recorder/script.js';
import { BridgeServer } from './bridge/bridge-server.js';
import { VibeService } from './vibe/service.js';
import { buildFixPrompt } from './vibe/fix-prompt.js';
import { dispatchFix, runWithAutoFix } from './vibe/auto-fix.js';
import { Vault } from './vault/vault.js';
import { startFixture } from '../fixture/server.js';

const program = new Command();
program.name('qa').description('Browser QA subagent — a cheap-model ladder tests your app in a real Chrome');

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
): Partial<QaConfig> | undefined {
  const config: Partial<QaConfig> = {};
  if (via) config.via = via;
  if (hosts.length) config.allowedHosts = [...loadConfig().allowedHosts, ...hosts];
  return Object.keys(config).length ? config : undefined;
}

program
  .command('run')
  .description('run a QA task against a URL; exit 0 pass / 1 fail / 2 uncertain')
  .argument('<task>', 'what to test, in plain English')
  .requiredOption('--url <url>', 'page to start on')
  .option('--max-steps <n>', 'driver step budget', (v) => parseInt(v, 10))
  .option('--via <transport>', 'cdp (default) | extension — how to drive Chrome')
  .option('--allow-host <host>', 'permit clicks/typing on this host (repeatable; outside allowedHosts is read-only)', collectHost, [])
  .option('--no-record', 'do not record a passing run to generated-tests/')
  .option('--fix', 'on failure, hand the fix prompt to your coding agent (claude/codex/gemini) and re-test', false)
  .option('--max-fix-attempts <n>', 'test→fix→retest rounds with --fix (default 2)', (v) => parseInt(v, 10))
  .option('--json', 'print the slim JSON verdict only', false)
  .action(async (task: string, opts: { url: string; maxSteps?: number; via?: 'cdp' | 'extension'; allowHost: string[]; record: boolean; fix: boolean; maxFixAttempts?: number; json: boolean }) => {
    const onProgress = opts.json ? undefined : (l: string) => console.log(l);
    const config = mergeConfig(opts.via, opts.allowHost);
    const qaRunOpts = {
      maxSteps: opts.maxSteps,
      record: opts.record,
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
  .description('print the resolved configuration')
  .action(() => {
    console.log(JSON.stringify(loadConfig(), null, 2));
  });

program
  .command('replay')
  .description('replay recorded scripts deterministically — no planner, $0; exit 0 pass / 1 fail / 2 uncertain')
  .argument('[name]', 'script name (or path to a generated-tests/*.json)')
  .option('--all', 'replay every script in generated-tests/ (the regression suite)', false)
  .option('--heal', 'on failure, re-engage the AI driver and re-emit the script', false)
  .option('--via <transport>', 'cdp (default) | extension — how to drive Chrome')
  .option('--allow-host <host>', 'permit clicks/typing on this host (repeatable; outside allowedHosts is read-only)', collectHost, [])
  .option('--json', 'print slim JSON verdicts only', false)
  .action(async (name: string | undefined, opts: { all: boolean; heal: boolean; via?: 'cdp' | 'extension'; allowHost: string[]; json: boolean }) => {
    const targets = opts.all ? listScripts() : name ? [name] : [];
    if (targets.length === 0) {
      console.error(opts.all ? 'no recorded scripts in generated-tests/' : 'give a script name or --all');
      process.exit(2);
    }
    const config = mergeConfig(opts.via, opts.allowHost);
    let worst = 0;
    for (const t of targets) {
      const report = await qaReplay(t, {
        heal: opts.heal,
        ...(config && { config }),
        onProgress: opts.json ? undefined : (l) => console.log(l),
      });
      console.log(JSON.stringify({ script: t, healed: report.healed, ...slimReport(report) }, null, 2));
      worst = Math.max(worst, report.verdict === 'pass' ? 0 : report.verdict === 'fail' ? 1 : 2);
    }
    process.exit(worst);
  });

program
  .command('daemon')
  .description('start the vibe-mode daemon: a bridge the extension side panel connects to, driving QA runs from the GUI')
  .option('--bridge-port <n>', 'WebSocket port the extension connects to', (v) => parseInt(v, 10))
  .action((opts: { bridgePort?: number }) => {
    const cfg = loadConfig();
    const port = opts.bridgePort ?? cfg.bridgePort;
    const bridge = new BridgeServer(port);
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
          console.error('usage: qa secret set <name> <value>');
          process.exit(2);
        }
        vault.set(name, value);
        console.log(`set "${name}" — use it in tasks as {{secret:${name}}}`);
        break;
      case 'get': {
        if (!name) { console.error('usage: qa secret get <name> [--reveal]'); process.exit(2); }
        const v = vault.get(name);
        if (v === undefined) { console.error(`no secret "${name}"`); process.exit(1); }
        console.log(opts?.reveal ? v : `"${name}" exists (use --reveal to print)`);
        break;
      }
      case 'list':
        console.log(vault.list().join('\n') || '(no secrets)');
        break;
      case 'delete':
        if (!name) { console.error('usage: qa secret delete <name>'); process.exit(2); }
        console.log(vault.delete(name) ? `deleted "${name}"` : `no secret "${name}"`);
        break;
      default:
        console.error('usage: qa secret <set|get|list|delete>');
        process.exit(2);
    }
  });

program
  .command('mcp')
  .description('start the MCP stdio server (register in a coding agent as: command "qa", args ["mcp"])')
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

program.parseAsync().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
