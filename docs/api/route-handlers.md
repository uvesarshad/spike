# API: Route Handlers — CLI Commands and MCP Tool

> Scope: Every CLI subcommand and the MCP stdio tool that callers use to trigger QA runs.
> Rendering context: Server-side (Node.js daemon / CLI)
> Project tier: 3
> Last updated: 2026-07-18

## Overview

The project exposes two call surfaces: a CLI binary (dist/cli.js, bin alias 'qa') and an MCP stdio server (dist/mcp-server.js). Both call the same underlying qaRun() engine function. The CLI is for human use and CI pipelines; the MCP server is for coding agents (Claude Code, Cursor, Copilot) that register it as a tool provider.

AGENT OWNER: src/cli.ts, src/mcp-server.ts

## MCP Tool: qa_run

Registered by src/mcp-server.ts via @modelcontextprotocol/sdk. The MCP server is started as a stdio transport (reads from stdin, writes to stdout) and is registered in the coding agent's tool config as command 'spike', args ['mcp'].

Tool name: qa_run
Input schema:
- task (string, required) — plain-English description of the browser task or QA check.
- url (string, required, must be a valid URL) — the starting URL for the run.
- maxSteps (number, optional, 1-30) — step budget override; defaults to cfg.maxSteps (12).

AGENT NOTE: unlike `spike run` on the CLI, the MCP tool's input schema has no `via` or `record` flag — every qa_run call goes through qaRun(task, url, { maxSteps }) with the daemon's configured transport (cfg.via) and default recording behavior. To drive transport/record/allow-host for a given call, use the CLI instead.

Response: the slim Report object — verdict, failing_step, console_error, evidence_paths, reason, plus an optional spendSummary (present only when a spend cap is configured). Approximately 2K tokens. Returned as `content: [{ type: 'text', text: <JSON> }]`; `isError` is left `false`/`undefined` even on a failing verdict — a failing TEST is still a successful TOOL call, only a thrown exception surfaces as an MCP error.

AGENT NOTE: The MCP server suppresses all progress lines (onProgress is a no-op). The calling agent sees only the final verdict object. This is intentional — the slim contract is exactly what the calling agent needs to understand what happened.

## CLI: spike run

node dist/cli.js run "<task>" --url <url> [--max-steps <n>] [--via cdp|extension] [--allow-host <host>] [--action-cache|--no-action-cache] [--no-record] [--no-replay] [--fix] [--max-fix-attempts <n>] [--json]

Runs a QA session; exits 0 pass / 1 fail / 2 uncertain. Streams progress lines to stdout during the run (suppressed when --json is passed). On completion, prints the slim verdict as JSON.

- `--max-steps <n>` — override the driver step budget (default cfg.maxSteps, 12).
- `--via cdp|extension` — transport override; defaults to cfg.via.
- `--allow-host <host>` — repeatable; permits click/type on an EXTRA host beyond the URL's own. The `--url` host (and its www./bare-domain sibling) is trusted automatically for the run — see CLAUDE.md's Tier-4 guard note.
- `--action-cache` / `--no-action-cache` — force the verified file-backed action cache on/off for this run, overriding config/env.
- `--no-record` — skip recording a replay script to generated-tests/ on pass.
- `--no-replay` — skip the pre-run replay matcher, forcing a fresh AI pass even if a recorded script confidently matches this task+url.
- `--fix` — on failure, hand the fix prompt to the configured coding agent (claude/codex/gemini) and re-test (test→fix→retest loop via runWithAutoFix).
- `--max-fix-attempts <n>` — number of test→fix→retest rounds with --fix (default 2).
- `--json` — print the slim JSON verdict only (implies no progress lines).

## CLI: spike replay

node dist/cli.js replay [name|path] [--all] [--heal] [--via cdp|extension] [--allow-host <host>] [--json]

Replays a recorded QaScript at $0 (no planner, Nano-only visuals); exits 0 pass / 1 fail / 2 uncertain. name matches generated-tests/<name>.json. --all replays every script in generated-tests/ (the regression suite). --heal re-engages the driver on the original task if the replay fails and re-emits the script. --allow-host is repeatable and works like `spike run`'s (the recorded script's own url host is trusted automatically). With --all --json, the CLI prints one JSON array of replay results for CI consumers; otherwise each result prints individually as it completes.

## CLI: spike daemon

node dist/cli.js daemon [--bridge-port <n>]
node dist/cli.js daemon --install-service
node dist/cli.js daemon --uninstall-service

Plain `spike daemon` starts the vibe-mode daemon: opens BridgeServer on `--bridge-port` (default cfg.bridgePort, 9410), starts VibeService, and keeps the process alive. The extension's service worker connects to this bridge. The daemon does not launch Chrome.

`--install-service` / `--uninstall-service` are one-shot: they register (or remove) an OS-native auto-start entry for `spike daemon` and then exit immediately — they do not run the daemon inline. This is the mechanism behind the install scripts' "no terminal after setup" UX; see docs/infra/deployment.md for the per-OS detail (Windows Scheduled Task / macOS LaunchAgent / Linux systemd --user). `--install-service` also starts the daemon immediately after registering it, so the extension's connection dot doesn't wait for the next login.

## CLI: spike fix

node dist/cli.js fix <runIdOrPath> [--apply]

Prints the paste-ready fix prompt for a past run. `<runIdOrPath>` may be a runId under artifacts/, a path to a report.json, or a path to an artifacts/<runId> directory — the command tries all three forms. The prompt is synthesized by buildFixPrompt(report); if the run passed, it prints a "no fix prompt needed" message instead. With `--apply`, the prompt is dispatched headlessly to the configured coding agent (claude/codex/gemini, auto-detected) via dispatchFix() instead of just being printed — exits 0 on success, 1 on failure.

## CLI: spike mcp

node dist/cli.js mcp

Starts the MCP stdio server inline (same as running dist/mcp-server.js directly). Used when registering the tool in a coding agent config via a command invocation rather than the prebuilt binary.

## CLI: spike nano

node dist/cli.js nano --check
node dist/cli.js nano --download

--check queries Gemini Nano availability in the daemon's Chrome profile and prints the status (available / downloading / downloadable / unavailable). 'unavailable' usually means the Chrome profile volume has less than 22 GB free.

--download triggers the ~2 GB on-device model download. The Chrome instance (on cfg.chromeProfile) must already be running, or is launched by the command.

## CLI: spike fixture

node dist/cli.js fixture --bug on|off [--port <n>]

Starts the dogfood fixture app (fixture/server.ts) on `--port` (default cfg.fixturePort, 9401). --bug on enables the intentional bugs (order.total undefined, /api/order 500). --bug off (the default) runs the healthy version. Primarily used for e2e tests and manual verification.

## CLI: spike secret

node dist/cli.js secret set <name> <value>
node dist/cli.js secret get <name> [--reveal]
node dist/cli.js secret list
node dist/cli.js secret delete <name>

`set` encrypts a secret with Windows DPAPI and stores it in the Vault. `get` confirms a secret exists without printing it, unless `--reveal` is passed. `list` prints all stored secret names. `delete` removes one. Secrets are referenced in QA tasks as {{secret:NAME}} placeholders; the driver resolves them at execute time without logging the value.

## CLI: spike config

node dist/cli.js config show
node dist/cli.js config set [--provider <p>] [--mode <m>] [--model <m>] [--debug-mode <d>] [--debug-agent <a>]

Reads or writes SettingsStore settings — this is the **planner** ("browsing-control AI") selection plus debugging settings; it does not cover the separate navigator pin (set via the extension panel or QA_NAVIGATOR_* env). `show` prints the current planner provider/mode/model, debugMode, debugAgent, and which API keys are present in the vault (never the values). `set` requires at least one flag:
- `--provider <p>` — one of nano | gemini | claude | gpt | ollama | openrouter | glm.
- `--mode <m>` — api | cli.
- `--model <m>` — model id; blank means "use the provider/mode default".
- `--debug-mode <d>` — prompt | auto.
- `--debug-agent <a>` — auto | claude | codex | gemini.

Not for API keys — those go in `spike secret`.

## CLI: spike dashboard

node dist/cli.js dashboard [--port <n>]

Serves a local, read-only HTML dashboard over artifacts/<runId>/report.json files: an index of runs (verdict, task, url, steps, duration, replay/cache source) linking to a per-run page (model_trace, assertion_trace, action-cache stats, token accounting, step list). Hand-rolled HTML with no client-side JS, no external fonts/scripts, and zero non-Node dependencies; never mutates artifacts/. Listens on `--port` (default 9420, or QA_DASHBOARD_PORT) and stays alive like `spike daemon`. $0, no backend, no external calls.

## Update Triggers

- When a new CLI subcommand is added to src/cli.ts.
- When the MCP tool's input schema or response shape changes.
- When spike run / spike replay gain or lose flags.
- When the spike daemon startup behavior changes, including --install-service/--uninstall-service.
- When spike config's settings surface (planner/navigator/debug) changes shape.

## Related Docs

- docs/architecture/data-flow.md — how CLI and MCP both invoke qaRun()
- docs/modules/engine.md — the qaRun and qaReplay functions
- docs/modules/vibe-mode.md — the daemon and fix prompt detail
- docs/state/server-state.md — Vault (secret storage) detail
