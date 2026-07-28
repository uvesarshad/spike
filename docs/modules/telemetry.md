# Module: Telemetry

> Scope: Structured tracing (`src/telemetry/*`), the always-on no-op default, the optional OTLP exporter, and the `spike dashboard` CLI command.
> Rendering context: Server-side (Node.js daemon / CLI)
> Project tier: 3
> Last updated: 2026-07-09

## Overview

`src/telemetry/*` is a small structured-tracing layer: spans with attributes and events, redacted before they ever leave the process. As of Phase 11, tracing is ALWAYS ON structurally — every wrapped call constructs a real span (sanitized attributes, start/end timestamps, events) — but the default sink discards it. Nothing is exported anywhere unless the operator opts in with `QA_TELEMETRY_EXPORTER=otlp`. Zero config means zero external calls, byte-for-byte the same behavior as before Phase 11.

AGENT OWNER: src/telemetry/*, wiring in src/engine.ts

## Files

- `src/telemetry/tracer.ts` — `TelemetryTracer`/`ActiveSpan`/`TelemetryExporter` types, `createTelemetryTracer()`, `NoopTelemetryExporter` (+ its shared `defaultNoopExporter` singleton), `NoopTelemetryTracer` (a true bypass, not the default).
- `src/telemetry/redaction.ts` — `redactValue`/`redactString`, sensitive-key detection, `{{secret:NAME}}` placeholder scrubbing, size/depth caps.
- `src/telemetry/otlp-exporter.ts` — `OtlpHttpExporter`, a generic OTLP/HTTP (JSON) exporter.
- `src/telemetry/env.ts` — `getDefaultTracer()` / `resetDefaultTracer()`, the process-wide tracer built from env vars.

## Always-on spans (Phase 11)

`createTelemetryTracer(opts)` used to short-circuit to a true no-op (`NoopTelemetryTracer`) whenever no exporter was configured — `trace()` just called the function, nothing was constructed. It now always builds a real `ExportingTelemetryTracer`, defaulting `opts.exporter` to `defaultNoopExporter` (a shared `NoopTelemetryExporter` instance). Spans are fully constructed — attributes sanitized through the redaction pipeline, start/end timestamps recorded, events captured — and handed to that sink, which discards them (`export()` is a no-op beyond an internal counter used only by tests to prove spans are actually reaching a sink). Net effect: `trace()`/`startSpan()` callers see identical return values, identical thrown errors, and zero network calls by default — the only change is a small amount of always-paid local object construction.

`NoopTelemetryTracer` still exists for call sites that want a true zero-construction bypass; it is no longer what `createTelemetryTracer()` returns by default.

## Boundaries wrapped

Within the files this module owns (`src/engine.ts` — the shared core both the CLI and MCP server call into):

- `qa.run` — one span per `qaRun()` call. Events: `replay.match` (Phase 14 matcher outcome), `replay.used` / `replay.fallback` (matched-replay path), `session.opened` (navigator/brain pins, transport), `driver.loop.completed`, `script.recorded`.
- `qa.run.driver_loop` — wraps the `runDriverLoop()` call itself (attributes: runId/task/url) so the AI-driven exploration phase has its own latency/outcome span.
- `qa.replay` — one span per `qaReplay()` call. Events: `heal.start` when `--heal` re-engages the driver after a failed replay.
- `model.call` — one span per adapter INVOCATION (in `src/router/model-router.ts`), including every down-ladder fallback attempt. Attributes: `capability` (`visual-verdict`/`plan-step`/`plan-goals`), `adapter` name, `rung`, `step`. Accurate wall-clock duration; `error` status on a failed attempt (the router then falls to the next rung). Non-secret attributes only — never the prompt, image bytes, or resolved secrets. Complements `report.model_trace` (the in-report per-call cost record).
- `browser.action` — one span per executed driver action (in `src/driver/loop.ts`). Attributes: `type` (click/type/navigate/upload_file/…), `step`, and `kind` for `mouse`. `error` status when the step records a failure. Non-secret attributes only (never type text, full urls, or targets).

Together these give a full `qa.run → qa.run.driver_loop → browser.action` / `model.call` tree in a tracing backend. Action-cache hits/misses remain in `report.json` (and the `spike dashboard`), not spans. A test hook, `setDefaultTracerForTest()` in `telemetry/env.ts`, lets tests pin a mock-exporter tracer to observe these spans (see `test/v33.trace-spans.ts`).

## Redaction guarantees

Every span attribute and event attribute passes through `redactValue()` before being handed to any exporter (including the no-op one):

- Known secret values (`redaction.secretValues`) are replaced wherever they appear in strings, even mid-sentence.
- `{{secret:NAME}}` placeholders have their NAME hidden too (`{{secret:[redacted]}}`) by default — telemetry is stricter than `report.json`, which keeps placeholder names for replay/debugging.
- Keys matching common secret-ish names (`password`, `token`, `authorization`, `cookie`, `api-key`, …) are redacted regardless of value.
- `Bearer`/`Basic` auth headers and common API-key shapes (`sk-...`, `sk-ant-...`, `ghp_...`) are stripped by pattern.
- `Buffer` values (the only way a screenshot/clip could ever end up in an attribute) collapse to a `[buffer:N bytes]` marker — raw image/video bytes never serialize into a span. Screenshots and clips are file paths in `report.json`, not span attributes, by construction; nothing in engine.ts ever attaches image/video buffers to a span.
- Very long strings are truncated (`maxStringLength`, default 4000 chars in `tracer.ts`, 2000 when exporting via `getDefaultTracer()`'s OTLP path).

## Optional OTLP export

Off by default. Enable with:

```
QA_TELEMETRY_EXPORTER=otlp
QA_OTLP_ENDPOINT=http://localhost:4318/v1/traces
```

`OtlpHttpExporter` POSTs each span as an OTLP/HTTP (JSON) `resourceSpans` payload via `fetch`. It never throws — a broken or absent collector logs one `console.error` and is silently skipped afterward for the rest of the process; a QA run's outcome is never affected by telemetry export failing. Each span carries a fresh random 16-byte trace id UNLESS its `runId` attribute is set (every `qa.run`/`qa.replay`/`qa.run.driver_loop` span sets one once known), in which case the trace id is a stable hash of that `runId` — so every span belonging to the same QA run groups into one trace/waterfall in the collector's UI. This is a deliberate simplification (no real parent/child span linking, no OpenTelemetry SDK dependency) — good enough for "show me this run's shape," not a full distributed-tracing implementation.

### Grafana Tempo / Grafana Alloy (local or self-hosted)

```
QA_TELEMETRY_EXPORTER=otlp
QA_OTLP_ENDPOINT=http://localhost:4318/v1/traces
```

No auth needed for a local collector. For Grafana Cloud Tempo, use the tenant's OTLP gateway URL and add the basic-auth header:

```
QA_OTLP_ENDPOINT=https://tempo-xxx.grafana.net/tempo/api/push
QA_OTLP_HEADERS={"Authorization":"Basic <base64 instanceId:apiKey>"}
```

### Axiom

```
QA_TELEMETRY_EXPORTER=otlp
QA_OTLP_ENDPOINT=https://api.axiom.co/v1/traces
QA_OTLP_HEADERS={"Authorization":"Bearer <axiom-api-token>","X-Axiom-Dataset":"<dataset-name>"}
```

`QA_OTLP_HEADERS` is a JSON object string merged onto every export POST — invalid JSON logs a warning and exports without extra headers rather than throwing. `QA_OTLP_SERVICE_NAME` overrides the `service.name` resource attribute (default `spike-agent`).

## `spike dashboard`

`spike dashboard [--port <n>]` (`src/cli.ts`) serves a read-only, localhost-only HTML view over `artifacts/<runId>/report.json` files — no database, no build step, no external calls, nothing written to disk. Default port 9420 (or `QA_DASHBOARD_PORT`).

- `/` — every run under `cfg.artifactsDir`, newest first: verdict, task, url, step count, duration, and source (fresh AI run / matched $0 replay with its score / self-heal outcome), plus action-cache hit ratio when enabled.
- `/run/<runId>` — one run's full detail: token accounting (`report.tokens` — navigator/brain/visual call counts, cheap-model total), `model_trace`, `assertion_trace` when present, per-step outcomes, and the failure reason.

It reads `report.json` files already written by `qaRun()`/`qaReplay()` — it does not read telemetry spans (those are for external collectors, not this local view) and it never mutates `artifacts/`.

## Update Triggers

- When a new boundary in `src/engine.ts` gets a span (update the "Boundaries wrapped" list above).
- When telemetry env var names or defaults change.
- When the OTLP payload shape or trace-id derivation changes.
- When `spike dashboard`'s routes or the fields it reads from `report.json` change.

## Related Docs

- docs/architecture/data-flow.md - where `qa.run`/`qa.replay`/`qa.run.driver_loop` sit in the run lifecycle
- docs/infra/environment.md - `QA_TELEMETRY_EXPORTER`, `QA_OTLP_*`, `QA_DASHBOARD_PORT`
- docs/modules/recorder.md - the Phase 14 replay matcher whose match/fallback events this module's `qa.run` span records
