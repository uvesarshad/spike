/* KeychainKeyProvider — macOS-only KeyProvider backend.
 *
 * Stores the vault's 32-byte data-encryption key as a generic-password item
 * in the user's login Keychain via the `security` CLI (no native deps / no
 * node-keytar) — a strict upgrade over FileKeyProvider's key.bin, which
 * stores the raw key in a 0600 file readable by anything running as that
 * user. This is the darwin sibling of DpapiKeyProvider (see
 * dpapi-key-provider.ts) and follows the same core rule: only base64 of the
 * key ever crosses the shell, never raw bytes or user text.
 *
 * `security add-generic-password` has no stdin form for the -w (password)
 * value — unlike `secret-tool store` on Linux — so the base64 token is
 * passed as a fixed-shape argv value, the same tradeoff DpapiKeyProvider
 * already accepts for its base64 blob (see dpapi-key-provider.ts's header
 * comment). It is base64, never raw/secret-shaped binary, so it can't break
 * argv quoting or embed control bytes.
 *
 * Keychain item: service "spike-vault", account "spike" (per the -s/-a
 * flags specified for this feature). `-U` on add-generic-password means
 * "update if it already exists" so re-running store is idempotent.
 *
 * Non-macOS: the constructor throws — callers (vault.ts) select
 * FileKeyProvider or LibsecretKeyProvider off-Darwin. */

import crypto from 'node:crypto';
import type { KeyProvider } from './vault.js';
import { runShell } from './shell-runner.js';

const KEY_BYTES = 32;
const SERVICE = 'spike-vault';
const ACCOUNT = 'spike';

/** Probe whether the macOS `security` CLI is present and runnable. Always
 * false off-Darwin. Used by vault.ts's default-provider selection so a
 * missing/broken `security` binary falls back to FileKeyProvider instead of
 * failing loudly later at getKey() time. */
export function isKeychainAvailable(): boolean {
  if (process.platform !== 'darwin') return false;
  // `security list-keychains` is a cheap, side-effect-free call that just
  // needs `security` to exist and run — it doesn't touch spike's own item.
  const res = runShell('security', ['list-keychains']);
  if (res.spawnError) return false; // ENOENT — security not on PATH
  return res.status === 0;
}

/** macOS Keychain-backed KeyProvider (shells out to `security`). */
export class KeychainKeyProvider implements KeyProvider {
  constructor() {
    if (process.platform !== 'darwin') {
      throw new Error('KeychainKeyProvider is macOS-only (Keychain). Use FileKeyProvider on this platform.');
    }
  }

  getKey(): Buffer {
    const existing = this.find();
    if (existing) {
      if (existing.length !== KEY_BYTES) {
        // wrong size — fail loudly rather than silently re-key (re-keying
        // would orphan the existing encrypted secrets), same stance as
        // FileKeyProvider/DpapiKeyProvider.
        throw new Error(
          `KeychainKeyProvider: key retrieved from Keychain is ${existing.length} bytes (expected ${KEY_BYTES}) — corrupt keychain item`,
        );
      }
      return existing;
    }
    const key = crypto.randomBytes(KEY_BYTES);
    this.store(key);
    return key;
  }

  /** Look up the stored key. Returns undefined if there is no such item yet
   * (or `security` is unavailable) — that's the "first use, create it" path,
   * not an error. */
  private find(): Buffer | undefined {
    const res = runShell('security', ['find-generic-password', '-a', ACCOUNT, '-s', SERVICE, '-w']);
    if (res.spawnError || res.status !== 0) return undefined;
    const b64 = res.stdout.trim();
    if (!b64) return undefined;
    return Buffer.from(b64, 'base64');
  }

  private store(key: Buffer): void {
    const b64 = key.toString('base64');
    const res = runShell('security', ['add-generic-password', '-U', '-a', ACCOUNT, '-s', SERVICE, '-w', b64]);
    if (res.spawnError) {
      throw new Error(
        `KeychainKeyProvider: could not run security (${res.spawnError.message}). ` +
          `Keychain key backend needs the macOS security CLI on PATH; set a vault dir with an existing key.bin to use the file backend instead.`,
      );
    }
    if (res.status !== 0) {
      const stderr = res.stderr.trim();
      throw new Error(
        `KeychainKeyProvider: security add-generic-password exited ${res.status}` + (stderr ? `: ${stderr}` : ''),
      );
    }
  }
}
