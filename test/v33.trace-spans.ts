/* v33 — per-adapter / per-action telemetry spans (follow-up to Phase 11).
 * Proves the ModelRouter emits a redacted `model.call` span per adapter
 * invocation (including down-ladder fallback), through the SAME always-on
 * tracer + no-op-default machinery v29 covers. The driver's `browser.action`
 * span uses the identical getDefaultTracer().startSpan path with non-secret
 * attributes, so it inherits the same redaction guarantee. */

import { createTelemetryTracer, type TelemetrySpan } from '../src/telemetry/tracer.js';
import { setDefaultTracerForTest, resetDefaultTracer } from '../src/telemetry/env.js';
import { ModelRouter } from '../src/router/model-router.js';
import type { Capability, JsonRequest, ModelAdapter } from '../src/router/adapter.js';

let pass = 0,
  fail = 0;
const check = (label: string, ok: boolean) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  ok ? pass++ : fail++;
};

// mock exporter that captures every span handed to the tracer. Register a
// known secret value (what the daemon passes from the Vault) so we can prove it
// is scrubbed from a span even when an adapter error echoes it.
const KNOWN_SECRET = 'vault-token-abc123-XYZ';
const captured: TelemetrySpan[] = [];
setDefaultTracerForTest(
  createTelemetryTracer({ exporter: { export: (s) => void captured.push(s) }, redaction: { secretValues: [KNOWN_SECRET] } }),
);

class MockAdapter implements ModelAdapter {
  constructor(
    readonly name: string,
    readonly rung: 0 | 1 | 2 | 3,
    private readonly caps: Capability[],
    private readonly behavior: 'ok' | 'throw',
  ) {}
  async available(): Promise<boolean> {
    return true;
  }
  supports(cap: Capability): boolean {
    return this.caps.includes(cap);
  }
  async generateJson(_req: JsonRequest): Promise<unknown> {
    if (this.behavior === 'throw') throw new Error(`upstream 401 — key ${KNOWN_SECRET} rejected`);
    return { verdict: 'pass', summary: 'looks good', issues: [] };
  }
}

// ---- 1. plan-step: one model.call span, correct attrs, success status ----
{
  captured.length = 0;
  const router = new ModelRouter([new MockAdapter('mock-nav', 2, ['plan-step', 'plan-goals'], 'ok')]);
  await router.planJson('drive the page — {{secret:TOKEN}} must not leak', {}, 3);
  const spans = captured.filter((s) => s.name === 'model.call');
  check('planJson emits exactly one model.call span', spans.length === 1);
  check('span carries capability=plan-step', spans[0]?.attributes.capability === 'plan-step');
  check('span carries adapter name + rung', spans[0]?.attributes.adapter === 'mock-nav' && spans[0]?.attributes.rung === 2);
  check('span carries step', spans[0]?.attributes.step === 3);
  check('successful span status is ok', spans[0]?.status === 'ok');
  check('span has a non-negative duration', typeof spans[0]?.durationMs === 'number' && spans[0].durationMs >= 0);
  check(
    'span attributes never include the prompt / secret placeholder',
    !JSON.stringify(spans[0]?.attributes).includes('secret') && !JSON.stringify(spans[0]?.attributes).includes('drive the page'),
  );
}

// ---- 2. down-ladder fallback: a span per attempt (failed + then ok) ----
{
  captured.length = 0;
  // planning tries rung 2 before rung 1 (planRank), so the rung-2 adapter is
  // the FIRST attempt — make it throw and the rung-1 adapter succeed.
  const router = new ModelRouter([
    new MockAdapter('mock-a', 2, ['plan-step'], 'throw'),
    new MockAdapter('mock-b', 1, ['plan-step'], 'ok'),
  ]);
  await router.planJson('prompt', {}, 0);
  const spans = captured.filter((s) => s.name === 'model.call');
  check('fallback produces one span per attempt (2)', spans.length === 2);
  check('first attempt span status is error', spans[0]?.status === 'error');
  check('second attempt span status is ok', spans[1]?.status === 'ok');
  check(
    'errored span scrubs the known Vault secret from the error text',
    spans[0]?.status === 'error' && !JSON.stringify(spans[0]).includes(KNOWN_SECRET),
  );
}

// ---- 3. visual-verdict path is instrumented too ----
{
  captured.length = 0;
  const router = new ModelRouter([new MockAdapter('mock-vis', 0, ['visual-verdict'], 'ok')]);
  await router.visualVerdict(Buffer.from('fake-png'), 'the page looks right', 5);
  const spans = captured.filter((s) => s.name === 'model.call' && s.attributes.capability === 'visual-verdict');
  check('visualVerdict emits a model.call span', spans.length === 1);
  check('visual span never carries the image bytes', !JSON.stringify(spans[0]?.attributes).includes('fake-png'));
}

resetDefaultTracer();
console.log(`\n${pass}/${pass + fail} v33 trace-span checks passed`);
process.exit(fail ? 1 : 0);
