/* pack-extension.ts — produce dist/extension.zip from extension/* for the
 * Chrome Web Store, and print a submission checklist.
 *
 * Cross-platform with NO runtime zip dependency: on Windows we shell out to
 * PowerShell's Compress-Archive; on macOS/Linux we use the stock `zip`/`unzip`
 * CLIs (present by default on both). Either way the archive has the extension's
 * files at the ROOT (manifest.json at top level), which is what the Web Store
 * requires — never the parent folder.
 *
 *   npx tsx scripts/pack-extension.ts   (or: npm run pack:extension)
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const IS_WINDOWS = process.platform === 'win32';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const EXT_DIR = path.join(REPO, 'extension');
const DIST_DIR = path.join(REPO, 'dist');
const ZIP_PATH = path.join(DIST_DIR, 'extension.zip');
const MANIFEST_PATH = path.join(EXT_DIR, 'manifest.json');

const MAX_DESCRIPTION = 132; // Chrome Web Store hard cap

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** Zip extension/* CONTENTS (manifest.json at the archive root). Dispatches to
 * the platform's stock tooling — no runtime dependency. */
function compress(): void {
  if (fs.existsSync(ZIP_PATH)) fs.rmSync(ZIP_PATH);
  if (IS_WINDOWS) {
    // Compress-Archive with `extension/*` puts the contents (not the folder) at root.
    const ps = [
      `$ErrorActionPreference = 'Stop'`,
      `Compress-Archive -Path '${path.join(EXT_DIR, '*')}' -DestinationPath '${ZIP_PATH}' -CompressionLevel Optimal -Force`,
    ].join('; ');
    const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' });
    if (res.status !== 0) {
      throw new Error(`Compress-Archive failed (exit ${res.status}):\n${res.stderr || res.stdout}`);
    }
    return;
  }
  // macOS/Linux: run `zip` with cwd = EXT_DIR so stored paths are relative to it
  // (root-level manifest.json). -r recurse, -X drop extra OS attrs, -q quiet.
  const res = spawnSync('zip', ['-r', '-X', '-q', ZIP_PATH, '.'], { cwd: EXT_DIR, encoding: 'utf8' });
  if (res.error && (res.error as NodeJS.ErrnoException).code === 'ENOENT') {
    throw new Error("`zip` CLI not found. Install it (macOS ships it; Linux: apt/dnf install zip) or run this on Windows.");
  }
  if (res.status !== 0) {
    throw new Error(`zip failed (exit ${res.status}):\n${res.stderr || res.stdout}`);
  }
}

/** List archive entries to show what shipped — stock tooling per platform. */
function listZipEntries(): string[] {
  if (IS_WINDOWS) {
    const ps = [
      `$ErrorActionPreference = 'Stop'`,
      `Add-Type -AssemblyName System.IO.Compression.FileSystem`,
      `$z = [System.IO.Compression.ZipFile]::OpenRead('${ZIP_PATH}')`,
      `$z.Entries | ForEach-Object { $_.FullName }`,
      `$z.Dispose()`,
    ].join('; ');
    const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' });
    if (res.status !== 0) return [];
    return res.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  }
  // unzip -Z1 = one bare entry name per line.
  const res = spawnSync('unzip', ['-Z1', ZIP_PATH], { encoding: 'utf8' });
  if (res.status !== 0) return [];
  return res.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

function main(): void {
  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error(`manifest not found at ${MANIFEST_PATH}`);
  }
  fs.mkdirSync(DIST_DIR, { recursive: true });

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as {
    description?: string;
    permissions?: string[];
    icons?: Record<string, string>;
  };

  console.log(`[pack] zipping ${path.relative(REPO, EXT_DIR)}/* → ${path.relative(REPO, ZIP_PATH)} …`);
  compress();

  const size = fs.statSync(ZIP_PATH).size;
  const entries = listZipEntries();

  console.log('');
  console.log(`  zip path : ${ZIP_PATH}`);
  console.log(`  zip size : ${fmtBytes(size)}`);
  console.log(`  entries  : ${entries.length}`);
  for (const e of entries) console.log(`    - ${e}`);

  // --- Web Store readiness checklist ---
  const desc = manifest.description ?? '';
  const descLen = desc.length;
  const hasIcon128 = !!manifest.icons?.['128'] && fs.existsSync(path.join(EXT_DIR, manifest.icons['128']));
  const icon128OnDisk = fs.existsSync(path.join(EXT_DIR, 'icons', 'icon128.png'));

  console.log('');
  console.log('  Chrome Web Store checklist');
  console.log('  ──────────────────────────');
  console.log(`  [${icon128OnDisk ? 'x' : ' '}] 128px icon present on disk (extension/icons/icon128.png)`);
  console.log(
    `  [${hasIcon128 ? 'x' : ' '}] manifest "icons" maps 128 → file` +
      (hasIcon128 ? '' : '  ⚠ NOT YET in manifest — parent must merge the icons block'),
  );
  console.log(
    `  [${descLen > 0 && descLen <= MAX_DESCRIPTION ? 'x' : ' '}] manifest description ≤ ${MAX_DESCRIPTION} chars` +
      `  (current: ${descLen} chars)`,
  );

  console.log('');
  console.log('  Action items (NOT auto-checkable — do before submission):');
  console.log('  - [ ] At least 1 screenshot (1280×800 or 640×400), up to 5 — store listing');
  console.log('  - [ ] Small promo tile 440×280 (optional but recommended)');
  console.log(
    '  - [ ] Privacy policy URL — REQUIRED: the extension requests the "debugger" ' +
      'permission and host_permissions <all_urls>, both flagged as sensitive/powerful',
  );
  console.log(
    '  - [ ] Permission justifications in the dashboard for: ' +
      (manifest.permissions ?? []).join(', '),
  );
  console.log('  - [ ] Single-purpose description + category selected');
  console.log('  - [ ] Listing copy: detailed description, support email/site');

  if (descLen > MAX_DESCRIPTION) {
    console.error(`\n[pack] FAIL: description is ${descLen} chars (> ${MAX_DESCRIPTION}).`);
    process.exit(1);
  }
  console.log('\n[pack] done.');
}

try {
  main();
} catch (err) {
  console.error('[pack] FAILED:', err);
  process.exit(1);
}
