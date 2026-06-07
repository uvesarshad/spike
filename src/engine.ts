/* engine.qaRun — the single core both transports (MCP + CLI) call.
 *
 * One headed Chrome instance (daemon ports/profile) hosts both the QA tab
 * (CdpBrowser) and the Nano runner tab (NanoRunnerPage); Chrome and the runner
 * tab survive across runs so the on-device model stays warm. Rung 0 is an
 * optimization, not a dependency: when Nano isn't available the router simply
 * starts the ladder at rung 1. */

import { loadConfig, type QaConfig } from './config.js';
import { CdpBrowser } from './ports/cdp-browser.js';
import { NanoRunnerPage } from './ports/nano-runner-page.js';
import { ModelRouter } from './router/model-router.js';
import type { ModelAdapter } from './router/adapter.js';
import { NanoAdapter } from './router/adapters/nano.js';
import { GoogleCliAdapter } from './router/adapters/google-cli.js';
import { ByokGeminiAdapter } from './router/adapters/byok-gemini.js';
import { OllamaAdapter } from './router/adapters/ollama.js';
import { ArtifactStore } from './report/artifacts.js';
import { runDriverLoop } from './driver/loop.js';
import type { Report } from './report/report.js';

export interface QaRunOptions {
  maxSteps?: number;
  config?: Partial<QaConfig>;
  /** Progress lines (CLI prints them; MCP ignores). */
  onProgress?: (line: string) => void;
}

export async function qaRun(task: string, url: string, opts: QaRunOptions = {}): Promise<Report> {
  const cfg = loadConfig(opts.config ?? {});
  const progress = opts.onProgress ?? (() => {});

  const nano = new NanoRunnerPage({
    cdpPort: cfg.cdpPort,
    runnerPort: cfg.runnerPort,
    profileDir: cfg.chromeProfile,
  });
  const browser = new CdpBrowser({
    port: cfg.cdpPort,
    profileDir: cfg.chromeProfile,
    headless: false, // headed: Nano lives here, and this window is the future "watch the robot" show
  });

  const adapters: ModelAdapter[] = [];
  await nano.start();
  if ((await nano.availability()) === 'available') {
    progress('rung 0: Gemini Nano available — warming up');
    await nano.warmup();
    adapters.push(new NanoAdapter(nano));
  } else {
    progress('rung 0: Gemini Nano not available — ladder starts at rung 1 (run `qa nano --download` to enable $0 visual checks)');
  }
  adapters.push(
    new GoogleCliAdapter({ bin: cfg.googleCliBin, model: cfg.googleCliModel, env: cfg.googleCliEnv }),
    new ByokGeminiAdapter({ apiKey: cfg.geminiApiKey, model: cfg.googleCliModel }),
    new OllamaAdapter(),
  );
  const router = new ModelRouter(adapters);

  const artifacts = new ArtifactStore(cfg.artifactsDir);
  progress(`run ${artifacts.runId}: "${task}" on ${url}`);

  try {
    await browser.launch();
    const report = await runDriverLoop(browser, router, artifacts, task, url, {
      maxSteps: opts.maxSteps ?? cfg.maxSteps,
    });
    progress(`verdict: ${report.verdict} (${report.steps.length} steps, ${Math.round(report.durationMs / 1000)}s)`);
    return report;
  } finally {
    await browser.close(); // QA tab closes; Chrome + runner tab stay warm
    await nano.close();
  }
}
