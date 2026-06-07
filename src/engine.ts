/* engine — the single core both transports (MCP + CLI) call.
 *
 * qaRun:    AI-driven exploration; a PASSED run is recorded to
 *           generated-tests/ (JSON trace + Playwright .spec.ts twin).
 * qaReplay: deterministic re-run of a recorded script — zero planner calls,
 *           Nano-only visuals; with heal=true a failed replay re-engages the
 *           driver on the original task and re-emits the script.
 *
 * One headed Chrome instance (daemon ports/profile) hosts both the QA tab
 * (CdpBrowser) and the Nano runner tab (NanoRunnerPage); Chrome and the runner
 * tab survive across runs so the on-device model stays warm. Rung 0 is an
 * optimization, not a dependency: without Nano the router starts at rung 1. */

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
import { loadScript, saveScript, scriptFromReport, type QaScript } from './recorder/script.js';
import { replayScript } from './recorder/replay.js';

export interface QaRunOptions {
  maxSteps?: number;
  /** Record a passed run to generated-tests/ (default true). */
  record?: boolean;
  config?: Partial<QaConfig>;
  /** Progress lines (CLI prints them; MCP ignores). */
  onProgress?: (line: string) => void;
}

export interface QaRunResult extends Report {
  /** Path of the recorded script, when the run passed and recording is on. */
  recordedScript?: string;
}

interface Session {
  cfg: QaConfig;
  browser: CdpBrowser;
  nano: NanoRunnerPage;
  close(): Promise<void>;
}

async function openSession(config: Partial<QaConfig>): Promise<Session> {
  const cfg = loadConfig(config);
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
  await nano.start();
  await browser.launch();
  return {
    cfg,
    browser,
    nano,
    async close() {
      await browser.close(); // QA tab closes; Chrome + runner tab stay warm
      await nano.close();
    },
  };
}

export async function qaRun(task: string, url: string, opts: QaRunOptions = {}): Promise<QaRunResult> {
  const progress = opts.onProgress ?? (() => {});
  const session = await openSession(opts.config ?? {});
  const { cfg, browser, nano } = session;

  const adapters: ModelAdapter[] = [];
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
    const report: QaRunResult = await runDriverLoop(browser, router, artifacts, task, url, {
      maxSteps: opts.maxSteps ?? cfg.maxSteps,
    });
    progress(`verdict: ${report.verdict} (${report.steps.length} steps, ${Math.round(report.durationMs / 1000)}s)`);

    if (report.verdict === 'pass' && (opts.record ?? true)) {
      const { jsonPath, specPath } = saveScript(scriptFromReport(report));
      report.recordedScript = jsonPath;
      progress(`recorded: ${jsonPath} (+ Playwright twin ${specPath}) — replay at $0 with \`qa replay\``);
    }
    return report;
  } finally {
    await session.close();
  }
}

export interface QaReplayOptions {
  /** On replay failure, re-engage the driver on the original task and re-emit the script. */
  heal?: boolean;
  config?: Partial<QaConfig>;
  onProgress?: (line: string) => void;
}

export interface QaReplayResult extends Report {
  healed?: boolean;
  recordedScript?: string;
}

export async function qaReplay(nameOrPath: string, opts: QaReplayOptions = {}): Promise<QaReplayResult> {
  const progress = opts.onProgress ?? (() => {});
  const script: QaScript = loadScript(nameOrPath);
  progress(`replaying "${script.name}" (${script.steps.length} steps, recorded ${script.createdAt}) — no planner, $0`);

  const session = await openSession(opts.config ?? {});
  const artifacts = new ArtifactStore(session.cfg.artifactsDir);

  let report: QaReplayResult;
  try {
    report = await replayScript(session.browser, session.nano, artifacts, script, { onProgress: progress });
    progress(`replay verdict: ${report.verdict} (${Math.round(report.durationMs / 1000)}s)`);
  } finally {
    await session.close();
  }

  if (report.verdict === 'fail' && opts.heal) {
    progress(`self-heal: replay failed at step ${report.failing_step ? report.failing_step.index + 1 : '?'} — re-engaging the driver on the original task`);
    const healed = await qaRun(script.task, script.url, {
      record: false, // we re-emit manually to keep the script's name + lineage
      config: opts.config,
      onProgress: progress,
    });
    if (healed.verdict === 'pass') {
      const newScript = scriptFromReport(healed);
      newScript.name = script.name; // same identity, new steps
      newScript.healedFrom = {
        runId: report.runId,
        failedStep: report.failing_step?.index ?? -1,
        healedAt: new Date().toISOString(),
      };
      const { jsonPath } = saveScript(newScript);
      progress(`self-heal succeeded — script re-emitted: ${jsonPath}`);
      return { ...healed, healed: true, recordedScript: jsonPath };
    }
    progress('self-heal failed too — the app is genuinely broken, reporting the AI run verdict');
    return { ...healed, healed: false };
  }

  return report;
}
