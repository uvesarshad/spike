import { loadConfig } from '../config.js';
import { detectAgents } from '../setup/detect.js';
import { Vault } from '../vault/vault.js';
import type { PlannerSelection } from '../vibe/settings-data.js';
import type { SetupData } from './read-pages.js';

/** Provider -> the env var / vault name an AI key for it lives under. */
const KEY_NAMES: Array<[string, string]> = [
  ['Claude', 'ANTHROPIC_API_KEY'],
  ['Gemini', 'GEMINI_API_KEY'],
  ['OpenAI', 'OPENAI_API_KEY'],
  ['OpenRouter', 'OPENROUTER_API_KEY'],
  ['GLM', 'GLM_API_KEY'],
];

const PROVIDER_WORDS: Record<string, string> = { claude: 'Claude', gemini: 'Gemini', openai: 'OpenAI', gpt: 'OpenAI', openrouter: 'OpenRouter', glm: 'GLM', nano: 'Chrome’s built-in AI', ollama: 'Ollama' };

/** A model pin in plain words: who provides it and how Spike reaches it. */
export function describeModel(sel: Pick<PlannerSelection, 'provider' | 'mode' | 'model'>): string {
  const who = PROVIDER_WORDS[sel.provider] ?? sel.provider;
  const how = sel.provider === 'nano' ? 'free, runs on this computer' : sel.mode === 'cli' ? 'through your logged-in command-line tool' : 'with your AI key';
  return `${who}${sel.model ? ` (${sel.model})` : ''} — ${how}`;
}

/** Names of the AI providers a key is present for. Never reads a value out. */
export function keysPresent(env: NodeJS.ProcessEnv, vaultNames: string[]): string[] {
  return KEY_NAMES.filter(([, n]) => Boolean(env[n]) || vaultNames.includes(n)).map(([p]) => p);
}

export function realSetupData(helperRunning: boolean): SetupData {
  const cfg = loadConfig();
  let vaultNames: string[] = [];
  try { vaultNames = new Vault().list(); } catch { /* an unreadable vault just means "no keys found" */ }
  return {
    agents: detectAgents(),
    clicker: describeModel(cfg.navigator),
    planner: describeModel(cfg.planner),
    keysPresent: keysPresent(process.env, vaultNames),
    helperRunning,
  };
}
