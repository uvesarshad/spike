# Infrastructure: Environment Variables and Config

> Scope: Every environment variable and spike.config.json key; purpose, default, and which module consumes each.
> Rendering context: Server-side (Node.js daemon / CLI)
> Project tier: 3
> Last updated: 2026-07-18

## Overview

Config resolution order (low to high): built-in defaults -> spike.config.json -> SettingsStore (user prefs) -> environment variables -> explicit CLI/API overrides. Environment variables win over the file for automation and CI. Env vars are read in src/config.ts via fromEnv(); provider API env vars are also consumed by adapter/engine setup.

AGENT OWNER: src/config.ts

## Legacy `QA_` prefix (back-compat)

Every tunable below used to be `QA_*` (the tool was `browser-qa-subagent`); the prefix is `SPIKE_*` as of the Spike rename. `src/env-compat.ts` bridges the two: at process start it copies any still-set `QA_FOO` to `SPIKE_FOO` unless `SPIKE_FOO` is already set (the new name always wins), and prints a one-time notice on **stderr** naming what to update. The bridge is generic — it covers vars added later without being touched.

Likewise, `fromFile()` reads `spike.config.json` first and falls back to `qa.config.json`.

Both are deprecation shims: delete `src/env-compat.ts` (plus its three side-effect imports in cli.ts / mcp-server.ts / config.ts) and the second entry of `CONFIG_FILENAMES` at 1.0. Set `SPIKE_SUPPRESS_LEGACY_ENV_WARNING=1` to silence the notice.

## spike.config.json Keys

spike.config.json keys mirror QaConfig camelCase fields:

via, bridgePort, bridgeHost, extensionDir, cdpPort, runnerPort, fixturePort, chromeProfile, googleCliBin, googleCliModel, geminiApiKey, googleCliEnv, artifactsDir, actionCache, actionCacheDir, maxSteps, perGoalMaxSteps, fixAgentBin, fixAgentArgs, fixAgentCwd, allowedHosts, recordClip, assertionPolicy, videoAssertions, readOnly, spendCapUsd, preferFreePlanner, planner, navigator, debugMode, debugAgent.

planner is the Brain selection: `{ "provider": "...", "mode": "...", "model": "..." }`. It leads the `plan-goals` ladder for initial planning and re-plans. navigator is the Navigator selection with the same shape. It leads the `plan-step` ladder for per-step actions.

## Transport and Ports

SPIKE_VIA - 'cdp' or 'extension'. Selects the browser transport. Default: 'cdp'.
Consumed by: engine.ts (openBrowserSession).

SPIKE_CDP_PORT - Integer. CDP port for the daemon's Chrome. Default: 9322.
Consumed by: src/ports/cdp-browser.ts, src/chrome/launch.ts.
AGENT NOTE: Must differ from spike Chrome ports (9223, 9224) to prevent collision when a spike Chrome is still running.

SPIKE_BRIDGE_PORT - Integer. WebSocket port for the daemon-to-extension bridge. Default: 9410.
Consumed by: src/bridge/bridge-server.ts.

SPIKE_BRIDGE_HOST - String (interface address). Interface the bridge WebSocket server binds to. Default: '127.0.0.1' (loopback-only). Added as A1 hardening — the server used to omit `host` entirely, which made `ws` default to binding ALL interfaces (0.0.0.0/::), reachable from the LAN.
Consumed by: src/bridge/bridge-server.ts (BridgeServer constructor's `host` param, `DEFAULT_BRIDGE_HOST` export), src/config.ts (fromEnv).
AGENT NOTE: The bridge also requires a pairing token as of 2026-07-18 (trust-on-first-use, persisted in the Vault under `bridge-pairing-token` — not env-configurable). See docs/state/server-state.md's Vault section.

SPIKE_RUNNER_PORT - Integer. Local HTTP port for the Gemini Nano runner page. Default: 9400.
Consumed by: src/ports/nano-runner-page.ts.

SPIKE_FIXTURE_PORT - Integer. Local HTTP port for the dogfood fixture app. Default: 9401.
Consumed by: fixture/server.ts (not in the daemon; only relevant when running `spike fixture`).

SPIKE_EXTENSION_DIR - String (directory path). Path to the unpacked extension directory. Default: <repo-root>/extension.
Consumed by: src/chrome/extensions.ts.

## Chrome Profile

SPIKE_CHROME_PROFILE - String (directory path). Chrome profile directory for the daemon. Default: %LOCALAPPDATA%\spike-chrome-profile (Windows) or $HOME/spike-chrome-profile.
Consumed by: src/chrome/launch.ts, src/ports/nano-runner-page.ts.
AGENT NOTE: Must be on a volume with 22 GB+ free for Gemini Nano. On a fresh Windows install, put it on C:, not a secondary drive. Deleting this directory reclaims the ~2 GB Nano model but resets the Chrome profile entirely.

## Model Credentials and Provider Knobs

GEMINI_API_KEY - String. BYOK Gemini API key (rung 2). Absent means rung 2 Gemini unavailable.
Consumed by: src/router/adapters/byok-gemini.ts.

ANTHROPIC_API_KEY - String. Anthropic API key (rung 2). Absent means rung 2 Anthropic unavailable. Vault key 'anthropic' takes precedence.
Consumed by: src/router/adapters/anthropic.ts.

OPENAI_API_KEY - String. OpenAI API key (rung 2). Absent means rung 2 OpenAI unavailable. Vault key 'openai' takes precedence.
Consumed by: src/router/adapters/openai-compatible.ts (label: 'gpt').

OPENAI_BASE_URL - String. Override the OpenAI-compatible endpoint for gpt:api. Default: https://api.openai.com/v1. Useful for Vercel AI Gateway, Cloudflare AI Gateway, or any gateway that exposes `/chat/completions`.
Consumed by: src/router/gateway.ts via engine.ts buildLadder.

OPENROUTER_API_KEY - String. OpenRouter API key (rung 2). Absent means rung 2 OpenRouter unavailable. Vault key 'openrouter' takes precedence.
Consumed by: src/router/adapters/openai-compatible.ts (label: 'openrouter').

OPENROUTER_BASE_URL - String. Override the OpenRouter-compatible endpoint. Default: https://openrouter.ai/api/v1.
Consumed by: src/router/gateway.ts via engine.ts buildLadder.

GLM_API_KEY - String. z.ai GLM API key (rung 2). Absent means rung 2 GLM unavailable. Vault key 'glm' takes precedence. ZAI_API_KEY is accepted as an alias.
Consumed by: src/router/adapters/openai-compatible.ts (label: 'glm') via engine.ts buildLadder.

GLM_BASE_URL - String. Override the z.ai endpoint. Default: https://api.z.ai/api/paas/v4. Use for the GLM Coding Plan endpoint or the mainland BigModel host (https://open.bigmodel.cn/api/paas/v4).
Consumed by: src/router/gateway.ts via engine.ts buildLadder.

GLM_THINKING - String. 'enabled' turns on GLM-5.2 reasoning (sharper plans, slower/costlier); any other value (default 'disabled') keeps the planner fast and cheap.
Consumed by: engine.ts buildLadder (passed as extraBody.thinking.type to the GLM adapter).

## Google CLI

SPIKE_GOOGLE_CLI_BIN - String. Name of the Google CLI binary on PATH. Default: 'gemini'.
Consumed by: src/router/adapters/google-cli.ts.
AGENT NOTE: After 2026-06-18, the Gemini free-tier CLI is replaced by the Antigravity CLI. Change this env var (or spike.config.json key googleCliBin) rather than modifying source code.

SPIKE_GOOGLE_CLI_MODEL - String. Model id passed to the Google CLI. Default: 'gemini-3-flash-preview'.
Consumed by: src/router/adapters/google-cli.ts.

NODE_OPTIONS - Injected into the Google CLI child process through cfg.googleCliEnv, not the daemon itself. Defaults to '--use-system-ca' so the CLI trusts the OS certificate store, which is what lets its OAuth calls succeed on machines behind a TLS-intercepting antivirus or corporate proxy (AVG, Zscaler, and similar TLS-MITM setups).
Consumed by: src/router/adapters/google-cli.ts.

SPIKE_NO_SYSTEM_CA - '1'/'true' to omit the '--use-system-ca' NODE_OPTIONS default above (A36, P1) — e.g. on a machine where trusting the OS certificate store is itself undesirable. Also honored by `spike daemon --install-service` (src/service/install-service.ts) and the install/*.sh|ps1|bat scripts, so the same opt-out applies to the auto-start service env and the one-line installer.
Consumed by: src/config.ts (defaultGoogleCliEnv), src/service/install-service.ts (serviceEnv), install/install.sh, install/install.ps1, install/install-linux.sh, install/install-mac.command, install/install-win.bat.

## Brain and Navigator Selection

SPIKE_PLANNER_PROVIDER - String. Pin the Brain provider for `plan-goals`: 'nano' | 'gemini' | 'claude' | 'gpt' | 'ollama' | 'openrouter' | 'glm'. Overrides SettingsStore.planner.provider. Daemon default: claude.
Consumed by: src/config.ts (fromEnv), engine.ts buildLadder, src/router/model-router.ts.

SPIKE_PLANNER_MODE - String. 'api' or 'cli'. Overrides SettingsStore.planner.mode. Daemon default: cli.
Consumed by: src/config.ts (fromEnv).

SPIKE_PLANNER_MODEL - String. Model id for the Brain. Overrides SettingsStore.planner.model. Empty/unset uses the provider/mode Brain default.
Consumed by: src/config.ts (fromEnv), engine.ts buildLadder.

SPIKE_NAVIGATOR_PROVIDER - String. Pin the Navigator provider for `plan-step`: 'nano' | 'gemini' | 'claude' | 'gpt' | 'ollama' | 'openrouter' | 'glm'. Overrides SettingsStore.navigator.provider. Default: nano.
Consumed by: src/config.ts (fromEnv), engine.ts buildLadder, src/router/model-router.ts.

SPIKE_NAVIGATOR_MODE - String. 'api', 'cli', or 'ondevice'. Overrides SettingsStore.navigator.mode. Default: ondevice. ondevice is intended for nano.
Consumed by: src/config.ts (fromEnv).

SPIKE_NAVIGATOR_MODEL - String. Model id for the Navigator. Overrides SettingsStore.navigator.model. Empty/unset uses the provider/mode Navigator default.
Consumed by: src/config.ts (fromEnv), engine.ts buildLadder.

SPIKE_PREFER_FREE_PLANNER - Boolean (truthy unless '0' or 'false'). For unpinned planning roles, keep rung-1 CLI before rung-2 BYOK even when a BYOK key is present. Default: false. Role-specific pins from planner/navigator take precedence over this ordering. Visual verdicts are unaffected (Nano always first).
Consumed by: src/router/model-router.ts.

## Driver Loop

SPIKE_MAX_STEPS - Integer. Global driver-loop step budget for a whole run, passed as cfg.maxSteps. Default: 40.
Consumed by: src/config.ts (fromEnv) -> engine.ts resolveStepBudgets -> src/driver/loop.ts.

SPIKE_PER_GOAL_MAX_STEPS - Integer. Steps ONE sub-goal may consume before the loop re-plans instead of grinding, passed as cfg.perGoalMaxSteps (config key: perGoalMaxSteps). Default: 12. Always clamped to the run budget, so the effective value is min(maxSteps, perGoalMaxSteps) - the same value the old hardcoded behaviour produced at the defaults.
Consumed by: src/config.ts (fromEnv) -> engine.ts resolveStepBudgets -> src/driver/loop.ts.

SPIKE_ALLOWED_HOSTS - Comma-separated strings. Hosts the driver may mutate (click/type). Default: 'localhost,127.0.0.1'.
Consumed by: src/driver/loop.ts.

SPIKE_RECORD_CLIP - Boolean. Enable GIF screencast recording. Default: false (0 or 'false' to disable).
Consumed by: engine.ts (startClipRecorder).

SPIKE_ASSERTION_POLICY - String. `single-ladder` (default), `fail-on-disagreement`, or `arbiter-on-disagreement`. Controls assert_visual and final pass confirmation. Strict modes use multiple visual-capable adapters when available and write assertion_trace in the full report.
Consumed by: src/config.ts, src/assertions/, src/driver/loop.ts.

SPIKE_VIDEO_ASSERTIONS - Boolean ('0'/'false' → off, any other value present → on). Default: false. When on, an `assert_visual { mode: 'video' }` step routes the recorded clip to a video-capable visual adapter (Gemini Files API) instead of judging the screenshot. Costly + slower — opt-in. With it off, video-mode asserts fall back to the screenshot verdict and note it. Also exposed as a panel toggle (non-secret, persisted in SettingsStore).
Consumed by: src/config.ts, src/driver/loop.ts, src/router/model-router.ts.

SPIKE_READ_ONLY - Boolean ('0'/'false' → off, any other value present → on). Default: true, BUT see the A1 relaxation below. Look-only mode, enforced at the driver's single mutation-guard site (`isMutatingAction` in src/driver/loop.ts) — while true, click/type/upload_file/drag_and_drop/blur/mouse/open_tab/switch_tab/close_tab/script are skipped (recorded as a FAILED step labeled 'skipped: look-only mode') even on an allowed host. A safety layer on top of, not a replacement for, the Tier-4 allowedHosts guard.

  A1 (P0) relaxation: `qaRun` resolves the effective value via `resolveReadOnly` (src/engine.ts). A caller that NAMES a target url — `spike run --url`, the `qa_run` tool — has already consented to drive it (the same reasoning as `trustTargetHost`), so the effective value is FALSE unless some config source set `readOnly` explicitly (`readOnlyWasConfigured` in src/config.ts checks the per-run override, this env var, and spike.config.json — deliberately NOT the SettingsStore, whose copy the old panel wrote on every Save and which is therefore nobody's explicit instruction to the CLI). `spike run --read-only` / `qa_run { readOnly: true }` force look-only mode on; the extension panel passes `trustTargetHost:false` and an explicit per-run value, so the relaxation never applies there.

  `spike replay --read-only` refuses a saved test that clicks or types (an `uncertain` verdict explaining why) rather than half-running it; replay reads ONLY that explicit flag, never the config value, so an existing `readOnly:true` setting cannot silently break saved tests.

  Panel: the per-site "Allow the agent to click & type on this site" checkbox above the Run button IS this switch (unchecked = look-only for that run). The stored `readOnly` key survives in SettingsStore for env/config parity only — it no longer has its own Settings control.
Consumed by: src/config.ts, src/driver/loop.ts.

SPIKE_SPEND_CAP_USD - Number (positive USD figure). Optional per-run spend cap. Default: unset (no cap). 0 or a non-finite value is ignored (leaves the cap unset). When set, the driver aborts the run once its best-available spend proxy (paid model-call token total, priced via SPEND_PROXY_USD_PER_MILLION_TOKENS — precise USD isn't derivable without a per-adapter pricing table) reaches this figure, ending with verdict 'uncertain'. Also exposed as a panel setting (non-secret, persisted in SettingsStore as `spendCapUsd`).
Consumed by: src/config.ts, src/driver/loop.ts.

## Artifact Output

SPIKE_ARTIFACTS_DIR - String (directory path). Where run artifacts are written. Default: ./artifacts.
Consumed by: src/report/artifacts.ts.

SPIKE_ACTION_CACHE - Boolean. Enable the verified file-backed action cache. Default: false. CLI `--action-cache` and `--no-action-cache` override this for one run.
Consumed by: src/config.ts, engine.ts, src/driver/loop.ts.

SPIKE_ACTION_CACHE_DIR - String (directory path). Where verified action-cache records are written. Default: ./.spike-action-cache.
Consumed by: src/cache/action-cache.ts via engine.ts.

## Telemetry & Dashboard

SPIKE_TELEMETRY_EXPORTER - String. `none` (default) or `otlp`. Spans are ALWAYS constructed (redacted) around adapter calls, the driver loop, and replay; `none` sends them to a no-op sink (zero external calls, zero behavior change), `otlp` ships them to an OTLP/HTTP endpoint.
Consumed by: src/telemetry/env.ts.

SPIKE_OTLP_ENDPOINT - String (URL). OTLP/HTTP traces endpoint (Grafana Tempo/Alloy, Axiom, etc.). Required when SPIKE_TELEMETRY_EXPORTER=otlp.
Consumed by: src/telemetry/otlp-exporter.ts.

SPIKE_OTLP_HEADERS - String (JSON object). Extra POST headers for the OTLP exporter (auth token, dataset name). Optional.
Consumed by: src/telemetry/otlp-exporter.ts.

SPIKE_OTLP_SERVICE_NAME - String. resource `service.name` on exported spans. Default: spike-agent.
Consumed by: src/telemetry/otlp-exporter.ts.

SPIKE_DASHBOARD_PORT - Integer. Port for the read-only `spike dashboard` local viewer of artifacts/<runId> reports. Default: 9420.
Consumed by: src/cli.ts (dashboard command).

## Auto-Fix

SPIKE_DEBUG_MODE - 'prompt' or 'auto'. Paste-a-prompt vs automated fix. Default: 'prompt'.
Consumed by: src/config.ts; VibeService uses it to decide whether to call the fix agent.

SPIKE_DEBUG_AGENT - 'auto' | 'claude' | 'codex' | 'gemini'. Which CLI agent runs the automated fix. Default: 'auto' (detects on PATH).
Consumed by: src/vibe/auto-fix.ts.

SPIKE_FIX_AGENT_BIN - String. Fix agent CLI binary path. Unset means auto-detect claude/codex.
SPIKE_FIX_AGENT_ARGS - JSON array string. Args for the fix agent, with '{prompt}' as a substitution token.
SPIKE_FIX_AGENT_CWD - String (directory). Working directory for the fix agent. Default: cwd.
Consumed by: src/vibe/auto-fix.ts.

## Update Triggers

- When src/config.ts adds, removes, or renames a config field.
- When fromEnv() adds new env var names.
- When Brain/Navigator selection fields or defaults change.
- When a new adapter is added and introduces new credential env vars.
- When port defaults change.

## Related Docs

- docs/modules/model-ladder.md - how adapters use API keys
- docs/modules/vibe-mode.md - how SettingsStore interacts with config
- docs/api/external-services.md - per-service credential and fallback detail
