# Module: Model Ladder

> Scope: ModelRouter, ModelAdapter interface, and all rung adapters in src/router/.
> Rendering context: Server-side (Node.js daemon)
> Project tier: 3
> Last updated: 2026-06-11

## Overview

The model ladder is a cost-ordered sequence of AI adapters. Each adapter wraps one model access method and declares its rung (cost level). ModelRouter walks the ladder for each capability request — cheap first — escalating on error or uncertainty. Every call (success or failure) appends a ModelTraceEntry to router.trace, which feeds both report.model_trace and the token accounting story.

AGENT OWNER: src/router/

## ModelAdapter Interface (src/router/adapter.ts)

Every adapter implements:

- name: string — unique identifier used in trace entries and the pinnedAdapter config.
- rung: number — cost tier (0 = free on-device, 1 = free CLI quota, 2 = BYOK API, 3 = local/Ollama).
- supports(cap) — declares which capabilities ('plan-step' | 'visual-verdict') this adapter handles. Rung 0 (Nano) supports visual-verdict only, never plan-step.
- available() — async probe; returns false when the adapter is unconfigured or its service is unreachable. ModelRouter calls all available() probes in parallel.
- generateJson(opts) — the single call surface: accepts prompt, schema (JSON Schema object), and optional imagePng (Buffer). Returns a validated parsed object.
- lastUsage — populated after each generateJson call with token counts (totalTokens, cachedTokens) when the provider reports them.

## ModelRouter (src/router/model-router.ts)

Constructor accepts an array of adapters and ModelRouterOptions (preferFreePlanner, pinnedAdapter). Adapters are sorted by ascending rung at construction time.

planJson(prompt, schema, step) — walks the plan-step ladder. Default ordering: if a rung-2 BYOK adapter is live and preferFreePlanner is false, rung 2 is promoted before rung 1 (~3× faster HTTP vs CLI cold-spawn). If pinnedAdapter is set, that adapter leads. Falls down-ladder on any error; throws only when all adapters fail.

visualVerdict(png, expectation, step) — walks the visual-verdict ladder. Rung 0 (Nano) always leads (it is $0/on-device). On 'uncertain', escalates to the next rung. Returns the last uncertain verdict if the whole ladder is uncertain rather than throwing.

AGENT NOTE: The availability() probes are called in parallel before every ladder walk (not cached between steps). This is intentional — a CLI process that was unavailable at run start may become available mid-run, and the adapter ordering must reflect live state.

## Rung 0 — NanoAdapter (src/router/adapters/nano.ts)

Wraps NanoPort. Rung 0. Supports visual-verdict only. Passes the bare expectation string to the runner page (the runner page builds its own Prompt API prompt). Reports no token counts (on-device, $0).

## Rung 1 — GoogleCliAdapter (src/router/adapters/google-cli.ts)

Wraps the Google CLI binary (cfg.googleCliBin, default 'gemini'). Rung 1. Supports both plan-step and visual-verdict. Spawns a child process with -p (headless prompt mode), passes images as base64 inline. Injects cfg.googleCliEnv into the child environment (contains NODE_OPTIONS=--use-system-ca on this machine for AVG TLS fix). Binary name is config-driven — after 2026-06-18 it switches from 'gemini' to the Antigravity CLI; never hardcode 'gemini' in new code.

AGENT NOTE: Exit code 41 from the Google CLI child process means OAuth/TLS failure (usually the AVG TLS intercept on this machine). The adapter prints a hint and re-throws; the router escalates to rung 2.

## Rung 1 — CliPlannerAdapter (src/router/adapters/cli-planner.ts)

Generic CLI planner adapter. Used for claude (claude CLI) and codex (Codex CLI). Rung 1. Supports plan-step only. Spawns the binary, passes the prompt via stdin or -p flag, parses JSON output.

AGENT AVOID: Never pass user-supplied model IDs to CLI adapters without the isSafeModelId() check from src/vibe/settings.ts. The model flag is passed in a shell-spawned child (shell:true); an unsanitized model string is a command-injection sink.

## Rung 2 — ByokGeminiAdapter (src/router/adapters/byok-gemini.ts)

Calls the Gemini REST API directly using cfg.geminiApiKey (or the Vault 'gemini' key). Rung 2. Supports plan-step and visual-verdict. Returns token counts from usageMetadata.

## Rung 2 — AnthropicAdapter (src/router/adapters/anthropic.ts)

Calls the Anthropic API using the Vault 'anthropic' key or ANTHROPIC_API_KEY env. Rung 2. Supports plan-step. Default model: claude-haiku-4-5 (cheap tier; the ladder's whole point is to use cheap models).

## Rung 2 — OpenAiCompatibleAdapter (src/router/adapters/openai-compatible.ts)

OpenAI-compatible REST adapter. Used for both 'gpt:api' (baseUrl: https://api.openai.com/v1) and 'openrouter:api' (baseUrl: https://openrouter.ai/api/v1). Rung 2. Supports plan-step. Keys from Vault or env (OPENAI_API_KEY, OPENROUTER_API_KEY).

## Rung 3 — OllamaAdapter (src/router/adapters/ollama.ts)

Calls a local Ollama instance (localhost:11434). Rung 3. Supports plan-step and visual-verdict. Default model: llama3.2-vision. Privacy floor: no data leaves the machine on this rung.

## Ladder Ordering Summary

For plan-step: [pinned adapter if set] → [rung 2 BYOK if preferFreePlanner=false] → [rung 1 CLI adapters] → [rung 3 Ollama]. Rung 0 (Nano) never plans.

For visual-verdict: [rung 0 Nano] → [pinned adapter if set and not Nano] → [remaining by ascending rung].

## PlannerSelection and SettingsStore

The user's chosen "browsing control AI" is stored as PlannerSelection (provider, mode, optional model) in SettingsStore (src/vibe/settings.ts). buildLadder() in engine.ts pins the corresponding adapter to the front. The default is { provider: 'gemini', mode: 'cli' } — Google CLI free quota. The side panel's vibe.config.set message and QA_PLANNER_* env vars both override this.

AGENT SEE: docs/state/server-state.md — SettingsStore persistence path

## Update Triggers

- When a new model provider or adapter is added.
- When the ladder ordering rules change (new rung, new preferFreePlanner behavior).
- When the ModelAdapter interface gains or loses methods.
- When the isSafeModelId security check scope changes.

## Related Docs

- docs/modules/engine.md — how buildLadder() and ModelRouter are composed in a run
- docs/api/external-services.md — credentials, rate limits, and fallback per provider
- docs/infra/environment.md — env vars for API keys and planner selection
