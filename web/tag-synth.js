/**
 * tag-synth.js - deterministic synthesiser for club-tag signals.
 * Used by the tests and by the app's "play synthetic tag" button. Pure: no DOM, no Node APIs.
 *
 * Every signal is a phase-continuous, constant-amplitude sinusoid with a short raised-cosine
 * fade at its very start and end. Timing comes from TAG_PROTOCOL, so the synthetic signals
 * exercise the same timing the decoder was measured against.
 */
import { TAG_PROTOCOL } from './tag-decoder.js';

const TWO_PI = 2 * Math.PI;
const MS_PER_S = 1000;
const FADE_MS = 5;
const DEFAULT_AMPLITUDE = 0.05;
/** Keeps Box-Muller away from log(0). */
const MIN_UNIFORM = 1e-12;

/**
 * @typedef {object} Segment
 * @property {number} hz tone frequency for the segment
 * @property {number} fromMs cumulative start time
 * @property {number} toMs cumulative end time, exclusive
 */

/**
 * @param {string} name
 * @param {number} value
 * @returns {void}
 * @throws {RangeError} unless value is a finite number above zero
 */
function requirePositive(name, value) {
  if (!(Number.isFinite(value) && value > 0)) {
    throw new RangeError(`${name} must be a positive number, got ${value}`);
  }
}

/**
 * @param {string} name
 * @param {number} value
 * @returns {void}
 * @throws {RangeError} unless value is an integer of at least one
 */
function requireCount(name, value) {
  if (!(Number.isInteger(value) && value >= 1)) {
    throw new RangeError(`${name} must be a positive integer, got ${value}`);
  }
}

/**
 * @param {number} amplitude
 * @returns {void}
 * @throws {RangeError} unless amplitude is a finite non-negative number
 */
function requireAmplitude(amplitude) {
  if (!(Number.isFinite(amplitude) && amplitude >= 0)) {
    throw new RangeError(`amplitude must be a non-negative number, got ${amplitude}`);
  }
}

/**
 * @param {number} ms cumulative time in milliseconds
 * @param {number} sampleRate Hz
 * @returns {number} the nearest sample index
 */
function toSample(ms, sampleRate) {
  return Math.round((ms * sampleRate) / MS_PER_S);
}

/**
 * Render contiguous segments as one phase-continuous buffer. The phase runs across segment
 * boundaries, so a change of frequency never restarts the wave.
 * @param {number} sampleRate
 * @param {Segment[]} segments in time order, covering the piece without gaps
 * @param {number} totalSamples
 * @param {number} amplitude
 * @returns {Float32Array} the piece, faded in and out
 */
function render(sampleRate, segments, totalSamples, amplitude) {
  const out = new Float32Array(totalSamples);
  let phase = 0;
  for (const seg of segments) {
    const from = toSample(seg.fromMs, sampleRate);
    const to = toSample(seg.toMs, sampleRate);
    const step = (TWO_PI * seg.hz) / sampleRate;
    for (let i = from; i < to; i++) {
      out[i] = amplitude * Math.sin(phase);
      phase = (phase + step) % TWO_PI;
    }
  }
  const fade = Math.min(toSample(FADE_MS, sampleRate), Math.floor(totalSamples / 2));
  for (let i = 0; i < fade; i++) {
    const gain = 0.5 - 0.5 * Math.cos((Math.PI * i) / fade);
    out[i] *= gain;
    out[totalSamples - 1 - i] *= gain;
  }
  return out;
}

/**
 * Synthesise `repeats` back-to-back frame periods. Each period sends one symbol per slot
 * (a tone `step` grid steps from rest, for symbolMs, then rest for the remainder of the slot)
 * and holds rest until framePeriodMs has elapsed.
 * @param {object} options
 * @param {number} options.sampleRate Hz
 * @param {number} options.restHz the tag's rest tone
 * @param {number[]} options.symbols grid steps from rest, one per symbol
 * @param {number} options.repeats frame periods to send
 * @param {number} [options.amplitude=0.05]
 * @returns {Float32Array}
 * @throws {RangeError} on a non-positive rate or count, empty or non-integer symbols, or
 *   symbols too many to fit in one frame period
 */
export function synthFrames({ sampleRate, restHz, symbols, repeats, amplitude = DEFAULT_AMPLITUDE }) {
  requirePositive('sampleRate', sampleRate);
  requirePositive('restHz', restHz);
  requireAmplitude(amplitude);
  requireCount('repeats', repeats);
  if (!Array.isArray(symbols) || symbols.length === 0) {
    throw new RangeError('symbols must be a non-empty array');
  }
  for (const step of symbols) {
    if (!Number.isInteger(step)) throw new RangeError(`symbols must be integers, got ${step}`);
  }
  const { gridHz, slotMs, symbolMs, framePeriodMs } = TAG_PROTOCOL;
  if (symbols.length * slotMs > framePeriodMs) {
    throw new RangeError(`${symbols.length} symbols do not fit in a ${framePeriodMs} ms frame`);
  }

  /** @type {Segment[]} */
  const segments = [];
  for (let p = 0; p < repeats; p++) {
    const frameStart = p * framePeriodMs;
    symbols.forEach((step, s) => {
      const slotStart = frameStart + s * slotMs;
      segments.push({ hz: restHz + step * gridHz, fromMs: slotStart, toMs: slotStart + symbolMs });
      segments.push({ hz: restHz, fromMs: slotStart + symbolMs, toMs: slotStart + slotMs });
    });
    segments.push({
      hz: restHz,
      fromMs: frameStart + symbols.length * slotMs,
      toMs: frameStart + framePeriodMs,
    });
  }
  return render(sampleRate, segments, toSample(repeats * framePeriodMs, sampleRate), amplitude);
}

/**
 * A single steady tone.
 * @param {object} options
 * @param {number} options.sampleRate Hz
 * @param {number} options.hz tone frequency
 * @param {number} options.ms duration
 * @param {number} [options.amplitude=0.05]
 * @returns {Float32Array}
 * @throws {RangeError} on a non-positive rate, frequency or duration
 */
export function synthTone({ sampleRate, hz, ms, amplitude = DEFAULT_AMPLITUDE }) {
  requirePositive('sampleRate', sampleRate);
  requirePositive('hz', hz);
  requirePositive('ms', ms);
  requireAmplitude(amplitude);
  return render(sampleRate, [{ hz, fromMs: 0, toMs: ms }], toSample(ms, sampleRate), amplitude);
}

/**
 * A rest tone that jumps by `offsetHz` for hopMs at the end of every period.
 * @param {object} options
 * @param {number} options.sampleRate Hz
 * @param {number} options.restHz the rest tone
 * @param {number} options.offsetHz size of the jump, signed
 * @param {number} options.periodMs time from one jump to the next
 * @param {number} options.hops number of periods
 * @param {number} [options.amplitude=0.05]
 * @returns {Float32Array}
 * @throws {RangeError} on a non-positive rate, frequency, or count, a period not longer than
 *   a jump, or a jump that takes the tone to zero or below
 */
export function synthHop({ sampleRate, restHz, offsetHz, periodMs, hops, amplitude = DEFAULT_AMPLITUDE }) {
  requirePositive('sampleRate', sampleRate);
  requirePositive('restHz', restHz);
  requirePositive('periodMs', periodMs);
  requireCount('hops', hops);
  requireAmplitude(amplitude);
  if (!Number.isFinite(offsetHz) || restHz + offsetHz <= 0) {
    throw new RangeError(`offsetHz ${offsetHz} takes the tone at ${restHz} Hz to zero or below`);
  }
  const { hopMs } = TAG_PROTOCOL;
  if (periodMs <= hopMs) {
    throw new RangeError(`periodMs must exceed the ${hopMs} ms jump, got ${periodMs}`);
  }

  const jumpHz = restHz + offsetHz;
  /** @type {Segment[]} */
  const segments = [];
  for (let p = 0; p < hops; p++) {
    const start = p * periodMs;
    const jumpStart = start + periodMs - hopMs;
    segments.push({ hz: restHz, fromMs: start, toMs: jumpStart });
    segments.push({ hz: jumpHz, fromMs: jumpStart, toMs: start + periodMs });
  }
  return render(sampleRate, segments, toSample(hops * periodMs, sampleRate), amplitude);
}

/**
 * Digital silence.
 * @param {number} sampleRate Hz
 * @param {number} ms duration
 * @returns {Float32Array}
 * @throws {RangeError} on a non-positive rate or duration
 */
export function silence(sampleRate, ms) {
  requirePositive('sampleRate', sampleRate);
  requirePositive('ms', ms);
  return new Float32Array(toSample(ms, sampleRate));
}

/**
 * Join buffers end to end.
 * @param {...ArrayLike<number>} parts
 * @returns {Float32Array} a new buffer holding every part in order
 */
export function concat(...parts) {
  const total = parts.reduce((n, part) => n + part.length, 0);
  const out = new Float32Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * Seeded PRNG (mulberry32): the same seed always yields the same sequence.
 * @param {number} seed
 * @returns {() => number} uniform values in [0, 1)
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
 * Add white Gaussian noise. The input is not modified.
 * @param {ArrayLike<number>} samples
 * @param {number} rms RMS of the noise to add (0 adds nothing)
 * @param {number} seed integer seed for the PRNG
 * @returns {Float32Array} a new buffer, samples plus noise
 * @throws {RangeError} when rms is negative or not finite
 */
export function addNoise(samples, rms, seed) {
  requireAmplitude(rms);
  const rnd = mulberry32(seed);
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const u1 = Math.max(rnd(), MIN_UNIFORM);
    const u2 = rnd();
    const gauss = Math.sqrt(-2 * Math.log(u1)) * Math.cos(TWO_PI * u2);
    out[i] = samples[i] + rms * gauss;
  }
  return out;
}
