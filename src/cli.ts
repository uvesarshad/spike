/* `qa` CLI — thin wrapper over the engine; the MCP server shares the same core.
 * Subcommands grow with the milestones: run, mcp, nano, fixture. */

import { Command } from 'commander';
import { loadConfig } from './config.js';
import { NanoRunnerPage } from './ports/nano-runner-page.js';

const program = new Command();
program.name('qa').description('Browser QA subagent — a cheap-model ladder tests your app in a real Chrome');

program
  .command('config')
  .description('print the resolved configuration')
  .action(() => {
    console.log(JSON.stringify(loadConfig(), null, 2));
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
