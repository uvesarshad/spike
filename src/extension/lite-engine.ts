/* lite-engine — the daemon-free engine entry, bundled into the extension service
 * worker by tsup (browser target). It composes ONLY portable pieces: the driver
 * loop, the model router, the BYOK + Nano adapters, LiteExtensionBrowser, and
 * BrowserArtifactStore. It MUST NOT import engine.ts / config.ts / settings.ts /
 * vault.ts / the CLI or Ollama adapters — any one of those would drag the Node
 * graph into the browser bundle. (Enforced by a grep gate on the emitted bundle.)
 *
 * The service worker calls runLite() with injected platform deps (CDP transport,
 * navigation, key storage values, nano callbacks) and forwards the `done` payload
 * — identical in shape to the daemon's vibe.done — straight to the panel. */

import { ModelRouter } from '../router/model-router.js';
import type { ModelAdapter } from '../router/adapter.js';
import { runDriverLoop, type StepInfo } from '../driver/loop.js';
import { AnthropicAdapter } from '../router/adapters/anthropic.js';
import { OpenAiCompatibleAdapter } from '../router/adapters/openai-compatible.js';
import { ByokGeminiAdapter } from '../router/adapters/byok-gemini.js';
import { NanoAdapter } from '../router/adapters/nano.js';
import { LiteExtensionBrowser, type LiteBrowserDeps } from './lite-extension-browser.js';
import { LiteNano, type LiteNanoDeps } from './lite-nano.js';
import { BrowserArtifactStore, type ArtifactBundle } from './browser-artifacts.js';
import {
  defaultModelFor,
  isSafeModelId,
  DEFAULT_SETTINGS,
  PROVIDER_ORDER,
  PROVIDER_MODES,
  VAULT_KEY_FOR,
  type PlannerSelection,
  type ProviderId,
  type QaSettings,
} from '../vibe/settings-data.js';
import { slimReport, type Report } from '../report/report.js';
import { renderPlainReport, buildFixPrompt } from '../vibe/fix-prompt.js';

// Re-export the pure helpers sw.js (plain JS, module SW) needs, so it imports
// everything from one place (./lite-engine.js) and never reimplements provider logic.
export { isSafeModelId, DEFAULT_SETTINGS, defaultModelFor };
export type { LiteBrowserDeps } from './lite-extension-browser.js';
export type { LiteNanoDeps } from './lite-nano.js';
export type { ArtifactBundle } from './browser-artifacts.js';

/** API keys keyed by the vault CONTRACT name (anthropic/openai/gemini/openrouter/glm). */
export interface LiteKeys {
  anthropic?: string;
  openai?: string;
  gemini?: string;
  openrouter?: string;
  glm?: string;
}

export interface LiteRunOptions {
  task: string;
  url: string;
  allowedHosts: string[];
  maxSteps?: number;
  keys: LiteKeys;
  planner: PlannerSelection;
  /** chrome.debugger transport + lifecycle, injected by the SW. */
  browserDeps: LiteBrowserDeps;
  /** Nano (rung 0) callbacks; omit to skip the on-device visual rung. */
  nanoDeps?: LiteNanoDeps;
  onProgress?: (line: string) => void;
  onStep?: (info: StepInfo) => void;
  signal?: AbortSignal;
}

export interface LiteRunResult {
  report: Report;
  /** report.json + screenshots, for the panel's download affordance. */
  bundle: ArtifactBundle;
  /** vibe.done-shaped payload the SW forwards to the panel unchanged. */
  done: Record<string, unknown>;
}

/** BYOK-only ladder (no CLI/Ollama rungs). Pins the user's chosen provider. */
function buildLiteLadder(keys: LiteKeys, planner: PlannerSelection): {
  adapters: ModelAdapter[];
  pinnedName?: string;
} {
  // chosen api-mode provider uses planner.model when set; others their default.
  const modelFor = (provider: ProviderId, fallback: string): string =>
    planner.provider === provider && planner.mode === 'api' && planner.model ? planner.model : fallback;

  const byKey = new Map<ProviderId, ModelAdapter>();
  byKey.set('gemini', new ByokGeminiAdapter({ apiKey: keys.gemini, model: modelFor('gemini', defaultModelFor('gemini', 'api')) }));
  byKey.set('claude', new AnthropicAdapter({ apiKey: keys.anthropic, model: modelFor('claude', defaultModelFor('claude', 'api')), browserDirect: true }));
  byKey.set('gpt', new OpenAiCompatibleAdapter({ apiKey: keys.openai, baseUrl: 'https://api.openai.com/v1', label: 'gpt', model: modelFor('gpt', defaultModelFor('gpt', 'api')) }));
  byKey.set('openrouter', new OpenAiCompatibleAdapter({ apiKey: keys.openrouter, baseUrl: 'https://openrouter.ai/api/v1', label: 'openrouter', model: modelFor('openrouter', defaultModelFor('openrouter', 'api')) }));
  byKey.set('glm', new OpenAiCompatibleAdapter({ apiKey: keys.glm, baseUrl: 'https://api.z.ai/api/paas/v4', label: 'glm', model: modelFor('glm', defaultModelFor('glm', 'api')), supportsVision: false, extraBody: { thinking: { type: 'disabled' } } }));

  const pinnedName = byKey.get(planner.provider)?.name;
  return { adapters: [...byKey.values()], pinnedName };
}

/** Build the panel's vibe.config.get payload from chrome.storage values. Same
 * shape the daemon's service.ts returns, so panel.js renderSettings is unchanged
 * (plus a `mode:'lite'` marker). Key VALUES never appear — only presence. */
export function buildLiteConfig(keys: LiteKeys, settings: QaSettings): Record<string, unknown> {
  const k = keys as Record<string, string | undefined>;
  const providers = PROVIDER_ORDER.map((id) => {
    const vaultName = VAULT_KEY_FOR[id];
    const needsKey = Boolean(vaultName);
    return {
      id,
      modes: PROVIDER_MODES[id],
      apiModelDefault: defaultModelFor(id, 'api'),
      cliModelDefault: defaultModelFor(id, 'cli'),
      needsKey,
      hasKey: needsKey ? Boolean(k[vaultName!]) : false,
      // lite mode can't drive CLI/Ollama rungs — flag unsupported providers so the
      // panel can hint (nano plans nothing; ollama needs a local server).
      liteUsable: id !== 'nano' && id !== 'ollama',
    };
  });
  return {
    planner: settings.planner,
    debugMode: settings.debugMode,
    debugAgent: settings.debugAgent,
    providers,
    mode: 'lite',
  };
}

export async function runLite(opts: LiteRunOptions): Promise<LiteRunResult> {
  const progress = opts.onProgress ?? (() => {});
  const browser = new LiteExtensionBrowser(opts.browserDeps);
  await browser.launch();

  try {
    const adapters: ModelAdapter[] = [];

    // rung 0 — Nano (visual verdicts only), when the SW reports it available.
    if (opts.nanoDeps) {
      const nano = new LiteNano(opts.nanoDeps);
      const a = await nano.availability().catch(() => 'unavailable' as const);
      if (a === 'available') {
        progress('rung 0: Gemini Nano available — warming up');
        await nano.warmup().catch(() => {});
        adapters.push(new NanoAdapter(nano));
      } else {
        progress(`rung 0: Gemini Nano ${a} — visual checks fall to the cloud model`);
      }
    }

    // rung 2 — BYOK ladder, pinned to the user's chosen provider.
    const { adapters: ladder, pinnedName } = buildLiteLadder(opts.keys, opts.planner);
    adapters.push(...ladder);
    progress(`planner: ${pinnedName ?? opts.planner.provider} (BYOK; lite mode — no daemon)`);

    const router = new ModelRouter(adapters, { pinnedAdapter: pinnedName });
    const artifacts = new BrowserArtifactStore();
    progress(`run ${artifacts.runId}: "${opts.task}" on ${opts.url}`);

    const report = await runDriverLoop(browser, router, artifacts, opts.task, opts.url, {
      maxSteps: opts.maxSteps ?? 12,
      onStep: opts.onStep,
      allowedHosts: opts.allowedHosts,
      signal: opts.signal,
      // no vault in lite mode — a {{secret:NAME}} placeholder fails its step.
    });
    progress(`verdict: ${report.verdict} (${report.steps.length} steps, ${Math.round(report.durationMs / 1000)}s)`);

    const done: Record<string, unknown> = {
      ...slimReport(report),
      plainReport: renderPlainReport(report),
      fixPrompt: buildFixPrompt(report),
      durationMs: report.durationMs,
    };
    return { report, bundle: artifacts.exportBundle(), done };
  } finally {
    await browser.close();
  }
}
