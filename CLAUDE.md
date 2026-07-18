# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

The **browser QA/debug subagent** product: a local daemon + (eventually) Chrome extension that lets a cheap-model ladder — Gemini Nano on-device, Gemini CLI free quota, BYOK, Ollama — do browser testing so the expensive coding agent only pays ~2K tokens per verdict. The full product vision, research, competitive landscape, and **spike results** live in `docs/browser-qa-subagent-product-doc.md` — read it first; §6.5 records what each spike proved and the gotchas hit on this machine. Demand-validation research is in `docs/grok-findings-about-auto-testing-tool.md`. A non-expert architecture walkthrough is in `docs/architecture-explainer.md`.

**The driver is a two-tier navigator/brain split** (the core cost lever — see `docs/plan/2026-07-01-planner-navigator-split.md`): a cheap/free **navigator** (`plan-step`, default Gemini Nano, $0) does the per-step page-driving on *every* step, and a smart **brain** (`plan-goals`, default Claude Sonnet) plans a sub-goal checklist *once* up front and is re-consulted only when the navigator is stuck (blocked / loops / invalid output / per-goal overflow / ambiguous final verdict). So brain cost is ~O(escalations + 1), not O(steps) — a run can go for hours over complex apps at near-navigator cost. Proven live on `mapleandsand.com` (2026-07-03): 14 Nano navigator steps vs 3 Sonnet brain calls, brain flat as steps grew; verdict payload 124 tok. Two Settings cards ("Navigator" + "Brain") expose the two roles. A single-model setup (no `plan-goals` adapter) degrades gracefully to navigator-only.

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
node dist/cli.js daemon --install-service    # register the daemon to auto-start on login (one-shot; then exits)
node dist/cli.js daemon --uninstall-service  # remove that autostart entry
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
- `src/router/` — model ladder with three `Capability` roles: `visual-verdict` (Nano first, then vision cloud), `plan-step` (the **navigator** — cheap per-step action-picker; Nano serves this too via `navStep`), `plan-goals` (the **brain** — smart planner; every `plan-step` adapter also serves it EXCEPT Nano, which never plans goals). `ModelRouter` takes two pins — `navigatorAdapter` (leads `plan-step`) and `plannerAdapter` (leads `plan-goals`) — plus a `pinnedAdapter` back-compat alias applied to both; `planJson()` is the navigator call, `planGoals()` the brain call, `hasCapability(cap)` gates the navigator-only fallback. Rung 0 Nano ($0 on-device), rung 1 generic Google CLI adapter (binary from config — `gemini` today, `antigravity` after June 18 2026; never hardcode) + `CliPlannerAdapter` (`claude`/`codex`), rung 2 BYOK HTTP adapters (Gemini, Anthropic, OpenAI/OpenRouter, and **GLM/z.ai** `glm-5.2` — text-only, planner-only, `GLM_API_KEY`/`GLM_BASE_URL`), rung 3 Ollama stub. Escalates on uncertainty/unavailability; every call lands in `report.model_trace` tagged by `capability` (per-role cost split). New OpenAI-compatible providers reuse `OpenAiCompatibleAdapter` (`supportsVision`/`jsonMode`/`extraBody` knobs) — don't write a new adapter class.
- `src/driver/` — hierarchical a11y-tree-first loop (`loop.ts`): brain `planGoals` → ordered sub-goal checklist (ONE call); then per `currentGoal` the **navigator** loop — serialize tree (~800 tok) → `planJson` (navigator) picks 1–3 actions or emits `goalComplete`/`blocked` → execute via port → drain console/network per step. Stuck (`blocked`, same-action-3×, invalid JSON, per-goal overflow) → `escalate()` re-consults the brain (revised goals / hint / verdict), capped by `MAX_BRAIN_ESCALATIONS`. Vision (Nano) only on `assert_visual` + final confirm; a navigator finish that the visual disagrees with escalates to the brain for the call. `maxSteps` 40 (per-goal budget 12) → `uncertain`. No `plan-goals` adapter configured → navigator-only fallback (single implicit goal = the task). Prompts in `planner-prompt.ts` (`buildGoalPlannerPrompt` brain, `buildNavigatorPrompt` navigator); schemas in `actions.ts` (`GOAL_PLAN_JSON_SCHEMA`, `PLAN_JSON_SCHEMA` + `goalComplete`/`blocked`).
- `src/capture/axtree.ts` — `Accessibility.getFullAXTree`, pruned to a compact indented text with per-snapshot stable ids (`n7 button "Place order"`) and an id→backendDOMNodeId map for the executor.
- `src/report/` — `artifacts/<runId>/report.json` + screenshots. Slim contract first (`verdict, failing_step, console_error, evidence_paths` — what the calling LLM reads, ~2K tokens), full steps/model_trace after.
- `src/recorder/` — passed runs → `generated-tests/<slug>.json` (role+name locators) + a Playwright `.spec.ts` twin; `qa replay` re-runs the JSON over CDP at $0 (Nano-only visuals), `--heal` re-engages the driver and re-emits.
- `src/bridge/` + `extension/` — the MV3 extension transport: WS bridge (daemon↔SW, JSON-RPC both directions: `{id}` daemon→ext, `{rid}` ext→daemon, `{event}` fan-out), Proxy CDP shim over `chrome.debugger`, side panel (vibe UI), ghost-cursor overlay. Dev-loading on Chrome 137+ is pipe-only: `src/chrome/extensions.ts`.
- `src/vibe/` — `vibe.run` service behind `qa daemon` + deterministic plain-English report and paste-ready fix-prompt synthesis.
- `src/service/install-service.ts` — the desktop-app UX half: `qa daemon --install-service` registers `qa daemon` to auto-start on login per-user (Win Scheduled Task `ONLOGON /RU <user>`, macOS `~/Library/LaunchAgents` plist `RunAtLoad`, Linux `systemd --user` unit), `--uninstall-service` removes it. Both one-shot (register/remove, then exit). Every spawn routes through an internal `run()` indirection (`__setRunner` stubs it in tests — no OS persistence). The env bakes in `NODE_OPTIONS=--use-system-ca` (AVG TLS). Paired with `install/install.ps1` + `install/install.sh`: the panel's **"Connect the desktop app"** block (Settings → Debugging, shown only while the daemon dot is red) hands the user a per-OS one-liner (default: `irm|iex` / `curl|sh` from GitHub **Raw** at `INSTALL_BASE` = `raw.githubusercontent.com/uvesarshad/spike/main/install` — $0, static, no backend; a "without a remote script (npm)" toggle swaps to the pure `npm i -g browser-qa-subagent … qa daemon --install-service` form). Nothing is hosted server-side — npm hosts the package, GitHub Raw serves the 2 install scripts, and the daemon runs on the user's OWN machine (`localhost`) → daemon auto-starts → the panel's 3s `bridge-status` poll flips the dot green → auto-fix + clips unlock, no terminal after that. Lite mode (no daemon) still does BYOK+Nano testing; the daemon only adds CLI planners/navigators, auto-fix (edits files on disk), and replay clips — things an MV3 worker fundamentally can't do.
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
- **June 18, 2026 HAPPENED: the Gemini CLI free tier is DEAD.** `gemini -p` now hard-fails auth with `IneligibleTierError: This client is no longer supported... migrate to the Antigravity suite` (verified 2026-06-29 on this machine). So rung-1-via-`gemini` no longer works for individuals — `google-cli.ts` detects this and prints a recovery hint, and the router falls through to other rungs. Working planners today: BYOK key (GLM/`gemini`/`claude`/`openai`), the `claude`/`codex` CLI (rung 1, `CliPlannerAdapter`), or point `googleCliBin` at the Antigravity CLI once installed (it keeps headless `-p`, adds `--output-format`). The default `planner` is still `gemini:cli` — change it (`qa config set --provider …`) or rely on `claude`/`codex` CLI fallback.
- The Google CLI child gets `NODE_OPTIONS=--use-system-ca` injected (machine-specific AVG TLS fix); exit code 41 from the CLI means OAuth/TLS — print the hint, don't retry.
- **`--install-service` on Windows needs `/RU <user>`** or `schtasks /Create … /SC ONLOGON` fails with "Access is denied" from a non-elevated shell (a bare `ONLOGON` trigger wants a machine-level logon-trigger right). `install-service.ts` already passes `/RU ${os.userInfo().username}` to scope the task per-user — don't drop it. The task command quotes both the node exe and `cli.js` path (spaces in `Program Files`). Registering a real task **persists beyond the session** (the auto-mode classifier will block it in-agent) — smoke-test via `__setRunner` (stubs the spawn, asserts args, zero persistence), not by actually running `--install-service`.
- **Navigator/brain pins are set separately from the SettingsStore.** As of Phase 13 (2026-07-10), `SettingsStore.readRaw()` MIGRATES stale on-disk pins on load: a persisted `planner: gemini:cli` (dead free tier) → `claude:cli`, and a missing `navigator` → `nano:ondevice`, rewritten to disk once. `config.ts`'s `DEFAULTS` (brain `claude:cli`, navigator `nano`) is the single source of truth — there is no checked-in `settings.json`. `loadConfig()` still prints a dead-planner warning if the FINAL resolved planner is `gemini:cli` (only reachable now via an explicit env/qa.config.json pin). For a working run you can still override per-role via env: `QA_PLANNER_PROVIDER=claude QA_PLANNER_MODE=cli` (brain) and `QA_NAVIGATOR_PROVIDER=… QA_NAVIGATOR_MODE=…` (navigator). Env beats the SettingsStore; a lone `QA_*_MODEL` partial-merges onto provider/mode. Reliable non-Nano recipe: `GEMINI_API_KEY` + `QA_NAVIGATOR_PROVIDER=gemini QA_NAVIGATOR_MODE=api` (cheap vision navigator + visual) with `QA_PLANNER_PROVIDER=claude QA_PLANNER_MODE=cli` (brain).
- **Nano-as-navigator is real but rough (Phase A still un-GO'd):** on `mapleandsand.com` the Nano navigator *guessed* a URL (`/shop`) instead of clicking a nav link and then repeated the same failing navigation before the brain escalation caught it. It works, but treat Nano-navigator as "Experimental" until the `spikes/nano-nav/` GO/NO-GO passes; a cheap vision cloud navigator (Gemini Flash / Haiku) is the reliable default.
- **The Tier-4 guard trusts the named target automatically for CLI/MCP (`trustTargetHost`, default true in `qaRun`/`engine.ts`):** `qa run "<task>" --url <anything>` / the `qa_run` MCP tool can click/type end-to-end on ANY site/app/SaaS/no-code build (WordPress, Framer, Webflow, whatever — the driver is accessibility-tree + screenshot driven, not framework-specific) with zero flags — the URL's host, plus its www./bare-domain sibling (apex↔www redirects, e.g. `mapleandsand.com` ↔ `www.mapleandsand.com`, are auto-covered both directions), is added to `allowedHosts` for that run. Hosts OTHER than the named target (ad iframes, OAuth redirects to a different domain, surprise 3rd-party redirects) still default-deny mutation — add those via `--allow-host` / `QA_ALLOWED_HOSTS`. The **vibe panel is the one caller that opts OUT** of this default (`trustTargetHost: false` unless its "allow click/type on this site" checkbox is on) since it drives whatever tab happens to be open, not a URL the user explicitly typed as a target — see `vibe/service.ts`. Only test sites you're authorized to drive, and scope tasks to non-destructive checks on anything you don't own outright.
