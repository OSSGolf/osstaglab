#!/usr/bin/env node
// Offline summary of one capture: per-kHz band levels (quiet lead-in vs peak),
// a 10 ms envelope timeline for chosen bands, and burst/tone estimates.
// Usage: node tools/analyze.mjs <file.wav> [loHz-hiHz ...]
import fs from 'node:fs';
import { decodeWav, stft, bandPowerDb, analyticBand, envelope, instantaneousFrequency } from '../web/dsp.js';
import { findBurst, burstStats, toneLevels } from '../web/analysis-core.js';

const [file, ...bandArgs] = process.argv.slice(2);
if (!file) {
  console.error('usage: analyze.mjs <file.wav> [loHz-hiHz ...]');
  process.exit(2);
}
const bands = bandArgs.length
  ? bandArgs.map((b) => b.split('-').map(Number))
  : [[200, 8000], [8000, 14000], [14000, 18000], [18000, 23500]];

const buf = fs.readFileSync(file);
const { sampleRate: sr, samples: x } = decodeWav(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const db = (v) => 20 * Math.log10(v + 1e-12);

let peak = 0;
let sumSq = 0;
for (const v of x) {
  peak = Math.max(peak, Math.abs(v));
  sumSq += v * v;
}
console.log(`${file}\n${sr} Hz, ${(x.length / sr).toFixed(3)} s, peak ${db(peak).toFixed(1)} dBFS, rms ${(10 * Math.log10(sumSq / x.length)).toFixed(1)} dBFS`);

const N = 1024;
const H = 256;
const S = stft(x, N, H);
const quietFrames = Math.max(1, Math.floor((0.3 * sr - N) / H));
console.log(`\nband kHz | first 0.3 s mean dB | peak dB | peak at ms | rise dB`);
for (let k = 0; k < Math.floor(sr / 2000); k++) {
  const lo = Math.round((k * 1000 * N) / sr);
  const hi = Math.round(((k + 1) * 1000 * N) / sr) - 1;
  let quiet = 0;
  let max = -Infinity;
  let at = 0;
  for (let f = 0; f < S.frames; f++) {
    const b = bandPowerDb(S.data.subarray(f * S.bins, (f + 1) * S.bins), lo, hi);
    if (f < quietFrames) quiet += 10 ** (b / 10);
    if (b > max) {
      max = b;
      at = ((f * H + N / 2) / sr) * 1000;
    }
  }
  const q = 10 * Math.log10(quiet / quietFrames);
  console.log(`${String(k).padStart(2)}-${String(k + 1).padEnd(2)} | ${q.toFixed(1).padStart(7)} | ${max.toFixed(1).padStart(7)} | ${at.toFixed(0).padStart(5)} | ${(max - q).toFixed(1).padStart(5)}`);
}

for (const [lo, hi] of bands) {
  const a = analyticBand(x, sr, lo, hi);
  const e = envelope(a);
  const w = Math.floor(sr * 0.01);
  const cells = [];
  for (let i = 0; i + w <= e.length; i += w) {
    let m = 0;
    for (let j = i; j < i + w; j++) m = Math.max(m, e[j]);
    cells.push(db(m).toFixed(0));
  }
  console.log(`\n${lo}-${hi} Hz, envelope max per 10 ms (dB):\n${cells.join(' ')}`);
  const burst = findBurst(e, sr);
  if (burst) {
    const f = instantaneousFrequency(a, sr);
    const st = burstStats(f, e, burst);
    const levels = toneLevels(f, e, burst, sr).map((l) => `${Math.round(l.hz)} Hz`);
    console.log(`burst ${((burst.start / sr) * 1000).toFixed(1)} ms, lasts ${(((burst.end - burst.start) / sr) * 1000).toFixed(1)} ms, peak ${db(burst.peak).toFixed(1)} dB, median ${Math.round(st.medianHz)} Hz (${Math.round(st.minHz)}-${Math.round(st.maxHz)}), tones: ${levels.join(', ') || 'none'}`);
  }
}
