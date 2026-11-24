#!/usr/bin/env node
// Event timeline for one capture: when the impact band (broadband click), the lower tag band
// and the upper tag band are each active, as merged [start-end] ms segments. A band is active
// when its level is `riseDb` above that band's median over the capture.
// Usage: node tools/events.mjs <file.wav> [riseDb=12] [stepMs=10] [mergeMs=120]
import fs from 'node:fs';
import { decodeWav, stft, bandIndices, bandPowerDb } from '../web/dsp.js';

const BANDS = [
  { name: 'impact 2-8k    ', lo: 2000, hi: 8000 },
  { name: 'lower 17.4-18.4k', lo: 17400, hi: 18400 },
  { name: 'upper 18.6-20.0k', lo: 18600, hi: 20000 },
];
const FFT_SIZE = 1024;

const [file, riseDb = 12, stepMs = 10, mergeMs = 120] = process.argv.slice(2);
if (!file) {
  console.error('usage: node tools/events.mjs <file.wav> [riseDb=12] [stepMs=10] [mergeMs=120]');
  process.exit(2);
}
const buf = fs.readFileSync(file);
const { sampleRate: sr, samples } = decodeWav(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const hop = Math.round((Number(stepMs) * sr) / 1000);
const S = stft(samples, FFT_SIZE, hop);
const timeMs = (f) => ((f * hop + FFT_SIZE / 2) / sr) * 1000;

console.log(`${file}  (${((samples.length / sr) * 1000).toFixed(0)} ms)`);
for (const band of BANDS) {
  const { lo, hi } = bandIndices(sr, FFT_SIZE, band.lo, band.hi);
  const level = new Float32Array(S.frames);
  for (let f = 0; f < S.frames; f++) {
    level[f] = bandPowerDb(S.data.subarray(f * S.bins, (f + 1) * S.bins), lo, hi);
  }
  const median = Float32Array.from(level).sort()[S.frames >> 1];
  const segments = [];
  for (let f = 0; f < S.frames; f++) {
    if (level[f] < median + Number(riseDb)) continue;
    const t = timeMs(f);
    const last = segments[segments.length - 1];
    if (last && t - last.end <= Number(mergeMs)) {
      last.end = t;
      last.peak = Math.max(last.peak, level[f]);
    } else {
      segments.push({ start: t, end: t, peak: level[f] });
    }
  }
  const text = segments
    .map((s) => `${s.start.toFixed(0)}-${s.end.toFixed(0)} (+${(s.peak - median).toFixed(0)})`)
    .join('  ');
  console.log(`  ${band.name} median ${median.toFixed(0)} dB: ${text || 'none'}`);
}
