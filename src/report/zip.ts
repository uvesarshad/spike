/* A15 (P1) — a minimal ZIP writer, so "Send to my developer" is one file.
 *
 * A run's evidence is a report and a handful of PNGs (and sometimes a clip).
 * Handing someone six separate downloads is not "send this to your developer",
 * so they need to arrive as one archive. Nothing in the tree could write one,
 * and pulling in a zip dependency would have to be carried by BOTH the Node
 * build and the browser bundle the extension ships.
 *
 * So: ~90 lines, STORED entries only (no compression). Everything going in is
 * already compressed — PNG, MP4/WebM — so deflating would cost CPU in a
 * service worker to save nothing, and the report JSON is small. Pure
 * Uint8Array in, Uint8Array out: no node:zlib, no Buffer, no fs, so the same
 * function serves the desktop helper and the in-browser engine.
 *
 * Deliberately not a general-purpose zip library: no reading, no ZIP64 (an
 * evidence bundle is megabytes, not gigabytes), no directory entries.
 */

/** One file in the archive. `path` may contain forward slashes. */
export interface ZipEntry {
  path: string;
  data: Uint8Array;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** UTF-8 bytes, without depending on Buffer (the browser bundle has no Node). */
function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

class ByteWriter {
  private chunks: Uint8Array[] = [];
  length = 0;

  push(bytes: Uint8Array): void {
    this.chunks.push(bytes);
    this.length += bytes.length;
  }

  u16(n: number): void {
    this.push(new Uint8Array([n & 0xff, (n >>> 8) & 0xff]));
  }

  u32(n: number): void {
    this.push(new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]));
  }

  concat(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const c of this.chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }
}

/** Build a STORED zip archive. Entries with an empty path are skipped; a
 * duplicate path would produce a valid but confusing archive, so the LAST one
 * wins and earlier duplicates are dropped. */
export function makeZip(entries: ZipEntry[]): Uint8Array {
  const seen = new Map<string, ZipEntry>();
  for (const e of entries) {
    const path = e.path.replace(/^[/\\]+/, '').replace(/\\/g, '/');
    if (!path) continue;
    seen.set(path, { path, data: e.data });
  }
  const files = [...seen.values()];

  const body = new ByteWriter();
  const central = new ByteWriter();
  // A fixed timestamp: the archive is evidence, and a stable one makes two
  // bundles of the same run byte-identical. 1980-01-01, the DOS epoch.
  const dosTime = 0;
  const dosDate = 0x0021;

  for (const f of files) {
    const name = utf8(f.path);
    const crc = crc32(f.data);
    const offset = body.length;

    body.u32(0x04034b50); // local file header
    body.u16(20); // version needed
    body.u16(0x0800); // flags: UTF-8 names
    body.u16(0); // method: stored
    body.u16(dosTime);
    body.u16(dosDate);
    body.u32(crc);
    body.u32(f.data.length);
    body.u32(f.data.length);
    body.u16(name.length);
    body.u16(0); // extra len
    body.push(name);
    body.push(f.data);

    central.u32(0x02014b50); // central directory header
    central.u16(20); // version made by
    central.u16(20); // version needed
    central.u16(0x0800);
    central.u16(0);
    central.u16(dosTime);
    central.u16(dosDate);
    central.u32(crc);
    central.u32(f.data.length);
    central.u32(f.data.length);
    central.u16(name.length);
    central.u16(0); // extra
    central.u16(0); // comment
    central.u16(0); // disk start
    central.u16(0); // internal attrs
    central.u32(0); // external attrs
    central.u32(offset);
    central.push(name);
  }

  const cdOffset = body.length;
  const cd = central.concat();
  const out = new ByteWriter();
  out.push(body.concat());
  out.push(cd);
  out.u32(0x06054b50); // end of central directory
  out.u16(0); // this disk
  out.u16(0); // disk with cd
  out.u16(files.length);
  out.u16(files.length);
  out.u32(cd.length);
  out.u32(cdOffset);
  out.u16(0); // comment len
  return out.concat();
}
