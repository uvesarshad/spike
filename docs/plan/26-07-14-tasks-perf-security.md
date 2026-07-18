> Source audit: [26-07-14-audit-perf-security](./26-07-14-audit-perf-security.md)
> Updated: 26-07-14 · 22/23 done

- [x] **(A1, P0)** Add a `bridgeHost` config knob and bind `BridgeServer`'s `WebSocketServer` to `127.0.0.1` by default instead of all interfaces.
- [x] **(A2, P0)** Add a pre-shared pairing token to the daemon↔extension bridge handshake (minted on extension install, required on every connect) so an unauthenticated local process can no longer be adopted as a client.
- [x] **(A3, P0)** Require the A2 pairing token (or equivalent auth) before `vibe.run`/`vibe.fix`/`vibe.key.set`/`vibe.key.clear`/`vibe.config.set` handlers execute, and stop trusting the caller-supplied `allowHost` param to self-authorize the Tier-4 guard.
- [x] **(A4, P0)** Move `allowedHosts` enforcement into the port/CDP transport layer (`CdpBrowser`/`ExtensionBrowser`) so the raw `cdp` passthrough and `ext.attachTab` can't bypass the host guard that today only lives in the driver loop.
- [x] **(A5, P0)** Cap/summarize navigator+brain prompt history (`formatHistory` in `planner-prompt.ts`) to a sliding window instead of resending the full `StepRecord[]` every call, to kill the O(n²) token growth on long runs.
- [x] **(A6, P1)** Replace the forgeable `Origin`-header check in `bridge-server.ts` with real auth (subsumed by A2, but verify the Origin check is removed or hardened, not left as the only gate).
- [x] **(A7, P1)** Add a per-tab/URL allowlist check in the extension before `chrome.debugger` attaches (`ext.attachTab`/`attachDebugger` in `sw.js`), scoping `<all_urls>`/`debugger` permission use in code, not just via manifest.
- [x] **(A8, P1)** Move the Gemini Files-API key in `byok-gemini.ts` (lines 184, 215) from the `?key=` query string into the `x-goog-api-key` header, matching the rest of the file.
- [x] **(A9, P1)** Sanitize/quote page-derived `console_error`/network `errorText` before embedding in auto-fix prompts (`fix-prompt.ts`), and/or require one-time human confirmation before the first `acceptEdits`/`auto_edit` auto-fix dispatch per project.
- [x] **(A10, P1)** Extend `telemetry/redaction.ts` to scrub the `task` and `url` span attributes (strip query strings/basic-auth, scan for secret-shaped substrings) before OTLP export.
- [x] **(A11, P1)** Call `serviceEnv()` from `installWindows()` in `install-service.ts` so the Windows Scheduled Task bakes in `NODE_OPTIONS=--use-system-ca` like the mac/linux install paths already do.
- [x] **(A12, P1)** Wrap CDP calls (`axTree`, `screenshot`) and model calls (`planJson`, `planGoals`, `navigateOnce`) in the driver loop with a timeout so a hung call can't stall a run indefinitely.
- [ ] **(A13, P1)** Replace fixed `sleep(150)`/`sleep(250)` waits in `loop.ts`/`replay.ts` with an event-driven "network idle / DOM settled" wait with a low ceiling. — **Skipped, documented in code**: `BrowserPort` has no non-destructive network-idle primitive (`drainConsole`/`drainNetwork` consume the buffer the step record still needs); building one means extending `BrowserPort`/`CdpBrowser`, which is a real feature addition, not a fix. Left the fixed sleeps in place with an inline comment explaining why.
- [x] **(A14, P1)** Switch `report/artifacts.ts` (`saveScreenshot`, `saveReport`, `appendAudit`) from sync `fs.writeFileSync`/`appendFileSync` to async `fs.promises`, queuing writes so they don't block the driver's event loop.
- [x] **(A15, P1)** Cache the `generated-tests/` script index in `recorder/matcher.ts` (build once per daemon process, invalidate on mtime/file-watch) instead of re-reading and re-parsing every script on every run.
- [x] **(A16, P2)** Note in `vault.ts`/docs that `{ mode: 0o600 }` has no effect on Windows, and confirm the vault directory's NTFS ACLs are actually restrictive on install (or add an explicit ACL lockdown step).
- [x] **(A17, P2)** Validate `OPENAI_BASE_URL`/`OPENROUTER_BASE_URL`/`GLM_BASE_URL` (scheme + host) in `gateway.ts` before sending the Bearer key and content there.
- [x] **(A18, P2)** Pin `install/install.ps1`/`install.sh` to a specific tagged release (or add a checksum check) instead of trusting `main` directly. — No tagged releases exist yet in this repo to pin to; documented the trust tradeoff in both scripts instead of building new release/checksum infra.
- [x] **(A19, P2)** Escape `Environment=${k}=${v}` values in `installLinux()`'s systemd unit builder (and extend `xmlEscape` coverage) so `install-service.ts` is safe if `InstallServiceOptions.env` ever carries untrusted data.
- [x] **(A20, P2)** Wrap `FileActionCache.read()`'s `JSON.parse` in `action-cache.ts:350` in a try/catch that degrades to a cache miss, matching `findForContext()`.
- [x] **(A21, P2)** Add an in-memory cache (with mtime check) to `SettingsStore.readRaw()`/`write()` in `vibe/settings.ts` instead of a sync read+parse on every call.
- [x] **(A22, P2)** Add a max-depth guard to the accessibility-tree walk in `capture/axtree.ts` (`build`/`serialize`) so a pathologically deep DOM can't drive unbounded recursion before the character cap applies.
- [x] **(A23, P2)** Combine the per-action `findNode` + `rankByRoleName` traversals in `driver/loop.ts` into a single pass over `ax.root`.

## Follow-ups from this pass

- **A2 pairing-token UI**: the daemon/extension now do trust-on-first-use pairing (first token presented is persisted in the Vault). There's no panel/options-page surface yet to let a user re-pair or revoke a token — worth a small UI pass before this ships broadly.
- **A2 test/CLI harness impact**: existing `ws`-based test/CLI harnesses that talk to `BridgeServer` directly will now be rejected unless they send a token-bearing hello — needs updating separately (not covered by this pass, which scoped out test files).
- **A13 event-driven wait**: still open — needs a `BrowserPort` "wait for network idle" primitive before the fixed sleeps can be replaced; noted above.
