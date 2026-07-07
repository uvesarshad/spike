import { getRunData, type RunDataState } from './state.js';

export const RUN_PLACEHOLDER_RE = /\{\{run\.([A-Za-z][A-Za-z0-9_-]*)\}\}/g;

export interface RunPlaceholderResolution {
  placeholder: string;
  key: string;
  value: string;
}

export interface ResolveRunPlaceholdersOptions {
  unknown?: 'error' | 'preserve';
}

export interface ResolveRunPlaceholdersResult {
  text: string;
  resolved: RunPlaceholderResolution[];
}

export class RunDataNotFoundError extends Error {
  constructor(readonly key: string) {
    super(`run data "${key}" not found`);
  }
}

export function hasRunPlaceholders(text: string): boolean {
  RUN_PLACEHOLDER_RE.lastIndex = 0;
  return RUN_PLACEHOLDER_RE.test(text);
}

export function resolveRunPlaceholders(
  text: string,
  state: RunDataState,
  opts: ResolveRunPlaceholdersOptions = {},
): ResolveRunPlaceholdersResult {
  const unknown = opts.unknown ?? 'error';
  const resolved: RunPlaceholderResolution[] = [];
  RUN_PLACEHOLDER_RE.lastIndex = 0;
  const output = text.replace(RUN_PLACEHOLDER_RE, (placeholder, key: string) => {
    const value = getRunData(state, key);
    if (value === undefined) {
      if (unknown === 'preserve') return placeholder;
      throw new RunDataNotFoundError(key);
    }
    resolved.push({ placeholder, key, value });
    return value;
  });
  return { text: output, resolved };
}
