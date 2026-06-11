# Infrastructure: Deployment

> Scope: Build pipeline, output packaging, port allocation, and installation paths.
> Rendering context: N/A
> Project tier: 3
> Last updated: 2026-06-11

## Overview

The project builds to a Node.js CLI binary and an MCP stdio server (both in dist/). The Chrome extension is plain MV3 JavaScript (no compile step) under extension/, packaged to dist/extension.zip for distribution. The fixture app runs via tsx (no compile) from fixture/server.ts.

AGENT OWNER: tsup.config.ts, scripts/pack-extension.ts, package.json

## Build Pipeline

npm run build — Runs tsup with the config in tsup.config.ts. tsup uses esbuild to compile:
- src/cli.ts → dist/cli.js (with #!/usr/bin/env node shebang)
- src/mcp-server.ts → dist/mcp-server.js

Both outputs are ES modules (type: "module" in package.json). Source maps are emitted alongside. The build is clean (dist/ wiped) before each run. Requires Node.js >=20.

npm run typecheck — Runs tsc --noEmit over src/, fixture/, and test/. Does not emit; type errors must be clean before publishing. This is the CI gate.

npm run pack:extension — Runs scripts/pack-extension.ts which bundles extension/ (minus git-ignored files) into dist/extension.zip. No transpilation — extension/ is already plain JavaScript.

npm run gen:icons — Runs scripts/gen-icons.ts to regenerate extension/icons/ from source assets. Run this when the extension icon design changes.

prepublishOnly — Automatically runs npm run build before npm publish.

## Binary Distribution

The package.json "bin" field maps 'qa' → 'dist/cli.js'. After npm install -g, the 'qa' command is available on PATH. When used as an MCP tool, the coding agent config registers command 'qa' with args ['mcp'] to start the stdio server.

## Port Allocation

All daemon ports are fixed and distinct from the spike ports to prevent collision:

| Service | Port | Override env var |
|---|---|---|
| Daemon CDP | 9322 | QA_CDP_PORT |
| Nano runner HTTP | 9400 | QA_RUNNER_PORT |
| Fixture HTTP | 9401 | QA_FIXTURE_PORT |
| Extension bridge WS | 9410 | QA_BRIDGE_PORT |
| Spike B CDP | 9223 | (spike-only, never override) |
| Spike A CDP | 9224 | (spike-only, never override) |
| Spike HTTP | 9333/9334 | (spike-only, never override) |

AGENT NOTE: If any daemon port is already in use (another process, a stale Chrome), Chrome/the bridge will fail to bind. Check with `netstat -ano | findstr :<port>` and kill the occupying process, or override with the QA_* env vars.

## Chrome Profile Paths

Daemon profile: %LOCALAPPDATA%\qa-subagent-chrome-profile — holds the Nano model (~2 GB). Must be on a volume with 22 GB+ free.

Spike A profile: %LOCALAPPDATA%\qa-spike-chrome-profile — separate from daemon; used by spike-a-web.js.

Extension-driver spike profile: spikes/.chrome-profile/ — inside the repo, git-ignored.

AGENT AVOID: Never point two Chrome instances at the same profile directory simultaneously — Chrome locks its profile and the second instance will crash or refuse to start.

## MCP Tool Registration

Add to the coding agent's MCP config (e.g., Claude Code's .claude/settings.json or MCP config file):

name: "qa"
command: "qa" (or full path to dist/cli.js if not globally installed)
args: ["mcp"]
transport: "stdio"

The MCP server reads from stdin and writes to stdout. It does not open any HTTP port.

## Environment Configuration for Production

For CI or a shared dev environment, set env vars rather than relying on qa.config.json:
- QA_CDP_PORT, QA_RUNNER_PORT: choose non-default ports if defaults conflict.
- QA_CHROME_PROFILE: explicit path on a high-capacity volume.
- GEMINI_API_KEY or other BYOK keys: injected by CI secrets.
- QA_ALLOWED_HOSTS: add the staging/production host under test.
- QA_RECORD_CLIP: set to '0' in headless CI (Page.startScreencast requires a display).

AGENT NOTE: QA_RECORD_CLIP must be false (or unset) in headless CI. CDP Page.startScreencast requires a visible Chrome window. Setting QA_VIA=cdp with a headless Chrome on a display-less server will likely fail at the screencast step.

## Update Triggers

- When tsup.config.ts changes (new entry points, output format).
- When port defaults change in src/config.ts.
- When the Chrome profile path logic changes.
- When a new build script is added to scripts/.

## Related Docs

- docs/infra/environment.md — all env vars and their defaults
- docs/infra/testing.md — how to run tests (uses the build output)
- docs/modules/engine.md — Chrome launch and profile management
