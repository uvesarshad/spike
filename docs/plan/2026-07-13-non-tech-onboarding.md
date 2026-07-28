# Non-Technical Onboarding — "Two clicks → ready to run"

> Status: PLAN (scoping only, no code written yet)
> Date: 2026-07-13
> Owner: onboarding / distribution
> Related: `install/install.ps1`, `install/install.sh`, `src/service/install-service.ts`,
> `src/extension/lite-engine.ts`, `extension/panel.js`, `extension/manifest.json`, CLAUDE.md (`INSTALL_BASE`)

## Why this doc

The existing tester guide (git clone → npm build → env vars → "Load unpacked") is a
**developer** onboarding path. A non-technical user who vibe-codes their app bounces off
every step. This doc scopes the flow that gets *that* user from nothing to a working QA
run in **two clicks + one paste**. To be precise about the terminal promise: **Lite mode
is zero terminal, ever; the optional Spike Core is one terminal paste, once.**

The critical reframe: **the `claude` CLI is NOT on the non-technical path.** It requires
installing another CLI and doing an OAuth login in a terminal — strictly harder than
pasting an API key. `claude` CLI stays a developer/tester convenience (it reuses an
existing login). The vibe-coder's model is a **pasted BYOK key**.

## Locked decisions (2026-07-13)

- **Extension install target:** Chrome Web Store listing ("Add to Chrome" = true one-click, auto-updating). The only genuinely one-click extension path; packaged `.crx` / drag-to-install is fragile in modern Chrome and rejected.
- **Daemon + model default:** one-liner installer (`irm|iex` / `curl|sh`) for the *optional* daemon, with the **model defaulting to a pasted BYOK key**, not `claude` CLI. Two pastes total, and the daemon is explicitly optional.
- **Scope of this pass:** planning/scoping only. No code changes in this doc.

## Target flow (what a vibe-coder actually does)

1. **Click 1 — "Add to Chrome"** on the Web Store listing → extension installs, auto-updates, side panel appears.
2. **Paste an API key** (Gemini or Anthropic) into the side panel → **Lite mode** tests immediately: no daemon, no terminal, no CLI. This step is genuinely zero terminal, ever.
3. **Optional, one terminal paste, once (only for auto-fix + saved replay clips)** — the panel's "Connect Spike Core" block hands them an `irm|iex` one-liner to paste into PowerShell (or `curl|sh` into a shell) → daemon installs + auto-starts on login → connection dot goes green. This step *is* a terminal, by definition — it is not part of the zero-terminal promise, which applies to Lite mode only.

Lite mode — BYOK, with Nano opportunistically accelerating visual checks when available
and the cloud key handling them too when it isn't — is the whole product for someone who
just wants a verdict, and it is the only genuinely terminal-free path. The daemon only adds
things an MV3 worker fundamentally can't do: CLI planners/navigators, auto-fix (edits files
on disk), and replay clips — and reaching it costs exactly one terminal paste, once.

## What already exists (do not rebuild)

- **Lite mode** — `src/extension/lite-engine.ts` runs BYOK testing with no daemon; Nano
  opportunistically accelerates visual checks when the on-device gate passes (it is marked
  `liteUsable: false` at `lite-engine.ts:129` and is never a planner/navigator — it only ever
  assists `assert_visual`/final-confirm checks, and the cloud key covers those too when Nano
  is unavailable, which is the common case on a fresh non-technical machine given the 22GB
  free-space + ~2GB download gate). This is the zero-terminal core; it already works.
- **One-liner daemon installer** — `install/install.ps1` / `install/install.sh`: node-check → `npm i -g spike-agent` → `spike daemon --install-service` → green dot. Idempotent, per-user, no admin.
- **Auto-start service** — `src/service/install-service.ts` registers a Windows Scheduled Task (`ONLOGON /RU <user>`), a macOS LaunchAgent (`RunAtLoad`), or a Linux `systemd --user` unit, so the daemon survives reboots with no terminal.
- **Panel "Connect Spike Core" block** — `extension/panel.js` already holds the REAL `INSTALL_BASE` (`raw.githubusercontent.com/uvesarshad/spike/main/install`) and renders the per-OS one-liner; `extension/panel.html:196` has the block; `extension/panel.css:937` styles it.
- **Extension icons** — `extension/manifest.json` already references 16/32/48/128 PNGs (a Store prerequisite, already met).

## Gaps to close

### A. Extension → Chrome Web Store (biggest lift, highest payoff; long pole = Google review)

1. **Manifest / permission audit for review.** `extension/manifest.json` requests
   `host_permissions: ["<all_urls>"]`, `permissions: ["debugger", "tabs", "tabCapture", ...]`,
   and an `<all_urls>` content script (`overlay.js`). The Store scrutinizes `debugger` +
   `<all_urls>` heavily. Actions:
   - Write a clear justification for `debugger` (it's the CDP transport for driving the page) and `tabCapture` (video assertions / clips).
   - Evaluate scoping host access to `activeTab` + on-demand grants instead of blanket `<all_urls>` where the driver's UX allows it. If `<all_urls>` must stay, document *why* in the store listing's permission-justification fields.
2. **Store assets.** Icons exist. Still needed: 1–2 screenshots (1280×800 or 640×400), a ≤132-char summary, a category, and a **privacy policy URL** (mandatory — the extension reads page content). A promo tile is optional.
3. **Developer account + submission.** $5 one-time Chrome Web Store dev account; package `extension/` as a zip; first review is typically a few days. **Start submission early** — it's calendar-bound, not effort-bound.
4. **Store-install must work daemon-free.** A Web Store install is only useful on its own if Lite mode (BYOK — Nano only opportunistically assisting visual checks when available) needs zero daemon. Verify the lite path end-to-end from a clean Store-style install (no `Extensions.loadUnpacked`, no local daemon).

### B. Daemon one-liner + BYOK default (small lift; do this FIRST)

1. **Fix the placeholder host in the script headers.** `install/install.ps1:4` and
   `install/install.sh:5` still show `https://<your-host>/…` in their usage comments. The
   panel already emits the correct `raw.githubusercontent.com/uvesarshad/spike/main/install`
   URL — just align the two script comments so a user reading the script sees the real URL.
2. **Make BYOK the panel's first-run default.** First run should invite "paste a Gemini or
   Anthropic key," NOT assume a daemon or CLI. The daemon ("Connect Spike Core") must
   read as explicitly optional — "unlocks auto-fix + saved replays," not "required to start."
3. **Node-not-installed is still a dead end.** The script tells the user to go install Node
   and re-run. For true non-tech, offer `winget install OpenJS.NodeJS.LTS` (Windows) or point
   at the .msi. This is the last real friction on the daemon path — see "Known remaining friction."

### C. Copy / UX so the two paths don't confuse (small lift)

- The panel currently foregrounds the daemon (a red connection dot), which reads as "broken
  until you install something" — the wrong signal for a BYOK-only user who never needs the daemon.
- Reword so the hierarchy is explicit: **"Test right now with an API key. Spike Core is
  optional and adds auto-fix + saved replays."** The red dot should not imply the product is
  non-functional without it.

## Recommended build order

1. **B first (days).** Fix the install-script host comments, make BYOK the first-run default,
   reword the daemon block as optional. This makes the extension genuinely useful *before* the
   Store listing lands, and de-risks the whole flow with real testers on the unpacked build.
2. **A in parallel (calendar-bound).** Manifest/permission audit → store assets → submit. The
   long pole is Google's review; kick off submission as early as possible.
3. **Leave `claude` CLI as the developer/tester path only.** Keep it in the tester guide; do
   NOT surface it in the vibe-coder UI.

## Known remaining friction (accepted for now)

- **Node is a prerequisite for the daemon.** Lite mode (BYOK) needs no Node at all; the
  *optional* daemon needs Node 20+. The one-liner can *help* install Node (winget/msi) but
  can't fully hide it. We chose the one-liner over a native `.exe`/`.dmg` bundle, so this is
  the accepted trade-off. **Escape hatch:** if real testers stall on Node, revisit a signed
  native installer that bundles Node + registers autostart with zero terminal.
- **First Web Store review is multi-day and may bounce on `<all_urls>` + `debugger`.** Budget
  a review round-trip; have the permission justifications written before submitting.

## Definition of done

- **The npm package `spike-agent` is actually published under that exact name.**
  Both `install/install.ps1` / `install/install.sh` and the extension service worker run
  `npm i -g spike-agent` — if the package isn't live on npm under this name, the
  entire daemon path (Click 2) fails at the last step for every user.
- **The GitHub repo `github.com/uvesarshad/spike` is public and serves
  `install/install.ps1` + `install/install.sh` at `main`.** The panel's `INSTALL_BASE`
  (`raw.githubusercontent.com/uvesarshad/spike/main/install`) points there;
  if the repo is private, renamed, or the scripts aren't on `main`, the one-liner 404s
  silently and the user has no error to act on.
- A non-technical user can: click "Add to Chrome" → paste an API key → run a QA task and get
  a verdict, **without ever opening a terminal or installing the `claude` CLI**.
- The optional daemon install is a single copy-paste one-liner (or, later, a native installer)
  surfaced from the panel, clearly labeled as optional and additive — and honestly labeled as
  a terminal step, since it is one.
- The `claude` CLI path remains documented for developers/testers only.
- **Acceptance test for the zero-daemon Lite path:** on a clean profile, install the extension
  Store-style (real "Add to Chrome" flow — NOT `Extensions.loadUnpacked`), with no local daemon
  running, paste an API key, run a QA task against the fixture app, and assert a verdict comes
  back. This is the test that actually proves the Lite path works from a real Store install,
  not just from a dev's unpacked build.
