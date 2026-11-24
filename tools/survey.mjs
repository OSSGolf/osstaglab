#!/usr/bin/env node
// Survey every capture for signal that is NOT a broadband click: for each clip, list
// the events in a band (start, length) and, per 1 kHz band, how many milliseconds the
// band spent more than 10 dB above its own median. A click is a few ms in every band;
// a data burst is tens of ms in a few bands.
// Usage: node tools/survey.mjs [recordings dir] [loHz] [hiHz]
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { decodeWav, stft, bandPowerDb, analyticBand, envelope, median } from '../web/dsp.js';

const dir = process.argv[2] ?? fileURLToPath(new URL('../recordings/', import.meta.url));
const loHz = Number(process.argv[3] ?? 14000);
const hiHz = Number(process.argv[4] ?? 23500);
if (!fs.existsSync(dir)) {
  console.error(`no recordings directory at ${process.argv[2] !== undefined ? dir : 'recordings/'}; pass a directory of WAV files`);
  process.exit(2);
}
const N = 512;
const H = 64;

/** The capture's .json sidecar, or {} when it has none. */
function readMeta(wavPath) {
  const sidecar = wavPath.replace(/\.wav$/, '.json');
  return fs.existsSync(sidecar) ? JSON.parse(fs.readFileSync(sidecar, 'utf8')) : {};
}

/** Events where the band envelope exceeds its median by `overDb`, merged across gaps < gapMs. */
function events(env, sr, overDb = 12, gapMs = 8) {
  const w = Math.round(sr * 0.001);
  const ms = [];
  for (let i = 0; i + w <= env.length; i += w) {
    let m = 0;
    for (let j = i; j < i + w; j++) m = Math.max(m, env[j]);
    ms.push(20 * Math.log10(m + 1e-12));
  }
  const floor = median(ms);
  const out = [];
  let cur = null;
  ms.forEach((v, t) => {
    if (v > floor + overDb) {
      if (cur && t - cur.end <= gapMs) {
        cur.end = t + 1;
        cur.peak = Math.max(cur.peak, v);
        cur.loud++;
      } else {
        cur = { start: t, end: t + 1, peak: v, loud: 1 };
        out.push(cur);
      }
    }
  });
  return { floor, list: out };
}

for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.wav')).sort()) {
  const meta = readMeta(path.join(dir, name));
  const buf = fs.readFileSync(path.join(dir, name));
  const { sampleRate: sr, samples: x } = decodeWav(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const env = envelope(analyticBand(x, sr, loHz, hiHz));
  const ev = events(env, sr);
  console.log(`\n${name}  ${meta.clubId ?? '-'}  ${meta.device ?? '-'}`);
  console.log(`  ${loHz}-${hiHz} Hz floor ${ev.floor.toFixed(0)} dB; events (start ms / span ms / ms loud / peak dB): ` +
    (ev.list.map((e) => `${e.start}/${e.end - e.start}/${e.loud}/${e.peak.toFixed(0)}`).join('  ') || 'none'));

  const S = stft(x, N, H);
  const frameMs = (H / sr) * 1000;
  let line = '  ms >10 dB over median, per kHz band:';
  for (let k = 1; k < Math.floor(sr / 2000); k++) {
    const lo = Math.round((k * 1000 * N) / sr);
    const hi = Math.round(((k + 1) * 1000 * N) / sr) - 1;
    const series = new Float32Array(S.frames);
    for (let f = 0; f < S.frames; f++) series[f] = bandPowerDb(S.data.subarray(f * S.bins, (f + 1) * S.bins), lo, hi);
    const med = median(series);
    let n = 0;
    for (const v of series) if (v > med + 10) n++;
    line += ` ${k}:${Math.round(n * frameMs)}`;
  }
  console.log(line);
}
