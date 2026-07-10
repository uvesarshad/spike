/* Secure script runner — validator. Structurally validates a `script` action's
 * `steps` body BEFORE anything executes: zod-parses each step against the
 * allowlisted shapes (unknown keys rejected via `.strict()`), enforces the
 * step-count cap, and scans every string field for code-injection markers
 * (import/require/fs/network/process/eval/Function/prototype access). There is
 * no `eval` anywhere in this module — steps are plain data, never code. A
 * validation failure means the action is REJECTED outright: the driver loop
 * must not execute a partially-validated script. */

import { ScriptRunnerStepSchema, SCRIPT_MAX_STEPS, type ScriptRunnerStep } from './schema.js';

export interface ScriptValidationResult {
  ok: boolean;
  steps: ScriptRunnerStep[];
  reason?: string;
}

/** Patterns that mean "this string is trying to reference code/IO primitives,
 * not describe a UI action". Matched against every string field of every step
 * (recursively) — deliberately broad; a legitimate step never needs any of
 * these tokens. Not exhaustive against a determined attacker (nothing here
 * ever reaches `eval`/`Function`/`vm` — the steps are inert data consumed by a
 * fixed switch in executor.ts), but closes the obvious injection attempts a
 * model or a hand-edited script.json might try. */
const DANGEROUS_PATTERNS: RegExp[] = [
  /\bimport\s*\(/i,
  /\brequire\s*\(/i,
  /\bprocess\s*\./i,
  /\beval\s*\(/i,
  /\bnew\s+Function\b/i,
  /\bFunction\s*\(/i,
  /__proto__/i,
  /\.constructor\s*[[(]/i,
  /\bprototype\s*[[.]/i,
  /\bchild_process\b/i,
  /\bfs\s*\.\s*[a-zA-Z]/i,
  /\bXMLHttpRequest\b/i,
  /\bfetch\s*\(/i,
  /\bWebSocket\s*\(/i,
  /`[^`]*\$\{/, // template-literal interpolation — no expression evaluation allowed
];

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function scanForDangerousText(value: unknown, path: string, hits: string[]): void {
  if (hits.length) return; // first hit is enough — short-circuit the walk
  if (typeof value === 'string') {
    for (const re of DANGEROUS_PATTERNS) {
      if (re.test(value)) {
        hits.push(`${path}: matched disallowed pattern ${re.source}`);
        return;
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) scanForDangerousText(value[i], `${path}[${i}]`, hits);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (DANGEROUS_KEYS.has(k)) {
        hits.push(`${path}.${k}: disallowed key`);
        return;
      }
      scanForDangerousText(v, `${path}.${k}`, hits);
      if (hits.length) return;
    }
  }
}

/** Validate a raw `script` action's `steps` value. Returns `ok: false` (never
 * throws) on: not an array, empty, over SCRIPT_MAX_STEPS, a step that fails
 * the allowlisted schema (unknown type or unknown/extra field), or a step
 * whose text matches a dangerous pattern. The loop treats a rejected script
 * as a stuck/escalate condition rather than executing anything. */
export function validateScriptSteps(input: unknown): ScriptValidationResult {
  if (!Array.isArray(input)) {
    return { ok: false, steps: [], reason: 'script.steps must be an array' };
  }
  if (input.length === 0) {
    return { ok: false, steps: [], reason: 'script.steps must not be empty' };
  }
  if (input.length > SCRIPT_MAX_STEPS) {
    return { ok: false, steps: [], reason: `script.steps exceeds the ${SCRIPT_MAX_STEPS}-step cap (${input.length} given)` };
  }
  const steps: ScriptRunnerStep[] = [];
  for (let i = 0; i < input.length; i++) {
    const parsed = ScriptRunnerStepSchema.safeParse(input[i]);
    if (!parsed.success) {
      return { ok: false, steps: [], reason: `step ${i}: ${parsed.error.message.slice(0, 200)}` };
    }
    const hits: string[] = [];
    scanForDangerousText(parsed.data, `step[${i}]`, hits);
    if (hits.length) {
      return { ok: false, steps: [], reason: `step ${i}: ${hits[0]}` };
    }
    steps.push(parsed.data);
  }
  return { ok: true, steps };
}
