# API: External Services

> Scope: Every external model API and service — credentials, rate limits, fallback behavior.
> Rendering context: Server-side (Node.js daemon)
> Project tier: 3
> Last updated: 2026-07-18

## Overview

The model ladder contacts up to nine external services across three capabilities — `visual-verdict`, `plan-step` (the navigator, per-step) and `plan-goals` (the brain, planned once + on escalation) — plus on-device Gemini Nano ($0, no network). All are optional — a run degrades gracefully when any rung is unavailable. Credentials come from the Vault first, then environment variables (`vault.get(name) ?? process.env.X_API_KEY`, see src/engine.ts's `buildLadder()`). No service is required to start the daemon; the only hard dependency is a working Chrome on cfg.cdpPort.

AGENT OWNER: src/router/adapters/

## Gemini Nano (On-Device) — Rung 0

What it does: visual verdicts via the Chrome Prompt API (window.ai), AND serves as the default **navigator** (`plan-step`) — it picks one action at a time from the a11y tree text (`nano.navStep()`). It never serves `plan-goals` (a 3B-class on-device model can pick the next click but shouldn't design a multi-step plan — that's the brain's job). $0, on-device, no network calls.
Module: src/router/adapters/nano.ts (`NanoAdapter`, `supports()` returns true for `visual-verdict` and `plan-step` only) wrapping NanoPort (src/ports/nano-runner-page.ts or src/ports/extension-nano.ts).
Credentials: none — the model runs locally in the Chrome profile.
Availability: requires Chrome 128+ (Canary or Dev channel for early access), 22 GB free on the profile volume, and the model downloaded (~2 GB). Run `spike nano --check` to probe; `spike nano --download` to trigger download.
Rate limit: none (on-device).
Fallback: skipped silently; ladder starts at rung 1. The progress line says "Gemini Nano not available".
Latency: ~16.7s cold (model load), ~5.5s warm. nano.warmup() holds one warm session between runs.
AGENT NOTE: The Nano Prompt API requires a secure context. It runs inside a localhost runner page (cfg.runnerPort). About:blank cannot host it. In vibe mode with an injected bridge, it runs inside the extension's offscreen document (extension/nano-offscreen.html) instead.
AGENT NOTE: Nano-as-navigator is real but still rough (see CLAUDE.md) — on at least one real site it guessed a URL instead of clicking a nav link. Treat it as "Experimental"; a cheap vision cloud navigator (Gemini Flash / Haiku) is the more reliable default until `spikes/nano-nav/` GO/NO-GOs.

## Google Gemini CLI (Rung 1 — Free Quota, DEAD for individuals)

What it does: plan-step / plan-goals (generates the next action or goal-plan JSON) and visual-verdict as fallback.
Module: src/router/adapters/google-cli.ts (`GoogleCliAdapter`, `supports()` returns true for all three capabilities).
Credentials: none for free quota (uses Google account OAuth managed by the gemini CLI). The CLI binary must be on PATH (cfg.googleCliBin, default 'gemini'; env override QA_GOOGLE_CLI_BIN). Model: cfg.googleCliModel, default `gemini-3-flash-preview` (env override QA_GOOGLE_CLI_MODEL).
Env injection: cfg.googleCliEnv (default { NODE_OPTIONS: '--use-system-ca' }) is injected into every child process. This is required on machines with AVG or Zscaler TLS interception.
Rate limit: free quota limits apply per Google account. Errors surface as CLI non-zero exits; the adapter escalates.
Fallback: on any non-zero exit or JSON parse failure, escalates to the next rung.
AGENT NOTE: The 2026-06-18 transition HAS HAPPENED and remains true as of 2026-07-18 — the free Gemini CLI tier (Gemini Code Assist for individuals) is dead. `gemini -p` now fails auth with IneligibleTierError / UNSUPPORTED_CLIENT (verified 2026-06-29). google-cli.ts detects the failure text (`IneligibleTier|UNSUPPORTED_CLIENT|no longer supported|Antigravity`) and throws a recovery hint naming `spike config set --provider glm`/gemini/claude/openai, the `claude`/`codex` CLI, or pointing cfg.googleCliBin at the Antigravity CLI once installed; the router escalates to the next rung either way. cfg.googleCliBin is the sole source of truth for the binary name — never hardcode 'gemini'. `config.ts`'s `warnIfDeadPlanner()` also prints a startup warning if the FINAL resolved planner/navigator pin still resolves to `gemini:cli` (the common on-disk case is already migrated away — see CLAUDE.md's navigator/brain-pin note).
AGENT NOTE: Exit code 41 means OAuth/TLS failure. Exit code 55 means an untrusted CLI workspace (GEMINI_CLI_TRUST_WORKSPACE=true should already be set by the adapter). Both are logged with a hint and escalate.

## Claude CLI / CliPlannerAdapter (Rung 1) — default brain

What it does: plan-step and plan-goals ONLY — `supports()` explicitly rejects `visual-verdict` (headless image attach isn't reliable across `claude`/`codex`, so visual verdicts stay on Nano/API/Ollama). This is the DEFAULT brain (`DEFAULTS.planner = { provider: 'claude', mode: 'cli' }` in src/config.ts) since the Gemini CLI free tier died.
Module: src/router/adapters/cli-planner.ts (`CliPlannerAdapter`, bin: 'claude', recipe: `claude -p --output-format json [--model <m>]`, prompt piped via stdin).
Credentials: Claude Code account (OAuth managed by the claude CLI). Binary must be on PATH. `available()` is a 30s-TTL-cached `claude --version` probe.
Default model: unset (falls back to the CLI's own configured model) unless a navigator/brain model override is set (brain default `claude-sonnet-5`, navigator default `claude-haiku-4-5` — see src/vibe/settings-data.ts `BRAIN_MODELS`/`NAVIGATOR_MODELS`).
Rate limit: depends on the Claude account plan.
Fallback: escalates to the next rung on any error (non-zero exit, timeout, unparseable output).

## Gemini BYOK API (Rung 2)

What it does: plan-step, plan-goals, visual-verdict, AND video-verdict (Phase 8) — the first concrete video-capable adapter in the ladder.
Module: src/router/adapters/byok-gemini.ts (`ByokGeminiAdapter`, `readonly supportsVideo = true`).
Credentials: Vault key 'gemini' or GEMINI_API_KEY env var (`cfg.geminiApiKey`). Auth is the `x-goog-api-key` request header (switched from a `?key=` query-string param as of 2026-07-18 — keeps the key out of URLs/logs) on both `generateContent` and the Files API upload/poll calls.
Default model: gemini-3-flash-preview for the navigator role, same for brain (no confirmed "pro" id yet — flash stays the brain default too). Set via navigator/brain selection (QA_PLANNER_MODEL / QA_NAVIGATOR_MODEL / panel), not a separate env var.
Video verdict: `videoVerdict(clipPath, expectation)` uploads the clip to the Gemini Files API (multipart, WebM/MP4/GIF → the matching MIME type), polls `GET /v1beta/{name}` every 2s until the file leaves `PROCESSING` (30s deadline; a `FAILED` state throws), then asks for a schema-enforced verdict referencing the uploaded `fileUri`. Only reachable when `cfg.videoAssertions` is true (opt-in, default false — see "Video Assertion Routing" below).
Rate limit: governed by the API key's quota.
Fallback: escalates to the next rung on error; rung 2 is unavailable when no key is configured.
AGENT NOTE: When cfg.preferFreePlanner is false (default) AND a BYOK key is set, the router promotes rung 2 ahead of rung 1 for plan-step (~3× faster HTTP vs CLI cold-spawn). Set QA_PREFER_FREE_PLANNER=1 to keep free quota first.
AGENT NOTE: Do NOT pass req.schema as Gemini's native `responseSchema` — this codebase's schemas use constructs (`additionalProperties`, `minItems`, `$`-keywords) that Gemini's strict schema subset rejects with a 400 "Unknown name" error. The adapter steers the shape in-prompt instead (`withSchemaInstruction`) plus `responseMimeType: 'application/json'`.

## Anthropic API (Rung 2)

What it does: plan-step, plan-goals, and visual-verdict (screenshot only — `supports()` returns true for all three capabilities, but `AnthropicAdapter` never sets `supportsVideo`/`videoVerdict`; a video assertion routed here falls back to the screenshot verdict path).
Module: src/router/adapters/anthropic.ts (Messages API, raw fetch — no SDK, image sent as a base64 content block).
Credentials: Vault key 'anthropic' or ANTHROPIC_API_KEY env var.
Default model: claude-haiku-4-5 for the navigator role, claude-sonnet-5 for the brain role (src/vibe/settings-data.ts).
Rate limit: governed by the API key's quota.
Fallback: escalates on error; unavailable when no key is configured.
AGENT NOTE: `browserDirect` option (default false) adds Anthropic's CORS opt-in header for LITE mode, where the extension calls the Anthropic API directly from the browser/SW context (no daemon). The daemon path always leaves it false. This exposes the key to the page's origin context — acceptable only because it's the user's own key never leaving their machine except to Anthropic.

## OpenAI API (Rung 2)

What it does: plan-step, plan-goals, and visual-verdict (screenshot only — `supportsVision` defaults true; `supportsVideo` is explicit false, so a video assertion falls back to the screenshot path).
Module: src/router/adapters/openai-compatible.ts via src/router/gateway.ts (default baseUrl: https://api.openai.com/v1, label: 'gpt').
Credentials: Vault key 'openai' or OPENAI_API_KEY env var.
Default model: gpt-4o-mini for the navigator role, gpt-4o for the brain role.
Gateway override: OPENAI_BASE_URL can point at an OpenAI-compatible gateway such as Vercel AI Gateway or a Cloudflare OpenAI gateway path. `assertHttpsBaseUrl()` in gateway.ts rejects a non-https override outright (a stray http:// value would otherwise leak the Bearer key over an unencrypted transport).
Rate limit: governed by the API key's quota.
Fallback: escalates on error.
AGENT NOTE: `gpt:cli` (the codex CLI, see below) is a separate rung-1 slot from this rung-2 HTTP adapter — both share the 'gpt' provider id but different modes.

## OpenRouter (Rung 2)

What it does: plan-step, plan-goals, and visual-verdict (screenshot only, same `supportsVision: true` default / `supportsVideo: false` as the OpenAI slot above — depends on the routed OpenRouter model actually accepting image input).
Module: src/router/adapters/openai-compatible.ts via src/router/gateway.ts (default baseUrl: https://openrouter.ai/api/v1, label: 'openrouter').
Credentials: Vault key 'openrouter' or OPENROUTER_API_KEY env var.
Default model: anthropic/claude-3.5-haiku for the navigator role, anthropic/claude-3.5-sonnet for the brain role.
Gateway override: OPENROUTER_BASE_URL can point at a compatible proxy while preserving the OpenRouter adapter label/model defaults (same https-only guard as the OpenAI gateway).
Rate limit: governed by the API key's quota and OpenRouter per-model limits.
Fallback: escalates on error.

## GLM / z.ai (Rung 2)

What it does: plan-step and plan-goals ONLY (GLM-5.2 is text-only — it does not judge screenshots or video).
Module: src/router/adapters/openai-compatible.ts (label: 'glm', supportsVision: false), wired in src/engine.ts's `buildLadder()` as the `glm:api` slot.
Endpoint: https://api.z.ai/api/paas/v4 (OpenAI-compatible `/chat/completions`). src/router/gateway.ts uses GLM_BASE_URL to override — e.g. the GLM Coding Plan endpoint or the mainland BigModel host (https://open.bigmodel.cn/api/paas/v4); non-https values are rejected.
Credentials: Vault key 'glm' or GLM_API_KEY env var (ZAI_API_KEY also accepted as a fallback). Bearer-token auth.
Default model: glm-5.2 for both navigator and brain roles (src/vibe/settings-data.ts — no separate "pro" tier tracked yet). Override via navigator/brain model selection.
Request shaping: thinking is disabled by default (`extraBody: { thinking: { type: 'disabled' } }`) so the planner stays fast/cheap — set GLM_THINKING=enabled to turn reasoning on; response_format json_object is requested and the schema steered in-prompt.
Dependencies: none new — the adapter uses Node's built-in fetch, like the other rung-2 HTTP adapters (no z.ai SDK).
Rate limit / pricing: governed by the z.ai API key's plan (see https://docs.z.ai/guides/llm/glm-5.2 and z.ai pricing).
Fallback: escalates on error; unavailable (clean skip) when no key is configured.

## Codex CLI / CliPlannerAdapter (Rung 1)

What it does: plan-step and plan-goals ONLY — same visual-verdict rejection as the claude CLI slot above (shared `CliPlannerAdapter` class).
Module: src/router/adapters/cli-planner.ts (bin: 'codex', recipe: `codex exec [-m <model>]`, prompt piped via stdin).
Credentials: Codex account (OAuth managed by the codex CLI). Binary must be on PATH. Same 30s-TTL `--version` availability probe as the claude slot.
Default model: empty string (codex uses its own configured default) unless a navigator/brain model override is set.
Fallback: escalates on error.

## Ollama (Rung 3 — Local/Private)

What it does: plan-step, plan-goals, and visual-verdict — the only rung-3+ adapter that `supports()` every capability unconditionally.
Module: src/router/adapters/ollama.ts.
Credentials: none — Ollama runs locally, default http://localhost:11434 (override via adapter opts; no dedicated env var wired in buildLadder today).
Default model: llama3.2-vision.
Availability: a 300ms-timeout `GET /api/tags` probe, cached 30s (mirrors the CLI adapters' pattern) so a not-running Ollama doesn't cost a slow probe on every step.
Rate limit: governed by local hardware.
Fallback: the privacy floor. If all other rungs fail, Ollama is the last resort. Unavailable when Ollama is not running.
AGENT NOTE: Ollama is the only rung guaranteed to keep data off external servers. In sensitive testing environments, set QA_PLANNER_PROVIDER=ollama (and/or QA_NAVIGATOR_PROVIDER=ollama) to pin it.

## Video Assertion Routing

`assert_visual` accepts mode `screenshot` or `video`, gated by `cfg.videoAssertions` (default false — opt-in, costly). When ON, a video-mode assertion routes through `ModelRouter.videoVerdict()` / `hasVideoVerdict()` to an adapter with `supportsVideo: true` — today that's Gemini BYOK only (see above; its `videoVerdict()` uploads the clip to the Files API and judges the uploaded file). Anthropic and the OpenAI-compatible adapters (OpenAI, OpenRouter, GLM) stay screenshot-only and never set `supportsVideo`/`videoVerdict`; a video assertion that reaches one of them (or reaches the ladder with `cfg.videoAssertions` OFF) falls back to the screenshot verdict path with a report note ("video assertion requested but disabled" / no video-capable adapter available). Never send clips to text-only adapters (GLM) or screenshot-only visual adapters.

## Update Triggers

- When a new external service or adapter is added.
- When credential sources change (new Vault keys or env vars).
- When a model default is updated for any rung (check both src/vibe/settings-data.ts's NAVIGATOR_MODELS/BRAIN_MODELS tables — most adapters have distinct navigator vs brain defaults).
- When the Google CLI binary name changes after 2026-06-18 (e.g. to the Antigravity CLI).
- When a second video-capable adapter is added, or Gemini's video routing changes.
- When an adapter's `supports()` capability set changes (visual-verdict / plan-step / plan-goals).

## Related Docs

- docs/modules/model-ladder.md — adapter interface and rung ordering
- docs/infra/environment.md — all API key env vars
- docs/state/server-state.md — Vault encryption and key storage
