// Zero-dep PNG icon generator (pattern borrowed from the tally PWA):
// deep violet field with a radial glow, a chalk crystal-ball ring, and a
// brass tick stroke inside it.
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

function png(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const FIELD = hex("#1d1833");
const GLOW = hex("#3a2d6e");
const CHALK = hex("#efeaff");
const BRASS = hex("#e5b04a");

const distSeg = (px, py, x1, y1, x2, y2) => {
  const dx = x2 - x1, dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
};

function draw(size) {
  const px = Buffer.alloc(size * size * 4);
  const u = size / 512;
  const cx = 256 * u, cy = 244 * u, R = 150 * u;
  const ring = 22 * u, w = 24 * u;
  // tick inside the ball: (188,252)->(238,304)->(330,196) in 512 space
  const t1 = [188 * u, 252 * u, 238 * u, 304 * u];
  const t2 = [238 * u, 304 * u, 330 * u, 196 * u];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const d = Math.hypot(x - size / 2, y - size / 2) / (size / 2);
      const mix = Math.max(0, 1 - d * d);
      let [r, g, b] = [0, 1, 2].map((k) => Math.round(FIELD[k] + (GLOW[k] - FIELD[k]) * mix));
      const dc = Math.hypot(x - cx, y - cy);
      const ringDist = Math.abs(dc - R);
      if (ringDist < ring) {
        const edge = Math.min(1, (ring - ringDist) / (2 * u));
        [r, g, b] = [0, 1, 2].map((k) => Math.round(r + (CHALK[k] - r) * edge * 0.95));
      }
      const dt = Math.min(distSeg(x, y, ...t1), distSeg(x, y, ...t2));
      if (dt < w && dc < R - ring) {
        const edge = Math.min(1, (w - dt) / (2 * u));
        [r, g, b] = [0, 1, 2].map((k) => Math.round(r + (BRASS[k] - r) * edge));
      }
      px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
    }
  }
  return px;
}

mkdirSync(new URL("../icons/", import.meta.url), { recursive: true });
for (const size of [192, 512]) {
  writeFileSync(new URL(`../icons/icon-${size}.png`, import.meta.url), png(size, draw(size)));
}
writeFileSync(new URL("../icons/apple-touch-icon.png", import.meta.url), png(180, draw(180)));
console.log("icons written");
