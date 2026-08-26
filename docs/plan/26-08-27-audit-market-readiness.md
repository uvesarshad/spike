# Audit — Market / Open-Source Readiness (2026-08-27)

> Scope: full v0.2 branch — core engine (driver/router/ports/recorder/cache/assertions/suite/discovery), extension + daemon + vibe surface, security posture, release engineering (build/tests/CI/npm packaging), and open-source hygiene (secrets, docs, licensing, community files).
> Method: five parallel code-verification agents reading source directly (not docs claims), cross-checked against the prior audits (`26-07-14-audit-perf-security.md`, `26-08-08-audit-deterministic-speed.md`). Build, typecheck, the 31-suite fast test bucket, `npm pack --dry-run`, and a fresh-clone `npm ci` were actually executed (all green).
> Severity: **P0** = broken / at-risk (blocks launch), **P1** = should-fix before or immediately after launch, **P2** = nice-to-have.

## Verdict up front

**Not ready to publish today — but closer than it looks.** The architecture is real: the navigator/brain split works end-to-end, the bridge security model (localhost bind + Origin rejection + pairing token + per-handler auth) held up under adversarial review with **zero security P0s**, no secrets or personal data exist anywhere in the tree or git history (no history rewrite needed), and the pure-logic half of the codebase builds, typechecks, and passes all 31 fast suites reproducibly from a clean clone.

The blockers cluster into three groups:

1. **Reliability of the engine under stress** (A2–A6): the $0 first-run path is functionally broken, two hang classes can wedge unattended runs forever, one bug can click the wrong element and report success, and a CDP throw can kill a run without writing a report.
2. **The "autonomous QA" verdict is still 100% model judgment** (A1): the entire deterministic-oracle layer (Tier-0 invariants, assertion verbs, differential baselines, metamorphic relations) is computed but never gates pass/fail.
3. **Release plumbing has never been exercised** (A8–A12, A14–A15): `main` is ~15,700 lines behind this branch, CI has never run once on GitHub, the privacy policy is an unfilled template, and Web Store approvability of `debugger` + `<all_urls>` is an untested hypothesis.

Decisions that belong to the product owner, not engineering: **A13** (third-party site references), **A38** (how much business strategy to open-source), **A55/A56** (npm name check, launch version number), and the Web Store submission timing (A15).

---

## P0 findings

### A1 (P0) — The deterministic-oracle layer never gates the verdict; pass/fail is still pure model judgment
`src/driver/loop.ts:360-365` documents it explicitly: Tier-0 invariant violations (rendered `undefined`/`NaN`, broken images, same-origin 5xx) are advisory evidence only. Failed precise assertions (`assert_text`/`assert_count`/`assert_url`/`assert_state`/`assert_network`) mark only that step `ok:false` — nothing forces the run's final verdict. Differential baselines (`compareToBaseline()`, `engine.ts:986-991`) are evidence-only; metamorphic `checkRelation()`/`RELATIONS` are **never invoked anywhere** — detection-only. Consequence: the product's own flagship demo bug (`order.total` undefined) is not enforced deterministically; a model that doesn't notice its own failed step yields a false **pass**. This is the core of the "autonomous QA pillar" the product claims. Fix: make error-severity Tier-0 violations and failed assertion verbs force `fail` (or add a `strictOracles` config defaulting on), and either wire `checkRelation()` or delete the metamorphic module.

### A2 (P0) — The navigator-only ($0, no-key) degrade path is broken under any stress
`src/driver/loop.ts:521-535`: with no `plan-goals` adapter, `escalate()` unconditionally returns `'end'`. Navigator-only mode = one implicit goal, and the per-goal budget is `min(maxSteps,12)` — so 12 steps, or a single `blocked`/3×-repeat/invalid-JSON event, terminates the entire run at `uncertain`, not the documented 40-step budget. This is the mode a fresh user with no subscriptions/keys hits first; their first impression will be premature `uncertain` verdicts. Fix: in the no-brain branch, only end on genuinely terminal signals; reset `stepsInGoal` on bare per-goal overflow.

### A3 (P0) — Mid-batch node-map clobber can click/type the wrong element and report success
`src/driver/loop.ts:1620-1643` + `src/ports/cdp-browser.ts:168-172` / `playwright-browser.ts:412-416`: a batch of up to 3 actions resolves against one snapshot, but `executeWithRetry`'s recovery re-snapshot **overwrites the port's live `nodeMap`**; later actions in the same batch resolve their ids against the new tree. Ids are sequential, so a coincidentally-existing id silently hits a different node with `record.ok: true`. A false-success wrong-element interaction is the worst failure mode a QA tool can have. Fix: resolve all batch targets to `backendDOMNodeId` up front, or invalidate the rest of the batch on any re-snapshot.

### A4 (P0) — Two hang classes can wedge a run (or the whole router) forever
(a) `src/ports/cdp-browser.ts:114-118, 163-166`: `assertMutationAllowed` (before every mutation) and `url()` have no timeout — a page stuck in a synchronous JS loop (exactly the bug class this tool exists to catch) wedges the run; no `Inspector.targetCrashed` watchdog exists. (b) `src/router/adapters/google-cli.ts:98-108`, `cli-planner.ts:82-92`: the `--version` availability probe has no timeout; a hung probe never resolves, the TTL cache is never written, and **every subsequent router call hangs too** — a full-ladder deadlock. Fix: wrap both in `withTimeout` (the helper already exists and is used for axTree/screenshot/LLM calls).

### A5 (P0) — An early-exiting CLI child can crash the entire daemon/CLI process
`google-cli.ts:170-174`, `cli-planner.ts:150-154`: `child.stdin.end(stdinText)` has no `'error'` listener. If the shelled binary exits early, EPIPE/`ERR_STREAM_WRITE_AFTER_END` is an uncaught exception killing the whole process — for daemon users, killing every connected panel's session. Fix: `child.stdin.on('error', ...)` swallow-and-classify.

### A6 (P0) — A CDP throw mid-run crashes without ever writing report.json
`src/driver/loop.ts:487, 557, 562, 708-710, 779, 959, 1372` call `browser.url()`/`axTree()` unguarded; nothing above `runDriverLoop` catches (engine.ts has only a `finally`). Most likely trigger is inside `escalate()` — the code path that exists to recover from a broken page. The caller gets a rejection and **no artifact** instead of an `uncertain` report with evidence. Fix: wrap `runDriverLoop`'s body so any throw still persists a minimal report.

### A7 (P0) — The panel's interaction-consent checkbox silently re-arms itself
`extension/panel.js:579-594` (`refreshConsent`) unconditionally sets `consentToggle.checked = true`, and it runs from `renderTabCard()` on **any** `tabs.onUpdated` event (favicon load, title change). A user who explicitly unchecked "Allow the agent to click & type on this site" — the only opt-out of target-host trust in the panel, per `src/vibe/service.ts` — has that choice silently reverted before `startRun()` reads it (`panel.js:1551`). Fix: default-check only on first render per (tab, host); never override after user interaction for the current host.

### A8 (P0) — `main` is ~75 files / ~15,700 lines behind `v0.2`; the public installer pulls from `main`
`git diff --stat main v0.2`. `install/install.ps1` / `install.sh` and the panel's "Connect Spike Core" one-liner fetch from `raw.githubusercontent.com/.../main/install`. Going public as-is means the default branch and the install path serve a stale, pre-wave-1–5 product on day one (and this exact class of drift already caused a 404 once — `docs/plan/26-07-14-tasks-non-tech-onboarding.md:7`). Fix: fast-forward/merge `main` to v0.2 before flipping the repo public.

### A9 (P0) — CI has never run once on GitHub
`git log origin/main` stops at `7a7051b`; `gh run list` is empty — the v0.2 line including `.github/workflows/ci.yml` itself is local-only. Everything the workflow claims is untested against the real Actions environment. Fix: push the branch, get one genuinely green run, fix what breaks (see A31 — the fast bucket currently needs a real Chrome, so the first run may fail).

### A10 (P0) — Chrome binary path is hardcoded with zero override
`src/chrome/launch.ts:12-23`: fixed candidate list, no `SPIKE_CHROME_PATH`/`CHROME_PATH` escape hatch anywhere in `src/`. Any Linux user with Chromium/snap/flatpak/Chrome-for-Testing, or any non-default install location on any OS, gets a hard throw with no workaround. The single most likely day-one failure for open-source adopters. Fix: check an env/config override before the candidate list (trivial).

### A11 (P0) — PRIVACY.md is an unfilled template, and the Web Store hard-requires it
`PRIVACY.md:3-4,81,89` still contains `[EFFECTIVE DATE]`, `[LEGAL ENTITY / PRODUCT NAME]`, `[CONTACT EMAIL]`, `[13/16 — per your jurisdiction]` placeholders; `docs/chrome-web-store-submission.md:92` links this exact file as the Store's privacy-policy URL ("Chrome will not approve without"), and `:57` still has `[SUPPORT EMAIL]`. `PRIVACY.md:36` also still lists the dead Gemini CLI free tier as a live rung. The raw-GitHub URL goes live the moment the repo is public, whether or not the Store submission happens. Fix: fill every bracket, correct the model-ladder table, before either the repo goes public or submission — whichever first.

### A12 (P0) — No SECURITY.md
A tool that requests `debugger` + `<all_urls>`, edits files on disk (auto-fix), and stores API keys in a vault is exactly the profile that draws responsible-disclosure reports. There is no private reporting channel documented. Fix: add SECURITY.md (private advisory route, scope, response expectation) before accepting public traffic. Note the `npm audit` caveat from A37 here too.

### A13 (P0) — Third-party live business site named throughout the repo as an unattended-agent target — **owner decision required**
`CLAUDE.md:9,82,83`, `docs/plan/2026-07-01-planner-navigator-split*.md` (multiple), `src/engine.ts:723` — "Proven live on mapleandsand.com", alongside prose explaining the tool auto-trusts any named target for click/type. Publishing "we ran an autonomous click/type agent against a stranger's production site" is a legal/reputational liability in a public repo regardless of outcome. Recommendation: **redact** — replace with the fixture app or a domain you own — unless you hold explicit authorization and choose to state it. (If redacting, note the domain also exists in git history; a squash/fresh-history start for the public repo is the clean path — no secrets force this, see the hygiene sweep, but this reference plus internal-strategy docs in history may.)

### A14 (P0) — The first README link is broken, in 6 files
`README.md:30` (and `CLAUDE.md:7`, `docs/TODO.md:4`, `docs/overview.md:47`, `docs/infra/testing.md:114`, `docs/modules/engine.md:34`) link `docs/spike-agent-product-doc.md`; the actual file is `docs/browser-qa-subagent-product-doc.md`. Rename the file to match the references (recommended — every doc pointer then works) or fix all six.

### A15 (P0) — Web Store approvability of `debugger` + `<all_urls>` + `tabCapture` is an untested hypothesis with no implemented fallback
`extension/manifest.json:13-14`; the project's own risk analysis (`docs/plan/2026-07-14-store-readiness.md:70-91,149-159`) rates this combination as elevated-rejection-risk and recommends early submission or an `activeTab`-narrowed fallback — neither has happened; the contingency exists only as a document. The entire GUI distribution channel rests on this. Fix: treat a trusted-tester Store submission as the next milestone (after A11), not a formality; budget for the narrowed-permission fallback build if rejected.

---

## P1 findings

### A16 (P1) — Auto-fix prompt injection: page-controlled text reaches a file-editing agent with a prose-only guard
`src/vibe/fix-prompt.ts:227-265` embeds attacker-controllable `console_error`/network text into the fix prompt with only a "treat as data" note; `src/vibe/auto-fix.ts:52-54,138-158` pipes it to `claude -p --permission-mode acceptEdits` / `gemini --approval-mode auto_edit` when `debugMode:'auto'`. Mitigations: `'prompt'` (human paste) is the default; `'auto'` is opt-in. Fix: sanitize/escape fence-breaking content, and add a one-time per-project confirmation before the first auto-edit run (the 26-07-14 audit's A9 left this half done).

### A17 (P1) — Navigator/brain prompts have no untrusted-content framing
`src/driver/planner-prompt.ts` interpolates a11y tree/console/network text with no "this is untrusted page data" framing (the fix prompt has it; these don't). Impact is well-bounded (fixed action schema, secrets never shown to models, Tier-4 host guard re-checks before every mutation), so worst case is a wasted/misdirected run — but the fix is cheap and should match `fix-prompt.ts`.

### A18 (P1) — `qa_run`'s auto-trust of the named host is under-disclosed to MCP integrators
`src/engine.ts:868-870`: `trustTargetHost` defaults true for CLI/MCP — any coding agent wired to the MCP tool gets full click/type authority on any URL it names, zero confirmation. Deliberate design, but the MCP tool description doesn't say so. Fix: state it prominently in the tool description and README.

### A19 (P1) — The live driver loop never uses the wave-2 auto-waiting it shipped
`waitForActionable` is called only by `src/recorder/replay.ts` (8 sites); `src/driver/loop.ts` clicks/types directly with no actionability wait — the primary AI-driven path lacks the race-condition fix the $0 replay path got. Same gap in the action-cache execution path. Fix: route live and cached executions through the same actionability wait.

### A20 (P1) — Action cache executes before verifying; a stale hit has already mutated the app
`src/driver/loop.ts:808-823`: `executeCacheAction()` runs against the live page, then checks correctness. On mutating actions (submit/delete/add-to-cart) a wrong cache hit is a real side effect on the app under test. Fix: verify target resolution/actionability before dispatching cached mutations.

### A21 (P1) — Cache-path locator resolution silently guesses on collisions
`src/cache/action-cache.ts:738-746` takes `matches[nth ?? 0]` where `replay.ts`'s `pickClearRoleWinner` loudly refuses ambiguity. A page that grows a second same-role+name element post-caching gets index 0 clicked silently. Fix: reuse replay's disambiguation in the cache path.

### A22 (P1) — MV3 service-worker eviction silently kills lite-mode runs
`extension/sw.js`: lite-mode run state (`liteBusy`, abort, promise chain) lives in SW module scope; long Nano/BYOK awaits (up to 5 min, no chrome.* touches) invite SW teardown; the panel's reconnect (`panel.js:276-281`) gets `busy:false` from a cold SW and the run just goes quiet with no error. Fix: checkpoint run-in-progress + runId to `chrome.storage.session` so a restarted SW can report the orphaned run as died.

### A23 (P1) — `chrome.debugger` detach mid-run is emitted but nothing listens
`extension/sw.js:1165-1169` emits `{event:'detached'}`; no `onEvent` subscriber exists in `src/` (`vibe/service.ts` registers none) and lite mode only clears its `attached` set. User cancels the debug banner → run fails later with an opaque CDP error instead of "debugging was stopped." Fix: wire the event to abort the active run with a human message.

### A24 (P1) — Timeout kill leaves orphaned CLI children
`google-cli.ts:148-178`, `cli-planner.ts:134-158`: `shell:true` means `child.kill()` kills the shell, not `gemini`/`claude`/`codex` — the real process lingers (and may still read a screenshot file the `finally` deletes). Fix: `detached:true` + process-group kill.

### A25 (P1) — HTTP `Retry-After` header is never read
`openai-compatible.ts:96-98`, `anthropic.ts:75-77`, `byok-gemini.ts:90-91,146-148`: real rate-limit guidance is discarded; blind exponential backoff instead (the typed-hint path already exists and works for Gemini's body-embedded `retryDelay`). Fix: parse the header into the same hint path.

### A26 (P1) — `goalComplete` bypasses the step budget; `goals[]` has no max
`src/driver/loop.ts:888-900` advances goals without touching `stepIndex`; schemas cap goals at `min(1)` with no max — an oversized goal list + instant `goalComplete` navigator = unbounded LLM calls that never trip `maxSteps`. Fix: count goal transitions against a budget; cap goals.

### A27 (P1) — 3×-repeat detector is goal-boundary-blind and effect-blind
`src/driver/loop.ts:920-939`: no reset at goal transitions, no did-it-have-effect check — a legitimate third click (stepper "+", wizard "Next") burns a brain escalation, which with A2 can end a navigator-only run. Fix: reset signature at goal boundaries; compare post-action tree hash before flagging.

### A28 (P1) — `drag_and_drop` bypasses the stale-node retry every other action gets (`loop.ts:1216-1217`).

### A29 (P1) — Profile-lock collision yields a 15s hang then a generic error
`src/chrome/launch.ts:82-120`: no profile-identity check on reuse-vs-spawn; a locked profile should say "profile already in use" instead. Fix: detect the singleton lock and message clearly.

### A30 (P1) — Resource leak window between `openSession()` and the try/finally
`src/engine.ts:895-923`: `nano.warmup()`, `buildLadder()`, `new ArtifactStore()`, `new FileActionCache()` run after the browser session opens but before the `finally` that closes it. A persistent misconfig (bad model id) leaks a tab/bridge connection on **every** attempt. Fix: extend the try (the close-on-throw pattern already exists at `engine.ts:884-894`).

### A31 (P1) — The "pure, no-Chrome" fast test bucket launches a real Chrome
`test/v49.parallel-session.ts` test 9 calls `ensureChrome()` for real, contradicting `ci.yml`'s and `docs/infra/testing.md`'s stated invariant — with A10, this is the likeliest cause of the first real CI run failing. Fix: move it to the browser bucket or split test 9 out.

### A32 (P1) — No functioning CI path exists for the daemon/extension/Nano half of the product
`.github/workflows/ci.yml` `browser-suites` runs on `ubuntu-latest` while its own comments require a pre-provisioned self-hosted runner + credentials; neither exists. 28 of 60 suites (the entire integration surface, all three e2e suites included) are never exercised by automation. Honestly self-documented in `docs/infra/testing.md`, but the manual escape hatch is non-functional as written. Fix: point at a real self-hosted runner or drop the job and document `npm run test:browser` as local-only.

### A33 (P1) — CI is single-OS despite three-OS product claims
No macOS/Windows job; all Windows code paths (DPAPI, Scheduled Task, `findChrome` win32) are automation-unverified. Fix: 3-OS matrix for typecheck + build + `npm test` (cheap).

### A34 (P1) — README quickstart breaks verbatim on macOS/Linux
`README.md:89-104,110-112`: PowerShell-only fences, backtick line continuation, `E:\path\to\repo` MCP example, no POSIX variant — the first pasted command fails for the majority OSS audience. Fix: POSIX-primary examples, PowerShell secondary.

### A35 (P1) — No publish workflow, no lint/format stack, no tags/releases/CHANGELOG, no `pack:extension` CI step
Publishing to npm is currently a human running `npm publish` locally. Fix priority: (1) tag-triggered publish workflow with `NPM_TOKEN`, (2) `pack:extension` in CI, (3) lint/format post-launch.

### A36 (P1) — The AVG `--use-system-ca` workaround ships unconditionally to every user, with no opt-out
`src/config.ts:200`, `src/service/install-service.ts:78`, all four install scripts bake `NODE_OPTIONS=--use-system-ca` into every installed daemon; docs (`docs/infra/environment.md:99`, `CLAUDE.md`) frame it as one machine's quirk. Low-risk (it adds the OS store, doesn't replace), but it's an unconditional TLS-trust change shipped for one developer's antivirus. Fix: env opt-out + reword docs to the generic "TLS-intercepting AV/proxy" framing.

### A37 (P1) — `npm audit` shows 3 high (6 total) transitive vulns via `@modelcontextprotocol/sdk`'s HTTP-transport deps
Unreachable at runtime (stdio transport only), but every installer sees red on day one. Fix: document the stdio-only reachability argument in SECURITY.md/README; watch for an SDK bump.

### A38 (P1) — Internal business-strategy documents would go public as-is — **owner decision required**
`docs/browser-qa-subagent-product-doc.md` (competitor teardown, TAM, pricing hypotheses, GTM timeline), `docs/grok-findings-about-auto-testing-tool.md` (demand research, pricing speculation), plus raw internal security audits (`docs/plan/26-07-14-audit-perf-security.md` — documented weaknesses are verified fixed in current code, so technical risk is low). Recommendation: move strategy docs to a private location and keep only technical architecture public; keep or summarize the audits per your transparency appetite. These also exist in git history (see A13's history note).

### A39 (P1) — "MontrAI" (an unreleased private product) is named as the dogfood target
`README.md:192`, `docs/TODO.md:61,133`, `docs/browser-qa-subagent-product-doc.md:144`. Redact to "a real production app" unless intentional.

### A40 (P1) — Stale top-level docs undermine trust
`docs/TODO.md` frozen at 2026-06-07 (no wave 1–5 mention); README's project-structure/test sections describe 5 suites where 60 exist and never mention `npm test`; suite counts in `docs/infra/testing.md` drifted (26 vs 31). Fix: update or delete TODO.md in favor of overview's timeline; point README's testing section at `npm test` / `run-tests.mjs --list`.

### A41 (P1) — No CONTRIBUTING.md, CODE_OF_CONDUCT.md, or issue/PR templates
`.github/` holds only `ci.yml`. A structured bug template (repro URL, task string, `report.json` attach) will save real triage time for this product shape. Fix: minimal CONTRIBUTING (pointing at `docs/infra/testing.md`), Contributor Covenant, one bug template.

### A42 (P1) — The genuine $0 out-of-box story is undersold, and defaults assume Claude Code
`src/config.ts:221` defaults the brain to `claude:cli`; verified that `ModelRouter.hasCapability` degrades cleanly to navigator-only when absent — so a zero-key, zero-subscription path exists (Nano navigator, on-device). README never says this. Fix it in docs — but note it only becomes a good story after A2 makes that path actually survive contact (and after the Nano-navigator "Experimental" caveat lands, A43).

### A43 (P1) — Nano-as-navigator is offered in the panel with no "Experimental" marking
`extension/panel.html:59` lists it plainly; CLAUDE.md documents the known rough behavior (guessed URLs, repeated failing navigation; Phase A GO/NO-GO never passed). Fix: mark it Experimental in panel + README; keep a cheap vision cloud navigator as the recommended default.

---

## P2 findings

### A44 (P2) — Tracked runtime debris: `generated-tests/log-in-as-test-…json` (pre-gitignore) and `.spike/app-model.json` (`.spike/` not ignored at all). Harmless content; `git rm --cached` both, add `.spike/` to `.gitignore`.

### A45 (P2) — Allowed-host guard trusts all subdomains, broader than the apex↔www intent
`src/ports/browser-port.ts:108-113`: suffix match means a target of `example.com` trusts `anything.example.com` — fine for owned domains, wrong for multi-tenant hosts (`*.vercel.app`, `*.myshopify.com` siblings). Restrict to exact + www, or document as intentional.

### A46 (P2) — Two complete modules ship as dead code
`src/email/` (EmailProvider, `findOtp()`, fake local provider — zero importers) and `src/assertions/visual-policy.ts` (zero importers; superseded by `assertions/policy.ts` + inline loop logic). Wire or delete — a maintainer will mistake them for working features. (Everything else under `src/` traces to an entrypoint; the "5 integration gaps" sweep missed these two.)

### A47 (P2) — Exit codes conflate "app is broken" (verdict fail → 1) with "tool couldn't run" (infra throw → also 1); `uncertain` is correctly 2. Define an exit-code contract (e.g. 0/1/2/3) for CI consumers.

### A48 (P2) — `spike daemon` hard-crashes on port-in-use
`src/bridge/bridge-server.ts:131`: no `'error'` handler on the `WebSocketServer` — running the CLI while the auto-start service owns the port throws uncaught instead of "port in use."

### A49 (P2) — Slow buffer growth + no crash watchdog on long runs
Console/network drains only fire per executed action (not during long LLM waits); the network `pending` map never clears unsettled requests; `Inspector.targetCrashed` is never subscribed.

### A50 (P2) — Router bookkeeping gaps: CLI/Ollama adapters never populate `lastUsage` (cost accounting silently zero for those rungs); 3-digit status regex (`model-router.ts:69`) can misparse CLI stderr as an HTTP status; schema/parse errors get zero same-rung retry before escalating.

### A51 (P2) — The discovery/autonomy layer is invisible to daemon/panel users
`spike map`/`spike coverage` + automatic coverage write-back are real and CLI-wired, but zero references exist under `src/vibe/` or the extension — GUI users get none of it. Also: element→state attribution matches first case-insensitive role+name hit (`record-coverage.ts`), mis-attributing shared elements across states (documented limitation).

### A52 (P2) — Package bloat: sourcemaps are ~half the npm tarball (1.04MB single map of 2.6MB unpacked); `playwright-core` (13MB) is a hard dep backing only the optional `--via playwright` transport. Drop maps from the published build; consider making playwright-core optional.

### A53 (P2) — Vault key on macOS/Linux is a plaintext 0600 file (Windows gets DPAPI). Honestly disclosed in code and PRIVACY.md, deliberate v1 choice — but it's the weakest link in the "keys never leave your machine" pitch now that launch targets macOS/Linux. Keychain/libsecret backends are the upgrade.

### A54 (P2) — README conversion polish: no badges, no demo GIF/screenshot (for a ghost-cursor product!), no explicit "Requires: Node 20+, Chrome 138+, Win/macOS/Linux" line, no CLI command table (13 commands exist, 4 shown), no warning that first Nano setup is a ~2GB download + 22GB free-disk gate.

### A55 (P2) — Check `spike-agent` availability on npm before committing to the name (not verified here); "Spike" is generic enough that Web Store search will bury it — a discoverability cost more than a trademark risk. **Owner decision.**

### A56 (P2) — Version `0.0.1` in both package.json and manifest: Web Store versions only increase and the first published version anchors auto-updates — decide the launch number (e.g. 1.0.0) deliberately before first submission. **Owner decision.**

### A57 (P2) — Extension icons: confirm they're self-generated via `scripts/gen-icons.ts` (they appear to be) and not stock assets with their own license. LICENSE itself is clean — stock Apache-2.0, matches package.json, no vendored third-party code found, no NOTICE needed.

---

## What is verifiably solid (for fairness and confidence)

- **Bridge security** (localhost bind, Origin rejection of browser-page WebSockets, TOFU pairing token in the encrypted vault, per-handler auth re-checks, protocol-version handshake, multi-client isolation) — independently re-verified, zero P0s.
- **Lite mode is a real standalone engine**, not a stub — full driver loop + router + CDP executor over `chrome.debugger`, with a build-time gate keeping Node imports out.
- **No secrets/PII in tree or history**; CLI adapters have no shell-injection path (prompts ride stdin; model ids validated at the sink); keys ride headers not URLs; telemetry redaction is real; `readOnly: true` is the default.
- **Build/typecheck/31 fast suites green from a fresh clone**; `npm pack` list is clean; the packed CLI runs; extension zip packs cross-platform.
- **Suite runner parallel isolation is correct** (per-worker CDP port + runner port + profile); recorder/replay disambiguation and heal-policy quarantine logic reviewed clean.
- **MCP error handling is safe** (SDK wraps tool calls); React-controlled-input typing has the right fallback chain; escalation caps and step budgets are correctly enforced on the two-model path.

---

## Feature suggestions, enhancements & upgrades

- **Wire `src/email/` into the driver** (`wait_for_email` / OTP action) — signup/verification flows are a top QA blocker and the module is already built (A46).
- **Oracle strict mode** — once A1 lands, expose `strictOracles` as a headline differentiator: "deterministic verdicts, the model can't hallucinate a pass."
- **OS-keychain vault backends** (macOS Keychain, libsecret) to close the platform asymmetry (A53).
- **Surface `map`/`coverage` in the side panel** — the autonomy layer is the newest work and GUI users can't see it (A51).
- **Auto-fix confirmation gate + content sanitization** — one-time per-project consent before the first `acceptEdits` run (pairs with A16).
- **`activeTab`-narrowed fallback extension build** as the Store-rejection contingency (A15) — worth building before the first review round-trip, not after.
- **Release automation**: tag-triggered npm publish, extension-zip artifact upload, CHANGELOG generation (A35).
- **Demo GIF + benchmark table** vs Playwright MCP / Claude in Chrome (already on the launch TODO; the ghost-cursor overlay is made for a repo-header GIF).
- **Exit-code contract** (0 pass / 1 fail / 2 uncertain / 3 infra) for CI consumers (A47).
- **Chromium support** alongside branded Chrome once A10's override lands — halves the install friction on Linux (Nano stays Chrome-only; document that split).
- **Feed the discovery app-model into the brain prompt** — `.spike/app-model.json` (from `spike map`) is never read by any prompt builder (verified: zero references in `src/driver/` or `engine.ts`); summarizing known routes/states into the goal-planner prompt would cut brain re-planning and wrong-URL guessing at near-zero token cost.

---

## Addendum (2026-08-27) — deterministic automation & prompt verification

Follow-up verification requested by the owner ("did the Chromium-based automation land, and do navigator/brain prompts/skills exist?"), checked directly in code:

**1. Chromium-based deterministic automation: IMPLEMENTED — four layers, no Selenium anywhere; `playwright-core` is the Chromium automation dependency.**
- `--via playwright` transport: `src/ports/playwright-browser.ts` (808 lines), wired at `src/engine.ts:238`, exposed on `run` and `replay` (`src/cli.ts:96,365`). Opt-in; default stays `cdp` (`src/config.ts:57-59`, per the 26-08-08 audit's A26 decision). In suite mode `--workers` + `--via playwright` is the cheap parallel path: one shared Chrome, one isolated `BrowserContext` per script (`src/cli.ts:486-502`); other transports get full per-worker Chrome isolation.
- Recorder/replay: recorded runs re-execute deterministically at $0 with zero planner calls (`src/recorder/replay.ts`).
- Verified action cache (`--action-cache` / `--no-action-cache`, `src/cli.ts:98-99`; `src/cache/action-cache.ts`): live runs reuse previously-verified actions without an LLM call — subject to safety findings A20/A21.
- `script` action + script-runner (`src/driver/script-runner/`): the navigator can emit up to 20 deterministic steps executed as ONE step (`SCRIPT_MAX_STEPS`), on top of ordinary 1–3-action batching — both cut LLM round-trips on the live path.
So the "LLM-per-step is slow" concern is addressed architecturally; the remaining speed/safety gaps are already filed as A19 (live loop skips auto-waiting), A20/A21 (cache discipline), and A2 (navigator-only budget bug).

**2. Navigator/brain prompts: EXIST and are substantive; a "skills" system does NOT exist.**
`src/driver/planner-prompt.ts` holds `buildGoalPlannerPrompt` (brain: initial checklist + escalation re-plan/hint/verdict modes) and `buildNavigatorPrompt` (navigator: full 22-verb action vocabulary, batching rules, `goalComplete`/`blocked` signals, evidence capped at 8 lines, history capped at 20 entries with overflow collapse). Both are wired into `loop.ts` (lines 567, 714, 861). There is no skills/per-site-memory system anywhere in `src/` or `extension/` (grep clean), and the discovery app-model is never fed into any prompt — see the new enhancement above. Known prompt gap already filed: A17 (no untrusted-content framing).

### A58 (P2) — Dead single-tier prompt builder + ~60 lines of verbatim prompt duplication
`buildPlannerPrompt` (`planner-prompt.ts:80-148`, the pre-split single-tier prompt) has zero callers outside its own file — `loop.ts` imports only the goal-planner and navigator builders, and navigator-only mode reuses the navigator prompt with an implicit goal. It duplicates the rules/action-vocabulary block verbatim with `buildNavigatorPrompt`, so a rule fixed in one silently drifts from the other. Fix: delete `buildPlannerPrompt` (keep the exported helpers `test/v36.client-errors.ts` uses — `networkLines`, `MAX_EVIDENCE_LINES`), and extract the shared rules/action-types block into a single constant consumed by `buildNavigatorPrompt`.

> Task list: [26-08-27-tasks-market-readiness](./26-08-27-tasks-market-readiness.md) — written for autonomous execution (each task self-contained with files, default decisions, and acceptance checks).
