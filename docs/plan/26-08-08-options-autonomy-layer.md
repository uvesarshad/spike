# Design options — autonomy layer (A23–A27, A21)

> Source audit: [26-08-08-audit-deterministic-speed](./26-08-08-audit-deterministic-speed.md)
> Task list: [26-08-08-tasks-deterministic-speed](./26-08-08-tasks-deterministic-speed.md)
> Status: options for decision — nothing here is committed yet.

Each section lists the real options, the tradeoff that actually decides between them, and a recommendation. Existing code that can be reused is cited, because several of these are much cheaper than they look.

---

## Correction to the audit's A26 framing

The audit says A26 (engine decision) gates A3/A4/A6/A13 and must be decided first. **That is only true for A3.** The reasoning I missed:

`BrowserPort` is shared by Core mode *and* lite mode. Lite mode is now AI-driven by design (two-track decision) — but an AI-driven run suffers the *same* fixed-sleep flakiness as a deterministic one (`cdp-browser.ts`, ~20 hardcoded sleeps). So **A4 (auto-waiting) must be hand-built in the port layer regardless of the Playwright decision**, because Playwright cannot serve the `chrome.debugger` transport. Building it once in `BrowserPort` benefits both tracks.

Similarly, A6 (storage state) is ~100 lines over `Network.getCookies`/`setCookies` through the existing `cdpClient()` escape hatch (`cdp-browser.ts:70-72`) — not worth a dependency decision.

So the Playwright question reduces to: **A3 (parallel isolated contexts), and A13 (routing) as a follow-on.** That is a much smaller decision, and it stops blocking A4/A6, which can start immediately.

---

## A23 — Discovery & coverage model

Three sub-decisions: how to discover, what counts as a "state", and what to measure.

### Discovery mechanism

| Option | Cost | Reaches | Notes |
|---|---|---|---|
| **1. Static route extraction** — parse Next.js `app/`/`pages/`, React Router config, `sitemap.xml`, `robots.txt` | Free, instant | Declared routes only | Daemon already has filesystem access (auto-fix edits files). Framework-specific parsers = ongoing maintenance. Unavailable in lite mode. |
| **2. Deterministic crawl** — BFS over `<a href>`, same-origin, depth-capped | Cheap, no model | Link-reachable pages | Framework-agnostic; works on no-code builds (WordPress/Framer/Webflow), which the product explicitly targets. Misses interaction-gated state; can explode on parameterised URLs. |
| **3. AI exploration** — navigator drives with goal "catalogue distinct states" | Expensive (~5.4 s/step) | Modals, wizards, tabs, SPA states | The only thing that reaches interaction-gated surface. Non-deterministic coverage; needs a budget. |
| **4. Passive observation** — extension records real navigation | Free | Whatever a human touches | Naturally covers auth-gated areas and reflects real usage priority. Needs a human; accrues slowly. |

**Recommendation: layer them cheapest-first**, mirroring the existing model-ladder philosophy. Static seeds → crawl expands → AI only for what the crawl provably cannot reach (elements the AX tree shows as interactive but that produced no navigation), under a step budget. Option 4 as a free bonus input in lite mode.

### What is a "state"?

| Option | Granularity | Risk |
|---|---|---|
| URL only | Coarse | Misses modal/drawer/tab states entirely — fatal for SPAs |
| URL + full AX signature | Fine | State explosion: every cart permutation is a new state |
| **URL + structural signature** (roles + depth, names/values dropped) | Right | Collapses data variation, keeps structural variation |

**Recommendation: `(normalizedUrl, structuralSignature)`.** Both primitives already exist and are tested: `normalizeUrlForActionCache()` (`action-cache.ts:103-120`, already strips tracking params and normalises paths) and `pageSignatureFromAx()` (`action-cache.ts:126-135`). The only new work is a structural variant of the latter that drops `name`/`value` from `stableAxMaterial()` (`action-cache.ts:584-597`) and keeps role+depth. That is a ~15-line change to proven code, not a new subsystem.

### Coverage metric

- **Route coverage** — legible, good for reporting, weak signal.
- **Interactive-element coverage** — elements clicked ÷ elements discovered, derived directly from AX snapshots the loop already takes every step. This is the metric that actually answers *"what haven't we tested?"*
- **State coverage** — meaningful but explodes.
- **Flow coverage** — most meaningful, hardest to define.

**Recommendation: report route + interactive-element coverage.** Element coverage is nearly free given the loop already snapshots the AX tree unconditionally (`loop.ts:664`).

**Storage:** `.spike/app-model.json` — routes, states, elements, last-exercised timestamp, and which script covers each. Entry points `spike map <url>` and `spike coverage`.

---

## A24 — The autonomous oracle

The hardest item, and worth being explicit that the tiers differ enormously in confidence.

### Tier 0 — Invariants (deterministic, free, zero human input)

Assertions true of essentially every correct page:

- No uncaught page errors / unhandled promise rejections / `console.error`
- No 4xx or 5xx on same-origin requests (requires the A18 fix — 4xx is currently filtered out before the model ever sees it)
- **No `undefined` / `NaN` / `null` / `[object Object]` / `Infinity` rendered in visible text**
- No broken images (`naturalWidth === 0`)
- No layout overflow (horizontal body scrollbar; elements outside viewport)
- No empty required regions (a `main` and an `h1` exist and are non-empty)
- No stuck loading state (skeleton/spinner still present after N seconds)
- Optional: a11y subset (duplicate ids, unlabelled inputs), response-time budget

The third item deserves emphasis: it catches the *exact* bug class the project's own fixture simulates (`order.total` undefined → `--bug on`), and it is the single most common failure mode in vibe-coded apps, which are this product's stated audience. Rendered-`undefined` is a deterministic, zero-cost, high-yield check.

**Cost:** one `Runtime.evaluate` per step, no model. **Risk:** false positives on apps that legitimately render "null" — needs a per-project allowlist in `spike.config.json`.

### Tier 1 — Differential (compare against a baseline)

| Variant | Stability | Notes |
|---|---|---|
| **AX structural diff** | High | Natural fit — this codebase is already AX-first, and `pageSignatureFromAx()` exists |
| Screenshot pixel diff | Low | Classic but noisy: fonts, animation, dynamic content |
| Network-shape diff | High | Same requests, same statuses — cheap and surprisingly effective |
| Extracted-value diff | High | Reuses `run-data` extractions |

The blessing problem: every intentional UI change reads as a regression until approved. Two ways out —
- **Across time** (this build vs last): needs a blessing step, i.e. a human, which fights autonomy.
- **Across environments** (staging vs prod, or PR preview vs main): needs no blessing at all, because both are live simultaneously and *divergence itself* is the signal. Strictly better for an autonomous system when two environments exist.

**Recommendation:** AX-structural + network-shape diff, environment-to-environment where available, time-to-time with auto-blessing of changes that coincide with a known deploy otherwise. Pixel diff opt-in only.

### Tier 2 — Metamorphic (relations that must hold)

Add item → cart count +1. Sort → same set, different order. Filter → subset. Pagination → disjoint pages whose union is the total. Login→logout→login returns to the same state. Same URL twice → same state.

The hard part is knowing *which* relation applies *where*. Options: a hand-authored relation library matched to detected UI patterns (cart, list, table, paginator), or AI-proposed relations.

**Recommendation: AI proposes candidate relations once per detected pattern; they are verified once; then they run deterministically forever.** That is precisely the blend thesis applied to oracles — AI at authoring time, determinism at runtime. But treat this tier as **research, not a scheduled task**: it is the one item on this list I would not commit a date to.

### Tier 3 — Spec-derived (opportunistic)

If the project has an OpenAPI spec, TypeScript types, or existing test names, derive expectations from them. The daemon has filesystem access. Underrated: an OpenAPI spec states exactly which status codes are legal per endpoint, which turns Tier 0's network invariant from a heuristic into a real contract check.

**Overall recommendation:** Tier 0 immediately (cheap, no infrastructure, high yield). Tier 1 next (shares the baseline store with A11's flake detection). Tier 3 where a spec exists. Tier 2 as a spike. Honest estimate: **Tier 0 + Tier 1 capture most of what an autonomous system can catch without human intent.**

---

## A25 — Change-triggered re-exploration

### Trigger

| Option | Precision | Requires |
|---|---|---|
| Git watch — diff changed files → map to routes | High | Source access + file→route mapping |
| **App-model fingerprint diff** — re-crawl, compare to stored model | Medium-high | Nothing; works on deployed apps with no source |
| Deploy/CI hook — `spike map --diff` post-deploy | High | CI integration |
| Scheduled nightly crawl | Low latency-wise | Nothing |

**Recommendation: fingerprint diff is the engine; the trigger is whichever of git-watch / deploy-hook / schedule is available.** The diff logic is identical regardless of what fires it, so build that once and let the trigger be pluggable.

### Response

- **New route/state** → author a new flow (AI, budgeted)
- **Changed structural signature** → re-validate scripts touching it; heal if broken (feeds A21)
- **Removed route** → retire its scripts, report
- **Unchanged** → do nothing — this is the entire point, and it is what keeps the AI spend proportional to *change*, not to *app size*

### Budget

**Recommendation: priority queue drained under a spend cap.** `spendCapUsd` already exists in config (`config.ts`), and `estimatedPaidSpendUsd` is already enforced in the loop. Prioritise by: newly-added surface > changed surface with existing coverage > changed surface without coverage. This makes the autonomous loop's cost predictable, which matters more than optimality.

---

## A26 — Core-mode engine

Reduced (see the correction above) to: **who provides parallel isolated contexts (A3), and routing (A13)?**

| Option | Gets you | Costs |
|---|---|---|
| **1. Playwright, launched** (`channel: 'chrome'` to drive installed Chrome, preserving Nano) | Everything, cleanest API, trace viewer | Heavy dep; Playwright manages the browser lifecycle, so the daemon's process model and the Nano tab arrangement need rework |
| **2. Playwright via `connectOverCDP`** | Attaches to the Chrome the daemon already launches — Nano untouched, process model preserved | **Unverified:** whether `browser.newContext()` over a CDP-connected browser gives genuine per-run isolation. This single unknown decides the option. |
| **3. Hand-build on `CdpBrowser`** | Full control; identical behaviour in extension mode | Real work — parallel contexts over raw CDP (`Target.createBrowserContext`) is the genuinely hard part |
| 4. Hybrid — Playwright for the replay runner, `CdpBrowser` for AI authoring | Each engine does what it is best at | Two code paths, recorder must serve both |

### RESOLVED 2026-08-08 — Option 2

The spike ran (`docs/plan/spikes/a26-connect-over-cdp.mjs`, `playwright-core` against branded Chrome on its own port/profile): **9/9 checks passed.** `browser.newContext()` works over `connectOverCDP` (contexts 1 → 3), cookies and localStorage are genuinely isolated per context, `storageState()` exports cleanly, two contexts drive concurrently (135 ms for both), closing one context leaves the others and the daemon's original Chrome intact, and `context.route()` interception works.

The pre-spike worry — that a CDP-connected browser only exposes its existing default context — **does not hold**.

**Decision: A3 / A6 / A13 via Playwright `connectOverCDP`, as a `PlaywrightBrowser` implementation of the existing `BrowserPort`. A4 hand-built in the port layer so lite mode gets it too.** The daemon keeps owning Chrome; Playwright attaches. `playwright-core` is 1 package with no browser download, so the dependency-weight objection is minor. Not a reversal of the DROPPED decision — that rejected a Playwright-shaped *product*, this is an internal engine behind an existing interface.

---

## A27 — Lite mode's AI split

| Option | One key? | Reliability | Notes |
|---|---|---|---|
| 1. Fixed cheap cloud navigator (`claude-haiku-4-5` / `gemini-3-flash-preview`) | Maybe two | High | Matches the "reliable non-Nano recipe" already documented in CLAUDE.md |
| 2. Make Nano a real plan-step candidate, keep it default | Yes ($0) | **Low** — CLAUDE.md records Nano-navigator guessing URLs and repeating failed navigations | Preserves $0 but ships a known-rough default |
| **3. Provider-matched tiers** — navigator = cheap tier of whatever key the user entered; brain = smart tier of the same provider | **Yes** | High | Anthropic key → Haiku drives, Sonnet judges. Gemini key → Flash drives, Pro judges. |
| 4. Ask during onboarding | No | High | Friction, against the zero-install pitch |

**Recommendation: Option 3.** It is the literal expression of *"one API key: a small model navigates, a big model decides"*, needs no second key, and both tiers are already tabulated in `NAVIGATOR_MODELS` / the brain table (`settings-data.ts:88-92`).

Two details that matter:

1. **Vision is not required for the navigator.** The loop is accessibility-tree-first; screenshots are only taken for `assert_visual` and the finish confirmation (`loop.ts:512,967,1267`). So a text-only cheap model (GLM, or any text tier) is a perfectly good navigator — only the *visual* role needs vision. This widens Option 3's provider coverage considerably.
2. **The Settings panel must display the resolved navigator, not the pin.** The current bug is precisely that it shows "Nano" while a cloud adapter is actually driving (`lite-engine.ts:88-91,102`). Whatever default is chosen, the panel showing something other than what runs is the thing to fix.

Nano stays available as an explicit opt-in $0 navigator, labelled Experimental, and remains the rung-0 visual adapter.

---

## A21 — Risk-tiered heal acceptance

### Classifier

| Option | Deterministic | Notes |
|---|---|---|
| **1. Structural diff rules** | Yes | Explainable, cheap, auditable |
| 2. AI judges the diff | No | Reintroduces hallucination at the exact moment correctness is decided |
| **3. Behavioural check** — run the OLD script's assertions against the NEW script's execution | Yes | Strongest single signal: if the old assertions still pass, the heal preserved semantics |
| 4. Quarantine everything | Yes | Safe, not autonomous |

**Recommendation: Option 1 as the gate, Option 3 as corroboration where the old assertions are still runnable.** Option 2 may only ever *escalate* to quarantine, never de-escalate to auto-accept.

### Tiers

- **Auto-accept** — same step count, same types in order, assertions byte-identical; only `target` descriptors changed. (A locator moved; nothing about intent changed.)
- **Accept with notice** — steps added that are navigation/wait only; assertions unchanged.
- **Quarantine → `needs-review`** — any step removed, any assertion removed, weakened (`exact`→`contains`, or a `contains` string shortened), or re-targeted.

### What `needs-review` means without a human

This is the part that keeps it autonomous *and* honest:

- The flow is **excluded from the pass/fail exit code** and reported in its own bucket.
- The **old script stays active** until the heal is reviewed — an unreviewed heal never silently becomes the suite's truth.
- If nobody ever reviews, the flow degrades to **"unverified"**, not to green.

That last rule is the whole safety property: the failure mode of an unattended autonomous system should be *loss of coverage you can see*, never *false confidence you cannot*.
