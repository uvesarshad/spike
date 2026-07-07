# Infrastructure: Environment Variables and Config

> Scope: Every environment variable and qa.config.json key; purpose, default, and which module consumes each.
> Rendering context: Server-side (Node.js daemon / CLI)
> Project tier: 3
> Last updated: 2026-07-07

## Overview

Config resolution order (low to high): built-in defaults -> qa.config.json -> SettingsStore (user prefs) -> environment variables -> explicit CLI/API overrides. Environment variables win over the file for automation and CI. Env vars are read in src/config.ts via fromEnv(); provider API env vars are also consumed by adapter/engine setup.

AGENT OWNER: src/config.ts

## qa.config.json Keys

qa.config.json keys mirror QaConfig camelCase fields:

via, bridgePort, extensionDir, cdpPort, runnerPort, fixturePort, chromeProfile, googleCliBin, googleCliModel, geminiApiKey, googleCliEnv, artifactsDir, maxSteps, fixAgentBin, fixAgentArgs, fixAgentCwd, allowedHosts, recordClip, preferFreePlanner, planner, navigator, debugMode, debugAgent.

planner is the Brain selection: `{ "provider": "...", "mode": "...", "model": "..." }`. It leads the `plan-goals` ladder for initial planning and re-plans. navigator is the Navigator selection with the same shape. It leads the `plan-step` ladder for per-step actions.

## Transport and Ports

QA_VIA - 'cdp' or 'extension'. Selects the browser transport. Default: 'cdp'.
Consumed by: engine.ts (openBrowserSession).

QA_CDP_PORT - Integer. CDP port for the daemon's Chrome. Default: 9322.
Consumed by: src/ports/cdp-browser.ts, src/chrome/launch.ts.
AGENT NOTE: Must differ from spike Chrome ports (9223, 9224) to prevent collision when a spike Chrome is still running.

QA_BRIDGE_PORT - Integer. WebSocket port for the daemon-to-extension bridge. Default: 9410.
Consumed by: src/bridge/bridge-server.ts.

QA_RUNNER_PORT - Integer. Local HTTP port for the Gemini Nano runner page. Default: 9400.
Consumed by: src/ports/nano-runner-page.ts.

QA_FIXTURE_PORT - Integer. Local HTTP port for the dogfood fixture app. Default: 9401.
Consumed by: fixture/server.ts (not in the daemon; only relevant when running `qa fixture`).

QA_EXTENSION_DIR - String (directory path). Path to the unpacked extension directory. Default: <repo-root>/extension.
Consumed by: src/chrome/extensions.ts.

## Chrome Profile

QA_CHROME_PROFILE - String (directory path). Chrome profile directory for the daemon. Default: %LOCALAPPDATA%\qa-subagent-chrome-profile (Windows) or $HOME/qa-subagent-chrome-profile.
Consumed by: src/chrome/launch.ts, src/ports/nano-runner-page.ts.
AGENT NOTE: Must be on a volume with 22 GB+ free for Gemini Nano. On a fresh Windows install, put it on C:, not a secondary drive. Deleting this directory reclaims the ~2 GB Nano model but resets the Chrome profile entirely.

## Model Credentials and Provider Knobs

GEMINI_API_KEY - String. BYOK Gemini API key (rung 2). Absent means rung 2 Gemini unavailable.
Consumed by: src/router/adapters/byok-gemini.ts.

ANTHROPIC_API_KEY - String. Anthropic API key (rung 2). Absent means rung 2 Anthropic unavailable. Vault key 'anthropic' takes precedence.
Consumed by: src/router/adapters/anthropic.ts.

OPENAI_API_KEY - String. OpenAI API key (rung 2). Absent means rung 2 OpenAI unavailable. Vault key 'openai' takes precedence.
Consumed by: src/router/adapters/openai-compatible.ts (label: 'gpt').

OPENROUTER_API_KEY - String. OpenRouter API key (rung 2). Absent means rung 2 OpenRouter unavailable. Vault key 'openrouter' takes precedence.
Consumed by: src/router/adapters/openai-compatible.ts (label: 'openrouter').

GLM_API_KEY - String. z.ai GLM API key (rung 2). Absent means rung 2 GLM unavailable. Vault key 'glm' takes precedence. ZAI_API_KEY is accepted as an alias.
Consumed by: src/router/adapters/openai-compatible.ts (label: 'glm') via engine.ts buildLadder.

GLM_BASE_URL - String. Override the z.ai endpoint. Default: https://api.z.ai/api/paas/v4. Use for the GLM Coding Plan endpoint or the mainland BigModel host (https://open.bigmodel.cn/api/paas/v4).
Consumed by: engine.ts buildLadder.

GLM_THINKING - String. 'enabled' turns on GLM-5.2 reasoning (sharper plans, slower/costlier); any other value (default 'disabled') keeps the planner fast and cheap.
Consumed by: engine.ts buildLadder (passed as extraBody.thinking.type to the GLM adapter).

## Google CLI

QA_GOOGLE_CLI_BIN - String. Name of the Google CLI binary on PATH. Default: 'gemini'.
Consumed by: src/router/adapters/google-cli.ts.
AGENT NOTE: After 2026-06-18, the Gemini free-tier CLI is replaced by the Antigravity CLI. Change this env var (or qa.config.json key googleCliBin) rather than modifying source code.

QA_GOOGLE_CLI_MODEL - String. Model id passed to the Google CLI. Default: 'gemini-3-flash-preview'.
Consumed by: src/router/adapters/google-cli.ts.

NODE_OPTIONS - Injected into the Google CLI child process through cfg.googleCliEnv, not the daemon itself. Set to '--use-system-ca' on machines with AVG or Zscaler TLS interception to allow the CLI's OAuth calls to succeed.
Consumed by: src/router/adapters/google-cli.ts.

## Brain and Navigator Selection

QA_PLANNER_PROVIDER - String. Pin the Brain provider for `plan-goals`: 'nano' | 'gemini' | 'claude' | 'gpt' | 'ollama' | 'openrouter' | 'glm'. Overrides SettingsStore.planner.provider. Daemon default: claude.
Consumed by: src/config.ts (fromEnv), engine.ts buildLadder, src/router/model-router.ts.

QA_PLANNER_MODE - String. 'api' or 'cli'. Overrides SettingsStore.planner.mode. Daemon default: cli.
Consumed by: src/config.ts (fromEnv).

QA_PLANNER_MODEL - String. Model id for the Brain. Overrides SettingsStore.planner.model. Empty/unset uses the provider/mode Brain default.
Consumed by: src/config.ts (fromEnv), engine.ts buildLadder.

QA_NAVIGATOR_PROVIDER - String. Pin the Navigator provider for `plan-step`: 'nano' | 'gemini' | 'claude' | 'gpt' | 'ollama' | 'openrouter' | 'glm'. Overrides SettingsStore.navigator.provider. Default: nano.
Consumed by: src/config.ts (fromEnv), engine.ts buildLadder, src/router/model-router.ts.

QA_NAVIGATOR_MODE - String. 'api', 'cli', or 'ondevice'. Overrides SettingsStore.navigator.mode. Default: ondevice. ondevice is intended for nano.
Consumed by: src/config.ts (fromEnv).

QA_NAVIGATOR_MODEL - String. Model id for the Navigator. Overrides SettingsStore.navigator.model. Empty/unset uses the provider/mode Navigator default.
Consumed by: src/config.ts (fromEnv), engine.ts buildLadder.

QA_PREFER_FREE_PLANNER - Boolean (truthy unless '0' or 'false'). For unpinned planning roles, keep rung-1 CLI before rung-2 BYOK even when a BYOK key is present. Default: false. Role-specific pins from planner/navigator take precedence over this ordering. Visual verdicts are unaffected (Nano always first).
Consumed by: src/router/model-router.ts.

## Driver Loop

QA_MAX_STEPS - Integer. Global driver-loop step budget passed as cfg.maxSteps. Default: 12.
Consumed by: src/driver/loop.ts.

QA_ALLOWED_HOSTS - Comma-separated strings. Hosts the driver may mutate (click/type). Default: 'localhost,127.0.0.1'.
Consumed by: src/driver/loop.ts.

QA_RECORD_CLIP - Boolean. Enable GIF screencast recording. Default: false (0 or 'false' to disable).
Consumed by: engine.ts (startClipRecorder).

## Artifact Output

QA_ARTIFACTS_DIR - String (directory path). Where run artifacts are written. Default: ./artifacts.
Consumed by: src/report/artifacts.ts.

## Auto-Fix

QA_DEBUG_MODE - 'prompt' or 'auto'. Paste-a-prompt vs automated fix. Default: 'prompt'.
Consumed by: src/config.ts; VibeService uses it to decide whether to call the fix agent.

QA_DEBUG_AGENT - 'auto' | 'claude' | 'codex' | 'gemini'. Which CLI agent runs the automated fix. Default: 'auto' (detects on PATH).
Consumed by: src/vibe/auto-fix.ts.

QA_FIX_AGENT_BIN - String. Fix agent CLI binary path. Unset means auto-detect claude/codex.
QA_FIX_AGENT_ARGS - JSON array string. Args for the fix agent, with '{prompt}' as a substitution token.
QA_FIX_AGENT_CWD - String (directory). Working directory for the fix agent. Default: cwd.
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
