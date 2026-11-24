#!/usr/bin/env node
// Narrowband search: in every frame, compare each bin with the median of its spectral
// neighbourhood (+-1 kHz). A piezo transmitter is narrowband and stands out from that
// local level; clicks, hiss and scraping raise the whole neighbourhood and do not.
// Reports frequency runs that stay >= minDb above the neighbourhood for >= minMs.
// Usage: node tools/tones.mjs [dir] [loHz=8000] [hiHz=23800] [minDb=12] [minMs=8]
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { decodeWav, stft } from '../web/dsp.js';

const dir = process.argv[2] ?? fileURLToPath(new URL('../recordings/', import.meta.url));
const loHz = Number(process.argv[3] ?? 8000);
const hiHz = Number(process.argv[4] ?? 23800);
const minDb = Number(process.argv[5] ?? 12);
const minMs = Number(process.argv[6] ?? 8);
if (!fs.existsSync(dir)) {
  console.error(`no recordings directory at ${process.argv[2] !== undefined ? dir : 'recordings/'}; pass a directory of WAV files`);
  process.exit(2);
}
const N = 1024;
const H = 96;

for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.wav')).sort()) {
  const buf = fs.readFileSync(path.join(dir, name));
  const { sampleRate: sr, samples: x } = decodeWav(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const S = stft(x, N, H);
  const kLo = Math.round((loHz * N) / sr);
  const kHi = Math.round((hiHz * N) / sr);
  const half = Math.round((1000 * N) / sr);
  const frameMs = (H / sr) * 1000;
  const scratch = new Float32Array(2 * half + 1);
  const hits = [];
  for (let k = kLo; k <= kHi; k++) {
    let run = 0;
    let best = 0;
    for (let f = 0; f <= S.frames; f++) {
      let over = -Infinity;
      if (f < S.frames) {
        const row = S.data.subarray(f * S.bins, (f + 1) * S.bins);
        const a = Math.max(0, k - half);
        const b = Math.min(S.bins - 1, k + half);
        const nb = scratch.subarray(0, b - a + 1);
        nb.set(row.subarray(a, b + 1));
        nb.sort();
        over = row[k] - nb[nb.length >> 1];
      }
      if (over >= minDb) {
        run++;
        best = Math.max(best, over);
      } else {
        if (run * frameMs >= minMs) hits.push({ hz: (k * sr) / N, startMs: (f - run) * frameMs, ms: run * frameMs, best });
        run = 0;
        best = 0;
      }
    }
  }
  hits.sort((p, q) => q.ms - p.ms);
  console.log(`${name}: ${hits.length} narrowband runs`);
  for (const h of hits.slice(0, 8)) console.log(`   ${h.hz.toFixed(0).padStart(6)} Hz  from ${h.startMs.toFixed(0).padStart(5)} ms for ${h.ms.toFixed(0).padStart(4)} ms, up to +${h.best.toFixed(0)} dB`);
}
