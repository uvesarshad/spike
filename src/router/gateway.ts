import type { OpenAiCompatibleOptions } from './adapters/openai-compatible.js';

export type OpenAiGatewayLabel = 'gpt' | 'openrouter' | 'glm';

export interface OpenAiGatewayOptionsInput extends Omit<OpenAiCompatibleOptions, 'baseUrl' | 'label'> {
  label: OpenAiGatewayLabel;
  /** Direct provider endpoint used when no gateway override is configured. */
  defaultBaseUrl: string;
  /** Test hook / future custom providers; defaults from label. */
  baseUrlEnvVar?: string;
}

const BASE_URL_ENV: Record<OpenAiGatewayLabel, string> = {
  gpt: 'OPENAI_BASE_URL',
  openrouter: 'OPENROUTER_BASE_URL',
  glm: 'GLM_BASE_URL',
};

export function gatewayBaseUrlEnv(label: OpenAiGatewayLabel): string {
  return BASE_URL_ENV[label];
}

export function normalizeOpenAiBaseUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '');
  return trimmed.endsWith('/chat/completions')
    ? trimmed.slice(0, -'/chat/completions'.length)
    : trimmed;
}

/** Reject anything but https: before a Bearer key + prompt content ever gets
 * sent to it — a stray http:// value or typo'd host would otherwise leak
 * secrets over an unencrypted (or non-URL) transport with no guard rail. */
function assertHttpsBaseUrl(url: string, envName: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${envName}: invalid base URL "${url}" — must be an https: URL`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`${envName}: base URL must use https:, got "${parsed.protocol}" ("${url}")`);
  }
}

export function openAiGatewayOptions(
  input: OpenAiGatewayOptionsInput,
  env: NodeJS.ProcessEnv = process.env,
): OpenAiCompatibleOptions {
  const { defaultBaseUrl, baseUrlEnvVar, ...rest } = input;
  const envName = baseUrlEnvVar ?? gatewayBaseUrlEnv(input.label);
  const baseUrl = normalizeOpenAiBaseUrl(env[envName] ?? defaultBaseUrl);
  assertHttpsBaseUrl(baseUrl, envName);
  return {
    ...rest,
    baseUrl,
  };
}
