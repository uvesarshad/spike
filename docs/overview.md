# Overview — browser-qa-subagent

> Scope: Master index and mental model for all AI agents and human contributors.
> Rendering context: N/A
> Project tier: 3
> Last updated: 2026-07-18

## Overview

browser-qa-subagent is a local Node.js daemon and Chrome extension that delegates browser QA runs to cheap models (Gemini Nano, Google CLI free quota, BYOK, Ollama), returning a ~2K-token verdict to the expensive coding agent that called it. The daemon drives a real headed Chrome via Chrome DevTools Protocol (CDP); the MV3 extension provides an alternative transport for "vibe mode" — testing the user's own browser session without a separate Chrome profile. Two de-risking spikes are frozen under spikes/ and prove the two hardest primitives: on-device Nano visual verdicts and CDP logpoint injection.

## Tech Stack

- Runtime: Node.js >=20, TypeScript 5.8, ESM modules
- Build: tsup (esbuild), outputs dist/cli.js and dist/mcp-server.js
- Browser control: chrome-remote-interface (CDP), Chrome MV3 extension (chrome.debugger CDP shim + WebSocket bridge)
- Schema validation: zod
- Model interfaces: Gemini Nano (Chrome Prompt API), Google Gemini CLI, Gemini BYOK API, Anthropic API, OpenAI-compatible APIs, Ollama
- MCP: @modelcontextprotocol/sdk (stdio server)
- Recording: gifenc + jpeg-js (GIF screencast)

## Tier Rationale

Tier 3: a server-side daemon with an engine that calls multiple external model APIs, a structured data-flow from browser → a11y tree → model ladder → verdict → report, and a testing infrastructure. No user auth or database; the credential vault (DPAPI) holds API keys only.

## Directory Map — /docs

- docs/overview.md — this file; the AI agent entry point
- docs/architecture/folder-structure.md — every folder mapped to its purpose and naming conventions
- docs/architecture/data-flow.md — end-to-end data path from browser page to calling-agent verdict
- docs/modules/engine.md — qaRun / qaReplay orchestrator and session lifecycle
- docs/modules/model-ladder.md — ModelRouter, ModelAdapter interface, and all rung adapters
- docs/modules/browser-port.md — BrowserPort interface, CdpBrowser, ExtensionBrowser, bridge
- docs/modules/action-cache.md — file-backed verified step action cache helpers
- docs/modules/script-runner.md — allowlisted/AST-validated secure custom-step runner
- docs/modules/telemetry.md — always-on redacted spans, OTLP export, and `qa dashboard`
- docs/modules/recorder.md — QaScript record/replay, pre-run replay matcher, and the Playwright spec twin
- docs/modules/vibe-mode.md — VibeService daemon, side panel, auto-fix loop
- docs/api/route-handlers.md — CLI commands and MCP tool contract
- docs/api/external-services.md — each external model service: credentials, rate limits, fallback
- docs/state/server-state.md — SettingsStore, Vault, ArtifactStore persistence
- docs/infra/environment.md — every environment variable and config key
- docs/infra/deployment.md — build pipeline, packaging, port allocation
- docs/infra/testing.md — test suites, frameworks, how to run

Product documentation (human-authored, not generated):
- docs/browser-qa-subagent-product-doc.md — full product vision, §6.5 records spike results
- docs/architecture-explainer.md — non-expert walkthrough of the system
- docs/grok-findings-about-auto-testing-tool.md — demand-validation research
- docs/TODO.md — roadmap and planned work
- docs/benchmark.md — token cost comparison vs Playwright MCP
- docs/vibe-panel-manual-test.md — manual testing checklist for the extension side panel
- docs/chrome-web-store-submission.md — Chrome Web Store listing and submission checklist

Planning and audit documentation:
- docs/plan/2026-07-01-planner-navigator-split.md — plan for the Brain/Navigator architecture split
- docs/plan/2026-07-01-planner-navigator-split-todo.md — implementation checklist and dogfood results for the split
- docs/plan/2026-07-03-ui-design-tokens.md — side-panel UI design token plan
- docs/plan/2026-07-07-passmark-comparison-audit.md — Passmark comparison audit and gap roadmap
- docs/plan/2026-07-07-passmark-gap-implementation-tasks.md — detailed implementation checklist from the Passmark audit
- docs/plan/2026-07-13-non-tech-onboarding.md — plan for non-technical-user onboarding (Lite mode, extension panel, install scripts)
- docs/plan/2026-07-14-store-readiness.md — Chrome Web Store readiness plan
- docs/plan/26-07-14-audit-non-tech-onboarding.md — audit of the non-technical onboarding implementation
- docs/plan/26-07-14-audit-perf-security.md — performance/security audit of the extension automation port
- docs/plan/26-07-14-tasks-non-tech-onboarding.md — implementation checklist from the onboarding audit
- docs/plan/26-07-14-tasks-perf-security.md — implementation checklist from the perf/security audit

## Key Architectural Decisions

Interface-driven transports: BrowserPort isolates the driver loop from how Chrome is controlled (CDP today, extension bridge in vibe mode). Adding a new transport means implementing BrowserPort; zero engine changes required.

Cheap-model-first ladder: Rung 0 (Gemini Nano, $0 on-device) handles visual verdicts; rung 1 (Google CLI free quota) handles planning. An expensive BYOK key (rung 2) is only used when the free rungs fail or when the user opts in. The calling coding agent pays only for the slim 5-field verdict (~2K tokens).

A11y-tree-first planning: The driver serializes Chrome's accessibility tree (~800 tokens) as the primary page representation. Screenshots are taken only for assert_visual actions and the final pass confirmation. This is what makes the per-run cost ~57× cheaper than Playwright MCP.

Engine-once, transport-twice: qaRun is a single function. Both the CLI (src/cli.ts) and the MCP server (src/mcp-server.ts) call it. The two transports differ only in how they report progress.

Headed Chrome, warm across runs: Chrome is launched once and stays up. The QA tab closes after each run; the Nano runner tab and the Chrome profile stay warm. Cold Nano load is ~16.7s; warm is ~5.5s.

Recorded scripts use role+name locators: After a passing run, the recorder emits a JSON script keyed by accessibility role+name (not node IDs, which die with the snapshot). This makes $0 replay deterministic across runs.

Lite mode degrades gracefully to the browser: when no daemon is running, the MV3 extension (extension/lite-engine.js) drives BYOK/Nano testing entirely in-browser — no CLI planners, auto-fix, or replay clips (those need the daemon), so a non-technical user gets value before ever touching a terminal.

Navigator and brain never silently share a mispinned model: `buildLadder()` (src/engine.ts) gives the brain its own adapter instance when it is pinned to the same provider:mode slot as the navigator but configured with a different model, instead of the brain quietly inheriting the navigator's model.

## Glossary

- rung: a level in the model cost ladder. Rung 0 = Gemini Nano ($0, on-device); rung 1 = Google CLI (free quota); rung 2 = BYOK API key; rung 3 = Ollama (local, private).
- verdict: the result of a QA run — one of 'pass', 'fail', or 'uncertain'.
- axTree / a11y tree: the Chrome accessibility tree, pruned to compact indented text (~800 tokens), used as the primary page representation for the planner.
- slim report: the 5-field contract the calling LLM reads — verdict, failing_step, console_error, evidence_paths, reason (~2K tokens).
- BrowserPort: the abstract interface (src/ports/browser-port.ts) that isolates the driver loop from CDP vs extension transport.
- ModelAdapter: the abstract interface (src/router/adapter.ts) wrapping one model rung; exposes supports(), available(), generateJson(), rung, name.
- vibe mode: interactive daemon mode that drives the user's own Chrome via the MV3 extension side panel, without a separate profile.
- Lite mode: daemon-less execution path where the MV3 extension itself (extension/lite-engine.js) drives BYOK/Nano QA runs; no CLI planners, auto-fix, or replay clips.
- runner page: a localhost HTTP page (port 9400) that hosts the Gemini Nano Prompt API in a secure context (about:blank cannot host it).
- script: a recorded QA run serialized as JSON (generated-tests/*.json) for $0 deterministic replay.
- fixture: the intentionally-buggy dogfood Express shop app (fixture/server.ts, port 9401).
- bridge: the WebSocket server (src/bridge/bridge-server.ts) that relays JSON-RPC messages between the daemon and the extension service worker.
- step budget: the maximum number of driver-loop actions per run (default 12, QA_MAX_STEPS).
- action cache: optional file-backed records for verified single actions keyed by normalized URL, current goal, action intent, and page signature.

## Recent Changes

- [2026-07-18] `buildLadder()` (src/engine.ts) now gives the brain a distinct adapter instance when it shares a provider:mode slot with the navigator but is pinned to a different model, instead of silently inheriting the navigator's model/instance; `CliPlannerAdapter` (src/router/adapters/cli-planner.ts) now also serves `visual-verdict` via image attach (claude `@file` mention / codex `--image`), adding a fallback rung ahead of Nano/API for screenshot verdicts.
- [2026-07-18] Matured the extension automation port: chrome.debugger-based CDP shim and WebSocket bridge hardening for ExtensionBrowser (upload/drag/blur/mouse/tab parity), plus vault/settings support for the extension transport.
- [2026-07-14] Added non-technical onboarding: Lite mode (browser-native execution without the daemon), extension side panel improvements, and cross-platform daemon install script updates (install/install.ps1, install/install.sh); Chrome Web Store submission checklist added as docs/chrome-web-store-submission.md.
- [2026-07-10] Added multi-model visual assertion policies (single-ladder/fail-on-disagreement/arbiter-on-disagreement) in src/assertions/, run-data placeholder resolution ({{run.email}} etc.), and a fake local email provider for OTP/signup flows.
- [2026-07-07] Added the file-backed action-cache module and v28 unit coverage.
- [2026-07-07] Added runtime data and fake email provider modules for Phase 4.
- [2026-07-07] Added Passmark gap implementation task list under docs/plan.
- [2026-07-10] Round 2 (Phases 8-15): opt-in video assertions, action parity (upload/drag/blur/mouse/tabs), secure script runner, first-class telemetry + `qa dashboard`, more provider SDKs, config-drift migration, pre-run replay matcher, and model-assisted extraction. Added docs/modules/script-runner.md and docs/modules/telemetry.md.
- [2026-07-07] Added Passmark comparison audit under docs/plan and indexed planning docs.
- [2026-06-11] Initial documentation generated from codebase; all docs/ subdirectories created.

## Related Docs

- docs/architecture/folder-structure.md — where everything lives on disk
- docs/architecture/data-flow.md — end-to-end data lifecycle
