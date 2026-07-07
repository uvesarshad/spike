/* V29 verification -
 *  1. default telemetry tracer is no-op and preserves behavior.
 *  2. mock exporter receives spans with headers/secrets redacted.
 *  3. OpenAI-compatible gateway helpers normalize provider/gateway base URLs. */

import assert from 'node:assert/strict';
import { createTelemetryTracer, redactString, redactValue, type TelemetryExporter, type TelemetrySpan } from '../src/telemetry/index.js';
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
