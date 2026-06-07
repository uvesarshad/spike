/* DpapiKeyProvider — Windows-only KeyProvider backend.
 *
 * Wraps the vault's 32-byte data-encryption key with the Windows Data
 * Protection API (DPAPI, CurrentUser scope) so the key at rest is bound to the
 * logged-in Windows user account — a copy of key.dpapi off the box (or read by
 * a different user) cannot be unwrapped. This is a strict upgrade over
 * FileKeyProvider's key.bin, which stores the raw key in a 0600 file.
 *
 * NO NATIVE DEPS: we don't bind to dpapi.dll via FFI. Instead we shell out to
 * PowerShell and call [Security.Cryptography.ProtectedData]::Protect/Unprotect
 * from System.Security. The only data that crosses the shell is base64 (the
 * wrapped/unwrapped key blob) — never any user text — so the command string is
 * a fixed template with a single base64 token interpolated, sidestepping the
 * PowerShell quoting traps entirely.
 *
 * Disk layout: <dir>/key.dpapi — base64 of the DPAPI-protected 32-byte key.
 * getKey(): unwrap key.dpapi if present; else generate 32 random bytes, wrap,
 * write (0600), return.
 *
 * Non-Windows: the constructor throws — callers (vault.ts) select FileKeyProvider
 * off-Windows. */

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { KeyProvider } from './vault.js';

const KEY_BYTES = 32;
const SCOPE = 'CurrentUser';

/** Run a fixed PowerShell command whose ONLY variable input is one base64 token.
 * Returns trimmed stdout. Throws an actionable error on spawn/exec failure. */
function runPowerShell(command: string): string {
  const res = spawnSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', command],
    { encoding: 'utf8', windowsHide: true },
  );
  if (res.error) {
    // ENOENT etc. — powershell not on PATH (e.g. a stripped Windows image).
    throw new Error(
      `DpapiKeyProvider: could not run powershell (${res.error.message}). ` +
        `DPAPI key backend needs Windows PowerShell on PATH; set a vault dir with an existing key.bin to use the file backend instead.`,
    );
  }
  if (res.status !== 0) {
    const stderr = (res.stderr ?? '').toString().trim();
    throw new Error(
      `DpapiKeyProvider: powershell exited ${res.status} during DPAPI operation` +
        (stderr ? `: ${stderr}` : ''),
    );
  }
  return (res.stdout ?? '').toString().trim();
}

/** DPAPI-wrap raw bytes → base64 of the protected blob. */
function protect(raw: Buffer): string {
  const b64 = raw.toString('base64');
  const cmd =
    `Add-Type -AssemblyName System.Security; ` +
    `[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect(` +
    `[Convert]::FromBase64String('${b64}'), $null, '${SCOPE}'))`;
  const out = runPowerShell(cmd);
  if (!out) throw new Error('DpapiKeyProvider: Protect returned empty output');
  return out;
}

/** DPAPI-unwrap base64 of a protected blob → raw bytes. */
function unprotect(protectedB64: string): Buffer {
  const cmd =
    `Add-Type -AssemblyName System.Security; ` +
    `[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect(` +
    `[Convert]::FromBase64String('${protectedB64}'), $null, '${SCOPE}'))`;
  const out = runPowerShell(cmd);
  if (!out) throw new Error('DpapiKeyProvider: Unprotect returned empty output (corrupt or foreign key.dpapi?)');
  return Buffer.from(out, 'base64');
}

/** Windows DPAPI (CurrentUser) backed key provider — no native deps, via PowerShell. */
export class DpapiKeyProvider implements KeyProvider {
  private readonly keyPath: string;

  /** @param dir vault directory; the wrapped key lives at <dir>/key.dpapi. */
  constructor(dir: string) {
    if (process.platform !== 'win32') {
      throw new Error(
        'DpapiKeyProvider is Windows-only (DPAPI). Use FileKeyProvider on this platform.',
      );
    }
    this.keyPath = path.join(dir, 'key.dpapi');
  }

  getKey(): Buffer {
    if (fs.existsSync(this.keyPath)) {
      const protectedB64 = fs.readFileSync(this.keyPath, 'utf8').trim();
      const key = unprotect(protectedB64);
      if (key.length !== KEY_BYTES) {
        // unwrapped to the wrong size — fail loudly rather than silently re-key
        // (re-keying would orphan the existing encrypted secrets).
        throw new Error(
          `DpapiKeyProvider: unwrapped key from ${this.keyPath} is ${key.length} bytes (expected ${KEY_BYTES}) — corrupt key file`,
        );
      }
      return key;
    }
    const key = crypto.randomBytes(KEY_BYTES);
    const protectedB64 = protect(key);
    fs.mkdirSync(path.dirname(this.keyPath), { recursive: true });
    fs.writeFileSync(this.keyPath, protectedB64, { mode: 0o600 });
    return key;
  }
}
