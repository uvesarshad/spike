/* Central config. Resolution order: explicit overrides → env → qa.config.json → defaults.
 * Ports deliberately differ from the spikes (CDP 9223/9224, HTTP 9333/9334) so a
 * still-running spike Chrome never collides with the daemon. */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo's extension/ dir, resolved relative to this source file (src/ → up → extension). */
const DEFAULT_EXTENSION_DIR = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)), // .../src/
  '..', // repo root
  'extension',
);

export interface QaConfig {
  /** Transport that drives Chrome: daemon-launched CDP, or the MV3 extension bridge. */
  via: 'cdp' | 'extension';
  /** WebSocket port the daemon↔extension bridge listens on (extension mode). */
  bridgePort: number;
  /** Unpacked extension dir dev-loaded in extension mode. */
  extensionDir: string;
  /** CDP port for the daemon's Chrome. */
  cdpPort: number;
  /** Local HTTP port serving the Nano runner page. */
  runnerPort: number;
  /** Local HTTP port for the fixture app (dev/dogfood only). */
  fixturePort: number;
  /** Chrome profile dir — must live on a volume with 22 GB+ free (Gemini Nano storage gate). */
  chromeProfile: string;
  /** Rung-1 Google CLI binary (gemini today, antigravity after 2026-06-18 — never hardcode). */
  googleCliBin: string;
  /** Rung-1 model id passed to the CLI. */
  googleCliModel: string;
  /** Rung-2 BYOK Gemini API key (absent → rung 2 unavailable). */
  geminiApiKey?: string;
  /** Extra env for the Google CLI child process (e.g. NODE_OPTIONS=--use-system-ca behind AVG TLS interception). */
  googleCliEnv: Record<string, string>;
  /** Where run artifacts (report.json, screenshots) are written. */
  artifactsDir: string;
  /** Default driver-loop step budget. */
  maxSteps: number;
}

const DEFAULTS: QaConfig = {
  via: 'cdp',
  bridgePort: 9410,
  extensionDir: DEFAULT_EXTENSION_DIR,
  cdpPort: 9322,
  runnerPort: 9400,
  fixturePort: 9401,
  chromeProfile: path.join(process.env.LOCALAPPDATA ?? process.env.HOME ?? '.', 'qa-subagent-chrome-profile'),
  googleCliBin: 'gemini',
  googleCliModel: 'gemini-3-flash-preview',
  googleCliEnv: { NODE_OPTIONS: '--use-system-ca' },
  artifactsDir: path.resolve('artifacts'),
  maxSteps: 12,
};

function fromFile(cwd: string): Partial<QaConfig> {
  const p = path.join(cwd, 'qa.config.json');
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}

function fromEnv(): Partial<QaConfig> {
  const e = process.env;
  const out: Partial<QaConfig> = {};
  if (e.QA_VIA === 'cdp' || e.QA_VIA === 'extension') out.via = e.QA_VIA;
  if (e.QA_BRIDGE_PORT) out.bridgePort = Number(e.QA_BRIDGE_PORT);
  if (e.QA_EXTENSION_DIR) out.extensionDir = e.QA_EXTENSION_DIR;
  if (e.QA_CDP_PORT) out.cdpPort = Number(e.QA_CDP_PORT);
  if (e.QA_RUNNER_PORT) out.runnerPort = Number(e.QA_RUNNER_PORT);
  if (e.QA_FIXTURE_PORT) out.fixturePort = Number(e.QA_FIXTURE_PORT);
  if (e.QA_CHROME_PROFILE) out.chromeProfile = e.QA_CHROME_PROFILE;
  if (e.QA_GOOGLE_CLI_BIN) out.googleCliBin = e.QA_GOOGLE_CLI_BIN;
  if (e.QA_GOOGLE_CLI_MODEL) out.googleCliModel = e.QA_GOOGLE_CLI_MODEL;
  if (e.GEMINI_API_KEY) out.geminiApiKey = e.GEMINI_API_KEY;
  if (e.QA_ARTIFACTS_DIR) out.artifactsDir = e.QA_ARTIFACTS_DIR;
  if (e.QA_MAX_STEPS) out.maxSteps = Number(e.QA_MAX_STEPS);
  return out;
}

export function loadConfig(overrides: Partial<QaConfig> = {}, cwd = process.cwd()): QaConfig {
  return { ...DEFAULTS, ...fromFile(cwd), ...fromEnv(), ...overrides };
}
