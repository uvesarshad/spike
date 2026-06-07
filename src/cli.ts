/* `qa` CLI — thin wrapper over the engine; the MCP server shares the same core.
 * Subcommands grow with the milestones: run, mcp, nano, fixture. */

import { Command } from 'commander';
import { loadConfig } from './config.js';

const program = new Command();
program.name('qa').description('Browser QA subagent — a cheap-model ladder tests your app in a real Chrome');

program
  .command('config')
  .description('print the resolved configuration')
  .action(() => {
    console.log(JSON.stringify(loadConfig(), null, 2));
  });

program.parseAsync().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
