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
  /** BRAIN — smart model, leads plan-goals (rare plan/re-plan call). */
  planner: PlannerSelection;
  /** NAVIGATOR — cheap/free model, leads plan-step (the per-step call). */
  navigator: PlannerSelection;
  /** A5b (P1) safety: dry-run/read-only default — forwarded to LoopOptions.
   * runDriverLoop's OWN default is false (unset → today's mutate-freely
   * behavior for any caller that doesn't pass it), so pass the resolved
   * QaSettings.readOnly (product default true) explicitly here. */
  readOnly?: boolean;
  /** A5a (P1) safety: optional per-run spend cap in USD — forwarded to
   * LoopOptions. undefined/absent = no cap. */
  spendCapUsd?: number;
  /** A1 (P0) headline feature: deterministic verdicts — forwarded to
   * LoopOptions. Mirrors readOnly's forwarding shape; product default true. */
  strictOracles?: boolean;
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

/** BYOK-only ladder (no CLI/Ollama rungs). Pins BOTH roles: navigator (plan-step)
 * and brain/planner (plan-goals). All BYOK slots are api-mode. The default (A27)
 * pins navigator to a cheap cloud model (claude:api → claude-haiku-4-5) so ONE
 * Anthropic key drives both roles out of the box: small model navigates every
 * step, big model (the shared planner default, claude-sonnet-5) judges/plans.
 * Nano is still selectable — Experimental, opt-in — but it's handled separately
 * as the rung-0 visual adapter and isn't one of this function's ladder entries,
 * so a nano navigator resolves to the literal name 'nano' here even though it
 * isn't guaranteed to be a live plan-step candidate; see resolveNavigatorName
 * below for the honest (fallthrough-aware) answer surfaced to the panel. */
function buildLiteLadder(keys: LiteKeys, planner: PlannerSelection, navigator: PlannerSelection): {
  adapters: ModelAdapter[];
  plannerName?: string;
  navigatorName?: string;
} {
  // Model for an api-mode slot: the role that pins it supplies its model (when set)
  // or the role default; unpinned fallback rungs take the cheap navigator tier.
  const modelFor = (provider: ProviderId): string => {
    if (navigator.provider === provider && navigator.mode === 'api') return navigator.model || defaultModelFor(provider, 'api', 'navigator');
    if (planner.provider === provider && planner.mode === 'api') return planner.model || defaultModelFor(provider, 'api', 'brain');
    return defaultModelFor(provider, 'api', 'navigator');
  };

  const byKey = new Map<ProviderId, ModelAdapter>();
  byKey.set('gemini', new ByokGeminiAdapter({ apiKey: keys.gemini, model: modelFor('gemini') }));
  byKey.set('claude', new AnthropicAdapter({ apiKey: keys.anthropic, model: modelFor('claude'), browserDirect: true }));
  byKey.set('gpt', new OpenAiCompatibleAdapter({ apiKey: keys.openai, baseUrl: 'https://api.openai.com/v1', label: 'gpt', model: modelFor('gpt') }));
  byKey.set('openrouter', new OpenAiCompatibleAdapter({ apiKey: keys.openrouter, baseUrl: 'https://openrouter.ai/api/v1', label: 'openrouter', model: modelFor('openrouter') }));
  byKey.set('glm', new OpenAiCompatibleAdapter({ apiKey: keys.glm, baseUrl: 'https://api.z.ai/api/paas/v4', label: 'glm', model: modelFor('glm'), supportsVision: false, extraBody: { thinking: { type: 'disabled' } } }));

  const navigatorName = navigator.provider === 'nano' ? 'nano' : byKey.get(navigator.provider)?.name;
  const plannerName = planner.provider === 'nano' ? 'nano' : byKey.get(planner.provider)?.name;
  return { adapters: [...byKey.values()], plannerName, navigatorName };
}

/** A27: which adapter will ACTUALLY lead plan-step, as opposed to merely echoing
 * the user's pin — the panel must not display a model that isn't driving.
 *
 * A pin only leads the ladder if ModelRouter finds it among LIVE candidates:
 * candidates() filters on supports(cap) && available() (model-router.ts:90-92)
 * before the pin-match at :98. Two ways a pin silently fails to lead:
 *   1. `nano` — never a plan-step candidate in the lite ladder (see
 *      buildLiteLadder above), and its on-device availability isn't provable
 *      synchronously here anyway (that needs the SW's live nanoDeps).
 *   2. ANY BYOK provider with no configured key — buildLiteLadder registers all
 *      five adapters unconditionally, so navigatorName is non-null even for a
 *      provider the user has no key for; available() then drops it at run time.
 * Case 2 is why this can't just special-case nano: with the claude:api default,
 * a user holding only a Gemini key would be shown "claude" while gemini drives.
 *
 * In both cases the router falls through to the BYOK ladder in byKey insertion
 * order (gemini, claude, gpt, openrouter, glm — all rung 2, so planRank keeps
 * them stable), first-with-a-configured-key wins. Mirror that here. */
function resolveNavigatorName(keys: LiteKeys, navigator: PlannerSelection, planner: PlannerSelection): string {
  const { adapters, navigatorName } = buildLiteLadder(keys, planner, navigator);
  // Key presence per provider, in buildLiteLadder's byKey insertion order.
  const ladder: Array<{ provider: ProviderId; key: string | undefined }> = [
    { provider: 'gemini', key: keys.gemini },
    { provider: 'claude', key: keys.anthropic },
    { provider: 'gpt', key: keys.openai },
    { provider: 'openrouter', key: keys.openrouter },
    { provider: 'glm', key: keys.glm },
  ];
  const pinnedHasKey =
    navigator.provider !== 'nano' &&
    Boolean(ladder.find((l) => l.provider === navigator.provider)?.key);
  if (pinnedHasKey) return navigatorName ?? navigator.provider;
  const idx = ladder.findIndex((l) => Boolean(l.key));
  // No BYOK key configured at all → nano really is the only candidate (its real
  // availability is only provable at run time via the live on-device probe).
  return idx >= 0 ? adapters[idx].name : 'nano';
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
      // role-aware defaults for the two Settings cards (navigator=cheap, brain=smart).
      navModelDefault: defaultModelFor(id, 'api', 'navigator'),
      brainModelDefault: defaultModelFor(id, 'api', 'brain'),
      needsKey,
      hasKey: needsKey ? Boolean(k[vaultName!]) : false,
      // lite mode can't drive CLI/Ollama rungs — flag unsupported providers so the
      // panel can hint (nano plans nothing; ollama needs a local server).
      liteUsable: id !== 'nano' && id !== 'ollama',
    };
  });
  return {
    planner: settings.planner,
    navigator: settings.navigator,
    // A27: the honest answer — which adapter will ACTUALLY serve plan-step,
    // accounting for the nano-pin fallthrough (see resolveNavigatorName above).
    // Additive only; `navigator` (the raw pin) is unchanged for existing readers.
    resolvedNavigatorName: resolveNavigatorName(keys, settings.navigator, settings.planner),
    debugMode: settings.debugMode,
    debugAgent: settings.debugAgent,
    videoAssertions: settings.videoAssertions ?? false,
    // A5b/A5a (P1 safety) — same shape as the daemon's vibe.config.get.
    readOnly: settings.readOnly ?? true,
    spendCapUsd: settings.spendCapUsd,
    // A1 headline feature — same shape as the daemon's vibe.config.get.
    strictOracles: settings.strictOracles ?? true,
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

    // rung 2 — BYOK ladder, with both pins: navigator (plan-step) + brain (plan-goals).
    const { adapters: ladder, plannerName, navigatorName } = buildLiteLadder(opts.keys, opts.planner, opts.navigator);
    adapters.push(...ladder);
    progress(`navigator: ${navigatorName ?? opts.navigator.provider} · brain: ${plannerName ?? opts.planner.provider} (BYOK; lite mode — no daemon)`);

    const router = new ModelRouter(adapters, { navigatorAdapter: navigatorName, plannerAdapter: plannerName });
    const artifacts = new BrowserArtifactStore();
    progress(`run ${artifacts.runId}: "${opts.task}" on ${opts.url}`);

    const report = await runDriverLoop(browser, router, artifacts, opts.task, opts.url, {
      maxSteps: opts.maxSteps ?? 40,
      onStep: opts.onStep,
      allowedHosts: opts.allowedHosts,
      signal: opts.signal,
      // A5b/A5a (P1 safety) — see LiteRunOptions.readOnly/spendCapUsd above.
      readOnly: opts.readOnly,
      spendCapUsd: opts.spendCapUsd,
      // A1 (P0) — see LiteRunOptions.strictOracles above.
      strictOracles: opts.strictOracles,
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
