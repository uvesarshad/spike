/* NanoPort — rung 0 of the model ladder: Gemini Nano in Chrome, $0, on-device.
 * MVP implementation is NanoRunnerPage (Prompt API web-exposed on a localhost
 * runner page); the extension milestone swaps in its own Prompt API access. */

export type NanoAvailability =
  | 'available'
  | 'downloadable'
  | 'downloading'
  | 'unavailable'
  | 'api-missing';

export interface NanoVerdict {
  verdict: 'pass' | 'fail' | 'uncertain';
  summary: string;
  issues: string[];
}

export interface NanoPort {
  start(): Promise<void>;
  availability(): Promise<NanoAvailability>;
  /** Trigger the ~2GB on-device model download if needed; resolves when available. */
  ensureModel(onProgress?: (status: string) => void): Promise<NanoAvailability>;
  /** Hold a session so the model stays in memory (~5.5s warm vs ~16.7s cold). */
  warmup(): Promise<void>;
  verdict(png: Buffer, task: string): Promise<{ verdict: NanoVerdict; ms: number }>;
  /** NAVIGATOR step ($0): pick ONE action as JSON matching `schema` from a
   * text-only prompt (the a11y tree + current sub-goal — no screenshot needed to
   * reference a nodeId). Resolves the parsed JSON; rejects on non-JSON output so
   * the router can fall through to a cloud navigator. Never used for plan-goals. */
  navStep(prompt: string, schema: object): Promise<unknown>;
  close(): Promise<void>;
}
