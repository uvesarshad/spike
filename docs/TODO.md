# Project TODO / Tracking

> Status legend: `[x]` done · `[ ]` not started · `[~]` partial/in progress
> Source of truth for scope: [`browser-qa-subagent-product-doc.md`](browser-qa-subagent-product-doc.md) §6.
> Last updated: 2026-06-07 (MVP shipped).

---

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
- [x] `ExtensionBrowser` stub with per-method MV3 mappings (keeps vibe mode honest)
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
- [ ] Rung 3: Ollama adapter — **interface stub only** (`available() → false`); implement when privacy floor is needed

### Driver & reporting
- [x] Action schema (zod + JSON-schema twins): navigate/click/type/assert_dom/assert_visual/wait/finish
- [x] Driver loop: a11y-first, one action per step, retry-once with role+name re-resolution, 3×-repeat guard, step budget → `uncertain`, visual confirmation before accepting `finish: pass`
- [x] `report.json`: slim contract (verdict / failing_step / console_error / evidence_paths / reason) + full steps/model_trace; screenshots to `artifacts/<runId>/`

### Transports
- [x] MCP stdio server with the single `qa_run` tool (`src/mcp-server.ts`)
- [x] CLI: `qa run | mcp | nano --check/--download | fixture --bug on/off | config`

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
- [ ] Dogfood against a real app (MontrAI social module) — first non-fixture target
- [ ] Planner latency: ~15–20s/step on free CLI quota (CLI boot dominates) — consider persistent BYOK planning as default-when-key-present
- [ ] `Input.insertText` vs React controlled inputs — add key-event fallback when a real app needs it
- [ ] a11y-tree size on real SPAs — measure, tune the truncation window
- [ ] `tokenEstimate` in report is rough — measure real prompt+verdict token spend per run

---

## Phase 2 — Recorder (AI once → deterministic forever) ⬜ not started

> A passed run emits a Playwright script; re-runs are deterministic and cost $0 AI tokens. Script breaks (UI changed) → AI re-engages, self-heals, re-emits. Kills vibe-coder pain (a) "fix one thing, break another".

- [ ] Step→Playwright codegen: map the passed run's StepRecords (click/type/navigate + assertions) to a `.spec.ts` with resilient selectors (role+name first, `data-qa-id` fallback)
- [ ] Persist generated scripts to `generated-tests/<task-slug>.spec.ts` + metadata (source runId, URL, date)
- [ ] `qa replay <script|task>` — run without any model; report in the same report.json shape
- [ ] Self-heal: on replay failure, re-engage the driver loop from the failing step, re-emit the script, diff-report what changed
- [ ] Suite mode: `qa replay --all` as the regression suite; nonzero exit on any fail
- [ ] e2e: record on healthy fixture → replay passes at $0; break the fixture UI (rename a button) → self-heal re-emits

## Phase 3 — Vibe mode (the GUI) ⬜ not started

> One-click Web Store install, chat side panel, watch-the-robot show, paste-ready fix prompt. The viral wedge.

### Extension foundation
- [ ] MV3 extension scaffold (grow from `spikes/extension/`): side panel, service worker, `chrome.debugger` permission flow
- [ ] **`ExtensionBrowser`**: implement the existing `BrowserPort` stub via `chrome.debugger.sendCommand` (same CDP domains as `CdpBrowser`)
- [ ] Daemon↔extension bridge (local WebSocket): qa_run requests in, step events out
- [ ] Nano via the extension's own Prompt API access (replaces the localhost runner page in this mode)
- [ ] Dev-loading story post-Chrome-137 (`Extensions.loadUnpacked` over CDP for development; Web Store for users)

### Vibe UX
- [ ] Side-panel chat: plain-English task in ("test my signup flow"), live step feed, plain-English report out
- [ ] **Ghost cursor overlay**: animated cursor trails, click ripples, caption bar narrating each step, green/red step ticks
- [ ] **Fix-prompt synthesis**: verdict + evidence → a ready-to-paste prompt for Lovable/Cursor/Bolt (repro steps, evidence timestamps, hypothesized root cause) — automate the "three-AI pipeline"
- [ ] **Replay clip export**: run → MP4/GIF (cursor trails + captions + verdict card, watermark, secrets auto-redacted)
- [ ] Onboarding: Nano availability + 22GB storage gate surfaced in plain English; works-without-Nano fallback messaging

### Quality gate
- [ ] e2e: full vibe flow against the fixture — type task in panel → watch run → fail report + fix prompt → paste prompt → re-run → green

---

## Phase 4 — Later (tracked, not scoped)

- [ ] Tier-4 guardrails: local credential vault (typed via CDP `Input.insertText`, model never sees secrets), read-only-by-default on third-party sites, confirm-on-mutation, domain scoping, audit log
- [ ] "Throw anything at it" goal mode (WordPress/Stripe/DNS troubleshooting)
- [ ] Launch: OSS polish, token-cost benchmark table (vs Playwright MCP / Claude in Chrome), Show HN + split-screen Lovable demo video
- [ ] 2026-06-18: Gemini CLI → Antigravity CLI transition — flip `googleCliBin` config, verify `-p`/`--output-format` parity
