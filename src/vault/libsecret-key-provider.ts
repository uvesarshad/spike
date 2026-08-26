/* LibsecretKeyProvider — Linux-only KeyProvider backend.
 *
 * Stores the vault's 32-byte data-encryption key in the user's Secret
 * Service keyring (GNOME Keyring / KWallet / any libsecret-compatible
 * provider) via the `secret-tool` CLI — the Linux sibling of
 * DpapiKeyProvider (Windows) / KeychainKeyProvider (macOS). Same core rule
 * as those two: only base64 of the key ever crosses the shell, never raw
 * bytes or user text — but here `secret-tool store` DOES support reading the
 * secret from stdin, so the base64 token never appears in argv/process
 * listing at all (a strictly better position than the macOS `security` CLI,
 * which has no stdin form for its -w value).
 *
 * Desktop Linux without a running keyring daemon (headless boxes, minimal
 * window managers, containers) would fail at store/lookup time, so
 * isLibsecretAvailable() probes first — vault.ts's default-provider
 * selection uses it to fall back to FileKeyProvider rather than surfacing a
 * hard error on a machine that simply has no keyring.
 *
 * Secret Service item attributes: service "spike-vault", account "spike"
 * (mirrors the macOS -s/-a naming for this feature).
 *
 * Non-Linux: the constructor throws — callers (vault.ts) select
 * FileKeyProvider or KeychainKeyProvider off-Linux. */

import crypto from 'node:crypto';
import type { KeyProvider } from './vault.js';
import { runShell } from './shell-runner.js';

const KEY_BYTES = 32;
const ATTR_SERVICE = 'spike-vault';
const ATTR_ACCOUNT = 'spike';

/** Probe whether `secret-tool` is on PATH AND a keyring daemon is actually
 * reachable. A lookup for a name that (almost certainly) doesn't exist is
 * the cheapest side-effect-free probe: exit 1 ("not found") still means the
 * daemon answered, so that counts as available; ENOENT (no `secret-tool`
 * binary) or any other nonzero/crash means "don't trust this backend". */
export function isLibsecretAvailable(): boolean {
  if (process.platform !== 'linux') return false;
  const res = runShell('secret-tool', [
    'lookup',
    'service',
    'spike-vault-availability-probe',
    'account',
    '__spike_probe__',
  ]);
  if (res.spawnError) return false; // secret-tool not on PATH
  return res.status === 0 || res.status === 1;
}

/** libsecret/Secret-Service-backed KeyProvider (shells out to `secret-tool`). */
export class LibsecretKeyProvider implements KeyProvider {
  constructor() {
    if (process.platform !== 'linux') {
      throw new Error('LibsecretKeyProvider is Linux-only (libsecret). Use FileKeyProvider on this platform.');
    }
  }

  getKey(): Buffer {
    const existing = this.lookup();
    if (existing) {
      if (existing.length !== KEY_BYTES) {
        // wrong size — fail loudly rather than silently re-key (re-keying
        // would orphan the existing encrypted secrets), same stance as
        // FileKeyProvider/DpapiKeyProvider/KeychainKeyProvider.
        throw new Error(
          `LibsecretKeyProvider: key retrieved from libsecret is ${existing.length} bytes (expected ${KEY_BYTES}) — corrupt secret item`,
        );
      }
      return existing;
    }
    const key = crypto.randomBytes(KEY_BYTES);
    this.store(key);
    return key;
  }

  /** Look up the stored key. Returns undefined if there is no such item yet
   * (or secret-tool/the daemon is unavailable) — that's the "first use,
   * create it" path, not an error. */
  private lookup(): Buffer | undefined {
    const res = runShell('secret-tool', ['lookup', 'service', ATTR_SERVICE, 'account', ATTR_ACCOUNT]);
    if (res.spawnError || res.status !== 0) return undefined;
    const b64 = res.stdout.trim();
    if (!b64) return undefined;
    return Buffer.from(b64, 'base64');
  }

  private store(key: Buffer): void {
    const b64 = key.toString('base64');
    // `secret-tool store` reads the secret from stdin — the base64 key never
    // appears in argv/process listing at all.
    const res = runShell(
      'secret-tool',
      ['store', '--label=Spike vault key', 'service', ATTR_SERVICE, 'account', ATTR_ACCOUNT],
      b64,
    );
    if (res.spawnError) {
      throw new Error(
        `LibsecretKeyProvider: could not run secret-tool (${res.spawnError.message}). ` +
          `libsecret key backend needs secret-tool (libsecret-tools) on PATH and a running keyring daemon; ` +
          `set a vault dir with an existing key.bin to use the file backend instead.`,
      );
    }
    if (res.status !== 0) {
      const stderr = res.stderr.trim();
      throw new Error(
        `LibsecretKeyProvider: secret-tool store exited ${res.status}` + (stderr ? `: ${stderr}` : ''),
      );
    }
  }
}
