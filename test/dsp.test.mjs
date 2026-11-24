import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hannPeriodic,
  FFT,
  SpectrumAnalyzer,
  stft,
  bandIndices,
  bandPowerDb,
  BandTrigger,
  analyticBand,
  bandpass,
  envelope,
  instantaneousFrequency,
  xcorrPeak,
  encodeWav,
  decodeWav,
  colorLUT,
} from '../web/dsp.js';

/** Seeded PRNG (mulberry32) so tests are deterministic. */
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

/** Uniform noise in [-1, 1). */
function noise(n, seed) {
  const rnd = mulberry32(seed);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = rnd() * 2 - 1;
  return out;
}

function tone(n, freqHz, fs, amp = 1) {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.cos((2 * Math.PI * freqHz * i) / fs);
  return out;
}

function rms(x, from = 0, to = x.length) {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / (to - from));
}

function db20(ratio) {
  return 20 * Math.log10(ratio);
}

/** Builds a RIFF/WAVE file from already-serialized chunks. */
function buildRiff(chunks) {
  const bodyLen = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(12 + bodyLen);
  const dv = new DataView(out.buffer);
  writeAscii(out, 0, 'RIFF');
  dv.setUint32(4, 4 + bodyLen, true);
  writeAscii(out, 8, 'WAVE');
  let off = 12;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out.buffer;
}

function writeAscii(bytes, off, s) {
  for (let i = 0; i < s.length; i++) bytes[off + i] = s.charCodeAt(i);
}

/** Serializes one chunk: id, LE size, body, and a pad byte when the body is odd-sized. */
function chunk(id, body) {
  const pad = body.length & 1;
  const out = new Uint8Array(8 + body.length + pad);
  writeAscii(out, 0, id);
  new DataView(out.buffer).setUint32(4, body.length, true);
  out.set(body, 8);
  return out;
}

function fmtBody({ tag, channels = 1, sampleRate = 48000, bits, extensible = false }) {
  const size = extensible ? 40 : 16;
  const b = new Uint8Array(size);
  const dv = new DataView(b.buffer);
  dv.setUint16(0, extensible ? 0xfffe : tag, true);
  dv.setUint16(2, channels, true);
  dv.setUint32(4, sampleRate, true);
  dv.setUint32(8, sampleRate * channels * (bits / 8), true);
  dv.setUint16(12, channels * (bits / 8), true);
  dv.setUint16(14, bits, true);
  if (extensible) {
    dv.setUint16(16, 22, true); // cbSize
    dv.setUint16(18, bits, true); // valid bits
    dv.setUint32(20, channels === 1 ? 4 : 3, true); // channel mask
    dv.setUint16(24, tag, true); // SubFormat GUID, first two bytes = format tag
  }
  return b;
}

function bytesOf(values, width, setter) {
  const out = new Uint8Array(values.length * width);
  const dv = new DataView(out.buffer);
  values.forEach((v, i) => setter(dv, i * width, v));
  return out;
}

// ---------------------------------------------------------------------------
// hannPeriodic

test('hannPeriodic: length, zero start, RMS-preserving scale, periodic symmetry', () => {
  const n = 512;
  const w = hannPeriodic(n);
  assert.ok(w instanceof Float32Array);
  assert.equal(w.length, n);
  assert.equal(w[0], 0);
  let meanSq = 0;
  for (const v of w) meanSq += v * v;
  meanSq /= n;
  assert.ok(Math.abs(meanSq - 1) < 1e-6, `mean(w^2) = ${meanSq}`);
  // Peak of the scaled window is sqrt(8/3) at i = n/2.
  assert.ok(Math.abs(w[n / 2] - Math.sqrt(8 / 3)) < 1e-6);
  // Periodic: w[i] == w[n-i] for i >= 1.
  for (let i = 1; i < n; i++) assert.ok(Math.abs(w[i] - w[n - i]) < 1e-6);
});

// ---------------------------------------------------------------------------
// FFT

test('FFT: rejects non power-of-two sizes with RangeError', () => {
  for (const n of [0, 3, 100, 1000, -8]) {
    assert.throws(() => new FFT(n), RangeError, `n=${n}`);
  }
  assert.doesNotThrow(() => new FFT(1024));
});

test('FFT: forward then inverse round-trips a random complex signal', () => {
  const n = 256;
  const rnd = mulberry32(7);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    re[i] = rnd() * 2 - 1;
    im[i] = rnd() * 2 - 1;
  }
  const re0 = Float64Array.from(re);
  const im0 = Float64Array.from(im);
  const fft = new FFT(n);
  fft.forward(re, im);
  fft.inverse(re, im);
  for (let i = 0; i < n; i++) {
    assert.ok(Math.abs(re[i] - re0[i]) < 1e-9, `re[${i}]`);
    assert.ok(Math.abs(im[i] - im0[i]) < 1e-9, `im[${i}]`);
  }
});

test('FFT: a cosine on bin 10 lands in bins 10 and n-10 with magnitude n/2', () => {
  const n = 256;
  const x = tone(n, 10 * (48000 / n), 48000); // exactly on bin 10
  const re = Float64Array.from(x);
  const im = new Float64Array(n);
  new FFT(n).forward(re, im);
  const mag = (k) => Math.hypot(re[k], im[k]);
  assert.ok(Math.abs(mag(10) - n / 2) < 1e-6, `|X[10]| = ${mag(10)}`);
  assert.ok(Math.abs(mag(n - 10) - n / 2) < 1e-6);
  for (let k = 0; k < n; k++) {
    if (k === 10 || k === n - 10) continue;
    assert.ok(mag(k) < 1e-6, `leakage at bin ${k}: ${mag(k)}`);
  }
});

test('FFT: Parseval, sum|x|^2 = (1/n) sum|X|^2', () => {
  const n = 512;
  const x = noise(n, 99);
  const re = Float64Array.from(x);
  const im = new Float64Array(n);
  new FFT(n).forward(re, im);
  let timeE = 0;
  let freqE = 0;
  for (let i = 0; i < n; i++) {
    timeE += x[i] * x[i];
    freqE += re[i] * re[i] + im[i] * im[i];
  }
  assert.ok(Math.abs(timeE - freqE / n) / timeE < 1e-12);
});

// ---------------------------------------------------------------------------
// SpectrumAnalyzer / powerDb

test('SpectrumAnalyzer.powerDb: full-scale on-bin sine reads 10log10(1/6) = -7.78 dB', () => {
  // Measured analytically: |X[k]| = (1/2) * sum(w) = N * sqrt(2/3) / 2 = 0.4082 N,
  // so |X[k]|^2 / N^2 = 1/6 and the dB value is -7.7815 dB.
  const n = 1024;
  const k = 64;
  const x = tone(n, (k * 48000) / n, 48000);
  const an = new SpectrumAnalyzer(n);
  assert.equal(an.bins, n / 2 + 1);
  const out = new Float32Array(an.bins);
  const ret = an.powerDb(x, 0, out);
  assert.equal(ret, out);
  const expected = 10 * Math.log10(1 / 6);
  assert.ok(Math.abs(out[k] - expected) < 0.5, `bin ${k} = ${out[k]} dB, expected ${expected}`);
  // Hann main lobe: the immediate neighbours sit 6.02 dB below the on-bin peak.
  assert.ok(Math.abs(out[k] - out[k - 1] - 6.0206) < 0.1, `neighbour k-1 ${out[k - 1]}`);
  assert.ok(Math.abs(out[k] - out[k + 1] - 6.0206) < 0.1, `neighbour k+1 ${out[k + 1]}`);
  // Beyond the main lobe the leakage is far lower.
  let maxFar = -Infinity;
  for (let i = 0; i < an.bins; i++) if (Math.abs(i - k) > 3 && out[i] > maxFar) maxFar = out[i];
  assert.ok(out[k] - maxFar > 60, `far-bin margin ${out[k] - maxFar} dB`);
});

test('SpectrumAnalyzer.powerDb: rejects out-of-range frames and short output buffers', () => {
  const an = new SpectrumAnalyzer(64);
  const x = new Float32Array(100);
  assert.throws(() => an.powerDb(x, 37, new Float32Array(an.bins)), RangeError);
  assert.throws(() => an.powerDb(x, -1, new Float32Array(an.bins)), RangeError);
  assert.throws(() => an.powerDb(x, 0, new Float32Array(3)), RangeError);
  assert.throws(() => new SpectrumAnalyzer(100), RangeError);
});

// ---------------------------------------------------------------------------
// stft

test('stft: frame count, shape, and row contents', () => {
  const x = noise(1000, 3);
  const { frames, bins, data } = stft(x, 256, 128);
  assert.equal(frames, Math.floor((1000 - 256) / 128) + 1); // 6
  assert.equal(bins, 129);
  assert.ok(data instanceof Float32Array);
  assert.equal(data.length, frames * bins);
  // Row 2 starts at sample 2*hop = 256.
  const an = new SpectrumAnalyzer(256);
  const row = new Float32Array(bins);
  an.powerDb(x, 256, row);
  for (let k = 0; k < bins; k++) assert.equal(data[2 * bins + k], row[k]);
});

test('stft: input shorter than fftSize gives zero frames; bad hop throws', () => {
  const r = stft(new Float32Array(100), 256, 64);
  assert.equal(r.frames, 0);
  assert.equal(r.data.length, 0);
  assert.throws(() => stft(new Float32Array(1000), 256, 0), RangeError);
});

// ---------------------------------------------------------------------------
// bandIndices / bandPowerDb

test('bandIndices: maps Hz to inclusive bins at 48 kHz / 1024', () => {
  // binHz = 46.875
  const { lo, hi } = bandIndices(48000, 1024, 15000, 22000);
  assert.equal(lo, 320); // 15000 / 46.875 = 320
  assert.equal(hi, 469); // 22000 / 46.875 = 469.33 -> 469
  assert.ok(lo <= hi);
});

test('bandIndices: clamps to [0, fftSize/2] and keeps lo <= hi', () => {
  assert.deepEqual(bandIndices(48000, 1024, -500, 30000), { lo: 0, hi: 512 });
  const narrow = bandIndices(48000, 1024, 18000, 18001);
  assert.ok(narrow.lo <= narrow.hi);
  assert.deepEqual(bandIndices(48000, 1024, 22000, 15000), { lo: 320, hi: 469 });
});

test('bandPowerDb: sums linear powers, not dB values', () => {
  // Three bins at 0 dB -> sum of linear powers = 3 -> 4.771 dB
  assert.ok(Math.abs(bandPowerDb([0, 0, 0, 0], 0, 2) - 10 * Math.log10(3)) < 1e-12);
  // -10, 0, +10 dB -> 0.1 + 1 + 10 = 11.1 linear
  const v = bandPowerDb([-10, 0, 10], 0, 2);
  assert.ok(Math.abs(v - 10 * Math.log10(11.1)) < 1e-9, `got ${v}`);
  // Single bin is identity.
  assert.ok(Math.abs(bandPowerDb([-3, 7], 1, 1) - 7) < 1e-12);
});

// ---------------------------------------------------------------------------
// BandTrigger

test('BandTrigger: fires exactly once on a step, then stays quiet while active', () => {
  const tr = new BandTrigger();
  let fires = [];
  for (let i = 0; i < 100; i++) if (tr.process(-60)) fires.push(i);
  assert.deepEqual(fires, []);
  assert.ok(Math.abs(tr.floorDb - -60) < 1e-9);
  // Step to -40 dB (20 dB above the floor).
  for (let i = 100; i < 200; i++) if (tr.process(-40)) fires.push(i);
  assert.deepEqual(fires, [100]);
  assert.equal(tr.active, true);
  assert.ok(Math.abs(tr.floorDb - -60) < 1e-9, 'floor must freeze while active');
});

test('BandTrigger: does not fire on slow drift (floor tracks it)', () => {
  const tr = new BandTrigger();
  let fires = 0;
  let level = -60;
  for (let i = 0; i < 3000; i++) {
    level += 0.005; // 0.005 dB per frame; EMA lag is about 1 dB
    if (tr.process(level)) fires++;
  }
  assert.equal(fires, 0);
});

test('BandTrigger: never fires during the 20-frame warm-up', () => {
  const tr = new BandTrigger();
  const fires = [];
  // Frame 1 initializes the floor at -60; frame 5 is a big spike.
  for (let i = 0; i < 20; i++) {
    if (tr.process(i === 4 ? 0 : -60)) fires.push(i + 1);
  }
  assert.deepEqual(fires, []);
  // Frame 21 onward can fire.
  assert.equal(tr.process(0), true);
});

test('BandTrigger: refractory delays re-arm; re-arm needs release level as well', () => {
  const tr = new BandTrigger({ refractoryFrames: 50 });
  for (let i = 0; i < 100; i++) tr.process(-60);
  assert.equal(tr.process(-40), true); // fire
  // Quiet for 49 frames: still disarmed by the refractory period.
  for (let i = 0; i < 49; i++) assert.equal(tr.process(-60), false);
  assert.equal(tr.active, true);
  // 50th frame after the fire: quiet and past refractory, so it re-arms.
  assert.equal(tr.process(-60), false);
  assert.equal(tr.active, false);
  // A new step now fires again.
  assert.equal(tr.process(-40), true);
});

test('BandTrigger: a level above the release threshold keeps it disarmed', () => {
  const tr = new BandTrigger({ thresholdDb: 12, releaseDb: 6, refractoryFrames: 50 });
  for (let i = 0; i < 100; i++) tr.process(-60);
  assert.equal(tr.process(-40), true);
  // -50 dB is above floor + release (-54), so it must not re-arm until maxActiveFrames (300).
  let fires = 0;
  for (let i = 0; i < 250; i++) if (tr.process(-50)) fires++;
  assert.equal(fires, 0);
  assert.equal(tr.active, true);
});

test('BandTrigger: reset() clears state and re-initializes the floor', () => {
  const tr = new BandTrigger();
  for (let i = 0; i < 50; i++) tr.process(-60);
  tr.process(-30);
  assert.equal(tr.active, true);
  tr.reset();
  assert.equal(tr.active, false);
  tr.process(-20);
  assert.equal(tr.floorDb, -20);
});

// ---------------------------------------------------------------------------
// analyticBand / bandpass / envelope

const FS = 48000;

test('analyticBand: keeps an in-band 18 kHz tone within 1 dB and rejects a 5 kHz tone by > 40 dB', () => {
  const n = 9600; // pads to 16384
  const inBand = tone(n, 18000, FS, 1);
  const outOfBand = tone(n, 5000, FS, 1);
  const a = analyticBand(inBand, FS, 15000, 22000);
  assert.equal(a.re.length, n);
  assert.equal(a.im.length, n);
  const env = envelope(a);
  // Middle region avoids the truncation edges of the finite tone.
  for (let i = 2000; i < n - 2000; i += 97) {
    assert.ok(Math.abs(db20(env[i])) < 1, `envelope[${i}] = ${env[i]}`);
  }
  const b = bandpass(outOfBand, FS, 15000, 22000);
  const rejectionDb = db20(rms(b, 2000, n - 2000) / rms(outOfBand, 2000, n - 2000));
  assert.ok(rejectionDb < -40, `rejection ${rejectionDb} dB`);
});

test('analyticBand: real part equals bandpass; empty input gives empty output', () => {
  const x = noise(1000, 5);
  const a = analyticBand(x, FS, 1000, 5000);
  assert.deepEqual(bandpass(x, FS, 1000, 5000), a.re);
  const e = analyticBand(new Float32Array(0), FS, 1000, 5000);
  assert.equal(e.re.length, 0);
  assert.equal(e.im.length, 0);
});

test('envelope: is sqrt(re^2 + im^2) and of matching length', () => {
  const env = envelope({ re: new Float32Array([3, 0]), im: new Float32Array([4, 0]) });
  assert.ok(env instanceof Float32Array);
  assert.equal(env[0], 5);
  assert.equal(env[1], 0);
});

// ---------------------------------------------------------------------------
// instantaneousFrequency

test('instantaneousFrequency: recovers an 18 kHz tone away from the edges', () => {
  const n = 16000;
  const x = tone(n, 18000, FS, 1);
  const a = analyticBand(x, FS, 17000, 19000);
  const f = instantaneousFrequency(a, FS);
  assert.equal(f.length, n);
  for (let i = 500; i < n - 500; i++) {
    assert.ok(Math.abs(f[i] - 18000) < 5, `f[${i}] = ${f[i]}`);
  }
  assert.equal(f[0], f[1]);
});

test('instantaneousFrequency: distinguishes the 18 kHz and 19 kHz halves of an FSK switch', () => {
  const n = 16000;
  const half = 8000;
  const x = new Float64Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const f = i < half ? 18000 : 19000;
    phase += (2 * Math.PI * f) / FS;
    x[i] = Math.cos(phase);
  }
  const a = analyticBand(x, FS, 17500, 19500);
  const f = instantaneousFrequency(a, FS);
  // Stay clear of the switch (band-edge ringing spreads over a few hundred samples).
  for (let i = 1000; i < half - 1000; i++) {
    assert.ok(Math.abs(f[i] - 18000) < 5, `first half f[${i}] = ${f[i]}`);
  }
  for (let i = half + 1000; i < n - 1000; i++) {
    assert.ok(Math.abs(f[i] - 19000) < 5, `second half f[${i}] = ${f[i]}`);
  }
});

// ---------------------------------------------------------------------------
// xcorrPeak

test('xcorrPeak: delayed copy gives peak ~1 with positive lag when b is later', () => {
  const a = noise(2000, 11);
  const d = 37;
  const b = new Float64Array(a.length + d);
  b.set(a, d);
  const { peak, lag } = xcorrPeak(a, b);
  assert.ok(peak > 0.999, `peak ${peak}`);
  assert.equal(lag, d);
});

test('xcorrPeak: sign flips when the roles are swapped; works with unequal lengths', () => {
  const a = noise(1000, 12);
  const b = new Float64Array(3000);
  b.set(a, 500);
  assert.equal(xcorrPeak(b, a).lag, -500);
  const r = xcorrPeak(a, b);
  assert.ok(r.peak > 0.999);
  assert.equal(r.lag, 500);
});

test('xcorrPeak: independent noise gives a low peak (< 0.3)', () => {
  const a = noise(4096, 21);
  const b = noise(4096, 22);
  const { peak } = xcorrPeak(a, b);
  assert.ok(peak < 0.3, `peak ${peak}`);
  assert.ok(peak >= 0 && peak <= 1);
});

test('xcorrPeak: zero-energy input returns {peak: 0, lag: 0}', () => {
  assert.deepEqual(xcorrPeak(new Float32Array(100), noise(100, 1)), { peak: 0, lag: 0 });
  assert.deepEqual(xcorrPeak(noise(100, 1), new Float32Array(0)), { peak: 0, lag: 0 });
});

// ---------------------------------------------------------------------------
// WAV

test('encodeWav/decodeWav: float32 round trip is bit-exact and header is 44 bytes', () => {
  const samples = Float32Array.from([0, 1, -1, 0.5, -0.333333343, 1e-30, 0.1, 123.5]);
  const buf = encodeWav(samples, 48000);
  assert.equal(buf.byteLength, 44 + samples.length * 4);
  const dv = new DataView(buf);
  const ascii = (o) => String.fromCharCode(...new Uint8Array(buf, o, 4));
  assert.equal(ascii(0), 'RIFF');
  assert.equal(ascii(8), 'WAVE');
  assert.equal(ascii(12), 'fmt ');
  assert.equal(dv.getUint16(20, true), 3); // IEEE float
  assert.equal(dv.getUint16(22, true), 1); // mono
  assert.equal(dv.getUint32(24, true), 48000);
  assert.equal(dv.getUint16(34, true), 32);
  assert.equal(ascii(36), 'data');
  const { sampleRate, samples: out } = decodeWav(buf);
  assert.equal(sampleRate, 48000);
  assert.ok(out instanceof Float32Array);
  assert.deepEqual(out, samples);
});

test('decodeWav: hand-built 16-bit PCM file decodes correctly', () => {
  const pcm = bytesOf([0, 16384, -32768, 32767], 2, (dv, o, v) => dv.setInt16(o, v, true));
  const file = buildRiff([chunk('fmt ', fmtBody({ tag: 1, bits: 16, sampleRate: 44100 })), chunk('data', pcm)]);
  const { sampleRate, samples } = decodeWav(file);
  assert.equal(sampleRate, 44100);
  assert.equal(samples.length, 4);
  assert.equal(samples[0], 0);
  assert.equal(samples[1], 0.5);
  assert.equal(samples[2], -1);
  assert.ok(Math.abs(samples[3] - 32767 / 32768) < 1e-12);
});

test('decodeWav: skips an odd-sized LIST chunk placed before data', () => {
  const pcm = bytesOf([1000, -1000, 2000], 2, (dv, o, v) => dv.setInt16(o, v, true));
  const list = chunk('LIST', new TextEncoder().encode('INFOabc')); // 7 bytes -> padded to 8
  const file = buildRiff([
    chunk('fmt ', fmtBody({ tag: 1, bits: 16, sampleRate: 48000 })),
    list,
    chunk('data', pcm),
  ]);
  const { sampleRate, samples } = decodeWav(file);
  assert.equal(sampleRate, 48000);
  assert.deepEqual(Array.from(samples), [1000 / 32768, -1000 / 32768, 2000 / 32768]);
});

test('decodeWav: 24-bit PCM, WAVE_FORMAT_EXTENSIBLE wrappers, and multi-channel (first channel kept)', () => {
  // 24-bit, mono: values 0x400000 (0.5), 0x800000 (-1), 0x7FFFFF (~1)
  const pcm24 = new Uint8Array([0x00, 0x00, 0x40, 0x00, 0x00, 0x80, 0xff, 0xff, 0x7f]);
  const f24 = buildRiff([chunk('fmt ', fmtBody({ tag: 1, bits: 24 })), chunk('data', pcm24)]);
  const d24 = decodeWav(f24).samples;
  assert.ok(Math.abs(d24[0] - 0.5) < 1e-9);
  assert.ok(Math.abs(d24[1] + 1) < 1e-9);
  assert.ok(Math.abs(d24[2] - 8388607 / 8388608) < 1e-9);

  // Extensible float32, mono.
  const f32 = bytesOf([0.25, -0.75], 4, (dv, o, v) => dv.setFloat32(o, v, true));
  const fx = buildRiff([chunk('fmt ', fmtBody({ tag: 3, bits: 32, extensible: true })), chunk('data', f32)]);
  assert.deepEqual(Array.from(decodeWav(fx).samples), [0.25, -0.75]);

  // Extensible 16-bit PCM, stereo: frames are (L, R); keep L.
  const st = bytesOf([100, -200, 300, -400], 2, (dv, o, v) => dv.setInt16(o, v, true));
  const stereo = buildRiff([
    chunk('fmt ', fmtBody({ tag: 1, channels: 2, bits: 16, extensible: true })),
    chunk('data', st),
  ]);
  const dec = decodeWav(stereo);
  assert.deepEqual(Array.from(dec.samples), [100 / 32768, 300 / 32768]);
});

test('decodeWav: unsupported formats and malformed files throw a clear Error', () => {
  const pcm8 = new Uint8Array([1, 2, 3]);
  const bad8 = buildRiff([chunk('fmt ', fmtBody({ tag: 1, bits: 8 })), chunk('data', pcm8)]);
  assert.throws(() => decodeWav(bad8), /unsupported WAV format.*8-bit/);
  const mu = buildRiff([chunk('fmt ', fmtBody({ tag: 7, bits: 8 })), chunk('data', pcm8)]);
  assert.throws(() => decodeWav(mu), /unsupported WAV format/);
  assert.throws(() => decodeWav(new ArrayBuffer(4)), /not a RIFF\/WAVE/);
  const noData = buildRiff([chunk('fmt ', fmtBody({ tag: 1, bits: 16 }))]);
  assert.throws(() => decodeWav(noData), /missing "data"/);
});

// ---------------------------------------------------------------------------
// colorLUT

test('colorLUT: 256 opaque RGBA entries ramping from near-black to pale yellow', () => {
  const lut = colorLUT();
  assert.ok(lut instanceof Uint8ClampedArray);
  assert.equal(lut.length, 256 * 4);
  for (let i = 0; i < 256; i++) assert.equal(lut[i * 4 + 3], 255);
  // Start: near-black.
  assert.ok(lut[0] < 20 && lut[1] < 20 && lut[2] < 40, 'first entry should be near black');
  // End: pale yellow.
  const e = 255 * 4;
  assert.ok(lut[e] > 240 && lut[e + 1] > 240 && lut[e + 2] > 120, 'last entry should be pale yellow');
  // Mid-ramp passes through red-orange (red dominates).
  const m = 180 * 4;
  assert.ok(lut[m] > lut[m + 2], 'mid entries should be warm');
  // Brightness increases overall.
  const luma = (i) => 0.3 * lut[i * 4] + 0.59 * lut[i * 4 + 1] + 0.11 * lut[i * 4 + 2];
  assert.ok(luma(255) - luma(0) > 150);
});

test('BandTrigger: a lasting step up becomes the new floor and the trigger re-arms', () => {
  const tr = new BandTrigger({ maxActiveFrames: 300 });
  for (let i = 0; i < 100; i++) tr.process(-120);
  let fires = 0;
  for (let i = 0; i < 400; i++) if (tr.process(-100)) fires++;
  assert.equal(fires, 1);
  assert.equal(tr.active, false);
  assert.ok(Math.abs(tr.floorDb - -100) < 1, `floor ${tr.floorDb}`);
  let second = false;
  for (let i = 0; i < 5; i++) second = tr.process(-80) || second;
  assert.equal(second, true);
});
