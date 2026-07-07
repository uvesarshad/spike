# State: Server State

> Scope: All persistent state — SettingsStore, Vault (API keys), ArtifactStore (run output).
> Rendering context: Server-side (Node.js daemon)
> Project tier: 3
> Last updated: 2026-07-07

## Overview

The daemon has three persistence points: SettingsStore (user preferences), Vault (API keys, encrypted), and ArtifactStore (per-run output). There is no database. All daemon state is file-based. The extension may keep panel UI history outside the daemon; authoritative run output is still ArtifactStore.

AGENT OWNER: src/vibe/settings.ts, src/vault/vault.ts, src/report/artifacts.ts

## SettingsStore (src/vibe/settings.ts)

Stores: QaSettings — planner (Brain PlannerSelection: provider, mode, model), navigator (Navigator PlannerSelection: provider, mode, model), debugMode ('prompt' | 'auto'), debugAgent ('auto' | 'claude' | 'codex' | 'gemini').

File location: %LOCALAPPDATA%\qa-subagent\settings.json (Windows) or $HOME/qa-subagent/settings.json (other platforms).

Read by: loadConfig() (src/config.ts) folds it in below env vars. The SettingsStore layer sits between qa.config.json and env vars in the precedence chain (low to high: defaults < qa.config.json < SettingsStore < env < explicit overrides).

Written by: `qa config set` CLI command and the vibe.config.set bridge message from the extension side panel. write() merges a partial patch (planner and navigator are merged as nested objects, not replaced wholesale).

AGENT NOTE: API keys are never stored in SettingsStore. A user who accidentally puts a key in SettingsStore will have it readable as plain JSON. Keys belong in the Vault only.

AGENT NOTE: Runtime-generated data is never stored in SettingsStore. Reports, screenshots, audit logs, and replay clips belong in ArtifactStore; generated replay scripts belong in generated-tests/; fix prompts are derived from Reports and may exist only in daemon memory or CLI output.

## Vault (src/vault/vault.ts)

Stores: API keys for external model services (keys: 'gemini', 'anthropic', 'openai', 'openrouter', 'glm', plus arbitrary named secrets like {{secret:MY_PASSWORD}}).

File location: %LOCALAPPDATA%\qa-subagent\vault.bin (Windows DPAPI encrypted) or a plaintext fallback on non-Windows platforms (noted in the file header).

Provider: src/vault/dpapi-key-provider.ts uses Windows DPAPI (CryptProtectData / CryptUnprotectData) to encrypt at rest, bound to the current Windows user account.

Written by: `qa secret set <name> <value>` CLI command.
Read by: engine.ts (buildLadder reads keys for each adapter) and the driver loop (resolveSecrets reads named secrets for {{secret:NAME}} substitution in type actions).

AGENT NOTE: Vault reads happen at every qaRun() call, not just at daemon startup. This means a key added via `qa secret set` is available immediately to the next run without restarting the daemon.

AGENT NOTE: On non-Windows platforms, DPAPI is unavailable. The Vault falls back to a plaintext file. Do not store sensitive production credentials without understanding this limitation.

## ArtifactStore (src/report/artifacts.ts)

Stores: per-run output under cfg.artifactsDir (default: ./artifacts/).

Layout for each run:
- artifacts/<runId>/report.json — the full Report object (written once at run end, rewritten with final token counts and clip path).
- artifacts/<runId>/screenshots/step-NN.png — one PNG per step that took a screenshot.
- artifacts/<runId>/audit.jsonl — append-only newline-delimited JSON; one line per executed action (ts, runId, action type, redacted target, url, ok). Secrets never appear here.
- artifacts/<runId>/replay.gif|webm|mp4 — optional replay clip (transport- and recorder-dependent).

runId: generated once per ArtifactStore instantiation (at the start of qaRun or qaReplay). A UUID-like string prefixed with 'r-'.

saveReport(report) — serializes the Report to report.json. Called twice per run: once at loop end (without clip path) and once after the clip is saved (with the clip path appended to evidence_paths).

saveScreenshot(stepIndex, pngBuffer) — writes the PNG and returns the relative path.

appendAudit(entry) — appends a single audit entry to audit.jsonl.

AGENT NOTE: artifacts/ and generated-tests/ are both git-ignored. Do not rely on them being present in the repo. They are runtime outputs only.

## Generated Test Scripts (src/recorder/script.ts)

Location: generated-tests/<slug>.json and generated-tests/<slug>.spec.ts.

These are recorded QaScripts emitted after a passing run. They are runtime/generated data, not SettingsStore state. They are also git-ignored by default. In a CI environment, the directory should be committed or restored from a cache so `qa replay --all` has scripts to run.

## Extension Panel UI State

The extension panel may keep lightweight UI history in browser storage, but it is not daemon SettingsStore state. Reports, clips, and fix prompts remain derived runtime outputs owned by ArtifactStore or the active daemon process.

## Update Triggers

- When SettingsStore gains or loses fields (QaSettings shape changes).
- When Vault adds new key names (e.g., a new service is added to the ladder).
- When the ArtifactStore directory layout changes (new file types per runId).
- When the audit.jsonl schema changes (new fields in the audit entry).

## Related Docs

- docs/modules/vibe-mode.md — SettingsStore is written by the side panel via vibe.config.set
- docs/modules/engine.md — Vault and ArtifactStore are instantiated in qaRun
- docs/infra/environment.md — QA_ARTIFACTS_DIR and other path overrides
