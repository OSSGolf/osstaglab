/**
 * dsp.js - pure-JavaScript DSP core for OSSTagLab.
 *
 * Loaded as an ES module by the browser and imported by Node tests.
 * No DOM, no Node APIs, no dependencies. Intended for 48 kHz microphone
 * recordings of short near-ultrasonic (15-22 kHz) data-over-sound bursts.
 *
 * Hot-path notes: per-frame functions (SpectrumAnalyzer.powerDb,
 * BandTrigger.process) reuse internal buffers and do not allocate.
 */

const TWO_PI = 2 * Math.PI;

/** Width in Hz of the raised-cosine taper applied outside each band edge. */
const BAND_TAPER_HZ = 200;

/** Frames at the start of a BandTrigger stream during which it cannot fire. */
const TRIGGER_WARMUP_FRAMES = 20;

/**
 * @param {number} n
 * @returns {boolean} true when n is a positive power of two.
 */
function isPow2(n) {
  return Number.isInteger(n) && n >= 1 && (n & (n - 1)) === 0 && n <= 0x40000000;
}

/**
 * @param {number} n
 * @returns {number} smallest power of two >= n (at least 1).
 */
function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/**
 * Cache of FFT plans keyed by size, so repeated offline analysis calls do not
 * recompute twiddles.
 * @type {Map<number, FFT>}
 */
const fftPlanCache = new Map();

/**
 * @param {number} n power-of-two transform size
 * @returns {FFT} shared plan for size n
 */
function getFFT(n) {
  let plan = fftPlanCache.get(n);
  if (!plan) {
    plan = new FFT(n);
    fftPlanCache.set(n, plan);
  }
  return plan;
}

/**
 * Periodic Hann window scaled so that mean(w^2) = 1 (RMS-preserving).
 * w[i] = 0.5 - 0.5 cos(2 pi i / n) * sqrt(8/3).
 * @param {number} n window length (>= 1)
 * @returns {Float32Array} window of length n
 */
export function hannPeriodic(n) {
  const w = new Float32Array(n);
  const raw = new Float64Array(n);
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const v = 0.5 - 0.5 * Math.cos((TWO_PI * i) / n);
    raw[i] = v;
    sumSq += v * v;
  }
  if (sumSq === 0) {
    // Only reachable for n = 1, where the periodic Hann degenerates to [0].
    w.fill(1);
    return w;
  }
  const scale = Math.sqrt(n / sumSq);
  for (let i = 0; i < n; i++) w[i] = raw[i] * scale;
  return w;
}

/**
 * @param {ArrayLike<number>} values
 * @returns {number} the median (mean of the middle two for an even count), or NaN when empty
 */
export function median(values) {
  if (values.length === 0) return NaN;
  const sorted = Float64Array.from(values).sort();
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * In-place iterative radix-2 complex FFT of fixed size.
 * Twiddles and the bit-reversal permutation are precomputed in the constructor.
 */
export class FFT {
  /**
   * @param {number} n transform size; must be a power of two
   * @throws {RangeError} if n is not a power of two
   */
  constructor(n) {
    if (!isPow2(n)) {
      throw new RangeError(`FFT size must be a power of two, got ${n}`);
    }
    /** @type {number} */
    this.n = n;
    const half = n >> 1;
    /** @type {Float64Array} cos(2 pi k / n), k < n/2 */
    this._cos = new Float64Array(half);
    /** @type {Float64Array} sin(2 pi k / n), k < n/2 */
    this._sin = new Float64Array(half);
    for (let k = 0; k < half; k++) {
      const a = (TWO_PI * k) / n;
      this._cos[k] = Math.cos(a);
      this._sin[k] = Math.sin(a);
    }
    const bits = Math.round(Math.log2(n));
    /** @type {Uint32Array} bit-reversal permutation */
    this._rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      let x = i;
      for (let b = 0; b < bits; b++) {
        r = (r << 1) | (x & 1);
        x >>= 1;
      }
      this._rev[i] = r;
    }
  }

  /**
   * Forward DFT (kernel e^{-j 2 pi k i / n}), in place, unscaled.
   * @param {Float32Array|Float64Array} re real parts, length n
   * @param {Float32Array|Float64Array} im imaginary parts, length n
   * @returns {void}
   */
  forward(re, im) {
    this._transform(re, im, -1);
  }

  /**
   * Inverse DFT, in place, scaled by 1/n.
   * @param {Float32Array|Float64Array} re real parts, length n
   * @param {Float32Array|Float64Array} im imaginary parts, length n
   * @returns {void}
   */
  inverse(re, im) {
    this._transform(re, im, 1);
    const s = 1 / this.n;
    for (let i = 0; i < this.n; i++) {
      re[i] *= s;
      im[i] *= s;
    }
  }

  /**
   * @param {Float32Array|Float64Array} re
   * @param {Float32Array|Float64Array} im
   * @param {number} sign -1 for forward, +1 for inverse (unscaled)
   * @returns {void}
   * @private
   */
  _transform(re, im, sign) {
    const n = this.n;
    if (re.length !== n || im.length !== n) {
      throw new RangeError(`FFT buffers must have length ${n}`);
    }
    const rev = this._rev;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }
    const cosT = this._cos;
    const sinT = this._sin;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0, t = 0; k < half; k++, t += step) {
          const wr = cosT[t];
          const wi = sign * sinT[t];
          const a = start + k;
          const b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
  }
}

/**
 * Windowed power spectrum in dB for real frames. Scratch buffers are reused
 * across calls, so powerDb does not allocate.
 *
 * Scaling: a full-scale sine (amplitude 1) exactly on a bin reads
 * 10 log10(1/6) = -7.78 dB at that bin (see the test suite for the measured figure).
 */
export class SpectrumAnalyzer {
  /**
   * @param {number} fftSize power-of-two frame length (>= 2)
   */
  constructor(fftSize) {
    if (!isPow2(fftSize) || fftSize < 2) {
      throw new RangeError(`fftSize must be a power of two >= 2, got ${fftSize}`);
    }
    /** @type {number} */
    this.fftSize = fftSize;
    /** @type {number} number of one-sided bins, fftSize/2 + 1 */
    this.bins = fftSize / 2 + 1;
    this._fft = new FFT(fftSize);
    this._win = hannPeriodic(fftSize);
    this._re = new Float64Array(fftSize);
    this._im = new Float64Array(fftSize);
  }

  /**
   * Window `fftSize` samples starting at `offset`, FFT them, and write
   * 10 log10(|X[k]|^2 / fftSize^2 + 1e-20) for k = 0..bins-1 into `out`.
   * @param {Float32Array|Float64Array} samples
   * @param {number} offset index of the first sample of the frame
   * @param {Float32Array|Float64Array} out receives `bins` dB values
   * @returns {Float32Array|Float64Array} `out`
   * @throws {RangeError} if the frame lies outside `samples` or `out` is too short
   */
  powerDb(samples, offset, out) {
    const n = this.fftSize;
    if (!Number.isInteger(offset) || offset < 0 || offset + n > samples.length) {
      throw new RangeError(`frame [${offset}, ${offset + n}) outside input of length ${samples.length}`);
    }
    if (out.length < this.bins) {
      throw new RangeError(`out must have at least ${this.bins} elements`);
    }
    const re = this._re;
    const im = this._im;
    const w = this._win;
    for (let i = 0; i < n; i++) {
      re[i] = samples[offset + i] * w[i];
      im[i] = 0;
    }
    this._fft.forward(re, im);
    const norm = 1 / (n * n);
    for (let k = 0; k < this.bins; k++) {
      const p = (re[k] * re[k] + im[k] * im[k]) * norm;
      out[k] = 10 * Math.log10(p + 1e-20);
    }
    return out;
  }
}

/**
 * Short-time spectrum in dB.
 * @param {Float32Array|Float64Array} samples
 * @param {number} fftSize frame length (power of two >= 2)
 * @param {number} hop positive integer hop in samples
 * @returns {{frames: number, bins: number, data: Float32Array}} data is row-major by frame
 *   with frames = floor((len - fftSize)/hop) + 1, or 0 when the input is shorter than fftSize
 */
export function stft(samples, fftSize, hop) {
  if (!Number.isInteger(hop) || hop < 1) {
    throw new RangeError(`hop must be a positive integer, got ${hop}`);
  }
  const analyzer = new SpectrumAnalyzer(fftSize);
  const bins = analyzer.bins;
  const frames = samples.length < fftSize ? 0 : Math.floor((samples.length - fftSize) / hop) + 1;
  const data = new Float32Array(frames * bins);
  const row = new Float32Array(bins);
  for (let f = 0; f < frames; f++) {
    analyzer.powerDb(samples, f * hop, row);
    data.set(row, f * bins);
  }
  return { frames, bins, data };
}

/**
 * Map a frequency band to inclusive bin indices, clamped to [0, fftSize/2].
 * @param {number} sampleRate Hz
 * @param {number} fftSize
 * @param {number} loHz lower edge in Hz (swapped with hiHz if reversed)
 * @param {number} hiHz upper edge in Hz
 * @returns {{lo: number, hi: number}} inclusive bin range with lo <= hi
 */
export function bandIndices(sampleRate, fftSize, loHz, hiHz) {
  const maxBin = fftSize / 2;
  const binHz = sampleRate / fftSize;
  const toBin = (hz) => Math.min(maxBin, Math.max(0, Math.round(hz / binHz)));
  const lo = toBin(Math.min(loHz, hiHz));
  const hi = toBin(Math.max(loHz, hiHz));
  return { lo, hi };
}

/**
 * Band power: 10 log10 of the sum of linear powers in bins lo..hi (inclusive).
 * @param {ArrayLike<number>} dbSpectrum dB values as produced by SpectrumAnalyzer.powerDb
 * @param {number} lo first bin, inclusive
 * @param {number} hi last bin, inclusive (lo <= hi)
 * @returns {number} band power in dB
 */
export function bandPowerDb(dbSpectrum, lo, hi) {
  let sum = 0;
  for (let k = lo; k <= hi; k++) {
    sum += Math.pow(10, dbSpectrum[k] / 10);
  }
  return 10 * Math.log10(sum);
}

/**
 * Adaptive threshold trigger on a per-frame band level (dB).
 *
 * The floor is an exponential moving average that only adapts while the
 * trigger is not active. It fires when bandDb > floorDb + thresholdDb while
 * armed, after the warm-up. It re-arms when bandDb < floorDb + releaseDb and
 * at least refractoryFrames frames have passed since the firing frame.
 */
export class BandTrigger {
  /**
   * @param {object} [options]
   * @param {number} [options.thresholdDb=12] fire when bandDb exceeds floor by this much
   * @param {number} [options.releaseDb=6] re-arm when bandDb falls below floor + this
   * @param {number} [options.floorTimeConstantFrames=200] EMA time constant of the floor
   * @param {number} [options.refractoryFrames=50] minimum frames between fire and re-arm
   * @param {number} [options.maxActiveFrames=300] if the level has not released after this
   *   many frames, the raised level is taken as the new floor and the trigger re-arms.
   *   Without this a step up in background noise (or a floor learned from silence)
   *   would leave the trigger latched forever, because the floor only adapts while idle.
   */
  constructor({
    thresholdDb = 12,
    releaseDb = 6,
    floorTimeConstantFrames = 200,
    refractoryFrames = 50,
    maxActiveFrames = 300,
  } = {}) {
    if (!(floorTimeConstantFrames > 0)) {
      throw new RangeError('floorTimeConstantFrames must be positive');
    }
    /** @type {number} */
    this.thresholdDb = thresholdDb;
    /** @type {number} */
    this.releaseDb = releaseDb;
    /** @type {number} */
    this.refractoryFrames = refractoryFrames;
    /** @type {number} */
    this.maxActiveFrames = maxActiveFrames;
    this._alpha = 1 - Math.exp(-1 / floorTimeConstantFrames);
    /** @type {number} current noise-floor estimate in dB */
    this.floorDb = 0;
    /** @type {boolean} true between a fire and the re-arm */
    this.active = false;
    this._frames = 0;
    this._sinceFire = 0;
  }

  /**
   * Feed one frame's band level.
   * @param {number} bandDb band power in dB for this frame
   * @returns {boolean} true exactly on the frame a trigger fires
   */
  process(bandDb) {
    this._frames++;
    if (this._frames === 1) this.floorDb = bandDb;

    let fired = false;
    if (this.active) {
      this._sinceFire++;
      if (this._sinceFire >= this.refractoryFrames && bandDb < this.floorDb + this.releaseDb) {
        this.active = false;
      } else if (this._sinceFire >= this.maxActiveFrames) {
        this.floorDb = bandDb;
        this.active = false;
      }
    } else if (this._frames > TRIGGER_WARMUP_FRAMES && bandDb > this.floorDb + this.thresholdDb) {
      fired = true;
      this.active = true;
      this._sinceFire = 0;
    }

    if (!this.active && this._frames > 1) {
      this.floorDb += this._alpha * (bandDb - this.floorDb);
    }
    return fired;
  }

  /**
   * Clear all state; the next sample re-initializes the floor.
   * @returns {void}
   */
  reset() {
    this.floorDb = 0;
    this.active = false;
    this._frames = 0;
    this._sinceFire = 0;
  }
}

/**
 * Raised-cosine pass gain for a frequency relative to a band.
 * Gain is 1 inside [loHz, hiHz] and falls to 0 over BAND_TAPER_HZ outside each edge.
 * @param {number} f frequency in Hz
 * @param {number} loHz
 * @param {number} hiHz
 * @returns {number} gain in [0, 1]
 */
function bandGain(f, loHz, hiHz) {
  let d;
  if (f < loHz) d = loHz - f;
  else if (f > hiHz) d = f - hiHz;
  else return 1;
  if (d >= BAND_TAPER_HZ) return 0;
  return 0.5 + 0.5 * Math.cos((Math.PI * d) / BAND_TAPER_HZ);
}

/**
 * Analytic signal restricted to [loHz, hiHz].
 * Zero-pads to the next power of two, FFTs, zeroes negative frequencies and
 * out-of-band bins (raised-cosine taper of 200 Hz outside each edge), doubles
 * the kept positive-frequency bins (DC and Nyquist are not doubled), inverse
 * FFTs, and truncates to the input length.
 * @param {Float32Array|Float64Array} samples
 * @param {number} sampleRate Hz
 * @param {number} loHz
 * @param {number} hiHz
 * @returns {{re: Float32Array, im: Float32Array}} same length as samples
 */
export function analyticBand(samples, sampleRate, loHz, hiHz) {
  const len = samples.length;
  const re = new Float32Array(len);
  const im = new Float32Array(len);
  if (len === 0) return { re, im };

  const n = nextPow2(len);
  const half = n >> 1;
  const fr = new Float64Array(n);
  const fi = new Float64Array(n);
  for (let i = 0; i < len; i++) fr[i] = samples[i];

  const fft = getFFT(n);
  fft.forward(fr, fi);

  const binHz = sampleRate / n;
  for (let k = 0; k < n; k++) {
    if (k > half) {
      fr[k] = 0;
      fi[k] = 0;
      continue;
    }
    const g = bandGain(k * binHz, loHz, hiHz);
    const scale = k === 0 || k === half ? g : 2 * g;
    fr[k] *= scale;
    fi[k] *= scale;
  }

  fft.inverse(fr, fi);
  for (let i = 0; i < len; i++) {
    re[i] = fr[i];
    im[i] = fi[i];
  }
  return { re, im };
}

/**
 * Real part of analyticBand: a zero-phase band-limited copy of the input.
 * @param {Float32Array|Float64Array} samples
 * @param {number} sampleRate Hz
 * @param {number} loHz
 * @param {number} hiHz
 * @returns {Float32Array} band-limited signal, same length as samples
 */
export function bandpass(samples, sampleRate, loHz, hiHz) {
  return analyticBand(samples, sampleRate, loHz, hiHz).re;
}

/**
 * Instantaneous amplitude |z|.
 * @param {{re: Float32Array, im: Float32Array}} analytic
 * @returns {Float32Array} sqrt(re^2 + im^2) per sample
 */
export function envelope(analytic) {
  const { re, im } = analytic;
  const out = new Float32Array(re.length);
  for (let i = 0; i < re.length; i++) {
    out[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
  }
  return out;
}

/**
 * Instantaneous frequency from the phase advance between consecutive samples:
 * f[i] = angle(z[i] conj(z[i-1])) * sampleRate / (2 pi). f[0] = f[1].
 * @param {{re: Float32Array, im: Float32Array}} analytic
 * @param {number} sampleRate Hz
 * @returns {Float32Array} frequency in Hz, same length as the analytic signal
 */
export function instantaneousFrequency(analytic, sampleRate) {
  const { re, im } = analytic;
  const n = re.length;
  const f = new Float32Array(n);
  if (n < 2) return f;
  const scale = sampleRate / TWO_PI;
  for (let i = 1; i < n; i++) {
    const pr = re[i] * re[i - 1] + im[i] * im[i - 1];
    const pi = im[i] * re[i - 1] - re[i] * im[i - 1];
    f[i] = Math.atan2(pi, pr) * scale;
  }
  f[0] = f[1];
  return f;
}

/**
 * Peak of the normalized cross-correlation of two real signals, computed by FFT.
 * c[l] = sum_n a[n] b[n+l] / sqrt(energy(a) energy(b)).
 * lag > 0 means b's content occurs later than a's by lag samples.
 * @param {Float32Array|Float64Array} a
 * @param {Float32Array|Float64Array} b may differ in length from a
 * @returns {{peak: number, lag: number}} peak = max |c[l]| in [0, 1]; {0, 0} if either input has zero energy
 */
export function xcorrPeak(a, b) {
  const la = a.length;
  const lb = b.length;
  let ea = 0;
  let eb = 0;
  for (let i = 0; i < la; i++) ea += a[i] * a[i];
  for (let i = 0; i < lb; i++) eb += b[i] * b[i];
  if (la === 0 || lb === 0 || ea === 0 || eb === 0) return { peak: 0, lag: 0 };

  const n = nextPow2(la + lb - 1);
  const ar = new Float64Array(n);
  const ai = new Float64Array(n);
  const br = new Float64Array(n);
  const bi = new Float64Array(n);
  for (let i = 0; i < la; i++) ar[i] = a[i];
  for (let i = 0; i < lb; i++) br[i] = b[i];

  const fft = getFFT(n);
  fft.forward(ar, ai);
  fft.forward(br, bi);
  // conj(A) * B, stored back into A/ai
  for (let k = 0; k < n; k++) {
    const xr = ar[k] * br[k] + ai[k] * bi[k];
    const xi = ar[k] * bi[k] - ai[k] * br[k];
    ar[k] = xr;
    ai[k] = xi;
  }
  fft.inverse(ar, ai);

  const norm = 1 / Math.sqrt(ea * eb);
  let best = 0;
  let bestLag = 0;
  for (let l = -(la - 1); l <= lb - 1; l++) {
    const idx = l >= 0 ? l : n + l;
    const v = ar[idx] * norm;
    if (Math.abs(v) > Math.abs(best)) {
      best = v;
      bestLag = l;
    }
  }
  return { peak: Math.min(1, Math.abs(best)), lag: bestLag };
}

/**
 * @param {DataView} dv
 * @param {number} off
 * @param {string} s four-character code
 * @returns {void}
 */
function writeFourCC(dv, off, s) {
  for (let i = 0; i < 4; i++) dv.setUint8(off + i, s.charCodeAt(i));
}

/**
 * @param {DataView} dv
 * @param {number} off
 * @returns {string} four-character code at off
 */
function readFourCC(dv, off) {
  return String.fromCharCode(
    dv.getUint8(off),
    dv.getUint8(off + 1),
    dv.getUint8(off + 2),
    dv.getUint8(off + 3),
  );
}

/**
 * Encode mono 32-bit IEEE float WAV (format tag 3) with a 44-byte header.
 * @param {Float32Array|Float64Array|ArrayLike<number>} samples
 * @param {number} sampleRate integer Hz
 * @returns {ArrayBuffer}
 */
export function encodeWav(samples, sampleRate) {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new RangeError(`sampleRate must be a positive integer, got ${sampleRate}`);
  }
  const n = samples.length;
  const dataBytes = n * 4;
  const buf = new ArrayBuffer(44 + dataBytes);
  const dv = new DataView(buf);
  writeFourCC(dv, 0, 'RIFF');
  dv.setUint32(4, 36 + dataBytes, true);
  writeFourCC(dv, 8, 'WAVE');
  writeFourCC(dv, 12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 3, true); // IEEE float
  dv.setUint16(22, 1, true); // mono
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 4, true);
  dv.setUint16(32, 4, true);
  dv.setUint16(34, 32, true);
  writeFourCC(dv, 36, 'data');
  dv.setUint32(40, dataBytes, true);
  for (let i = 0; i < n; i++) dv.setFloat32(44 + 4 * i, samples[i], true);
  return buf;
}

/**
 * Decode a WAV file. Walks RIFF chunks (skipping unknown ones and honouring
 * odd-size padding). Accepts 16-bit PCM, 24-bit PCM and 32-bit float, including
 * WAVE_FORMAT_EXTENSIBLE wrapping those. Multi-channel input keeps channel 0.
 * @param {ArrayBuffer} arrayBuffer
 * @returns {{sampleRate: number, samples: Float32Array}}
 * @throws {Error} on malformed files or unsupported formats
 */
export function decodeWav(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  const len = dv.byteLength;
  if (len < 12 || readFourCC(dv, 0) !== 'RIFF' || readFourCC(dv, 8) !== 'WAVE') {
    throw new Error('decodeWav: not a RIFF/WAVE file');
  }

  let fmt = null;
  let dataOff = -1;
  let dataLen = 0;
  let off = 12;
  while (off + 8 <= len) {
    const id = readFourCC(dv, off);
    const size = dv.getUint32(off + 4, true);
    const body = off + 8;
    if (body + size > len) {
      throw new Error(`decodeWav: chunk "${id}" declares ${size} bytes but only ${len - body} remain (truncated file?)`);
    }
    if (id === 'fmt ') {
      if (size < 16) throw new Error(`decodeWav: "fmt " chunk too short (${size} bytes)`);
      let tag = dv.getUint16(body, true);
      if (tag === 0xfffe) {
        if (size < 40) throw new Error('decodeWav: WAVE_FORMAT_EXTENSIBLE "fmt " chunk too short');
        // SubFormat GUID starts at byte 24; its first two bytes hold the format tag.
        tag = dv.getUint16(body + 24, true);
      }
      fmt = {
        tag,
        channels: dv.getUint16(body + 2, true),
        sampleRate: dv.getUint32(body + 4, true),
        bits: dv.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      dataOff = body;
      dataLen = size;
    }
    if (fmt && dataOff >= 0) break;
    off = body + size + (size & 1);
  }

  if (!fmt) throw new Error('decodeWav: missing "fmt " chunk');
  if (dataOff < 0) throw new Error('decodeWav: missing "data" chunk');
  if (fmt.channels < 1) throw new Error('decodeWav: channel count must be at least 1');
  if (fmt.sampleRate < 1) throw new Error('decodeWav: sample rate must be positive');

  let kind;
  if (fmt.tag === 1 && fmt.bits === 16) kind = 'pcm16';
  else if (fmt.tag === 1 && fmt.bits === 24) kind = 'pcm24';
  else if (fmt.tag === 3 && fmt.bits === 32) kind = 'float32';
  else {
    throw new Error(
      `decodeWav: unsupported WAV format (tag ${fmt.tag}, ${fmt.bits}-bit); ` +
        'supported: 16-bit PCM, 24-bit PCM, 32-bit float',
    );
  }

  const bytesPer = fmt.bits / 8;
  const frameBytes = fmt.channels * bytesPer;
  const frames = Math.floor(dataLen / frameBytes);
  const samples = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const p = dataOff + f * frameBytes;
    if (kind === 'pcm16') {
      samples[f] = dv.getInt16(p, true) / 32768;
    } else if (kind === 'pcm24') {
      let v = dv.getUint8(p) | (dv.getUint8(p + 1) << 8) | (dv.getUint8(p + 2) << 16);
      if (v & 0x800000) v -= 0x1000000;
      samples[f] = v / 8388608;
    } else {
      samples[f] = dv.getFloat32(p, true);
    }
  }
  return { sampleRate: fmt.sampleRate, samples };
}

/**
 * Perceptual "inferno"-style colour ramp as an RGBA lookup table.
 * Eight anchor colours are linearly interpolated (approximations of the
 * matplotlib inferno map, not the exact published values).
 * @returns {Uint8ClampedArray} 256 entries x 4 bytes (RGBA), alpha = 255
 */
export function colorLUT() {
  /** @type {number[][]} anchors at t = 0, 1/7, ..., 1 */
  const anchors = [
    [0, 0, 4],
    [40, 11, 84],
    [101, 21, 110],
    [159, 42, 99],
    [212, 72, 66],
    [245, 125, 21],
    [250, 193, 39],
    [252, 255, 164],
  ];
  const lut = new Uint8ClampedArray(256 * 4);
  const last = anchors.length - 1;
  for (let i = 0; i < 256; i++) {
    const pos = (i / 255) * last;
    const j = Math.min(last - 1, Math.floor(pos));
    const frac = pos - j;
    const a = anchors[j];
    const b = anchors[j + 1];
    for (let c = 0; c < 3; c++) {
      lut[i * 4 + c] = Math.round(a[c] + (b[c] - a[c]) * frac);
    }
    lut[i * 4 + 3] = 255;
  }
  return lut;
}
