# Chrome Web Store Readiness

> Status: PLAN (readiness prep, no code written yet)
> Date: 2026-07-14
> Owner: onboarding / distribution
> Related: `docs/plan/2026-07-13-non-tech-onboarding.md` (the plan this supports),
> `docs/plan/26-07-14-audit-non-tech-onboarding.md` (findings A2, A10, and the native-installer
> enhancement this doc actions), `extension/manifest.json`, `install/install.ps1`, `install/install.sh`

## Why this doc

The onboarding plan's entire non-technical distribution strategy rests on one unverified
assumption: that Chrome Web Store review approves `debugger` + `<all_urls>` for a
general-audience extension. The audit (A2) flagged this as a P0 rejection risk, not a
"heavy scrutiny, write a good justification" risk. This doc writes the actual
justifications (A2a), the CDP infobar copy the panel needs (A2b), the contingency if
`debugger` is rejected (A2c), the privacy-policy content checklist (A10), and cost-out
notes for the native-installer enhancement — so the submission and the fallback plan
both exist before store assets are invested in.

## 1. Chrome Web Store permission justifications (A2a, P0)

`extension/manifest.json` requests:

```json
"permissions": ["debugger", "tabs", "storage", "alarms", "offscreen", "sidePanel", "tabCapture"],
"host_permissions": ["<all_urls>"],
"content_scripts": [{ "matches": ["<all_urls>"], "js": ["overlay.js"], "run_at": "document_idle" }]
```

Below is the plain-English justification for each item that needs one in the Store's
"permission justification" fields (low-risk permissions like `storage`, `alarms`,
`sidePanel` are omitted — reviewers rarely question them).

**`debugger`** — This is the extension's core transport. The product drives the browser
via the Chrome DevTools Protocol (the same protocol Chrome DevTools itself uses) to
click, type, read the accessibility tree, and capture console/network errors on the page
the user is actively testing. There is no non-`debugger` way to get CDP-level access
(logpoint injection, full a11y tree, network drain) from an MV3 extension — `chrome.debugger`
is the only bridge. Justification text for the listing: *"Browser QA Subagent uses the
`debugger` permission to programmatically interact with the page under test (click, type,
scroll, read accessibility structure) and to capture console errors and failed network
requests, so it can report exactly what broke and where. This only runs on tabs the user
explicitly starts a QA run on, and stops when the run ends."*

**`tabCapture`** — Used to capture screenshots and short video clips as evidence for visual
assertions (e.g., confirming a modal actually rendered, or recording the failing step for
a replay clip). Justification text: *"tabCapture is used to record a short clip or
screenshot of the tab being tested, attached to the QA report as evidence of what the
agent observed. Capture is limited to the tab under test and only during an active run."*

**`tabs`** — Needed to identify which tab is the active QA target (title/URL, to open the
side panel against the right tab, and to know when the tab navigates during a run).
Justification text: *"tabs is used to identify the current tab so the QA agent knows which
page it is testing and can detect navigation during a run."*

**`host_permissions: ["<all_urls>"]`** — The product is generic: it has to be able to test
whatever site or web app the user names, not a fixed list of domains known in advance.
Justification text: *"The extension tests whatever site the user points it at — a
work-in-progress app on localhost, a staging URL, or a live site. Because the target is
user-supplied and unknown ahead of time, broad host access is required; the extension does
not access any host unless the user starts a QA run against it."*

**`<all_urls>` content script (`overlay.js`)** — Draws the ghost-cursor / highlight overlay
that shows the user what the agent is about to click, on whatever page is under test.
Justification text: *"overlay.js draws a visual cursor/highlight so the user can see what
the agent is about to interact with during a run. It is inert (does nothing, reads
nothing) on any tab that is not an active QA target."*

### Honest risk assessment

`debugger` + `<all_urls>` together is one of the most heavily restricted permission
combinations in the Chrome Web Store review process. Google's stated policy is that
`debugger` should be used only when no other API can achieve the same result, and reviewers
manually scrutinize any extension combining it with broad host access — this pairing is
associated with a meaningfully elevated **rejection** rate, not just a slower review. Two
mitigating facts do not eliminate the risk: (1) the justification above is genuinely
narrow and true (there is no alternative CDP-level API for MV3), and (2) usage is
gated to explicit, user-initiated runs. But neither guarantees approval, and Google's
review criteria for `debugger` have tightened over time with no public precedent database
to test against in advance.

**Recommendation: treat Store approval as a hypothesis to de-risk *before* investing in
screenshots, promo copy, or a privacy-policy page.** Concretely:
- Submit the extension for review as early as possible with minimal store assets (the
  review process itself is the cheapest way to get a real answer) rather than polishing
  the full listing first.
- If Google offers any pre-review / trusted-tester channel, use it.
- Do not schedule downstream onboarding work (screenshots, promo video, GIF from the
  audit's enhancement list) as if Store approval is a foregone conclusion — sequence those
  *after* a first review response, not before.

## 2. The CDP infobar (A2b, P0)

Any tab driven via `chrome.debugger` gets a **persistent yellow Chrome infobar**:
`"Browser QA Subagent" started debugging this browser`. This is a Chrome platform
behavior, not something the extension renders — it cannot be hidden, styled, or
suppressed in a Store-distributed build (only `--silent-debugger-extension-api`, a
command-line flag unavailable to a packaged extension, suppresses it). It reappears on
every tab the extension attaches to and stays until the debugger detaches.

For a non-technical user mid-onboarding this reads as an alarming, unexplained system
warning ("something is wrong" / "am I being spied on") unless it's pre-explained. The
current onboarding plan (2026-07-13 doc) has no copy for this. Add it in two places:

**First-run / panel copy (before the first run starts):**

> "Heads up: when a test starts, Chrome shows a yellow bar at the top of the tab saying
> **'Browser QA Subagent started debugging this browser.'** That's expected — it's Chrome's
> own way of telling you an extension is driving that tab, the same notice DevTools shows.
> It disappears automatically when the run finishes. You don't need to do anything."

**Inline copy shown the moment a run starts (side panel, next to the "running" indicator):**

> "Chrome's yellow bar is showing on your tab right now — that's normal, it means the
> agent is actively testing this page."

**Tooltip/help icon next to the connection status**, for a user who dismisses the
first-run copy and sees the bar later without context:

> "Why do I see a yellow bar? Chrome shows this on any tab an extension is remote-
> controlling via its debugging API. It's a Chrome safety notice, not an error — it clears
> when the test ends."

## 3. Contingency if `debugger` is rejected (A2c, P0)

The entire Web Store strategy — "one click, auto-updating, non-technical-friendly" — rides
on `debugger` clearing review. This section exists so a rejection has a pre-thought-out
response instead of a scramble.

**Is there a non-`debugger` transport?** No full substitute exists today. `chrome.scripting`
(content-script injection) can drive DOM clicks/typing on pages the extension has host
permission for, but it cannot: read the full accessibility tree the way `Accessibility.getFullAXTree`
does, set CDP logpoints for zero-edit instrumentation (Spike B's core proof), or capture
structured console/network events the way the CDP `Runtime`/`Network` domains do. A
`chrome.scripting`-only rewrite would lose the a11y-tree-first driver design entirely and
regress to fragile CSS/DOM-selector automation — a materially different, weaker product,
not a drop-in swap. This is not a quick fallback; it's a second engineering track.

**Does the Store path collapse to developer-only "Load unpacked"?** Yes, if `debugger` is
rejected outright with no acceptable narrower framing. `Extensions.loadUnpacked` / manual
`chrome://extensions` dev-mode loading requires enabling Developer Mode and manually
pointing Chrome at an unpacked folder — exactly the friction the non-technical onboarding
plan exists to eliminate. That would sink the "two clicks" premise for the extension half
of the product; **Lite mode's CDP path (the CLI, via `CdpBrowser` spawning Chrome directly)
is unaffected**, since it never goes through the Store or `chrome.debugger` — only the
extension-driven vibe-panel flow is at risk.

**Fallback plan, in order of preference if rejected:**
1. **Re-submit with a narrower justification or reduced scope** — e.g., request
   `activeTab` instead of blanket `<all_urls>` host permissions (see the original plan's
   Gap A1, not yet implemented) and re-emphasize the `debugger` justification's narrowness.
   This is the first thing to try; a rejection reason from Google should directly inform
   what to narrow.
2. **Ship as "developer/tester" only via unpacked/sideload**, and be explicit in product
   messaging that the non-technical audience is not yet served by the extension — Lite
   mode via a locally-run CLI/daemon becomes the only non-technical-friendly surface until
   a Store path exists (which itself still needs the daemon one-liner, i.e. is not
   zero-terminal either — see the audit's A6).
3. **Investigate whether Google offers a restricted/unlisted or enterprise-only listing
   path** that has different `debugger` tolerance, as an interim distribution channel while
   pursuing (1).

**Bottom line:** don't build downstream non-technical UX (store screenshots, onboarding
GIFs, the audit's "onboarding that shows, not tells" enhancement) on the assumption that
`debugger` clears review. Get a real review verdict first.

## 4. Privacy-policy content checklist (A10, P2)

The onboarding plan's Gap A2 only notes that a privacy policy URL is mandatory for
submission. With `debugger` + `<all_urls>` + `tabCapture`, Google's review reads the
policy's *content* closely, and a thin policy risks compounding the A2 rejection risk. The
policy must explicitly disclose, at minimum:

- **Page content is read.** The extension reads DOM/accessibility-tree content and console/
  network activity from the tab under test via `chrome.debugger`, in order to drive the
  page and detect errors.
- **Screenshots and video clips are captured.** `tabCapture` is used to record screenshots
  and short clips of the tab under test as evidence attached to QA reports; state whether
  these are stored locally only, or ever transmitted (see next point).
- **API keys are stored in `chrome.storage`.** User-pasted BYOK keys (Gemini/Anthropic/
  OpenAI/etc.) are persisted in the browser's extension storage on the user's own device;
  state that these are not transmitted to any server the product operator controls.
- **Page data is sent to third-party model providers.** Screenshots, accessibility-tree
  text, and console/network excerpts from the tested page are sent to whichever model
  provider the user has configured (Anthropic, Google, OpenAI, GLM/z.ai, or a local Ollama/
  on-device Gemini Nano — name the actual set the product ships with) to generate the QA
  verdict. This is the most safety-relevant disclosure for the permission set requested:
  the extension does not just read the page, it forwards captured page data off-device to
  a party the user chose.
- **What is NOT collected/transmitted** — no analytics/telemetry to the product operator
  beyond what's explicitly opted into (if any exists — check `src/telemetry` for what
  actually ships and disclose truthfully), no data sold or shared beyond the user's chosen
  model provider.
- **Retention** — where captured artifacts (`artifacts/<runId>/report.json`, screenshots)
  live (local disk, under the user's control) and how a user deletes them.
- **Scope of access** — reiterate that data is only read/transmitted for tabs the user
  explicitly starts a QA run against, not passively on every tab despite the `<all_urls>`
  permission grant.

This should be a real published page (not a placeholder) before submission — Google
checks that the privacy-policy URL resolves and that its content plausibly matches the
requested permissions; a generic template policy that doesn't mention model-provider data
sharing is a known rejection pattern for AI-assistant-style extensions.

## 5. Native installer spike notes (Enhancement, P2)

The onboarding plan's "Known remaining friction" section names Node-as-prerequisite as the
last real friction on the daemon path and defers a native installer to an "escape hatch."
The audit's enhancement list promotes it further: a signed native installer is the single
change that eliminates *both* remaining daemon frictions at once — Node-as-prerequisite
**and** the terminal paste (`irm|iex` / `curl|sh`) itself — replacing them with a normal
double-click installer non-technical users already know how to run. Sketch, to be costed
before committing to the one-liner as the permanent answer (not the fallback):

**Windows (`.exe`, primary target given the dev machine and likely early testers):**
- Package with a bundler that produces a single signed `.exe` — options: `electron-builder`
  squirrel/NSIS target (heavier, but well-trodden), or a lighter NSIS/Inno Setup script
  around a bundled Node runtime (e.g. via `node-sea` / `pkg`-style single-executable Node,
  or just vendoring a portable Node zip alongside the installed CLI).
- Installer steps: extract bundled Node + the `spike-agent` CLI to
  `%LOCALAPPDATA%\spike-agent\`, then shell out to the existing
  `src/service/install-service.ts` logic (Scheduled Task `ONLOGON /RU <user>`) to register
  autostart — reuses code that already exists and is tested via `__setRunner`.
  wanted: no admin elevation, matching the current one-liner's per-user, no-admin design.
- Code-signing: needs an Authenticode cert (~$100–400/yr depending on vendor) or Windows
  SmartScreen will warn on first run — a trust/friction cost to weigh against the terminal
  paste it removes.

**macOS (`.dmg` / `.pkg`):**
- `.pkg` installer (via `pkgbuild`/`productbuild`) that installs a bundled Node + the CLI
  into `/usr/local/spike-agent` or similar, then registers the existing
  `~/Library/LaunchAgents` plist (`RunAtLoad`) from `install-service.ts`.
- Needs an Apple Developer ID cert ($99/yr) for code-signing + notarization, or Gatekeeper
  blocks the unsigned installer outright — this is a harder requirement than Windows
  SmartScreen (notarization is enforced, not just a warning).

**Linux:** lowest priority given the audience (non-technical vibe-coders skew Windows/
macOS); if pursued, an AppImage or a distro-specific package (`.deb`) wrapping the same
bundled-Node + `systemd --user` unit registration.

**What to cost before committing:**
- Engineering time to build + test three installer pipelines vs. the one-liner's near-zero
  marginal cost.
- Annual signing-cert costs (Windows + Apple) vs. $0 for the script-based approach.
- Whether bundling a full Node runtime per OS meaningfully bloats download size in a way
  that matters for a "click and go" non-technical audience (a few tens of MB is likely
  fine).
- Update story: the one-liner's `npm i -g` picks up new versions on re-run; a native
  installer needs its own update mechanism (auto-update lib, or just "re-download and
  re-run the installer") — don't let this quietly regress the update story the daemon
  already has.

**Recommendation:** spike the Windows `.exe` path first (matches the current dev
environment and likely first test cohort), reusing `install-service.ts`'s existing
autostart registration rather than rewriting it, and get a real signing-cert cost before
deciding whether this replaces or merely supplements the `irm|iex` one-liner.
