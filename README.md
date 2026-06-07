# Browser QA Subagent

> **Opus writes the code. A $0 model tests it. Your context stays clean.**

An autonomous browser QA/debugging subagent for coding agents (Claude Code, Cursor, Copilot…) and — soon — for no-code builders (Lovable, Bolt, v0, Replit). The expensive model never touches the browser: a cheap-model ladder drives a **real Chrome**, watches what actually happens (console errors, failed requests, broken rendering), and returns a ~2K-token verdict with evidence.

```
Playwright MCP:  ~114,000 tokens per 10-step test, paid at Opus prices
This project:     ~2,000 tokens per verdict, the looking done by $0 models
```

## About

Coding agents are blind. They write UI code, claim "fixed!", and can't verify it — so the human becomes the QA department for the AI. The existing fix (browser tools driven by the main model) is ruinously expensive: screenshots cost 10K+ tokens each and the priciest model in the stack ends up clicking login buttons.

This project flips that: one tool call — `qa_run(task, url)` — delegates the whole browser session to a local daemon that does the looking with models that cost nothing, then reports back like a QA engineer would:

```json
{
  "verdict": "fail",
  "failing_step": { "index": 6, "description": "click 'Place order'" },
  "console_error": "[PAGE-ERROR] TypeError: Cannot read properties of undefined (reading 'toFixed')\n    at http://localhost:9401/checkout:35:85",
  "evidence_paths": ["artifacts/…/report.json", "artifacts/…/screenshots/step-07.png"],
  "reason": "Order API failed with status 500 and a client-side TypeError occurred upon clicking 'Place order'."
}
```

The exact error with file:line, the failing step, the failed network call, and a screenshot — for ~660 bytes of the calling agent's context.

📚 Full product vision, research, and competitive landscape: [`docs/browser-qa-subagent-product-doc.md`](docs/browser-qa-subagent-product-doc.md)
🧑‍🏫 Plain-English architecture tour (no prior knowledge assumed): [`docs/architecture-explainer.md`](docs/architecture-explainer.md)

## How it works

```
 Coding agent (Opus/any)                   YOUR MACHINE — daemon + Chrome
 ───────────────────────                   ─────────────────────────────────────────
 1. calls one MCP tool:                    2. daemon starts/reuses Chrome (CDP)
    qa_run("log in and check out",         3. opens the page in a QA tab
           "http://localhost:3000")        4. THE LOOP — paid in cheap/free tokens:
          │                                   a. read the page as a compact a11y
          │   pays ZERO tokens                   tree (~800 tok, stable node ids)
          │   while this runs                 b. planner (Gemini Flash) picks ONE
          │                                      action: click n7 / type / assert…
          │                                   c. execute it over CDP
          │                                   d. capture console + network caused
          │                                      by exactly this step
          │                                   e. visual question? screenshot →
          │                                      Gemini Nano judges it on-device, $0
          ▼                                5. write report.json + screenshots/
 6. receives ~2K-token verdict ◄──────────    return the slim verdict over MCP
```

Key design decisions:

- **a11y-tree-first**: the page goes to the model as a pruned accessibility tree (`n7 button "Place order"`), not as screenshots. Vision is invoked only for genuinely visual questions — and then a $0 on-device model does the looking.
- **The model ladder** (escalate only on uncertainty, every escalation recorded in `report.model_trace`):

  | Rung | Model | Cost | Role |
  |---|---|---|---|
  | 0 | **Gemini Nano** (Chrome Prompt API) | $0, on-device | visual verdicts on screenshots |
  | 1 | **Google CLI free quota** (Gemini Flash) | $0 | step planning, multi-step reasoning |
  | 2 | **BYOK** (Gemini API key; OpenRouter et al. drop in) | your key | heavy runs, lower latency |
  | 3 | **Ollama local** | $0, private | privacy floor (interface stub today) |

- **CDP logpoints** (the spike-B trick): when diagnosing, the daemon can inject `console.log`s at any file:line of a *running* page with **zero source edits** — `Debugger.setBreakpointByUrl` with a condition that logs and returns `false`. No dirty diffs, no cleanup, works on sites you don't own.
- **CDP now, extension later**: the engine only talks to a `BrowserPort` interface. `CdpBrowser` (plain `--remote-debugging-port`) ships today; `ExtensionBrowser` (MV3 `chrome.debugger`) is a deliberate stub that becomes the plug-and-play vibe-mode face (Web Store install, real logged-in sessions, native Nano access) without rewriting the engine.
- **Evidence per step**: console and network buffers are drained between steps, so each step record carries exactly the fallout it caused.

## Tech stack

| Layer | Technology | Why |
|---|---|---|
| Language | **TypeScript** (strict) on Node 20+ | the design is interface-driven (ports, adapters, rungs) — the compiler enforces the seams |
| Build | **tsup** (esbuild) | instant ESM builds, `dist/cli.js` + `dist/mcp-server.js` |
| Browser control | **Chrome DevTools Protocol** via [`chrome-remote-interface`](https://github.com/cyrus-and/chrome-remote-interface) | navigate/click/type/screenshot/a11y-tree/logpoints/console/network — everything DevTools can do |
| On-device AI | **Gemini Nano** via Chrome's **Prompt API** (`LanguageModel`, Chrome 138+, multimodal in 148) | $0 schema-enforced JSON verdicts on screenshots, fully offline |
| Planner | **Gemini Flash** via the `gemini` CLI headless mode (`-p`, `-o json`) | free quota (model-agnostic adapter — binary name is config, ready for the Antigravity CLI transition) |
| BYOK | **Gemini API** (`generateContent` + `responseSchema`) | the adapter seam any provider can implement |
| Agent transport | **MCP** ([`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk), stdio) + a thin **commander** CLI | one core, two front doors |
| Validation | **zod** | planner output is validated, invalid JSON gets one retry with the error attached |
| Test target | self-contained **fixture shop** (`fixture/`) with a toggleable intentional bug | deterministic e2e oracle: healthy → `pass`, bug-on → `fail` with evidence |

No test framework, no lint stack yet — runnable TS scripts with explicit PASS/FAIL output and nonzero exit on regression (see `test/`).

## Getting started

```powershell
npm install
npm run build

# one-time: set up the $0 on-device model (~2GB download; needs 22GB free
# on the drive holding the Chrome profile — the tool tells you if not)
node dist/cli.js nano --check
node dist/cli.js nano --download

# try it against the built-in fixture app
node dist/cli.js fixture --bug on        # terminal 1: intentionally broken shop
node dist/cli.js run "log in as test@test.com with password pw and complete checkout" `
  --url http://localhost:9401/login      # terminal 2: watch the verdict
```

Register as an MCP tool in Claude Code:

```powershell
claude mcp add qa -- node E:\path\to\repo\dist\mcp-server.js
```

…then any agent in that session can call `qa_run(task, url)`.

## Installing

**CLI / daemon (npm).** Once published you can run it without a clone:

```powershell
npx browser-qa-subagent run "<task>" --url http://localhost:3000
# or install the `qa` binary globally:
npm i -g browser-qa-subagent
qa run "<task>" --url http://localhost:3000
```

Until then, use the local checkout (`npm install && npm run build`, then `node dist/cli.js …` as shown above).

**Chrome extension (vibe mode).** The MV3 extension — side-panel chat, ghost-cursor overlay, native Nano access in your real logged-in Chrome — is **coming soon to the Chrome Web Store**. To run it today as an unpacked dev extension:

1. `npm run pack:extension` (or just point Chrome at the `extension/` folder directly).
2. Open `chrome://extensions`, enable **Developer mode** (top-right).
3. Click **Load unpacked** and select the `extension/` directory (or unzip `dist/extension.zip` and select that).
4. Pin the extension and click it to open the QA side panel.

The extension uses the `debugger` permission to drive the page over CDP; Chrome shows a banner while a debug session is attached.

Prerequisites: Node 20+, desktop Chrome 138+ (148+ for multimodal Nano), and for rung 1 a logged-in [`gemini` CLI](https://geminicli.com). Without Nano the ladder starts at rung 1; without the CLI, set `GEMINI_API_KEY` (rung 2). Configuration via `qa.config.json` / env (`QA_CDP_PORT`, `QA_CHROME_PROFILE`, `QA_GOOGLE_CLI_BIN`…) — see `src/config.ts`.

## Project structure

```
src/
├─ ports/        BrowserPort (CdpBrowser real, ExtensionBrowser stub) · NanoPort (localhost runner page)
├─ chrome/       Chrome process management (launch/attach/reuse)
├─ capture/      a11y tree extraction · console+network capture · CDP logpoints
├─ router/       model ladder: adapters (nano, google-cli, byok-gemini, ollama) + escalation
├─ driver/       the loop: planner prompt, action schema, execute/retry policies
├─ report/       report.json contract + artifacts (screenshots) on disk
├─ engine.ts     qaRun() — the single core
├─ mcp-server.ts MCP stdio transport (tool: qa_run)
└─ cli.ts        qa run | mcp | nano | fixture | config
fixture/         dogfood shop app with a toggleable checkout bug
test/            m1/m2/m4/m5/m6 suites + e2e.run-fixture.ts (the oracle)
spikes/          frozen de-risking spikes (never imported by src/)
docs/            product doc · architecture explainer · research
```

## Workflow

Day-to-day development loop:

1. `npm run typecheck` — strict TS gate.
2. Fast suites (no model spend): `npx tsx test/m1.browser-port.ts` (browser port, 7 checks) · `npx tsx test/m5.fixture.ts` (fixture sanity, 7 checks).
3. Model-touching suites: `npx tsx test/m2.nano-port.ts` (Nano discrimination) · `npx tsx test/m4.router.ts` (escalation + one live CLI call).
4. The oracle: `npm run test:e2e` — full planner-driven runs against the fixture in both modes (several minutes; every step is a free-quota Flash call). Healthy must `pass`, bug-on must `fail` with `console_error` + screenshot evidence.
5. MCP contract: `npx tsx test/m6.mcp.ts` (drives the **built** server over stdio).
6. Spike regression: `cd spikes/cdp-logpoint && npm run spike` must keep passing.

Conventions worth knowing: logpoint lines are located by content, never hardcoded; the engine imports interfaces, never concrete browsers; machine-specific settings live in gitignored `qa.config.json`; operational gotchas are recorded in [`CLAUDE.md`](CLAUDE.md).

## Timeline

| Date | Milestone | Status |
|---|---|---|
| 2026-06-06 | Idea validated (demand research, competitive landscape) — founding doc written | ✅ |
| 2026-06-06 | **Spike B**: CDP logpoints — instrumentation with zero source edits, live variable capture | ✅ PASS |
| 2026-06-07 | **Spike A**: Gemini Nano — schema-enforced JSON verdicts on screenshots, $0, ~5.5s warm; rung-1 Gemini CLI verdicts | ✅ PASS |
| 2026-06-07 | **MVP vertical slice**: `qa_run` over MCP + CLI, driver loop, model ladder (rungs 0–2), evidence capture, report.json, fixture app — e2e 6/6, MCP smoke 4/4 | ✅ shipped |
| 2026-06-07 | **Recorder**: passed run → JSON trace + Playwright `.spec.ts`; `qa replay` is deterministic, ~9s, $0 AI tokens; self-heals on UI drift and re-emits — e2e 12/12 | ✅ shipped |
| 2026-06-07 | **Extension transport**: MV3 extension drives Chrome via `chrome.debugger` over a WS bridge; same 7/7 port contract as plain CDP; Nano through the extension's Prompt API; `--via extension` | ✅ shipped |
| 2026-06-07 | **Vibe mode (core)**: side-panel chat (`qa daemon`), ghost-cursor overlay (glide/ripples/captions), plain-English reports + paste-ready fix prompts (`qa fix`) — headless e2e green | ✅ shipped |
| next | Dogfood against a real app (MontrAI social module) | 🔜 |
| then | **Vibe mode (polish)**: shareable replay clips (MP4/GIF), guided Nano onboarding from the panel, run history | planned |
| then | **Tier 4 guardrails**: local credential vault (model never sees secrets), read-only-by-default on third-party sites, audit log | planned |
| then | Launch: OSS core + BYOK, token-cost benchmark vs Playwright MCP / Claude in Chrome | planned |
| 2026-06-18 | External: Gemini CLI free tier moves to Antigravity CLI — rung 1 is a generic adapter, switch is a config change | tracked |

## License

[Apache-2.0](LICENSE).
