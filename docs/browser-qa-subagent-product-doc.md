# Browser QA/Debug Subagent — Founding Document

**Date:** 2026-06-06 · **Status:** Validated idea, pre-spike · **Working title:** TBD

> **One-liner:** Opus writes the code. A $0 model tests it. Your context stays clean.
>
> **For vibe coders:** Watch a robot test your app in your browser — then get the exact prompt that fixes what's broken.

---

## 1. The Problem

### For developers using coding agents (Claude Code, Cursor, Copilot, Codex CLI)

- Coding agents are blind. They write UI code, claim "fixed!", and can't verify it. The human becomes the QA department for the AI.
- The existing fix — browser tools driven by the main model — is ruinously expensive:
  - **Playwright MCP burns ~114K tokens per 10-step test**; a single screenshot costs 10,000+ tokens; the 26-tool schema eats ~13.7K tokens before the agent clicks anything.
  - Opus-class models cost an order of magnitude more than Flash-class models, yet they're the ones reading hundreds of screenshots to click a login button.
  - A whole article genre exists about this ("The Context Wars: Why Your Browser Tools Are Bleeding Tokens").
- Claude in Chrome (Anthropic's own answer) is beta quality, and its **#1 user complaint is a model-cost complaint** (Pro users locked to Haiku).
- Google Antigravity solved this natively (free browser sub-agent) — but it's locked to one IDE, one vendor, a private protocol.

### For vibe coders (Lovable, Bolt, v0, Replit Agent — non-technical builders)

Grok deep-search across r/lovable, r/replit, r/nocode, r/Bolt + X (2025–2026) found four loud, costly pains (full findings: `grok-findings-about-auto-testing-tool.md`):

| Pain | Evidence |
|---|---|
| **(a) Fix one thing, break another** ("whack-a-mole") | #1 cited issue. "Fix login → three unrelated files change; revert → mobile breaks" — 92-message death spirals. Users built SpecLock (file-lock constraint engine) just to cope. |
| **(b) Can't tell if the AI actually fixed it** | "Debugging decay" — AI confidently claims success while broken; users' only verification is manual clicking. |
| **(c) Don't know how to test** | No systematic testing skills; treat git commits like RPG save points out of fear. |
| **(d) Don't know what prompt to write to get a fix** | Users manually run a **"three-AI pipeline"**: external model diagnoses → crafts the precise prompt → paste into Lovable/Cursor. Common, tedious, unreliable. |

- Documented credit burns: **$400–700+ on failed fix loops.**
- **Critical PMF signal:** the target users *already perform our product manually* (the three-AI pipeline). We automate an existing ritual.

---

## 2. The Research Findings (what we verified)

1. **Token pain is loud and quantified.** Playwright MCP ~114K tok/test → Playwright CLI ~27K → PinchTab ~800 tok/page. The market is actively rewarding token-efficiency plays (PinchTab: 5.2K GitHub stars in 3 weeks, Feb 2026).
2. **Chrome ships a free multimodal model.** The Prompt API with **Gemini Nano is stable in Chrome 148 with image input + structured output** — on-device, no API key, no billing. Only extensions can touch it (not CDP/Playwright tools). **Nobody in the competitive set uses it.**
3. **Gemini CLI free quota is scriptable.** Personal Google login → **Gemini 3 Flash, 1,500 requests/day, headless mode** (`gemini -p`). Claude Code→Gemini CLI delegation plugins already exist (proven pattern), but none are browser-QA-specific. ⚠️ Google announced quota changes for individual tiers starting **June 18, 2026** and already 3x'd Flash API pricing — free quota is a growth hack, **not** the foundation. Architecture must be model-agnostic.
4. **Antigravity's browser magic is just Chrome + CDP on port 9222** + a private extension protocol (reverse-engineered publicly). Its end-to-end debug loop (read console → instrument code with logs → test → fix → remove logs) is replicable — and improvable (see §4, CDP logpoints).
5. **"Watch the AI click" is a proven viral format.** Multi-agent build demo: 2.7M views. Agent-S: 3K stars in 48h. Paperclip live demo: 343K views. The format works because of visual proof of agency + multi-step real-world tasks + platform-native short video.
6. **Cheap models are good enough.** Gemini Flash-class ran browser tasks at ~$0.002/task; Gemini Computer Use models beat GPT/Claude on browser-task accuracy at 20–30x lower cost.

---

## 3. The Solution

A **Chrome extension + tiny local daemon** that gives any coding agent — and any non-technical builder — an autonomous browser QA/debugging subagent. The expensive model never touches the browser; a cheap-model ladder does the looking and clicking and returns a ~2K-token verdict.

### The model ladder (cost collapses to ~$0 for the common case)

| Rung | Model | Cost | Used for |
|---|---|---|---|
| 0 | **Gemini Nano in-Chrome** (Prompt API, multimodal) | $0, on-device | "is this element visible / does this look right" — most checks |
| 1 | **Gemini CLI free quota** (Flash, 1,500/day, headless) | $0 | multi-step reasoning, flow planning |
| 2 | **BYOK** (Gemini API / OpenRouter / any) | user's key | heavy runs, teams |
| 3 | **Ollama local** | $0, private | privacy floor, offline |

Escalate only on uncertainty. a11y-tree-first extraction (~800 tok/page); vision only for visual assertions.

### The capability ladder (each tier is its own marketing moment)

| Tier | Capability | Detail |
|---|---|---|
| **1. Verify** | QA runs + deterministic replay | **AI explores once → emits a Playwright script → re-runs are deterministic and cost $0 AI tokens.** Script breaks (UI changed) → AI re-engages, self-heals, re-emits. A regression suite that writes and maintains itself — directly kills vibe-coder pain (a). |
| **2. Diagnose** | Console + network + DOM capture, correlated per step | Plus **runtime instrumentation via CDP logpoints**: inject console.logs at any file:line *without touching source* (`Debugger.setBreakpointByUrl` w/ log expression; `Page.addScriptToEvaluateOnNewDocument` patches fetch/onerror on any site). Strictly better than Antigravity's edit-code-then-remove loop: no dirty diffs, no cleanup, works on sites you don't own. Dev mode adds a second channel: the QA agent can *request* the coding agent to instrument source and re-run. |
| **3. Prescribe** | Output tailored per audience | **Dev mode:** structured JSON verdict (`{verdict, failing_step, console_error, evidence_paths}`) over **both MCP and CLI** transports (~2K tokens). **Vibe mode:** plain-English report + a **ready-to-paste fix prompt** for Lovable/Cursor/Bolt — automating the "three-AI pipeline" users already do by hand. Kills pains (b)(c)(d). |
| **4. Troubleshoot** | "Throw anything at it" | Goal-driven debugging of ANY site you can log into — WordPress/WooCommerce settings, Stripe dashboards, DNS panels (validated by the Antigravity-fixes-WordPress experience: no code involved, pure config troubleshooting). Massive TAM expansion beyond builders. |

### Tier-4 guardrails (non-negotiable — one "AI deleted my products" thread kills the product)

- **Local credential vault:** encrypted on-device; typed via CDP `Input.insertText`; **the model never sees credentials**; auto-redacted from logs, screenshots, and shareable clips.
- **Read-only by default** on third-party sites; mutations require explicit confirm or pre-approved allowlist.
- **Domain scoping** per task + complete action audit log.
- Trust as differentiator: *"your passwords never leave your machine"* — no cloud browser-agent can claim this.

---

## 4. The Viral Twist

**The spectacle is free.** Token efficiency and showmanship don't conflict: the compressed a11y-tree goes to the model; the live theater goes to the human at zero token cost. Same run, two audiences.

- **Ghost cursor mode** — animated cursor trails, click ripples, plain-English caption bar narrating each step ("Logging in… ✓ Trying checkout… ✗ found it"), green/red step ticks, pass celebration. Satisfying to watch ≈ satisfying to share.
- **Auto-generated replay clip** — every run ends with a ready-to-post MP4/GIF (cursor trails + captions + verdict card, subtle watermark, secrets auto-redacted). One-tap share. **Every user demo is our ad** (the Loom loop).
- **Launch video writes itself:** split screen — Lovable building an app | our ghost cursor testing it, catching the broken checkout, producing the fix prompt → paste → re-run → all green. 45 seconds, zero jargon.
- Grok's verdict on the format: "almost perfectly aligned" with what's currently pulling millions of views in builder circles.

### Two skins, one engine

| | Dev mode | Vibe mode |
|---|---|---|
| Interface | MCP tool + CLI (`qa_run`) | Extension side panel, plain English |
| Input | `qa_run(task, url)` from Claude Code/Cursor | "test my signup flow" |
| Output | ~2K-token JSON verdict + artifact paths | Live ghost-cursor show + fix prompt to paste |
| Role | retention + revenue | viral wedge (unserved, loudest sharers) |

---

## 5. Competitive Landscape (2026-06)

| Player | What it is | Why we win |
|---|---|---|
| **web-eval-agent** (Operative/Refresh) | MCP browser sub-agent w/ condensed report — closest (~80% of Tier 1–2) | Hosted API-key lock-in, their model only, no script-gen, no free/local rungs, `uv` install friction, dev-only |
| **PinchTab** | Token-compressed browser control (800 tok/page), 5.2K★/3wks | Compression only — the *expensive model still drives*. No delegation, no QA loop, no vibe face |
| **Vercel agent-browser / MS Playwright CLI** | Token-efficient CLI browser tools | Same — efficient hands, no cheap brain; no extension (no real sessions, no Nano) |
| **Browser MCP / mcp-chrome** | Extension↔agent bridge, real profile (6.5K★) | No sub-agent, no model ladder, main model does all looking |
| **Claude in Chrome** | Anthropic native | Beta, subscription-locked, Haiku-on-Pro complaint = our pitch |
| **Antigravity** | Free native browser sub-agent + e2e debug loop | One IDE, one vendor, private protocol; we're agent-agnostic + extension-powered (Nano, real sessions) |
| **SpecLock / multi-agent reviewers** | Vibe-coder coping tools | Constraint/review only — nobody combines live visual testing + fix-prompt synthesis (Grok-confirmed gap) |

**The unowned combo:** real-browser extension (sessions, fingerprint, Nano) + cheap-model autonomous loop + BYOK/local + agent-agnostic MCP/CLI + AI-once→deterministic-forever scripts + fix-prompt output for non-coders.

**Window:** measured in GitHub-trending cycles. PinchTab went 0→5K stars in 3 weeks on a weaker story. Microsoft, Vercel, Google, Anthropic are all converging. Ship in weeks, not months.

---

## 6. What We're Building

### MVP (Tier 1 + 2, dev mode first)

```
┌─ Coding agent (Opus/any) ── one tool: qa_run(task, url) ──┐
│  pays ~2K tokens per test                                 │
├─ Local daemon (single binary; MCP + CLI transports)       │
│   ├─ driver loop: a11y-tree first, vision on demand       │
│   ├─ model router: Nano → Gemini CLI → BYOK → Ollama      │
│   └─ recorder: emits Playwright script per passed run     │
├─ Chrome extension (MV3)                                   │
│   ├─ chrome.debugger → CDP (click/type/navigate/logpoints)│
│   ├─ Prompt API → Gemini Nano vision ($0 assertions)      │
│   ├─ console/network/error capture, step-correlated       │
│   └─ ghost-cursor overlay + narration + clip recorder     │
└─ Artifacts to disk: report.json, screenshots/, trace,     │
    generated-tests/*.spec.ts                               │
```

### Build order

1. **Spike (de-risk the two novel bets):** (a) extension runs Gemini Nano multimodal prompt against a screenshot → structured verdict; (b) set a CDP logpoint on a running page with zero source edits. Both pass → every differentiator is feasible.
2. **MVP:** `qa_run` MCP tool + driver loop + console/network capture + report.json. Dogfood target: MontrAI social module (§E runtime QA — exactly the tedious clicking this kills).
3. **Recorder:** passed-run → Playwright script; replay command; self-heal on breakage.
4. **Vibe mode:** side panel + plain-English input + ghost cursor + fix-prompt synthesis + replay clip export.
5. **Tier 4:** credential vault + guardrails + "throw it at it" goal mode.
6. **Launch:** OSS core + BYOK day one; HN "Show HN" + X with token-cost benchmark table (vs Playwright MCP / Claude in Chrome) + the split-screen Lovable video; hosted tier later.

### Positioning

- Lead with the wedge: **"the debugging copilot that actually looks."**
- Dev hook: *"Opus codes. A $0 model tests. 114K tokens → 2K."*
- Vibe hook: *"Watch a robot test your app — get the prompt that fixes it."*
- Tier 4 is the expansion testimonial ("it fixed my WooCommerce shipping while I watched"), not the lead — avoid the general-browser-agent bloodbath.

---

## 6.5 Spike Results (2026-06-06, this machine — Chrome 148.0.7778.217 stable)

Spike code: `E:\Projects\browser-qa-spike\` (extension/ + cdp-logpoint/).

### Spike B — CDP logpoint instrumentation: ✅ PASS (first run)

- `Debugger.setBreakpointByUrl` with `condition: "console.log(...), false"` injected a log at `app.js:13` of a running page and captured **live variable values** (`total=74.99`, full cart JSON) — **zero source edits**.
- `Page.addScriptToEvaluateOnNewDocument` fetch-shim captured network calls (`[NET] /api/ping 200 5ms`) — works on any site, no source access.
- Conclusion: the better-than-Antigravity diagnose loop (Tier 2) is fully feasible. Run: `cd cdp-logpoint && npm run spike`.

### Spike A — Gemini Nano structured verdict: learnings so far

- **`--load-extension` is dead in branded Chrome 137+.** Dev-loading now goes through CDP `Extensions.loadUnpacked` (how Playwright does it) or manual chrome://extensions. Web Store install unaffected — product unaffected, dev workflow noted.
- **The Prompt API is web-exposed in Chrome 148 stable on secure contexts** (`LanguageModel` is a function on https/localhost pages; NOT on about:blank — opaque origin). Means: the product could even offer a no-extension "paste a snippet" mode; and our spike runs Nano from a localhost page, no extension needed.
- **`availability() === 'unavailable'` is usually the storage gate**: Nano needs **22 GB free on the volume holding the Chrome profile** (hit this on E: with 7.2 GB free; moved profile to C: → `downloadable`). Product must surface this clearly in onboarding.
- Model download triggered; verdict discrimination test (good vs broken dashboard) pending download completion.
- **✅ FINAL RESULT (2026-06-07): PASS.** After download (~2GB; interrupted once at 49% by tab navigation — restart re-attaches): `good.html` → `{"verdict":"pass"}`, `bad.html` → `{"verdict":"fail"}` quoting the error banner verbatim; JSON schema enforced via `responseConstraint`. Latency: 16.7s cold (model load) / **5.5s warm** → product keeps a warm session. **$0.00, fully on-device.**
- Operational notes: keep the runner tab untouched during download (page navigation kills the create() promise; component download survives, harness re-attaches). Throwaway profile lives at `%LOCALAPPDATA%\qa-spike-chrome-profile` (~2GB+, reusable; delete to reclaim).

### Rung 1 — Gemini CLI free-quota verdict: ✅ PASS (perfect discrimination)

- `gemini -p "@shots/good.png …json schema…" -m gemini-3-flash-preview` → `{"verdict":"pass"}` with accurate summary; `bad.png` → `{"verdict":"fail"}` quoting the error banner verbatim + "no navigation" + "blank content area". Clean JSON both times, free quota, image attach via `@path`.
- Machine gotcha: Gemini CLI OAuth fails behind AVG TLS interception — needs `NODE_OPTIONS=--use-system-ca` (exit code 41 otherwise).
- **Gemini CLI → Antigravity CLI transition (June 18, 2026, confirmed):** free/Google One tiers move to Antigravity CLI; it keeps headless `-p/--print` AND adds `--output-format` structured output (better than text parsing). Field reports of aggressive free-tier 429s under the multi-agent system → reinforces ladder design. Rung 1 = generic "Google CLI adapter" (gemini today, antigravity after June 18).

## 7. Risks

| Risk | Mitigation |
|---|---|
| Field velocity — whoever ships this combo first wins in weeks | Moat = distribution + UX, not tech. OSS + viral clips + ship fast |
| Incumbents converge (Anthropic cheap-model checkbox; Antigravity goes open) | Agent-agnostic + extension-only powers (Nano, real sessions) stay defensible |
| Free quotas are quicksand (June 18 2026 Gemini CLI change; Flash 3x repricing) | Model-agnostic router; free rungs are defaults, BYOK/Ollama the floor |
| Cheap-model misclicks / flakiness | The product IS the harness: retries, a11y-first, escalation ladder, structured assertions |
| Tier-4 destructive action disaster | Vault + read-only default + confirm-on-mutation + audit log (see §3) |
| Fix-prompt quality must be excellent or users still loop (Grok caveat) | Include repro steps, evidence timestamps, hypothesized root cause; eval-test the prompt outputs themselves |

---

## 8. Source Index

- Grok demand validation: `temp/grok-findings-about-auto-testing-tool.md`
- Antigravity CDP teardown: alokbishoyi.com "Reverse Engineering Antigravity's Browser Automation" (Chrome on :9222, extension HTTP 3025–3035)
- Token economics: scrolltest.medium.com (114K/test), paddo.dev "Context Wars", betterstack.com (CLI vs MCP), pinchtab.com
- Chrome Prompt API / Gemini Nano: developer.chrome.com/docs/ai/prompt-api + /blog/chrome-at-io26 (Chrome 148 multimodal stable)
- Gemini CLI quotas: geminicli.com/docs/resources/quota-and-pricing (1,500 RPD Flash; June 18 2026 change)
- Closest competitor: github.com/Operative-Sh/web-eval-agent (+ Show HN: news.ycombinator.com/item?id=43822659)
- Vibe-coder pain: justtalkingtech.medium.com "Vibe Coding in 2026" (~1,000-comment Reddit analysis)
- Viral format precedents: Agent-S (3K★/48h), 7-agents demo (2.7M views), Paperclip (343K views)
