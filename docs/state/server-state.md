# State: Server State

> Scope: All persistent state — SettingsStore, Vault (API keys), ArtifactStore (run output).
> Rendering context: Server-side (Node.js daemon)
> Project tier: 3
> Last updated: 2026-07-18

## Overview

The daemon has four established persistence points: SettingsStore (user preferences), Vault (API keys, encrypted), ArtifactStore (per-run output), and the optional FileActionCache (verified action reuse). There is no database. All daemon state is file-based. The extension may keep panel UI history outside the daemon; authoritative run output is still ArtifactStore.

AGENT OWNER: src/vibe/settings.ts, src/vault/vault.ts, src/report/artifacts.ts

## SettingsStore (src/vibe/settings.ts)

Stores: QaSettings — planner (Brain PlannerSelection: provider, mode, model), navigator (Navigator PlannerSelection: provider, mode, model), debugMode ('prompt' | 'auto'), debugAgent ('auto' | 'claude' | 'codex' | 'gemini'), videoAssertions (boolean, opt-in `assert_visual { mode: 'video' }` routing; default false), readOnly (boolean, A5b P1 safety dry-run default; default true), spendCapUsd (number, A5a P1 safety optional per-run USD cap; default unset/no cap).

readOnly and spendCapUsd (src/vibe/settings-data.ts) were added 2026-07-14 as part of the non-technical-onboarding safety work: readOnly gates every mutating action (click/type/upload_file/drag_and_drop/blur/mouse/open_tab/switch_tab/close_tab/script) behind an explicit opt-out in src/driver/loop.ts's `isMutatingAction` guard — layered on top of, not replacing, the Tier-4 allowedHosts guard; spendCapUsd aborts a run once the driver's best-effort paid-token spend proxy reaches the cap. Both mirror a same-named QaConfig field and QA_READ_ONLY / QA_SPEND_CAP_USD env var (env still wins) — see docs/infra/environment.md.

File location: %LOCALAPPDATA%\qa-subagent\settings.json (Windows) or $HOME/qa-subagent/settings.json (other platforms).

Read by: loadConfig() (src/config.ts) folds it in below env vars. The SettingsStore layer sits between qa.config.json and env vars in the precedence chain (low to high: defaults < qa.config.json < SettingsStore < env < explicit overrides).

Written by: `qa config set` CLI command and the vibe.config.set bridge message from the extension side panel. write() merges a partial patch (planner and navigator are merged as nested objects, not replaced wholesale).

AGENT NOTE: `readRaw()` (the un-defaulted read config.ts's fromSettings() relies on) also runs a one-time config-drift migration: a persisted `planner` pinned to the dead Gemini CLI free tier (`gemini:cli`) is rewritten to `{ provider: 'claude', mode: 'cli' }`, and a persisted settings.json with no `navigator` key at all (pre planner/navigator split) is rewritten to `DEFAULT_SETTINGS.navigator` (`nano`/`ondevice`). The migrated value is written back to disk once (best-effort — a write failure still returns the migrated value in memory). See `isDeadPlannerSelection()` in src/vibe/settings-data.ts and the "Navigator/brain pins" gotcha in CLAUDE.md.

AGENT NOTE (2026-07-18): `SettingsStore.readRaw()` now caches the last-read value keyed by the file's mtime, so an unchanged settings.json (the common case) skips the sync readFileSync/JSON.parse and the migration check entirely. The cache is invalidated the instant the on-disk mtime moves, including from the migration rewrite above and from `write()` — both re-stat the file and refresh the cache with the new mtime. Purely a perf detail; it does not change what callers observe.

AGENT NOTE: API keys are never stored in SettingsStore. A user who accidentally puts a key in SettingsStore will have it readable as plain JSON. Keys belong in the Vault only.

AGENT NOTE: Runtime-generated data is never stored in SettingsStore. Reports, screenshots, audit logs, and replay clips belong in ArtifactStore; generated replay scripts belong in generated-tests/; fix prompts are derived from Reports and may exist only in daemon memory or CLI output.

## Vault (src/vault/vault.ts)

Stores: API keys for external model services (keys: 'gemini', 'anthropic', 'openai', 'openrouter', 'glm', plus arbitrary named secrets like {{secret:MY_PASSWORD}}), plus one non-model secret: `bridge-pairing-token` (src/bridge/bridge-server.ts's `PAIRING_TOKEN_VAULT_KEY`) — the daemon↔extension WebSocket bridge's pairing token (A2 hardening, added 2026-07-18). Trust-on-first-use: the first token any client presents in its `hello` frame is adopted as THE pairing token and persisted here via `Vault.set()`; every later connection must present a matching token or the socket is closed (code 1008) before adoption. Read via plain `Vault.get()`/`Vault.set()` — same encrypted store as API keys, not a separate mechanism.

File location: %LOCALAPPDATA%\qa-subagent\vault.bin (Windows DPAPI encrypted) or a plaintext fallback on non-Windows platforms (noted in the file header).

Provider: src/vault/dpapi-key-provider.ts uses Windows DPAPI (CryptProtectData / CryptUnprotectData) to encrypt at rest, bound to the current Windows user account.

Written by: `qa secret set <name> <value>` CLI command; also written internally by BridgeServer on first pairing (see above).
Read by: engine.ts (buildLadder reads keys for each adapter), the driver loop (resolveSecrets reads named secrets for {{secret:NAME}} substitution in type actions), and BridgeServer (reads/writes the pairing token on construction/first-connect).

AGENT NOTE: Vault reads happen at every qaRun() call, not just at daemon startup. This means a key added via `qa secret set` is available immediately to the next run without restarting the daemon.

AGENT NOTE: On non-Windows platforms, DPAPI is unavailable. The Vault falls back to a plaintext file. Do not store sensitive production credentials without understanding this limitation.

AGENT NOTE (2026-07-18): On Windows, both `key.bin`/`key.dpapi` and `secrets.enc` now also get an explicit ACL lockdown after write (`lockdownWindowsAcl()` in vault.ts, via `icacls <path> /inheritance:r /grant:r <user>:F`) — `{ mode: 0o600 }` has no effect on Windows (NTFS ignores POSIX mode bits; protection there previously came only from inherited folder ACLs). This is best-effort defense-in-depth on top of DPAPI/inherited ACLs, not a change to the encryption path; a failure to run `icacls` is swallowed silently and does not affect the vault's actual security guarantee. No-op on POSIX (the `0o600` mode bits already do the job there).

## ArtifactStore (src/report/artifacts.ts)

Stores: per-run output under cfg.artifactsDir (default: ./artifacts/).

Layout for each run:
- artifacts/<runId>/report.json — the full Report object (written once at run end, rewritten with final token counts and clip path).
- artifacts/<runId>/screenshots/step-NN.png — one PNG per step that took a screenshot.
- artifacts/<runId>/audit.jsonl — append-only newline-delimited JSON; one line per executed action (ts, runId, action type, redacted target, url, ok). Secrets never appear here.
- artifacts/<runId>/replay.gif|webm|mp4 — optional full-run or per-step replay clip (transport- and recorder-dependent).

runId: generated once per ArtifactStore instantiation (at the start of qaRun or qaReplay). A UUID-like string prefixed with 'r-'.

saveReport(report) — serializes the Report to report.json. Called twice per run: once at loop end (without clip path) and once after the clip is saved (with the clip path appended to evidence_paths).

saveScreenshot(stepIndex, pngBuffer) — writes the PNG and returns the relative path.

appendAudit(entry) — appends a single audit entry to audit.jsonl.

AGENT NOTE: artifacts/ and generated-tests/ are both git-ignored. Do not rely on them being present in the repo. They are runtime outputs only.

## Action Cache (src/cache/action-cache.ts)

Stores: optional verified single-action records under cfg.actionCacheDir, laid out as `v1/<hash-prefix>/<hash>.json`. It is enabled only when cfg.actionCache is true, QA_ACTION_CACHE is set, or `qa run --action-cache` is passed.

Each record contains a normalized URL/goal/action/page-signature key and a redacted action value. Targeted values store role/name/nth/qaId locators, never snapshot nodeIds. Screenshots and reports are not stored in this cache.

AGENT NOTE: The action cache may store `{{secret:NAME}}` placeholders but must never store resolved secret values or raw API-key/token-looking strings. It is separate from SettingsStore and Vault.

## Generated Test Scripts (src/recorder/script.ts)

Location: generated-tests/<slug>.json and generated-tests/<slug>.spec.ts.

These are recorded QaScripts emitted after a passing run. They are runtime/generated data, not SettingsStore state. They are also git-ignored by default. In a CI environment, the directory should be committed or restored from a cache so `qa replay --all` has scripts to run.

## Extension Panel UI State

The extension panel may keep lightweight UI history in browser storage, but it is not daemon SettingsStore state. Reports, clips, and fix prompts remain derived runtime outputs owned by ArtifactStore or the active daemon process.

## Runtime Data

src/run-data/ defines RunDataState for non-secret values generated during one QA run: `{{run.email}}`, `{{run.shortid}}`, `{{run.name}}`, `{{run.phone}}`, plus extracted values such as `{{run.orderId}}`. runDriverLoop and replayScript create fresh in-memory RunDataState instances, resolve placeholders immediately before type actions, and preserve placeholder-bearing actions in reports/scripts. This is not SettingsStore state and is not Vault state.

src/email/ defines EmailProvider and FakeLocalEmailProvider for local signup/OTP tests. Email messages used by the fake provider are test/runtime data only; real provider credentials, if added later, must go through Vault.

## Update Triggers

- When SettingsStore gains or loses fields (QaSettings shape changes).
- When Vault adds new key names (e.g., a new service is added to the ladder).
- When the ArtifactStore directory layout changes (new file types per runId).
- When the audit.jsonl schema changes (new fields in the audit entry).
- When action-cache layout, keying, or redaction guarantees change.
- When RuntimeDataState persistence, placeholder semantics, or email-provider credential handling changes.

## Related Docs

- docs/modules/vibe-mode.md — SettingsStore is written by the side panel via vibe.config.set
- docs/modules/engine.md — Vault and ArtifactStore are instantiated in qaRun
- docs/modules/action-cache.md — action-cache keying, values, and integration notes
- docs/infra/environment.md — QA_ARTIFACTS_DIR and other path overrides
