import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findBurst,
  burstStats,
  toneLevels,
  runLengths,
  estimateSymbolMs,
  expandLevelSequence,
  cropToBurst,
  similarityMatrix,
  columnMax,
} from '../web/analysis-core.js';
import { analyticBand, envelope, instantaneousFrequency } from '../web/dsp.js';

const SR = 48000;
const CLIP_SAMPLES = 2 * SR;
const BURST_AT_MS = 500;
const NOISE_SIGMA = 0.001;
const TONE_AMP = 0.1;
const FADE_MS = 2;
const BIT_MS = 5;
const SYMBOL_SAMPLES = (BIT_MS * SR) / 1000;
const TAG_BAND = { loHz: 15000, hiHz: 22000 };

/** Transmitted message: 0xA5C3F00F, MSB first. */
const MESSAGE_A = bitsOf(0xa5c3f00f);
/** Different message used for the dissimilarity check. */
const MESSAGE_B = bitsOf(0x0f0f3c5a);

/**
 * @param {number} word 32-bit value
 * @returns {number[]} bits, most significant first
 */
function bitsOf(word) {
  const bits = [];
  for (let i = 31; i >= 0; i--) bits.push((word >>> i) & 1);
  return bits;
}

/**
 * Seeded PRNG (mulberry32). Never Math.random, so the tests are repeatable.
 * @param {number} seed
 * @returns {() => number} uniform in [0, 1)
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Linear fade envelope applied at both ends of a burst.
 * @param {number} i sample index
 * @param {number} n burst length
 * @returns {number} gain in [0, 1]
 */
function fadeGain(i, n) {
  const fadeN = (FADE_MS * SR) / 1000;
  return Math.min(1, i / fadeN, (n - 1 - i) / fadeN);
}

/**
 * Phase-continuous 2-FSK burst: bit 0 = 18 kHz, bit 1 = 19 kHz.
 * @param {number[]} bits
 * @returns {Float32Array}
 */
function fskBurst(bits) {
  const n = bits.length * SYMBOL_SAMPLES;
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const f = bits[Math.floor(i / SYMBOL_SAMPLES)] ? 19000 : 18000;
    phase += (2 * Math.PI * f) / SR;
    out[i] = TONE_AMP * fadeGain(i, n) * Math.cos(phase);
  }
  return out;
}

/**
 * Constant-frequency burst with the same fades.
 * @param {number} hz
 * @param {number} ms
 * @returns {Float32Array}
 */
function toneBurst(hz, ms) {
  const n = Math.round((ms * SR) / 1000);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = TONE_AMP * fadeGain(i, n) * Math.cos((2 * Math.PI * hz * i) / SR);
  }
  return out;
}

/**
 * Add uniform noise of amplitude NOISE_SIGMA to every sample.
 * @param {Float32Array} x modified in place
 * @param {() => number} rng
 * @returns {Float32Array} x
 */
function addNoise(x, rng) {
  for (let i = 0; i < x.length; i++) x[i] += NOISE_SIGMA * (2 * rng() - 1);
  return x;
}

/**
 * Two-second clip: noise everywhere, burst starting at atSample.
 * @param {Float32Array} burst
 * @param {number} atSample
 * @param {number} seed
 * @returns {Float32Array}
 */
function makeClip(burst, atSample, seed) {
  const clip = new Float32Array(CLIP_SAMPLES);
  clip.set(burst, atSample);
  return addNoise(clip, mulberry32(seed));
}

/**
 * Run the real pipeline used by the panel.
 * @param {Float32Array} clip
 * @returns {{env: Float32Array, inst: Float32Array}}
 */
function pipeline(clip) {
  const analytic = analyticBand(clip, SR, TAG_BAND.loHz, TAG_BAND.hiHz);
  return { env: envelope(analytic), inst: instantaneousFrequency(analytic, SR) };
}

/**
 * Full chain from a clip to the sequence of expanded symbol levels.
 * @param {Float32Array} clip
 */
function decode(clip) {
  const { env, inst } = pipeline(clip);
  const burst = findBurst(env, SR);
  const levels = toneLevels(inst, env, burst, SR);
  const runs = runLengths(inst, env, burst, SR, levels);
  const symbolMs = estimateSymbolMs(runs);
  return { env, inst, burst, levels, runs, symbolMs, sequence: expandLevelSequence(runs, symbolMs) };
}

const FSK_CLIP = makeClip(fskBurst(MESSAGE_A), (BURST_AT_MS * SR) / 1000, 1);
const FSK = decode(FSK_CLIP);

test('findBurst locates the 160 ms FSK burst at 500 ms', () => {
  assert.ok(FSK.burst, 'burst found');
  const startMs = (FSK.burst.start * 1000) / SR;
  const durationMs = ((FSK.burst.end - FSK.burst.start) * 1000) / SR;
  assert.ok(Math.abs(startMs - 500) <= 3, `start ${startMs} ms`);
  assert.ok(Math.abs(durationMs - 160) <= 6, `duration ${durationMs} ms`);
});

test('burstStats puts the median between the two tones', () => {
  const stats = burstStats(FSK.inst, FSK.env, FSK.burst);
  assert.ok(stats.medianHz > 18000 && stats.medianHz < 19000, `median ${stats.medianHz}`);
  assert.ok(stats.minHz <= stats.medianHz && stats.medianHz <= stats.maxHz);
});

test('toneLevels finds exactly the two FSK tones', () => {
  assert.equal(FSK.levels.length, 2, JSON.stringify(FSK.levels));
  assert.ok(Math.abs(FSK.levels[0].hz - 18000) <= 60, `low tone ${FSK.levels[0].hz}`);
  assert.ok(Math.abs(FSK.levels[1].hz - 19000) <= 60, `high tone ${FSK.levels[1].hz}`);
});

test('estimateSymbolMs recovers the 5 ms bit period', () => {
  assert.ok(FSK.symbolMs !== null, 'symbol estimate');
  assert.ok(Math.abs(FSK.symbolMs - 5) <= 0.4, `symbol ${FSK.symbolMs} ms`);
});

test('expanded level sequence equals the 32 transmitted bits', () => {
  assert.deepEqual(FSK.sequence, MESSAGE_A);
});

test('constant 18.5 kHz burst gives one level and no runs', () => {
  const clip = makeClip(toneBurst(18500, 160), (BURST_AT_MS * SR) / 1000, 2);
  const { env, inst } = pipeline(clip);
  const burst = findBurst(env, SR);
  const levels = toneLevels(inst, env, burst, SR);
  assert.equal(levels.length, 1, JSON.stringify(levels));
  assert.ok(Math.abs(levels[0].hz - 18500) <= 60, `tone ${levels[0].hz}`);
  assert.deepEqual(runLengths(inst, env, burst, SR, levels), []);
});

test('findBurst returns null for all-zero input', () => {
  assert.equal(findBurst(new Float32Array(SR), SR), null);
  assert.equal(findBurst(new Float32Array(0), SR), null);
});

test('similarityMatrix: noisy copies at different offsets score high with mirrored lags', () => {
  // 6 ms offset between the two copies: 288 samples at 48 kHz.
  const copyA = new Float32Array(200 * SR / 1000);
  copyA.set(fskBurst(MESSAGE_A), (20 * SR) / 1000);
  const copyB = new Float32Array(copyA.length);
  copyB.set(fskBurst(MESSAGE_A), (26 * SR) / 1000);
  addNoise(copyA, mulberry32(21));
  addNoise(copyB, mulberry32(22));

  const m = similarityMatrix([copyA, copyB]);
  assert.equal(m.peaks[0], 1);
  assert.ok(m.peaks[1] > 0.9, `peak ${m.peaks[1]}`);
  assert.equal(m.peaks[1], m.peaks[2]);
  assert.ok(Math.abs(m.lags[1] - 288) <= 2, `lag ${m.lags[1]}`);
  assert.equal(m.lags[2], -m.lags[1]);
});

// Two FSK codes sharing a tone pair agree on about half their bits, so their
// waveform correlation sits near 0.5, not 0. The usable gap is same > 0.9 vs different < 0.7.
test('similarityMatrix: different bits score well below identical bursts', () => {
  const copyA = new Float32Array(200 * SR / 1000);
  copyA.set(fskBurst(MESSAGE_A), (20 * SR) / 1000);
  const copyC = new Float32Array(copyA.length);
  copyC.set(fskBurst(MESSAGE_B), (20 * SR) / 1000);
  addNoise(copyA, mulberry32(31));
  addNoise(copyC, mulberry32(32));

  const m = similarityMatrix([copyA, copyC]);
  assert.ok(m.peaks[1] < 0.7, `peak ${m.peaks[1]}`);
});

test('cropToBurst pads by padMs and clamps to the clip', () => {
  const samples = new Float32Array(SR);
  const inner = cropToBurst(samples, { start: 10000, end: 20000 }, SR, 20);
  assert.equal(inner.length, 10000 + 2 * 960);
  const edge = cropToBurst(samples, { start: 100, end: 5000 }, SR, 20);
  assert.equal(edge.length, 5000 + 960);
});

test('columnMax keeps a single hot cell at several zoom levels', () => {
  const frames = 100;
  const bins = 65;
  const data = new Float32Array(frames * bins).fill(-100);
  data[37 * bins + 20] = 100;
  for (const [width, height] of [
    [1000, 260],
    [37, 13],
    [7, 5],
  ]) {
    const out = columnMax(data, frames, bins, 0, frames, 0, bins - 1, width, height, new Float32Array(width * height));
    assert.equal(out.reduce((m, v) => Math.max(m, v), -Infinity), 100, `${width}x${height} max`);
    assert.ok(out.some((v) => v === 100), `${width}x${height} hot pixel present`);
    assert.ok(out.every((v) => v === 100 || v === -100), `${width}x${height} no averaging`);
  }
});
