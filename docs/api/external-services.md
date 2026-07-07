# API: External Services

> Scope: Every external model API and service — credentials, rate limits, fallback behavior.
> Rendering context: Server-side (Node.js daemon)
> Project tier: 3
> Last updated: 2026-06-20

## Overview

The model ladder contacts up to seven external services. All are optional — a run degrades gracefully when any rung is unavailable. Credentials come from the Vault first, then environment variables. No service is required to start the daemon; the only hard dependency is a working Chrome on cfg.cdpPort.

AGENT OWNER: src/router/adapters/

## Gemini Nano (On-Device)

What it does: visual verdicts via the Chrome Prompt API (window.ai). $0, on-device, no network calls.
Module: src/router/adapters/nano.ts wrapping NanoPort (src/ports/nano-runner-page.ts or src/ports/extension-nano.ts).
Credentials: none — the model runs locally in the Chrome profile.
Availability: requires Chrome 128+ (Canary or Dev channel for early access), 22 GB free on the profile volume, and the model downloaded (~2 GB). Run `qa nano --check` to probe; `qa nano --download` to trigger download.
Rate limit: none (on-device).
Fallback: skipped silently; ladder starts at rung 1. The progress line says "Gemini Nano not available".
Latency: ~16.7s cold (model load), ~5.5s warm. nano.warmup() holds one warm session between runs.
AGENT NOTE: The Nano Prompt API requires a secure context. It runs inside a localhost runner page (cfg.runnerPort). About:blank cannot host it. In vibe mode with an injected bridge, it runs inside the extension's offscreen document (extension/nano-offscreen.html) instead.

## Google Gemini CLI (Rung 1 — Free Quota)

What it does: plan-step (generates the next action JSON) and visual-verdict as fallback.
Module: src/router/adapters/google-cli.ts.
Credentials: none for free quota (uses Google account OAuth managed by the gemini CLI). The CLI binary must be on PATH (cfg.googleCliBin, default 'gemini').
Env injection: cfg.googleCliEnv (default { NODE_OPTIONS: '--use-system-ca' }) is injected into every child process. This is required on machines with AVG or Zscaler TLS interception.
Rate limit: free quota limits apply per Google account. Errors surface as CLI non-zero exits; the adapter escalates.
Fallback: on any non-zero exit or JSON parse failure, escalates to rung 2.
AGENT NOTE: The 2026-06-18 transition HAS HAPPENED — the free Gemini CLI tier (Gemini Code Assist for individuals) is dead. `gemini -p` now fails auth with IneligibleTierError / UNSUPPORTED_CLIENT (verified 2026-06-29). google-cli.ts detects this and throws a recovery hint; the router escalates to the next rung. Recover by using a BYOK key (GLM/gemini/claude/openai), the claude/codex CLI (rung 1), or pointing cfg.googleCliBin at the Antigravity CLI once installed. cfg.googleCliBin is the sole source of truth for the binary name — never hardcode 'gemini'.
AGENT NOTE: Exit code 41 means OAuth/TLS failure. The adapter logs a hint about NODE_OPTIONS=--use-system-ca and escalates.

## Claude CLI / CliPlannerAdapter (Rung 1)

What it does: plan-step. A second rung-1 option alongside the Gemini CLI.
Module: src/router/adapters/cli-planner.ts (bin: 'claude').
Credentials: Claude Code account (OAuth managed by the claude CLI). Binary must be on PATH.
Rate limit: depends on the Claude account plan.
Fallback: escalates to rung 2 on any error.

## Gemini BYOK API (Rung 2)

What it does: plan-step and visual-verdict.
Module: src/router/adapters/byok-gemini.ts.
Credentials: Vault key 'gemini' or GEMINI_API_KEY env var.
Default model: gemini-3-flash-preview (cheap tier; set QA_PLANNER_MODEL or cfg.planner.model to override).
Rate limit: governed by the API key's quota.
Fallback: escalates to rung 3 on error; rung 2 is unavailable when no key is configured.
AGENT NOTE: When cfg.preferFreePlanner is false (default) AND a BYOK key is set, the router promotes rung 2 ahead of rung 1 for plan-step (~3× faster HTTP vs CLI cold-spawn). Set QA_PREFER_FREE_PLANNER=1 to keep free quota first.

## Anthropic API (Rung 2)

What it does: plan-step.
Module: src/router/adapters/anthropic.ts.
Credentials: Vault key 'anthropic' or ANTHROPIC_API_KEY env var.
Default model: claude-haiku-4-5 (cheap tier; overridable via planner selection).
Rate limit: governed by the API key's quota.
Fallback: escalates on error; unavailable when no key is configured.

## OpenAI API (Rung 2)

What it does: plan-step.
Module: src/router/adapters/openai-compatible.ts via src/router/gateway.ts (default baseUrl: https://api.openai.com/v1, label: 'gpt').
Credentials: Vault key 'openai' or OPENAI_API_KEY env var.
Default model: gpt-4o-mini.
Gateway override: OPENAI_BASE_URL can point at an OpenAI-compatible gateway such as Vercel AI Gateway or a Cloudflare OpenAI gateway path.
Rate limit: governed by the API key's quota.
Fallback: escalates on error.

## OpenRouter (Rung 2)

What it does: plan-step.
Module: src/router/adapters/openai-compatible.ts via src/router/gateway.ts (default baseUrl: https://openrouter.ai/api/v1, label: 'openrouter').
Credentials: Vault key 'openrouter' or OPENROUTER_API_KEY env var.
Default model: anthropic/claude-3.5-haiku.
Gateway override: OPENROUTER_BASE_URL can point at a compatible proxy while preserving the OpenRouter adapter label/model defaults.
Rate limit: governed by the API key's quota and OpenRouter per-model limits.
Fallback: escalates on error.

## GLM / z.ai (Rung 2)

What it does: plan-step only (GLM-5.2 is text-only — it does not judge screenshots).
Module: src/router/adapters/openai-compatible.ts (label: 'glm', supportsVision: false), wired in engine.ts buildLadder as 'glm:api'.
Endpoint: https://api.z.ai/api/paas/v4/chat/completions (OpenAI-compatible). src/router/gateway.ts uses GLM_BASE_URL for the GLM Coding Plan endpoint or the mainland BigModel host (https://open.bigmodel.cn/api/paas/v4).
Credentials: Vault key 'glm' or GLM_API_KEY (ZAI_API_KEY also accepted) env var. Bearer-token auth.
Default model: glm-5.2. Override via planner selection (QA_PLANNER_MODEL / panel) — e.g. a cheaper GLM tier.
Request shaping: thinking is disabled by default ({ thinking: { type: 'disabled' } }) so the planner stays fast/cheap (set GLM_THINKING=enabled to turn reasoning on); response_format json_object is requested and the schema steered in-prompt.
Dependencies: none new — the adapter uses Node's built-in fetch, like the other rung-2 HTTP adapters (no z.ai SDK).
Rate limit / pricing: governed by the z.ai API key's plan (see https://docs.z.ai/guides/llm/glm-5.2 and z.ai pricing).
Fallback: escalates on error; unavailable (clean skip) when no key is configured.

## Codex CLI / CliPlannerAdapter (Rung 1)

What it does: plan-step.
Module: src/router/adapters/cli-planner.ts (bin: 'codex').
Credentials: Codex account (OAuth managed by the codex CLI). Binary must be on PATH.
Default model: empty (codex uses its own configured default).
Fallback: escalates on error.

## Ollama (Rung 3 — Local/Private)

What it does: plan-step and visual-verdict.
Module: src/router/adapters/ollama.ts.
Credentials: none — Ollama runs locally at localhost:11434.
Default model: llama3.2-vision.
Rate limit: governed by local hardware.
Fallback: the privacy floor. If all other rungs fail, Ollama is the last resort. Unavailable when Ollama is not running.
AGENT NOTE: Ollama is the only rung guaranteed to keep data off external servers. In sensitive testing environments, set QA_PLANNER_PROVIDER=ollama to pin it.

## Video Assertion Routing

`assert_visual` accepts mode `screenshot` or `video`. Current provider adapters consume screenshots only; video mode can add best-effort clip evidence to the report, then falls back to screenshot visual verdict routing until a video-capable adapter is added. Do not send clips to text-only adapters or screenshot-only visual adapters.

## Update Triggers

- When a new external service or adapter is added.
- When credential sources change (new Vault keys or env vars).
- When a model default is updated for any rung.
- When the Google CLI binary name changes after 2026-06-18.
- When video-capable assertion providers are added.

## Related Docs

- docs/modules/model-ladder.md — adapter interface and rung ordering
- docs/infra/environment.md — all API key env vars
- docs/state/server-state.md — Vault encryption and key storage
