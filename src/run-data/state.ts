import { randomBytes } from 'node:crypto';

export type RunDataValue = string;

export interface RunDataExtraction {
  key: string;
  value: RunDataValue;
  source: 'dom' | 'model' | 'email' | 'manual';
  label?: string;
  at: string;
}

export interface RunDataState {
  run: Record<string, RunDataValue>;
  extractions: Record<string, RunDataExtraction>;
}

export interface CreateRunDataOptions {
  shortid?: string;
  email?: string;
  name?: string;
  phone?: string;
  emailDomain?: string;
  now?: Date;
}

const RUN_KEY_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

export function createRunDataState(opts: CreateRunDataOptions = {}): RunDataState {
  const shortid = opts.shortid ?? randomShortId();
  const emailDomain = opts.emailDomain ?? 'example.test';
  return {
    run: {
      shortid,
      email: opts.email ?? `qa+${shortid}@${emailDomain}`,
      name: opts.name ?? `QA User ${shortid}`,
      phone: opts.phone ?? phoneFromShortId(shortid),
    },
    extractions: {},
  };
}

export function isSafeRunDataKey(key: string): boolean {
  return RUN_KEY_RE.test(key);
}

export function getRunData(state: RunDataState, key: string): RunDataValue | undefined {
  assertSafeRunDataKey(key);
  return state.run[key];
}

export function setRunData(state: RunDataState, key: string, value: RunDataValue): void {
  assertSafeRunDataKey(key);
  state.run[key] = value;
}

export function recordExtraction(
  state: RunDataState,
  input: Omit<RunDataExtraction, 'at'> & { at?: string | Date },
): RunDataExtraction {
  assertSafeRunDataKey(input.key);
  const extraction: RunDataExtraction = {
    key: input.key,
    value: input.value,
    source: input.source,
    ...(input.label && { label: input.label }),
    at: normalizeTime(input.at),
  };
  state.run[input.key] = input.value;
  state.extractions[input.key] = extraction;
  return extraction;
}

export function extractRegexToRunData(
  state: RunDataState,
  text: string,
  specs: Array<{ key: string; pattern: RegExp; group?: number | string; label?: string; source?: RunDataExtraction['source'] }>,
): RunDataExtraction[] {
  const out: RunDataExtraction[] = [];
  for (const spec of specs) {
    spec.pattern.lastIndex = 0;
    const match = spec.pattern.exec(text);
    if (!match) continue;
    const defaultGroup = match.length > 1 ? 1 : 0;
    const raw = typeof spec.group === 'string' ? match.groups?.[spec.group] : match[spec.group ?? defaultGroup];
    if (raw === undefined) continue;
    out.push(
      recordExtraction(state, {
        key: spec.key,
        value: raw.trim(),
        source: spec.source ?? 'dom',
        ...(spec.label && { label: spec.label }),
      }),
    );
  }
  return out;
}

function assertSafeRunDataKey(key: string): void {
  if (!isSafeRunDataKey(key)) {
    throw new Error(`invalid run data key "${key}"`);
  }
}

function randomShortId(): string {
  return randomBytes(4).toString('hex');
}

function phoneFromShortId(shortid: string): string {
  let acc = 0;
  for (const ch of shortid) acc = (acc * 33 + ch.charCodeAt(0)) % 10_000;
  return `+1555${String(acc).padStart(4, '0')}`;
}

function normalizeTime(value: string | Date | undefined): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return new Date().toISOString();
}
