# Chrome Web Store — Submission Kit

> Copy‑paste answers for the Web Store developer dashboard, grounded in
> `extension/manifest.json`. Fill the `[BRACKETED]` values. Pairs with the
> privacy policy in `PRIVACY.md` (host it and paste the URL where noted).
> Package the upload with `npm run pack:extension` → `dist/extension.zip`.

---

## 1. Store listing

**Item name**
```
Spike — QA testing agent
```

**Summary / short description** (≤132 chars — matches `manifest.json`)
```
Autonomous browser QA: a cheap-model ladder tests your app in your real Chrome and reports back.
```

**Category:** Developer Tools
**Language:** English (United States)

**Detailed description** (store listing body):
```
Spike turns the browser you already have into an automated QA engineer for the apps you're building.

Give it a URL and a plain-English task — "log in and complete checkout", "verify the homepage renders and the nav works" — and it drives YOUR real Chrome, watches what actually happens (console errors, failed network requests, broken rendering), and reports back a clear verdict with evidence: the failing step, the exact error with file:line, the failed request, and a screenshot.

It's built for the age of AI coding agents. Coding assistants write UI code and claim "fixed!" but can't see the result. This extension does the looking — cheaply — so you (or your agent) get a trustworthy pass/fail instead of guessing.

HOW IT KEEPS COST DOWN
A "model ladder" runs the cheapest capable model for each step:
• On-device Gemini Nano (Chrome's built-in AI) for visual checks — $0, nothing leaves your machine.
• Your own API key (Gemini, Anthropic, OpenAI, OpenRouter, or GLM/z.ai) for planning — you control the spend.
• Local Ollama for a fully private option.
The page is read primarily as a compact accessibility tree (text), not as a stream of screenshots, so runs stay fast and cheap.

WHAT YOU GET
• Plain-English verdict with the failing step and the real console/network error.
• A side-panel chat UI with a live progress feed and a ghost-cursor "watch the robot" view.
• A paste-ready fix prompt for your coding agent — or hand it off automatically.
• Re-runnable recorded tests so a passing flow can be checked again at $0.

PRIVACY-FIRST
The extension talks only to Spike Core on your own machine and to the AI provider YOU choose. There is no account and no first-party analytics. On-device (Nano) and local (Ollama) options keep everything on your machine. Your API keys are stored encrypted on your device and are never sent to us. See our privacy policy for the full data-flow breakdown.

REQUIREMENTS
• Desktop Chrome (latest). Multimodal on-device AI needs a recent Chrome with Gemini Nano support.
• Spike Core running on your machine — install instructions on our site/repo.

Open source, Apache-2.0.
```

**Support / homepage URL:** `https://github.com/uvesarshad/spike`
**Support email:** `uveskhan234@gmail.com`

---

## 2. Single‑purpose description (required field)

```
This extension automates browser-based QA testing: it drives the user's current
tab to perform a user-described test and reports a pass/fail verdict with console,
network, and screenshot evidence. Every permission below serves that single
purpose.
```

---

## 3. Permission justifications

Paste each into the matching box in the dashboard's "Permission justification" section. These map 1:1 to `manifest.json`.

| Permission | Justification |
|---|---|
| `debugger` | Core function. The extension drives the page under test over the Chrome DevTools Protocol — navigate, click, type, capture screenshots, read the accessibility tree, and collect console messages and network activity caused by each test step. This is how it observes whether the app actually works. Chrome shows the standard "is being debugged" banner while a test runs. |
| `tabs` | To identify the user's active tab (the app they want tested) and attach the test session to it, and to open a fresh tab for the "test a URL" flow. Used only to target the correct tab; page contents are read via the debugger session above, not the tabs API. |
| `storage` | Local-only. Stores the user's settings (which AI provider drives testing, debugging preferences) and a short local run history (last ~10 runs) via `chrome.storage.local`. No data is synced or sent off-device by this permission. |
| `alarms` | Keeps the MV3 service worker alive and reconnected to Spike Core. The worker maintains a WebSocket to a localhost daemon; a periodic alarm reconnects it after the worker is suspended, so a queued test can run reliably. |
| `offscreen` | Hosts an offscreen document for two on-device tasks that require a DOM/secure context: (1) running Chrome's built-in Gemini Nano Prompt API for $0 on-device visual checks, and (2) the `MediaRecorder` that produces the optional replay clip. |
| `sidePanel` | The product UI is a side panel: the user types the test task there and watches a live progress feed and verdict card. |
| `tabCapture` | Optional, user-visible feature: records a short replay clip (video) of the test run so the user can review or share what the agent did. Only active during a run the user initiated. |
| `host_permissions: <all_urls>` | The user must be able to test **any** web app they are building, on whatever origin it's served from (localhost, a staging URL, or production they own). The extension cannot know those origins in advance, so it requests access to all URLs and acts only on the page the user explicitly points it at. By default it is read-only (navigation and observation) on third-party origins; clicking and typing require the user's per-site opt-in. |
| `content_scripts` on `<all_urls>` (`overlay.js`) | Injects a visual overlay (a "ghost cursor" and a caption pill narrating each step) on the page under test, so the user can see what the agent is doing. The overlay is display-only (`pointer-events: none`) and does not read or modify page data. Same all-URLs rationale as above. |

---

## 4. Privacy practices (Data usage tab)

**Privacy policy URL:** `https://github.com/uvesarshad/spike/blob/main/PRIVACY.md`  ← required (the `debugger` + `<all_urls>` permissions are "powerful"; Chrome will not approve without a privacy policy). Hosted on GitHub for now; swap for a website URL later if desired.

Declare the following in the "What user data do you collect?" checklist — answer honestly per your final build:

- ☑ **Website content** — the page under test (accessibility tree, and screenshots for visual checks) is processed to run the test. Sent to the AI provider the user configures, or processed on-device (Nano/Ollama). Not sent to us.
- ☑ **Authentication information** — only if the user stores an AI‑provider API key via the panel; it is passed to Spike Core and stored **encrypted on the user's device**. Not transmitted to us. (Test credentials the user supplies are likewise resolved locally and never sent to the AI model.)
- ☐ Location, health, financial, personal communications, web‑browsing history — **not** collected.

**Required certifications** (all true for this extension):
- ☑ I do not sell or transfer user data to third parties outside of the approved use cases.
- ☑ I do not use or transfer user data for purposes unrelated to the item's single purpose.
- ☑ I do not use or transfer user data to determine creditworthiness or for lending.

> Note for review: the extension has **no first‑party server**. Data either stays
> on-device or is sent to the AI provider the user themselves selected and keyed.
> The "remote code" question: all executable code ships in the package; no remote
> scripts are loaded.

---

## 5. Graphic assets (manual — capture before submit)

Required:
- **Screenshots:** 1–5, at **1280×800** (or 640×400). PNG/JPEG, no alpha.

Suggested shot list (open the side panel on a test run):
1. Side panel with a task typed in + the live progress feed mid-run.
2. The verdict card on a **FAIL** — failing step + console error + screenshot evidence.
3. The "watch the robot" ghost cursor gliding over a page with a caption pill.
4. The verdict card on a **PASS** (green).
5. Settings: provider picker (showing the model ladder incl. on-device + BYOK).

Recommended:
- **Small promo tile:** 440×280 PNG.
- (Optional marquee: 1400×560.)

Store icon (128px) is already in the package (`extension/icons/icon128.png`).

---

## 6. Pre-upload checklist

- [ ] `npm run pack:extension` → `dist/extension.zip` (manifest at zip root).
- [ ] Manifest `version` is correct (currently `0.0.1`).
- [ ] No `key` field or dev-only entries in `manifest.json` (verified: none).
- [ ] Privacy policy hosted; URL pasted in §4.
- [ ] Screenshots (§5) uploaded.
- [ ] Permission justifications (§3) pasted.
- [ ] Single-purpose statement (§2) pasted.
- [ ] Support email + homepage set.
- [ ] Heads-up for review: the extension needs **Spike Core** running to
      function; reviewers without it will see the panel + a "daemon not connected"
      state. Mention this in the reviewer notes so it isn't flagged as broken.

> Known limitation worth a reviewer note: the side panel shows a "connect the local
> app" state until the `spike` daemon is running on the user's machine. This is by
> design (the heavy lifting is local, not in the extension).
