#!/usr/bin/env node
// Decode FSK frames to tone-grid indices. Runs symbols-style excursion detection, groups
// excursions into frames (separated by > gapMs of rest tone), and prints each distinct
// frame once with how many times it occurred, as offsets from the rest tone in units
// of gridHz (so +3 means rest tone + 3 x gridHz).
// Usage: node tools/frames.mjs <file.wav> <loHz> <hiHz> [startMs=0] [endMs=inf] [gridHz=100] [gapMs=30]
import fs from 'node:fs';
import { decodeWav, analyticBand, envelope, instantaneousFrequency } from '../web/dsp.js';

const [file, lo, hi, startMs = 0, endMs = 1e9, gridHz = 100, gapMs = 30] = process.argv.slice(2);
if (!file || lo === undefined || hi === undefined) {
  console.error('usage: node tools/frames.mjs <file.wav> <loHz> <hiHz> [startMs=0] [endMs=inf] [gridHz=100] [gapMs=30]');
  process.exit(2);
}
const buf = fs.readFileSync(file);
const { sampleRate: sr, samples: x } = decodeWav(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const from = Math.round((Number(startMs) * sr) / 1000);
const to = Math.min(x.length, Math.round((Number(endMs) * sr) / 1000));
const a = analyticBand(x, sr, Number(lo), Number(hi));
const env = envelope(a);
const raw = instantaneousFrequency(a, sr);
const w = Math.round(sr * 0.003);
const f = new Float32Array(raw.length);
let acc = 0;
for (let i = 0; i < raw.length; i++) {
  acc += raw[i];
  if (i >= w) acc -= raw[i - w];
  f[i] = acc / Math.min(i + 1, w);
}
const seg = Float32Array.from(env.subarray(from, to)).sort();
const gate = seg[Math.floor(seg.length * 0.9)] * 0.1;
const hist = new Map();
for (let i = from; i < to; i++) {
  if (env[i] <= gate) continue;
  const k = Math.round(f[i] / 10);
  hist.set(k, (hist.get(k) ?? 0) + 1);
}
const carrier = [...hist.entries()].sort((p, q) => q[1] - p[1])[0][0] * 10;

const excursions = [];
let run = null;
const flush = (end) => {
  const ms = ((end - run.start) / sr) * 1000;
  if (ms >= 5) excursions.push({ t: (run.start / sr) * 1000, ms, off: run.sum / run.n });
  run = null;
};
for (let i = from; i < to; i++) {
  const off = f[i] - carrier;
  const out = env[i] > gate && Math.abs(off) > Number(gridHz) / 2;
  if (out && run && Math.abs(off - run.sum / run.n) < Number(gridHz) * 0.8) {
    run.sum += off;
    run.n++;
  } else {
    if (run) flush(i);
    if (out) run = { start: i, sum: off, n: 1 };
  }
}
if (run) flush(to);

const frames = [];
for (const e of excursions) {
  const last = frames[frames.length - 1];
  if (last && e.t - last.end < Number(gapMs)) {
    last.syms.push(e);
    last.end = e.t + e.ms;
  } else {
    frames.push({ start: e.t, end: e.t + e.ms, syms: [e] });
  }
}
const fmt = (v) => (v > 0 ? '+' : '') + v;
const counts = new Map();
for (const fr of frames) {
  const key = fr.syms.map((s) => fmt(Math.round(s.off / Number(gridHz)))).join(' ');
  counts.set(key, (counts.get(key) ?? 0) + 1);
}
const starts = frames.map((fr) => fr.start);
const periods = starts.slice(1).map((s, i) => s - starts[i]).sort((p, q) => p - q);
console.log(`${file}  ${startMs}-${Math.round((to / sr) * 1000)} ms`);
console.log(`rest tone ${carrier} Hz, ${frames.length} frames, median frame period ${periods.length ? periods[periods.length >> 1].toFixed(1) : '-'} ms`);
const meanOff = new Map();
for (const e of excursions) {
  const k = Math.round(e.off / Number(gridHz));
  const m = meanOff.get(k) ?? { s: 0, n: 0 };
  m.s += e.off;
  m.n++;
  meanOff.set(k, m);
}
console.log('measured offsets: ' + [...meanOff.entries()].sort((p, q) => p[0] - q[0]).map(([k, m]) => `${fmt(k)}=${(m.s / m.n).toFixed(0)}Hz(n${m.n})`).join('  '));
for (const [key, n] of [...counts.entries()].sort((p, q) => q[1] - p[1])) console.log(`${String(n).padStart(4)} x  ${key}`);
