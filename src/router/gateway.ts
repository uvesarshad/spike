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

export function openAiGatewayOptions(
  input: OpenAiGatewayOptionsInput,
  env: NodeJS.ProcessEnv = process.env,
): OpenAiCompatibleOptions {
  const { defaultBaseUrl, baseUrlEnvVar, ...rest } = input;
  const envName = baseUrlEnvVar ?? gatewayBaseUrlEnv(input.label);
  return {
    ...rest,
    baseUrl: normalizeOpenAiBaseUrl(env[envName] ?? defaultBaseUrl),
  };
}
