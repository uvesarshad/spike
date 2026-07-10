import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { strict as assert } from 'node:assert';
import * as jpeg from 'jpeg-js';
import { ActionSchema } from '../src/driver/actions.js';
import { scriptFromReport, toPlaywrightSpec } from '../src/recorder/script.js';
import type { Report } from '../src/report/report.js';
import { ByokGeminiAdapter } from '../src/router/adapters/byok-gemini.js';
import { AnthropicAdapter } from '../src/router/adapters/anthropic.js';
import { ModelRouter } from '../src/router/model-router.js';
import { runDriverLoop } from '../src/driver/loop.js';
import { ArtifactStore } from '../src/report/artifacts.js';
import type { Capability, JsonRequest, ModelAdapter } from '../src/router/adapter.js';
import type {
  AxNode,
  AxSnapshot,
  BrowserPort,
  ConsoleEntry,
  LogpointSpec,
  NetworkEntry,
} from '../src/ports/browser-port.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

// MODELS: video adapter unit — Phase 8 (router.hasVideoVerdict/videoVerdict +
// ByokGeminiAdapter's Files-API video route). Mocked fetch only, no network.
// Added by the MODELS lane; do not rewrite the DRIVER cases below this block.
{
  const realFetch = globalThis.fetch;
  const calls: { url: string }[] = [];
  const tmpClip = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-video-')), 'clip.webm');
  fs.writeFileSync(tmpClip, Buffer.from('fake-webm-bytes'));

  globalThis.fetch = (async (url: string) => {
    calls.push({ url: String(url) });
    if (String(url).includes('/upload/v1beta/files')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ file: { name: 'files/abc123', uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc123', mimeType: 'video/webm', state: 'ACTIVE' } }),
        text: async () => '',
      } as Response;
    }
    // generateContent
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '{"verdict":"pass","summary":"toast shown","issues":[]}' }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, totalTokenCount: 14 },
      }),
      text: async () => '',
    } as Response;
  }) as typeof fetch;

  try {
    const gemini = new ByokGeminiAdapter({ apiKey: 'k', model: 'gemini-3-flash-preview' });
    check('byok-gemini: supportsVideo is true', gemini.supportsVideo === true);
    const raw = (await gemini.videoVerdict(tmpClip, 'toast appears after saving')) as { verdict?: string };
    check('byok-gemini videoVerdict: uploads then judges (2 fetch calls)', calls.length === 2);
    check('byok-gemini videoVerdict: upload call hits the Files API', calls[0].url.includes('/upload/v1beta/files'));
    check('byok-gemini videoVerdict: parses the verdict JSON', raw.verdict === 'pass');
    check('byok-gemini videoVerdict: records token usage', gemini.lastUsage?.totalTokens === 14);

    // router.hasVideoVerdict()/videoVerdict(): picks the first supportsVideo
    // candidate and normalizes the reply into the same NanoVerdict shape
    // visualVerdict() returns; a screenshot-only adapter never gets picked.
    const claude = new AnthropicAdapter({ apiKey: 'k', model: 'claude-haiku-4-5' });
    check('anthropic: supportsVideo is unset (screenshot-only)', !claude.supportsVideo);
    const router = new ModelRouter([claude, gemini]);
    check('router.hasVideoVerdict(): true when a video-capable adapter is available', await router.hasVideoVerdict());
    const verdict = await router.videoVerdict(tmpClip, 'toast appears after saving', 1);
    check('router.videoVerdict(): returns a NanoVerdict-shaped result', verdict.verdict === 'pass' && Array.isArray(verdict.issues));
    check('router.videoVerdict(): trace records the video call', router.trace.some((t) => t.note === 'video' && t.adapter === gemini.name));

    // no video-capable adapter configured → hasVideoVerdict() false, videoVerdict() throws
    // (the driver catches this and falls back to the screenshot path).
    const screenshotOnlyRouter = new ModelRouter([claude]);
    check('router.hasVideoVerdict(): false with only screenshot-only adapters', !(await screenshotOnlyRouter.hasVideoVerdict()));
    let threw = false;
    try {
      await screenshotOnlyRouter.videoVerdict(tmpClip, 'x', 1);
    } catch {
      threw = true;
    }
    check('router.videoVerdict(): throws when no video adapter is available (caller falls back)', threw);
  } finally {
    globalThis.fetch = realFetch;
    fs.rmSync(path.dirname(tmpClip), { recursive: true, force: true });
  }
}

const parsed = ActionSchema.safeParse({
  type: 'assert_visual',
  expectation: 'toast appears after saving',
  mode: 'video',
});
check('ActionSchema accepts assert_visual video mode', parsed.success);

const report: Report = {
  verdict: 'pass',
  failing_step: null,
  console_error: null,
  evidence_paths: [],
  reason: 'ok',
  runId: 'r-video',
  task: 'verify save toast',
  url: 'http://localhost/video',
  steps: [
    {
      index: 0,
      action: { type: 'assert_visual', expectation: 'toast appears after saving', mode: 'video' },
      description: 'video check',
      ok: true,
      console: [],
      network: [],
      ts: 0,
    },
  ],
  model_trace: [],
  durationMs: 1,
  tokenEstimate: 0,
};

const script = scriptFromReport(report);
check('scriptFromReport preserves video assertion mode', script.steps[0]?.type === 'assert_visual' && script.steps[0].mode === 'video');

const spec = toPlaywrightSpec({
  ...script,
  steps: [
    ...script.steps,
    { type: 'assert_dom', target: { role: `custom'role`, name: 'Result' }, contains: 'Saved' },
  ],
});
check('Playwright twin labels video assertions', spec.includes('// video check'));
check('Playwright twin escapes unknown role names', spec.includes(`page.getByRole("custom'role"`));

/* ------------------------------------------------------------------------- *
 * DRIVER: Phase 8 loop-wiring — does runDriverLoop actually route
 * assert_visual { mode: 'video' } to router.hasVideoVerdict()/videoVerdict()
 * when opts.videoAssertions is on, fall back to the screenshot path with a
 * note when it's off, and gracefully fall back when videoVerdict() throws.
 * Same hand-rolled FAKE BrowserPort + real-ModelRouter harness as v13/v32.
 * ------------------------------------------------------------------------- */

function fakeTree(): AxNode {
  return { id: 'root', role: 'WebArea', children: [] };
}
function fakeSnapshot(): AxSnapshot {
  return { root: fakeTree(), text: '(empty page)', truncated: false };
}

/** A tiny valid JPEG frame (2x2, mid-gray) so startClipRecorder's real
 * jpeg-js decode() succeeds — no hand-crafted magic bytes. */
function fakeJpegFrameBase64(): string {
  const width = 2;
  const height = 2;
  const data = Buffer.alloc(width * height * 4, 128);
  const encoded = jpeg.encode({ data, width, height }, 70);
  return Buffer.from(encoded.data).toString('base64');
}

/** A minimal CdpClientLike (see src/clip/screencast.ts) that emits 2 frames
 * spaced beyond startClipRecorder's maxFps=4 (250ms) throttle window, so
 * stop() has enough kept frames to write a real GIF and return a videoPath. */
function fakeScreencastClient() {
  let handler: ((p: { data: string; sessionId: number }) => void) | null = null;
  return {
    Page: {
      screencastFrame(h: (p: { data: string; sessionId: number }) => void) {
        handler = h;
        setTimeout(() => handler?.({ data: fakeJpegFrameBase64(), sessionId: 1 }), 20);
        setTimeout(() => handler?.({ data: fakeJpegFrameBase64(), sessionId: 1 }), 320);
      },
      async startScreencast() {},
      async stopScreencast() {},
      async screencastFrameAck() {},
    },
  };
}

/** FAKE BrowserPort implementing the full current contract. `recordsClips`
 * controls whether cdpClient() is exposed (drives whether assert_visual can
 * ever produce a real videoPath — mirrors a transport that can/can't screencast). */
class FakeVideoBrowser implements BrowserPort {
  constructor(private recordsClips: boolean) {}
  async launch(): Promise<void> {}
  async navigate(_url: string): Promise<void> {}
  async url(): Promise<string> {
    return 'http://localhost:3000/';
  }
  async axTree(): Promise<AxSnapshot> {
    return fakeSnapshot();
  }
  async click(): Promise<void> {}
  async type(): Promise<void> {}
  async hover(): Promise<void> {}
  async pressKey(): Promise<void> {}
  async selectOption(): Promise<void> {}
  async reload(): Promise<void> {}
  async goBack(): Promise<void> {}
  async uploadFile(): Promise<void> {}
  async dragAndDrop(): Promise<void> {}
  async blur(): Promise<void> {}
  async mouse(): Promise<void> {}
  async openTab(): Promise<string> {
    return 'tab';
  }
  async switchTab(): Promise<void> {}
  async closeTab(): Promise<void> {}
  async screenshot(): Promise<Buffer> {
    return Buffer.from('\x89PNG\r\n\x1a\n', 'binary');
  }
  async setLogpoint(_spec: LogpointSpec): Promise<void> {}
  drainConsole(): ConsoleEntry[] {
    return [];
  }
  drainNetwork(): NetworkEntry[] {
    return [];
  }
  cdpClient(): unknown {
    return this.recordsClips ? fakeScreencastClient() : undefined;
  }
  async close(): Promise<void> {}
}

/** A single-navigator plan (assert_visual mode:video, alone in its batch)
 * followed by a trusted finish:fail so the run ends without needing a
 * confirmation visual call. */
function videoAssertPlans(): unknown[] {
  return [
    { thought: 'check the toast', actions: [{ type: 'assert_visual', expectation: 'a save toast is visible', mode: 'video' }] },
    { thought: 'done', actions: [{ type: 'finish', verdict: 'fail', reason: 'stop here after the assertion' }] },
  ];
}

/** Video-capable + visual-verdict-capable fake adapter. generateJson()
 * discriminates plan-step vs visual-verdict calls by imagePng presence (only
 * a screenshot-verdict call carries one) so the SAME adapter can answer both
 * the navigator's plan-step calls and a screenshot-fallback visual-verdict call. */
function videoCapablePlanner(opts: {
  screenshotVerdict?: { verdict: 'pass' | 'fail'; summary: string; issues?: string[] };
  video?: 'pass' | 'fail' | 'throw';
}): ModelAdapter {
  let i = 0;
  const plans = videoAssertPlans();
  return {
    name: 'fake-video-planner',
    rung: 2,
    available: async () => true,
    supports: (c: Capability) => c === 'plan-step' || c === 'visual-verdict',
    generateJson: async (req: JsonRequest) => {
      if (req.imagePng) {
        return opts.screenshotVerdict ?? { verdict: 'pass', summary: 'screenshot ok', issues: [] };
      }
      const p = plans[Math.min(i, plans.length - 1)];
      i++;
      return p;
    },
    supportsVideo: true,
    async videoVerdict(_clipPath: string, _expectation: string) {
      if (opts.video === 'throw') throw new Error('upload failed (simulated)');
      return { verdict: opts.video ?? 'pass', summary: '[video-adapter] motion looked right', issues: [] };
    },
  };
}

function tmpVideoArtifacts(): ArtifactStore {
  return new ArtifactStore(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-art-video-')));
}

console.log('\n=== v30 DRIVER: Phase 8 loop wiring ===');

// 1) videoAssertions ON + a real clip → router.videoVerdict() judges it, not
// the screenshot path (the adapter's screenshotVerdict would say fail; the
// video verdict says pass — the run must reflect the VIDEO verdict).
{
  const browser = new FakeVideoBrowser(true);
  const router = new ModelRouter([videoCapablePlanner({ screenshotVerdict: { verdict: 'fail', summary: 'screenshot path should NOT be used' }, video: 'pass' })]);
  const report = await runDriverLoop(browser, router, tmpVideoArtifacts(), 'check the save toast', 'http://localhost:3000/', {
    maxSteps: 4,
    allowedHosts: ['localhost'],
    videoAssertions: true,
  });
  const assertStep = report.steps.find((s) => s.action.type === 'assert_visual');
  check('enabled+clip: assert_visual step recorded a video path', Boolean(assertStep?.video));
  check('enabled+clip: the VIDEO verdict wins, not the screenshot fallback', assertStep?.visual?.verdict === 'pass' && (assertStep?.visual?.summary ?? '').includes('[video-adapter]'));
  check('enabled+clip: assertion_trace records the video source', Boolean(report.assertion_trace?.some((t) => t.summary.startsWith('[video]'))));
}

// 2) videoAssertions OFF → screenshot fallback + a note on the step, even
// though the action asked for mode:'video'.
{
  const browser = new FakeVideoBrowser(false);
  const router = new ModelRouter([videoCapablePlanner({ screenshotVerdict: { verdict: 'pass', summary: 'screenshot verdict used' } })]);
  const report = await runDriverLoop(browser, router, tmpVideoArtifacts(), 'check the save toast', 'http://localhost:3000/', {
    maxSteps: 4,
    allowedHosts: ['localhost'],
    videoAssertions: false,
  });
  const assertStep = report.steps.find((s) => s.action.type === 'assert_visual');
  check('disabled: falls back to the screenshot verdict', assertStep?.visual?.summary === 'screenshot verdict used');
  check('disabled: step description notes video was requested but disabled', (assertStep?.description ?? '').includes('video assertion requested but disabled'));
}

// 3) videoAssertions ON + a real clip, but router.videoVerdict() THROWS
// (simulated upload failure) → graceful fallback to the screenshot verdict,
// never a crashed run.
{
  const browser = new FakeVideoBrowser(true);
  const router = new ModelRouter([videoCapablePlanner({ screenshotVerdict: { verdict: 'pass', summary: 'screenshot fallback after upload failure' }, video: 'throw' })]);
  const report = await runDriverLoop(browser, router, tmpVideoArtifacts(), 'check the save toast', 'http://localhost:3000/', {
    maxSteps: 4,
    allowedHosts: ['localhost'],
    videoAssertions: true,
  });
  const assertStep = report.steps.find((s) => s.action.type === 'assert_visual');
  check('upload failure: falls back to the screenshot verdict without crashing', assertStep?.visual?.summary === 'screenshot fallback after upload failure');
}

assert.equal(checks.filter(([, ok]) => !ok).length, 0);
console.log(`\n${checks.length}/${checks.length} v30 video assertion checks passed`);
