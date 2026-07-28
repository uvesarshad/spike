/* M2 verification — NanoRunnerPage reproduces spike A through the port:
 * availability, warm session, verdict discrimination on the spike's
 * good/bad screenshots (spikes/cdp-logpoint/shots/, created by capture-shots.js).
 * Exits 2 (skip) when the model isn't downloaded yet — run `spike nano --download`. */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { NanoRunnerPage } from '../src/ports/nano-runner-page.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const shots = path.join(here, '..', 'spikes', 'cdp-logpoint', 'shots');
const TASK =
  'Does this page render correctly: a complete dashboard UI with visible navigation and content, no blank areas, no error messages, no obviously broken layout?';

for (const f of ['good.png', 'bad.png']) {
  if (!fs.existsSync(path.join(shots, f))) {
    console.error(`missing ${f} — run the spike capture first (spikes/cdp-logpoint/capture-shots.js)`);
    process.exit(2);
  }
}

const cfg = loadConfig();
const nano = new NanoRunnerPage({
  cdpPort: cfg.cdpPort,
  runnerPort: cfg.runnerPort,
  profileDir: cfg.chromeProfile,
});

await nano.start();
const a = await nano.availability();
console.log('availability:', a);
if (a !== 'available') {
  console.error('model not available — run `spike nano --download` first');
  await nano.close();
  process.exit(2);
}

console.log('warming up…');
const t0 = Date.now();
await nano.warmup();
console.log(`warm in ${Date.now() - t0} ms`);

const results: Record<string, string> = {};
for (const page of ['good', 'bad'] as const) {
  const png = fs.readFileSync(path.join(shots, `${page}.png`));
  const { verdict, ms } = await nano.verdict(png, TASK);
  results[page] = verdict.verdict;
  console.log(`\n--- ${page}.png → ${verdict.verdict} (${ms} ms, $0.00 on-device) ---`);
  console.log(JSON.stringify(verdict, null, 2));
}

await nano.close();

const ok = results.good === 'pass' && results.bad === 'fail';
console.log(`\ndiscriminates good vs broken UI: ${ok ? 'PASS' : 'FAIL'}`);
process.exit(ok ? 0 : 1);
