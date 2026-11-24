#!/usr/bin/env node
// Cut a time range out of a WAV and write it as 16-bit PCM mono. Used to make the small
// test fixtures from longer captures.
// Usage: node tools/clip.mjs <in.wav> <out.wav> <startMs> <endMs>
import fs from 'node:fs';
import { decodeWav } from '../web/dsp.js';

const [inFile, outFile, startMs, endMs] = process.argv.slice(2);
if (!inFile || !outFile || startMs === undefined || endMs === undefined) {
  console.error('usage: clip.mjs <in.wav> <out.wav> <startMs> <endMs>');
  process.exit(2);
}
const buf = fs.readFileSync(inFile);
const { sampleRate, samples } = decodeWav(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const from = Math.max(0, Math.round((Number(startMs) * sampleRate) / 1000));
const to = Math.min(samples.length, Math.round((Number(endMs) * sampleRate) / 1000));
if (!(to > from)) {
  console.error(`clip.mjs: empty range ${startMs}-${endMs} ms in a ${((samples.length / sampleRate) * 1000).toFixed(0)} ms file`);
  process.exit(1);
}

const HEADER_BYTES = 44;
const dataBytes = (to - from) * 2;
const out = Buffer.alloc(HEADER_BYTES + dataBytes);
out.write('RIFF', 0, 'ascii');
out.writeUInt32LE(HEADER_BYTES - 8 + dataBytes, 4);
out.write('WAVEfmt ', 8, 'ascii');
out.writeUInt32LE(16, 16); // fmt chunk size
out.writeUInt16LE(1, 20); // PCM
out.writeUInt16LE(1, 22); // mono
out.writeUInt32LE(sampleRate, 24);
out.writeUInt32LE(sampleRate * 2, 28); // byte rate
out.writeUInt16LE(2, 32); // block align
out.writeUInt16LE(16, 34); // bits per sample
out.write('data', 36, 'ascii');
out.writeUInt32LE(dataBytes, 40);
for (let i = from; i < to; i++) {
  const v = Math.max(-1, Math.min(1, samples[i]));
  out.writeInt16LE(Math.round(v * 32767), HEADER_BYTES + (i - from) * 2);
}
fs.writeFileSync(outFile, out);
console.log(`${outFile}  ${(((to - from) / sampleRate) * 1000).toFixed(0)} ms, ${out.length} bytes`);
