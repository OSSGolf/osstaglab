#!/usr/bin/env node
// Render a band-limited spectrogram of one capture to a PNG (no dependencies).
// Time runs left to right at 1 px per hop; frequency runs bottom to top, `rowPx` px per bin.
// Usage: node tools/spectro.mjs <in.wav> <out.png> [loHz=17000] [hiHz=20500]
//          [floorDb=-115] [ceilDb=-55] [fft=1024] [hopMs=2.5] [rowPx=4]
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { decodeWav, stft, bandIndices, colorLUT } from '../web/dsp.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(zlib.crc32(body), body.length + 4);
  return out;
}

/** Encode 8-bit RGB pixels (row-major, top row first) as a PNG file buffer. */
export function encodePng(rgb, width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit, truecolour, deflate, no filter set, no interlace
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height); // each row is prefixed with filter type 0
  for (let y = 0; y < height; y++) {
    raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * stride + 1);
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function main() {
  const [inFile, outFile, loHz = 17000, hiHz = 20500, floorDb = -115, ceilDb = -55, fft = 1024, hopMs = 2.5, rowPx = 4] =
    process.argv.slice(2);
  if (!inFile || !outFile) {
    console.error('usage: spectro.mjs <in.wav> <out.png> [loHz] [hiHz] [floorDb] [ceilDb] [fft] [hopMs] [rowPx]');
    process.exit(2);
  }
  const buf = fs.readFileSync(inFile);
  const { sampleRate, samples } = decodeWav(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const fftSize = Number(fft);
  const hop = Math.round((Number(hopMs) * sampleRate) / 1000);
  const S = stft(samples, fftSize, hop);
  const { lo, hi } = bandIndices(sampleRate, fftSize, Number(loHz), Number(hiHz));
  const rows = hi - lo + 1;
  const scale = Number(rowPx);
  const width = S.frames;
  const height = rows * scale;
  const lut = colorLUT();
  const span = Number(ceilDb) - Number(floorDb);
  const rgb = new Uint8Array(width * height * 3);
  for (let f = 0; f < width; f++) {
    for (let r = 0; r < rows; r++) {
      const db = S.data[f * S.bins + hi - r];
      const level = Math.max(0, Math.min(255, Math.round(((db - Number(floorDb)) / span) * 255)));
      for (let s = 0; s < scale; s++) {
        const p = ((r * scale + s) * width + f) * 3;
        rgb[p] = lut[level * 4];
        rgb[p + 1] = lut[level * 4 + 1];
        rgb[p + 2] = lut[level * 4 + 2];
      }
    }
  }
  fs.writeFileSync(outFile, encodePng(rgb, width, height));
  const binHz = sampleRate / fftSize;
  console.log(
    `${outFile} ${width}x${height} px, ${(lo * binHz).toFixed(0)}-${(hi * binHz).toFixed(0)} Hz, ` +
      `${((samples.length / sampleRate) * 1000).toFixed(0)} ms`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) main();
