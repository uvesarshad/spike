# Module: Action Cache

> Scope: File-backed verified step action cache helpers.
> Rendering context: Server-side (Node.js daemon)
> Project tier: 3
> Last updated: 2026-07-07

## Overview

`src/cache/action-cache.ts` defines the optional action-cache boundary for Phase 3. When cfg.actionCache is enabled, qaRun() creates a FileActionCache and runDriverLoop() uses it before navigator calls and after verified actions. The cache stores verified single actions as JSON files so future AI runs can reuse a locator/action when the URL, goal, action intent, and page signature still match.

AGENT OWNER: src/cache/action-cache.ts

## Persistence

`FileActionCache(rootDir)` writes records under `rootDir/v1/<hash-prefix>/<hash>.json`. The root defaults to `./.spike-action-cache` and is controlled by cfg.actionCacheDir / SPIKE_ACTION_CACHE_DIR. The cache is off by default; enable it with cfg.actionCache, SPIKE_ACTION_CACHE, or `spike run --action-cache`.

Record shape:
- `key`: versioned normalized URL, normalized goal, redacted action intent, page signature, and hash id.
- `value`: cacheable action payload, target locator, creation metadata, hit count, and last-hit timestamp.
- `metadata`: optional source run and step references.

AGENT NOTE: The cache is separate from `ArtifactStore` and generated replay scripts. It stores reusable action hints, not screenshots, reports, or full scripts.

## Keying

`buildActionCacheKey()` combines:
- normalized URL: lowercased protocol/host, normalized path, sorted non-tracking query params.
- normalized current goal: lowercased, whitespace-collapsed, redacted.
- action intent: action type plus target role/name/nth/qaId hash and redacted payload.
- page signature: SHA-256 over a stable accessibility-tree summary that ignores per-snapshot node IDs.

AGENT NOTE: Never key only on the user task text. The current goal and page signature are required to keep cached steps scoped to the actual page state.

## Values

`toCachedActionValue()` can represent cacheable actions: navigate, click, type, hover, press_key, select_option, reload, go_back, wait, assert_dom, and extract. runDriverLoop intentionally does not store or execute cached wait actions because a wait can verify without changing page state and would be unsafe to replay ahead of the Navigator.

Targeted actions store `StepRecord.target` as role/name/nth/qaId. They never store nodeId because node IDs are per snapshot. `actionFromCachedValue()` rehydrates a cached value to a current `Action` by resolving that target in the current `AxSnapshot`, optionally using `BrowserPort.findByQaId()`.

`finish` and `assert_visual` are not cached. Visual checks belong to the assertion path and screenshots are not stored in this cache.

## Redaction

The cache accepts `{{secret:NAME}}` placeholders for type actions but rejects raw secret-like material such as common API key/token formats and credential-looking type targets that do not use a placeholder.

AGENT NOTE: Driver integration must pass the original redacted `Action` to `toCachedActionValue()`, never the resolved action text after `resolveSecrets()`.

## Effect Verification

`captureActionEffectState(browser)` captures current URL plus a fresh accessibility snapshot/signature. `verifyActionEffect(before, after, action, target?)` accepts a cached action only when it observes a URL change, page-signature change, visible typed/selected value, satisfied DOM assertion, or elapsed wait.

On a stale hit, the driver should ignore or delete the record and fall back to the Navigator.

## Driver Integration

Before a Navigator call, runDriverLoop() searches FileActionCache for records matching current URL, current goal, and current page signature. The driver only tries a cache hit when that context has exactly one matching record; ambiguous contexts fall back to the Navigator. Rehydrated actions execute through BrowserPort only after their role/name/nth/qaId target resolves in the fresh accessibility tree. The driver captures before/after effect state and accepts the hit only when `verifyActionEffect().ok` is true; stale records are deleted and the loop falls back to the Navigator.

After a successful final action in a Navigator batch, the driver verifies the action effect and writes a record with the original redacted Action plus StepRecord.target. This preserves placeholders such as `{{secret:NAME}}` and avoids storing resolved secret text.

The full report includes `action_cache: { enabled, hits, misses, stale, stored }`. The slim five-field verdict and MCP response do not include cache metadata.

## Update Triggers

- When cache key parts or normalization rules change.
- When cacheable action types are added or removed.
- When redaction rules change.
- When driver integration adds config, report metadata, or CLI invalidation controls.

## Related Docs

- docs/architecture/data-flow.md - driver loop hook points
- docs/state/server-state.md - file-backed daemon state
- docs/infra/testing.md - v28 unit coverage and v31 driver integration coverage
