#!/usr/bin/env node
// Decode tag signals in one or more WAV files of any length and print each file's event
// timeline.
// Usage: node tools/decode.mjs <file.wav> [more.wav ...]
import fs from 'node:fs';
import { decodeWav } from '../web/dsp.js';
import { decodeTagSignals, describeEvent } from '../web/tag-decoder.js';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: decode.mjs <file.wav> [more.wav ...]');
  process.exit(2);
}

let failed = false;
for (const file of files) {
  try {
    const buf = fs.readFileSync(file);
    const { sampleRate, samples } = decodeWav(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const events = decodeTagSignals(samples, sampleRate);
    console.log(`${file}  ${(samples.length / sampleRate).toFixed(1)} s at ${sampleRate} Hz`);
    if (events.length === 0) console.log('  no tag signal found');
    for (const e of events) {
      const from = (e.startMs / 1000).toFixed(2).padStart(7);
      const to = (e.endMs / 1000).toFixed(2).padStart(7);
      console.log(`  ${from}-${to} s  ${describeEvent(e)}`);
    }
  } catch (err) {
    failed = true;
    console.error(`${file}: ${err.message}`);
  }
}
process.exit(failed ? 1 : 0);
