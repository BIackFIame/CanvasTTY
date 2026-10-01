// Small valid RGBA PNGs for importer tests. The built-in theme art ships as AVIF, while imported themes are PNG,
// so tests build their own PNG input: a transparent frame-sized image with one opaque pixel whose colour is `seed`
// (different seeds give different files).
import { deflateSync } from "node:zlib";

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function chunk(kind, data) {
  const body = Buffer.concat([Buffer.from(kind, "ascii"), data]);
  let crc = 0xffffffff;
  for (const byte of body) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + data.length);
  return out;
}

export function testPng({ width = 1536, height = 1024, seed = 1 } = {}) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  const pixel = Math.floor(height / 2) * stride + 1 + Math.floor(width / 2) * 4;
  raw[pixel] = seed & 0xff;
  raw[pixel + 1] = (seed >> 8) & 0xff;
  raw[pixel + 2] = 0x80;
  raw[pixel + 3] = 0xff;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}
