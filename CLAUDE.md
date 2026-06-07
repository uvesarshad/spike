# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

The **browser QA/debug subagent** product: a local daemon + (eventually) Chrome extension that lets a cheap-model ladder — Gemini Nano on-device, Gemini CLI free quota, BYOK, Ollama — do browser testing so the expensive coding agent only pays ~2K tokens per verdict. The full product vision, research, competitive landscape, and **spike results** live in `docs/browser-qa-subagent-product-doc.md` — read it first; §6.5 records what each spike proved and the gotchas hit on this machine. Demand-validation research is in `docs/grok-findings-about-auto-testing-tool.md`. A non-expert architecture walkthrough is in `docs/architecture-explainer.md`.

Both de-risking spikes **PASSED** (frozen reference code under `spikes/`, never imported by `src/`):
- **Spike A** — Gemini Nano (Chrome Prompt API) returns a schema-enforced JSON verdict on a page screenshot, discriminates good vs broken UI, $0 on-device (~5.5s warm).
- **Spike B** — CDP logpoints (`Debugger.setBreakpointByUrl` with a `console.log(...), false` condition) inject instrumentation into a running page with zero source edits; `Page.addScriptToEvaluateOnNewDocument` shims fetch/onerror on any site.

## Commands

```powershell
npm install                            # root deps (TS product)
npm run build                          # tsup → dist/ (cli.js, mcp-server.js)
npm run typecheck                      # tsc --noEmit
npm run test:e2e                       # e2e: qa_run vs the fixture app, both bug modes
node dist/cli.js run "<task>" --url <url> [--json] [--via cdp|extension] [--no-record]   # one QA run
node dist/cli.js replay [name|--all] [--heal] [--via ...]   # deterministic $0 re-run of a recorded script
node dist/cli.js daemon                # vibe-mode daemon: bridge + vibe.run service for the side panel
node dist/cli.js fix <runId>           # print the paste-ready fix prompt for a past run
node dist/cli.js mcp                   # start the MCP stdio server (register as command "qa", args ["mcp"])
node dist/cli.js nano --check          # Gemini Nano availability (surfaces the 22GB storage gate)
node dist/cli.js nano --download       # trigger the ~2GB on-device model download
node dist/cli.js fixture --bug on|off  # start the dogfood fixture app (login→products→cart→checkout)
```

Spike regression (must keep passing — frozen reference):
```powershell
cd spikes/cdp-logpoint
npm install
npm run spike                          # Spike B: CDP logpoint proof (headless, self-contained, exits with verdict)
node spike-a-web.js                    # Spike A: Nano verdict on good/bad demo pages
```

Rung-1 (Google CLI free quota) check, no script:
```powershell
$env:NODE_OPTIONS='--use-system-ca'    # required on THIS machine — AVG TLS interception breaks OAuth (exit 41) otherwise
gemini -p "@spikes/cdp-logpoint/shots/good.png <prompt asking for JSON verdict>" -m gemini-3-flash-preview
```

## Architecture (MVP)

One engine, two transports (MCP stdio + CLI), interface-driven so the extension can replace CDP later without touching the engine:

- `src/ports/` — `BrowserPort` (navigate/click/type/screenshot/axTree/logpoints/console+network drains): `CdpBrowser` is the real implementation (spawns/attaches Chrome via `--remote-debugging-port`); `ExtensionBrowser` is a deliberate stub mapping each op to its MV3 equivalent for the vibe-mode milestone. `NanoPort`: Gemini Nano via a localhost **runner page** (Prompt API is web-exposed on secure contexts; about:blank is not) — `runner-assets.ts` holds the in-page JS as string literals.
- `src/router/` — model ladder. Rung 0 Nano (visual verdicts only, never plans), rung 1 generic Google CLI adapter (binary from config — `gemini` today, `antigravity` after June 18 2026; never hardcode), rung 2 BYOK Gemini API, rung 3 Ollama stub. Escalates on uncertainty/unavailability; every escalation lands in `report.model_trace`.
- `src/driver/` — a11y-tree-first loop: serialize tree (~800 tok) → planner picks ONE action (JSON schema) → execute via port → drain console/network per step. Vision (Nano) only on `assert_visual` + final confirmation. Step budget 12 → `uncertain`.
- `src/capture/axtree.ts` — `Accessibility.getFullAXTree`, pruned to a compact indented text with per-snapshot stable ids (`n7 button "Place order"`) and an id→backendDOMNodeId map for the executor.
- `src/report/` — `artifacts/<runId>/report.json` + screenshots. Slim contract first (`verdict, failing_step, console_error, evidence_paths` — what the calling LLM reads, ~2K tokens), full steps/model_trace after.
- `src/recorder/` — passed runs → `generated-tests/<slug>.json` (role+name locators) + a Playwright `.spec.ts` twin; `qa replay` re-runs the JSON over CDP at $0 (Nano-only visuals), `--heal` re-engages the driver and re-emits.
- `src/bridge/` + `extension/` — the MV3 extension transport: WS bridge (daemon↔SW, JSON-RPC both directions: `{id}` daemon→ext, `{rid}` ext→daemon, `{event}` fan-out), Proxy CDP shim over `chrome.debugger`, side panel (vibe UI), ghost-cursor overlay. Dev-loading on Chrome 137+ is pipe-only: `src/chrome/extensions.ts`.
- `src/vibe/` — `vibe.run` service behind `qa daemon` + deterministic plain-English report and paste-ready fix-prompt synthesis.
- `fixture/` — intentionally-buggy dogfood app; `--bug on` makes "Place order" throw (`order.total` undefined) + `/api/order` 500 → exercises `[PAGE-ERROR]`, `[NET-FAIL]`, and the Nano visual path at once.

**Port allocation (fixed, distinct from spikes so a live spike Chrome never collides):**
- Daemon: CDP **9322**, runner HTTP **9400**, fixture HTTP **9401** (override `QA_CDP_PORT` / `QA_RUNNER_PORT` / `QA_FIXTURE_PORT`).
- Spikes: CDP 9223 (B, throwaway headless) / 9224 (A, persistent headed); HTTP 9333/9334.

**Chrome profiles (placement matters):**
- Daemon profile: `%LOCALAPPDATA%\qa-subagent-chrome-profile` — on C: deliberately, because **Gemini Nano requires 22 GB free on the volume holding the profile** (`availability() === 'unavailable'` is usually this storage gate; E: was too small). Holds the ~2GB model; delete to reclaim.
- Spike A profile: `%LOCALAPPDATA%\qa-spike-chrome-profile`; extension-driver variant uses `spikes/.chrome-profile/`.

## Operational gotchas

- During Nano model download, **don't navigate the runner tab** — navigation kills the `create()` promise (component download survives; rerunning re-attaches).
- Verdict latency: ~16.7s cold (model load) vs ~5.5s warm — `NanoPort.warmup()` holds one session; never `destroy()` it between verdicts.
- Logpoint lines are located by content (`findIndex` on the source), never hardcoded line numbers.
- `--load-extension` is dead in branded Chrome 137+ — dev-loading the extension needs CDP `Extensions.loadUnpacked` or manual chrome://extensions.
- June 18, 2026: Gemini CLI free tier moves to Antigravity CLI (keeps headless `-p`, adds `--output-format`). Rung 1 is a generic "Google CLI adapter" — binary name comes from config.
- The Google CLI child gets `NODE_OPTIONS=--use-system-ca` injected (machine-specific AVG TLS fix); exit code 41 from the CLI means OAuth/TLS — print the hint, don't retry.
