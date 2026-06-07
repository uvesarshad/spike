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

/**
 * Download the model with progress reporting. The SW relays a 'download' op
 * here; we create a session with a `monitor` and stream each 'downloadprogress'
 * update back to the SW via chrome.runtime.sendMessage({ target:'nano-progress' }).
 * The SW rebroadcasts to the panel. We keep the warm session afterwards.
 */
async function download() {
  if (typeof LanguageModel === 'undefined') throw new Error('LanguageModel API missing in offscreen document');
  const session = await LanguageModel.create({
    ...MODEL_OPTS,
    monitor(m) {
      m.addEventListener('downloadprogress', (e) => {
        try {
          chrome.runtime.sendMessage({
            target: 'nano-progress',
            status: {
              loaded: typeof e.loaded === 'number' ? e.loaded : undefined,
              total: typeof e.total === 'number' ? e.total : undefined,
              progress: typeof e.loaded === 'number' && (e.total === undefined || e.total === 1)
                ? e.loaded : undefined,
            },
          }, () => { void chrome.runtime.lastError; });
        } catch { /* fire-and-forget */ }
      });
    },
  });
  // prime so the model is resident and the first real verdict starts warm
  try {
    await session.prompt([{ role: 'user', content: [{ type: 'text', value: 'ok' }] }]);
    warmSession = session;
  } catch {
    try { session.destroy(); } catch { /* noop */ }
  }
  return 'downloaded';
}

// ---- replay recording (chrome.tabCapture → MediaRecorder → webm) -----------
//
// This offscreen document doubles as the recorder host: chrome.offscreen allows
// only ONE offscreen document per extension, so rather than a second document we
// extend this one (which already exists for Nano) with recording ops. The SW
// obtains a streamId via chrome.tabCapture.getMediaStreamId and relays it here;
// we open the tab MediaStream with getUserMedia (chromeMediaSource:'tab') and
// feed it to a MediaRecorder, collecting webm chunks (~1s timeslice) in memory.
//
// On stop we assemble the Blob, base64 it, and hand it back to the SW. A short
// run's webm is a few MB; if the base64 exceeds a threshold we chunk it back to
// the SW over chrome.runtime messages (see rec_stop). Errors NEVER throw into a
// run — they return { ok:false, reason }.

let recMediaRecorder = null;
let recStream = null;
let recChunks = [];
let recError = null;

/**
 * Pick a supported recording mime type. We try H.264 MP4 FIRST so the saved clip
 * is a `.mp4` that previews/shares everywhere (Slack/iMessage/Quicktime accept it
 * directly; webm does not), then fall back to the always-supported webm codecs.
 *
 * Measured on THIS machine (Chrome 137, Windows 11) via MediaRecorder.isTypeSupported:
 *   video/mp4;codecs=avc1.42E01E  → false
 *   video/mp4                     → false
 *   video/webm;codecs=vp9         → true
 *   video/webm;codecs=vp8         → true
 *   video/webm                    → true
 * So MP4 recording is not available here and we land on webm/vp9 — but MP4 IS
 * supported on some Chrome builds/platforms (notably macOS), so trying it first
 * costs nothing and upgrades the artifact where the platform allows.
 */
function pickRecMime() {
  const candidates = [
    'video/mp4;codecs=avc1.42E01E', // H.264 baseline — broadest MP4 playback
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  for (const m of candidates) {
    try {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) return m;
    } catch { /* fall through */ }
  }
  return 'video/webm';
}

async function recStart(streamId) {
  if (recMediaRecorder) {
    // a stale recorder from a prior aborted run — tear it down first
    try { recStop(); } catch { /* noop */ }
  }
  recChunks = [];
  recError = null;
  if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
    return { ok: false, reason: 'navigator.mediaDevices unavailable in offscreen document' };
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      // video-only: a QA replay clip needs no audio (and audio capture would
      // also mute the tab unless re-piped). chromeMediaSource:'tab' consumes the
      // streamId minted by the SW's chrome.tabCapture.getMediaStreamId.
      video: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
          maxWidth: 1280,
          maxHeight: 800,
          maxFrameRate: 12,
        },
      },
    });
  } catch (e) {
    return { ok: false, reason: 'getUserMedia(tab) failed: ' + String(e && e.message ? e.message : e) };
  }
  recStream = stream;
  let rec;
  try {
    rec = new MediaRecorder(stream, { mimeType: pickRecMime() });
  } catch (e) {
    try { for (const t of stream.getTracks()) t.stop(); } catch { /* noop */ }
    recStream = null;
    return { ok: false, reason: 'MediaRecorder construction failed: ' + String(e && e.message ? e.message : e) };
  }
  rec.ondataavailable = (ev) => {
    if (ev.data && ev.data.size > 0) recChunks.push(ev.data);
  };
  rec.onerror = (ev) => {
    recError = (ev && ev.error && ev.error.message) ? ev.error.message : 'MediaRecorder error';
  };
  recMediaRecorder = rec;
  try {
    rec.start(1000); // ~1s timeslice → periodic dataavailable chunks
  } catch (e) {
    recMediaRecorder = null;
    try { for (const t of stream.getTracks()) t.stop(); } catch { /* noop */ }
    recStream = null;
    return { ok: false, reason: 'MediaRecorder.start failed: ' + String(e && e.message ? e.message : e) };
  }
  return { ok: true, mime: rec.mimeType || pickRecMime() };
}

/** Stop recording, assemble the Blob, base64 it. Returns { ok, webmBase64 } or
 * { ok:false, reason }. Fully defensive — a run must never die here. */
async function recStop() {
  const rec = recMediaRecorder;
  if (!rec) return { ok: false, reason: 'no active recording' };
  const mime = rec.mimeType || 'video/webm';
  // Wait for the final dataavailable + stop.
  const blob = await new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      try { resolve(new Blob(recChunks, { type: mime })); }
      catch { resolve(new Blob([], { type: mime })); }
    };
    rec.onstop = done;
    // safety: if onstop never fires, resolve from whatever chunks we have
    const t = setTimeout(done, 8000);
    const origDone = done;
    rec.onstop = () => { clearTimeout(t); origDone(); };
    try { rec.stop(); } catch { done(); }
  });
  // tear down the stream / recorder
  try { for (const tr of (recStream ? recStream.getTracks() : [])) tr.stop(); } catch { /* noop */ }
  recMediaRecorder = null;
  recStream = null;
  const chunks = recChunks;
  recChunks = [];

  if (recError) return { ok: false, reason: 'recording error: ' + recError };
  if (!blob || blob.size === 0) return { ok: false, reason: 'recording produced no data (0 bytes — invocation/permission likely denied)' };

  // Blob → base64 (no data: prefix). FileReader keeps this off the main work.
  let base64;
  try {
    base64 = await blobToBase64(blob);
  } catch (e) {
    return { ok: false, reason: 'base64 encode failed: ' + String(e && e.message ? e.message : e) };
  }
  void chunks; // (already in the blob; kept only for the size note above)
  return { ok: true, webmBase64: base64, bytes: blob.size, mime };
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(fr.error || new Error('FileReader failed'));
    fr.onload = () => {
      const res = String(fr.result || '');
      const comma = res.indexOf(',');
      resolve(comma >= 0 ? res.slice(comma + 1) : res); // strip "data:...;base64,"
    };
    fr.readAsDataURL(blob);
  });
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
        case 'avail':    result = await avail(); break;
        case 'warmup':   result = await warmup(); break;
        case 'download': result = await download(); break;
        case 'verdict':  result = await verdict(msg.args.dataUrl, msg.args.task); break;
        case 'rec.start': result = await recStart(msg.args.streamId); break;
        case 'rec.stop':  result = await recStop(); break;
        default: throw new Error('unknown nano offscreen op ' + msg.op);
      }
      sendResponse({ ok: true, result });
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  })();
  return true; // async sendResponse
});
