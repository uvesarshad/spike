/* Minimal ambient types for `gifenc` (ships no .d.ts). Covers only the
 * quantize → applyPalette → GIFEncoder.writeFrame surface screencast.ts uses.
 *
 * gifenc is CJS with no `exports` map; Node's ESM loader surfaces it only as a
 * default export, so we type the module's DEFAULT as the namespace object. */
declare module 'gifenc' {
  export type PixelFormat = 'rgb565' | 'rgb444' | 'rgba4444';

  type QuantizeFn = (
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    options?: { format?: PixelFormat; oneBitAlpha?: boolean | number; clearAlpha?: boolean },
  ) => number[][];

  type ApplyPaletteFn = (
    rgba: Uint8Array | Uint8ClampedArray,
    palette: number[][],
    format?: PixelFormat,
  ) => Uint8Array;

  export interface GIFEncoderInstance {
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      opts?: {
        palette?: number[][];
        delay?: number;
        repeat?: number;
        transparent?: boolean;
        dispose?: number;
        first?: boolean;
      },
    ): void;
    finish(): void;
    bytes(): Uint8Array;
    bytesView(): Uint8Array;
    reset(): void;
  }

  type GIFEncoderFn = (opts?: { auto?: boolean; initialCapacity?: number }) => GIFEncoderInstance;

  interface GifencNamespace {
    GIFEncoder: GIFEncoderFn;
    quantize: QuantizeFn;
    applyPalette: ApplyPaletteFn;
  }

  const gifenc: GifencNamespace;
  export default gifenc;
}
