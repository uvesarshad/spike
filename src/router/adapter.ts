/* ModelAdapter — one rung of the model ladder. Everything the driver needs
 * reduces to "produce JSON matching this schema from this prompt (+ image)",
 * so the adapter surface is a single generateJson(). Nano is the exception
 * that proves the rule: it only does visual verdicts (its runner enforces a
 * fixed verdict schema and requires an image), hence supports(). */

export type Capability = 'visual-verdict' | 'plan-step';

export interface JsonRequest {
  prompt: string;
  /** JSON schema the response must match (adapters enforce it as well as they can). */
  schema: object;
  imagePng?: Buffer;
}

export interface ModelAdapter {
  readonly name: string;
  readonly rung: 0 | 1 | 2 | 3;
  available(): Promise<boolean>;
  supports(cap: Capability): boolean;
  generateJson(req: JsonRequest): Promise<unknown>;
}

/** Pull the first JSON object out of model output that may have prose around it. */
export function extractJson(text: string): unknown {
  const direct = text.trim();
  try {
    return JSON.parse(direct);
  } catch {
    /* fall through */
  }
  const fence = direct.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      /* fall through */
    }
  }
  const start = direct.indexOf('{');
  if (start >= 0) {
    // walk to the matching close brace
    let depth = 0;
    for (let i = start; i < direct.length; i++) {
      if (direct[i] === '{') depth++;
      else if (direct[i] === '}' && --depth === 0) {
        try {
          return JSON.parse(direct.slice(start, i + 1));
        } catch {
          break;
        }
      }
    }
  }
  throw new Error(`model output contained no parseable JSON: ${direct.slice(0, 200)}`);
}
