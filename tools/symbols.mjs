#!/usr/bin/env node
// List the frequency excursions of an FSK-on-carrier signal: stretches where the
// instantaneous frequency sits away from the resting carrier. Prints each excursion's
// start, length and mean offset, with a blank line wherever the carrier rests > gapMs.
// Usage: node tools/symbols.mjs <file.wav> <loHz> <hiHz> [startMs=0] [minOffsetHz=50] [gapMs=30]
import fs from 'node:fs';
import { decodeWav, analyticBand, envelope, instantaneousFrequency } from '../web/dsp.js';

const [file, lo, hi, startMs = 0, minOffset = 50, gapMs = 30] = process.argv.slice(2);
if (!file || lo === undefined || hi === undefined) {
  console.error('usage: node tools/symbols.mjs <file.wav> <loHz> <hiHz> [startMs=0] [minOffsetHz=50] [gapMs=30]');
  process.exit(2);
}
const buf = fs.readFileSync(file);
const { sampleRate: sr, samples: x } = decodeWav(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const a = analyticBand(x, sr, Number(lo), Number(hi));
const env = envelope(a);
const raw = instantaneousFrequency(a, sr);

// Smooth instantaneous frequency over 3 ms; gate on envelope within 20 dB of its 90th percentile.
const w = Math.round(sr * 0.003);
const f = new Float32Array(raw.length);
let acc = 0;
for (let i = 0; i < raw.length; i++) {
  acc += raw[i];
  if (i >= w) acc -= raw[i - w];
  f[i] = acc / Math.min(i + 1, w);
}
const sortedEnv = Float32Array.from(env).sort();
const gate = sortedEnv[Math.floor(sortedEnv.length * 0.9)] * 0.1;
const from = Math.round((Number(startMs) * sr) / 1000);
const live = [];
for (let i = from; i < f.length; i++) if (env[i] > gate) live.push(f[i]);
if (!live.length) {
  console.log('no signal in band');
  process.exit(0);
}
// Resting carrier = most common frequency (10 Hz histogram mode).
const hist = new Map();
for (const v of live) hist.set(Math.round(v / 10), (hist.get(Math.round(v / 10)) ?? 0) + 1);
const carrier = [...hist.entries()].sort((p, q) => q[1] - p[1])[0][0] * 10;
console.log(`${file}\nresting carrier about ${carrier} Hz; excursions (start ms, length ms, offset Hz, absolute Hz):`);

let run = null;
let lastEnd = null;
const flush = (endIdx) => {
  const ms = ((endIdx - run.start) / sr) * 1000;
  if (ms >= 4) {
    const t0 = (run.start / sr) * 1000;
    if (lastEnd !== null && t0 - lastEnd > Number(gapMs)) console.log('');
    const off = run.sum / run.n;
    console.log(`${t0.toFixed(1).padStart(7)} ${ms.toFixed(1).padStart(5)} ${off.toFixed(0).padStart(5)} ${(carrier + off).toFixed(0).padStart(6)}`);
    lastEnd = t0 + ms;
  }
  run = null;
};
for (let i = from; i < f.length; i++) {
  const off = f[i] - carrier;
  const out = env[i] > gate && Math.abs(off) > Number(minOffset);
  if (out && run && Math.sign(off) === run.sign && Math.abs(off - run.sum / run.n) < 80) {
    run.sum += off;
    run.n++;
  } else {
    if (run) flush(i);
    if (out) run = { start: i, sum: off, n: 1, sign: Math.sign(off) };
  }
}
if (run) flush(f.length);
