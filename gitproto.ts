// Git wire helpers: pkt-line framing, packfile read/write, delta application.
// No deltas are ever written; packs carry plain zlib-compressed objects.
import { inflateSync, deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { sha1Object, type GitObject, type ObjType } from './store.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export function pktLine(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = payload.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), payload]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function encodePktLines(items: Array<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const it of items) {
    if (it === 'flush') parts.push(pktFlush());
    else if (it === 'delim') parts.push(pktDelim());
    else parts.push(pktLine(it));
  }
  return Buffer.concat(parts);
}

export type Pkt =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

export function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const hex = buf.subarray(i, i + 4).toString('ascii');
    const len = parseInt(hex, 16);
    if (Number.isNaN(len)) break;
    if (len === 0) { out.push({ kind: 'flush' }); i += 4; continue; }
    if (len === 1) { out.push({ kind: 'delim' }); i += 4; continue; }
    if (len === 2) { out.push({ kind: 'response-end' }); i += 4; continue; }
    if (i + len > buf.length) break;
    out.push({ kind: 'data', payload: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return out;
}

// Split a packfile body into its data packets (ignoring flush/delim), for receive-pack.
export function sidebandWrap(band: number, data: Buffer): Buffer {
  const parts: Buffer[] = [];
  const max = 65515; // pkt-line payload max 65516 incl. the band byte
  for (let i = 0; i < data.length; i += max) {
    const chunk = data.subarray(i, Math.min(data.length, i + max));
    parts.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  if (data.length === 0) parts.push(pktLine(Buffer.from([band])));
  return Buffer.concat(parts);
}

const OBJ_TYPE_NUM: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag', 6: 'ofs-delta', 7: 'ref-delta' };
const OBJ_NUM_TYPE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4, 'ofs-delta': 6, 'ref-delta': 7 };

function readVarint(buf: Buffer, off: number): { value: number; next: number } {
  let value = buf[off] & 0x7f;
  let shift = 7;
  let i = off + 1;
  while (buf[off] & 0x80) {
    value |= (buf[i] & 0x7f) << shift;
    shift += 7;
    i += 1;
    if (!(buf[i - 1] & 0x80)) break;
  }
  return { value, next: i };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let p = 0;
  const readDeltaVarint = (): number => {
    let v = 0;
    let s = 0;
    while (true) {
      const b = delta[p++];
      v |= (b & 0x7f) << s;
      s += 7;
      if (!(b & 0x80)) break;
    }
    return v;
  };
  const srcSize = readDeltaVarint();
  const tgtSize = readDeltaVarint();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let total = 0;
  while (p < delta.length) {
    const op = delta[p++];
    if (op & 0x80) {
      let off = 0;
      let size = 0;
      for (let i = 0; i < 4; i++) if (op & (1 << i)) off |= delta[p++] << (8 * i);
      for (let i = 0; i < 3; i++) if (op & (0x10 << i)) size |= delta[p++] << (8 * i);
      if (size === 0) size = 0x10000;
      out.push(base.subarray(off, off + size));
      total += size;
    } else if (op) {
      out.push(delta.subarray(p, p + op));
      p += op;
      total += op;
    } else {
      throw new Error('delta op 0');
    }
  }
  const res = Buffer.concat(out);
  if (res.length !== tgtSize || total !== tgtSize) throw new Error('delta size mismatch');
  return res;
}

export interface PackReadResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

export function verifyPackChecksum(pack: Buffer): { ok: boolean; expected: string; actual: string } {
  if (pack.length < 32) return { ok: false, expected: '', actual: '' };
  const expected = pack.subarray(pack.length - 20).toString('hex');
  const actual = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
  return { ok: expected === actual, expected, actual };
}

export function readPack(
  pack: Buffer,
  resolveBase?: (oid: string) => GitObject | undefined,
): PackReadResult {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const rawByOffset = new Map<number, GitObject>();
  let deltaCount = 0;
  let off = 12;
  const end = pack.length - 20;
  for (let n = 0; n < count; n++) {
    const entryStart = off;
    const first = pack[off];
    const typeNum = (first >> 4) & 0x7;
    let size = first & 0x0f;
    let shift = 4;
    off += 1;
    while (first & 0x80 || pack[off - 1] & 0x80) {
      const b = pack[off];
      size |= (b & 0x7f) << shift;
      shift += 7;
      off += 1;
      if (!(b & 0x80)) break;
    }
    let baseOid: string | null = null;
    let baseOffset: number | null = null;
    if (typeNum === 6) {
      // OFS_DELTA: negative offset varint
      let b = pack[off++];
      let baseOff = b & 0x7f;
      while (b & 0x80) {
        b = pack[off++];
        baseOff = ((baseOff + 1) << 7) | (b & 0x7f);
      }
      baseOffset = entryStart - baseOff;
    } else if (typeNum === 7) {
      baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
    }
    const inflated = inflateSync(pack.subarray(off));
    // Find how many bytes the zlib stream consumed: re-inflate with a probe.
    // Node's inflateSync consumes the whole slice; measure by deflating lengths:
    // instead, scan using zlib inflate with explicit window via incremental approach.
    const consumed = zlibConsumed(pack.subarray(off), inflated.length);
    off += consumed;
    const typeName = OBJ_TYPE_NUM[typeNum];
    if (!typeName) throw new Error(`unknown pack object type ${typeNum}`);
    if (typeName === 'ofs-delta' || typeName === 'ref-delta') {
      deltaCount += 1;
      let base: GitObject | undefined;
      if (baseOffset !== null) base = rawByOffset.get(baseOffset);
      else if (baseOid) base = objects.get(baseOid) ?? resolveBase?.(baseOid);
      if (!base) throw new Error('delta base not found');
      const data = applyDelta(base.data, inflated);
      const oid = sha1Object(base.type, data);
      const obj: GitObject = { type: base.type, data };
      objects.set(oid, obj);
      rawByOffset.set(entryStart, obj);
    } else {
      if (inflated.length !== size) throw new Error('object size mismatch');
      const oid = sha1Object(typeName as ObjType, inflated);
      const obj: GitObject = { type: typeName as ObjType, data: inflated };
      objects.set(oid, obj);
      rawByOffset.set(entryStart, obj);
    }
    void end;
  }
  return { objects, deltaCount };
}

// How many bytes of `compressed` the zlib stream for `expectedSize` output occupies.
// Determined by trial: inflate prefixes until the output length matches.
function zlibConsumed(compressed: Buffer, expectedSize: number): number {
  let lo = 1;
  let hi = compressed.length;
  // Binary search on the assumption that a longer prefix inflates to >= output.
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    try {
      const out = inflateSync(compressed.subarray(0, mid));
      if (out.length >= expectedSize) hi = mid;
      else lo = mid + 1;
    } catch {
      lo = mid + 1;
    }
  }
  return lo;
}

export function writePack(objects: GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    const typeNum = OBJ_NUM_TYPE[obj.type];
    const size = obj.data.length;
    const bytes: number[] = [];
    let s = size;
    let first = (typeNum << 4) | (s & 0x0f);
    s >>= 4;
    if (s > 0) first |= 0x80;
    bytes.push(first);
    while (s > 0) {
      let b = s & 0x7f;
      s >>= 7;
      if (s > 0) b |= 0x80;
      bytes.push(b);
    }
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}
