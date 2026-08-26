/* v70 — Oracle strict mode surfaced in settings (the "spike config" / panel
 * Settings / README enhancement item, covered by A1).
 *
 * Covers:
 *   1. DEFAULT_SETTINGS.strictOracles is true (safe-by-default, mirrors readOnly)
 *   2. buildLiteConfig() (lite mode's vibe.config.get payload) carries
 *      strictOracles through with the same safe-default-true fallback as
 *      readOnly/videoAssertions
 *   3. an explicit false setting is honored, not silently defaulted back to true
 */

import { DEFAULT_SETTINGS, type QaSettings } from '../src/vibe/settings-data.js';
import { buildLiteConfig } from '../src/extension/lite-engine.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

function baseSettings(overrides: Partial<QaSettings> = {}): QaSettings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

check('DEFAULT_SETTINGS.strictOracles is true', DEFAULT_SETTINGS.strictOracles === true);

{
  const cfg = buildLiteConfig({}, baseSettings());
  check('buildLiteConfig: strictOracles present and true by default', cfg.strictOracles === true);
}

{
  const cfg = buildLiteConfig({}, baseSettings({ strictOracles: false }));
  check('buildLiteConfig: an explicit false is honored, not defaulted back to true', cfg.strictOracles === false);
}

{
  // strictOracles absent entirely on the settings object (e.g. an old
  // persisted settings.json from before this field existed) — must still
  // default safely to true, exactly like readOnly's `?? true` fallback.
  const partial = { ...baseSettings() } as Partial<QaSettings>;
  delete partial.strictOracles;
  const cfg = buildLiteConfig({}, partial as QaSettings);
  check('buildLiteConfig: a missing field (pre-migration settings.json) defaults to true', cfg.strictOracles === true);
}

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} v70 checks passed`);
process.exit(failed.length ? 1 : 0);
