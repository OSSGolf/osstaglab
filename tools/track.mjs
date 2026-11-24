#!/usr/bin/env node
// Track the dominant tone(s) in a band over time: every stepMs, the strongest spectral
// peak (parabolic-interpolated frequency, dB) and the runner-up if within 20 dB and at
// least 150 Hz away. Rows below minDb are printed as '-'.
// Usage: node tools/track.mjs <file.wav> [loHz=16500] [hiHz=21000] [stepMs=10] [minDb=-95] [fft=1024]
import fs from 'node:fs';
import { decodeWav, stft } from '../web/dsp.js';

const [file, lo = 16500, hi = 21000, stepMs = 10, minDb = -95, fft = 1024] = process.argv.slice(2);
if (!file) {
  console.error('usage: node tools/track.mjs <file.wav> [loHz=16500] [hiHz=21000] [stepMs=10] [minDb=-95] [fft=1024]');
  process.exit(2);
}
const buf = fs.readFileSync(file);
const { sampleRate: sr, samples: x } = decodeWav(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const N = Number(fft);
const H = Math.round((Number(stepMs) * sr) / 1000);
const S = stft(x, N, H);
const kLo = Math.round((Number(lo) * N) / sr);
const kHi = Math.round((Number(hi) * N) / sr);

function peakAt(row, k) {
  const a = row[k - 1];
  const b = row[k];
  const c = row[k + 1];
  const d = (0.5 * (a - c)) / (a - 2 * b + c || 1);
  return { hz: ((k + d) * sr) / N, db: b - 0.25 * (a - c) * d };
}

console.log(file);
for (let f = 0; f < S.frames; f++) {
  const row = S.data.subarray(f * S.bins, (f + 1) * S.bins);
  let k1 = kLo;
  for (let k = kLo; k <= kHi; k++) if (row[k] > row[k1]) k1 = k;
  const t = (((f * H + N / 2) / sr) * 1000).toFixed(0).padStart(5);
  if (row[k1] < Number(minDb)) {
    console.log(`${t}  -`);
    continue;
  }
  const p1 = peakAt(row, k1);
  const guard = Math.ceil((150 * N) / sr);
  let k2 = -1;
  for (let k = kLo + 1; k < kHi; k++) {
    if (Math.abs(k - k1) < guard) continue;
    if (row[k] >= row[k - 1] && row[k] >= row[k + 1] && (k2 < 0 || row[k] > row[k2])) k2 = k;
  }
  let line = `${t}  ${p1.hz.toFixed(0).padStart(6)} Hz ${p1.db.toFixed(0).padStart(4)} dB`;
  if (k2 > 0 && row[k2] > row[k1] - 20) {
    const p2 = peakAt(row, k2);
    line += `   | ${p2.hz.toFixed(0).padStart(6)} Hz ${p2.db.toFixed(0).padStart(4)} dB`;
  }
  console.log(line);
}
