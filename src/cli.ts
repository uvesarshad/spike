/* `qa` CLI — thin wrapper over the engine; the MCP server shares the same core.
 * Subcommands grow with the milestones: run, mcp, nano, fixture. */

import { Command } from 'commander';
import { loadConfig } from './config.js';
import { NanoRunnerPage } from './ports/nano-runner-page.js';
import { qaRun } from './engine.js';
import { slimReport } from './report/report.js';
import { startFixture } from '../fixture/server.js';

const program = new Command();
program.name('qa').description('Browser QA subagent — a cheap-model ladder tests your app in a real Chrome');

program
  .command('run')
  .description('run a QA task against a URL; exit 0 pass / 1 fail / 2 uncertain')
  .argument('<task>', 'what to test, in plain English')
  .requiredOption('--url <url>', 'page to start on')
  .option('--max-steps <n>', 'driver step budget', (v) => parseInt(v, 10))
  .option('--json', 'print the slim JSON verdict only', false)
  .action(async (task: string, opts: { url: string; maxSteps?: number; json: boolean }) => {
    const report = await qaRun(task, opts.url, {
      maxSteps: opts.maxSteps,
      onProgress: opts.json ? undefined : (l) => console.log(l),
    });
    if (opts.json) {
      console.log(JSON.stringify(slimReport(report), null, 2));
    } else {
      console.log(JSON.stringify(slimReport(report), null, 2));
      console.log(`full report: ${report.evidence_paths[0]}`);
    }
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
