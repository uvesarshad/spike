# Audit — Usability & end-to-end autonomy (non-technical user path)

> Date: 2026-09-12 · Branch: `v0.2` @ `59c8fb3` · Scope: "can a non-technical person plug this in, give a vague brief (a sentence, a PRD, a verbal note), and get a trustworthy end-to-end QA verdict — and can an expert give precise flows?"
> Method: four parallel code-verification passes (panel/lite UX, autonomy & input, CLI/MCP/daemon, report/output), every claim re-checked against source with file:line, the highest-impact claims re-verified by hand (read-only default, post-finish livelock, password leak, cart-badge false fail, replay secrets).
> Prior audits this builds on: [26-07-14-audit-non-tech-onboarding](./26-07-14-audit-non-tech-onboarding.md), [26-08-27-audit-market-readiness](./26-08-27-audit-market-readiness.md), [26-08-08-options-autonomy-layer](./26-08-08-options-autonomy-layer.md).

---

## 0. Executive summary

**The engine is good. The product around it is not yet usable by the person it is for.** The two-tier navigator/brain split, the failure containment, the token discipline, the oracle gating and the secret handling *inside the driver* are all genuinely strong (see §4). But a new user — technical or not — cannot currently get a correct verdict on a default run, on any of the three surfaces:

1. **Every default run is a no-op.** `readOnly: true` is the shipped default for the panel, the CLI *and* the MCP tool. Every click/type is skipped, stamped `ok: true`, the model believes it clicked, loops, and the run ends `uncertain` or — worse — `fail` on a working site. The panel's own "Allow the agent to click & type" checkbox does not turn it off. There is no CLI flag. Only an undocumented env var does. (A1)
2. **Any site with a cart badge is force-failed.** The metamorphic layer proposes "+1 on add" and "−1 on remove" from the same badge, both `reliable`, both gate the verdict; one of them always violates. (A2)
3. **Nobody can install it.** `npm i -g spike-agent` and the GitHub raw install URLs both 404. The panel's "Connect Spike Core" button hands users a command that cannot work. Open since 2026-07-14. (A3)
4. **The first-run path in the panel is broken at the first two taps**: the big "Save" button in Settings does not save the API key, and the first suggestion card starts a run that errors with "Add your Brain (planner) API key … lite mode is BYOK; no daemon". (A4)
5. **The product teaches users to paste passwords into the task box, then writes them to disk, history, generated tests and the fix prompt they paste into Lovable/Cursor.** (A5)
6. **A run that succeeded can be reported as "Couldn't finish"**: after a passing page check, the action cache replays the same check every iteration until the 40-step budget dies. Verified live in the current loop. (A6)
7. **The "vague brief → full autonomous QA" promise has no front door.** The only input is one free-text string. No PRD/spec/story-list intake, no "test everything" mode, no orchestration above a single 40-step run, discovery output never becomes goals, login via SSO or email/OTP is structurally unreachable. (A7–A9)

**What "very user-friendly" should look like** is spelled out in §1 as a target experience. The short version: *one key, one consent switch, three input levels (nothing / a sentence / a document), a verdict card a non-engineer can act on, and a "Saved tests" list that grows by itself.* Most of the engine needed for that already exists; what is missing is the wiring and the front door.

**Recommended order of attack** (not a task list — that comes when you ask for it): A1 → A2 → A6 → A4 → A5 → A3 (owner) → A10/A11 → A7 → A8 → A9. The first five are days of work and turn "cannot get a verdict" into "gets a correct verdict on a plain sentence". A7–A9 are the autonomy story and are weeks.

---

## 1. Target experience — what "plug in and use" should mean

This section is the design answer to the question "how would a user use it?". Everything in §2 is a gap against this.

### 1.1 The two personas, kept honest

| | Vibe-coder / founder / QA-curious non-dev | Developer / coding agent |
|---|---|---|
| Surface | Extension side panel, on the tab they already have open and are already logged into | `spike run` / `qa_run` MCP |
| Setup they will tolerate | Paste **one** API key. Nothing else. No terminal, ever. | `npm i -g`, one MCP registration line |
| Input they will give | "test signup", a pasted PRD, or nothing ("just check it") | precise flow text, `--spec file`, a suite file |
| Output they can act on | a verdict card with a screenshot, a plain reason, and one of three buttons: *Copy fix prompt* / *Send to my developer* / *Save as a test* | slim JSON, exit code, artifact paths |
| Optional upgrade | "Spike Core" for auto-fix + clips — framed as optional, never as "disconnected" | daemon for replay/heal/suite |

### 1.2 Onboarding: three screens, then never again

1. **"Which AI should do the testing?"** — one key field with provider auto-detected from the key's prefix (`sk-ant-`, `AIza`, `sk-`), a "where do I get a key" link, and the sentence *"A small model drives every step; a smarter one plans and checks. One key covers both."* Provider-matched tiers are already implemented (`settings-data.ts` `NAVIGATOR_MODELS`/`BRAIN_MODELS`); the panel just has to stop asking twice.
2. **"Which site?"** — the current tab, already shown. One line: *"I'll test the page in this tab, logged in as you."* (This is the product's best autonomy decision — say it out loud.)
3. **"May I click things here?"** — ONE switch. On = the run may click/type on this host. Off = look-only. This switch *is* `readOnly`. No second switch in Settings.

Optional card, collapsed: **"Test login (optional)"** — username + password stored in the vault, referenced as `{{secret:…}}`, never shown to the model, never written to the report.

### 1.3 Three input levels (the brief can be anything)

| Level | The user gives | What the tool does | Exists today? |
|---|---|---|---|
| **0 — "Check this site"** | nothing; one button | crawl from the current (logged-in) tab, visit every reachable page, run the Tier-0 oracles + dead-click oracle + one visual check per page, report *health + coverage* ("checked 11 pages, 84 controls; 2 problems") | No. `spike map` crawls unauthenticated with no verdict; discovery never becomes runs. (A7, A17, A24) |
| **1 — a sentence** | "make sure checkout works" | today's brain→goals→navigator loop | Yes, once A1/A2/A6 are fixed |
| **2 — a document** | a pasted PRD / story list / verbal notes | the brain decomposes it ONCE into a flow checklist, **shows the checklist for a yes** ("I'll test these 9 flows — go?"), runs each flow as its own budgeted run sharing login state, aggregates into one report with per-flow verdicts | No. One free-text string is the entire input surface. (A7, A8) |
| **3 — expert** | explicit steps, `--spec`, suite file, recorded scripts, CLI flags | precise, deterministic, CI-shaped | Partially — the suite runner only replays already-recorded scripts; `spike suite` is not a command. (A22) |

Level 2 is the bridge between "vague" and "full control": the user reviews a checklist, not a script. That checklist is also the seed of their regression suite (every flow that passes gets recorded → "Saved tests" → nightly replay at $0).

### 1.4 The result card a non-engineer can act on

- **Verdict in one line** in their words: *"Checkout is broken: pressing 'Place order' shows an error instead of a confirmation."*
- **The screenshot of the failing step, inline.** It is already captured; nothing displays it. (A15)
- **"Whose fault?"** — every `uncertain` says whether the tool ran out of budget, couldn't log in, was blocked, or hit a tool error, and what to do. (A14)
- **Three buttons:** *Copy fix prompt* (exists, good) · *Send to my developer* (a zip: report + screenshots + clip; A15) · *Save as a test* (A19).
- **Coverage line on every non-pass:** "I got through 4 of the 9 flows" — so "Couldn't finish" is never a mystery. (A8)

### 1.5 Vocabulary rules for anything a non-dev sees

Never: daemon, CDP, bridge, BYOK, lite mode, navigator, brain, planner, oracle, metamorphic, invariant, rung, a11y, step budget, allowedHosts, env var names, audit IDs.
Instead: "Spike Core (optional desktop helper)", "your AI key", "the model that clicks / the model that plans", "safety checks", "look-only mode", "this site".

---

## 2. Findings (severity order)

Severity: **P0** = a user cannot reach a correct verdict, a silent wrong answer, a dead end, or a secrets leak · **P1** = works only with expert knowledge, or likely abandonment · **P2** = polish.

### P0

**A1 (P0) — Read-only is the default on every surface, has no switch on two of them, and skipped clicks are recorded as successes.**
`DEFAULTS.readOnly = true` (`src/config.ts:257`) and `DEFAULT_SETTINGS.readOnly = true` (`src/vibe/settings-data.ts:98`) flow unconditionally into the loop (`src/engine.ts:1005`; lite: `extension/sw.js:369,546`). Every mutating action is skipped and stamped `ok: true` with the prefix "read-only mode: skipped …" (`src/driver/loop.ts:1288-1291`, mutation set `:354-367`). Neither prompt is told read-only is on (`src/driver/planner-prompt.ts` has no `readOnly`), so the navigator re-issues the click, the identical-tree repeat detector fires (`loop.ts:1134-1141`), escalation budget burns (`MAX_BRAIN_ESCALATIONS = 2`, `:108`), and the run ends `uncertain` — or the brain concludes "login is broken" and returns **fail** on a working site. `spike run` has no `--live`/`--read-only` flag (`src/cli.ts:97-114`), `spike config set` cannot set it (`:310-314`), `qa_run` exposes only `task/url/maxSteps` (`src/mcp-server.ts:31-35`). The panel's prominent pre-checked "Allow the agent to click & type on this site" (`extension/panel.html:298-301`) only adds a host to `allowedHosts` (`panel.js:1705-1708`) — it does not touch `readOnly`; the real switch is buried in Settings → Debugging (`panel.html:201`). The repo's own e2e suites had to override it (`test/e2e.run-fixture.ts:28-34`: "the default made every action a no-op … this suite had been failing silently"). README:279 describes read-only as third-party-site-scoped, which is a *different*, weaker guard (`loop.ts:1171-1177`).
*User sees:* a list of green ticks that all say "skipped", then UNCERTAIN — after ticking the box that says the agent may click.
*Fix:* one consent switch per host = `readOnly`. For CLI/MCP with an explicitly named `--url`/`qa_run` target, default `readOnly:false` the same way `trustTargetHost` already relaxes hosts (`engine.ts:898`); add `--read-only` for the look-only case. Never record a skipped mutation as `ok:true`; tell the prompt when look-only is on.

**A2 (P0) — Two mutually exclusive cart relations gate the verdict: any site with a numeric cart badge is forced to FAIL.**
`detectRelationCandidates` proposes *both* `addItemIncrementsCount` (+1) and `removeItemDecrementsCount` (−1) from the same badge node (`src/assertions/metamorphic.ts:386-398`), both `confidence: 'reliable'` (`:147`). The loop checks them against first-vs-last snapshot counts (`src/driver/loop.ts:1693-1713`); any reliable relation with data present becomes severity `error` and `findStrictOracleViolation` forces `verdict:'fail'` (`:1725-1736`, `:2305-2318`) because `strictOracles` defaults true (`config.ts:278`). `after === before+1` and `after === before−1` cannot both hold, so at least one violates on every run; when the badge is unchanged (the common case, and guaranteed under A1) both do.
*User sees:* "FAIL — Expected 'cart' to go from 0 to 1 (delta 1), but it went to 0" on a healthy storefront, every time. This is the flagship demo flow.
*Fix:* never propose a relation and its inverse from one observation; only propose a count-delta relation when an add/remove action actually appears in the step history, and compare the snapshots around *that* action, not run-start vs run-end. Add a fixture variant with a cart badge to the e2e gate.

**A3 (P0) — Distribution is dead: every install path 404s, and the panel actively hands users the broken command.** *(owner-blocked, carried over)*
`npm view spike-agent` → 404; `https://raw.githubusercontent.com/uvesarshad/spike/main/install/install.sh` → 404; `https://github.com/uvesarshad/spike` → 404 (all re-verified 2026-09-12). All five install scripts (`install/install.sh:57-69`, `install.ps1:56-68`, `install-mac.command`, `install-win.bat`) and the panel's copy-paste block (`extension/panel.js:160-170`, `INSTALL_BASE`) funnel into `npm i -g spike-agent` with no fallback. Open since the 2026-07-14 audit (A1 there).
*User sees:* copies the "Connect Spike Core" one-liner, gets a curl 404 or `npm ERR! 404`.
*Fix:* publish `0.x` to npm and make the repo public (or move `INSTALL_BASE` to a host you control) **before** the extension ships; until then hide the Connect block behind a reachability probe of `INSTALL_BASE`.

**A4 (P0) — The panel's first two taps fail: "Save" doesn't save the key, and there is no first-run state.**
The key field has its own "Save key" button (`panel.html:96,157`; handlers `panel.js:1544-1557`); the modal's primary "Save" posts `config-set` only and discards a pasted key (`panel.js:1559-1585`); reopening shows an empty field (`:1231-1233` reflects only `hasKey`). There is no first-run/onboarding state — the panel opens onto three suggestion cards that *immediately start a run* (`panel.js:1715-1721`), which with no key errors: `Add your Brain (planner) API key in Settings — no "claude" key found (lite mode is BYOK; no daemon).` (`sw.js:511`, navigator variant `:518`), rendered as a plain red banner with no link into Settings (`panel.js:914-917`).
*Fix:* Save persists a non-empty key (or auto-save on blur); gate Run on "no key" with an inline "Add your AI key" CTA that opens the Navigator card; rewrite the error in plain English. Build the three-screen onboarding in §1.2.

**A5 (P0) — Typed passwords are stored and re-broadcast in plaintext, and the UI teaches users to type them inline.**
Step records keep raw `action.text` (`artifacts/2026-08-09_10-39-42-qaks/report.json` step 1: `"text":"pw"`). `humanizeStep` renders `typed "pw" into the "Password" textbox` (`src/vibe/fix-prompt.ts:26-27`), which lands in the panel's plain report *and* in the fix prompt's "Steps to reproduce" (`:280-282`) that users are told to paste into Lovable/Bolt/Cursor. The task string itself — where the textarea placeholder (`panel.html:296`: "Log in with test@demo.com / pw…") and the first suggestion card (`:278`) teach users to put credentials — is interpolated into every brain and navigator call (`planner-prompt.ts:175,234`), persisted in `report.json` (`src/report/report.ts:148`), written into the generated `.spec.ts` (`src/recorder/script.ts:606,610`) and `generated-tests/*.json` (`:188`), and echoed into `chrome.storage.local` history (`panel.js:1623-1628`). The vault is real and good (`src/vault/vault.ts:111-181`) but CLI-only: the bridge exposes only the five model-key names (`src/vibe/service.ts:63-69,381-405`), lite mode has no vault by design (`lite-engine.ts:5-6,246`), and `spike secret set <name> <value>` takes the value positionally into shell history (`cli.ts:638,648`). `audit.log` is correctly redacted (`src/report/artifacts.ts:8-9`) — the team knows how; it just isn't applied elsewhere. The product doc's "auto-redacted from screenshots and clips" (`docs/spike-agent-product-doc.md:76,88`) has no implementation in `src/clip/` or `src/report/`.
*Fix:* redact `type` text for secret-looking targets (password/token/card/otp) in `StepRecord` before write and in `humanizeStep`; add a "Test login (optional)" panel card backed by a new `vibe.secret.*` bridge method (and a lite-mode `chrome.storage` equivalent); change placeholder/suggestion copy to teach `{{secret:…}}`; add stdin entry to `spike secret set`; drop the screenshot-redaction claim from the doc until it exists.

**A6 (P0) — Post-success livelock: a cached page check that passes without changing the page replays every iteration until the step budget dies, and a working site is reported "Couldn't finish".**
Verified in current code: after an accepted cache hit the loop `continue`s (`src/driver/loop.ts:1033`), re-snapshots, `findForContext` returns the same record for the unchanged (url, goal, page) (`:948`), and a non-mutating `assert_dom` is re-executed with `ok:true` (`:985`). `finish` is explicitly never replayed from cache (`:955`), so the navigator — the only thing that can emit `finish` — is never called again. Real artifact: `artifacts/2026-08-09_15-57-01-lcwr/report.json` step 7 `finish: pass — completed all 5 goals`, step 8 the DOM check passes, steps 9–39 are 31 identical `cached: dom check…`, verdict `uncertain — step budget exhausted`.
*Fix:* stop the run once `finish` has settled the verdict; never replay a cache hit whose (page hash, action) pair equals the previous step's; collapse consecutive identical steps in the report.

**A7 (P0) — There is no way to give a PRD, a spec, a story list, or "test everything"; discovery output never becomes goals.**
The only input is one required positional string plus `--url` (`cli.ts:99-100`), `{task,url,maxSteps}` over MCP (`mcp-server.ts:31-35`), `{task,url,tabId,allowHost}` over the bridge (`service.ts:181-198`). No `--task-file`/`--spec`/stdin/array input; the task cannot be omitted. A pasted 3-page PRD is sent verbatim as one `TASK:` line on every model call (`planner-prompt.ts:175,234`) and compressed by the brain to "usually 2-6 goals" (`:194-201`, cap 12 at `actions.ts:251`), with no signal that ~95% was dropped. The app-model reaches the brain only as a ≤1200-char, 7-day-expiring hint framed "may be stale" (`loop.ts:164-209`); nothing iterates `model.routes` into goals or runs. `exploreInteractionGated` is a no-op seam whose only caller is a test (`src/discovery/discover.ts:5-12,46,120`); `diffAppModel`'s prioritized queue has no consumer beyond a terminal print (`diff.ts:42-46,99` → `cli.ts:253`); no generator writes a suite from discovery.
*Fix:* a spec-decomposition front door (`--spec <file>`, MCP `flows: string[]`, panel "paste a document" mode) that fans out to N runs with a user-confirmed checklist (§1.3 level 2); a route→goal generator over `app-model.routes` (§1.3 level 0).

**A8 (P0) — The budget ceiling makes whole-app testing structurally impossible and there is no orchestration above a single run.**
Global 40 steps (`loop.ts:101,562`), per-goal 12 not settable anywhere (`:105,563`), 2 brain escalations (`:108`), 12 goals (`actions.ts:251`), `maxGoalTransitions = goals.length + 24` (`loop.ts:905`). One realistic flow costs 5–10 steps, so 40 buys 4–6 flows; a 10-page SaaS needs hundreds. `spike suite` does not exist (`cli.ts:97-710`), and the suite runner only executes already-recorded scripts (`src/suite/config.ts:48`). `qa_run` caps `maxSteps` at 30 — *below* the default of 40 — while its description says "default 12" (`mcp-server.ts:34`); the same stale 12 is in `docs/overview.md:100` and `docs/infra/environment.md:130`. On exhaustion: "🤔 Couldn't finish / step budget exhausted before the task completed" (`fix-prompt.ts:117,137`; `loop.ts:550`) with no coverage statement and no resume.
*Fix:* a route/flow fan-out orchestrator (one budgeted run per flow, shared storage state, aggregated verdict); report "checked N of M" on every non-pass; fix the 12/30/40 mismatch in all four places.

**A9 (P0) — Apps behind a login: SSO popups are unreachable and email/OTP can never work, though the navigator is told it can.**
The port tracks only tabs *it* opened (`src/ports/cdp-browser.ts:117-131,542,584`); there is no `Target.setAutoAttach`/`targetCreated` handling, so a `window.open` from "Sign in with Google/GitHub" creates a target the driver never sees. `QaConfig.emailProvider` exists (`config.ts:208,280,395`) but no production call site injects a provider — `engine.ts:996-1008` and `lite-engine.ts:236-247` pass none — so `wait_for_email` always fails at `loop.ts:1452-1454`, even with `SPIKE_EMAIL_PROVIDER=fake-local`. The only implementation is an in-memory test double (`src/email/fake-local.ts:20-59`); `{{run.email}}` is hard-wired to the undeliverable `@example.test` (`src/run-data/state.ts:29-41`). The navigator prompt and schema nevertheless advertise the verb (`planner-prompt.ts:91`, `actions.ts:137`), so the model plans it and burns a failure. The saving grace is accidental: the extension attaches to the user's already-logged-in tab (`sw.js:425-438`), so login is often unnecessary there.
*Fix:* auto-attach new targets and expose them to `switch_tab`; until then detect a popup-auth button and fail with "SSO popups aren't supported yet — log in first, then run". Either ship one real inbox provider (IMAP or a disposable-inbox API) and wire `cfg.emailProvider` through `engine.ts`, or remove `wait_for_email` from prompt and schema. Document "test on your logged-in tab" as the primary strategy.

**A10 (P0) — Closing the side panel loses the result; a service-worker eviction is detected and then thrown away.**
Results reach the UI only via `broadcastToPanels` (`sw.js:210-218`); with no open port the `done` payload is dropped (`:561`). History is written by the panel, not the SW (`panel.js:981-986`); `lastLiteBundle` is stored and never read (`sw.js:451`). Separately, the SW computes `orphanedRun` on cold start (`sw.js:489-496`) and sends it in every status reply (`:686-691`), but the panel reads only `msg.busy` (`panel.js:350-352`) and polls status only at init/reconnect (`:1724-1730`).
*User sees:* closes the panel to watch the page, reopens — no verdict, no history row, no fix prompt. Or the feed freezes mid-step and silently flips to idle.
*Fix:* persist the last `done` payload to `chrome.storage.session` and replay it to a reconnecting panel; render `orphanedRun` as "Your last test stopped when Chrome put the extension to sleep — run it again."

**A11 (P0) — Auto-fix from the panel can never pass its own consent gate, and cannot serve its target audience.**
`ensureAutoFixConfirmed` (`src/vibe/auto-fix.ts:135-165`) needs prior on-disk acceptance, `confirmed:true`, or a y/N prompt on the *daemon's* TTY. The panel's button (`panel.js:1092-1111`) → `sw.js:626` sends `vibe.fix` with `{}` — never `confirmed`. Under `--install-service` (non-interactive) every panel auto-fix throws `AutoFixNotConfirmedError` whose text tells the user to pass `--yes-auto-fix` (`panel.js:1132` shows it raw); in a real terminal the button hangs forever on a keypress nobody sees. There is no project-directory picker; `dispatchFix` uses `cfg.fixAgentCwd ?? process.cwd()` (`auto-fix.ts:309`); `detectFixAgent` requires `claude`/`codex`/`gemini` on PATH (`:199-209`). A Lovable/Bolt user has no local code and no CLI agent.
*Fix:* a confirm modal in the panel that sends `confirmed:true`; a project folder field in Settings (daemon-side picker or path entry); hide/relabel the button when no fix agent is detected and say plainly "needs a local coding agent — otherwise use Copy fix prompt".

**A12 (P0) — Replay never resolves vaulted secrets, so credentialed regression tests always fail and silently fall back to a paid AI run.**
`ReplayOptions.vault` exists (`src/recorder/replay.ts:25-31`) and the script runner *does* resolve `{{secret:…}}` when given a vault (`src/driver/script-runner/executor.ts:15-21`), but neither engine call site passes one — both are `{ onProgress: progress }` (`src/engine.ts:1294,1304`). A recorded login types the literal `{{secret:PASSWORD}}`. Because `qaRun` falls back to a fresh AI pass when a matched replay fails (`engine.ts:831-845`), the symptom is "my free tests always cost money", not an error.
*Fix:* pass the vault from both call sites; make a replay-time unresolved-secret a loud, distinct failure rather than a silent fallback.

### P1

**A13 (P1) — Stale and misleading model copy: "cloud free tier", Nano pin shown while a paid model drives, dead-tier CLI hint, Nano as the daemon default.**
Panel: "On-device AI: unavailable — testing still works via cloud free tier" (`panel.js:472,477,522`; `panel.html:31`) — lite mode has no free rung at all (`lite-engine.ts:113-118`) and the Gemini CLI free tier died 2026-06-18. `resolvedNavigatorName` is computed honestly (`lite-engine.ts:143-161,192`) but never rendered; the panel shows the raw pin (`panel.js:1342-1344,1376`). CLI: the no-planner error still says "install the Google CLI (free quota)" (`src/router/model-router.ts:527-530`). Daemon default navigator is `nano:ondevice` (`config.ts:274`) and `SettingsStore.readRaw` migrates missing navigators *to* nano (`settings.ts:105-116`) — the same Nano the repo marks Experimental; when Nano is unavailable the ladder silently falls through to the user's Sonnet key for *every* step (`engine.ts:945`), evaporating the cost lever. Lite got this right (`settings-data.ts:78-92`).
*Fix:* "On-device AI isn't available on this computer — tests will use your AI key"; render the resolved navigator ("actually using: claude-haiku-4-5"); fix the hint string; make the daemon default navigator the cheap cloud tier of the configured brain provider, with a loud warning on nano fall-through.

**A14 (P1) — `uncertain` and provider errors surface as internal strings, with no "your app vs the tool" attribution.**
Reasons flowing verbatim into the plain report (`fix-prompt.ts:137`): "step budget exhausted before the task completed" (`loop.ts:550`), "goal transitions (N) exceeded the bound…" (`:1080`), "read-only mode: <host> is not in allowedHosts — add it via SPIKE_ALLOWED_HOSTS or spike.config.json" (`:1668-1670` — unreachable instructions for a panel user, and mislabelled "read-only"), "spend cap reached … see LoopOptions.spendCapUsd" (`:923-925`), "stuck: … the planner offered no new plan" (`:754`). A wrong key yields `anthropic api 401: {"type":"error",…}` (`src/router/adapters/anthropic.ts:101`) truncated into a step row (`loop.ts:884-889`) and then into the verdict reason (`panel.js:939-940`); 429 is the same shape. Nothing says "fix your key in Settings" or "this is not a bug in your app".
*Fix:* a reason-translation layer keyed on the known constants, each mapped to a plain sentence + attribution + next action; map 401/403/429 to "Your AI key was rejected / your AI provider is rate-limiting — check Settings"; make a cross-host hop a one-click "allow <host> and re-run".

**A15 (P1) — No screenshot is ever shown, lite mode yields zero downloadable evidence, and the fix prompt cites screenshots by bare filename.**
`panel.js` has no reference to `.png`, `screenshot` or `evidence_paths`. `BrowserArtifactStore.exportBundle()` exists (`extension/lite-engine.js:14644`) and `lastLiteBundle` is set for "a future download affordance" (`sw.js:451`) — nothing calls either. The daemon-gated "Download clip" (`panel.js:1024-1038`) is the only visual. `buildFixPrompt` emits `- Screenshot: step-06.png` (`fix-prompt.ts:311-318`), meaningless to a web-based coding tool. `spike dashboard` (`cli.ts:832-865`) shows model traces but no images either.
*Fix:* inline the failing-step screenshot in the result card; a "Send to my developer" zip (report + screenshots + clip) in both modes; either embed a small data-URI thumbnail in the fix prompt or drop the filename line.

**A16 (P1) — The "button does nothing" oracle is computed on every click and discarded.**
`verifyActionEffect` already returns "click produced no targeted effect on its own target, the URL, or an alert/status/dialog region" (`src/cache/action-cache.ts:348-370`) and runs on every successful click (cache on by default, `config.ts:245`), but the result only decides whether to write a cache entry; `effect.ok === false` leaves the step `ok:true` (`loop.ts:1552-1567`). The most common vibe-coded bug — an unwired submit button — passes silently.
*Fix:* push a `dead-interaction` invariant at `warn` (promote to `error` after measuring false positives) so it reaches the report, the prompts and the verdict gate.

**A17 (P1) — Detection ceiling: a vague run is a page-health smoke test, not functional QA; the precise assertion verbs are unreachable; lite mode loses the DOM oracles.**
Caught by default (`collectInvariants`, `loop.ts:1548`; `src/assertions/invariants.ts:109-127,131-156,175,215-224,262-277,312-321,355-388`): uncaught JS errors, same-origin 5xx, rendered `undefined`/`NaN`, broken images, duplicate ids, empty `<main>`, plus one final visual verdict. Not caught: wrong price/number, raw i18n keys, a form that fails with HTTP 200 and no console output; 4xx is `warn` only (`invariants.ts:142-148`); cross-origin API failures are filtered (`:133`). The six precise verbs (`assert_text/count/url/state/network/no_console_errors`) are implemented (`src/assertions/dom-assertions.ts:386-401`) and gate `strictOracles`, but appear in no prompt (`planner-prompt.ts:92-93,132-133` teach only `assert_dom`/`assert_visual`) and cannot be authored from CLI, suite config or recorded scripts. `ExtensionBrowser` implements no `probeInvariants`, so lite/vibe mode loses every DOM-level Tier-0 check. `InvariantConfig.disabled/allowText` is never plumbed (`loop.ts:456,459`).
*Fix:* teach the six verbs with one example each; add a user-authorable "expect…" block (panel: optional "What should be true at the end?"); implement `probeInvariants` on `ExtensionBrowser`; plumb the allow-list.

**A18 (P1) — Safety and cost switches are buried under "Debugging", in engine vocabulary, next to options that cannot work.**
Read-only, spend cap, strict oracles and video assertions live in a collapsed accordion titled "Debugging" (`panel.html:166-227`); copy includes "metamorphic-relation mismatch", "strict oracle mode", "$0-first" (`:191,212-213`). The Brain dropdown offers "Ollama — Advanced" and a "CLI" radio unconditionally (`:128,138-142`) though `liteUsable` (`lite-engine.ts:183`) is never read by the panel; picking Ollama passes the key check (`sw.js:314,510`) and limps to `uncertain`. The "Same as Navigator" note names the navigator's cheap model as the brain's (`panel.js:1266-1268`) while a blank brain model resolves to Sonnet (`settings-data.ts:127`). Live progress leaks "rung 0: Gemini Nano unavailable…", "navigator: claude · brain: claude (BYOK; lite mode — no daemon)", a run UUID (`lite-engine.ts:223,230,234`).
*Fix:* rename to "Safety & cost", move look-only + spend cap to the top level, plain copy per §1.5; filter providers/modes by `liteUsable` in lite mode; fix the brain label; humanize progress lines.

**A19 (P1) — The panel never creates a regression test, and there is no saved-tests / replay / heal UI.**
`record: false` is hardcoded for every panel run (`service.ts:456`) while CLI/MCP record on pass (`engine.ts:1087-1089`). "Recent runs" stores `{ts, task(80), verdict, reason(120)}` (`panel.js:1621-1674`); clicking re-fills the textarea and launches a fresh paid AI pass (`:1666-1670`); it cannot reopen a report. Yet the panel still *consumes* `generated-tests/` via the pre-run matcher (`engine.ts:813`).
*Fix:* record panel runs; a "Saved tests" card with re-run ($0) / heal; history entries that store the slim report and re-render the result card.

**A20 (P1) — A permanent "disconnected" state, an unexplained debugger banner, and a site-map card that tells lite users to open a terminal.**
Grey/red dot titled "Daemon not connected" forever for the lite majority (`panel.html:13`, `panel.js:426-428`); the warn variant reads "Desktop app is outdated and can't run tests reliably" (`panel.html:36`). `chrome.debugger.attach` (`sw.js:812-818`) raises Chrome's "started debugging this browser" bar; nothing explains it, and dismissing it ends the run with the bare "Chrome's debugging session was closed" (`sw.js:1299` → `:558`). `siteMapSection` is never hidden (`panel.html:353`) and without a daemon always renders `Run "spike map https://…" in a terminal` (`panel.js:652`; `sw.js:662,673`).
*Fix:* a neutral "Lite" chip instead of an off dot; a one-line pre-run note about the banner plus a "Run again" CTA on that error; hide the site-map card unless the daemon is healthy.

**A21 (P1) — No preflight, and the only "what will run" view is incomplete and mislabelled.**
There is no `spike doctor`/`init` (13 commands: run, bless, map, coverage, fixture, config, replay, daemon, fix, secret, mcp, nano, dashboard). `spike config show` prints only the *brain* under the heading "Browsing-control AI (planner)" (`cli.ts:45-68,307-308`) — the navigator is the one that browses; there is no navigator flag on `config set` (`:310-345`); `readOnly`, `via`, `allowedHosts`, and live adapter availability (CLI on PATH? Nano state?) are not printed. Five config layers (flags > env > `settings.json` > `spike.config.json` > defaults, `config.ts:452-459`) plus a sixth (extension `chrome.storage`) with no single resolved view.
*Fix:* `spike doctor` (Chrome found, Nano state, each configured adapter actually available, effective read-only/via/hosts); `config show` prints Navigator and Brain by those names plus the resolved effective run config; `--navigator-*` flags.

**A22 (P1) — `spike suite` is not a command; the suite file is not human-authorable; `--reporter json --out` writes nothing.**
Suite runs only as `spike replay --all` (`cli.ts:372`). `spike.suite.json` has six fields (`src/suite/config.ts:48-58`), `.strict()`; `script` must name an already-recorded artifact; no task text, per-case URL or credentials; `needsAuth` is validated and read by nothing. `buildJsonSummary` has no caller outside a test (`src/suite/reporters.ts:43`; flag accepted at `cli.ts:556`) — a CI job asking for a JSON artifact gets no file and a green step.
*Fix:* `spike suite` over `cases: [{name, url, task}]`; wire or reject `--reporter json`.

**A23 (P1) — Common real-site patterns have no action or guidance: no scroll, viewport-only screenshots, no cookie/consent rule, cross-origin iframes invisible.**
`mouse` dispatches only move/down/up (`actions.ts:31`, `cdp-browser.ts:536`) — no scroll/wheel; infinite scroll and below-the-fold content are unreachable. `Page.captureScreenshot` has no `captureBeyondViewport` (`cdp-browser.ts:802`), so the visual verdict only ever judges the top of the page. A grep for cookie/consent/banner/modal/dialog/popup/overlay across `loop.ts` finds one unrelated hit (`:774`). `Accessibility.getFullAXTree({})` has no frame handling (`src/capture/axtree.ts:258`), so Stripe Checkout, Auth0, reCAPTCHA, Intercom are unreachable (open shadow DOM does work). `upload_file` needs real local paths the model cannot know (`planner-prompt.ts:94`).
*Fix:* a `scroll` action; full-page verdict screenshots; a "dismiss consent/cookie banners first" rule; OOPIF target attachment; a fixture-file provisioner for uploads.

**A24 (P1) — `spike map` renders no judgement, cannot see behind a login, and is blind to client-rendered SPAs.**
`map` takes no task and exits 0 unconditionally (`cli.ts:231,260,264`); `AppModel` has no verdict (`src/discovery/app-model.ts:60-65`); HTTP status is recorded, never evaluated (`crawler.ts:155`); no console/network capture. The fetcher is bare `fetch` with no cookies and no `--storage-state` (`cli.ts:153-162`); frontier is `<a href>` only (`html.ts:184-206`); SPA routes come only from sitemap/robots/Next.js source (`static-routes.ts:74-113`) — a client-rendered SPA yields one route.
*Fix:* crawl through the driver (the user's logged-in tab) rather than `fetch`; evaluate statuses into findings; add router-config/bundle route extraction. This is the engine for §1.3 level 0.

**A25 (P1) — Storage state is CLI-only and written world-readable.**
`--storage-state`/`--save-storage-state`/`--auth-fixture` are well built (`engine.ts:424-483`, `cli.ts:109-110,385-387`) but `saveStorageStateFile` writes with no mode restriction (`engine.ts:491-494`; contrast the vault's `0o600` at `vault.ts:156-157`) and is not reachable from the panel (`service.ts:450-460`). The CDP profile carries login state between unrelated runs (`config.ts:234`, `launch.ts:235`) while `--via playwright` uses a fresh context (`playwright-browser.ts:225`).
*Fix:* `0o600`; expose "remember my login for tests" in the panel; document the transport divergence.

**A26 (P1) — The first suggestion card cannot succeed.** "Log in with the demo credentials and verify the dashboard loads" (`panel.html:278`) — no credentials field exists, lite has no vault, `{{secret:…}}` fails by design (`lite-engine.ts:246`). With A1 it is a guaranteed-fail first impression.
*Fix:* suggestions that need no secrets ("Check the signup form rejects a bad email", "Find anything broken on this page"), and the credentials card from A5.

**A27 (P1) — No Cursor MCP instructions; two different registration forms.** README names Cursor as a target but shows only `claude mcp add …`; `cli.ts:673` recommends `command 'spike', args ['mcp']` while README recommends `node dist/mcp-server.js`.
*Fix:* one canonical form + a Cursor `mcp.json` snippet.

### P2

**A28 (P2) — Internal audit IDs leak into `--help`.** `(A47)`, `(A45)`, `(A16)`, `(A3)`, `(A7)`, `(A6)`, `(A25)` in `run`/`replay`/`fix`/`map` descriptions (`cli.ts:98,103,113,375-387`).

**A29 (P2) — The "plain" report is raw markdown in a `<pre>`, ends with a "Cost:" line, and duplicates steps.** `renderPlainReport` emits `## ❌ …`/`**What I did:**` (`fix-prompt.ts:112-131`) into `textContent` (`panel.js:940`); the trailing cost line is engine-speak for this audience; consecutive identical steps print 30+ times (see A6).

**A30 (P2) — `spike run` prints JSON regardless of `--json`.** `console.log(JSON.stringify(slimReport…))` is unconditional (`cli.ts:137-138`); `renderPlainReport` is never used by the CLI.

**A31 (P2) — Stale/unsafe model table.** OpenRouter defaults are a generation behind (`settings-data.ts:117,132`); `gpt-4o-mini` vision is weak for a navigator; the table has no date or test.

**A32 (P2) — No way to remove a saved key from the panel.** `clear-key` exists in the SW (`sw.js:751-764`) with no UI.

**A33 (P2) — Coverage under-reports by an unknown amount and drives nothing.** Discovery names come from HTML attributes, run names from the AX tree, so they rarely match (`src/discovery/record-coverage.ts:36-52`); routes the run reached but the map never saw are dropped (`:28-33,118-121`); nothing schedules work from the gap.

**A34 (P2) — Dead capability and doc drift.** `checkAxInvariants`, `checkPaginationUnion`, `compareEnvironments` are test-only (`invariants.ts:444`, `metamorphic.ts:250`, `differential.ts:370`); `DiffMask` is documented as required and never plumbed (`engine.ts:1048,1051`). Invariants never reach any prompt (`planner-prompt.ts:51-64`; zero `invariant` refs in `src/vibe/*`). `visibleErrorText` matches English "error"/"invalid" only (`loop.ts:522-537`). `loop.ts:444-449` still says invariants are "non-fatal … fed to the planner"; `engine.ts:1022-1027` says metamorphic execution "is not wired" (it is, `loop.ts:1693`); `engine.ts:658-660` says Nano is never a plan-step candidate (it is, `nano.ts:25,37`); README:279 misdescribes read-only.

**A35 (P2) — `--json` output is unversioned.** `slimReport` (`report.ts:192`) has no `schemaVersion`; exit codes (0/1/2/3, `cli-exit-codes.ts`) are the only documented contract.

**A36 (P2) — Minor copy.** "Open the page you want to test in this tab." reads as an error (`panel.html:272`); "third-party site — the agent will interact with it as you" is amber alarm for the normal case (`panel.js:742`); restricted pages surface raw `attachDebugger` text (`sw.js:810`); `strictOracles` has no `config set` flag; `perGoalMaxSteps` has no surface at all.

---

## 3. Capability matrix (today)

| Input type | Status | Why |
|---|---|---|
| Precise flow, expert user (`SPIKE_READ_ONLY=0`, `--storage-state`, vaulted secrets) | **Works** | the loop, ports, oracles and recorder are solid once the expert disables read-only and pre-supplies a session (A2 still bites on cart badges) |
| Precise flow, default invocation (panel / `spike run` / `qa_run`) | **Broken** | A1 skips every click; A2 forces fail on a cart badge; A6 can turn a pass into "couldn't finish" |
| Vague sentence ("test my site", "find bugs") | **Partial** | 2–6 invented goals + a real page-health smoke test; dead buttons, wrong prices, silent save failures pass undetected (A16, A17) |
| App behind a login | **Partial → No** | plain same-page email+password works with the password in cleartext (A5); SSO popups and email/OTP are structurally impossible (A9) |
| PRD / spec / user-story list | **No** | one free-text string is the entire input surface (A7) |
| "Test everything" / no input | **No** | task is required; `map` is unauthenticated and verdict-less; discovery never becomes runs (A7, A24) |
| Non-technical user authoring a regression suite | **No** | `spike suite` doesn't exist; panel never records; no saved-tests UI (A19, A22) |

---

## 4. What is genuinely strong (keep, and say so in marketing)

1. **The navigator/brain split is real and the cost math holds** — five well-reasoned stuck conditions, escalation budget resets on any landed action (`loop.ts:1603-1627`), an effect-aware repeat detector (`:1134-1141`).
2. **Failure containment** — every crash still yields a persisted, evidence-bearing report (`loop.ts:1739-1751`); every CDP and LLM call has a deadline; sessions close on init throw (`engine.ts:963-966`).
3. **Secret handling inside the driver is correct by construction** — resolved only at execute time into a spread copy; placeholders preserved in step record, audit log, cache key and recorded script (`loop.ts:1385-1387,2277-2288`). The leak (A5) is in the surrounding surfaces, not the core.
4. **Driving the user's own logged-in tab** (`sw.js:425-438`) sidesteps the entire auth problem for the non-technical user. It should be the documented strategy, not a side effect.
5. **Token discipline everywhere** — history capped at 20, evidence at 8 lines, AX tree ~1.5K tokens with focus-preserving truncation (`axtree.ts:176-224`), ~2K verdict contract honoured.
6. **The live step timeline in the panel** (`panel.js:809-874`) — a non-technical user can follow it without knowing anything.
7. **The fix prompt** — steps to reproduce, expected, evidence, root-cause heuristics, and real prompt-injection hardening (`fix-prompt.ts:257-264`). The fail-reason prose is unusually good.
8. **Honest daemon gating** — auto-fix and clips refuse cleanly with an explanation rather than pretending (`panel.js:1290-1334`).
9. **Exit-code contract** (0/1/2/3) and MCP error forwarding — a coding agent gets the real message on infra failure.
10. **Config precedence** is careful and well-commented (`config.ts:452-459`); install scripts are Node-gated and idempotent — only the unpublished package stands in their way.

---

## 5. Feature suggestions, enhancements & upgrades

### Onboarding & first run
- **E1 — Three-screen first run** (§1.2): one key with provider auto-detect from prefix, current tab, one consent switch. Provider-matched tiers already exist; the panel stops asking twice.
- **E2 — "Check this site" button (level 0)**: crawl through the driver from the logged-in tab → per-page Tier-0 + dead-click + one visual check → health + coverage card. Reuses `discovery/`, `invariants.ts`, `verifyActionEffect`.
- **E3 — "Test login (optional)" card** backed by the vault (`vibe.secret.*`), teaching `{{secret:…}}` by construction; lite-mode equivalent in `chrome.storage`.
- **E4 — `spike doctor`** and a resolved-config view that names Navigator and Brain and probes real availability.

### Input flexibility (the "vague brief" promise)
- **E5 — Document intake (level 2)**: paste a PRD / story list / notes → brain decomposes ONCE into a flow checklist → user confirms → N budgeted runs sharing login state → one aggregated report with per-flow verdicts. `--spec <file>` on the CLI, `flows: string[]` on MCP.
- **E6 — Route/flow fan-out orchestrator**: one run per discovered route or confirmed flow, aggregated verdict, coverage line on every non-pass. Lifts the 40-step ceiling without touching the loop.
- **E7 — Implement the AI exploration pass** in the `exploreInteractionGated` seam under a step budget (modals, wizards, auth-gated surface), as the options doc already recommends.
- **E8 — Optional "What should be true at the end?" field** → the six precise assertion verbs, which the prompt should also teach.

### Detection quality
- **E9 — Promote the dead-click oracle** (highest value per line in the codebase).
- **E10 — Semantic checks for vibe-coded apps**: raw i18n-key detector, "NaN/undefined in a price" on numeric-looking nodes, form-submit-with-no-effect (HTTP 200, no DOM change).
- **E11 — Tier-0 oracles in lite mode** (`probeInvariants` on `ExtensionBrowser`).
- **E12 — Metamorphic relations only from observed actions**, with a cart-badge fixture in the e2e gate.

### Output & trust
- **E13 — Result card v2**: inline failing screenshot, one-line verdict in user words, "whose fault" attribution on every `uncertain`, three buttons (Copy fix prompt / Send to my developer zip / Save as a test).
- **E14 — Reason translation layer** for every internal `uncertain` constant and every 401/403/429.
- **E15 — Redaction pass**: secret-looking `type` text in `StepRecord`, plain report, fix prompt, history, generated tests; pixel-blur on password-field screenshots (or drop the doc claim).
- **E16 — Reopenable history** storing the slim report; "Saved tests" card with $0 re-run and heal.
- **E17 — CLI prints the plain report by default**, JSON only with `--json`; add `schemaVersion`.

### Login & real-site coverage
- **E18 — One real inbox provider** (IMAP or a disposable-inbox API) wired through `engine.ts`; unlocks signup, magic link, reset, 2FA.
- **E19 — Popup/OOPIF target attachment** for SSO and embedded payment/auth widgets; interim: detect and explain.
- **E20 — `scroll` action, full-page verdict screenshots, cookie-banner rule, fixture-file provisioner for uploads.**
- **E21 — "Remember my login for tests"** in the panel (storage state, `0o600`).

### Distribution & platform
- **E22 — Publish + public repo (or self-hosted `INSTALL_BASE`)** before the extension ships; hide the Connect block behind a reachability probe until then.
- **E23 — Native signed installer** (.dmg/.exe bundling Node) — still the only thing that removes both daemon frictions; cost it (carried from 26-07-14).
- **E24 — `spike suite`** with plain `cases: [{name, url, task}]`; wire `--reporter json`.
- **E25 — Cursor/Windsurf/Codex MCP snippets** and one canonical registration form.
