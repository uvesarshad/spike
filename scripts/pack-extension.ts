/* pack-extension.ts — produce dist/extension.zip from extension/* for the
 * Chrome Web Store, and print a submission checklist.
 *
 * Cross-platform with NO runtime zip dependency: on Windows we shell out to
 * PowerShell's Compress-Archive; on macOS/Linux we use the stock `zip`/`unzip`
 * CLIs (present by default on both). Either way the archive has the extension's
 * files at the ROOT (manifest.json at top level), which is what the Web Store
 * requires — never the parent folder.
 *
 *   npx tsx scripts/pack-extension.ts                    (default: <all_urls> build)
 *   npx tsx scripts/pack-extension.ts --variant activetab (narrowed activeTab fallback,
 *                                                          see docs/chrome-web-store-submission.md)
 *
 * VARIANTS (A15 store-rejection contingency, docs/plan/26-08-27-audit-market-readiness.md):
 * the default build ships extension/manifest.json (host_permissions <all_urls>, full
 * functionality). `--variant activetab` ships extension/manifest.activetab.json instead
 * (drops <all_urls>, adds activeTab) into dist/extension-activetab.zip. Because the two
 * manifests need different sw.js behavior (the activetab build must refuse to attach the
 * debugger to any tab other than the user-invoked current one — see MANIFEST_VARIANT in
 * sw.js), this build stages a COPY of extension/* in dist/.pack-stage-<variant>/, swaps in
 * the right manifest, and token-replaces the MANIFEST_VARIANT constant in the staged sw.js
 * before zipping the staging dir (not extension/ directly). The staging dir is removed
 * after zipping either way.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const IS_WINDOWS = process.platform === 'win32';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO = path.resolve(__dirname, '..');
const EXT_DIR = path.join(REPO, 'extension');
const DIST_DIR = path.join(REPO, 'dist');

const MAX_DESCRIPTION = 132; // Chrome Web Store hard cap

type Variant = 'default' | 'activetab';

interface VariantConfig {
  variant: Variant;
  /** Manifest source file (in extension/) to ship as manifest.json in the zip. */
  manifestSrc: string;
  /** Output zip filename under dist/. */
  zipName: string;
  /** Value substituted for MANIFEST_VARIANT in the staged sw.js. */
  swToken: string;
}

const VARIANTS: Record<Variant, VariantConfig> = {
  default: {
    variant: 'default',
    manifestSrc: path.join(EXT_DIR, 'manifest.json'),
    zipName: 'extension.zip',
    swToken: 'default',
  },
  activetab: {
    variant: 'activetab',
    manifestSrc: path.join(EXT_DIR, 'manifest.activetab.json'),
    zipName: 'extension-activetab.zip',
    swToken: 'activetab',
  },
};

/** Parse `--variant <name>` off argv. Defaults to 'default'; throws on an
 * unrecognized value so a typo fails loudly instead of silently shipping the
 * wrong build. Exported as a pure function so it's unit-testable in isolation
 * from the filesystem/zip side effects below. */
export function parseVariant(argv: string[]): Variant {
  const idx = argv.indexOf('--variant');
  if (idx === -1) return 'default';
  const value = argv[idx + 1];
  if (value !== 'default' && value !== 'activetab') {
    throw new Error(`--variant must be "default" or "activetab" (got: ${value ?? '<missing>'})`);
  }
  return value;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** Stage a variant-specific copy of extension/* under dist/.pack-stage-<variant>/:
 * the right manifest.json, and sw.js with MANIFEST_VARIANT substituted. Both
 * manifest.json and manifest.activetab.json are excluded from the raw copy so
 * the correct single manifest.json can be written in explicitly (a Web Store
 * zip must not ship the other variant's manifest file alongside it). */
function stageVariant(cfg: VariantConfig): string {
  const stageDir = path.join(DIST_DIR, `.pack-stage-${cfg.variant}`);
  if (fs.existsSync(stageDir)) fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });

  fs.cpSync(EXT_DIR, stageDir, {
    recursive: true,
    filter: (src) => {
      const base = path.basename(src);
      return base !== 'manifest.json' && base !== 'manifest.activetab.json';
    },
  });

  fs.copyFileSync(cfg.manifestSrc, path.join(stageDir, 'manifest.json'));

  const swPath = path.join(stageDir, 'sw.js');
  const swSrc = fs.readFileSync(swPath, 'utf8');
  const swTokenPattern = /const MANIFEST_VARIANT = '[^']*';/;
  if (!swTokenPattern.test(swSrc)) {
    throw new Error(`sw.js is missing the "const MANIFEST_VARIANT = '...';" marker pack-extension.ts substitutes`);
  }
  fs.writeFileSync(swPath, swSrc.replace(swTokenPattern, `const MANIFEST_VARIANT = '${cfg.swToken}';`));

  return stageDir;
}

/** Zip srcDir CONTENTS (manifest.json at the archive root) to zipPath. Dispatches
 * to the platform's stock tooling — no runtime dependency. */
function compress(srcDir: string, zipPath: string): void {
  if (fs.existsSync(zipPath)) fs.rmSync(zipPath);
  if (IS_WINDOWS) {
    // Compress-Archive with `srcDir/*` puts the contents (not the folder) at root.
    const ps = [
      `$ErrorActionPreference = 'Stop'`,
      `Compress-Archive -Path '${path.join(srcDir, '*')}' -DestinationPath '${zipPath}' -CompressionLevel Optimal -Force`,
    ].join('; ');
    const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' });
    if (res.status !== 0) {
      throw new Error(`Compress-Archive failed (exit ${res.status}):\n${res.stderr || res.stdout}`);
    }
    return;
  }
  // macOS/Linux: run `zip` with cwd = srcDir so stored paths are relative to it
  // (root-level manifest.json). -r recurse, -X drop extra OS attrs, -q quiet.
  const res = spawnSync('zip', ['-r', '-X', '-q', zipPath, '.'], { cwd: srcDir, encoding: 'utf8' });
  if (res.error && (res.error as NodeJS.ErrnoException).code === 'ENOENT') {
    throw new Error("`zip` CLI not found. Install it (macOS ships it; Linux: apt/dnf install zip) or run this on Windows.");
  }
  if (res.status !== 0) {
    throw new Error(`zip failed (exit ${res.status}):\n${res.stderr || res.stdout}`);
  }
}

/** List archive entries to show what shipped — stock tooling per platform. */
function listZipEntries(zipPath: string): string[] {
  if (IS_WINDOWS) {
    const ps = [
      `$ErrorActionPreference = 'Stop'`,
      `Add-Type -AssemblyName System.IO.Compression.FileSystem`,
      `$z = [System.IO.Compression.ZipFile]::OpenRead('${zipPath}')`,
      `$z.Entries | ForEach-Object { $_.FullName }`,
      `$z.Dispose()`,
    ].join('; ');
    const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' });
    if (res.status !== 0) return [];
    return res.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  }
  // unzip -Z1 = one bare entry name per line.
  const res = spawnSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' });
  if (res.status !== 0) return [];
  return res.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

function main(): void {
  const variant = parseVariant(process.argv.slice(2));
  const cfg = VARIANTS[variant];

  if (!fs.existsSync(cfg.manifestSrc)) {
    throw new Error(`manifest not found at ${cfg.manifestSrc}`);
  }
  fs.mkdirSync(DIST_DIR, { recursive: true });

  const manifest = JSON.parse(fs.readFileSync(cfg.manifestSrc, 'utf8')) as {
    description?: string;
    permissions?: string[];
    host_permissions?: string[];
    icons?: Record<string, string>;
  };

  const zipPath = path.join(DIST_DIR, cfg.zipName);

  console.log(
    `[pack] variant=${cfg.variant} — staging ${path.relative(REPO, cfg.manifestSrc)} → ` +
      `${path.relative(REPO, zipPath)} …`,
  );

  const stageDir = stageVariant(cfg);
  try {
    compress(stageDir, zipPath);
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }

  const size = fs.statSync(zipPath).size;
  const entries = listZipEntries(zipPath);

  console.log('');
  console.log(`  zip path : ${zipPath}`);
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
  const sensitivePerms = [
    ...(manifest.permissions ?? []),
    ...(manifest.host_permissions ?? []),
  ];
  console.log(
    '  - [ ] Privacy policy URL — REQUIRED: the extension requests the "debugger" ' +
      `permission${manifest.host_permissions?.length ? ' and host_permissions <all_urls>' : ' (activeTab-narrowed build — no host_permissions)'}, flagged as sensitive/powerful`,
  );
  console.log('  - [ ] Permission justifications in the dashboard for: ' + sensitivePerms.join(', '));
  console.log('  - [ ] Single-purpose description + category selected');
  console.log('  - [ ] Listing copy: detailed description, support email/site');

  if (descLen > MAX_DESCRIPTION) {
    console.error(`\n[pack] FAIL: description is ${descLen} chars (> ${MAX_DESCRIPTION}).`);
    process.exit(1);
  }
  console.log('\n[pack] done.');
}

// Only run when executed directly (tsx scripts/pack-extension.ts / node …) — not
// when parseVariant is imported for a unit test.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  try {
    main();
  } catch (err) {
    console.error('[pack] FAILED:', err);
    process.exit(1);
  }
}
