# Module: Model Ladder

> Scope: ModelRouter, ModelAdapter interface, and all rung adapters in src/router/.
> Rendering context: Server-side (Node.js daemon)
> Project tier: 3
> Last updated: 2026-07-18

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
- supportsVideo: optional. True only on an adapter that can judge an uploaded video clip in addition to a screenshot. Absent/false means screenshot-only.
- videoVerdict(clipPath, expectation): optional, present iff supportsVideo is true. Uploads/judges a recorded clip and returns the same raw verdict shape generateJson() returns for a visual-verdict call.

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

hasVideoVerdict() (Phase 8, opt-in via cfg.videoAssertions) returns true iff the current visual-verdict ladder contains at least one live candidate with supportsVideo and a videoVerdict method. videoVerdict(videoPath, expectation, step) picks the FIRST such candidate (same ladder/pin ordering as visualVerdict()), calls its videoVerdict(), normalizes the reply into the same NanoVerdict shape visualVerdict() returns, and records a ModelTraceEntry with note:'video'. It throws when no candidate supports video (`no video-capable visual-verdict adapter available`) — the driver catches this and falls back to a screenshot verdict, writing a report note. It never falls back internally to a screenshot call itself; that decision belongs to the caller.

AGENT NOTE: available() probes are called in parallel before every ladder walk. Rung-0 Nano and the BYOK/HTTP rung-2 adapters probe live every call (cheap: a boolean check or a stored key). GoogleCliAdapter, CliPlannerAdapter, and OllamaAdapter cache their (slower, spawn/localhost-fetch) probe for 30s so a long run doesn't re-probe on every step, while still picking a CLI/service that becomes available mid-run back up within that window.

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

Generic CLI planner adapter for claude CLI and codex CLI. Rung 1. Supports plan-step, plan-goals AND visual-verdict. Spawns the binary, passes the prompt through stdin or a prompt flag, and parses JSON output.

Visual verdicts (Phase: 2026-07-18): a `req.imagePng` screenshot is written by basename into a lazily-created per-adapter work dir and the child runs with `cwd` there — claude gets an `@shot.png` mention prepended to the prompt (Claude Code reads @-path images), codex gets `codex exec --image shot.png`. cwd+basename dodges argv-with-spaces and each CLI's workspace-file guard (mirrors GoogleCliAdapter). The router still leads the visual-verdict ladder with Nano/API, so this only ADDS a fallback rung; it does not displace Nano. If an installed CLI names the image mechanism differently, the two spots to change are the header-documented imageArgs (codex) and the claude prompt-prefix in generateJson().

AGENT AVOID: Never pass user-supplied model IDs to CLI adapters without the isSafeModelId() check from src/vibe/settings.ts. The model flag is passed in a shell-spawned child; an unsanitized model string is a command-injection sink.

## Rung 2 - ByokGeminiAdapter (src/router/adapters/byok-gemini.ts)

Calls the Gemini REST API directly using cfg.geminiApiKey or the Vault "gemini" key. Rung 2. Supports planning and visual verdicts. Returns token counts from usageMetadata. Selectable for BOTH the NAVIGATOR (plan-step) and visual-verdict roles, not just planning — see "Reliable Default Recipe" below.

supportsVideo is true. videoVerdict(clipPath, expectation) uploads the clip to the Gemini Files API (`POST /upload/v1beta/files`, multipart/related body with a JSON metadata part + the raw clip bytes), polls `GET /v1beta/{file.name}` until the file leaves `PROCESSING` (bounded to ~30s), then calls `generateContent` with a `fileData` part referencing the uploaded `fileUri` plus a schema-steered video-verdict prompt (`videoVerdictPrompt()` in verdict.ts). Reuses the adapter's already-configured model id — no new model is invented. This is the Phase 8 route ModelRouter.videoVerdict() calls when cfg.videoAssertions is on.

## Rung 2 - AnthropicAdapter (src/router/adapters/anthropic.ts)

Calls the Anthropic API using the Vault "anthropic" key or ANTHROPIC_API_KEY. Rung 2. Supports plan-step and plan-goals, and visual-verdict (image as a base64 content block) — selectable for BOTH the NAVIGATOR and visual-verdict roles. It is commonly used as the BRAIN default through cfg.planner.

Screenshot-only: supportsVideo is explicitly false. The Messages API has no Files-API-style video upload/judge path, so a video assertion routed here falls back to the screenshot verdict.

## Rung 2 - OpenAiCompatibleAdapter (src/router/adapters/openai-compatible.ts)

OpenAI-compatible REST adapter. Used for gpt:api, openrouter:api, and glm:api. Rung 2. Supports plan-step and plan-goals, and supports visual-verdict only when constructed with supportsVision:true. Keys come from Vault or provider env vars. src/router/gateway.ts normalizes provider and gateway base URLs before adapter construction.

AGENT NOTE: supportsVision:false keeps text-only models such as GLM off the visual-verdict ladder. jsonMode and extraBody are provider-specific request knobs. Gateway base URL overrides must point at an OpenAI-compatible `/v1`-style base; a trailing `/chat/completions` suffix is normalized away.

Screenshot-only: supportsVideo is explicitly false for gpt/openrouter/glm — chat-completions has no standard video-upload-and-judge path across those providers.

## Rung 2 - GLM / z.ai

GLM is wired as glm:api through OpenAiCompatibleAdapter. It is constructed with supportsVision:false and joins only the planning ladders. GLM_THINKING defaults to disabled so planner calls stay fast and cheap.

## Rung 3 - OllamaAdapter (src/router/adapters/ollama.ts)

Calls a local Ollama instance on localhost:11434. Rung 3. Supports planning and visual verdicts when the configured local model can serve them. Privacy floor: no data leaves the machine on this rung.

## Video Assertions (Phase 8, opt-in)

Config field cfg.videoAssertions (default false, env QA_VIDEO_ASSERTIONS) gates `assert_visual { mode: 'video' }`. OFF (default): the driver runs the normal screenshot verdict and writes a report note that video was requested but disabled — it never calls router.videoVerdict(). ON: the driver records a clip (CDP screencast or extension tabCapture, per docs/modules/engine.md), calls router.hasVideoVerdict() to check a video-capable candidate is live, then router.videoVerdict(clipPath, expectation, step). Today only ByokGeminiAdapter (byok-gemini.ts) implements the route; Anthropic and the OpenAI-compatible adapters (gpt/openrouter/glm) are screenshot-only. Any failure (no adapter, upload error, timeout) is caught by the driver, which falls back to the screenshot path rather than failing the run.

## Ladder Ordering Summary

For plan-step: navigatorAdapter if live -> pinnedAdapter if no navigatorAdapter -> rung 2 before rung 1 when preferFreePlanner=false -> remaining planners by rung. Nano may lead this role when cfg.navigator resolves to nano and Nano is available.

For plan-goals: plannerAdapter if live -> pinnedAdapter if no plannerAdapter -> rung 2 before rung 1 when preferFreePlanner=false -> remaining planners by rung. Nano never appears on this ladder.

For visual-verdict: rung 0 Nano -> pinnedAdapter if live and not Nano -> remaining visual-capable adapters by rung. Text-only adapters do not appear.

## PlannerSelection, NavigatorSelection, and SettingsStore

The user's BRAIN choice is stored in cfg.planner and pins plannerAdapter for plan-goals. The user's NAVIGATOR choice is stored in cfg.navigator and pins navigatorAdapter for plan-step. loadConfig() merges defaults, qa.config.json, SettingsStore, env, and explicit overrides; QA_PLANNER_* controls the BRAIN and QA_NAVIGATOR_* controls the NAVIGATOR.

buildLadder() resolves each role selection to an adapter name, constructs each provider:mode slot once (by default), and passes navigatorAdapter/plannerAdapter into ModelRouter. Role-specific model IDs are applied to the pinned slot; unpinned fallback slots use cheap navigator-tier defaults. Nano resolves to the adapter name "nano"; it can serve plan-step if available but is intentionally absent from plan-goals.

AGENT SEE: docs/state/server-state.md - SettingsStore persistence path

## buildLadder() construction: makeAdapter() + SLOTS (2026-07-18)

buildLadder() (src/engine.ts) builds the fallback ladder through two pieces instead of one-off `byKey.set(...)` calls per provider:

- `makeAdapter(provider, mode, model)` — a `switch` on `${provider}:${mode}` that constructs exactly one adapter instance (GoogleCliAdapter, ByokGeminiAdapter, AnthropicAdapter, CliPlannerAdapter for both `claude:cli` and `gpt:cli`, OpenAiCompatibleAdapter for `gpt:api`/`openrouter:api`/`glm:api`, OllamaAdapter) for an explicit model string, or `undefined` for an unrecognized slot.
- `SLOTS` — a `[provider, mode, base]` array (gemini:cli, gemini:api, claude:api, claude:cli, gpt:api, gpt:cli, openrouter:api, glm:api, ollama:api) that buildLadder() iterates once, calling `modelFor(provider, mode, base)` to resolve the model for that slot, then `makeAdapter(...)` to build it, then `byKey.set(`${provider}:${mode}`, adapter)`. `modelFor()` is unchanged: a role that pins the slot supplies its own model (or the role-appropriate `defaultModelFor()` default); an unpinned slot takes the cheap navigator-tier default.

This refactor is mechanical (same slots, same models, same resulting ladder) EXCEPT for one behavioral change, described next.

### Distinct brain instance when navigator and brain share a slot with different models

Before this change, if the navigator and brain pins resolved to the same `provider:mode` slot (e.g. both `claude:cli`), `byKey` held only ONE adapter for that slot — built with whichever role's model `modelFor()` picked first (the navigator, since it is checked before the brain). The brain's own configured model was silently discarded and the brain ran on the navigator's model without any error or log line.

buildLadder() now detects this case explicitly, after computing `navigatorName`/`plannerName`:

```
const navSlot = `${nav.provider}:${nav.mode}`;
const brainSlot = `${brain.provider}:${brain.mode}`;
...
if (brain.provider !== 'nano' && navSlot === brainSlot) {
  const navModel = nav.model || defaultModelFor(nav.provider, nav.mode, 'navigator');
  const brainModel = brain.model || defaultModelFor(brain.provider, brain.mode, 'brain');
  if (brainModel !== navModel) {
    const brainAdapter = makeAdapter(brain.provider, brain.mode, brainModel);
    if (brainAdapter) {
      byKey.set(`${brainSlot}:brain`, brainAdapter);
      plannerName = brainAdapter.name;
    }
  }
}
```

When the shared slot's resolved navigator model and brain model differ, buildLadder() calls `makeAdapter()` a second time with the brain's model and stores it under a distinct key, `${brainSlot}:brain` (e.g. `claude:cli:brain`), so it does not collide with the navigator's `claude:cli` entry in `byKey`. `plannerName` is reassigned to the new adapter's own `name` so ModelRouter's `plannerAdapter` pin resolves to the brain-specific instance, not the shared one. If the two roles resolve to the SAME model on a shared slot (common case: navigator and brain both left at provider defaults), a single shared instance is still used — the extra instance is only created when the models actually diverge, keeping the common case unchanged and the ladder from growing extra unused adapters.

Why this matters: without it, a user (or SettingsStore migration) who pins the navigator to `claude:cli` with a cheap/fast model and the brain to `claude:cli` with a stronger model for planning would get the brain silently downgraded to the navigator's model — no error, no trace note, just a weaker brain than configured. The fix makes each role's model pin authoritative regardless of whether the two roles happen to share a CLI/API slot.

`nano` is exempt from this logic (`brain.provider !== 'nano'` guard) — a brain pinned to `nano` never reaches this branch because `plan-goals` never resolves to Nano in the first place (see "Nano never supports plan-goals" above).

## Config Drift Migration (Phase 13)

SettingsStore.readRaw() (src/vibe/settings.ts) reads settings.json exactly as stored, with no default-filling for planner/navigator — this lets config.ts's fromSettings() distinguish "the user explicitly saved a role pin" from "nothing was ever saved, fall through to config.ts's own DEFAULTS" (previously SettingsStore.read()'s always-filled shape silently overrode config.ts's daemon-specific claude:cli brain default with the shared lite DEFAULT_SETTINGS.planner of claude:api, even on a machine with no settings.json at all).

readRaw() also migrates on load: a persisted planner pinned to the dead Gemini CLI free tier (isDeadPlannerSelection() in settings-data.ts: provider 'gemini' + mode 'cli') is rewritten to claude:cli; a persisted config with no navigator key (pre planner/navigator split) is rewritten to nano:ondevice. The migrated result is written back to settings.json once, so every other reader (the panel, `qa config` CLI) sees the fixed values without re-deriving the migration. loadConfig() additionally prints a startup warning (warnIfDeadPlanner()) if the FINAL merged config still resolves either role to gemini:cli — this only fires for an explicit env/qa.config.json/override pin, since the on-disk case is already migrated away.

There is no checked-in settings.json in this repo (it is a per-machine file under %LOCALAPPDATA%/qa-subagent/, created on first run) — DEFAULTS.planner in src/config.ts (claude:cli) is the single source of truth for the daemon's out-of-the-box brain pin.

## Reliable Default Recipe (Phase 12)

A cheap, reliable non-Nano navigator + visual pair, useful while Nano-as-navigator stays Experimental (see CLAUDE.md's "Nano-as-navigator is real but rough" gotcha):

```
GEMINI_API_KEY=<your key>
QA_NAVIGATOR_PROVIDER=gemini
QA_NAVIGATOR_MODE=api
QA_NAVIGATOR_MODEL=gemini-3-flash-preview   # optional — already the default
QA_PLANNER_PROVIDER=claude
QA_PLANNER_MODE=cli                          # or api + ANTHROPIC_API_KEY for BYOK
```

ByokGeminiAdapter and AnthropicAdapter both declare `supports(cap)` unconditionally true, so either is selectable for BOTH plan-step (navigator) and visual-verdict, not just planning — pin either as navigatorAdapter and it also leads the visual-verdict ladder right after rung-0 Nano (or absolute-first if Nano is unavailable). An all-BYOK pair with no CLI dependency: `GEMINI_API_KEY` + `QA_NAVIGATOR_PROVIDER=gemini QA_NAVIGATOR_MODE=api` for the navigator, `ANTHROPIC_API_KEY` + `QA_PLANNER_PROVIDER=claude QA_PLANNER_MODE=api` for the brain.

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
- When supportsVideo/videoVerdict is added to a new adapter.
- When the config-drift migration's dead-provider detection or migration target changes.
- When the availability-probe TTL window changes for any adapter.
- When buildLadder()'s SLOTS table, makeAdapter() switch, or the shared-slot distinct-brain-instance logic changes.

## Related Docs

- docs/modules/engine.md - how buildLadder() and ModelRouter are composed in a run
- docs/api/external-services.md - credentials, rate limits, and fallback per provider
- docs/infra/environment.md - env vars for API keys and planner/navigator selection
