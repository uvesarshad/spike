# Spike

> **Opus writes the code. A $0 model tests it. Your context stays clean.**

An autonomous browser QA/debugging subagent for coding agents (Claude Code, Cursor, Copilot…) and — soon — for no-code builders (Lovable, Bolt, v0, Replit). The expensive model never touches the browser: a cheap-model ladder drives a **real Chrome**, watches what actually happens (console errors, failed requests, broken rendering), and returns a ~2K-token verdict with evidence.

```
Playwright MCP:  ~114,000 tokens per 10-step test, paid at Opus prices
This project:     ~2,000 tokens per verdict, the looking done by $0 models
```

## Demo

_A demo GIF/screenshot goes here — the ghost-cursor overlay driving a real page._

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

**Deterministic verdicts — the model can't hallucinate a pass.** With oracle strict mode (on by default), a `verdict:'fail'` isn't just a model's opinion: any Tier-0 invariant violation (rendered `undefined`/`NaN`, a broken image, a same-origin 5xx), any failed `assert_*` step, or any metamorphic-relation violation forces the final verdict to `fail`, evidence attached — regardless of what the model itself concluded. Check the current setting with `spike config show`; toggle it via `spike.config.json`'s `strictOracles` field or the `SPIKE_STRICT_ORACLES` env var.

📚 Full product vision, research, and competitive landscape: [`docs/spike-agent-product-doc.md`](docs/spike-agent-product-doc.md)
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
          │   while this runs                 b. Brain/Navigator models pick ONE
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
  | 1 | **CLI planner** (`claude` / `codex` / Antigravity) | account quota | step planning, multi-step reasoning |
  | 2 | **BYOK** (Gemini, Anthropic, OpenAI, OpenRouter, **GLM/z.ai** — `glm-5.2`) | your key | heavy runs, lower latency |
  | 3 | **Ollama local** | $0, private | privacy floor; skipped unless a local daemon is available |

- **CDP logpoints** (the spike-B trick): when diagnosing, the daemon can inject `console.log`s at any file:line of a *running* page with **zero source edits** — `Debugger.setBreakpointByUrl` with a condition that logs and returns `false`. No dirty diffs, no cleanup, works on sites you don't own.
- **CDP and extension transports**: the engine only talks to a `BrowserPort` interface. `CdpBrowser` drives a daemon-owned Chrome over `--remote-debugging-port`; `ExtensionBrowser` drives the user's existing Chrome tab through the MV3 bridge and `chrome.debugger`, so vibe mode can use real logged-in sessions without rewriting the engine.
- **Evidence per step**: console and network buffers are drained between steps, so each step record carries exactly the fallout it caused.
- **Durability features**: optional consensus visual assertions (`SPIKE_ASSERTION_POLICY`), verified action reuse (`spike run --action-cache`), runtime data placeholders such as `{{run.email}}`, extraction into `{{run.*}}`, and `spike replay --all --json` for CI summaries.

## Tech stack

| Layer | Technology | Why |
|---|---|---|
| Language | **TypeScript** (strict) on Node 20+ | the design is interface-driven (ports, adapters, rungs) — the compiler enforces the seams |
| Build | **tsup** (esbuild) | instant ESM builds, `dist/cli.js` + `dist/mcp-server.js` |
| Browser control | **Chrome DevTools Protocol** via [`chrome-remote-interface`](https://github.com/cyrus-and/chrome-remote-interface) | navigate/click/type/screenshot/a11y-tree/logpoints/console/network — everything DevTools can do |
| On-device AI | **Gemini Nano** via Chrome's **Prompt API** (`LanguageModel`, Chrome 138+, multimodal in 148) | $0 schema-enforced JSON verdicts on screenshots, fully offline |
| Planner | a cheap model via **BYOK** (Gemini/Anthropic/OpenAI/OpenRouter/**GLM**) or a **CLI** (`claude`/`codex`/Antigravity) | model-agnostic adapter; binary/key from config. (The free Gemini CLI tier ended 2026-06-18.) |
| BYOK | **Gemini API** (`generateContent` + `responseSchema`) | the adapter seam any provider can implement |
| Agent transport | **MCP** ([`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk), stdio) + a thin **commander** CLI | one core, two front doors |
| Validation | **zod** | planner output is validated, invalid JSON gets one retry with the error attached |
| Test target | self-contained **fixture shop** (`fixture/`) with a toggleable intentional bug | deterministic e2e oracle: healthy → `pass`, bug-on → `fail` with evidence |

No test framework, no lint stack yet — runnable TS scripts with explicit PASS/FAIL output and nonzero exit on regression (see `test/`).

## Requirements

- **Node 20+**
- **Branded Chrome 138+** (148+ for multimodal Nano) — Windows, macOS, or Linux
- The $0 on-device navigator (Gemini Nano) needs a one-time **~2GB model download** and **22GB free disk** on the volume holding the Chrome profile — `spike nano --check` tells you if you're short (`SPIKE_CHROME_PATH` overrides Chrome binary discovery if it's not auto-found)
- A planner — see ["The $0 path"](#the-0-path--no-keys-no-subscriptions) below for the zero-key option, or "Installing" for CLI/BYOK options

## Getting started

```bash
npm install
npm run build

# one-time: set up the $0 on-device model (~2GB download; needs 22GB free
# on the drive holding the Chrome profile — the tool tells you if not)
node dist/cli.js nano --check
node dist/cli.js nano --download

# try it against the built-in fixture app
node dist/cli.js fixture --bug on        # terminal 1: intentionally broken shop
node dist/cli.js run "log in as test@test.com with password pw and complete checkout" \
  --url http://localhost:9401/login      # terminal 2: watch the verdict

# test a whole document instead of one sentence: the flows it describes are
# worked out once, then each one is tested as its own run and rolled up into
# a single verdict (exit code follows the overall verdict)
node dist/cli.js run --spec ./docs/release-2.3.md --url http://localhost:9401/

# CI replay-first workflow after committing or restoring generated-tests/
node dist/cli.js replay --all --json
```

Register as an MCP tool in Claude Code:

```bash
claude mcp add spike -- node /path/to/repo/dist/mcp-server.js
```

…then any agent in that session can call `qa_run(task, url)` — or, for several
things at once, `qa_run({ url, flows: [...] })` with instructions it split
itself, or `qa_run({ url, spec: "<document text>" })` to have them worked out
from a spec/PRD/story list.

<details>
<summary>Windows (PowerShell)</summary>

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

# CI replay-first workflow after committing or restoring generated-tests/
node dist/cli.js replay --all --json
```

Register as an MCP tool in Claude Code:

```powershell
claude mcp add spike -- node C:\path\to\repo\dist\mcp-server.js
```

…then any agent in that session can call `qa_run(task, url)`.

</details>

## Installing

**CLI / daemon (npm).** Once published you can run it without a clone:

```powershell
npx spike-agent run "<task>" --url http://localhost:3000
# or install the `spike` binary globally:
npm i -g spike-agent
spike run "<task>" --url http://localhost:3000
```

Until then, use the local checkout (`npm install && npm run build`, then `node dist/cli.js …` as shown above).

**Chrome extension (vibe mode).** The MV3 extension — side-panel chat, ghost-cursor overlay, native Nano access in your real logged-in Chrome — is **coming soon to the Chrome Web Store**. To run it today as an unpacked dev extension:

1. `npm run pack:extension` (or just point Chrome at the `extension/` folder directly).
2. Open `chrome://extensions`, enable **Developer mode** (top-right).
3. Click **Load unpacked** and select the `extension/` directory (or unzip `dist/extension.zip` and select that).
4. Pin the extension and click it to open the QA side panel.

The extension uses the `debugger` permission to drive the page over CDP; Chrome shows a banner while a debug session is attached.

Prerequisites: Node 20+, desktop Chrome 138+ (148+ for multimodal Nano), and a planner. **Note:** the free Gemini CLI tier (Gemini Code Assist for individuals) ended 2026-06-18 — `gemini -p` now returns `IneligibleTierError`, so the default rung-1 planner no longer works for individuals. Use a BYOK key instead (`GEMINI_API_KEY`, or `spike config set --provider glm` + `spike secret set glm <key>`, or Anthropic/OpenAI), or the `claude`/`codex` CLI as the rung-1 planner. Without Nano the ladder starts at rung 1. Configuration via `spike.config.json` / env (`SPIKE_CDP_PORT`, `SPIKE_CHROME_PROFILE`, `SPIKE_GOOGLE_CLI_BIN`…) — see `src/config.ts`.

Using a specific BYOK provider (rung 2) — e.g. **GLM-5.2 (z.ai)**:

```powershell
node dist/cli.js secret set glm <your-z.ai-key>   # or: $env:GLM_API_KEY="…"
node dist/cli.js config set --provider glm         # pin GLM as the browsing-control AI
# GLM_BASE_URL overrides the endpoint (Coding Plan / mainland host); GLM_THINKING=enabled turns reasoning on
```

GLM-5.2 is text-only, so it does the planning while Gemini Nano (or another vision rung) still handles visual checks.

**A note on `npm audit`:** it currently reports vulnerabilities transitively pulled in via `@modelcontextprotocol/sdk`'s HTTP-transport dependencies. Spike only uses the SDK's **stdio transport** (`spike mcp`) — that code path is never loaded or executed by anything in this repo, so we consider these findings unreachable at runtime. Full reasoning in [SECURITY.md](SECURITY.md#npm-audit-findings).

**Vault key storage:** secrets set via `spike secret set` live in an on-device, AES-256-GCM-encrypted vault. On Windows the encryption key is protected by the OS DPAPI, bound to your user account. On **macOS/Linux the encryption key is currently a local file with `0600` permissions** (owner-read/write only) rather than OS-keychain-backed — a deliberate v1 tradeoff, not a bug, and disclosed the same way in [PRIVACY.md](PRIVACY.md). OS-keychain backends (macOS Keychain, Linux `libsecret`) are **planned** to close that gap.

## The $0 path — no keys, no subscriptions

Spike has a real zero-cost path through the whole stack, not just for visual checks:

- **Navigator:** Gemini Nano (on-device, in Chrome) drives every step — reading the page, picking the next action, judging screenshots — entirely on your machine, $0.
- **Brain:** none required. With no `plan-goals` adapter configured, the driver degrades gracefully to **navigator-only mode** — a single implicit goal covering the whole task, with the driver's *full* step budget (40 steps), not a truncated one.
- **Replay:** once a run has passed and been recorded, `spike replay` re-runs it deterministically over CDP with zero planner calls — $0, indefinitely, until the UI actually changes.

That's real end-to-end testing — log in, click through a flow, catch a broken checkout — for the price of running Chrome.

What each add-on unlocks:

| Add-on | Unlocks |
|---|---|
| A CLI brain (`claude`/`codex` CLI on `PATH`, your account quota) | Smarter up-front planning (`plan-goals`): a sub-goal checklist made once per run and re-consulted only when the navigator gets stuck — better recovery on unfamiliar or complex apps. |
| A BYOK vision navigator (e.g. `GEMINI_API_KEY`) | A steadier per-step navigator than Nano today — Nano-as-navigator works but is still rough (see `CLAUDE.md`'s "Experimental" note on guessed URLs / repeated failing navigation); a cheap vision cloud navigator is the recommended default for reliability. |
| The daemon (`spike daemon`) | Auto-fix (hands a failing run's fix prompt to your coding agent and re-tests), shareable replay clips, and the side-panel "vibe mode" GUI — capabilities an MV3 extension worker can't provide alone. |

## Commands

| Command | What it does |
|---|---|
| `spike run <task> --url <url>` | Run one QA task against a URL; exit 0 pass / 1 verdict fail / 2 uncertain / 3 infra error |
| `spike run … --read-only` | Look-only mode: navigate and check the page, but never click, type, or submit (also `spike replay --read-only`, `readOnly` on the `qa_run` tool, `SPIKE_READ_ONLY=1`) |
| `spike bless [flow]` | Accept the current stored baseline for a flow as intentional (differential oracle) |
| `spike map <url>` | Discover the app — routes, states, interactive elements — into `.spike/app-model.json` ($0, no browser) |
| `spike coverage` | Report what has and hasn't been tested yet, from `.spike/app-model.json` |
| `spike fixture --bug on\|off` | Start the dogfood fixture app (login → products → cart → checkout) |
| `spike config` | View or change the browsing-control AI + debugging settings (shared with the extension panel) |
| `spike replay [name\|--all]` | Replay recorded scripts deterministically — no planner, $0 |
| `spike daemon` | Start the vibe-mode daemon: the bridge the extension side panel connects to |
| `spike fix <runId>` | Print the fix prompt for a finished run — or with `--apply`, hand it to your coding agent headlessly |
| `spike secret` | Manage the local encrypted vault — secrets are typed via `{{secret:NAME}}`, never reach any model |
| `spike mcp` | Start the MCP stdio server (register in a coding agent as command `spike`, args `["mcp"]`) |
| `spike nano --check\|--download` | Check or set up the on-device Gemini Nano model (rung 0) |
| `spike dashboard` | Serve a local read-only dashboard over run reports — model_trace, token accounting, cache/replay stats |

## Testing an app behind a login

**The primary strategy: test on the tab you're already logged in on.** Open the app in Chrome, sign in as you normally would, then open the side panel on that tab and describe what to test. The run uses that tab's session, so everything you can see, the agent can see — no credentials to hand over, no login flow to automate, and it works with any sign-in method your app has, including single sign-on. The tab card in the panel says so: *I'll test this page logged in as you*.

The alternatives, when you need the login itself tested:

- **Email and password** — put the credentials in the vault (`spike secret set TEST_USER …`, `spike secret set TEST_PASSWORD …`, or the panel's "Test login" card) and refer to them in the task as `{{secret:TEST_USER}}` / `{{secret:TEST_PASSWORD}}`. They are typed into the page and never shown to any model.
- **A saved session** — `spike run … --storage-state <file>` reuses cookies and local storage captured from an earlier signed-in session.
- **A code emailed to you** — see the next section.
- **"Sign in with Google / Microsoft / GitHub / Apple"** — these open a separate popup window. From the command line that window is followed automatically; from the side panel it isn't yet, and the run will stop and tell you to sign in on the tab first (which is the first option above, and the one that always works).

## Email verification and one-time codes

Signup, password-reset and magic-link flows end in an email. Point Spike at a real mailbox and it will read the message and pull the code out itself; leave it unset and the agent is simply never told it can wait for email, so it won't plan a step that can't work.

Set these and the mailbox is live (the password is read from the vault first — `spike secret set imap <app-password>` — with the env var as a fallback):

| Variable | What it is |
|---|---|
| `SPIKE_EMAIL_PROVIDER` | `none` (default), `fake-local` (in-memory, for the dogfood fixture and tests), or `imap` |
| `SPIKE_IMAP_HOST` | IMAP server, e.g. `imap.gmail.com` (port 993, TLS) |
| `SPIKE_IMAP_USER` | The account, usually the full address |
| `SPIKE_IMAP_PASS` | App password — prefer the vault (`spike secret set imap …`) |
| `SPIKE_IMAP_MAILBOX` | Folder to watch, default `INBOX` |
| `SPIKE_RUN_EMAIL_DOMAIN` | Domain for the throwaway `{{run.email}}` address a signup uses. Default `example.test` goes nowhere on purpose — point it at a catch-all domain that lands in the mailbox above and signups complete end to end |

Reading mail needs one extra package: `npm install imapflow`. It is optional, so installs that never test a signup flow don't pay for it. The mailbox is only ever read — nothing is flagged, moved or deleted.

## Project structure

```
src/
├─ ports/        BrowserPort (CdpBrowser + ExtensionBrowser real) · NanoPort (localhost runner page)
├─ chrome/       Chrome process management (launch/attach/reuse)
├─ capture/      a11y tree extraction · console+network capture · CDP logpoints
├─ router/       model ladder: adapters (nano, google-cli, byok-gemini, ollama) + escalation
├─ driver/       the loop: planner prompt, action schema, execute/retry policies
├─ report/       report.json contract + artifacts (screenshots) on disk
├─ engine.ts     qaRun() — the single core
├─ mcp-server.ts MCP stdio transport (tool: qa_run)
└─ cli.ts        spike run | mcp | nano | fixture | config
fixture/         dogfood shop app with a toggleable checkout bug
test/            60+ suites (fast + browser buckets) + e2e.run-fixture.ts (the oracle) —
                 run `node scripts/run-tests.mjs --list` for the current breakdown
spikes/          frozen de-risking spikes (never imported by src/)
docs/            product doc · architecture explainer · research
```

## Workflow

Day-to-day development loop:

1. `npm run typecheck` — strict TS gate.
2. `npm test` — the fast bucket: every suite that's pure/in-memory and needs no real Chrome, pooled for speed. This is what CI runs on all three OSes.
3. `npm run test:browser` — the browser bucket: real-Chrome/real-socket suites (contract tests, extension bridge, Nano availability, clip recording…), run serially since they share fixed ports. Local, pre-release only — not run by CI (see `docs/infra/testing.md`).
4. `node scripts/run-tests.mjs --list` — prints the current fast/browser bucket assignment and suite counts without running anything; treat this as the source of truth over any number quoted in prose (docs drift, this command doesn't).
5. The oracle: `npm run test:e2e` — full planner-driven runs against the fixture in both modes (several minutes; every step is a real model call). Healthy must `pass`, bug-on must `fail` with `console_error` + screenshot evidence.
6. Spike regression: `cd spikes/cdp-logpoint && npm run spike` must keep passing.

Conventions worth knowing: logpoint lines are located by content, never hardcoded; the engine imports interfaces, never concrete browsers; machine-specific settings live in gitignored `spike.config.json`; operational gotchas are recorded in [`CLAUDE.md`](CLAUDE.md).

## Timeline

| Date | Milestone | Status |
|---|---|---|
| 2026-06-06 | Idea validated (demand research, competitive landscape) — founding doc written | ✅ |
| 2026-06-06 | **Spike B**: CDP logpoints — instrumentation with zero source edits, live variable capture | ✅ PASS |
| 2026-06-07 | **Spike A**: Gemini Nano — schema-enforced JSON verdicts on screenshots, $0, ~5.5s warm; rung-1 Gemini CLI verdicts | ✅ PASS |
| 2026-06-07 | **MVP vertical slice**: `qa_run` over MCP + CLI, driver loop, model ladder (rungs 0–2), evidence capture, report.json, fixture app — e2e 6/6, MCP smoke 4/4 | ✅ shipped |
| 2026-06-07 | **Recorder**: passed run → JSON trace + Playwright `.spec.ts`; `spike replay` is deterministic, ~9s, $0 AI tokens; self-heals on UI drift and re-emits — e2e 12/12 | ✅ shipped |
| 2026-06-07 | **Extension transport**: MV3 extension drives Chrome via `chrome.debugger` over a WS bridge; same 7/7 port contract as plain CDP; Nano through the extension's Prompt API; `--via extension` | ✅ shipped |
| 2026-06-07 | **Vibe mode (core)**: side-panel chat (`spike daemon`), ghost-cursor overlay (glide/ripples/captions), plain-English reports + paste-ready fix prompts (`spike fix`) — headless e2e green | ✅ shipped |
| next | Dogfood against a real production app | 🔜 |
| then | **Vibe mode (polish)**: shareable replay clips (MP4/GIF), guided Nano onboarding from the panel, run history | planned |
| then | **Tier 4 guardrails**: local credential vault (model never sees secrets), look-only mode (no clicking or typing anywhere, on by default in the browser panel unless you allow this site), mutation limited to the site you named, audit log | planned |
| then | Launch: OSS core + BYOK, token-cost benchmark vs Playwright MCP / Claude in Chrome | planned |
| 2026-06-18 | External: Gemini CLI free tier moves to Antigravity CLI — rung 1 is a generic adapter, switch is a config change | tracked |

## Documentation

Full project documentation lives in /docs and is written for both humans and AI coding agents.

Start here: [docs/overview.md](docs/overview.md)

The overview contains the project's tech stack, architecture decisions, directory map of all doc files, and a glossary of domain terms. All other doc files are linked from there.

AI agents (Claude Code, Gemini CLI, Codex, Cursor, etc.) should read docs/overview.md before making any changes to this codebase.

AGENT NOTE: If you are an AI agent reading this README, stop here and open docs/overview.md before proceeding with any task.

## License

[Apache-2.0](LICENSE).
