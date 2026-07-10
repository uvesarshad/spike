/* Optional OTLP/HTTP (JSON) span exporter — the ONLY way a span ever leaves
 * this machine, and only when the caller explicitly configures it (opt-in;
 * see src/telemetry/env.ts). Generic by design so one class serves any OTLP
 * HTTP receiver: a local Grafana Alloy/Tempo collector, a hosted Grafana Cloud
 * Tempo endpoint, or Axiom's OTLP ingest endpoint — the only difference
 * between targets is the URL + headers (auth token, dataset header), both
 * caller-supplied. See docs/modules/telemetry.md for exact per-target setup. */

import { createHash, randomBytes } from 'node:crypto';
import type { TelemetryExporter, TelemetrySpan } from './tracer.js';

export interface OtlpHttpExporterOptions {
  /** Full OTLP/HTTP traces endpoint, e.g. http://localhost:4318/v1/traces
   * (local Tempo/Alloy) or https://api.axiom.co/v1/traces (Axiom). */
  endpoint: string;
  /** Extra headers merged onto the POST (auth bearer token, dataset header, …). */
  headers?: Record<string, string>;
  /** OTLP resource `service.name` attribute. Default 'browser-qa-subagent'. */
  serviceName?: string;
  /** Best-effort fetch timeout in ms. export() NEVER throws — a broken/absent
   * collector must never affect a QA run. Default 5000. */
  timeoutMs?: number;
}

/**
 * Exports each span as its own OTLP trace by default (traceId derived from a
 * random 16 bytes) EXCEPT when the span carries a `runId` attribute (engine.ts
 * sets one on every run/replay span) — then traceId is a stable hash of that
 * runId, so every span from the same QA run groups into one trace/waterfall in
 * the collector's UI. This is a deliberate simplification, not full
 * OpenTelemetry context propagation (no parent/child span linking) — see
 * docs/modules/telemetry.md.
 */
export class OtlpHttpExporter implements TelemetryExporter {
  private readonly endpoint: string;
  private readonly headers: Record<string, string>;
  private readonly resourceAttrs: OtlpAttr[];
  private readonly timeoutMs: number;
  private warned = false;

  constructor(opts: OtlpHttpExporterOptions) {
    this.endpoint = opts.endpoint;
    this.headers = { 'content-type': 'application/json', ...(opts.headers ?? {}) };
    this.resourceAttrs = [{ key: 'service.name', value: { stringValue: opts.serviceName ?? 'browser-qa-subagent' } }];
    this.timeoutMs = opts.timeoutMs ?? 5_000;
  }

  async export(span: TelemetrySpan): Promise<void> {
    let body: string;
    try {
      body = JSON.stringify(toOtlpPayload(span, this.resourceAttrs));
    } catch {
      return; // unserializable attribute (shouldn't happen post-redaction) — drop, never throw
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.endpoint, { method: 'POST', headers: this.headers, body, signal: controller.signal });
      if (!res.ok) this.warnOnce(`OTLP export to ${this.endpoint} returned HTTP ${res.status}`);
    } catch (e) {
      this.warnOnce(`OTLP export to ${this.endpoint} failed (${e instanceof Error ? e.message : String(e)})`);
    } finally {
      clearTimeout(timer);
    }
  }

  private warnOnce(message: string): void {
    if (this.warned) return;
    this.warned = true;
    console.error(`telemetry: ${message} — further export failures are silenced for this process (spans are best-effort).`);
  }
}

interface OtlpAttr {
  key: string;
  value: { stringValue: string };
}

function attrsToOtlp(attrs: Record<string, unknown>): OtlpAttr[] {
  return Object.entries(attrs).map(([key, value]) => ({
    key,
    value: { stringValue: typeof value === 'string' ? value : safeStringify(value) },
  }));
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function traceIdFor(span: TelemetrySpan): string {
  const runId = typeof span.attributes.runId === 'string' ? span.attributes.runId : undefined;
  if (runId) return createHash('sha256').update(runId).digest('hex').slice(0, 32);
  return randomBytes(16).toString('hex');
}

function nanos(iso: string): string {
  return String(Date.parse(iso) * 1_000_000);
}

function toOtlpPayload(span: TelemetrySpan, resourceAttrs: OtlpAttr[]): unknown {
  return {
    resourceSpans: [
      {
        resource: { attributes: resourceAttrs },
        scopeSpans: [
          {
            scope: { name: 'browser-qa-subagent' },
            spans: [
              {
                traceId: traceIdFor(span),
                spanId: randomBytes(8).toString('hex'),
                name: span.name,
                kind: 1, // SPAN_KIND_INTERNAL
                startTimeUnixNano: nanos(span.startTime),
                endTimeUnixNano: nanos(span.endTime),
                attributes: attrsToOtlp(span.attributes),
                events: span.events.map((e) => ({
                  name: e.name,
                  timeUnixNano: nanos(e.time),
                  attributes: attrsToOtlp(e.attributes),
                })),
                status: { code: span.status === 'ok' ? 1 : 2, message: span.error },
              },
            ],
          },
        ],
      },
    ],
  };
}
