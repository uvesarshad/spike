# Changelog

All notable changes to this project are documented here, in the style of
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/). This project has
not yet cut a versioned release (`package.json` is still `0.0.1`); the
history below is grouped by development "wave" — the unit of work this repo
actually shipped in — rather than by version tag, and will be reorganized
under proper version headers starting with the first tagged release.

## [Unreleased]

### Fix wave 3 — driver hardening, extension reliability, retry/leak fixes

- **Fixed:** the live driver loop now routes clicks/types/hovers through the
  same actionability wait the deterministic replay path already used, closing
  a race-condition gap between the two execution paths (both direct
  execution and the action-cache path).
- **Fixed:** the action cache now verifies target resolution and
  actionability *before* dispatching a mutating cached action, instead of
  executing first and checking after — a stale cache hit can no longer cause
  a real side effect on the app under test. It also no longer guesses on
  role+name collisions with no `nth` disambiguator; an ambiguous match is
  now a cache miss.
- **Fixed:** goal-driven work is now bounded — goals are capped at 12 and
  `goalComplete` transitions are counted against a fixed budget, so a
  misbehaving brain that keeps re-extending the goal list can no longer
  dodge the step budget.
- **Fixed:** the 3x-repeat-action detector is now effect-aware and
  goal-boundary-aware — a legitimate repeated action that actually changed
  the page (a stepper "+", a wizard "Next") no longer burns a brain
  escalation.
- **Fixed:** `drag_and_drop` now gets the same stale-node retry every other
  action verb already had.
- **Fixed:** lite-mode (extension-only) runs now checkpoint to
  `chrome.storage.session`, so an MV3 service-worker eviction mid-run is
  reported as an orphaned run instead of the UI going silent.
- **Fixed:** a `chrome.debugger` detach mid-run now aborts the active run
  with a clear message, on both the daemon path (bridge event) and the lite
  path.
- **Fixed:** HTTP `Retry-After` headers (429/503) are now read and fed into
  the same typed retry-hint path Gemini's body-embedded `retryDelay` already
  used, instead of blind exponential backoff.
- **Fixed:** a resource-leak window between opening a browser session and
  the point the driver's `try/finally` took over is closed — a persistent
  misconfiguration (e.g. a bad model id) no longer leaks a tab/bridge
  connection on every attempt.

### Fix wave 2 — legal/docs, auto-fix hardening, prompt hardening

- **Added:** `PRIVACY.md` filled in (product name, effective date, support
  email, corrected model-ladder table with the dead Gemini CLI free tier
  removed) and `SECURITY.md` added (private advisory reporting, scope,
  90-day disclosure expectation, `npm audit` caveat).
- **Changed:** the third-party production site previously named in docs and
  code comments as a live-run example has been redacted throughout.
- **Fixed:** the product doc was renamed so every README/doc cross-reference
  that pointed at it now resolves.
- **Fixed:** the auto-fix path now sanitizes embedded console/network text
  before it reaches a file-editing agent (fence-escaping, ANSI/control-char
  stripping, per-line length cap) and requires a one-time per-project
  consent step before any unattended file edit — wired through both the CLI
  (`--yes-auto-fix`) and the daemon bridge (`confirmed` param).
- **Added:** untrusted-content framing on navigator/brain prompts (matching
  the framing the fix-prompt path already had), and the duplicated
  rules/action-vocabulary block across prompt builders was consolidated into
  one shared constant.
- **Removed:** the dead single-tier prompt builder (superseded by the
  navigator/brain split).
- **Changed:** the `qa_run` MCP tool description now discloses its
  auto-trust-the-named-host behavior to integrators.

### Fix wave 1 — P0 engine reliability

- **Added:** `strictOracles` config — deterministic-oracle gating so
  Tier-0/assertion/relation-check violations can force a `fail` verdict
  instead of being advisory-only evidence.
- **Fixed:** the navigator-only (no-brain, $0) degrade path — it now gets
  the full 40-step budget and one recovery retry instead of ending the run
  immediately on the first stall.
- **Fixed:** a mid-batch node-map clobber that could resolve a later action
  in a batch against a stale/replaced element map — the rest of a dirtied
  batch is now discarded rather than misdirected.
- **Fixed:** CDP and CLI-adapter calls that previously had no timeout
  (`assertMutationAllowed`, `url()`, CLI `--version` availability probes)
  are now wrapped in the existing timeout helper, so a hung page or a hung
  probe can no longer wedge a run — or the whole router — forever.
- **Fixed:** unhandled stdin EPIPE from CLI planner children no longer
  crashes the whole daemon/CLI process.
- **Fixed:** the driver loop body is now wrapped so any unexpected throw
  still produces a persisted `uncertain` report with whatever evidence was
  captured, instead of losing the run entirely.
- **Fixed:** the panel's interaction-consent checkbox no longer silently
  re-arms itself on unrelated tab events after a user has explicitly
  unchecked it.
- **Added:** a Chrome binary path override (env + config), and a clear
  fail-fast error when a Chrome profile directory is already locked by a
  live process, instead of a silent 15s hang.
- **Fixed:** CLI planner children are now killed by process group on
  timeout, instead of leaving the real child process orphaned.
- **Changed:** `main` brought up to parity with this development line
  locally (not pushed as part of this wave).

### Fix — close the 5 integration gaps (built-but-unwired modules)

Five modules shipped in feature wave 4 passed their unit tests but were
called by nothing at runtime — found by grepping each symbol outside its own
module.

- **Fixed:** coverage write-back — `spike coverage` had always reported zero
  exercised routes/elements because nothing called the functions that record
  a touch. Runs now attribute touches to the route they happened on and
  write back on every verdict, including failing runs.
- **Added:** an opt-in differential oracle (`SPIKE_DIFFERENTIAL`) — the
  first run of a flow writes a baseline; later runs diff accessibility-tree
  and network shape into the report as evidence (never a verdict on their
  own), plus a new `spike bless` command to accept a stored diff.
- **Added:** `--retries` threaded into both replay paths for real flake
  control.

### Feature wave 5 — discovery CLI, benchmark harness, docs

- **Added:** `spike map <url>` — crawl + static-route extraction into a
  local app-model ledger, with `--diff` to print new/changed/removed
  surface since the last crawl.
- **Added:** `spike coverage` — routes and interactive elements exercised
  versus discovered, including the list of routes nothing has ever touched.
- **Added:** `npm run bench` — a benchmark harness measuring AI-pass
  wall-clock split (model vs. non-model time), per-role model-call counts,
  replay median/speedup versus a fresh AI pass, and flake rate over N
  replays.

### Feature wave 4 — autonomy layer, parallel isolation, locators, CI

- **Added:** the discovery module — static-route extraction plus a
  deterministic BFS crawl, writing a local app-model ledger with a
  structural signature designed to avoid false "changed" positives on
  ordinary list-count churn.
- **Added:** a differential-diff helper prioritizing where an AI pass is
  actually needed, so determinism can be replayed everywhere else.
- **Added:** structural (accessibility-tree) diff, network-shape diff,
  masking, baselines, and environment-vs-environment comparison as a
  first-class case that needs no prior "blessed" baseline. Metamorphic
  relations with an explicit reliable/speculative split.
- **Added:** a Playwright-backed browser port (`--via playwright`) giving
  each parallel worker an isolated browser context on one shared Chrome, for
  cheaper parallel suite runs. Fixed two related concurrency hazards found
  while building it: the Nano runner's shared HTTP server is now a
  refcounted per-port singleton, and concurrent Chrome-launch calls on a
  cold port now dedupe instead of racing.
- **Added:** storage-state capture/injection (`replay --all
  --auth-fixture`), network route rules (block / fail-with-status), and
  viewport/network-throttle emulation.
- **Added:** `--headless`, with Gemini Nano correctly split onto its own
  headed Chrome profile when the main browser session runs headless.
- **Added:** the first version of `.github/workflows/ci.yml` — a
  push/PR-gated fast-suite job.

### Feature wave 3 — Playwright port, assertions, suite runner, heal gating

- **Added:** six precise assertion verbs (`assert_text`
  exact/contains/regex, `assert_count`, `assert_url`, `assert_state`,
  `assert_network`, `assert_no_console_errors`) with a pure evaluator,
  alongside the existing `assert_dom`.
- **Added:** a real suite runner (`spike.suite.json`) with deterministic
  ordering, `--workers` parallelism over an injected run function,
  `--tag`/`--filter`/`--shard`, and JUnit XML output.
- **Added:** risk-tiered self-healing for recorded scripts — pure locator
  drift auto-accepts; a removed step or a weakened assertion instead
  quarantines the change, leaves the original script active, and reports
  `uncertain` rather than silently accepting an unreviewed heal.
- **Added:** retries, a `flaky` marker, and a quarantine list, wired so
  quarantined flows still run and report but can't redden the suite.

### Feature wave 2 — auto-waiting, cache verification, backoff, loud fallback

- **Added:** condition-based actionability/idle waiting on the browser
  port, replacing roughly a dozen fixed `sleep`s in the CDP transport;
  replay now gates actions on actionability instead of a timer.
- **Changed:** action-effect verification now requires intent-specific
  proof (a targeted DOM change, URL change, target disappearance, or a live
  region change) — a bare page-signature diff no longer counts as
  confirmation that a click did anything. The action cache defaults to on.
- **Fixed:** a macOS-specific typing bug — the CDP typing path used
  Ctrl+A to select-all before typing into a field, which is
  select-all on Windows/Linux but move-to-line-start on macOS; any
  non-empty field got silently appended-to instead of overwritten, then the
  per-character fallback double-typed the result. Selection is now handled
  correctly per-platform.
- **Added:** retry-with-backoff before falling to the next model-router rung
  (429/5xx/connection errors only, capped attempts and total wait, honoring
  `Retry-After`); 401s and schema errors still fail fast without retrying.
- **Added:** near-miss reporting in the locator matcher (with stemming, so
  variants like "log in"/"login"/"logs in" unify), and the previously-silent
  matched-replay-failed-so-fell-back-to-a-fresh-AI-run path is now visible
  on the report as `replayFallback`.

### Feature wave 1 — unblock the deterministic pillar, add the Tier-0 oracle

- **Fixed:** the two primary e2e gates had been failing silently — a
  read-only safety default meant every simulated type/click against the
  fixture app was a no-op, so neither gate could ever reach its assertions.
  Both suites now explicitly opt out of read-only mode against the fixture
  they start themselves.
- **Added:** schema validation for recorded QA scripts, so a hand-authored
  or drifted script fails fast at load time instead of misbehaving at
  replay time.
- **Changed:** the step budget for a run went from 12 to 40 (with the
  per-goal budget still capped at 12 within that), fixing an independent
  hardcoded 12 that had also leaked into the lite (extension-only) path.
- **Added:** a Tier-0 invariant oracle (7 rules, including "rendered
  `undefined`/`NaN` on the page") evaluated via a narrow, non-model-supplied
  browser-port probe — non-fatal by default until a green baseline exists
  for a given flow.
- **Added:** network client-error tracking (4xx) kept separate from the
  network failures that already drove batch-abort, surfaced to both the
  report and the planner prompt.
