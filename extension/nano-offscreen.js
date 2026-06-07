/* Offscreen document — hosts the on-device Gemini Nano (Prompt API) session for
 * the extension. The MV3 service worker relays nano.* requests here over
 * chrome.runtime messaging; this document holds the warm session in a module
 * variable so the model stays resident between verdicts.
 *
 * Semantics mirror src/ports/runner-assets.ts EXACTLY (same MODEL_OPTS, same
 * VERDICT_SCHEMA, same prompt text, fresh session per verdict, warm priming). */

const MODEL_OPTS = {
  expectedInputs: [{ type: 'text', languages: ['en'] }, { type: 'image' }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }],
};

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['verdict', 'summary', 'issues'],
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail', 'uncertain'] },
    summary: { type: 'string' },
    issues: { type: 'array', items: { type: 'string' } },
  },
};

let warmSession = null;

async function avail() {
  if (typeof LanguageModel === 'undefined') return 'api-missing';
  return LanguageModel.availability(MODEL_OPTS);
}

async function warmup() {
  if (typeof LanguageModel === 'undefined') throw new Error('LanguageModel API missing in offscreen document');
  if (!warmSession) {
    warmSession = await LanguageModel.create(MODEL_OPTS);
    // session creation alone does not page the model in — the first prompt
    // does. Prime with a near-empty prompt so real verdicts start warm.
    await warmSession.prompt([{ role: 'user', content: [{ type: 'text', value: 'ok' }] }]);
  }
  return 'warm';
}

async function verdict(dataUrl, task) {
  if (typeof LanguageModel === 'undefined') throw new Error('LanguageModel API missing in offscreen document');
  const blob = await (await fetch(dataUrl)).blob();
  const t0 = performance.now();
  const session = await LanguageModel.create(MODEL_OPTS);
  const raw = await session.prompt(
    [{
      role: 'user',
      content: [
        { type: 'text', value:
          'You are a QA assistant inspecting a screenshot of a web page.\n' +
          'Question: ' + task + '\n' +
          'Judge strictly from what is visible. List concrete issues if any.' },
        { type: 'image', value: blob },
      ],
    }],
    { responseConstraint: VERDICT_SCHEMA },
  );
  const ms = Math.round(performance.now() - t0);
  session.destroy();
  let v;
  try { v = JSON.parse(raw); }
  catch { v = { verdict: 'uncertain', summary: 'model returned non-JSON', issues: [String(raw).slice(0, 300)] }; }
  return { verdict: v, ms };
}

// Relay handler: SW → offscreen. Messages are tagged { target: 'nano-offscreen', op, args }.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'nano-offscreen') return false;
  (async () => {
    try {
      let result;
      switch (msg.op) {
        case 'avail':   result = await avail(); break;
        case 'warmup':  result = await warmup(); break;
        case 'verdict': result = await verdict(msg.args.dataUrl, msg.args.task); break;
        default: throw new Error('unknown nano offscreen op ' + msg.op);
      }
      sendResponse({ ok: true, result });
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  })();
  return true; // async sendResponse
});
