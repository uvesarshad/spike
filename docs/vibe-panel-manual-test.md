# Vibe side panel — manual test

How to exercise the side-panel vibe flow on this machine. The panel never talks
to the daemon directly: it speaks to the extension service worker over a
`chrome.runtime` port (`vibe-panel`), and the SW relays to the daemon's WS bridge.

## Prerequisites

- Daemon + bridge built and runnable via the CLI (`src/cli.ts`).
- The extension loaded in a Chrome that the daemon can reach on the bridge port
  (9410–9413). The repo's extension loader launches Chrome with the extension
  dev-loaded over the debugging pipe.

## Steps

1. **Start the daemon** (hosts the WS bridge + the vibe run service):

   ```powershell
   npx tsx src/cli.ts daemon
   ```

2. **Start the fixture with the bug on** (so the run produces a FAIL + fix prompt):

   ```powershell
   npx tsx src/cli.ts fixture --bug on
   ```

   This serves the demo app (default `http://localhost:9401/login`).

3. **Launch Chrome with the extension** loaded. Either use the repo's loader
   helper (`test/v1.load-extension.ts`-style: launches Chrome with
   `--remote-debugging-pipe --enable-unsafe-extension-debugging` and
   `Extensions.loadUnpacked` pointing at `extension/`), or load it manually:
   `chrome://extensions` → Developer mode → Load unpacked → select `extension/`.

4. **Open the side panel**: click the extension's toolbar icon (the SW calls
   `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`, so a
   single click on the action icon opens the panel).

## What you should see

- **Header status dot** turns **green** within ~3s when the SW's WebSocket to the
  daemon bridge is open (it polls `bridge-status` every 3s). Red/grey = daemon not
  reachable.
- **On-device AI line**: "ready" if Nano is available, otherwise "downloading" or
  "unavailable — testing still works via cloud free tier".
- **URL field** prefilled with `http://localhost:9401/login` (persisted to
  `chrome.storage.local` after the first run).

5. **Type the canned task** into "What should I test?", e.g.:

   ```
   Log in as test@test.com with password pw and complete checkout
   ```

   Click **Run test**.

## Expected result (bug on)

- The button flips to **Testing…** (disabled).
- The **live feed** streams timestamped progress lines as the agent drives the page.
- On completion a **result card** appears with a **❌ FAIL** badge, a plain-English
  report (preserving line breaks), and a **Fix prompt** section with a readonly
  textarea. **Copy** flips to **Copied ✓** for 2s.
- Run again with `fixture --bug off` for a **✅ PASS** card (no fix prompt).

## Error cases to sanity-check

- **Daemon not running**: with the daemon stopped, clicking Run shows the error
  banner **"daemon not running — start it with: spike daemon"** (the SW rejects
  `vibe.run` because its WebSocket is closed).
- **Run already in progress**: a second Run while one is active surfaces the
  daemon's "a run is already in progress" error in the banner.
- **Reopening the panel mid-run**: the panel asks `status` on open; if the daemon
  reports `busy`, the feed shows "(a test is already running — showing live
  progress)" and continues streaming.
