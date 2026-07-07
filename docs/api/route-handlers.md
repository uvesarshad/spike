# API: Route Handlers — CLI Commands and MCP Tool

> Scope: Every CLI subcommand and the MCP stdio tool that callers use to trigger QA runs.
> Rendering context: Server-side (Node.js daemon / CLI)
> Project tier: 3
> Last updated: 2026-07-07

## Overview

The project exposes two call surfaces: a CLI binary (dist/cli.js, bin alias 'qa') and an MCP stdio server (dist/mcp-server.js). Both call the same underlying qaRun() engine function. The CLI is for human use and CI pipelines; the MCP server is for coding agents (Claude Code, Cursor, Copilot) that register it as a tool provider.

AGENT OWNER: src/cli.ts, src/mcp-server.ts

## MCP Tool: qa_run

Registered by src/mcp-server.ts via @modelcontextprotocol/sdk. The MCP server is started as a stdio transport (reads from stdin, writes to stdout) and is registered in the coding agent's tool config as command 'qa', args ['mcp'].

Tool name: qa_run
Input schema:
- task (string, required) — plain-English description of the browser task or QA check.
- url (string, required) — the starting URL for the run.
- via (string, optional) — 'cdp' or 'extension'; defaults to cfg.via.
- maxSteps (number, optional) — step budget override; defaults to cfg.maxSteps (12).
- record (boolean, optional) — whether to record a replay script on pass; defaults to true.

Response: the slim 5-field Report object — verdict, failing_step, console_error, evidence_paths, reason. Approximately 2K tokens.

AGENT NOTE: The MCP server suppresses all progress lines (onProgress is a no-op). The calling agent sees only the final verdict object. This is intentional — the slim contract is exactly what the calling agent needs to understand what happened.

## CLI: qa run

node dist/cli.js run "<task>" --url <url> [--json] [--via cdp|extension] [--no-record] [--action-cache|--no-action-cache]

Runs a QA session. Streams progress lines to stdout during the run. On completion, prints the slim 5-field verdict in human-readable form, or JSON if --json is passed. --no-record skips recording a replay script on pass. --action-cache enables the verified file-backed action cache for one run; --no-action-cache bypasses it even if config/env enables it.

## CLI: qa replay

node dist/cli.js replay [name|path] [--all] [--heal] [--via cdp|extension] [--json]

Replays a recorded QaScript at $0 (no planner, Nano-only visuals). name matches generated-tests/<name>.json. --all replays every script in generated-tests/. --heal re-engages the driver on the original task if the replay fails and re-emits the script. With --all --json, the CLI prints one JSON array of replay results for CI consumers.

## CLI: qa daemon

node dist/cli.js daemon

Starts the vibe-mode daemon: opens BridgeServer on cfg.bridgePort, starts VibeService, and keeps the process alive. The extension's service worker connects to this bridge. The daemon does not launch Chrome.

## CLI: qa fix

node dist/cli.js fix <runId>

Prints the paste-ready fix prompt for a past failing run. The prompt is synthesized by buildFixPrompt(report) at run time and stored by VibeService; this command retrieves it by runId.

## CLI: qa mcp

node dist/cli.js mcp

Starts the MCP stdio server inline (same as running dist/mcp-server.js directly). Used when registering the tool in a coding agent config via a command invocation rather than the prebuilt binary.

## CLI: qa nano

node dist/cli.js nano --check
node dist/cli.js nano --download

--check queries Gemini Nano availability in the daemon's Chrome profile and prints the status (available / downloading / downloadable / unavailable). 'unavailable' usually means the Chrome profile volume has less than 22 GB free.

--download triggers the ~2 GB on-device model download. The Chrome instance (on cfg.chromeProfile) must already be running, or is launched by the command.

## CLI: qa fixture

node dist/cli.js fixture --bug on|off

Starts the dogfood fixture app (fixture/server.ts) on cfg.fixturePort (default 9401). --bug on enables the intentional bugs (order.total undefined, /api/order 500). --bug off runs the healthy version. Primarily used for e2e tests and manual verification.

## CLI: qa secret

node dist/cli.js secret set <name> <value>
node dist/cli.js secret list

set encrypts a secret with Windows DPAPI and stores it in the Vault. Secrets are referenced in QA tasks as {{secret:NAME}} placeholders; the driver resolves them at execute time without logging the value.

## CLI: qa config

node dist/cli.js config get [key]
node dist/cli.js config set <key> <value>

Reads or writes SettingsStore settings (planner provider/mode/model, debugMode, debugAgent). Not for API keys — those go in `qa secret`.

## Update Triggers

- When a new CLI subcommand is added to src/cli.ts.
- When the MCP tool's input schema or response shape changes.
- When qa run / qa replay gain or lose flags.
- When the qa daemon startup behavior changes.

## Related Docs

- docs/architecture/data-flow.md — how CLI and MCP both invoke qaRun()
- docs/modules/engine.md — the qaRun and qaReplay functions
- docs/modules/vibe-mode.md — the daemon and fix prompt detail
- docs/state/server-state.md — Vault (secret storage) detail
