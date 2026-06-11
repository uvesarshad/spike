# Agent Instructions — browser-qa-subagent

## Start here
Read docs/overview.md before doing anything else.
It contains the full mental model: stack, architecture, data flow, module map, and glossary.

## Documentation index
docs/overview.md lists every doc file and what it covers.
Navigate from there. Do not rely on memory or assumptions.

## Before every task
1. Read docs/overview.md
2. Read the relevant module doc in docs/modules/ if one exists
3. Make the change
4. Run the update decision tree against the change (AGENT UPDATE tags in affected doc files)
5. Output a DOCS UPDATED summary before marking the task complete

## Hard rules
- Never invent file paths, component names, or type names. Verify against the codebase.
- Never import from spikes/ in src/. The spikes/ directory is frozen reference code.
- Never hardcode 'gemini' as the Google CLI binary name. Use cfg.googleCliBin (config-driven).
- Never run Chrome in headless mode. Gemini Nano requires a headed Chrome (secure context).
- Never store API keys in SettingsStore (src/vibe/settings.ts). Keys belong in the Vault only.
- Never pass user-supplied model IDs to CLI adapters without the isSafeModelId() check.
- Never add an environment variable without updating docs/infra/environment.md.
- Never change BrowserPort without updating all implementations (CdpBrowser + ExtensionBrowser).
- If a docs/ file would exceed 200 lines after your update, split it and update docs/overview.md.

## Docs update tags
Throughout the /docs files you will find:
  AGENT NOTE:   — constraint you must follow
  AGENT SEE:    — cross-reference to read
  AGENT AVOID:  — anti-pattern to skip
  AGENT UPDATE: — doc files to update when this area changes
  AGENT OWNER:  — the module or file that owns this concept

## Stack summary
Node.js >=20 daemon + Chrome MV3 extension. TypeScript 5.8 compiled by tsup. Browser control via CDP (chrome-remote-interface) or extension bridge (WebSocket JSON-RPC). Model ladder: Gemini Nano (rung 0, $0) → Google CLI (rung 1, free) → BYOK APIs (rung 2) → Ollama (rung 3). MCP stdio server for coding-agent integration.

## Key paths
- src/engine.ts — qaRun() and qaReplay(); both transports call this
- src/driver/loop.ts — the a11y-tree-first driver loop
- src/ports/browser-port.ts — the BrowserPort interface all browser control flows through
- src/router/model-router.ts — ModelRouter: walks the cost ladder
- src/config.ts — loadConfig(); all env vars and qa.config.json keys resolved here
- src/cli.ts — CLI entry point (commander subcommands)
- src/mcp-server.ts — MCP stdio server (registers qa_run tool)
- extension/ — Chrome MV3 extension (no compile step; plain JS)
