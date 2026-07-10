/* Process-wide default tracer, configured from the environment. `getDefaultTracer()`
 * is what engine.ts (and anything else in the daemon) should call — it stays
 * the zero-config no-op sink unless the operator explicitly opts into export
 * via QA_TELEMETRY_EXPORTER=otlp. See docs/modules/telemetry.md. */

import { createTelemetryTracer, type TelemetryTracer } from './tracer.js';
import { OtlpHttpExporter } from './otlp-exporter.js';

let cached: TelemetryTracer | undefined;

/** Memoized: env vars are read once per process. Tests that need to flip
 * QA_TELEMETRY_EXPORTER mid-run should call `resetDefaultTracer()` first. */
export function getDefaultTracer(): TelemetryTracer {
  if (!cached) cached = buildTracerFromEnv();
  return cached;
}

/** Test-only hook: forces the next `getDefaultTracer()` call to rebuild from
 * the current environment instead of returning the memoized instance. */
export function resetDefaultTracer(): void {
  cached = undefined;
}

function buildTracerFromEnv(): TelemetryTracer {
  const mode = (process.env.QA_TELEMETRY_EXPORTER ?? 'none').toLowerCase();
  if (mode !== 'otlp') return createTelemetryTracer(); // no-op sink; spans still always constructed

  const endpoint = process.env.QA_OTLP_ENDPOINT;
  if (!endpoint) {
    console.error(
      'telemetry: QA_TELEMETRY_EXPORTER=otlp is set but QA_OTLP_ENDPOINT is missing — ' +
        'falling back to the no-op sink (zero external calls).',
    );
    return createTelemetryTracer();
  }

  let headers: Record<string, string> = {};
  if (process.env.QA_OTLP_HEADERS) {
    try {
      headers = JSON.parse(process.env.QA_OTLP_HEADERS);
    } catch {
      console.error('telemetry: QA_OTLP_HEADERS is not valid JSON — exporting without extra headers.');
    }
  }

  const exporter = new OtlpHttpExporter({
    endpoint,
    headers,
    serviceName: process.env.QA_OTLP_SERVICE_NAME || 'browser-qa-subagent',
  });
  // maxStringLength kept modest — traces are for debugging/latency/cost shape,
  // not for re-reading full prompts/responses; full detail still lives in
  // report.json (never exported here).
  return createTelemetryTracer({ exporter, redaction: { maxStringLength: 2_000 } });
}
