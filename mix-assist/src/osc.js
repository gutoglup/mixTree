// Codec OSC 1.0 (tipos i, f, s, b), lei de fader da X32 e blobs de meters.

export function pad2(n) {
  return String(n).padStart(2, '0');
}

function oscString(str) {
  const raw = Buffer.from(str + '\0', 'utf8');
  const len = Math.ceil(raw.length / 4) * 4;
  const out = Buffer.alloc(len);
  raw.copy(out);
  return out;
}

function oscBlob(buf) {
  const len = Math.ceil(buf.length / 4) * 4;
  const out = Buffer.alloc(4 + len);
  out.writeInt32BE(buf.length, 0);
  buf.copy(out, 4);
  return out;
}

export function encode(address, args = []) {
  let tags = ',';
  const parts = [];
  for (const a of args) {
    if (Buffer.isBuffer(a)) {
      tags += 'b';
      parts.push(oscBlob(a));
    } else if (typeof a === 'string') {
      tags += 's';
      parts.push(oscString(a));
    } else if (a && typeof a === 'object' && a.type === 'i') {
      tags += 'i';
      const b = Buffer.alloc(4);
      b.writeInt32BE(a.value | 0, 0);
      parts.push(b);
    } else if (a && typeof a === 'object' && a.type === 'f') {
      tags += 'f';
      const b = Buffer.alloc(4);
      b.writeFloatBE(a.value, 0);
      parts.push(b);
    } else if (a && typeof a === 'object' && a.type === 's') {
      tags += 's';
      parts.push(oscString(String(a.value)));
    } else if (typeof a === 'number') {
      tags += 'f';
      const b = Buffer.alloc(4);
      b.writeFloatBE(a, 0);
      parts.push(b);
    } else {
      throw new Error(`Tipo OSC não suportado: ${a}`);
    }
  }
  return Buffer.concat([oscString(address), oscString(tags), ...parts]);
}

function readString(buf, offset) {
  let end = offset;
  while (end < buf.length && buf[end] !== 0) end++;
  const str = buf.toString('utf8', offset, end);
  const next = Math.ceil((end + 1) / 4) * 4;
  return [str, next];
}

export function decode(buf) {
  let [address, off] = readString(buf, 0);
  const args = [];
  if (off >= buf.length) return { address, args };
  let tags;
  [tags, off] = readString(buf, off);
  if (!tags.startsWith(',')) return { address, args };
  for (const t of tags.slice(1)) {
    if (t === 'i') {
      args.push(buf.readInt32BE(off));
      off += 4;
    } else if (t === 'f') {
      args.push(buf.readFloatBE(off));
      off += 4;
    } else if (t === 's') {
      let s;
      [s, off] = readString(buf, off);
      args.push(s);
    } else if (t === 'b') {
      const len = buf.readInt32BE(off);
      off += 4;
      args.push(buf.subarray(off, off + len));
      off += Math.ceil(len / 4) * 4;
    } else {
      throw new Error(`Tag OSC não suportada: ${t}`);
    }
  }
  return { address, args };
}

// Lei de fader da X32: float 0..1 <-> dB
export function faderToDb(f) {
  if (f >= 0.5) return f * 40 - 30;
  if (f >= 0.25) return f * 80 - 50;
  if (f >= 0.0625) return f * 160 - 70;
  if (f <= 0) return -90;
  return f * 480 - 90;
}

export function dbToFader(db) {
  let f;
  if (db >= -10) f = (db + 30) / 40;
  else if (db >= -30) f = (db + 50) / 80;
  else if (db >= -60) f = (db + 70) / 160;
  else if (db > -90) f = (db + 90) / 480;
  else f = 0;
  f = Math.min(1, Math.max(0, f));
  return Math.round(f * 1023) / 1023;
}

// Blob de meters: int32 LE com a quantidade + floats LE lineares
export function decodeMeterBlob(blob) {
  if (!blob || blob.length < 4) return [];
  const count = blob.readInt32LE(0);
  const n = Math.min(count, Math.floor((blob.length - 4) / 4));
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = blob.readFloatLE(4 + i * 4);
  return out;
}

export function encodeMeterBlob(values) {
  const buf = Buffer.alloc(4 + values.length * 4);
  buf.writeInt32LE(values.length, 0);
  values.forEach((v, i) => buf.writeFloatLE(v, 4 + i * 4));
  return buf;
}

export function linToDb(v) {
  if (!(v > 1e-6)) return -120;
  return 20 * Math.log10(v);
}

export function dbToLin(db) {
  return Math.pow(10, db / 20);
}
