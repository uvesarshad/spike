/* Secrets vault — Tier-4 guardrail: credentials live encrypted on-device and
 * the model NEVER sees them. Plaintext only ever exists in memory at execute
 * time (loop.ts resolves {{secret:NAME}} immediately before browser.type()).
 *
 * v1 storage: an AES-256-GCM blob at %LOCALAPPDATA%/qa-subagent-vault/secrets.enc,
 * with the 32-byte key in key.bin (created on first use). This is "encrypted at
 * rest, key on the same machine" — it protects the file if it's copied off the
 * box, not against a local attacker who can read both files. That tradeoff is
 * deliberate for v1.
 *
 * KEYCHAIN-SWAP SEAM: all key access goes through the KeyProvider interface
 * below. FileKeyProvider reads/writes key.bin; an OS-keychain backend (Windows
 * DPAPI / macOS Keychain / libsecret) implements the same { getKey(): Buffer }
 * contract and is injected via the Vault constructor — no change to the
 * encryption path or the public API. The first such backend, DpapiKeyProvider
 * (Windows DPAPI, no native deps), is now the DEFAULT on Windows — see the
 * provider-selection rule in the Vault constructor. KeychainKeyProvider
 * (macOS Keychain) and LibsecretKeyProvider (Linux Secret Service) are the
 * matching defaults on those platforms, when available (see
 * defaultKeyProvider() below). */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DpapiKeyProvider } from './dpapi-key-provider.js';
import { KeychainKeyProvider, isKeychainAvailable } from './keychain-key-provider.js';
import { LibsecretKeyProvider, isLibsecretAvailable } from './libsecret-key-provider.js';
import { migrateLegacyPath } from '../env-compat.js';

const ALGO = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;

/** `{ mode: 0o600 }` has no POSIX-permission effect on Windows — protection
 * there comes only from inherited NTFS folder ACLs. Lock the file down
 * explicitly: strip inheritance and grant Full Control to the current user
 * only. Best-effort — a failure here doesn't affect the vault's encryption,
 * only this extra layer of defense-in-depth on Windows (inherited ACLs remain
 * as the fallback, same as before). No-op on POSIX, where the mode bits above
 * already do the job. */
function lockdownWindowsAcl(filePath: string): void {
  if (process.platform !== 'win32') return;
  try {
    execFileSync('icacls', [filePath, '/inheritance:r', '/grant:r', `${os.userInfo().username}:F`], { stdio: 'pipe' });
  } catch { /* best-effort hardening only */ }
}

/** The key-management seam. Swap FileKeyProvider for an OS-keychain provider
 * later without touching the encryption path or the Vault public API. */
export interface KeyProvider {
  /** Return the 32-byte data-encryption key, creating it on first use. */
  getKey(): Buffer;
}

/** Default v1 provider: a random 32-byte key persisted at key.bin (mode 0600). */
export class FileKeyProvider implements KeyProvider {
  constructor(private readonly keyPath: string) {}

  getKey(): Buffer {
    if (fs.existsSync(this.keyPath)) {
      const key = fs.readFileSync(this.keyPath);
      if (key.length === KEY_BYTES) return key;
      // corrupt/short key file — fail loudly rather than silently re-keying
      // (re-keying would orphan the existing encrypted secrets).
      throw new Error(`vault key file ${this.keyPath} is corrupt (expected ${KEY_BYTES} bytes, got ${key.length})`);
    }
    const key = crypto.randomBytes(KEY_BYTES);
    fs.mkdirSync(path.dirname(this.keyPath), { recursive: true });
    fs.writeFileSync(this.keyPath, key, { mode: 0o600 });
    lockdownWindowsAcl(this.keyPath);
    return key;
  }
}

function defaultVaultDir(): string {
  const base = process.env.LOCALAPPDATA ?? process.env.HOME ?? '.';
  // pre-Spike dir was `qa-subagent-vault/` — moved once so stored API keys survive.
  return migrateLegacyPath(path.join(base, 'qa-subagent-vault'), path.join(base, 'spike-vault'));
}

export interface VaultOptions {
  /** Vault directory (default %LOCALAPPDATA%/qa-subagent-vault). */
  dir?: string;
  /** Key backend — when omitted, selected by platform/migration rule (see the
   * Vault constructor): DPAPI on Windows / Keychain on macOS / libsecret on
   * Linux for new vaults (when available), else FileKeyProvider. */
  keyProvider?: KeyProvider;
}

/** Pick the default key backend for a vault dir.
 *
 * MIGRATION RULE (back-compat is non-negotiable — existing secrets must stay
 * readable):
 *  - If a legacy <dir>/key.bin already exists, KEEP FileKeyProvider so secrets
 *    encrypted under that key still decrypt. We NEVER auto-migrate an existing
 *    vault onto a different backend, on ANY platform — that's the one rule
 *    every OS-native provider (DPAPI, Keychain, libsecret) is built around.
 *  - Else on Windows (win32), use DpapiKeyProvider — the wrapped key (key.dpapi)
 *    is bound to the Windows user account, a strict upgrade over a raw key.bin.
 *  - Else on macOS (darwin), use KeychainKeyProvider IF the `security` CLI is
 *    available (isKeychainAvailable()) — same strict-upgrade reasoning as
 *    DPAPI. If unavailable, fall back to FileKeyProvider rather than fail.
 *  - Else on Linux, use LibsecretKeyProvider IF `secret-tool` + a keyring
 *    daemon are reachable (isLibsecretAvailable()) — many desktop Linux boxes
 *    have one, but headless/minimal ones don't, so this is probed rather than
 *    assumed. If unavailable, fall back to FileKeyProvider rather than fail.
 *  - Else (no OS-native backend available, no key.bin), FileKeyProvider over
 *    key.bin (the universal cross-platform fallback). */
function defaultKeyProvider(dir: string): KeyProvider {
  const legacyKeyBin = path.join(dir, 'key.bin');
  if (fs.existsSync(legacyKeyBin)) return new FileKeyProvider(legacyKeyBin);
  if (process.platform === 'win32') return new DpapiKeyProvider(dir);
  if (process.platform === 'darwin' && isKeychainAvailable()) return new KeychainKeyProvider();
  if (process.platform === 'linux' && isLibsecretAvailable()) return new LibsecretKeyProvider();
  return new FileKeyProvider(legacyKeyBin);
}

/** File-based AES-256-GCM secrets store. Sync fs throughout — the secret set is
 * tiny and access is rare (interactive `spike secret …` + per-step resolution). */
export class Vault {
  private readonly dir: string;
  private readonly secretsPath: string;
  private readonly keyProvider: KeyProvider;

  constructor(opts: VaultOptions = {}) {
    this.dir = opts.dir ?? defaultVaultDir();
    this.secretsPath = path.join(this.dir, 'secrets.enc');
    this.keyProvider = opts.keyProvider ?? defaultKeyProvider(this.dir);
  }

  /** Decrypt the secrets map. {} when the file does not exist yet. */
  private read(): Record<string, string> {
    if (!fs.existsSync(this.secretsPath)) return {};
    const blob = fs.readFileSync(this.secretsPath);
    // layout: [12B iv][16B authTag][ciphertext]
    const iv = blob.subarray(0, IV_BYTES);
    const tag = blob.subarray(IV_BYTES, IV_BYTES + 16);
    const ciphertext = blob.subarray(IV_BYTES + 16);
    const decipher = crypto.createDecipheriv(ALGO, this.keyProvider.getKey(), iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plain.toString('utf8')) as Record<string, string>;
  }

  /** Encrypt + persist the secrets map (atomic-ish: write temp then rename). */
  private write(map: Record<string, string>): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGO, this.keyProvider.getKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(map), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const blob = Buffer.concat([iv, tag, ciphertext]);
    const tmp = this.secretsPath + '.tmp';
    fs.writeFileSync(tmp, blob, { mode: 0o600 });
    lockdownWindowsAcl(tmp);
    fs.renameSync(tmp, this.secretsPath);
  }

  set(name: string, value: string): void {
    const map = this.read();
    map[name] = value;
    this.write(map);
  }

  get(name: string): string | undefined {
    return this.read()[name];
  }

  list(): string[] {
    return Object.keys(this.read()).sort();
  }

  delete(name: string): boolean {
    const map = this.read();
    if (!(name in map)) return false;
    delete map[name];
    this.write(map);
    return true;
  }
}
