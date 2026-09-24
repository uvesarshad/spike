/* A14: authenticator-app codes (RFC 6238 TOTP: HMAC-SHA1, 30 s step, 6 digits)
 * computed locally from a base32 secret kept in the vault as TOTP_<NAME>.
 * `{{totp:NAME}}` in a typed value is swapped for the current code at type
 * time only; every record keeps the placeholder, never a code. */

import crypto from 'node:crypto';

export const TOTP_PLACEHOLDER_RE = /\{\{totp:([a-zA-Z0-9_-]+)\}\}/g;

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('authenticator secret is not valid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 6238 code for `nowMs`. `secret` is base32 unless `raw` is given. */
export function generateTotp(secretBase32: string, nowMs = Date.now(), opts: { digits?: number; stepSec?: number; raw?: Buffer } = {}): string {
  const digits = opts.digits ?? 6;
  const step = opts.stepSec ?? 30;
  const key = opts.raw ?? base32Decode(secretBase32);
  const counter = Math.floor(nowMs / 1000 / step);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(msg).digest();
  const off = h[h.length - 1]! & 0x0f;
  const bin = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!;
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export function hasTotpPlaceholder(text: string): boolean {
  TOTP_PLACEHOLDER_RE.lastIndex = 0;
  const has = TOTP_PLACEHOLDER_RE.test(text);
  TOTP_PLACEHOLDER_RE.lastIndex = 0;
  return has;
}

/** Replace each {{totp:NAME}} with the current code from vault secret TOTP_NAME.
 * Throws (message carries the `spike secret set` hint) when it is missing. */
export function resolveTotpPlaceholders(text: string, vault: { get(name: string): string | undefined; totpUnavailable?: string } | undefined, nowMs = Date.now()): string {
  if (!hasTotpPlaceholder(text)) return text;
  return text.replace(TOTP_PLACEHOLDER_RE, (_m, name: string) => {
    const secret = vault?.get(`TOTP_${name}`);
    if (secret === undefined) {
      if (vault?.totpUnavailable) throw new Error(vault.totpUnavailable);
      throw new Error(`secret "TOTP_${name}" not found — save the authenticator key from a terminal: spike secret set TOTP_${name} <base32-key>`);
    }
    return generateTotp(secret, nowMs);
  });
}
