#!/usr/bin/env node
// Print a time x frequency table (dB over each band's median) for part of a capture.
// Usage: node tools/tf.mjs <file.wav> <startMs> <endMs> [loHz=12000] [hiHz=24000] [stepHz=500] [stepMs=2] [fft=256]
import fs from 'node:fs';
import { decodeWav, stft, bandPowerDb } from '../web/dsp.js';

const [file, a, b, lo = 12000, hi = 24000, stepHz = 500, stepMs = 2, fft = 256] = process.argv.slice(2);
if (!file || a === undefined || b === undefined) {
  console.error('usage: node tools/tf.mjs <file.wav> <startMs> <endMs> [loHz=12000] [hiHz=24000] [stepHz=500] [stepMs=2] [fft=256]');
  process.exit(2);
}
const buf = fs.readFileSync(file);
const { sampleRate: sr, samples: x } = decodeWav(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const N = Number(fft);
const H = Math.max(1, Math.round((Number(stepMs) * sr) / 1000));
const S = stft(x, N, H);
const bands = [];
for (let f = Number(lo); f < Number(hi); f += Number(stepHz)) {
  const kLo = Math.round((f * N) / sr);
  const kHi = Math.max(kLo, Math.round(((f + Number(stepHz)) * N) / sr) - 1);
  const series = new Float32Array(S.frames);
  for (let i = 0; i < S.frames; i++) series[i] = bandPowerDb(S.data.subarray(i * S.bins, (i + 1) * S.bins), kLo, kHi);
  const med = Float32Array.from(series).sort()[S.frames >> 1];
  bands.push({ f, series, med });
}
console.log('kHz    ' + bands.map((q) => (q.f / 1000).toFixed(1).padStart(5)).join(''));
console.log('median ' + bands.map((q) => q.med.toFixed(0).padStart(5)).join(''));
for (let i = 0; i < S.frames; i++) {
  const t = ((i * H + N / 2) / sr) * 1000;
  if (t < Number(a) || t > Number(b)) continue;
  console.log(t.toFixed(1).padStart(6) + ' ' + bands.map((q) => {
    const d = Math.round(q.series[i] - q.med);
    return (d >= 6 ? String(d) : '.').padStart(5);
  }).join(''));
}
