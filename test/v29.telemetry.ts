/* V29 verification -
 *  1. default telemetry tracer is no-op and preserves behavior.
 *  2. mock exporter receives spans with headers/secrets redacted.
 *  3. OpenAI-compatible gateway helpers normalize provider/gateway base URLs. */

import assert from 'node:assert/strict';
import {
  createTelemetryTracer,
  defaultNoopExporter,
  getDefaultTracer,
  resetDefaultTracer,
  redactString,
  redactValue,
  OtlpHttpExporter,
  type TelemetryExporter,
  type TelemetrySpan,
} from '../src/telemetry/index.js';
import { gatewayBaseUrlEnv, normalizeOpenAiBaseUrl, openAiGatewayOptions } from '../src/router/gateway.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

class MockExporter implements TelemetryExporter {
  spans: TelemetrySpan[] = [];
  export(span: TelemetrySpan): void {
    this.spans.push(span);
  }
}

/* ---------- no-op default ---------- */

{
  const tracer = createTelemetryTracer();
  const result = await tracer.trace('adapter.generateJson', { authorization: 'Bearer sk-live-secret' }, async () => 42);
  check('default tracer preserves async result', result === 42);

  let message = '';
  try {
    await tracer.trace('adapter.generateJson', {}, async () => {
      throw new Error('boom');
    });
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }
  check('default tracer rethrows errors unchanged', message === 'boom');
}

/* ---------- redaction helpers ---------- */

{
  const redacted = redactString('Authorization: Bearer sk-live-abcdef123456 and {{secret:LOGIN_PW}}', {
    secretValues: ['abcdef123456'],
  });
  check('redactString removes bearer token and secret placeholder name', !redacted.includes('sk-live') && !redacted.includes('LOGIN_PW'));

  const obj = redactValue({
    ok: 'visible',
    nested: {
      password: 'hunter2',
      prompt: 'type hunter2 into the password box',
    },
  }, { secretValues: ['hunter2'] }) as { ok: string; nested: { password: string; prompt: string } };
  check('redactValue redacts sensitive keys', obj.nested.password === '[redacted]');
  check('redactValue redacts known secret values in non-sensitive strings', obj.nested.prompt === 'type [redacted] into the password box');
}

/* ---------- mock exporter ---------- */

{
  const exporter = new MockExporter();
  const tracer = createTelemetryTracer({
    exporter,
    redaction: { secretValues: ['real-secret-value'] },
  });
  const span = tracer.startSpan('router.adapter.call', {
    adapter: 'gpt(gpt-4o-mini)',
    authorization: 'Bearer sk-test-1234567890',
    prompt: 'login with real-secret-value and {{secret:LOGIN_PW}}',
  });
  span.addEvent('http.request', {
    headers: {
      'content-type': 'application/json',
      'x-api-key': 'real-secret-value',
    },
  });
  span.setAttribute('password', 'real-secret-value');
  span.end({ response: { output: 'done with real-secret-value' } });

  assert.equal(exporter.spans.length, 1);
  const raw = JSON.stringify(exporter.spans[0]);
  check('mock exporter receives one completed span', exporter.spans[0].status === 'ok');
  check('exported span has no raw API key or known secret', !raw.includes('sk-test') && !raw.includes('real-secret-value'));
  check('exported span hides secret placeholder names', !raw.includes('LOGIN_PW'));
  check('exported span keeps non-sensitive attributes', raw.includes('gpt(gpt-4o-mini)'));
  check('setAttribute redacts by sensitive key name', exporter.spans[0].attributes.password === '[redacted]');
}

/* ---------- Phase 11: spans always constructed with the default no-op sink ---------- */

{
  const before = defaultNoopExporter.exportCount;
  const tracer = createTelemetryTracer(); // no exporter passed — default sink
  const result = await tracer.trace('driver.step', { goal: 'add the Widget to the cart' }, async () => 'ok');
  check('default (no-exporter) tracer still returns the wrapped function result', result === 'ok');
  check(
    'default sink received the span — spans are always constructed, not skipped (Phase 11)',
    defaultNoopExporter.exportCount === before + 1,
  );

  const span = tracer.startSpan('adapter.call', { adapter: 'nano' });
  span.addEvent('retry', { attempt: 1 });
  span.end({ ok: true });
  check('manually-managed spans (startSpan/end) also always reach the default sink', defaultNoopExporter.exportCount === before + 2);
}

/* ---------- Phase 11: getDefaultTracer() is env-driven and memoized ---------- */

{
  delete process.env.SPIKE_TELEMETRY_EXPORTER;
  resetDefaultTracer();
  const before = defaultNoopExporter.exportCount;
  await getDefaultTracer().trace('qa.run', {}, async () => 1);
  check('getDefaultTracer() defaults to the no-op sink with zero external calls', defaultNoopExporter.exportCount === before + 1);
  check('getDefaultTracer() is memoized across calls', getDefaultTracer() === getDefaultTracer());
}

/* ---------- Phase 11: OTLP exporter — well-formed payload, no secrets, no screenshots ---------- */

{
  const calls: { url: string; init: { method?: string; headers?: Record<string, string>; body?: string } }[] = [];
  const realFetch = globalThis.fetch;
  // @ts-expect-error test stub — only the shape export() actually reads
  globalThis.fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, init: init as { method?: string; headers?: Record<string, string>; body?: string } });
    return { ok: true, status: 200 } as Response;
  };
  try {
    const exporter = new OtlpHttpExporter({ endpoint: 'http://localhost:4318/v1/traces', serviceName: 'test-svc' });
    const tracer = createTelemetryTracer({ exporter, redaction: { secretValues: ['s3cr3t-token'] } });
    const span = tracer.startSpan('adapter.call', {
      runId: 'run-123',
      screenshot: Buffer.from('not-really-a-png'),
      authorization: 'Bearer s3cr3t-token',
    });
    span.end({ prompt: 'type s3cr3t-token into the field, then {{secret:LOGIN_PW}}' });
    await new Promise((r) => setTimeout(r, 20)); // export() fires from finish() without being awaited

    check('OTLP exporter POSTs to the configured endpoint', calls.length === 1 && calls[0].url === 'http://localhost:4318/v1/traces');
    const body = calls[0].init.body ?? '';
    check('OTLP payload carries no raw secret value', !body.includes('s3cr3t-token'));
    check('OTLP payload carries no secret placeholder name', !body.includes('LOGIN_PW'));
    check('OTLP payload never carries raw screenshot bytes (Buffer collapses to a length marker)', !body.includes('not-really-a-png'));
    const payload = JSON.parse(body);
    const otlpSpan = payload.resourceSpans[0].scopeSpans[0].spans[0];
    check('OTLP payload is well-formed (resourceSpans/scopeSpans/spans)', otlpSpan.name === 'adapter.call');
    check('OTLP traceId is derived from runId (32 hex chars, deterministic)', /^[0-9a-f]{32}$/.test(otlpSpan.traceId));

    // same runId -> same traceId (Tempo/Grafana waterfall groups all spans of one QA run)
    const span2 = tracer.startSpan('adapter.call.second', { runId: 'run-123' });
    span2.end();
    await new Promise((r) => setTimeout(r, 20));
    const payload2 = JSON.parse(calls[1].init.body ?? '{}');
    check('two spans sharing runId share the same OTLP traceId', payload2.resourceSpans[0].scopeSpans[0].spans[0].traceId === otlpSpan.traceId);
  } finally {
    globalThis.fetch = realFetch;
  }
}

/* ---------- gateway helpers ---------- */

{
  check('gpt gateway env name is OPENAI_BASE_URL', gatewayBaseUrlEnv('gpt') === 'OPENAI_BASE_URL');
  check(
    'normalizeOpenAiBaseUrl strips /chat/completions suffix',
    normalizeOpenAiBaseUrl('https://gateway.example/v1/chat/completions/') === 'https://gateway.example/v1',
  );
  const opts = openAiGatewayOptions({
    label: 'gpt',
    apiKey: 'key',
    model: 'gpt-4o-mini',
    defaultBaseUrl: 'https://api.openai.com/v1',
  }, {
    OPENAI_BASE_URL: 'https://gateway.example/openai/v1/chat/completions',
  });
  check('openAiGatewayOptions applies normalized env override', opts.baseUrl === 'https://gateway.example/openai/v1');
}

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
