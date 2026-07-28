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

/** Test-only hook: pin the process-wide tracer to a specific instance (e.g. one
 * wired to a mock exporter) so a test can observe the `model.call` /
 * `browser.action` spans the router and driver emit. Pass a tracer to set it,
 * or call `resetDefaultTracer()` afterwards to return to env-driven behaviour.
 * Never used by product code. */
export function setDefaultTracerForTest(tracer: TelemetryTracer): void {
  cached = tracer;
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
    serviceName: process.env.QA_OTLP_SERVICE_NAME || 'spike-agent',
  });
  // Known BYOK key env vars — scrubbed wherever they appear in span text (e.g. a
  // key that leaked into an adapter error message or a query string), same as
  // engine.ts's own precedence order for these vars.
  const secretValues = [
    process.env.GEMINI_API_KEY,
    process.env.ANTHROPIC_API_KEY,
    process.env.OPENAI_API_KEY,
    process.env.OPENROUTER_API_KEY,
    process.env.GLM_API_KEY,
    process.env.ZAI_API_KEY,
  ].filter((v): v is string => Boolean(v));
  // maxStringLength kept modest — traces are for debugging/latency/cost shape,
  // not for re-reading full prompts/responses; full detail still lives in
  // report.json (never exported here).
  return createTelemetryTracer({ exporter, redaction: { maxStringLength: 2_000, secretValues } });
}
