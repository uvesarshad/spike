# Project TODO / Tracking

> Status legend: `[x]` done · `[ ]` not started · `[~]` partial/in progress
> Source of truth for scope: [`spike-agent-product-doc.md`](spike-agent-product-doc.md) §6.
> Last updated: 2026-08-27 (v0.2 — feature waves 1–5 + market-readiness hardening waves 1–5 landed).

---

## Current state (v0.2)

The MVP (Phase 0–3.5 below) shipped 2026-06-07 and has since had two further
rounds of work layered on top of it, both on the `v0.2` branch:

**Feature waves 1–5** (`19d7f13` → `1663ce1`, plus the integration-gap sweep
`51eef1f`): unblocked the deterministic pillar and added the Tier-0 oracle;
auto-waiting, cache verification, backoff, and a loud fallback path; the
Playwright port, real assertions, a suite runner, and heal gating; an
autonomy layer (`spike map` / `spike coverage`, parallel session isolation,
resilient locators) plus a CI gate; a discovery CLI, a benchmark harness, and
docs — then a sweep that wired 5 modules that existed in `src/` but were
never called from anywhere real.

**Market-readiness hardening, waves 1–4** (`649ec0e` → `cd71580`, from an
audit numbered A1–A58 — see `docs/plan/26-08-27-audit-market-readiness.md`
and its paired task list):

- **Wave 1** — P0 engine reliability: deterministic oracles now gate the
  verdict (`strictOracles`), the navigator-only degrade path no longer
  silently caps out early, batch/node-map races and missing timeout classes
  are closed, stdin EPIPE is handled, a run can no longer crash without
  writing a report, Chrome-path override + profile-lock detection added.
- **Wave 2** — P0 legal/docs + P1 hardening: `PRIVACY.md` and store-kit
  placeholders filled in, `SECURITY.md` added, a third-party site redacted
  from the docs, broken doc links fixed, auto-fix given a one-time consent
  gate + input sanitization, untrusted-content framing added to
  navigator/brain prompts, `trustTargetHost` disclosed.
- **Wave 3** — P1 driver hardening + extension reliability: the live loop
  routes through auto-waiting, the action cache verifies before executing
  and no longer guesses on role/name collisions, MV3 service-worker
  eviction and debugger-detach are handled gracefully, `Retry-After` is
  honored across BYOK adapters, goal-driven work is bounded, the repeat
  detector no longer false-positives on real progress, session leaks on
  throw are closed.
- **Wave 4** — CI/release plumbing + community files + P2 cleanup: the fast
  test bucket is genuinely Chrome-free, CI runs a 3-OS matrix, the phantom
  browser-suite CI job (which could only ever fail) was removed in favor of
  documenting `npm run test:browser` as a local pre-release gate, a
  tag-triggered publish workflow was added, `CONTRIBUTING.md` /
  `CODE_OF_CONDUCT.md` landed, the `allowedHosts` subdomain-trust default
  was tightened, CLI exit codes became a real 0/1/2/3 contract, and several
  smaller P2 findings were closed.
- **This session** (docs-only wave): README quickstart made POSIX-first with
  a collapsed PowerShell block, the `npm audit` posture documented (README +
  an `audit-note` comment in `src/mcp-server.ts`), the private product name
  used as a dogfood-target example redacted to "a real production app",
  this file rewritten to reflect the above, README given a genuine $0
  quickstart story + a real command table + a Requirements block, and the
  macOS/Linux vault-key asymmetry documented in README + `PRIVACY.md`.

Full finding-by-finding detail (severity-tagged, with file:line evidence)
lives in `docs/plan/26-08-27-audit-market-readiness.md`; the matching task
list (what's done, what's left, in execution order) is
`docs/plan/26-08-27-tasks-market-readiness.md`.

## Open items (genuinely open, as of 2026-08-27)

**⛔ Owner-only** — real-world actions no agent can do autonomously:

- [ ] Push the `v0.2`/`main` branches to GitHub and get the first genuinely
      green CI run (`.github/workflows/ci.yml` has never executed against a
      remote).
- [ ] Submit the extension to the Chrome Web Store (trusted-tester first) to
      test `debugger` + `<all_urls>` approvability.
- [ ] Decide the fate of the internal strategy docs (product doc, demand
      research, raw internal audits) — keep public, move private, or trim.
- [ ] Verify `spike-agent` is free on npm; weigh "Spike" Web-Store
      discoverability before first publish.
- [ ] Pick the launch version number (both `package.json` and
      `extension/manifest.json` — Web Store versions can only increase).
- [ ] Record the README demo GIF and publish the token-cost benchmark table
      (needs a live run against real Chrome + real keys).

**Still open — code/docs work:**

- [ ] Mark Nano-as-navigator "Experimental" in the extension panel and in
      README's settings/navigator section (it works, but has known rough
      edges — guessed URLs, repeated failing navigation — see `CLAUDE.md`).
- [ ] Long-run hygiene: expire stale entries in the network `pending` map,
      subscribe `Inspector.targetCrashed` and abort with a clear message,
      drain console/network buffers on a timer during long LLM waits (not
      only per executed action).
- [ ] Slim the published npm package: drop sourcemaps from the publish
      build, make `playwright-core` an optional/lazily-imported dependency
      (it only backs `--via playwright`).
- [ ] Verify extension icon provenance against `scripts/gen-icons.ts`
      output.
- [ ] **OS-keychain vault backends** (`KeychainKeyProvider` for macOS,
      `LibsecretKeyProvider` for Linux) — closes the vault-key asymmetry
      documented this session in README/`PRIVACY.md`; not started as of this
      writing (only `src/vault/dpapi-key-provider.ts` exists today).
- [ ] Wire the existing-but-unused email/OTP module (`src/email/`) into the
      driver as a `wait_for_email` action.
- [ ] Confirm `strictOracles` (deterministic verdicts) is discoverable in
      `spike config`, the panel Settings, and called out in README as a
      headline feature, not just implemented.
- [ ] Surface `spike map`/`spike coverage` output in the extension side
      panel (currently CLI-only; GUI/vibe-mode users can't see it).
- [ ] An `activeTab`-narrowed fallback extension build/manifest, so a Web
      Store rejection over `<all_urls>` has a same-day fallback answer.
- [ ] Unbranded-Chromium support behind the branded-Chrome candidate list
      (with a clear "Nano needs Google Chrome" message when Chromium is
      detected instead).
- [ ] Feed the `spike map` discovery app-model into the brain's goal-planning
      prompt when one exists for the target host.

---

## Old phase history

<details>
<summary>Phase 0–3.6 — original MVP build log (2026-06-06 to 2026-06-07), before the v0.2 hardening waves above</summary>

## Phase 0 — Spikes (de-risk the two novel bets) ✅ complete

- [x] **Spike A** — Gemini Nano (Prompt API) returns a schema-enforced JSON verdict on a screenshot; discriminates good vs broken UI ($0, ~5.5s warm) — `spikes/cdp-logpoint/spike-a-web.js`
- [x] **Spike B** — CDP logpoints: inject `console.log` at any file:line of a running page with zero source edits; capture live variable values — `spikes/cdp-logpoint/spike.js`
- [x] **Rung-1 proof** — Gemini CLI free quota returns clean JSON verdicts on screenshots (`@path` attach)

## Phase 1 — MVP (dev mode: MCP + CLI) ✅ complete (2026-06-07)

### Infrastructure
- [x] Repo restructure: spikes frozen under `spikes/`, TS scaffold (tsup, strict), `.gitignore`, CLAUDE.md
- [x] Central config (`src/config.ts`): ports 9322/9400/9401, profile placement (22GB Nano gate), env/file/flag resolution
- [x] Chrome process management: launch/attach/reuse detached Chrome with CDP (`src/chrome/launch.ts`)

### Ports (the engine ↔ browser seam)
- [x] `BrowserPort` interface + `CdpBrowser` implementation (navigate, click, type, screenshot, logpoints, drains)
- [x] `ExtensionBrowser` planned at the BrowserPort seam with per-method MV3 mappings (later shipped as the real extension transport)
- [x] `NanoPort` + localhost runner page (warm session priming, storage-gate diagnostics, tab reuse across runs)

### Capture & evidence
- [x] a11y tree extraction: `getFullAXTree` → compact indented text, stable node ids, StaticText dedup, token guard
- [x] Console/network capture via native CDP domains, drained per step (exact step↔evidence correlation)
- [x] CDP logpoints through the port (lines located by content, never hardcoded)

### Model ladder
- [x] `ModelAdapter` interface (everything reduces to `generateJson`) + `ModelRouter` with escalation + `model_trace`
- [x] Rung 0: Nano adapter (visual verdicts only, never plans)
- [x] Rung 1: generic Google CLI adapter (stdin prompt, `@shot.png` + cwd=tempdir, `-e none -o json`, trust env, exit 41/55 hints; binary name from config — Antigravity-ready)
- [x] Rung 2: BYOK Gemini API adapter (`responseSchema`, gated on key)
- [x] Rung 3: Ollama adapter — local privacy floor with `/api/tags` availability probe and `/api/chat` JSON generation; skips cleanly when no daemon is listening

### Driver & reporting
- [x] Action schema (zod + JSON-schema twins): navigate/click/type/assert_dom/assert_visual/wait/finish
- [x] Driver loop: a11y-first, one action per step, retry-once with role+name re-resolution, 3×-repeat guard, step budget → `uncertain`, visual confirmation before accepting `finish: pass`
- [x] `report.json`: slim contract (verdict / failing_step / console_error / evidence_paths / reason) + full steps/model_trace; screenshots to `artifacts/<runId>/`

### Transports
- [x] MCP stdio server with the single `qa_run` tool (`src/mcp-server.ts`)
- [x] CLI: `spike run | mcp | nano --check/--download | fixture --bug on/off | config`

### Verification (all green 2026-06-07)
- [x] `test/m1.browser-port.ts` — 7/7 (port surface incl. logpoint w/ live values via real clicks)
- [x] `test/m2.nano-port.ts` — Nano discriminates good/bad, ~2s warm
- [x] `test/m4.router.ts` — 8/8 (escalation policy + live CLI verdict)
- [x] `test/m5.fixture.ts` — 7/7 (fixture happy/bug paths, scripted)
- [x] `test/e2e.run-fixture.ts` — 6/6 (**the oracle**: healthy→pass in 8 steps; bug-on→fail citing TypeError w/ file:line + 500 + screenshot)
- [x] `test/m6.mcp.ts` — 4/4 (qa_run over stdio against built `dist/`, slim payload)
- [x] Spike regression still passing from `spikes/`

### Docs
- [x] README (about, how it works, stack, workflow, timeline) · architecture explainer (non-expert) · CLAUDE.md · Apache-2.0

### MVP follow-ups (known gaps, not blockers)
- [ ] Dogfood against a real production app — user is preparing; will test on a different app
- [ ] Planner latency: ~12–20s/call on free CLI quota (CLI boot dominates) — consider persistent BYOK planning as default-when-key-present
- [x] React controlled inputs: SETTLED — `Input.insertText` satisfies React 18 (fires beforeinput/input like IME; `test/v18.react-typing.ts` 4/4 against real React + `/react` fixture route). Defense-in-depth added anyway: type() always verifies the live `.value`, falls back to per-char key events, throws precisely — silent typing failures are dead
- [ ] a11y-tree size on real SPAs — measure, tune the truncation window
- [x] Token accounting is REAL now: adapters report exact usage (gemini CLI `-o json` stats / BYOK usageMetadata) → `model_trace[].usage` + `report.tokens {cheapModelTotal, cheapModelCached, callsByRung, verdictPayloadTokens}`. Measured run: caller pays **84 tokens** vs Playwright MCP ~114K → `docs/benchmark.md` (the HN table)
- [x] Phantom click no-ops in headed cdp runs ROOT-CAUSE MITIGATED: Windows occlusion throttling — Chrome now launches with `--disable-backgrounding-occluded-windows` etc. + CdpBrowser brings the tab to front before input (matching ExtensionBrowser); the earlier clip-recorder suspicion was a red herring
- [x] Fixture served HTML without charset → mojibake the visual check correctly FAILED on (the QA agent caught a real bug in its own fixture) — `charset=utf-8` added to both fixtures

---

## Phase 2 — Recorder (AI once → deterministic forever) ✅ complete (2026-06-07)

> A passed run emits a Playwright script; re-runs are deterministic and cost $0 AI tokens. Script breaks (UI changed) → AI re-engages, self-heals, re-emits. Kills vibe-coder pain (a) "fix one thing, break another".

- [x] Recording: passed runs distilled to `generated-tests/<task-slug>.json` with resilient role+name locators (driver records `target` per interaction; nodeIds never persisted) — `src/recorder/script.ts`
- [x] Playwright codegen twin: `.spec.ts` emitted alongside (getByRole locators) as a PORTABLE artifact for the user's CI — we replay the JSON ourselves, no Playwright dependency
- [x] `spike replay <name>` — deterministic re-run over CDP: zero planner calls, Nano-only visuals (skipped w/ warning if unavailable — replays never spend paid tokens), strict on runtime errors/5xx, same report.json shape — `src/recorder/replay.ts`
- [x] Self-heal (`--heal`): failed replay re-engages the full driver on the original task, re-emits the script with `healedFrom` lineage (full re-run, not mid-flow resume — deviation from original sketch, simpler and proven)
- [x] Suite mode: `spike replay --all` — worst verdict drives the exit code
- [x] Fixture `v2` variant (renamed checkout button) to simulate UI drift
- [x] e2e 12/12 (`test/e2e.recorder.ts`): record → $0 replay passes in ~9s (vs ~3min AI run) → bug-on replay fails w/ evidence → v2 drift fails → heal re-emits → healed script replays at $0

### Recorder follow-ups
- [x] Duplicate-target safety: ambiguous role+name now FAILS replay with a precise error instead of silently clicking the first; `nth` accepted in scripts + Playwright codegen (`.nth(n)`). Still open: loop records which match it used so `nth` auto-populates
- [x] Diff-report on heal (`diffScripts`, surfaced in qaReplay heal progress)
- [ ] `data-qa-id` stamping as a second locator strategy for name-less elements

## Phase 3 — Vibe mode (the GUI) ⬜ not started

> One-click Web Store install, chat side panel, watch-the-robot show, paste-ready fix prompt. The viral wedge.

### Extension foundation — ✅ complete (2026-06-07)
- [x] MV3 extension scaffold (`extension/`): service worker with reconnect loop + chrome.alarms keepalive, debugger/tabs/storage/alarms permissions
- [x] **`ExtensionBrowser`**: real implementation — `ext.*` lifecycle via chrome.tabs, everything else via a Proxy **CDP shim** over `chrome.debugger.sendCommand`, so snapshotAxTree/attachCapture/setLogpointByContent run byte-identical to CdpBrowser (`src/ports/extension-browser.ts`, `src/bridge/cdp-shim.ts`)
- [x] Daemon↔extension bridge (`src/bridge/bridge-server.ts`): WS on 9410, JSON-RPC request/response + CDP event forwarding; new SW connection supersedes the old
- [x] Dev-loading post-Chrome-137 solved (`src/chrome/extensions.ts`): `Extensions.loadUnpacked` is **pipe-only** — launch with `--remote-debugging-pipe` (NUL-framed JSON-RPC on fd 3/4) + `--enable-unsafe-extension-debugging`, port stays live for the daemon; Web Store for users
- [x] Port-contract suite (`test/port-contract.ts`): the m1 checks generalized over any BrowserPort — **CdpBrowser 7/7 AND ExtensionBrowser 7/7** (`test/v3.extension-port.ts`), logpoints with live values working through chrome.debugger
- [x] Nano via the extension's own Prompt API (`src/ports/extension-nano.ts` + sw.js `nano.*` bridge methods; SW-first with automatic chrome.offscreen fallback) — v6: good→pass 5.1s / bad→fail 3.0s, $0, schema-enforced (`test/v6.extension-nano.ts`)
- [x] Engine wiring: `spike run|replay --via extension` (config: via/bridgePort/extensionDir + SPIKE_VIA env; engine `openBrowserSession` picks the transport, reuse-if-alive on the CDP port; SW scans bridge ports 9410-9413) — v5 4/4 no-AI + full AI capstone run
- [x] Engine: ExtensionNano in vibe mode (injected bridge → no pointless runner-Chrome spawn); NanoRunnerPage stays for engine-launched Chrome
- [ ] Investigate: chrome.offscreen.createDocument stalls in headless Chrome (observed via nano.avail hang in v9) — SW now guards every nano.* bridge call with a timeout (avail→'unavailable' after 10s) so runs degrade to rung 1 instead of dying; find the real cause for headed-vibe Nano
- [ ] Fresh-Chrome Nano availability: component re-validates (~60s 'downloading') after every Chrome start — engine should poll briefly instead of falling to rung 1 (v6 polls; engine doesn't yet)

### Vibe UX — core ✅ (2026-06-07)
- [x] Side-panel chat (`extension/panel.{html,js,css}`): URL + plain-English task in, live progress feed, verdict card, copy-able fix prompt; SW relays panel⇄daemon over the bridge (reverse RPC `{rid,...}` frames); `spike daemon` hosts the service
- [x] **Ghost cursor overlay** (`extension/overlay.js` + emits in ExtensionBrowser): indigo cursor glides to each click (450ms ease), click ripples, bottom caption pill narrating steps ("Clicking the "Sign in" button"), ✓/✗ ticks — driven by `vibe.cursor` events, pointer-events:none, zero page interference
- [x] **Fix-prompt synthesis** (`src/vibe/fix-prompt.ts`): deterministic Report → paste-ready prompt (repro steps humanized via step targets, console_error verbatim, failed requests w/ status, evidence timestamps, heuristic root cause, "do not change unrelated files" guard); also `spike fix <runId>` for dev mode + `renderPlainReport` for the panel
- [x] Onboarding-lite: panel shows bridge status dot + Nano availability line ("testing still works via cloud free tier")
- [~] **Replay clip export (GIF)**: `src/clip/screencast.ts` works over raw CDP (v14: 27KB gif) and is wired into the engine, but **OPT-IN (`SPIKE_RECORD_CLIP=1`) and cdp-transport only** for now: (a) chrome.debugger does NOT expose Page.startScreencast → extension/vibe mode needs a `chrome.tabCapture`-based recorder (the real product target); (b) one cdp run on the warm daemon Chrome had post-nav clicks no-op with screencast active, unreproducible on fresh profiles (`test/v16.clip-input-interaction.ts` all clean). Engine guards clip start with a 5s timeout. MP4/watermark also open.
- [x] Onboarding full flow: panel "Download on-device AI (~2 GB)" button w/ progress bar (SW + offscreen paths), 22GB-gate explanation on 'unavailable'
- [x] Panel polish: cancel/Stop button (vibe.cancel → AbortSignal through the driver), run history (storage.local, 10 entries), step ticks landed last round
- [~] Vibe clip v2 (tabCapture→MediaRecorder→webm): plumbing SHIPPED (`rec.*` bridge ops, offscreen MediaRecorder, daemon saves `artifacts/<runId>/replay.webm`, `clipPath` in vibe.done, ⚡ watermark badge in-frame) — but tabCapture's invocation gating fails in headless dev-loads (graceful {ok:false}); needs a MANUAL headed verification: real panel run → check replay.webm appears. MP4 + share button later
- [ ] Web Store submission checklist (from pack script): ≥1 screenshot 1280×800, privacy policy URL (debugger + <all_urls> permissions), permission justifications, listing copy. Icons ✓ (extension/icons, gen via scripts/gen-icons.ts), zip ✓ (`npm run pack:extension` → dist/extension.zip, 41.6KB), npm pack dry-run ✓ (private:false, files allowlist)

### Quality gate
- [x] Headless e2e (`test/v9.vibe-flow.ts`): real daemon service + real extension SW; vibe.run accepted (concurrent refused), progress + ghost-cursor events flow, vibe.done carries fail verdict + plain report + paste-ready fix prompt on the bug-on fixture
- [x] Manual panel walkthrough — done by the user 2026-06-07; feedback round (speed/cursor/glow/tab-attach/cards/green) implemented same day
- [ ] Full loop incl. the fix: paste prompt into a coding agent → fix the fixture bug → re-run → green

---

## Phase 3.5 — Auto-fix for CLI users ✅ (2026-06-07)

> GUI vibe-coders paste the fix prompt; CLI users get the loop closed automatically: test → fail → prompt handed to claude/codex/gemini headlessly → re-test.

- [x] `src/vibe/auto-fix.ts`: agent auto-detect (claude→codex→gemini on PATH), stdin/file prompt delivery (Windows .cmd argv quoting solved), 15-min timeout, streamed output
- [x] `spike run --fix [--max-fix-attempts N]` (runWithAutoFix loop) + `spike fix <runId> --apply`
- [x] Panel: "🤖 Auto-fix with my coding agent" button on FAIL (vibe.fix → fix-progress/fix-done events)
- [x] e2e with a REAL coding agent: `test/e2e.autofix-real.ts` (gated on SPIKE_REAL_AGENT_E2E=1 — spends real tokens) + on-disk `test/fixtures/buggy-shop/`. PROVEN: red → real `claude -p` edits checkout.js (adds the missing `total`) → green, ~5.7min wall. Gotchas solved: serve the agent's temp copy, cache-bust scripts, deterministic sync throw

## Phase 3.6 — Pre-launch hardening round (scoped 2026-06-07)

> Items 5–11 from the remaining-work review — ALL SHIPPED 2026-06-07. Dogfood (a real production app) runs in parallel on the user's side.

- [x] **#5 Fast planning when BYOK key present**: plan-step ladder puts rung 2 before rung 1 when a key is live (`preferFreePlanner: true` opts back to free-first); visual verdicts unchanged (Nano first). m4 8/8 held.
- [x] **#6 Recorder `nth` auto-populate**: loop records the acted node's index among role+name duplicates (`rankByRoleName`, document order — same traversal as replay/codegen); flows into scripts automatically. v21.
- [x] **#7 Clip share + MP4 attempt**: offscreen recorder tries `video/mp4` first (unsupported on this Chrome/Win build — measured matrix in code; lands on webm/vp9 here, mp4 where platforms allow), daemon saves the matching extension; panel "⬇ Download clip" button via `vibe.clip` base64 fetch → blob download. v22 9/9.
- [x] **#8 DPAPI vault key backend**: `DpapiKeyProvider` (ProtectedData via PowerShell, base64-only across the shell, no native deps); DEFAULT on win32 for new vaults, legacy key.bin keeps FileKeyProvider (no silent re-key). v23 18/18.
- [x] **#9 `data-qa-id` fallback locator**: both ports stamp name-less targets (`stampQaId`) + resolve them (`findByQaId` → synthetic nodeId); scripts carry qaId; replay falls back on ambiguous/drift/out-of-range; Playwright codegen emits the attribute locator. Best-effort across reloads (stamps die on navigation). v21 13/13.
- [x] **#10 Interaction consent UX**: CLI repeatable `--allow-host` on run/replay (appends to allowedHosts); panel pre-run checkbox "Allow the agent to click & type on this site" (amber third-party note) → `allowHost` through vibe.run.
- [x] **#11 Multi-Chrome bridge multiplexing**: BridgeServer tracks N clients (clientId per socket, origin-checked response routing, per-client pending cleanup); ExtensionBrowser/cdp-shim bind to a clientId; VibeService routes the whole run + all UI events back to the ASKING Chrome. v24 proof: two Chromes on ONE bridge port, tab created via A undrivable via B, A's run untouched by B. v24 9/9; v7/v3/v17 held.

</details>

<details>
<summary>Phase 4 — Later (tracked, not scoped) — pre-v0.2 list, superseded by "Open items" above</summary>

- [x] Tier-4 guardrail core (2026-06-07): AES-256-GCM vault (`spike secret`, `{{secret:NAME}}` resolved at execute-time only — placeholders everywhere else: prompts/reports/scripts/audit), read-only-by-default outside allowedHosts, per-action audit.log. Still open: confirm-on-mutation UX, OS-keychain key backend, secret redaction in screenshots/clips
- [x] Ollama adapter (rung 3) implemented — untested against a live Ollama (none on this machine)
- [ ] "Throw anything at it" goal mode (WordPress/Stripe/DNS troubleshooting)
- [ ] Launch: OSS polish, token-cost benchmark table (vs Playwright MCP / Claude in Chrome), Show HN + split-screen demo video
- [ ] 2026-06-18: Gemini CLI → Antigravity CLI transition — flip `googleCliBin` config, verify `-p`/`--output-format` parity

</details>
