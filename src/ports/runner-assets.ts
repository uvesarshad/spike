/* In-page assets for the Nano runner — plain-JS string literals (this code runs
 * inside Chrome, not Node). Lifted from spikes/cdp-logpoint/spike-a-web.js with
 * one product change: warmup() holds a session so the model stays resident,
 * while each verdict still uses a fresh session (no context bleed between runs).
 *
 * Why a localhost page at all: the Prompt API is web-exposed only on secure
 * contexts — localhost qualifies, about:blank (opaque origin) does not. */

export const RUNNER_JS = `
window.__status = 'idle';
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
window.nano = {
  async avail() {
    if (typeof LanguageModel === 'undefined') return 'api-missing';
    return LanguageModel.availability(MODEL_OPTS);
  },
  async download() {
    window.__status = 'starting download';
    const session = await LanguageModel.create({
      ...MODEL_OPTS,
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => {
          window.__status = 'downloading ' + Math.round(e.loaded * 100) + '%';
        });
      },
    });
    session.destroy();
    window.__status = 'download done';
    return window.nano.avail();
  },
  async warmup() {
    if (!warmSession) {
      warmSession = await LanguageModel.create(MODEL_OPTS);
      // session creation alone does not page the model in — the first prompt
      // does. Prime with a near-empty prompt so real verdicts start warm.
      await warmSession.prompt([{ role: 'user', content: [{ type: 'text', value: 'ok' }] }]);
    }
    return 'warm';
  },
  async verdict(dataUrl, task) {
    const blob = await (await fetch(dataUrl)).blob();
    const t0 = performance.now();
    const session = await LanguageModel.create(MODEL_OPTS);
    const raw = await session.prompt(
      [{
        role: 'user',
        content: [
          { type: 'text', value:
            'You are a QA assistant inspecting a screenshot of a web page.\\n' +
            'Question: ' + task + '\\n' +
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
  },
};
`;

export const RUNNER_HTML = `<!DOCTYPE html><html><head><title>qa-nano-runner</title></head>
<body><h1>QA subagent — Nano runner</h1>
<p>This tab hosts the on-device Gemini Nano session. Leave it open.</p>
<script src="/runner.js"></script></body></html>`;
