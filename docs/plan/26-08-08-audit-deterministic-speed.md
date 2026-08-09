# Audit — deterministic speed & accuracy at product scale

**Date:** 2026-08-08
**Question audited:** *"Everything is dependent on AI computer use — it's good but slow. Blend AI with deterministic automation to get speed, accuracy, and full end-to-end QA of a whole project, while keeping it autonomous. What's the scope?"*
**Method:** direct code read plus five parallel verification agents over `src/recorder/*`, `src/driver/loop.ts`, `src/ports/*`, `src/cache/action-cache.ts`, `src/engine.ts`, `test/`, `docs/`, and the six real run artifacts on disk. Every claim below is cited to `file:line` or to a measured artifact.
**Verification:** 2026-08-08 — four adversarial verification agents independently re-derived every measured number (all reproduced exactly) and re-checked ~110 file:line citations (2 drifts found and corrected below). Verdict tally: 22/22 findings confirmed on substance; A2 softened, A6/A17/A18 strengthened, suggestions 1/3/7/12/15 amended per feasibility review.

---

## 0. Direct answer to the question

**The blend is the right instinct — and the deterministic half of it already exists in this codebase and is effectively switched off.**

The engine already speaks raw CDP (`src/ports/cdp-browser.ts`), the same transport Playwright uses, so nothing needs replacing at the wire level. What is missing is the *engineering* that makes a deterministic runner fast and trustworthy — auto-waiting, real assertions, session reuse, parallel isolated contexts — plus the machinery to keep the blend autonomous at project scale.

Current state of the deterministic half:

| Asset | State | Evidence |
|---|---|---|
| `recorder/` — passing run → replayable JSON script | Built, **never once exercised** | `generated-tests/` does not exist on disk; zero scripts ever recorded |
| `recorder/replay.ts` — $0, zero-planner re-run | Built, unproven on real data | `replay.ts:270` hardcodes `model_trace = []` |
| `cache/action-cache.ts` — skip the model on repeat steps | Built, **off by default** | `src/config.ts:123` `actionCache: false` |
| `driver/script-runner/` — 15-verb allowlisted deterministic DSL (max 20 steps/script) | Built, only reachable via a model emitting a `script` action | `script-runner/schema.ts:21-37`, `SCRIPT_MAX_STEPS` `:17` |
| `run-data/` — per-run unique email/shortid placeholders | Built and sound | `src/run-data/state.ts:29-42` |

So the scope is: *finish and default-on the deterministic path you already have, add the four engineering primitives this codebase is missing — auto-waiting, real assertions, session reuse, parallel isolated contexts — and then build the autonomy layer on top (discovery, oracles, change-triggered re-exploration) that turns per-flow testing into whole-project testing.*

### The measured problem

From the six real runs in `artifacts/` (all 2026-07-28, CLI planner `claude:opus` on both roles):

- Average run wall-clock: **26,079 ms** for a 3–6 step login flow.
- Navigator (`plan-step`) call latency: n=13, avg **5,377 ms** (min 3,929 / max 8,479).
- Brain (`plan-goals`) call latency: n=12, avg **5,964 ms** (min 5,066 / max 7,848).
- On run `2026-07-28_12-39-40-j3t9`: model_trace sums to 29,235 ms of a 35,950 ms run → **~81% of wall-clock is model latency.**
- Corroborated by `audit.log` timestamps in that run: intra-batch step gaps are 156–193 ms; the inter-batch gap is **5,897 ms**, matching the 5,726 ms navigator call logged for that step.

Action batching works as designed — **every observed batch was the full 3 actions** (`type`,`type`,`click`). So even at maximum batching, the architecture costs ~5.4 s of model latency per 3 UI actions.

### Scope math for a "fully-featured product"

Take a realistic mid-size suite: **200 flows × ~25 UI actions**.

| Path | Per flow | 200 flows, serial | With 8 workers |
|---|---|---|---|
| Today (AI-driven every step) | ~9 navigator + ~2 brain calls ≈ **60 s model + ~15 s CDP ≈ 75–90 s** | **4.2 – 5.0 hours** | *not possible — no parallelism exists* |
| Deterministic replay (existing code, unoptimised) | ~9 s per `docs/benchmark.md` (8-step flow) → ~28 s extrapolated linearly to 25 actions | ~93 min | ~12 min |
| Deterministic replay + auto-wait + headless + session reuse | ~6–10 s | ~25 min | **~3 min** |

The prize is roughly **80–100× on suite wall-clock** (252–300 min ÷ 3 min), and it is mostly reachable by finishing existing code rather than writing a new engine. But three of the findings below (A1, A3, A4) each independently block that.

### Where AI should stay

Do not remove the model — relocate it. AI earns its cost in exactly three places, none of which are the hot loop:

1. **Authoring** — explore the flow once, emit a script (this is a compiler, not a runtime).
2. **Healing** — when a script breaks, re-derive it instead of a human editing YAML.
3. **Semantic/visual judgement** — "does this page look broken", which no deterministic assertion can express.

Everything else should be deterministic. That is the whole thesis of `docs/browser-qa-subagent-product-doc.md:69` — it is simply not yet true in practice.

### The two-track architecture (decision, 2026-08-08)

The blend does **not** apply uniformly to both transports. They are deliberately different products with different constraints, and conflating them is what makes the Playwright question look harder than it is:

| | **Lite mode** (MV3 extension, no daemon) | **Core mode** (daemon, CDP) |
|---|---|---|
| Execution | **Fully AI-driven, by design** | Deterministic-first; AI only for authoring / healing / visual judgement |
| Models | **BYOK API key: small model navigates, big model decides** | Same two-tier split, plus CLI rungs and Nano |
| Purpose | Zero-install onboarding, "test the tab I'm looking at", exploratory | Autonomous whole-project QA, regression suites, CI |
| Speed target | Good enough for one flow, interactively | 80–100× suite wall-clock (see table above) |
| Playwright | **Never** — `chrome.debugger` is not Playwright-drivable | Candidate engine (A26) |

This matters for two reasons. First, it settles A26: **the MV3 constraint is no longer an argument against adopting Playwright**, because lite mode was never going to be deterministic-first — it keeps `ExtensionBrowser` and stays AI-powered regardless of what Core mode does. Second, it means lite mode's navigator/brain pins are a *product surface*, not a fallback — and today they are misconfigured (A27).

Everything from A1–A22 targets **Core mode**. A23–A26 are the autonomy layer, also Core mode. A27 is the lite-mode correction.

---

## Findings

### P0

#### A1 (P0) — The entire deterministic pillar has never been exercised, even once

`generated-tests/` **does not exist on disk** and is gitignored. All six directories in `artifacts/` are from a single session on 2026-07-28, all with `verdict: "fail"`, all on the identical task, and all failing for the identical structural reason: the run was in read-only mode so every `type`/`click` was skipped (`src/driver/loop.ts:945-948`). Sample reason from `artifacts/2026-07-28_13-42-28-nkiv/report.json`: *"The run is in read-only mode: all type and click actions are skipped… so the login form cannot be submitted."*

Consequences: no run has ever passed → `scriptFromReport()` throws on non-pass (`src/recorder/script.ts:94-96`) → no script has ever been written → **the replay path, the matcher, `--heal`, and `replay --all` have never run against real recorded data in this checkout.** `test/e2e.recorder.ts` covers the mechanism synthetically, but the product's core claim ("AI once → deterministic forever", `docs/browser-qa-subagent-product-doc.md:69`) is entirely unvalidated end-to-end.

This is P0 because every speed argument below depends on replay working, and we currently have no evidence that it does. Also note `readOnly: true` is the config default (`src/config.ts:135`), which is why the only dogfood attempts produced nothing.

#### A2 (P0) — Model latency is 81% of wall-clock and there is no model-free path for a new flow

Measured above. Structurally: one `planJson` call per outer-loop iteration (`loop.ts:746-760`), yielding at most 3 actions. `DEFAULT_MAX_STEPS = 40` (`loop.ts:94`), `MAX_BRAIN_ESCALATIONS = 2` (`loop.ts:101`). On a *first* run of a flow, only two mechanisms can stretch a model call beyond 3 actions, and neither changes the picture: the action cache (A9) is off by default and only helps on repeats, and the navigator *can* emit a `{type:'script'}` batch of up to 20 deterministic sub-steps (`loop.ts:1097-1113`) — but its nodeIds reference the current AX snapshot and don't survive an in-script navigation, so in practice it only compresses same-page interactions (e.g. a multi-field form), and none of the six recorded runs ever used it.

At 5.4 s/navigator-call this is fine for a 5-step demo and untenable for a 25-step flow × 200 flows. Any speed work that does not attack this is cosmetic.

#### A3 (P0) — Zero parallelism, and hard singletons make concurrent runs impossible

No `--workers`, no sharding, no pool, no queue anywhere in `src/` (repo-wide grep for `worker|concurren|parallel|mutex|semaphore|pool` returns only MV3 service-worker hits and one `Promise.all` over adapter availability probes at `src/router/model-router.ts:91`).

Collision points that make a second concurrent run fail or corrupt the first:

- **Nano runner HTTP port 9400** — `src/config.ts:116`, bound at `src/ports/nano-runner-page.ts:47-57`. Second process throws `EADDRINUSE`. Sharpest, loudest failure.
- **CDP port 9322** — `src/chrome/launch.ts:44`: `if (await cdpAlive(opts.port)) return;`. Second run silently **attaches to the same Chrome**, sharing profile, cookies and session state. No `BrowserContext`-equivalent isolation exists anywhere.
- **Single Chrome profile** — `--user-data-dir` at `src/chrome/launch.ts:47`; one cookie jar for all tabs.
- **Nano warm session** — one tab, one session, no lock around concurrent `Runtime.evaluate` calls (`nano-runner-page.ts:124-139`).
- **VibeService** enforces single-run by design — `src/vibe/service.ts:94,119` (`if (this.busy) throw new Error('a run is already in progress')`).

`spike replay --all` is a plain serial `for…of` with `await` inside (`src/cli.ts:216-226`). Even if every other finding were fixed, suite throughput is pinned at 1.

#### A4 (P0) — No auto-waiting anywhere; ~20 hardcoded sleeps instead

This is simultaneously the largest avoidable time cost and the largest flake source.

`src/ports/cdp-browser.ts` fixed sleeps: navigate 300 ms (`:96`), click **400 ms** (`:136`), type 150 ms (`:166`), hover 250 ms (`:181`), pressKey 150 ms (`:189`), selectOption 200 ms (`:221`), reload/goBack 300 ms (`:228`,`:237`), uploadFile 150 ms (`:244`), dragAndDrop 30 ms × 6 + 200 ms (`:261`,`:264`), blur 100 ms (`:283`), mouse 50/150 ms (`:294`), typeByKeyEvents tail 100 ms (`:413`). Plus a flat `sleep(150)` per step in the driver (`loop.ts:1134`, `:698`, `:571`) and a flat `sleep(250)` per step in replay (`replay.ts:215`).

A 3-action batch burns **~1,150 ms in fixed sleeps alone**. On a 25-action flow that is ~10 s of pure waiting — and it is *simultaneously* not enough on a slow page, which is where flake comes from.

`replay.ts:397-432` does have a find-poll loop (`FIND_TIMEOUT_MS = 5000`, poll every 300 ms) for "element not present yet" — but once a matching AX node is found the action fires immediately with **no visibility / enabled / stability / receives-events check**. `replay.ts:215` even carries the acknowledgement: *"BrowserPort has no non-destructive in-flight/idle check to poll here."*

There is no `waitFor` primitive in `BrowserPort` at all (`src/ports/browser-port.ts:99-159`). This is the single highest-leverage missing abstraction in the codebase.

#### A5 (P0) — The assertion vocabulary cannot express a precise expectation

What exists:
- `assert_dom` — **case-insensitive substring only**: `hay.toLowerCase().includes(action.contains.toLowerCase())` (`loop.ts:1017`, mirrored at `loop.ts:1557` and `action-cache.ts:311`). No exact-equality variant exists anywhere in the codebase.
- `assert_visual` — pure LLM opinion on a screenshot (`src/assertions/policy.ts:29-48` → `src/router/verdict.ts:15-22`).

What does **not** exist: exact text equality, element-count assertion, URL-equality assertion, HTTP status-code assertion, console-error assertion, attribute/value assertion, ordering assertion.

On a large app this is the accuracy problem in a nutshell. `assert_dom contains "Order"` passes on the orders list, the order-confirmation page, an "Order failed" toast, and a nav link. The user's stated worry ("AI agents hallucinate") is real, but the deeper issue is that **even when the AI is right, it has no primitive precise enough to encode what it verified.** A recorded script is only as durable as its assertions, so this also caps the value of A1's fix.

Related: console errors and network failures are **evidence for the model, never a hard fail** — `firstError()` (`src/capture/console-network.ts:87-97`) annotates the report *after* the verdict is decided (`loop.ts:1277-1288`); the prompt merely tells the model they are "strong evidence" (`planner-prompt.ts:91`) and the model may ignore it.

---

### P1

#### A6 (P1) — No session/auth state reuse; every flow logs in through the UI

Repo-wide grep for `Network.setCookie`, `Storage.`, `cookies`, `localStorage`, `storageState` across `src/` returns **zero hits**. There is no way to capture an authenticated state once and inject it into subsequent runs (Playwright's `storageState`, the single biggest suite-level speed win in practice).

On a 200-flow suite this means 200 redundant UI logins — at ~2 navigator calls each (measured avg 5,377 ms/call), that is 400 × 5.4 s ≈ **36 minutes of pure repeated login** per suite pass before adding the ~1–2 s of fixed CDP sleeps per login (A4), so realistically ~40 min — plus it makes every flow depend on the login flow's stability.

#### A7 (P1) — Headless is unreachable; every run is headed

`LaunchOptions.headless` exists (`src/chrome/launch.ts:38`, consumed at `:58`) but **every product call site hardcodes `headless: false`**: `src/engine.ts:152`, `src/engine.ts:191`, `src/ports/nano-runner-page.ts:66`. No CLI flag toggles it (`src/cli.ts` has no `--headless` option).

The stated reason is legitimate — *"Nano availability in headless is not proven"* (`nano-runner-page.ts:66`) — but it couples the whole engine to a Nano constraint. Deterministic replay does not need Nano except for `assert_visual`, so replay could run headless today. Blocks CI (A15) and costs measurable per-step time.

#### A8 (P1) — Locators are accessibility role+name only; ambiguity is a hard fail

`BrowserPort` exposes no CSS, XPath, or `data-testid` locator strategy (`src/ports/browser-port.ts:99-159`); `DOM.querySelector` is used only internally for the `qaId` stamp (`cdp-browser.ts:452`). Resolution is role + name + optional `nth` + optional `qaId` (`replay.ts:397-432`).

On ambiguity (>1 match, no `nth`) replay attempts the `qaId` fallback once, then **hard-fails immediately** with `ambiguous locator: N × role "name" — re-record or refine` (`replay.ts:417-422`) — no wait, no retry, no disambiguation heuristic over the matches themselves. On zero matches it polls 5 s then fails.

Large apps break this constantly: data tables with N identical "Edit"/"Delete" buttons, virtualized lists where `nth` shifts with scroll position, canvas/SVG/charting UIs with no accessible name at all, i18n where the name string changes per locale. The `qaId` fallback is explicitly documented as not surviving a reload (`src/ports/browser-port.ts:155`).

#### A9 (P1) — Action cache is off by default and its verification can false-positive

Off by default: `src/config.ts:123` `actionCache: false`.

When on, `verifyActionEffect()` ends with a catch-all: `if (changes.length) return { ok: true, reason: 'observed … change' }` (`action-cache.ts:335`), where `changes` is populated purely from a URL change or a page-signature change (`action-cache.ts:272-273`). Cached targets do re-resolve by role+name+nth against the live page (`action-cache.ts:599-618`), so a hit cannot land on an *arbitrary* node — but it **can** land on a node that still matches role+name+nth while no longer being the semantically same element (a reordered/paginated list where "3rd Delete button" is now a different row; a redesign recycling a label on a different control), and that case is accepted by the catch-all if anything at all on the page changed — a toast, an ad refresh, a live price ticker.

Weaker sub-cases: `type` with a secret placeholder only checks the field is non-empty *or focused* (`action-cache.ts:641-646`); `select_option` uses substring containment (`:301-306`); `navigate` verifies only the destination URL, so a 500 page at the right URL "verifies" (`:283-292`). `pageSignature` is truncated at 250 nodes / 12,000 chars (`:126-135`, `:584-597`), so two materially different pages can collide onto one signature and produce a hit for a page never seen.

Mitigation that does exist: a hit requires **exactly one** matching record, else it is treated as a miss (`loop.ts:672-673`).

#### A10 (P1) — Replay matching is bag-of-words, and a failed replay silently buys a full AI run

The matcher scores `0.7 × taskSimilarity + 0.3 × pathSimilarity` with threshold **0.62** (`src/recorder/matcher.ts:29-31,135`). `taskSimilarity` is Jaccard over a stopword-filtered bag of words with tokens <3 chars dropped (`matcher.ts:43-65`) — no stemming, no ordering, no semantics. Host must match exactly after stripping `www.` (`matcher.ts:131`).

Two failure modes, both silent:
1. Reword a task ("log in and check out" → "sign in then purchase") and it drops below 0.62 → a full-price AI run with no warning that a near-miss script existed. Near-miss scores are never surfaced at the CLI.
2. If a matched script replays and returns `fail`, `qaRun` **silently falls back to `runFreshAiPass`** (`src/engine.ts:429-436`) — so a broken script costs replay time *plus* a full AI run, invisibly, unless the caller inspects `replayMatch`.

Also: scripts are keyed by `taskSlug(task)` truncated to 60 chars (`script.ts:82-90`) with no collision check in `saveScript()` (`script.ts:237-245`) — two tasks that slug identically silently overwrite each other.

#### A11 (P1) — No flake detection, no retries at verdict level, no golden baselines

Repo-wide grep confirms: no `quarantine`, no re-run-on-fail, no two-run agreement check, no `baseline`/`golden`/pixel-diff/DOM-snapshot-diff anywhere in `src/`. Nothing persists a known-good artifact across runs.

Retries that exist are narrow and single-shot: one retry on invalid navigator JSON (`loop.ts:1444-1455`), one retry on a failed click/type/hover/select/upload/blur with target re-resolution (`loop.ts:1485-1508`). The only whole-task re-run is `runWithAutoFix()` (`src/vibe/auto-fix.ts:274-346`), which is fix-and-retry conditioned on a code edit — not flake mitigation.

For a 200-flow suite, a 1% flake rate means ~2 red flows every run with no mechanism to distinguish flake from regression. That destroys trust in the suite faster than any single bug.

#### A12 (P1) — There is no suite concept

`spike replay --all` = `listScripts()` (unordered `fs.readdirSync`, `script.ts:267-274`) iterated serially, aggregating `worst = max(pass 0, fail 1, uncertain 2)` (`src/cli.ts:214-228`). That is the entirety of suite orchestration.

Missing: ordering, dependencies, tags/filters, sharding, `beforeAll`/`afterAll`, shared fixtures, per-suite setup (seed the DB, create a tenant), teardown/cleanup, and shared login state (A6). Each `qaReplay` opens and closes its own browser session independently (`engine.ts:584,596`), so nothing is shareable across scripts even in principle today.

#### A13 (P1) — No network interception or mocking

Zero hits for `Fetch.enable`, `Network.setRequestInterception`, `setBlockedURLs`, `Emulation.*` across `src/`.

Consequences: third-party scripts, analytics and ad iframes cannot be blocked (they are pure latency and a flake source); error states (500, timeout, empty list) cannot be forced deterministically and must be reproduced by luck; no offline/slow-network emulation; no request-level assertion.

For a fully-featured product this is often the difference between a 40 s flow and a 6 s flow.

#### A14 (P1) — Hand-authored scripts are the natural accuracy escape hatch and are unvalidated

`loadScript()` does `JSON.parse(...) as QaScript` (`src/recorder/script.ts:262`) — a TypeScript assertion, **not a runtime schema check**. `QaScript`/`ScriptStep` are plain interfaces (`script.ts:32-80`), not zod. Only the nested `{type:'script'}` sub-DSL is genuinely validated (`replay.ts:176-183` → `script-runner/schema.ts:21-37`).

So a user *can* hand-write a fully deterministic test today and `spike replay` will run it with zero model calls — which is exactly the answer to "I don't want the AI hallucinating in my regression suite." But it is undocumented as a supported workflow, unvalidated (typos fail late and obscurely), and constrained to the same weak assertion set as A5.

#### A15 (P1) — No CI config, no test runner, and the Playwright integration was explicitly dropped

No `.github/`, no `*.yml`/`*.yaml` outside `node_modules`, no git hooks, no `husky`/`lint-staged`. No unit test framework — `docs/infra/testing.md:10` states plainly: *"No test framework like Jest or Vitest is used; suites run directly with tsx and assert() / throw."* `package.json` wires exactly one test-related script (`test:e2e`); the other ~33 files in `test/` are run ad hoc via `npx tsx`.

`docs/plan/2026-07-07-passmark-comparison-audit.md` already flagged this as P2 (*"Local needs a stronger CI/package story if competing with test frameworks"*), and the follow-up task list records the resolution as **DROPPED**: *"Playwright helper/reporter package: DROPPED… a Playwright-library shape dilutes the wedge."* I verified `qaRunAsPlaywrightTest` exists nowhere in `src/` — so this is a deliberate product decision, not drift.

That decision is defensible for *positioning* (don't become a Playwright plugin) but it left the *engineering* gap unaddressed: the reason to care about Playwright here is auto-waiting, parallel contexts, and web-first assertions — capabilities, not packaging. Dropping the integration should not have dropped the capabilities.

#### A16 (P1) — The `.spec.ts` twin is not runnable, so the stated portability guarantee is hollow

`toPlaywrightSpec()` (`src/recorder/script.ts:390-482`) emits a file that cannot be executed:

- `@playwright/test` is **not a dependency** anywhere in the repo, and no `playwright.config.ts` is generated.
- Visual assertions collapse to `await expect(page.locator('body')).toBeVisible();` (`script.ts:431`) — an assertion that essentially cannot fail. The real expectation survives only as a comment (`script.ts:429-430`).
- `extract` steps emit **comments only** (`script.ts:421-427`); so do `open_tab`/`switch_tab`/`close_tab`/`script` (`script.ts:458-469`).
- `{{secret:*}}` / `{{run.*}}` placeholders are emitted verbatim via `JSON.stringify(s.text)` (`script.ts:401`) with no resolution mechanism.
- Documented as not kept in sync after manual JSON edits (`docs/modules/recorder.md:75`).

The product doc leans on this artifact as the durability story (`docs/browser-qa-subagent-product-doc.md:69`: *"AI explores once → emits a Playwright script"*). As emitted, it is a readable summary, not a test.

#### A17 (P1) — The effective step budget is 12, not the documented 40

`src/engine.ts:523` always passes `maxSteps: opts.maxSteps ?? cfg.maxSteps`, and `cfg.maxSteps` defaults to **12** (`src/config.ts:125`). `DEFAULT_MAX_STEPS = 40` (`loop.ts:94`) is therefore dead for the product path, and `perGoalMaxSteps = min(maxSteps, DEFAULT_PER_GOAL_STEPS) = min(12,12) = 12` (`loop.ts:379`) — meaning **one sub-goal can consume the entire run budget**, after which the run ends `uncertain` (`loop.ts:371,636`). No caller overrides it: `cli.ts --max-steps` defaults undefined, `mcp-server.ts:27` caps at 30 but defaults to 12, `vibe/service.ts` passes nothing — and the MV3 lite path has its *own* independent hardcoded 12 (`src/extension/lite-engine.ts:185`), bypassing `config.ts` entirely.

`CLAUDE.md` documents "maxSteps 40 (per-goal budget 12)". A realistic multi-page flow (login → browse → cart → checkout) exceeds 12 actions before reaching the assertion, so on a fully-featured app the default configuration cannot finish the flow it was asked to test — and it fails as `uncertain`, the least actionable verdict.

---

### P2

#### A18 (P2) — 4xx responses are invisible to the failure signal

`failed` is set only for `status >= 500` or a transport-level `loadingFailed` (`src/capture/console-network.ts:54,58-70`). It is worse than "unflagged": the navigator prompt filters network entries by `.filter((e) => e.failed)` before showing them (`planner-prompt.ts:31-35`), and the batch-abort check gates on `.failed` too (`loop.ts:334-337`) — so a 400/401/403/404 from an API, the most common signature of a real broken flow, is **entirely absent from what the model ever sees during a live run**. (The post-run `spike fix` prompt does check `status >= 400` — `vibe/fix-prompt.ts:75,190` — but that runs after the verdict is already decided.)

#### A19 (P2) — AX tree is refetched in full every step and truncated on large pages

`Accessibility.getFullAXTree({})` fetches the entire tree over CDP, then prunes in Node (`src/capture/axtree.ts:54,70-131`) — CDP does no pruning. Called unconditionally at the top of every iteration (`loop.ts:664`), again in `escalate()` (`loop.ts:448`), and again in the initial plan (`loop.ts:595`). `lastSnapshotAx` (`loop.ts:398`) is stored but never read back to skip a fetch.

`MAX_CHARS = 6000` (`axtree.ts:12`) with a keep-first-40%-plus-tail elision (`axtree.ts:117-129`). On a dense enterprise page this truncates aggressively and sets `truncated: true` — the navigator then plans against a partial view of the page, which is a direct hallucination driver on exactly the "fully-featured product" case the question is about.

#### A20 (P2) — No rate-limit awareness or backoff

Every adapter defaults to a 120 s timeout (`ollama.ts:30`, `anthropic.ts:73`, `cli-planner.ts:147`, `openai-compatible.ts:94`, `google-cli.ts:177-178`, `byok-gemini.ts:87`), backstopped by `LLM_CALL_TIMEOUT_MS = 130_000` (`loop.ts:88`). On failure the router falls to the **next rung** (`model-router.ts:299-342`) — it never retries the same adapter and never special-cases HTTP 429.

Under any future parallel suite this degrades silently: a burst of 429s from the preferred model quietly demotes every worker to a weaker rung, and the only visible symptom is worse verdicts.

#### A21 (P2) — `--heal` overwrites the script in place with no review gate

`--heal` runs a **full AI pass** (`engine.ts:602-607`), then reuses the same name (`newScript.name = script.name`, `engine.ts:610`) and re-saves, stamping `healedFrom` (`:611-615`). The old steps are gone; the only record is a logged diff (`:616`). No versioning, no dry-run, no approval step.

For a regression suite this is a correctness hazard: a heal that "fixes" a script by routing around a genuine regression silently converts a real bug into a green test.

**Reframed for autonomy (2026-08-08):** a blanket human approval gate contradicts the autonomous goal. The correct design is **risk-tiered auto-accept** with a full audit trail: a heal that only re-resolved a locator (same steps, same assertions, different target descriptor) auto-accepts; a heal that changed step *count*, removed an assertion, or weakened one (exact → contains) is quarantined for review and the flow is reported as `needs-review`, not `pass`. The unacceptable status quo is that all three cases are treated identically and silently.

#### A22 (P2) — Screenshots only on `assert_visual` and `finish`

`browser.screenshot()` fires only at `loop.ts:512` (finish confirmation), `loop.ts:967` (`assert_visual`), and `loop.ts:1267` (final fallback). Correct for speed, but it means a failed step mid-flow has no visual evidence — on a 200-flow suite, debugging a red run means re-running it.

---

---

## Autonomy layer (added 2026-08-08)

A1–A22 make the runner fast and trustworthy **per flow**. They do not make it autonomous over a whole project — every one of them assumes a human supplies the task string. A23–A26 are the missing axis; A27 corrects lite mode.

### P0

#### A23 (P0) — No discovery or coverage model: nothing knows what the app *contains*

Every entry point takes a single task + url: `qa_run` (`src/mcp-server.ts:19-20`), `spike run "<task>" --url`, and the vibe panel's current tab. There is no crawler, no route enumeration, no site map, no state model, and no record of which parts of the app have ever been exercised. `listScripts()` (`recorder/script.ts:267-274`) is an unordered directory read — the closest thing to a suite, and it only knows what a human already asked for.

Consequence: "autonomous QA of a full project" is currently "a human writes 200 task strings, and the tool runs them." The tool cannot answer *what haven't we tested?* — which is the question that makes QA autonomous rather than merely automated.

Needed: a discovery pass that enumerates reachable routes/states (crawl + link extraction + form detection, seeded from the app's own router manifest where available), a persisted app model, and a coverage ledger (routes seen / routes exercised / interactive elements touched / flows generated) that the planner can query to prioritise untested surface.

#### A24 (P0) — No autonomous oracle: expectations only ever come from a human or one-shot LLM opinion

This is the hardest problem in autonomous QA and the audit's biggest omission. Today a verdict derives from exactly two sources: a human-written task string interpreted by the brain, or `assert_visual`'s subjective screenshot judgement (`src/router/verdict.ts:15-22`). A5 improves the assertion *primitives*; it says nothing about **who generates the expectation** when no human wrote one.

Nothing in the codebase implements any of the three standard autonomous oracles:
- **Differential** — run the same flow against the previous build/deploy and diff outcomes. Requires a baseline store, which does not exist (A11).
- **Invariant-based** — assertions true of *every* page regardless of intent: no uncaught page errors, no 5xx (and no 4xx — A18), no layout overflow, no broken images, no empty required regions, no a11y violations, response under budget. These need no human input at all and would catch a large share of real regressions.
- **Metamorphic** — relations that must hold across runs (adding an item increases cart count by exactly 1; sorting preserves set membership).

Without at least the invariant tier, an autonomous run can only ever report "the AI thought it looked fine", which is precisely the hallucination exposure the whole exercise is trying to remove.

### P1

#### A25 (P1) — "AI once → deterministic forever" is too static; nothing re-explores when the app changes

The recorder fires once on a passing run (`engine.ts:546-550`) and `--heal` fires only when an existing script *fails* (`engine.ts:599`). There is no trigger anywhere for "the app gained surface" — a new route, a new form, a new feature ships and the suite neither notices nor grows. Combined with A23 (no app model to diff against), the suite's coverage can only ever shrink relative to the product.

Needed: capture an app-model fingerprint per run (route set + per-route AX signature), diff it on the next run, and trigger targeted AI authoring for *new or changed* surface only — so the expensive AI pass is spent exactly where determinism has nothing to replay. This is what makes the blend self-sustaining rather than a one-time bootstrap.

#### A26 (P1) — Core-mode engine: **RESOLVED 2026-08-08 — adopt Playwright via `connectOverCDP` for A3/A6/A13; hand-build A4**

The original framing ("this gates A3/A4/A6/A13") was wrong on scope. `BrowserPort` is shared by Core *and* lite mode, and Playwright can never serve the `chrome.debugger` transport — so **A4 (auto-waiting) must be hand-built in the port layer regardless**, because lite mode suffers the identical fixed-sleep flakiness and needs the same fix. Building it once in `BrowserPort` serves both tracks. A6 is also ~100 lines over `Network.getCookies`/`setCookies` through the existing `cdpClient()` escape hatch (`cdp-browser.ts:70-72`).

So the real question was narrower: **who provides parallel isolated contexts (A3), and routing (A13)?**

**Spike result (2026-08-08, `playwright-core` against branded Chrome on its own port/profile — 9/9 checks passed):**

| Check | Result |
|---|---|
| `connectOverCDP` attaches to an already-running Chrome | PASS |
| `browser.contexts()` exposes the existing default context | PASS — 1 context |
| **`browser.newContext()` succeeds over CDP** | **PASS — contexts 1 → 3** |
| **Cookies isolated per context** | **PASS — A sees it, B does not** |
| **localStorage isolated per context** | **PASS — A: `"A"`, B: `null`** |
| `storageState()` exports cookies + origins (A6 primitive) | PASS |
| Two contexts drive concurrently | PASS — 135 ms for both |
| Closing one context leaves others + the original Chrome intact | PASS |
| `context.route()` interception (A13 primitive) | PASS |

The pre-spike concern — that `connectOverCDP` only operates over the existing default context — **does not hold**. New contexts are genuinely isolated for both cookies and localStorage, they drive concurrently, and closing one does not disturb the daemon's original Chrome or its Nano tab.

**Decision:**
- **A3 / A6 / A13 → Playwright via `connectOverCDP`**, as a third `BrowserPort` implementation (`PlaywrightBrowser`) alongside `CdpBrowser` and `ExtensionBrowser`. The daemon keeps launching and owning Chrome exactly as it does today; Playwright attaches. Nano stays in the same browser, untouched.
- **A4 → hand-build in `BrowserPort`**, so lite mode gets auto-waiting too.
- Dependency weight objection is smaller than assumed: `playwright-core` installs as **1 package with no browser download**, since `connectOverCDP` uses the Chrome that is already there.
- This does not re-open the DROPPED decision (`2026-07-07-passmark-gap-implementation-tasks.md:225`): that rejected shipping a *Playwright-library product shape*. This is an internal engine choice behind an existing port interface, invisible to users. (A16's `.spec.ts` twin remains a separate question.)

Spike script retained at `docs/plan/spikes/a26-connect-over-cdp.mjs` for re-verification against future Chrome/Playwright versions.

#### A27 (P1) — Lite mode's navigator pin is a silent no-op, so its two-tier split is accidental

`DEFAULT_SETTINGS.navigator` is `{ provider: 'nano', mode: 'ondevice' }` (`src/vibe/settings-data.ts:73`), but the lite ladder documents that this pin does not resolve to a plan-step candidate: *"nano (navigator default) is handled separately as the rung-0 visual adapter, so a nano navigator resolves to name 'nano' here — **not a plan-step candidate yet**, so the router falls through to the next available cloud adapter"* (`src/extension/lite-engine.ts:88-91`).

So lite mode today *does* end up with a small model navigating — but by accidental fallthrough (`modelFor()` defaults an unpinned rung to the navigator tier, `lite-engine.ts:102`), not by design, while the Settings panel displays "Nano" as the configured navigator. The user-visible configuration and the actual behaviour disagree.

Per the two-track decision, lite mode is **intentionally AI-powered**: BYOK key, small model navigates every step, big model decides. That should be the explicit default, not a fallthrough:
- Navigator default → a cheap vision-capable API model (`claude-haiku-4-5` or `gemini-3-flash-preview`; both already in `NAVIGATOR_MODELS`, `settings-data.ts:88-92`), matching the "reliable non-Nano recipe" already documented in `CLAUDE.md`.
- Brain default stays `claude:api` Sonnet (`settings-data.ts:69`) — consulted rarely, so a smart model barely moves run cost.
- Nano stays available as an opt-in $0 navigator and as the rung-0 visual adapter, clearly labelled Experimental (per `CLAUDE.md`'s own note that Nano-as-navigator is "real but rough").

---

## Feature suggestions, enhancements & upgrades

Ordered roughly by leverage per unit of work. Items 1–5 are the ones that actually answer the question.

1. **`waitFor` / actionability as a first-class `BrowserPort` primitive.** Add `waitFor(condition: {nodeId?, role?, name?, state: 'attached'|'visible'|'enabled'|'stable'})` plus a `waitForIdle({networkQuiet, domQuiet})`, then delete every fixed `sleep()` in `cdp-browser.ts` and `replay.ts` in favour of it. This is the single change that improves speed *and* flake at once. Cheap to build: `Network.enable` is already on for every session (`console-network.ts:22`), so network-idle needs no new CDP domain. Reference model: Playwright's actionability checks (attached → visible → stable → receives-events → enabled).

2. **A real assertion vocabulary.** Add deterministic primitives alongside the existing substring `assert_dom`: `assert_text {exact|contains|regex}`, `assert_count {role, name, n}`, `assert_url {equals|matches}`, `assert_attr`, `assert_network {urlPattern, status}`, `assert_no_console_errors`, `assert_visible/hidden/enabled/disabled`. Keep `assert_visual` for the genuinely semantic case. This is what makes a recorded script durable and is a prerequisite for trusting replay in CI.

3. **Parallel isolated runs.** Smaller than it looks: `CdpBrowser` and `NanoRunnerPage` already take `port`/`profileDir` per instance (`cdp-browser.ts:49`, `nano-runner-page.ts:33`), and `chrome/launch.ts` holds no global state — two Chromes on two ports+profiles can coexist today. The work is mostly config plumbing: allocate free ports dynamically instead of the fixed 9322/9400 defaults, add `--workers N` to `replay --all`, and make the Nano runner either per-session or a properly locked shared service (the real architectural constraints are the VibeService single-run lock, `vibe/service.ts:94,119`, and the single warm Nano tab). Combined with items 1 and 4, this is the 80–100× suite number.

4. **Session/storage state capture and injection.** `saveStorageState()` / `loadStorageState()` over `Network.getCookies`/`setCookies` + a `localStorage` snapshot, plus a suite-level `auth` fixture that logs in once and injects state into every subsequent flow. Removes 200 redundant logins and decouples every flow from login stability.

5. **Make deterministic-first the default, with the AI as the fallback.** Flip `actionCache` to `true` by default (after tightening `verifyActionEffect` per A9), and reframe the CLI around a two-mode contract: `spike author <task>` (AI, once, expensive, emits a script) and `spike test [suite]` (deterministic, $0, parallel, CI-shaped). The current single `spike run` conflates them, which is why the deterministic path never gets exercised (A1).

6. **Tighten `verifyActionEffect` to intent-specific proof.** Remove the `changes.length` catch-all at `action-cache.ts:335`; require an effect that matches the action's intent (a click must produce a *targeted* change — the target's own state, a new URL, or a named region mutation — not merely "the page changed").

7. **Headless for the deterministic path.** Replay does not need Nano except for `assert_visual` (`replay.ts:53-55,186-193`), so it *can* go headless — but not as a lone flag: today `NanoRunnerPage` and `CdpBrowser` are tabs in **one** Chrome process on the shared `cfg.cdpPort` (`engine.ts:188-189,224`), and `ensureChrome()` no-ops if the port is alive (`launch.ts:44`), so whichever caller launches first wins the headless/headed choice — a headless replay launched first would silently drag Nano into a headless Chrome, violating its documented headed requirement (`nano-runner-page.ts:66`). Prerequisite: split the Nano runner onto its own port/Chrome (a slice of item 3). Then ship `--headless` as the CI default for replay.

8. **A hand-authored script format as a supported, documented, zod-validated workflow.** Publish the JSON schema, validate on load, ship a `spike validate <script>` command and a JSON-schema file for editor autocomplete. This is the direct answer to "I don't want AI in my regression suite" and it costs very little on top of A14.

9. **Network interception.** `route()`-style stubbing over `Fetch.enable` for: blocking third-party/analytics (speed), forcing error states (deterministic negative tests), and request assertions. Also add `Emulation` for viewport/device/network-throttle coverage.

10. **Flake control.** Per-flow `retries: N` config, a `flaky` verdict when a flow fails then passes on retry, a quarantine list excluded from the exit code, and a suite report that separates *regressions* from *flakes*. Without this a large suite loses credibility within weeks.

11. **Locator strategy upgrade.** Add `data-testid`-first resolution with role+name as fallback, teach the recorder to prefer a testid when present, and replace the hard-fail on ambiguity with a scored disambiguation (position, nearest-landmark, sibling text) before giving up. Also record a *stack* of candidate locators per step so replay can degrade rather than fail.

12. **Fix or retire the `.spec.ts` twin.** Its current state overpromises (A16). Honest framing: making it genuinely runnable (optional `@playwright/test` peer, emitted config, real `expect()` calls, placeholder resolution) **is functionally a thin Playwright integration — i.e. a partial reversal of the DROPPED decision** (`docs/plan/2026-07-07-passmark-gap-implementation-tasks.md:225`), and should be weighed as such. The non-conflicting alternative is to demote the twin to a clearly-labelled human-readable summary and stop implying runnability. Pick one deliberately; the untenable option is the status quo.

13. **Suite orchestration.** Ordering, tags/filters, `beforeAll`/`afterAll`, shared fixtures, sharding (`--shard 1/4`), and a machine-readable suite report (JUnit XML + JSON) so it drops into any CI. Plus content-hashed script names to kill the slug-collision overwrite (A10).

14. **Raise and decouple the step budget.** Set `cfg.maxSteps` to the documented 40, keep `perGoalMaxSteps` at 12 so a single goal cannot eat the run, and reconcile `CLAUDE.md` (A17). Consider making the budget adaptive — a flow making steady progress should not be cut off at a fixed number.

15. **Incremental AX snapshots** *(exploratory — higher risk than the rest of this list)*. CDP's `Accessibility.loadComplete`/`nodesUpdated` events are marked experimental, and patching a cached tree from deltas means maintaining a full live AX graph client-side — a materially bigger lift than "subscribe to events". Treat as a spike, not a task. The safer near-term win from A19 is the second half: raise/adapt the 6000-char cap for dense pages with a region-focused serialization (only the subtree under the current goal's landmark).

16. **Treat 4xx as a failure signal** (A18), and expose console/network failures as *assertable* conditions rather than prompt evidence only (A5).

17. **Heal with a review gate.** Version healed scripts (`name.v2.json`), keep the prior version, emit the diff as a reviewable artifact, and require `--heal --accept` (or a CI annotation) before a healed script becomes the suite's truth (A21).

18. **Benchmark harness.** `docs/benchmark.md` has one cost measurement and no speed/parallelism baseline. Add a repeatable harness over the fixture app that reports: per-step latency split (model vs CDP vs sleep), suite wall-clock at N workers, replay-vs-AI ratio, and flake rate over 20 consecutive runs. Without it, none of the above can be shown to have worked.

19. **Dogfood to a real recorded suite.** Turn off `readOnly` for the fixture app, get a genuine pass, and land the resulting `generated-tests/*.json` as a committed regression suite for this repo itself (A1). Nothing else on this list is trustworthy until that exists.

20. **App model + coverage ledger** (A23). A discovery pass that enumerates reachable routes and states (crawl + link/form extraction, seeded from the app's router manifest when available), persisted as an app model, plus a coverage ledger the planner queries to pick what to test next. `spike map <url>` as the entry point; `spike coverage` to report untested surface. This is the difference between automated and autonomous.

21. **Invariant oracle tier** (A24). The cheapest autonomous oracle and the highest value-per-line on this list: assertions true of every page with zero human input — no uncaught page errors, no 4xx/5xx (A18), no layout overflow, no broken images, no empty required regions, optional a11y and response-budget checks. Run them on *every* step of *every* flow, deterministic and free. Follow with a differential tier (baseline store, reused from A11) and metamorphic relations for cart/sort/pagination-style invariants.

22. **Change-triggered re-exploration** (A25). Fingerprint the app model per run (route set + per-route AX signature), diff on the next run, and spend the AI authoring pass only on new or changed surface. This is what makes the blend self-sustaining instead of a one-time bootstrap.

23. **Decide the Core-mode engine** (A26). Write the decision down: Playwright via `connectOverCDP` as a third `BrowserPort` implementation, versus hand-building A3/A4/A6/A13. Spike `connectOverCDP` first to verify per-run `BrowserContext` isolation actually satisfies A3 — that single unknown decides it. Do this **before** starting A3/A4/A6/A13, or that work risks being thrown away.

24. **Make lite mode's AI split explicit** (A27). Default the lite navigator to a cheap vision API model (`claude-haiku-4-5` / `gemini-3-flash-preview`, both already in `NAVIGATOR_MODELS`), keep the brain on Sonnet, demote Nano to an opt-in Experimental navigator, and make the Settings panel show what is actually running. Pair with panel copy that states the contract plainly: *one API key; a small model drives, a big model judges.*

25. **Risk-tiered heal acceptance** (A21, reframed). Auto-accept locator-only heals; quarantine heals that change step count or weaken assertions, reporting the flow as `needs-review` rather than `pass`. Keeps the loop autonomous without letting a heal silently launder a real regression into green.
