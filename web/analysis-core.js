/**
 * analysis-core.js - pure burst analysis for the OSSTagLab capture panel.
 *
 * No DOM. Imported by the browser (analysis.js) and by Node tests. Inputs are the
 * linear envelope and instantaneous-frequency traces produced by dsp.js. Results
 * are estimates of what the detector saw, not decoded data.
 *
 * Sample indices are absolute within the clip. Run times (startMs) are relative
 * to the start of the detected burst.
 */

import { xcorrPeak } from './dsp.js';

/** A sample counts as "in the burst" for frequency statistics within this many dB of the peak. */
const GATE_DB = 12;

/** Width of the median filter applied to the per-sample tone assignment. */
const MEDIAN_WINDOW_MS = 0.5;

/** Runs shorter than this are merged into their neighbour. */
const MIN_RUN_MS = 0.5;

/** Tone-histogram peaks closer than this many bins are merged. */
const MIN_PEAK_SEPARATION_BINS = 4;

/**
 * @param {number} ms
 * @param {number} sampleRate Hz
 * @returns {number} nearest whole number of samples
 */
function msToSamples(ms, sampleRate) {
  return Math.round((ms * sampleRate) / 1000);
}

/**
 * Centred moving average computed with a prefix sum; edges use the samples available.
 * @param {Float32Array} x
 * @param {number} width window length in samples (>= 1)
 * @returns {Float32Array}
 */
function movingAverage(x, width) {
  const n = x.length;
  const half = Math.floor(width / 2);
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + x[i];
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - half);
    const b = Math.min(n, i - half + width);
    out[i] = (prefix[b] - prefix[a]) / (b - a);
  }
  return out;
}

/**
 * Walk from the peak in one direction and return the last index still above
 * threshold. Dips shorter than gapLimit samples are bridged.
 * @param {Float32Array} smooth
 * @param {number} from peak index
 * @param {1|-1} step
 * @param {number} threshold linear
 * @param {number} gapLimit samples
 * @returns {number} index of the outermost above-threshold sample
 */
function extendEdge(smooth, from, step, threshold, gapLimit) {
  let last = from;
  let belowRun = 0;
  for (let i = from + step; i >= 0 && i < smooth.length; i += step) {
    if (smooth[i] > threshold) {
      last = i;
      belowRun = 0;
    } else {
      belowRun++;
      if (belowRun >= gapLimit) break;
    }
  }
  return last;
}

/**
 * Locate the burst in a linear envelope.
 * @param {Float32Array} env envelope (linear amplitude)
 * @param {number} sampleRate Hz
 * @param {object} [options]
 * @param {number} [options.dropDb=20] edge threshold below the smoothed peak
 * @param {number} [options.minGapMs=5] dips shorter than this are bridged
 * @param {number} [options.smoothMs=1] moving-average width applied before detection
 * @returns {{start: number, end: number, peakIndex: number, peak: number} | null}
 *   start and end (exclusive) in samples; peak is the smoothed envelope at peakIndex.
 *   null when the envelope is empty or all zero.
 */
export function findBurst(env, sampleRate, { dropDb = 20, minGapMs = 5, smoothMs = 1 } = {}) {
  const n = env.length;
  if (n === 0) return null;
  const smooth = movingAverage(env, Math.max(1, msToSamples(smoothMs, sampleRate)));
  let peakIndex = 0;
  for (let i = 1; i < n; i++) {
    if (smooth[i] > smooth[peakIndex]) peakIndex = i;
  }
  const peak = smooth[peakIndex];
  if (!(peak > 0)) return null;
  const threshold = peak * 10 ** (-dropDb / 20);
  const gapLimit = msToSamples(minGapMs, sampleRate);
  const first = extendEdge(smooth, peakIndex, -1, threshold, gapLimit);
  const last = extendEdge(smooth, peakIndex, 1, threshold, gapLimit);
  return { start: first, end: last + 1, peakIndex, peak };
}

/**
 * Indices inside the burst whose envelope is within gateDb of the burst peak.
 * @param {Float32Array} env
 * @param {{start: number, end: number, peak: number}} burst
 * @param {number} [gateDb=GATE_DB]
 * @returns {number[]}
 */
function gatedIndices(env, burst, gateDb = GATE_DB) {
  const threshold = burst.peak * 10 ** (-gateDb / 20);
  const out = [];
  for (let i = burst.start; i < burst.end; i++) {
    if (env[i] >= threshold) out.push(i);
  }
  return out;
}

/**
 * Nearest-rank percentile of an ascending typed array.
 * @param {Float64Array} sorted
 * @param {number} p in [0, 1]
 * @returns {number}
 */
function percentile(sorted, p) {
  return sorted[Math.round(p * (sorted.length - 1))];
}

/**
 * Frequency statistics over the gated part of the burst.
 * @param {Float32Array} instFreq instantaneous frequency in Hz
 * @param {Float32Array} env
 * @param {{start: number, end: number, peak: number} | null} burst
 * @returns {{medianHz: number, minHz: number, maxHz: number} | null}
 *   minHz and maxHz are the 5th and 95th percentiles.
 */
export function burstStats(instFreq, env, burst) {
  if (!burst) return null;
  const idx = gatedIndices(env, burst);
  if (idx.length === 0) return null;
  const hz = Float64Array.from(idx, (i) => instFreq[i]).sort();
  return {
    medianHz: percentile(hz, 0.5),
    minHz: percentile(hz, 0.05),
    maxHz: percentile(hz, 0.95),
  };
}

/**
 * Three-tap smoothing [1/4, 1/2, 1/4] with zero padding.
 * @param {Float64Array} counts
 * @returns {Float64Array}
 */
function lightSmooth(counts) {
  const n = counts.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const left = i > 0 ? counts[i - 1] : 0;
    const right = i < n - 1 ? counts[i + 1] : 0;
    out[i] = 0.25 * left + 0.5 * counts[i] + 0.25 * right;
  }
  return out;
}

/**
 * Keep the strongest of any group of peaks closer than MIN_PEAK_SEPARATION_BINS.
 * @param {{bin: number, share: number}[]} peaks
 * @returns {{bin: number, share: number}[]}
 */
function mergeClosePeaks(peaks) {
  const byShare = [...peaks].sort((a, b) => b.share - a.share);
  const kept = [];
  for (const p of byShare) {
    if (kept.every((k) => Math.abs(k.bin - p.bin) >= MIN_PEAK_SEPARATION_BINS)) kept.push(p);
  }
  return kept;
}

/**
 * Distinct tone frequencies in the burst: local maxima of a lightly smoothed
 * histogram of the gated instantaneous frequency.
 * @param {Float32Array} instFreq
 * @param {Float32Array} env
 * @param {{start: number, end: number, peak: number} | null} burst
 * @param {number} sampleRate Hz
 * @param {object} [options]
 * @param {number} [options.binHz=25] histogram bin width
 * @param {number} [options.minShare=0.08] minimum fraction of gated samples per tone
 * @returns {{hz: number, share: number}[]} sorted by hz; empty when no burst
 */
export function toneLevels(instFreq, env, burst, sampleRate, { binHz = 25, minShare = 0.08 } = {}) {
  if (!burst) return [];
  const idx = gatedIndices(env, burst);
  const total = idx.length;
  if (total === 0) return [];
  const nyquist = sampleRate / 2;
  const bins = new Int32Array(total);
  let minBin = Infinity;
  let maxBin = -Infinity;
  for (let k = 0; k < total; k++) {
    const hz = Math.min(nyquist, Math.max(0, instFreq[idx[k]]));
    bins[k] = Math.round(hz / binHz);
    if (bins[k] < minBin) minBin = bins[k];
    if (bins[k] > maxBin) maxBin = bins[k];
  }
  const counts = new Float64Array(maxBin - minBin + 1);
  for (let k = 0; k < total; k++) counts[bins[k] - minBin]++;
  const smooth = lightSmooth(counts);

  const candidates = [];
  for (let i = 0; i < smooth.length; i++) {
    const left = i > 0 ? smooth[i - 1] : 0;
    const right = i < smooth.length - 1 ? smooth[i + 1] : 0;
    const share = smooth[i] / total;
    if (smooth[i] > 0 && smooth[i] >= left && smooth[i] > right && share >= minShare) {
      candidates.push({ bin: i, share });
    }
  }
  return mergeClosePeaks(candidates)
    .map((p) => ({ hz: (p.bin + minBin) * binHz, share: p.share }))
    .sort((a, b) => a.hz - b.hz);
}

/**
 * Index of the tone level nearest to a frequency.
 * @param {number} hz
 * @param {{hz: number}[]} levels
 * @returns {number}
 */
function nearestLevel(hz, levels) {
  let best = 0;
  for (let j = 1; j < levels.length; j++) {
    if (Math.abs(hz - levels[j].hz) < Math.abs(hz - levels[best].hz)) best = j;
  }
  return best;
}

/**
 * Median of each sample's label over a centred window.
 * @param {Uint16Array} labels
 * @param {number} half half-width in samples
 * @returns {Uint16Array}
 */
function medianFilter(labels, half) {
  const n = labels.length;
  const out = new Uint16Array(n);
  const scratch = new Uint16Array(2 * half + 1);
  for (let k = 0; k < n; k++) {
    const a = Math.max(0, k - half);
    const b = Math.min(n, k + half + 1);
    const window = scratch.subarray(0, b - a);
    window.set(labels.subarray(a, b));
    window.sort();
    out[k] = window[(b - a) >> 1];
  }
  return out;
}

/**
 * @param {Uint16Array} labels
 * @returns {{start: number, len: number, level: number}[]} maximal equal-label runs
 */
function labelRuns(labels) {
  const runs = [];
  let start = 0;
  for (let k = 1; k <= labels.length; k++) {
    if (k === labels.length || labels[k] !== labels[start]) {
      runs.push({ start, len: k - start, level: labels[start] });
      start = k;
    }
  }
  return runs;
}

/**
 * Merge adjacent runs that carry the same level.
 * @param {{start: number, len: number, level: number}[]} runs
 * @returns {{start: number, len: number, level: number}[]}
 */
function coalesceRuns(runs) {
  const out = [];
  for (const r of runs) {
    const top = out[out.length - 1];
    if (top && top.level === r.level) top.len += r.len;
    else out.push({ ...r });
  }
  return out;
}

/**
 * Repeatedly merge the first run shorter than minLen into a neighbour
 * (the previous run if there is one, else the next).
 * @param {{start: number, len: number, level: number}[]} runs
 * @param {number} minLen samples
 * @returns {{start: number, len: number, level: number}[]}
 */
function absorbShortRuns(runs, minLen) {
  let list = runs;
  let idx = list.findIndex((r) => r.len < minLen);
  while (idx >= 0 && list.length > 1) {
    const target = idx > 0 ? idx - 1 : idx + 1;
    const merged = {
      start: Math.min(list[idx].start, list[target].start),
      len: list[idx].len + list[target].len,
      level: list[target].level,
    };
    const lo = Math.min(idx, target);
    const hi = Math.max(idx, target);
    list = coalesceRuns([...list.slice(0, lo), merged, ...list.slice(hi + 1)]);
    idx = list.findIndex((r) => r.len < minLen);
  }
  return list;
}

/**
 * Sequence of tone-level runs across the burst.
 * @param {Float32Array} instFreq
 * @param {Float32Array} env
 * @param {{start: number, end: number} | null} burst
 * @param {number} sampleRate Hz
 * @param {{hz: number}[]} levels from toneLevels
 * @returns {{level: number, startMs: number, durationMs: number}[]}
 *   level indexes levels; empty when fewer than two levels or no burst.
 */
export function runLengths(instFreq, env, burst, sampleRate, levels) {
  if (!burst || levels.length < 2) return [];
  const len = burst.end - burst.start;
  const raw = new Uint16Array(len);
  for (let k = 0; k < len; k++) {
    raw[k] = nearestLevel(instFreq[burst.start + k], levels);
  }
  const half = Math.floor(msToSamples(MEDIAN_WINDOW_MS, sampleRate) / 2);
  const filtered = medianFilter(raw, half);
  const runs = absorbShortRuns(labelRuns(filtered), msToSamples(MIN_RUN_MS, sampleRate));
  return runs.map((r) => ({
    level: r.level,
    startMs: (r.start * 1000) / sampleRate,
    durationMs: (r.len * 1000) / sampleRate,
  }));
}

/**
 * Estimate the shortest symbol duration. The 20th-percentile run is the candidate;
 * each run is then divided by its nearest integer multiple of the candidate and the
 * results are averaged.
 * @param {{durationMs: number}[]} runs
 * @returns {number | null} milliseconds, or null for fewer than 4 runs
 */
export function estimateSymbolMs(runs) {
  if (runs.length < 4) return null;
  const sorted = runs.map((r) => r.durationMs).sort((a, b) => a - b);
  const candidate = sorted[Math.floor(0.2 * (sorted.length - 1))];
  if (!(candidate > 0)) return null;
  let sum = 0;
  let count = 0;
  for (const r of runs) {
    const multiple = Math.round(r.durationMs / candidate);
    if (multiple >= 1) {
      sum += r.durationMs / multiple;
      count++;
    }
  }
  return count > 0 ? sum / count : null;
}

/**
 * Expand runs into one level index per symbol, using round(duration / symbolMs)
 * (at least 1) for each run.
 * @param {{level: number, durationMs: number}[]} runs
 * @param {number | null} symbolMs
 * @returns {number[]} empty when symbolMs is not a positive number
 */
export function expandLevelSequence(runs, symbolMs) {
  if (!(symbolMs > 0)) return [];
  const out = [];
  for (const r of runs) {
    const count = Math.max(1, Math.round(r.durationMs / symbolMs));
    for (let j = 0; j < count; j++) out.push(r.level);
  }
  return out;
}

/**
 * Copy of the clip from burst start - padMs to burst end + padMs, clamped to the clip.
 * @param {Float32Array} samples
 * @param {{start: number, end: number}} burst
 * @param {number} sampleRate Hz
 * @param {number} [padMs=20]
 * @returns {Float32Array}
 */
export function cropToBurst(samples, burst, sampleRate, padMs = 20) {
  const pad = msToSamples(padMs, sampleRate);
  const a = Math.max(0, burst.start - pad);
  const b = Math.min(samples.length, burst.end + pad);
  return samples.slice(a, b);
}

/**
 * Pairwise normalized cross-correlation peaks of already-cropped clips.
 * Each pair is computed once and mirrored; lags[j*n+i] = -lags[i*n+j].
 * @param {Float32Array[]} clips
 * @returns {{n: number, peaks: Float32Array, lags: Int32Array}}
 *   peaks[i*n+j] in [0, 1]; diagonal is 1 with lag 0.
 */
export function similarityMatrix(clips) {
  const n = clips.length;
  const peaks = new Float32Array(n * n);
  const lags = new Int32Array(n * n);
  for (let i = 0; i < n; i++) peaks[i * n + i] = 1;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const r = xcorrPeak(clips[i], clips[j]);
      peaks[i * n + j] = r.peak;
      peaks[j * n + i] = r.peak;
      lags[i * n + j] = r.lag;
      lags[j * n + i] = -r.lag;
    }
  }
  return { n, peaks, lags };
}

/**
 * Rasterize an STFT region at any zoom. For each pixel, the maximum dB over the
 * frames and bins that pixel covers, so a single hot cell survives any downsampling.
 *
 * Pixel x covers frames [frameStart + floor(x*F/width), frameStart + floor((x+1)*F/width))
 * (at least one frame), F = frameEnd - frameStart. Pixel row y = 0 is the highest
 * bin, binHi; row y covers the bins from binHi - floor(y*B/height) down to the
 * matching lower edge (at least one bin), B = binHi - binLo + 1.
 *
 * @param {Float32Array} data row-major STFT, frames x bins
 * @param {number} frames total frame count in data
 * @param {number} bins bins per frame in data
 * @param {number} frameStart first frame, inclusive
 * @param {number} frameEnd last frame, exclusive (> frameStart, <= frames)
 * @param {number} binLo first bin, inclusive
 * @param {number} binHi last bin, inclusive
 * @param {number} width output pixels across
 * @param {number} height output pixels down
 * @param {Float32Array} out receives width * height values
 * @returns {Float32Array} out
 * @throws {RangeError} when the frame range is invalid
 */
export function columnMax(data, frames, bins, frameStart, frameEnd, binLo, binHi, width, height, out) {
  if (!(frameEnd > frameStart) || frameEnd > frames || frameStart < 0) {
    throw new RangeError(`invalid frame range [${frameStart}, ${frameEnd}) for ${frames} frames`);
  }
  const frameSpan = frameEnd - frameStart;
  const binSpan = binHi - binLo + 1;
  for (let y = 0; y < height; y++) {
    const hi = binHi - Math.floor((y * binSpan) / height);
    const lo = Math.min(hi, binHi - Math.floor(((y + 1) * binSpan) / height) + 1);
    for (let x = 0; x < width; x++) {
      const f0 = frameStart + Math.floor((x * frameSpan) / width);
      const f1 = Math.max(f0 + 1, frameStart + Math.floor(((x + 1) * frameSpan) / width));
      let m = -Infinity;
      for (let f = f0; f < f1; f++) {
        const base = f * bins;
        for (let k = lo; k <= hi; k++) {
          if (data[base + k] > m) m = data[base + k];
        }
      }
      out[y * width + x] = m;
    }
  }
  return out;
}
