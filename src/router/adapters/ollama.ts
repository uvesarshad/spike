/* Rung 3 — Ollama local. Interface stub for the MVP: the privacy floor exists
 * in the ladder's type system, not yet in code. Implementation sketch: POST
 * http://localhost:11434/api/chat with format=<schema>, images as base64. */

import type { Capability, JsonRequest, ModelAdapter } from '../adapter.js';

export class OllamaAdapter implements ModelAdapter {
  readonly name = 'ollama';
  readonly rung = 3 as const;

  async available(): Promise<boolean> {
    return false; // stub — flips when implemented
  }

  supports(_cap: Capability): boolean {
    return true;
  }

  async generateJson(_req: JsonRequest): Promise<unknown> {
    throw new Error('Ollama adapter not implemented (interface stub)');
  }
}
