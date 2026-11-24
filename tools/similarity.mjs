#!/usr/bin/env node
// Do the bursts repeat? Band-pass each capture, cut out its burst, and cross-correlate
// every pair. A transmitter sending the same packet scores high between captures;
// impact noise does not. A shuffled-noise baseline shows what "unrelated" scores.
// Usage: node tools/similarity.mjs [dir] [loHz=13000] [hiHz=23500] [device substring]
// A first argument that is not a number is the directory of WAV files (default recordings/).
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { decodeWav, analyticBand, envelope, xcorrPeak } from '../web/dsp.js';
import { findBurst, cropToBurst } from '../web/analysis-core.js';

const args = process.argv.slice(2);
const dirGiven = args.length > 0 && !Number.isFinite(Number(args[0]));
const dir = dirGiven ? args.shift() : fileURLToPath(new URL('../recordings/', import.meta.url));
const loHz = Number(args[0] ?? 13000);
const hiHz = Number(args[1] ?? 23500);
const deviceFilter = args[2] ?? '';
if (!fs.existsSync(dir)) {
  console.error(`no recordings directory at ${dirGiven ? dir : 'recordings/'}; pass a directory of WAV files`);
  process.exit(2);
}

/** The capture's .json sidecar, or {} when it has none. */
function readMeta(wavPath) {
  const sidecar = wavPath.replace(/\.wav$/, '.json');
  return fs.existsSync(sidecar) ? JSON.parse(fs.readFileSync(sidecar, 'utf8')) : {};
}

const clips = [];
for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.wav')).sort()) {
  const meta = readMeta(path.join(dir, name));
  if (!String(meta.device ?? '').includes(deviceFilter)) continue;
  const buf = fs.readFileSync(path.join(dir, name));
  const { sampleRate: sr, samples } = decodeWav(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  // Skip the first 300 ms: some clips begin with the microphone's switch-on transient.
  const x = samples.subarray(Math.round(0.3 * sr));
  const a = analyticBand(x, sr, loHz, hiHz);
  const burst = findBurst(envelope(a), sr, { dropDb: 15 });
  if (!burst) continue;
  const clip = cropToBurst(a.re, burst, sr, 5);
  clips.push({ name: name.slice(9, 19), clip, ms: ((burst.end - burst.start) / sr) * 1000, at: 300 + (burst.start / sr) * 1000 });
}

console.log(`band ${loHz}-${hiHz} Hz, ${clips.length} bursts`);
clips.forEach((c, i) => console.log(`${String(i).padStart(2)} ${c.name} burst at ${c.at.toFixed(0)} ms, ${c.ms.toFixed(0)} ms long`));
console.log('\n    ' + clips.map((_, i) => String(i).padStart(5)).join(''));
const scores = [];
clips.forEach((a, i) => {
  let row = String(i).padStart(4);
  clips.forEach((b, j) => {
    const p = i === j ? 1 : xcorrPeak(a.clip, b.clip).peak;
    if (i < j) scores.push(p);
    row += p.toFixed(2).padStart(5);
  });
  console.log(row);
});

// Baseline: same clips with their spectra kept but phases destroyed (time-reversed partner).
const baseline = [];
clips.forEach((a, i) => clips.forEach((b, j) => {
  if (i < j) baseline.push(xcorrPeak(a.clip, Float32Array.from(b.clip).reverse()).peak);
}));
const mean = (v) => v.reduce((s, q) => s + q, 0) / (v.length || 1);
console.log(`\nmean pair score ${mean(scores).toFixed(3)} (max ${Math.max(...scores).toFixed(3)}); time-reversed baseline ${mean(baseline).toFixed(3)} (max ${Math.max(...baseline).toFixed(3)})`);
