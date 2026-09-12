/* V96 — the reason translation layer (audit finding A14).
 *
 * When a run doesn't settle, the sentence the user reads used to be whatever
 * string the driver happened to set — written for whoever was debugging the
 * driver, and in several cases naming an environment variable or a config file
 * a person driving the browser panel cannot reach. A rejected AI key surfaced
 * as `anthropic api 401: {"type":"error",…}` and read like a bug report about
 * the user's own app.
 *
 * This suite pins the layer that fixes it:
 *
 *   1. COMPLETENESS — every reason string src/driver/loop.ts can produce is
 *      recognised by the table. This walks the real loop.ts, so adding a new
 *      `reason = …` without a rule fails here rather than shipping an
 *      untranslated string;
 *   2. every rule has a non-empty headline AND next step, and an attribution
 *      from the fixed set;
 *   3. provider HTTP failures map to key / rate-limit wording, both blamed on
 *      setup rather than on the user's app;
 *   4. the host block reads as a HOST block, not as look-only mode (they are
 *      different things — a host block fires with look-only off);
 *   5. the plain report actually uses the layer, and an unknown reason still
 *      comes through verbatim rather than being swallowed.
 *
 * Pure/in-memory: reads source files and calls pure functions. No Chrome, no
 * network, no API keys.
 *
 * Run: npx tsx test/v96.reason-text.ts
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REASON_RULES, explainReason, plainReasonText } from '../src/vibe/reason-text.js';
import { renderPlainReport } from '../src/vibe/fix-prompt.js';
import type { Report } from '../src/report/report.js';

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL  ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const REPO_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const loopSrc = fs.readFileSync(path.join(REPO_ROOT, 'src', 'driver', 'loop.ts'), 'utf8');

// ---- 1. completeness against the real driver -------------------------------
//
// Every `reason = <string literal or template>` in loop.ts, reduced to the
// literal head of the string (everything before the first interpolation), which
// is what a rule's RegExp has to recognise. Template continuations that begin
// with an interpolation carry no literal head and are skipped — they are the
// tails of multi-line concatenations whose head is already covered.

function reasonHeadsFromLoop(src: string): string[] {
  const heads: string[] = [];
  // `reason =` followed (possibly after a newline / a leading `+`) by a quote.
  const re = /\breason\s*=\s*\n?\s*(?:`([^`]*)`|'((?:[^'\\]|\\.)*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const raw = m[1] ?? m[2] ?? '';
    // literal head only — stop at the first ${…}
    const head = raw.split('${')[0].trim();
    if (head) heads.push(head);
  }
  return [...new Set(heads)];
}

const heads = reasonHeadsFromLoop(loopSrc);

check('the walker actually found the driver’s reason strings', () => {
  assert.ok(heads.length >= 8, `only found ${heads.length}: ${JSON.stringify(heads)}`);
});

for (const head of heads) {
  check(`the table recognises: "${head.slice(0, 64)}"`, () => {
    // Some reasons are only a prefix of the final string (a template whose
    // literal head is followed by an interpolation), so the match is done on
    // the head — which is exactly what the rules are written against.
    assert.ok(explainReason(head), 'no rule matched');
  });
}

// Reasons whose literal head lives outside loop.ts (the driver assigns them
// from another module's constant), checked explicitly.
for (const [label, reason] of [
  ["the sign-in popup wall", "Sign-in popups aren't supported yet — log in on this tab first, then run again"],
  ['a bare cancellation', 'cancelled by user'],
] as const) {
  check(`the table recognises ${label}`, () => {
    assert.ok(explainReason(reason), 'no rule matched');
  });
}

// ---- 2. every rule is actually usable --------------------------------------

check('every rule has a non-empty headline and next step', () => {
  for (const r of REASON_RULES) {
    assert.ok(r.id.trim(), 'empty id');
    assert.ok(r.headline.trim(), `${r.id}: empty headline`);
    assert.ok(r.nextStep.trim(), `${r.id}: empty next step`);
  }
});

check('every rule carries one of the three attributions', () => {
  for (const r of REASON_RULES) {
    assert.ok(['your app', 'the test', 'setup'].includes(r.whoseFault), `${r.id}: ${r.whoseFault}`);
  }
});

check('rule ids are unique', () => {
  const ids = REASON_RULES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
});

check('no rule leaks an internal setting name into what the reader sees', () => {
  const banned = /SPIKE_[A-Z_]+|allowedHosts|LoopOptions|spike\.config\.json|maxSteps/;
  for (const r of REASON_RULES) {
    assert.ok(!banned.test(r.headline), `${r.id} headline`);
    assert.ok(!banned.test(r.nextStep), `${r.id} next step`);
  }
});

// ---- 3. provider failures --------------------------------------------------

check('a rejected key reads as a key problem, blamed on setup', () => {
  for (const raw of ['anthropic api 401: {"type":"error","error":{"message":"invalid x-api-key"}}', 'gpt api 403: forbidden']) {
    const e = explainReason(raw);
    assert.ok(e, raw);
    assert.equal(e!.id, 'key-rejected');
    assert.equal(e!.whoseFault, 'setup');
    assert.ok(/key was rejected/i.test(e!.headline));
    assert.ok(/Settings/i.test(e!.nextStep));
  }
});

check('a rate limit reads as a rate limit, blamed on setup', () => {
  for (const raw of ['anthropic api 429: rate limited', 'gemini api 503: overloaded']) {
    const e = explainReason(raw);
    assert.ok(e, raw);
    assert.equal(e!.id, 'rate-limited');
    assert.equal(e!.whoseFault, 'setup');
    assert.ok(/rate-limiting/i.test(e!.headline));
  }
});

check('neither provider failure is ever blamed on the user’s app', () => {
  for (const raw of ['anthropic api 401: x', 'anthropic api 429: x']) {
    assert.notEqual(explainReason(raw)!.whoseFault, 'your app');
  }
});

// ---- 4. the host block is a HOST block -------------------------------------

check("the driver no longer labels a host block as read-only mode", () => {
  assert.ok(!/read-only mode: \$\{readOnlyBlock\}/.test(loopSrc), 'loop.ts still says "read-only mode:" for a host block');
  assert.ok(loopSrc.includes('blocked host:'), 'loop.ts does not produce the host-block wording');
});

check('a host block explains a different website, not a setting', () => {
  const e = explainReason("blocked host: accounts.example.com is not on this run's allowed host list — pass --allow-host accounts.example.com");
  assert.ok(e);
  assert.equal(e!.id, 'host-blocked');
  assert.ok(/different website/i.test(e!.headline));
  assert.ok(!/read-only|look-only/i.test(e!.headline + e!.nextStep), 'must not conflate the two');
});

check('an old saved report using the previous wording still translates', () => {
  const e = explainReason('read-only mode: accounts.example.com is not in allowedHosts — add it via SPIKE_ALLOWED_HOSTS');
  assert.ok(e);
  assert.equal(e!.id, 'host-blocked');
});

// ---- 5. it reaches what the reader reads -----------------------------------

function reportWith(reason: string): Report {
  return {
    runId: 'r',
    task: 'check the cart',
    url: 'http://x.test/',
    verdict: 'uncertain',
    reason,
    steps: [],
    evidence_paths: [],
    durationMs: 1,
    model_trace: [],
  } as unknown as Report;
}

check('the plain report shows the translation, not the internal string', () => {
  const out = renderPlainReport(reportWith('step budget exhausted before the task completed'));
  assert.ok(!out.includes('step budget exhausted'), 'the internal wording leaked through');
  assert.ok(/ran out of room/i.test(out), 'the translated headline is missing');
  assert.ok(/the test couldn’t get there|the test couldn't get there/i.test(out), 'the attribution is missing');
});

check('an unknown reason is never swallowed', () => {
  const odd = 'something nobody has taught this table about';
  assert.equal(explainReason(odd), null);
  assert.equal(plainReasonText(odd), odd);
  assert.ok(renderPlainReport(reportWith(odd)).includes(odd));
});

check('an empty reason yields nothing rather than a fabricated explanation', () => {
  assert.equal(explainReason(''), null);
  assert.equal(explainReason(undefined), null);
});

console.log(failures === 0 ? '\nV96 OK' : `\nV96 FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
