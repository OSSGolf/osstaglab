#!/usr/bin/env node
// Mix a narrowband signal down to baseband and print amplitude and phase over time.
// The carrier frequency is refined from a stretch of unmodulated carrier
// (refStartMs..refEndMs) so the phase reads flat there.
// Usage: node tools/demod.mjs <file.wav> <carrierHz> <startMs> <endMs> <refStartMs> <refEndMs> [halfBandHz=1200] [stepMs=1]
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import { decodeWav, analyticBand } from '../web/dsp.js';

export function demodulate(x, sr, carrierHz, halfBandHz, refStart, refEnd) {
  const a = analyticBand(x, sr, carrierHz - halfBandHz, carrierHz + halfBandHz);
  // Refine the carrier: mean phase advance per sample across the reference stretch.
  let re = 0;
  let im = 0;
  for (let i = refStart + 1; i < refEnd; i++) {
    re += a.re[i] * a.re[i - 1] + a.im[i] * a.im[i - 1];
    im += a.im[i] * a.re[i - 1] - a.re[i] * a.im[i - 1];
  }
  const fc = (Math.atan2(im, re) * sr) / (2 * Math.PI);
  const n = x.length;
  const amp = new Float32Array(n);
  const phase = new Float32Array(n);
  const w = (2 * Math.PI * fc) / sr;
  for (let i = 0; i < n; i++) {
    const c = Math.cos(w * i);
    const s = Math.sin(w * i);
    const br = a.re[i] * c + a.im[i] * s;
    const bi = a.im[i] * c - a.re[i] * s;
    amp[i] = Math.hypot(br, bi);
    phase[i] = Math.atan2(bi, br);
  }
  return { fc, amp, phase };
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const [file, carrier, a, b, r0, r1, half = 1200, step = 1] = process.argv.slice(2);
  if (!file || carrier === undefined || a === undefined || b === undefined || r0 === undefined || r1 === undefined) {
    console.error('usage: node tools/demod.mjs <file.wav> <carrierHz> <startMs> <endMs> <refStartMs> <refEndMs> [halfBandHz=1200] [stepMs=1]');
    process.exit(2);
  }
  const buf = fs.readFileSync(file);
  const { sampleRate: sr, samples: x } = decodeWav(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const ms = (v) => Math.round((Number(v) * sr) / 1000);
  const d = demodulate(x, sr, Number(carrier), Number(half), ms(r0), ms(r1));
  // Reference phase = circular mean over the reference stretch.
  let cr = 0;
  let ci = 0;
  for (let i = ms(r0); i < ms(r1); i++) {
    cr += Math.cos(d.phase[i]);
    ci += Math.sin(d.phase[i]);
  }
  const ref = Math.atan2(ci, cr);
  console.log(`${file}\ncarrier ${d.fc.toFixed(2)} Hz; columns: ms, amplitude dB, phase degrees relative to reference`);
  for (let t = Number(a); t < Number(b); t += Number(step)) {
    const i = ms(t);
    let p = ((d.phase[i] - ref) * 180) / Math.PI;
    p = ((((p + 180) % 360) + 360) % 360) - 180;
    console.log(`${t.toFixed(1).padStart(7)} ${(20 * Math.log10(d.amp[i] + 1e-12)).toFixed(0).padStart(5)} ${p.toFixed(0).padStart(5)}`);
  }
}
