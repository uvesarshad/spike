# Audit — Non-Technical Onboarding plan

> Subject: [2026-07-13-non-tech-onboarding.md](./2026-07-13-non-tech-onboarding.md)
> Date: 2026-07-14
> Verdict: **Sound direction, but two P0 at-risk assumptions and several missing guardrails.** The plan correctly identifies BYOK-not-claude-CLI as the non-tech default and correctly describes what already exists, but it silently assumes distribution preconditions that may not hold, under-rates the `chrome.debugger` risk that threatens the whole Web Store strategy, and has no findings for cost/safety — the exact things the target audience is least equipped to handle.

Evidence was checked against the code, not just re-read from the plan. Findings ordered by severity.

---

## P0 — broken / at-risk

### A1 (P0) — The daemon one-liner's distribution preconditions are unverified and silently assumed
The whole "Click 2" path depends on two things being live that the plan never confirms:
- **npm package `browser-qa-subagent` is published** — `install.ps1:42` / `install.sh:43` run `npm i -g browser-qa-subagent`, and `sw.js:398` / lite copy reference it. If it isn't published (or is private), every daemon install 404s at npm.
- **`github.com/uvesarshad/browser-qa-subagent` is public with `install/` on `main`** — the panel's `INSTALL_BASE` (`panel.js:140`) points at `raw.githubusercontent.com/uvesarshad/browser-qa-subagent/main/install`. If that repo is private/renamed/empty, `irm … | iex` fetches a 404 and the copy-paste silently fails for the user.

**Action:** Before shipping any onboarding, verify (a) the npm package is published under that exact name, and (b) the GitHub repo is public and serves `install/install.ps1` + `install.sh` at `main`. Add both as explicit preconditions in the plan's "Definition of done."

### A2 (P0) — `chrome.debugger` may block the Web Store listing outright, and the CDP infobar is a non-tech UX killer the plan ignores
The plan calls `debugger` "heavy scrutiny" (Gap A1). It's worse than that on two fronts:
- **Approval risk:** `permissions: ["debugger", …]` + `host_permissions: ["<all_urls>"]` (`manifest.json:13-14`) is one of the hardest permission combos to get through Chrome Web Store review for a general-audience extension. This is a *listing-may-be-rejected* risk, not a *fill-in-a-justification* risk — it can invalidate the entire chosen distribution strategy.
- **Runtime UX:** every tab the extension drives via `chrome.debugger` shows Chrome's persistent yellow **"Browser QA Subagent started debugging this browser"** infobar. There is no way to suppress it in a Store build. For a non-technical vibe-coder this reads as "something is wrong / I'm being spied on." The plan's onboarding flow never mentions it.

**Action:** (1) Treat Store approval of the `debugger` extension as a hypothesis to de-risk *first* (draft the permission justifications and, if possible, a pre-review inquiry) before investing in store assets. (2) Add the infobar to onboarding copy so it's expected, not alarming. (3) Note a fallback: if `debugger` is rejected, the Lite/BYOK value prop still needs a non-`debugger` transport or the Store path collapses to "developer-only unpacked" — which defeats the plan's premise.

---

## P1 — should-fix

### A3 (P1) — "BYOK + Nano" overstates Nano's role; a Store non-tech user will almost never have Nano
The plan repeatedly frames the zero-daemon path as "Lite mode (BYOK + Nano)." In the code, Nano is **visual-verdict only** and explicitly `liteUsable: false` (`lite-engine.ts:129`), never a planner/navigator. It is also hard-gated: 22 GB free on the profile volume + a ~2 GB model download + Chrome availability (CLAUDE.md). A freshly-onboarded non-tech user will overwhelmingly get `unavailable`, at which point `lite-engine.ts:160` silently routes visual checks to the **paid cloud key**. Functionally fine — but the plan implies Nano is a reliable free contributor, which sets wrong cost/latency expectations.

**Action:** Reword to "BYOK (Nano opportunistically accelerates visual checks when available; otherwise the cloud key handles them too)." Set expectation that the pasted key drives *everything* on a typical machine.

### A4 (P1) — Extension↔daemon version skew: the Store auto-updates one half, npm pins the other
The plan sells Web Store "auto-updates" as a benefit (Gap A intro). But the daemon is a global npm install pinned to whatever version the user first ran; it does **not** auto-update. The two halves speak a WS JSON-RPC protocol (`{id}`/`{rid}`/`{event}`, per CLAUDE.md). A Store-updated panel against a months-old daemon can show a **green dot but broken runs** — the worst failure mode for a non-tech user (looks connected, silently misbehaves).

**Action:** Add a bridge **protocol-version handshake** on connect; if the daemon is older than the panel needs, surface "update the desktop app: re-run the one-liner" instead of failing opaquely. Add this as a Gap-B task.

### A5 (P1) — No cost or safety guardrail for the least-equipped audience
The plan targets users who vibe-code and won't grasp the Tier-4 host guard, autonomous click/type risk, or per-run token spend — yet it has **zero findings** on:
- **Spend:** a pasted key + an autonomous multi-step agent = uncapped cost. No in-panel spend meter, no cap.
- **Destructive actions:** the panel's "allow click/type on this site" opt-in (CLAUDE.md, `vibe/service.ts` `trustTargetHost:false`) is exactly the nuance this audience will tick without understanding. First runs on a real app could submit forms, delete data, send messages.

**Action:** Add a Gap-D "Safe defaults for non-tech": (1) a visible spend estimate/meter and an optional monthly cap; (2) a read-only/dry-run default for the first N runs, requiring an explicit flip before mutation; (3) plain-language copy on what "allow click/type" actually permits.

### A6 (P1) — "Zero terminal after setup" oversells the daemon path
The headline "two clicks + one paste, zero terminal" is only true for the **Lite/BYOK** path. "Click 2" is literally pasting `irm … | iex` into PowerShell (`panel.js:142`) — that *is* a terminal. The plan half-acknowledges this but the top-line promise doesn't scope it.

**Action:** Scope the headline: "Lite mode: zero terminal, ever. Optional desktop app: one terminal paste, once." Manage tester expectations so the terminal step isn't a surprise that reads as "I thought this was one-click."

---

## P2 — nice-to-have

### A7 (P2) — Gap B1 is overstated; the panel is already correct
The plan lists "fix the placeholder host" as a Gap-B task. The panel already emits the real `INSTALL_BASE` (`panel.js:140`); only the two **usage-comment lines** `install.ps1:4` and `install.sh:5` still say `<your-host>`. It's a ~2-minute comment fix, not a wiring gap — reclassify so it doesn't read as blocking.

### A8 (P2) — Definition of Done has no measurable acceptance test
"A non-technical user can click → paste → run" needs a concrete verification: a **clean-profile, Store-style (non-`loadUnpacked`) install with no local daemon**, paste key, run against the fixture, assert a verdict. The plan already flags "verify the lite path from a clean Store-style install" (Gap A4) but doesn't promote it into DoD as a gating test.

### A9 (P2) — Going public widens the localhost-bridge attack surface; unaddressed
The daemon listens on `ws://localhost:9322`. For a single developer that's fine; for a broad Store audience, any local page or other extension can probe/connect to it. The plan inherits this from the dev design without a finding.

**Action:** Consider an origin allow-list or a pairing token on the bridge before a public launch.

### A10 (P2) — Privacy-policy *content* undefined, not just the URL
The plan notes a privacy policy URL is mandatory (Gap A2) but not what it must disclose: page content is read, screenshots/clips captured (`tabCapture`), API keys stored in `chrome.storage`, and page data is sent to third-party model providers. With `debugger` + `<all_urls>`, Google will read this closely; a thin policy risks the rejection in A2.

---

## Feature suggestions, enhancements & upgrades

- **Native signed installer (.exe / .dmg) bundling Node.** The plan lists this only as an "escape hatch," but it is the single change that eliminates *both* remaining frictions (Node prerequisite + terminal paste) for the daemon path. For a non-tech audience this is arguably the real answer, not the fallback — worth a spike to cost it before committing to the one-liner long-term.
- **Hosted free-tier key proxy for a true zero-paste trial.** A rate-limited shared key behind a small proxy would let a first-time user run *one* QA task with no key paste at all — the lowest-friction possible "aha," with BYOK as the upgrade. (Weigh against the "nothing hosted server-side" principle in CLAUDE.md — this is a deliberate exception.)
- **In-panel spend meter + monthly cap** (also A5) — turns an invisible risk into a visible control; strong trust signal for non-tech users pasting their own key.
- **First-run read-only/dry-run mode** (also A5) — the agent explores and reports without clicking/typing until the user explicitly enables mutation. Safe default for the audience least able to predict consequences.
- **Daemon auto-update nudge** — panel pings npm `outdated` and offers a one-click "re-run installer" when the daemon lags the extension (pairs with A4).
- **One-click uninstall from the panel** — surfaces `qa daemon --uninstall-service` as a button so leaving is as easy as arriving.
- **Onboarding that shows, not tells** — a 15-second inline GIF of "Add to Chrome → paste key → run → verdict," since the audience won't read a `TESTING.md`. Pairs with the infobar heads-up from A2.
