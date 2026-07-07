# Module: Model Ladder

> Scope: ModelRouter, ModelAdapter interface, and all rung adapters in src/router/.
> Rendering context: Server-side (Node.js daemon)
> Project tier: 3
> Last updated: 2026-07-07

## Overview

The model ladder is a cost-ordered sequence of AI adapters. Each adapter wraps one model access method and declares its rung (cost level). ModelRouter walks the ladder per capability request, cheap first unless a role pin or BYOK-fast ordering changes the planner order. Every call, success or failure, appends a ModelTraceEntry to router.trace, which feeds report.model_trace and token accounting.

The current architecture splits planning into two roles:

- visual-verdict: judge a screenshot against an expectation.
- plan-step: the NAVIGATOR, a cheap per-step call that chooses the next browser action.
- plan-goals: the BRAIN, a smarter and rarer call that creates or repairs the sub-goal plan.

AGENT OWNER: src/router/

## ModelAdapter Interface (src/router/adapter.ts)

Every adapter implements:

- name: unique identifier used in trace entries and role pins.
- rung: cost tier (0 = free on-device, 1 = free CLI quota, 2 = BYOK API, 3 = local/Ollama).
- supports(cap): declares support for visual-verdict, plan-step, or plan-goals.
- available(): async probe; returns false when unconfigured or unreachable. ModelRouter probes supported adapters in parallel before each ladder walk.
- generateJson(opts): accepts prompt, schema, and optional imagePng, then returns a parsed JSON-shaped value.
- lastUsage: optional token usage from the most recent generateJson call. The router copies it into ModelTraceEntry. Rung-0 Nano and local adapters may leave it undefined.

Any adapter that supports plan-step can also support plan-goals, except Nano. Nano supports visual-verdict and plan-step only; it is never the BRAIN.

## ModelRouter (src/router/model-router.ts)

Constructor accepts adapters and ModelRouterOptions:

- preferFreePlanner: when false, live rung-2 planners are promoted before rung-1 planners for both plan-step and plan-goals. Visual verdicts are unaffected.
- pinnedAdapter: back-compat single pin used for both planner roles when role-specific pins are absent. For visual-verdict, rung-0 Nano still stays first.
- navigatorAdapter: role pin for plan-step. This is cfg.navigator resolved to an adapter name by buildLadder().
- plannerAdapter: role pin for plan-goals. This is cfg.planner resolved to an adapter name by buildLadder().

planJson(prompt, schema, step) walks the plan-step ladder. This is the NAVIGATOR path and is called frequently by the driver loop.

planGoals(prompt, schema, step) walks the plan-goals ladder. This is the BRAIN path and is used for the sub-goal plan or re-plan.

visualVerdict(png, expectation, step) walks the visual-verdict ladder. Rung 0 Nano always leads when available. On an uncertain verdict, the router escalates to the next visual adapter and returns the last uncertain verdict if every visual adapter is uncertain.

visualVerdictCandidates() returns the live visual-capable candidates in ladder order. visualVerdictWith(candidate, png, expectation, step, traceNote) runs a specific candidate and appends the same model_trace metadata as a normal visual verdict. src/assertions/policy.ts uses these helpers for `fail-on-disagreement` and `arbiter-on-disagreement`; the default `single-ladder` policy still calls visualVerdict().

hasCapability(cap) probes whether any adapter can serve a capability right now. The driver uses this for plan-goals so a missing BRAIN can degrade to navigator-only behavior instead of failing the run.

AGENT NOTE: available() probes are called in parallel before every ladder walk and are not cached between steps. A CLI or local service may become available mid-run, so live state drives ordering.

## Rung 0 - NanoAdapter (src/router/adapters/nano.ts)

Wraps NanoPort. Rung 0. Supports:

- visual-verdict: passes the bare expectation plus screenshot to the runner/offscreen Prompt API.
- plan-step: calls nano.navStep() with the navigator prompt and schema.

Nano never supports plan-goals. It is a cheap local navigator and visual judge, not the BRAIN. It reports no token counts because it is on-device and $0.

## Rung 1 - GoogleCliAdapter (src/router/adapters/google-cli.ts)

Wraps the Google CLI binary from cfg.googleCliBin. Rung 1. Supports planning and visual verdicts. Spawns a child process with -p, passes images as base64 inline, and injects cfg.googleCliEnv into the child environment.

AGENT NOTE: The binary name is config-driven. Never hardcode "gemini"; use cfg.googleCliBin.

AGENT NOTE: Exit code 41 from the Google CLI child process means OAuth/TLS failure. The adapter prints a hint and re-throws; the router escalates.

## Rung 1 - CliPlannerAdapter (src/router/adapters/cli-planner.ts)

Generic CLI planner adapter for claude CLI and codex CLI. Rung 1. Supports plan-step and plan-goals. Spawns the binary, passes the prompt through stdin or a prompt flag, and parses JSON output.

AGENT AVOID: Never pass user-supplied model IDs to CLI adapters without the isSafeModelId() check from src/vibe/settings.ts. The model flag is passed in a shell-spawned child; an unsanitized model string is a command-injection sink.

## Rung 2 - ByokGeminiAdapter (src/router/adapters/byok-gemini.ts)

Calls the Gemini REST API directly using cfg.geminiApiKey or the Vault "gemini" key. Rung 2. Supports planning and visual verdicts. Returns token counts from usageMetadata.

## Rung 2 - AnthropicAdapter (src/router/adapters/anthropic.ts)

Calls the Anthropic API using the Vault "anthropic" key or ANTHROPIC_API_KEY. Rung 2. Supports plan-step and plan-goals. It is commonly used as the BRAIN default through cfg.planner.

## Rung 2 - OpenAiCompatibleAdapter (src/router/adapters/openai-compatible.ts)

OpenAI-compatible REST adapter. Used for gpt:api, openrouter:api, and glm:api. Rung 2. Supports plan-step and plan-goals, and supports visual-verdict only when constructed with supportsVision:true. Keys come from Vault or provider env vars. src/router/gateway.ts normalizes provider and gateway base URLs before adapter construction.

AGENT NOTE: supportsVision:false keeps text-only models such as GLM off the visual-verdict ladder. jsonMode and extraBody are provider-specific request knobs. Gateway base URL overrides must point at an OpenAI-compatible `/v1`-style base; a trailing `/chat/completions` suffix is normalized away.

## Rung 2 - GLM / z.ai

GLM is wired as glm:api through OpenAiCompatibleAdapter. It is constructed with supportsVision:false and joins only the planning ladders. GLM_THINKING defaults to disabled so planner calls stay fast and cheap.

## Rung 3 - OllamaAdapter (src/router/adapters/ollama.ts)

Calls a local Ollama instance on localhost:11434. Rung 3. Supports planning and visual verdicts when the configured local model can serve them. Privacy floor: no data leaves the machine on this rung.

## Ladder Ordering Summary

For plan-step: navigatorAdapter if live -> pinnedAdapter if no navigatorAdapter -> rung 2 before rung 1 when preferFreePlanner=false -> remaining planners by rung. Nano may lead this role when cfg.navigator resolves to nano and Nano is available.

For plan-goals: plannerAdapter if live -> pinnedAdapter if no plannerAdapter -> rung 2 before rung 1 when preferFreePlanner=false -> remaining planners by rung. Nano never appears on this ladder.

For visual-verdict: rung 0 Nano -> pinnedAdapter if live and not Nano -> remaining visual-capable adapters by rung. Text-only adapters do not appear.

## PlannerSelection, NavigatorSelection, and SettingsStore

The user's BRAIN choice is stored in cfg.planner and pins plannerAdapter for plan-goals. The user's NAVIGATOR choice is stored in cfg.navigator and pins navigatorAdapter for plan-step. loadConfig() merges defaults, qa.config.json, SettingsStore, env, and explicit overrides; QA_PLANNER_* controls the BRAIN and QA_NAVIGATOR_* controls the NAVIGATOR.

buildLadder() resolves each role selection to an adapter name, constructs each provider:mode slot once, and passes navigatorAdapter/plannerAdapter into ModelRouter. Role-specific model IDs are applied to the pinned slot; unpinned fallback slots use cheap navigator-tier defaults. Nano resolves to the adapter name "nano"; it can serve plan-step if available but is intentionally absent from plan-goals.

AGENT SEE: docs/state/server-state.md - SettingsStore persistence path

## Token Accounting

Adapters that receive provider usage metadata set lastUsage after generateJson(). ModelRouter copies that value into each ModelTraceEntry. This makes report.model_trace the source for per-call prompt, output, total, and cached token counts when providers expose them. Nano and local adapters can omit usage.

## Update Triggers

- When a model provider or adapter is added.
- When capability support changes for any adapter.
- When ladder ordering, role pinning, or preferFreePlanner behavior changes.
- When ModelAdapter or ModelRouterOptions gains or loses fields.
- When assertion consensus routing or visual candidate selection changes.
- When token usage is reported from a new source.
- When the isSafeModelId security check scope changes.

## Related Docs

- docs/modules/engine.md - how buildLadder() and ModelRouter are composed in a run
- docs/api/external-services.md - credentials, rate limits, and fallback per provider
- docs/infra/environment.md - env vars for API keys and planner/navigator selection
