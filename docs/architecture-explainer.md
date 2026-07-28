# How Spike Works — A Plain-English Tour

*Audience: anyone — including builders who have never opened a terminal. No prior knowledge assumed.*

---

## What this is, in one breath

A robot QA tester that drives a **real Chrome browser**, watches what actually happens (errors, broken pages, failed network calls), and reports back — so your expensive coding AI doesn't have to look at the browser at all. The AI that writes your code pays ~2,000 tokens for a complete test verdict instead of ~114,000 tokens for driving the browser itself.

Two faces, one engine:

| | **Dev mode** (built first) | **Vibe mode** (coming next) |
|---|---|---|
| Who | Developers using Claude Code, Cursor, Copilot | Builders on Lovable, Bolt, v0, Replit |
| How it's used | The coding agent calls one tool: `qa_run("test the login flow", url)` | A chat panel in Chrome: *"test my signup flow"* |
| What comes back | A compact JSON verdict + evidence files | A watchable robot-cursor show + a ready-to-paste fix prompt |

---

## What is CDP, and how do we "launch" it?

**CDP = Chrome DevTools Protocol.** When you press F12 in Chrome, the DevTools panel that opens isn't magic — it talks to the browser over an internal wire protocol. That protocol is CDP. Anything DevTools can do — click, type, navigate, take a screenshot, read console errors, watch network requests — a program can do by speaking CDP.

You never launch "CDP" itself. You launch Chrome with one extra flag:

```
chrome.exe --remote-debugging-port=9322
```

…and Chrome starts listening on that local port (a door that only programs on **your own machine** can knock on). Our daemon — a small background program — starts Chrome with that flag automatically, or quietly reuses a Chrome it already started. **Nobody has to type that command.** Playwright, Puppeteer, and Google's Antigravity all work exactly this way under the hood.

## "I don't do terminals" — the plug-and-play story

Today's MVP is for developers, and its install is the one developers already know (register an MCP tool, one command). The vibe-mode plan is different and deliberately boring:

1. Install a Chrome extension from the Web Store (one click).
2. A side panel opens in your browser. Type *"test my checkout."*
3. Watch the robot cursor do it. Get a plain-English report and a fix prompt you paste into Lovable/Cursor/Bolt.

No terminal, no flags, no ports. The extension reaches the same CDP powers through Chrome's `chrome.debugger` permission — granted by a normal extension-permission prompt instead of a command-line flag. A few honest facts the app surfaces during onboarding instead of hiding:

- It opens (or uses) a Chrome window it controls; your normal browsing is untouched — it runs under its **own browser profile**.
- Everything runs on your machine. No cloud browser, no uploaded screenshots, no account.
- The on-device AI needs a one-time ~2 GB download and ~22 GB of free disk (next section).

## What is Gemini Nano, and what does it need?

Gemini Nano is a small AI model **built into Chrome itself**. Chrome downloads it once (~2 GB) and runs it **on your computer** — no API key, no account, no per-use billing, and it works offline. Web pages and extensions reach it through Chrome's **Prompt API**: you hand it text and/or an image, and you can force it to answer in an exact JSON shape (so the answer is always machine-readable, never rambling).

We use it as the **$0 eyeball**: "here's a screenshot — does this page look broken?" It answers in a strict format:

```json
{ "verdict": "fail", "summary": "Application error banner is visible.", "issues": ["Application error: a client-side exception has occurred…"] }
```

**System requirements** (Chrome enforces these; the product surfaces them in onboarding):

| Requirement | Detail |
|---|---|
| Chrome | Desktop Chrome 138+ (image input stable in 148). Not mobile. |
| Disk | **22 GB free on the drive that holds the Chrome profile.** This is the #1 silent failure — Chrome just reports "unavailable". Our tooling checks your free space and tells you which drive to fix. |
| GPU/CPU | A modern GPU (~4 GB VRAM) or a reasonably fast CPU. |
| Speed | First answer after Chrome starts: ~15–20 s (model loads into memory). After that: **~2–6 s per verdict.** We keep it "warm" so you only pay the slow start once. |

**If a machine doesn't qualify, nothing breaks.** Nano is rung 0 of a ladder (below) — the system silently uses the next rung.

## The complete flow — how the expensive AI "talks to" Nano

Short answer: **it never does.** The daemon sits in the middle, and the expensive model only ever sees the final verdict.

```
 Coding agent (Claude/GPT/…)               YOUR MACHINE — the daemon + Chrome
 ───────────────────────────               ──────────────────────────────────────────
 1. calls one tool:                        2. daemon starts/reuses Chrome (CDP)
    qa_run("log in and check out",         3. opens the page in a QA tab
           "http://localhost:3000")        4. THE LOOP — paid in cheap/free tokens:
          │                                   ┌────────────────────────────────────┐
          │  while this runs, the             │ a. read the page as an             │
          │  expensive model pays             │    "accessibility tree" — compact  │
          │  NOTHING — it's just              │    text, ~800 tokens, with ids:    │
          │  waiting for one                  │      n3 textbox "Email"            │
          │  tool result                      │      n7 button "Sign in"           │
          │                                   │ b. ask the PLANNER (Gemini Flash,  │
          │                                   │    free quota or your key):        │
          │                                   │    "task + page + history →        │
          │                                   │     what's the ONE next action?"   │
          │                                   │ c. execute it over CDP (click n7…) │
          │                                   │ d. capture console errors + every  │
          │                                   │    network request this step caused│
          │                                   │ e. visual question? screenshot →   │
          │                                   │    GEMINI NANO judges it ($0)      │
          │                                   └────────── repeat ≤12 steps ────────┘
          ▼                                5. write artifacts to disk:
 6. receives ~2K-token verdict:               report.json + screenshots/
    { verdict: "fail",
      failing_step: {…"click 'Place order'"},
      console_error: "[PAGE-ERROR] Cannot read … 'toFixed'",
      evidence_paths: ["artifacts/…/report.json", "…/step-07.png"] }
```

Why this is cheap: the page goes to the model as that **compact text tree**, not as screenshots (screenshots cost 10,000+ tokens each when an expensive model reads them). Vision happens only when the question is genuinely visual — and then a $0 on-device model does the looking.

## The model ladder

The daemon routes each job to the cheapest model that can do it, escalating only on uncertainty:

| Rung | Model | Cost | Used for |
|---|---|---|---|
| 0 | **Gemini Nano** (in Chrome) | $0, on-device | "does this look right?" — most checks |
| 1 | **Google CLI free quota** (Gemini Flash) | $0 (quota) | planning the steps, multi-step reasoning |
| 2 | **Bring-your-own-key** (Gemini API / OpenRouter / any) | your key | heavy runs, teams, lower latency |
| 3 | **Ollama** (fully local) | $0, private | the privacy floor — nothing ever leaves the machine |

Every escalation is recorded in the report (`model_trace`), so you can see exactly which model did what and what the run really cost. The free rungs are *defaults*, not the foundation: Google has already announced free-quota changes (June 18, 2026 — the `gemini` CLI's free tier moves to the Antigravity CLI). That's why rung 1 is a generic "Google CLI adapter" with the binary name in config, and why BYOK + local exist on day one.

## Why "CDP now, extension later" — and how both live together

The engine never talks to Chrome directly. It talks to a **BrowserPort** — a contract listing exactly what it needs (navigate, click, type, screenshot, read the tree, capture console/network, set logpoints). Two implementations:

- **`CdpBrowser` (today):** plain CDP against the Chrome the daemon launches. Proven by the spikes, zero install friction for developers, shipping now.
- **`ExtensionBrowser` (vibe milestone):** the same contract implemented inside an MV3 Chrome extension (`chrome.debugger`). This unlocks the Web-Store one-click install, testing in your *real logged-in* browser session, and the extension's own native access to Nano.

The stub for the second one exists in the codebase **now**, with every method mapped to its extension equivalent. That's not dead code — it's a design constraint: the engine is forbidden from assuming "Chrome was launched by me," so when vibe mode arrives it's *implement the right column*, not *rewrite the engine*.

### Bonus trick the spikes proved: logpoints

When a test fails, the daemon can inject `console.log`s into the running page **at any file and line, without touching your source code** (a CDP debugger feature: a breakpoint whose "condition" logs values and then refuses to pause). Your code on disk never changes — no dirty diffs, no cleanup, and it works on sites you don't own. This is the core of the *diagnose* tier: not just "it's broken," but "here's the variable that was wrong at the moment it broke."

## Glossary

- **a11y tree (accessibility tree):** the structured outline browsers build for screen readers — every meaningful element with its role and label ("button: Sign in"). Tiny in tokens, which is why it's the robot's primary "eyes".
- **CDP:** Chrome DevTools Protocol — the browser's built-in remote control (see above).
- **Daemon:** a small program that runs in the background on your machine and does the orchestrating.
- **Logpoint:** a debugger breakpoint that logs values instead of pausing — instrumentation with zero source edits.
- **MCP (Model Context Protocol):** the standard plug through which coding agents (Claude Code, Cursor…) call external tools like `qa_run`.
- **MV3 extension:** a normal modern Chrome extension (Manifest V3), installed from the Web Store.
- **Profile (Chrome profile):** Chrome's per-identity data folder. The robot uses its own, so your bookmarks/logins/history are untouched.
- **Token:** the billing unit of AI models (~4 characters of text). 114K tokens ≈ a short novel chapter; 2K ≈ half a page.
