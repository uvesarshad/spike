/* Replay-clip recorder — turns a run into a shareable GIF.
 *
 * Every vibe run renders the ghost cursor + caption bar IN-PAGE, so they are
 * already in any frame Chrome paints. We just grab the page's own screencast
 * (Page.startScreencast, JPEG frames sent only when the page changes), throttle
 * to a low FPS, and encode the kept frames into a GIF with pure-JS deps
 * (jpeg-js to decode, gifenc to encode) — no ffmpeg, no native modules.
 *
 * Works over BOTH transports: the structural `CdpClientLike` matches the bits
 * of a chrome-remote-interface client AND the bridge CDP shim
 * (src/bridge/cdp-shim.ts) — Page.startScreencast/stopScreencast/
 * screencastFrameAck as commands, Page.screencastFrame(handler) as an event
 * subscription. */

import fs from 'node:fs';
import path from 'node:path';
// gifenc/jpeg-js ship as CJS with no `exports` map. Node's ESM loader detects
// jpeg-js's named exports (decode/encode) but NOT gifenc's, so gifenc must come
// through its synthesized default and be destructured.
import gifenc from 'gifenc';
import * as jpeg from 'jpeg-js';

const { GIFEncoder, quantize, applyPalette } = gifenc;
const { decode } = jpeg;

/** Structural subset of ArtifactStore this recorder needs (it only writes one
 * file into the run's own directory) — avoids depending on the full class,
 * which other code owns. Satisfied by `src/report/artifacts.ts`'s ArtifactStore. */
export interface ArtifactStoreLike {
  readonly dir: string;
}

/** Structural subset of a CDP client this recorder touches — satisfied by both
 * chrome-remote-interface's CDP.Client and the bridge shim's proxy client. */
export interface CdpClientLike {
  Page: {
    startScreencast(params: {
      format: 'jpeg' | 'png';
      quality?: number;
      maxWidth?: number;
      maxHeight?: number;
      everyNthFrame?: number;
    }): Promise<unknown>;
    stopScreencast(): Promise<unknown>;
    screencastFrameAck(params: { sessionId: number }): Promise<unknown>;
    /** Event subscription: invoked with a single handler function. */
    screencastFrame(
      handler: (params: { data: string; sessionId: number; metadata?: unknown }) => void,
    ): unknown;
  };
}

export interface ClipRecorder {
  /** Stop the screencast and (if ≥2 frames were kept) encode + write the GIF.
   * Returns the artifact path, or null when there were too few frames. */
  stop(): Promise<string | null>;
}

export interface ClipRecorderOptions {
  /** Cap on kept frames per second (Chrome only emits frames on change). */
  maxFps?: number;
  /** Downscale the screencast to at most this width (keeps the GIF small). */
  maxWidth?: number;
}

/** Hard cap on retained frames — a long run must not exhaust memory. Once hit
 * we stop keeping NEW frames (still ACK everything so Chrome keeps streaming). */
const MAX_KEPT_FRAMES = 240;
/** Last frame is held this long so the clip ends on the final state. */
const LAST_FRAME_HOLD_MS = 1500;
/** Inter-frame delays are clamped to this range (ms). */
const MIN_DELAY_MS = 100;
const MAX_DELAY_MS = 2000;

interface KeptFrame {
  /** RGBA pixels. */
  rgba: Uint8Array;
  width: number;
  height: number;
  /** Wall-clock time the frame was kept, for real inter-frame delays. */
  ts: number;
}

export async function startClipRecorder(
  client: CdpClientLike,
  artifacts: ArtifactStoreLike,
  opts: ClipRecorderOptions = {},
): Promise<ClipRecorder> {
  const maxFps = opts.maxFps ?? 2;
  const maxWidth = opts.maxWidth ?? 800;
  const minGapMs = 1000 / maxFps;

  const frames: KeptFrame[] = [];
  let lastKeptAt = 0;
  let capWarned = false;
  let stopped = false;

  const onFrame = (params: { data: string; sessionId: number }): void => {
    // ACK first, unconditionally — Chrome pauses the stream until acked.
    void client.Page.screencastFrameAck({ sessionId: params.sessionId }).catch(() => {});
    if (stopped) return;

    const now = Date.now();
    // throttle: keep a frame only if ≥ minGap since the last KEPT frame.
    if (frames.length > 0 && now - lastKeptAt < minGapMs) return;

    if (frames.length >= MAX_KEPT_FRAMES) {
      if (!capWarned) {
        capWarned = true;
        // eslint-disable-next-line no-console
        console.warn(`[clip] frame cap (${MAX_KEPT_FRAMES}) reached — dropping further frames`);
      }
      return;
    }

    try {
      const buf = Buffer.from(params.data, 'base64');
      const img = decode(buf, { useTArray: true, formatAsRGBA: true });
      frames.push({ rgba: img.data, width: img.width, height: img.height, ts: now });
      lastKeptAt = now;
    } catch {
      /* a corrupt frame must not kill the recording */
    }
  };

  // Register the frame handler, then start the stream. `everyNthFrame:2` halves
  // Chrome's emission rate before our own throttle even runs.
  client.Page.screencastFrame(onFrame);
  await client.Page.startScreencast({ format: 'jpeg', quality: 60, maxWidth, everyNthFrame: 2 });

  return {
    async stop(): Promise<string | null> {
      stopped = true;
      try {
        await client.Page.stopScreencast();
      } catch {
        /* page/transport may already be gone */
      }

      if (frames.length < 2) return null;

      const first = frames[0];
      const encoder = GIFEncoder();
      for (let i = 0; i < frames.length; i++) {
        const f = frames[i];
        // delay = real gap to the NEXT frame (last frame held LAST_FRAME_HOLD_MS).
        const delay =
          i < frames.length - 1
            ? clamp(frames[i + 1].ts - f.ts, MIN_DELAY_MS, MAX_DELAY_MS)
            : LAST_FRAME_HOLD_MS;
        // per-frame palette: best fidelity for UI screenshots with gradients.
        const palette = quantize(f.rgba, 256, { format: 'rgba4444' });
        const index = applyPalette(f.rgba, palette, 'rgba4444');
        encoder.writeFrame(index, f.width, f.height, { palette, delay });
      }
      encoder.finish();

      void first; // (frame 0 anchors the clip's dimensions)
      const gifPath = path.join(artifacts.dir, 'replay.gif');
      fs.writeFileSync(gifPath, encoder.bytes());
      return gifPath;
    },
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}
