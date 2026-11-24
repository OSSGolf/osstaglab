/**
 * analysis.js - DOM views for the OSSTagLab capture analysis panel.
 *
 * createAnalysisView: one capture at a time. Three stacked traces (spectrogram,
 * band envelope, instantaneous frequency) share one time axis and a left gutter.
 * Pointer readouts, time selection, and plain-sentence findings from analysis-core.js.
 *
 * createSimilarityView: pairwise waveform similarity table for several captures.
 *
 * DOM is built once per view. Capture-derived text is only ever set through
 * textContent. Analysis is cached per (capture, band, fftSize); pointer moves only
 * composite the cached offscreen images and draw overlays.
 *
 * Time-to-pixel mapping: every trace maps sample s to
 *   x = plotLeft + (s - view.s0) / (view.s1 - view.s0) * plotW   (CSS px)
 * The spectrogram maps frame f (centre at f*hop + fftSize/2) with the same rule,
 * rasterized in device pixels and scaled to the same extent.
 */

import { PART_COLORS } from './reading.js';
import {
  stft,
  analyticBand,
  envelope,
  instantaneousFrequency,
  colorLUT,
  bandIndices,
} from './dsp.js';
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
} from './analysis-core.js';

const FFT_SIZES = [128, 256, 512, 1024, 2048];
const DEFAULT_FFT_SIZE = 512;
const MIN_HOP = 16;
const SPEC_HEIGHT = 260;
const ENV_HEIGHT = 90;
const IF_HEIGHT = 120;
const GUTTER = 52;
const RIGHT_MARGIN = 10;
const PANEL_PAD = 4;
const BAND_MARGIN_HZ = 1000;
const BURST_PAD_MS = 20;
const ENV_RANGE_DB = 60;
const ENV_HEADROOM_DB = 3;
const IF_GATE_DB = 30;
const MAX_SYMBOLS_SHOWN = 256;
const SIMILARITY_MAX_CAPTURES = 40;
const TIME_STEPS_MS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
const FREQ_STEPS_HZ = [250, 500, 1000, 2000, 5000];
const ENV_FLOOR = 1e-9;
const LUT = colorLUT();

const EXPLAINER =
  'Values near 1.00 mean two bursts have the same waveform. If the same tag scores high ' +
  'against itself across taps and clearly lower against other tags, each tag’s burst is a usable fingerprint. ' +
  'Different tags using the same tones still share about half their waveform, so expect around 0.5 between them, not 0.';

/** Palette fallbacks used when a :root property is missing or not a hex or rgb colour. */
const PALETTE_VARS = {
  scope: ['--scope', '#0B1418'],
  scopeInk: ['--scope-ink', '#C9D6D2'],
  signal: ['--signal', '#D98A00'],
  fairway: ['--fairway', '#1F6F54'],
  rule: ['--rule', '#C5CEC9'],
  panel: ['--panel', '#FFFFFF'],
  paper: ['--paper', '#FFFFFF'],
  ink: ['--ink', '#1B1F1E'],
};
const FONT_TIGHT_FALLBACK = 'ui-monospace, SFMono-Regular, Menlo, monospace';

/**
 * @param {string} text CSS colour as written in a custom property
 * @returns {number[] | null} [r, g, b] for #rgb, #rrggbb, rgb() or rgba(); null otherwise
 */
function parseColor(text) {
  const t = text.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(t);
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(t);
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : null;
}

/**
 * Read the page palette once: RGB triples per colour key, plus the tight font stack.
 * @returns {Record<string, number[]> & {fontTight: string}}
 */
function readPalette() {
  const style = getComputedStyle(document.documentElement);
  const palette = {};
  for (const [key, [cssVar, fallback]] of Object.entries(PALETTE_VARS)) {
    palette[key] = parseColor(style.getPropertyValue(cssVar)) ?? parseColor(fallback);
  }
  palette.fontTight = style.getPropertyValue('--font-tight').trim() || FONT_TIGHT_FALLBACK;
  return palette;
}

/**
 * @param {number[]} rgb
 * @returns {string} CSS rgb() string
 */
function cssRgb(rgb) {
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

/**
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [text]
 * @returns {HTMLElement}
 */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * @param {string} label
 * @param {() => void} onClick
 * @returns {HTMLButtonElement}
 */
function button(label, onClick) {
  const b = el('button', 'an-button', label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

/**
 * @param {number} v
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * @param {number} n
 * @returns {string} integer with thin grouping spaces, e.g. "18 742"
 */
function fmtInt(n) {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/**
 * @param {number} ms
 * @param {number} [digits=1]
 * @returns {string}
 */
function fmtMs(ms, digits = 1) {
  return ms.toFixed(digits);
}

/**
 * @param {number} db
 * @returns {string} e.g. "−63.1 dB"
 */
function fmtDb(db) {
  return `${db.toFixed(1).replace('-', '−')} dB`;
}

/**
 * Smallest step from the list that gives at most targetTicks ticks across span.
 * @param {number} span
 * @param {number} targetTicks
 * @param {number[]} steps ascending
 * @returns {number}
 */
function niceStep(span, targetTicks, steps) {
  return steps.find((s) => span / s <= targetTicks) ?? steps[steps.length - 1];
}

/**
 * @param {Float32Array} env linear envelope
 * @returns {Float32Array} 20 log10 with a floor, same length
 */
function toDb(env) {
  const out = new Float32Array(env.length);
  for (let i = 0; i < env.length; i++) out[i] = 20 * Math.log10(Math.max(env[i], ENV_FLOOR));
  return out;
}

/**
 * Clamp a band to the capture's usable range (above 0 Hz, below Nyquist), ordered.
 * @param {{loHz: number, hiHz: number}} band
 * @param {number} sampleRate
 * @returns {{loHz: number, hiHz: number}}
 */
function usableBand(band, sampleRate) {
  const nyquist = sampleRate / 2 - 1;
  const lo = clamp(Math.min(band.loHz, band.hiHz), 1, nyquist - 1);
  const hi = clamp(Math.max(band.loHz, band.hiHz), lo + 1, nyquist);
  return { loHz: lo, hiHz: hi };
}

/**
 * Everything the analysis view needs for one capture, band and FFT size.
 * This is the expensive step; the caller caches the result.
 * @param {object} capture
 * @param {{loHz: number, hiHz: number}} band already usable
 * @param {number} fftSize
 * @returns {object}
 */
function computeAnalysis(capture, band, fftSize) {
  const sr = capture.sampleRate;
  const samples = capture.samples;
  const analytic = analyticBand(samples, sr, band.loHz, band.hiHz);
  const env = envelope(analytic);
  const inst = instantaneousFrequency(analytic, sr);
  const envDb = toDb(env);
  let peakDb = -Infinity;
  for (let i = 0; i < envDb.length; i++) if (envDb[i] > peakDb) peakDb = envDb[i];
  const burst = findBurst(env, sr);
  const levels = toneLevels(inst, env, burst, sr);
  const runs = runLengths(inst, env, burst, sr, levels);
  const symbolMs = estimateSymbolMs(runs);
  const hop = Math.max(MIN_HOP, fftSize / 8);
  return {
    capture,
    sampleRate: sr,
    sampleCount: samples.length,
    loHz: band.loHz,
    hiHz: band.hiHz,
    fftSize,
    hop,
    spec: stft(samples, fftSize, hop),
    env,
    envDb,
    inst,
    peakDb,
    burst,
    stats: burstStats(inst, env, burst),
    levels,
    runs,
    symbolMs,
  };
}

/**
 * Plain-sentence findings. Every figure is an estimate.
 * @param {ReturnType<typeof computeAnalysis>} entry
 * @returns {string[]}
 */
function findingLines(entry) {
  const sr = entry.sampleRate;
  if (!entry.burst) {
    return [
      `No burst found in ${fmtInt(entry.loHz)}–${fmtInt(entry.hiHz)} Hz. ` +
        'Widen the tag band or check the spectrogram.',
    ];
  }
  const b = entry.burst;
  const lines = [
    `Burst starts at about ${fmtMs((b.start * 1000) / sr)} ms and lasts about ${fmtMs(((b.end - b.start) * 1000) / sr)} ms.`,
  ];
  if (entry.stats) {
    const s = entry.stats;
    lines.push(
      `Median frequency ≈ ${fmtInt(s.medianHz)} Hz (5th–95th percentile ${fmtInt(s.minHz)}–${fmtInt(s.maxHz)} Hz).`,
    );
  }
  if (entry.levels.length >= 2) {
    const tones = entry.levels.map((l) => `${fmtInt(l.hz)} Hz (${Math.round(l.share * 100)}%)`);
    lines.push(`About ${entry.levels.length} distinct tones: ${tones.join(', ')}.`);
  } else {
    lines.push(
      'Only one tone found in the band — not FSK, or the band setting misses part of the signal. ' +
        'Check the envelope for on/off keying.',
    );
  }
  if (entry.symbolMs !== null) {
    lines.push(
      `Shortest symbol ≈ ${fmtMs(entry.symbolMs)} ms (about ${fmtInt(1000 / entry.symbolMs)} symbols/s); ${entry.runs.length} runs.`,
    );
  } else if (entry.levels.length >= 2) {
    lines.push('Symbol length not estimated: fewer than 4 runs.');
  }
  return lines;
}

/**
 * Spectrogram bin window for the chosen frequency mode, in bins and in Hz edges.
 * @param {ReturnType<typeof computeAnalysis>} entry
 * @param {'tag'|'display'} mode
 * @param {{loHz: number, hiHz: number}} display
 * @returns {{binHz: number, binLo: number, binHi: number, rows: number}}
 */
function specWindow(entry, mode, display) {
  const sr = entry.sampleRate;
  const binHz = sr / entry.fftSize;
  const range =
    mode === 'display'
      ? { lo: display.loHz, hi: display.hiHz }
      : { lo: entry.loHz - BAND_MARGIN_HZ, hi: entry.hiHz + BAND_MARGIN_HZ };
  const { lo, hi } = bandIndices(sr, entry.fftSize, range.lo, range.hi);
  return { binHz, binLo: lo, binHi: hi, rows: hi - lo + 1 };
}

/**
 * Pixel row for a frequency in the spectrogram. Bin k covers [k - 0.5, k + 0.5] bins.
 * @param {{binHz: number, binHi: number, rows: number}} win
 * @param {number} hz
 * @param {number} height CSS px of the spectrogram
 * @returns {number} CSS px from the top
 */
function specYOfHz(win, hz, height) {
  return ((win.binHi + 0.5 - hz / win.binHz) / win.rows) * height;
}

/**
 * Colour a float raster through the LUT.
 * @param {Float32Array} values
 * @param {number} w
 * @param {number} h
 * @param {number} floorDb
 * @param {number} ceilDb
 * @returns {HTMLCanvasElement} offscreen canvas
 */
function colorize(values, w, h, floorDb, ceilDb) {
  const span = ceilDb - floorDb || 1;
  const img = new ImageData(w, h);
  const out = img.data;
  for (let i = 0; i < values.length; i++) {
    const idx = clamp(Math.round(((values[i] - floorDb) / span) * 255), 0, 255);
    out[4 * i] = LUT[4 * idx];
    out[4 * i + 1] = LUT[4 * idx + 1];
    out[4 * i + 2] = LUT[4 * idx + 2];
    out[4 * i + 3] = 255;
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').putImageData(img, 0, 0);
  return canvas;
}

/**
 * @param {CanvasRenderingContext2D} ctx CSS-px transform already applied
 * @param {number} width CSS px
 * @param {number} height CSS px
 * @param {number[]} fill
 * @returns {void}
 */
function paintBackground(ctx, width, height, fill) {
  ctx.fillStyle = cssRgb(fill);
  ctx.fillRect(0, 0, width, height);
}

/**
 * CSS-px x of a sample index.
 * @param {number} s
 * @param {{plotLeft: number, plotW: number}} g
 * @param {{s0: number, s1: number}} view
 * @returns {number}
 */
function xOfSample(s, g, view) {
  return g.plotLeft + ((s - view.s0) / (view.s1 - view.s0)) * g.plotW;
}

/**
 * Draw one trace. Columns with more than one sample are reduced: 'max' keeps the
 * column maximum (polyline), 'minmax' draws a vertical min-to-max stroke. Samples
 * are drawn directly when there are fewer samples than pixels. NaN breaks the line.
 * @param {CanvasRenderingContext2D} ctx
 * @param {{plotLeft: number, plotW: number}} g
 * @param {{s0: number, s1: number}} view
 * @param {number} sampleCount
 * @param {(i: number) => number} valueAt NaN where nothing should be drawn
 * @param {(v: number) => number} yOf
 * @param {number[]} color
 * @param {'max'|'minmax'} mode
 * @returns {void}
 */
function paintTrace(ctx, g, view, sampleCount, valueAt, yOf, color, mode) {
  const perPx = (view.s1 - view.s0) / g.plotW;
  const cols = [];
  if (perPx >= 1) {
    for (let px = 0; px < g.plotW; px++) {
      const a = Math.max(0, Math.floor(view.s0 + px * perPx));
      const b = Math.min(sampleCount, Math.max(a + 1, Math.floor(view.s0 + (px + 1) * perPx)));
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = a; i < b; i++) {
        const v = valueAt(i);
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      const valid = hi >= lo;
      cols.push({ x: g.plotLeft + px + 0.5, lo: valid ? lo : NaN, hi: valid ? hi : NaN });
    }
  } else {
    const first = Math.max(0, Math.floor(view.s0));
    const last = Math.min(sampleCount, Math.ceil(view.s1));
    for (let i = first; i < last; i++) {
      const v = valueAt(i);
      cols.push({ x: xOfSample(i, g, view), lo: v, hi: v });
    }
  }
  ctx.strokeStyle = cssRgb(color);
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (mode === 'minmax') {
    for (const c of cols) {
      if (Number.isNaN(c.hi)) continue;
      ctx.moveTo(c.x, yOf(c.hi));
      ctx.lineTo(c.x, yOf(c.lo));
    }
  } else {
    let pen = false;
    for (const c of cols) {
      if (Number.isNaN(c.hi)) {
        pen = false;
        continue;
      }
      if (pen) ctx.lineTo(c.x, yOf(c.hi));
      else ctx.moveTo(c.x, yOf(c.hi));
      pen = true;
    }
  }
  ctx.stroke();
}

/**
 * Time ticks along the bottom edge of a panel.
 * @param {CanvasRenderingContext2D} ctx
 * @param {{plotLeft: number, plotW: number}} g
 * @param {number} height
 * @param {{s0: number, s1: number}} view
 * @param {number} sampleRate
 * @param {number[]} ink
 * @returns {void}
 */
function paintTimeTicks(ctx, g, height, view, sampleRate, ink) {
  const t0 = (view.s0 * 1000) / sampleRate;
  const t1 = (view.s1 * 1000) / sampleRate;
  const step = niceStep(t1 - t0, 8, TIME_STEPS_MS);
  ctx.fillStyle = cssRgb(ink);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
    const x = xOfSample((t * sampleRate) / 1000, g, view);
    ctx.fillRect(x, height - 5, 1, 5);
    ctx.fillText(`${fmtInt(t)} ms`, x + 3, height - 6);
  }
}

/**
 * Spectrogram image for the current view: columnMax at device resolution, then
 * the LUT. The image spans frames [fA, fB) exactly, so it lines up with the other
 * panels in time.
 * @param {CanvasRenderingContext2D} ctx device-px transform (identity) applied by caller
 * @param {{plotLeft: number, plotW: number, dpr: number}} g
 * @param {number} height CSS px
 * @param {{s0: number, s1: number}} view
 * @param {ReturnType<typeof computeAnalysis>} entry
 * @param {ReturnType<typeof specWindow>} win
 * @param {{floorDb: number, ceilDb: number}} display
 * @returns {void}
 */
function paintSpectrogramImage(ctx, g, height, view, entry, win, display) {
  const { spec, fftSize, hop } = entry;
  const fA = (view.s0 - fftSize / 2) / hop;
  const fB = (view.s1 - fftSize / 2) / hop;
  const f0 = clamp(Math.floor(fA), 0, spec.frames - 1);
  const f1 = clamp(Math.ceil(fB), f0 + 1, spec.frames);
  const plotDevW = g.plotW * g.dpr;
  const devH = Math.round(height * g.dpr);
  const imgW = Math.max(1, Math.round((plotDevW * (f1 - f0)) / (fB - fA)));
  const raster = columnMax(
    spec.data,
    spec.frames,
    spec.bins,
    f0,
    f1,
    win.binLo,
    win.binHi,
    imgW,
    devH,
    new Float32Array(imgW * devH),
  );
  const img = colorize(raster, imgW, devH, display.floorDb, display.ceilDb);
  const scale = plotDevW / (fB - fA);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.beginPath();
  ctx.rect(g.plotLeft * g.dpr, 0, plotDevW, devH);
  ctx.clip();
  ctx.drawImage(img, g.plotLeft * g.dpr + (f0 - fA) * scale, 0, (f1 - f0) * scale, devH);
  ctx.restore();
}

/**
 * Draw the spectrogram panel into its base canvas.
 * @returns {void}
 */
function paintSpectrogram(ctx, g, view, entry, win, display, colors) {
  const H = SPEC_HEIGHT;
  paintBackground(ctx, g.width, H, colors.scope);
  if (entry.spec.frames > 0) {
    paintSpectrogramImage(ctx, g, H, view, entry, win, display);
  }
  ctx.font = `11px ${colors.fontTight}`;
  ctx.fillStyle = cssRgb(colors.scopeInk);
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const fTop = (win.binHi + 0.5) * win.binHz;
  const fBot = (win.binLo - 0.5) * win.binHz;
  const step = niceStep(fTop - fBot, 6, FREQ_STEPS_HZ);
  const decimals = step >= 1000 ? 0 : step >= 500 ? 1 : 2;
  for (let f = Math.ceil(fBot / step) * step; f <= fTop; f += step) {
    const y = specYOfHz(win, f, H);
    ctx.fillRect(GUTTER - 4, y, 4, 1);
    ctx.fillText(`${(f / 1000).toFixed(decimals)} kHz`, GUTTER - 6, y);
  }
  paintTimeTicks(ctx, g, H, view, entry.sampleRate, colors.scopeInk);
}

/**
 * Outline each stretch the decoder named (wake tone, resting frame, tap, signal after a
 * hit) on the capture's spectrogram, so the segmentation can be checked against the picture.
 * @param {CanvasRenderingContext2D} ctx CSS-px transform applied
 * @param {{plotLeft: number, plotW: number}} g
 * @param {{s0: number, s1: number}} view
 * @param {number} sampleRate
 * @param {{binHz: number, binLo: number, binHi: number}} win
 * @param {import('./reading.js').ReadingPart[]} parts
 * @returns {void}
 */
function paintMarks(ctx, g, view, sampleRate, win, parts) {
  const H = SPEC_HEIGHT;
  const right = g.plotLeft + g.plotW;
  ctx.save();
  ctx.beginPath();
  ctx.rect(g.plotLeft, 0, g.plotW, H);
  ctx.clip();
  ctx.lineWidth = 2;
  ctx.font = `600 11px ${FONT_TIGHT_FALLBACK}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  for (const part of parts) {
    const x0 = xOfSample((part.startMs * sampleRate) / 1000, g, view);
    const x1 = xOfSample((part.endMs * sampleRate) / 1000, g, view);
    if (x1 < g.plotLeft || x0 > right) continue;
    ctx.strokeStyle = PART_COLORS[part.kind];
    ctx.fillStyle = PART_COLORS[part.kind];
    if (part.loHz === null) {
      ctx.strokeRect(x0, 1, Math.max(3, x1 - x0), H - 2);
      ctx.fillText(part.label, x0 + 4, 14);
      continue;
    }
    const yTop = specYOfHz(win, part.hiHz, H);
    const yBottom = specYOfHz(win, part.loHz, H);
    ctx.strokeRect(x0, yTop, Math.max(3, x1 - x0), yBottom - yTop);
    ctx.fillText(part.label, Math.max(x0, g.plotLeft) + 2, yTop - 2);
  }
  ctx.restore();
}

/**
 * dB scale labels for the envelope panel: the peak, then every 20 dB down.
 * @returns {void}
 */
function paintEnvelope(ctx, g, view, entry, colors) {
  const H = ENV_HEIGHT;
  const top = entry.peakDb + ENV_HEADROOM_DB;
  const bottom = entry.peakDb - ENV_RANGE_DB;
  const yOf = (db) => PANEL_PAD + ((top - db) / (top - bottom)) * (H - 2 * PANEL_PAD);
  paintBackground(ctx, g.width, H, colors.scope);
  ctx.font = `11px ${colors.fontTight}`;
  ctx.fillStyle = cssRgb(colors.scopeInk);
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let db = entry.peakDb; db >= bottom; db -= 20) {
    const y = yOf(db);
    ctx.fillText(fmtDb(db), GUTTER - 6, y);
  }
  paintTrace(ctx, g, view, entry.sampleCount, (i) => entry.envDb[i], yOf, colors.scopeInk, 'max');
}

/**
 * Instantaneous frequency over the tag band. Only drawn where the envelope is within
 * IF_GATE_DB of its peak. Dotted guide lines mark the detected tones.
 * @returns {void}
 */
function paintFrequency(ctx, g, view, entry, colors) {
  const H = IF_HEIGHT;
  const { loHz, hiHz } = entry;
  const yOf = (hz) => PANEL_PAD + ((hiHz - hz) / (hiHz - loHz)) * (H - 2 * PANEL_PAD);
  const gateDb = entry.peakDb - IF_GATE_DB;
  paintBackground(ctx, g.width, H, colors.scope);
  ctx.font = `11px ${colors.fontTight}`;
  ctx.fillStyle = cssRgb(colors.scopeInk);
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${(hiHz / 1000).toFixed(1)} kHz`, GUTTER - 6, yOf(hiHz));
  ctx.fillText(`${(loHz / 1000).toFixed(1)} kHz`, GUTTER - 6, yOf(loHz));
  ctx.strokeStyle = cssRgb(colors.rule);
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 3]);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillStyle = cssRgb(colors.scopeInk);
  for (const level of entry.levels) {
    const y = Math.round(yOf(level.hz)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(g.plotLeft, y);
    ctx.lineTo(g.plotLeft + g.plotW, y);
    ctx.stroke();
    ctx.fillText(`${fmtInt(level.hz)} Hz`, g.plotLeft + 4, y - 2);
  }
  ctx.setLineDash([]);
  const gated = (i) => (entry.envDb[i] >= gateDb ? entry.inst[i] : NaN);
  paintTrace(ctx, g, view, entry.sampleCount, gated, yOf, colors.scopeInk, 'minmax');
}

/**
 * Cursor and selection overlays, composited on top of a base image.
 * @param {CanvasRenderingContext2D} ctx CSS-px transform applied
 * @param {{plotLeft: number, plotW: number}} g
 * @param {number} height
 * @param {{s0: number, s1: number}} view
 * @param {{a: number, b: number} | null} selection
 * @param {{s: number} | null} pointer
 * @param {number[]} signal
 * @returns {void}
 */
function paintOverlay(ctx, g, height, view, selection, pointer, signal) {
  if (selection) {
    const xa = xOfSample(selection.a, g, view);
    const xb = xOfSample(selection.b, g, view);
    ctx.globalAlpha = 0.2;
    ctx.fillStyle = cssRgb(signal);
    ctx.fillRect(xa, 0, xb - xa, height);
    ctx.globalAlpha = 1;
  }
  if (pointer) {
    const x = xOfSample(pointer.s, g, view);
    if (x >= g.plotLeft && x <= g.plotLeft + g.plotW) {
      ctx.strokeStyle = cssRgb(signal);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, height);
      ctx.stroke();
    }
  }
}

/**
 * Plain text of the level sequence, capped for display.
 * @param {ReturnType<typeof computeAnalysis>} entry
 * @returns {{full: string, preview: string, count: number}}
 */
function sequenceOf(entry) {
  const seq = expandLevelSequence(entry.runs, entry.symbolMs);
  const shown = seq.slice(0, MAX_SYMBOLS_SHOWN).join(' ');
  return {
    full: seq.join(' '),
    preview: seq.length > MAX_SYMBOLS_SHOWN ? `${shown} …` : shown,
    count: seq.length,
  };
}

/**
 * Build the analysis view DOM once and return its controller.
 * @param {HTMLElement} container
 * @param {{getBand: () => {loHz: number, hiHz: number}, getDisplayRange: () => {loHz: number, hiHz: number, floorDb: number, ceilDb: number}, getMarks?: (capture: object) => import('./reading.js').ReadingPart[]}} options
 *   getMarks gives the stretches the decoder named in a capture, to outline on its spectrogram
 * @returns {{show: (capture: object | null) => void, refresh: () => void}}
 */
export function createAnalysisView(container, { getBand, getDisplayRange, getMarks }) {
  const colors = readPalette();

  const root = el('div', 'an-analysis');
  const meta = el('p', 'an-meta');
  const note = el('p', 'an-note');
  const empty = el('p', 'an-empty', 'Select a capture to analyse it.');

  const fftSelect = el('select', 'an-select');
  fftSelect.setAttribute('aria-label', 'FFT size');
  for (const size of FFT_SIZES) fftSelect.append(new Option(String(size), String(size)));
  fftSelect.value = String(DEFAULT_FFT_SIZE);
  const fftField = el('label', 'an-field');
  fftField.append('FFT size', fftSelect);

  const zoomBurstBtn = button('Zoom to burst', () => zoomToBurst());
  const wholeBtn = button('Whole clip', () => setView(wholeClipView()));
  const freqBtn = button('Frequency: tag band ±1 kHz', () => toggleFrequencyMode());
  freqBtn.setAttribute('aria-pressed', 'false');

  const controls = el('div', 'an-controls');
  controls.append(fftField, zoomBurstBtn, wholeBtn, freqBtn);

  const stack = el('div', 'an-stack');
  const panels = [
    { name: 'spec', height: SPEC_HEIGHT },
    { name: 'env', height: ENV_HEIGHT },
    { name: 'if', height: IF_HEIGHT },
  ].map((p) => ({
    ...p,
    canvas: el('canvas'),
    ctx: null,
    base: document.createElement('canvas'),
    baseCtx: null,
  }));
  for (const p of panels) {
    p.canvas.style.height = `${p.height}px`;
    p.ctx = p.canvas.getContext('2d');
    p.baseCtx = p.base.getContext('2d');
    stack.append(p.canvas);
  }
  stack.tabIndex = 0;
  stack.setAttribute('role', 'group');
  stack.setAttribute('aria-label', 'Spectrogram, envelope and instantaneous frequency');

  const readout = el('p', 'an-readout');
  const zoomSelBtn = button('Zoom to selection', () => zoomToSelection());
  const clearSelBtn = button('Clear selection', () => clearSelection());
  const selectionBar = el('div', 'an-selection-bar');
  selectionBar.append(zoomSelBtn, clearSelBtn);

  const findings = el('ul', 'an-findings');
  const sequenceLine = el('p', 'an-sequence');
  const copyBtn = button('Copy', () => copySequence());
  const copyStatus = el('span', 'an-copy-status');
  const sequenceRow = el('div', 'an-selection-bar');
  sequenceRow.append(sequenceLine, copyBtn, copyStatus);

  const body = el('div', 'an-body');
  body.append(controls, stack, readout, selectionBar, findings, sequenceRow);

  root.append(meta, note, empty, body);
  container.append(root);

  const state = {
    capture: null,
    cache: null,
    view: null,
    selection: null,
    drag: null,
    pointer: null,
    freqMode: 'tag',
    geom: null,
    win: null,
    lastWidth: 0,
    sequenceFull: '',
  };

  function ensureEntry() {
    const band = usableBand(getBand(), state.capture.sampleRate);
    const fftSize = Number(fftSelect.value);
    const c = state.cache;
    if (
      c &&
      c.capture === state.capture &&
      c.loHz === band.loHz &&
      c.hiHz === band.hiHz &&
      c.fftSize === fftSize
    ) {
      return c;
    }
    state.cache = computeAnalysis(state.capture, band, fftSize);
    return state.cache;
  }

  function wholeClipView() {
    return { s0: 0, s1: state.capture.samples.length };
  }

  function setView(view) {
    state.view = view;
    state.selection = null;
    paintAll();
    drawOverlays();
    updateButtons();
  }

  function zoomToBurst() {
    const entry = state.cache;
    if (!entry?.burst) return;
    const pad = Math.round((BURST_PAD_MS * entry.sampleRate) / 1000);
    setView({
      s0: Math.max(0, entry.burst.start - pad),
      s1: Math.min(entry.sampleCount, entry.burst.end + pad),
    });
  }

  function zoomToSelection() {
    if (!state.selection) return;
    setView({ s0: state.selection.a, s1: state.selection.b });
  }

  function clearSelection() {
    state.selection = null;
    drawOverlays();
    updateButtons();
  }

  function toggleFrequencyMode() {
    state.freqMode = state.freqMode === 'tag' ? 'display' : 'tag';
    freqBtn.textContent =
      state.freqMode === 'tag' ? 'Frequency: tag band ±1 kHz' : 'Frequency: display range';
    freqBtn.setAttribute('aria-pressed', String(state.freqMode === 'display'));
    paintAll();
    drawOverlays();
  }

  async function copySequence() {
    try {
      await navigator.clipboard.writeText(state.sequenceFull);
      copyStatus.textContent = 'Copied.';
    } catch {
      copyStatus.textContent = 'Copy failed.';
    }
  }

  function updateButtons() {
    const entry = state.cache;
    zoomBurstBtn.disabled = !entry?.burst;
    zoomSelBtn.disabled = !state.selection;
    clearSelBtn.disabled = !state.selection;
  }

  function updateHeader(capture) {
    const time = new Date(capture.createdAt).toTimeString().slice(0, 8);
    const duration = capture.samples.length / capture.sampleRate;
    meta.textContent =
      `${time} · ${capture.source} · ${capture.sampleRate} Hz · ${fmtMs(duration, 2)} s clip`;
    note.textContent = capture.note || '';
  }

  function updateFindings(entry) {
    findings.replaceChildren(...findingLines(entry).map((line) => el('li', null, line)));
    const seq = entry.levels.length >= 2 && entry.symbolMs !== null ? sequenceOf(entry) : null;
    state.sequenceFull = seq ? seq.full : '';
    sequenceLine.textContent = seq
      ? `Estimated level sequence, ${seq.count} symbols: ${seq.preview}`
      : '';
    copyBtn.hidden = !seq;
    copyStatus.textContent = '';
  }

  function paintAll() {
    const entry = state.cache;
    const cssW = stack.clientWidth;
    if (!entry || cssW <= GUTTER + RIGHT_MARGIN + 8) return;
    const dpr = window.devicePixelRatio || 1;
    const g = { width: cssW, plotLeft: GUTTER, plotW: cssW - GUTTER - RIGHT_MARGIN, dpr };
    const display = getDisplayRange();
    const win = specWindow(entry, state.freqMode, display);
    for (const p of panels) {
      for (const c of [p.canvas, p.base]) {
        c.width = Math.round(cssW * dpr);
        c.height = Math.round(p.height * dpr);
      }
      p.baseCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    const view = state.view;
    paintSpectrogram(panels[0].baseCtx, g, view, entry, win, display, colors);
    paintMarks(panels[0].baseCtx, g, view, entry.sampleRate, win, getMarks ? getMarks(state.capture) : []);
    paintEnvelope(panels[1].baseCtx, g, view, entry, colors);
    paintFrequency(panels[2].baseCtx, g, view, entry, colors);
    state.geom = g;
    state.win = win;
    state.lastWidth = cssW;
  }

  function drawOverlays() {
    const g = state.geom;
    if (!g || !state.view) return;
    for (const p of panels) {
      p.ctx.setTransform(1, 0, 0, 1, 0, 0);
      p.ctx.drawImage(p.base, 0, 0);
      p.ctx.setTransform(g.dpr, 0, 0, g.dpr, 0, 0);
      paintOverlay(p.ctx, g, p.height, state.view, state.selection, state.pointer, colors.signal);
    }
    readout.textContent = readoutText();
  }

  function pointerText(entry, p) {
    const sr = entry.sampleRate;
    const i = clamp(Math.round(p.s), 0, entry.sampleCount - 1);
    const t = `t = ${fmtMs((p.s * 1000) / sr, 2)} ms`;
    if (p.panel === 'spec') {
      if (entry.spec.frames === 0) return t;
      const hz = (state.win.binHi + 0.5 - (p.yCss / SPEC_HEIGHT) * state.win.rows) * state.win.binHz;
      const frame = clamp(
        Math.round((p.s - entry.fftSize / 2) / entry.hop),
        0,
        entry.spec.frames - 1,
      );
      const bin = clamp(Math.round(hz / state.win.binHz), state.win.binLo, state.win.binHi);
      const db = entry.spec.data[frame * entry.spec.bins + bin];
      return `${t}, f = ${fmtInt(hz)} Hz, ${fmtDb(db)}`;
    }
    if (p.panel === 'env') return `${t}, ${fmtDb(entry.envDb[i])}`;
    const gated = entry.envDb[i] >= entry.peakDb - IF_GATE_DB;
    return `${t}, f = ${gated ? `${fmtInt(entry.inst[i])} Hz` : '—'}`;
  }

  function readoutText() {
    const entry = state.cache;
    if (!entry || !state.capture) return '';
    const sel = state.selection;
    if (state.drag && sel && sel.b > sel.a) {
      const dt = ((sel.b - sel.a) * 1000) / entry.sampleRate;
      return `Δt = ${fmtMs(dt, 2)} ms (${fmtInt(1000 / dt)} Hz)`;
    }
    return state.pointer ? pointerText(entry, state.pointer) : '';
  }

  function locate(ev) {
    const g = state.geom;
    if (!g || !state.view) return null;
    const rects = panels.map((p) => p.canvas.getBoundingClientRect());
    let idx = rects.findIndex((r) => ev.clientY >= r.top && ev.clientY < r.bottom);
    if (idx < 0) idx = ev.clientY < rects[0].top ? 0 : panels.length - 1;
    const r = rects[idx];
    const x = clamp(ev.clientX - r.left, g.plotLeft, g.plotLeft + g.plotW);
    const { s0, s1 } = state.view;
    const s = s0 + ((x - g.plotLeft) / g.plotW) * (s1 - s0);
    return { panel: panels[idx].name, s, yCss: ev.clientY - r.top };
  }

  function onPointerDown(ev) {
    if (!state.capture || ev.button !== 0) return;
    const p = locate(ev);
    if (!p) return;
    state.drag = { anchor: p.s };
    state.selection = null;
    state.pointer = p;
    stack.setPointerCapture(ev.pointerId);
    drawOverlays();
    updateButtons();
  }

  function onPointerMove(ev) {
    const p = locate(ev);
    state.pointer = p;
    if (state.drag && p) {
      const a = Math.min(state.drag.anchor, p.s);
      const b = Math.max(state.drag.anchor, p.s);
      state.selection = { a, b };
    }
    drawOverlays();
  }

  function onPointerUp() {
    if (!state.drag) return;
    const sel = state.selection;
    state.drag = null;
    if (!sel || sel.b - sel.a < 1) state.selection = null;
    drawOverlays();
    updateButtons();
  }

  function onPointerLeave() {
    if (state.drag) return;
    state.pointer = null;
    drawOverlays();
  }

  function onKeyDown(ev) {
    if (ev.key === 'Escape' && state.selection) clearSelection();
  }

  stack.addEventListener('pointerdown', onPointerDown);
  stack.addEventListener('pointermove', onPointerMove);
  stack.addEventListener('pointerup', onPointerUp);
  stack.addEventListener('pointercancel', onPointerUp);
  stack.addEventListener('pointerleave', onPointerLeave);
  document.addEventListener('keydown', onKeyDown);

  const resizeObserver = new ResizeObserver(() => {
    if (stack.clientWidth === state.lastWidth || !state.capture) return;
    paintAll();
    drawOverlays();
  });
  resizeObserver.observe(stack);

  function setEmpty(isEmpty) {
    body.hidden = isEmpty;
    empty.hidden = !isEmpty;
  }

  /**
   * Analyse a capture (or clear the view with null). Resets zoom and selection.
   * @param {object | null} capture
   */
  function show(capture) {
    state.capture = capture;
    state.selection = null;
    state.drag = null;
    state.pointer = null;
    if (!capture) {
      state.cache = null;
      state.geom = null;
      state.view = null;
      meta.textContent = '';
      note.textContent = '';
      findings.replaceChildren();
      sequenceLine.textContent = '';
      readout.textContent = '';
      setEmpty(true);
      updateButtons();
      return;
    }
    setEmpty(false);
    updateHeader(capture);
    state.view = wholeClipView();
    refresh();
  }

  /**
   * Re-read band and display settings and recompute if needed. Cheap when only
   * the display range changed (the analysis cache is kept).
   */
  function refresh() {
    if (!state.capture) return;
    const entry = ensureEntry();
    updateFindings(entry);
    paintAll();
    drawOverlays();
    updateButtons();
  }

  fftSelect.addEventListener('change', () => refresh());

  return { show, refresh };
}

/**
 * Pairwise similarity table for several captures.
 * @param {HTMLElement} container
 * @param {{getBand: () => {loHz: number, hiHz: number}, clubName: (id: string) => string, onSelect: (captureId: string) => void}} options
 * @returns {{render: (captures: object[]) => Promise<void>}}
 */
export function createSimilarityView(container, { getBand, clubName, onSelect }) {
  const colors = readPalette();

  const root = el('div', 'an-similarity');
  const status = el('p', 'an-status');
  const matrixWrap = el('div', 'an-matrix-wrap');
  const explain = el('p', 'an-explain', EXPLAINER);
  const summary = el('p', 'an-summary');
  root.append(status, matrixWrap, explain, summary);
  container.append(root);

  let token = 0;

  function labelFor(capture) {
    const club = capture.clubId ? clubName(capture.clubId) || 'Unlabelled' : 'Unlabelled';
    return `${club} ${new Date(capture.createdAt).toTimeString().slice(0, 8)}`;
  }

  /**
   * Band-pass, find the burst and crop it. Null when no burst is found.
   * @param {object} capture
   * @param {{loHz: number, hiHz: number}} band
   * @returns {Float32Array | null}
   */
  function clipFor(capture, band) {
    const sr = capture.sampleRate;
    const usable = usableBand(band, sr);
    const analytic = analyticBand(capture.samples, sr, usable.loHz, usable.hiHz);
    const burst = findBurst(envelope(analytic), sr);
    return burst ? cropToBurst(analytic.re, burst, sr) : null;
  }

  /**
   * Background interpolates panel (score 0) to fairway (score 1); text is whichever
   * of ink or paper has the higher contrast against it.
   * @param {number} score 0..1
   * @returns {{bg: string, fg: string}}
   */
  function cellColours(score) {
    const bg = colors.panel.map((c, i) => Math.round(c + (colors.fairway[i] - c) * score));
    const fg = contrast(bg, colors.paper) >= contrast(bg, colors.ink) ? colors.paper : colors.ink;
    return { bg: cssRgb(bg), fg: cssRgb(fg) };
  }

  function buildCell(rowCap, colCap, score, lag) {
    const cell = el('button', 'an-cell', score.toFixed(2));
    cell.type = 'button';
    const colours = cellColours(score);
    cell.style.backgroundColor = colours.bg;
    cell.style.color = colours.fg;
    const lagMs = (lag * 1000) / rowCap.sampleRate;
    const text = `${labelFor(rowCap)} vs ${labelFor(colCap)}: ${score.toFixed(2)} at lag ${fmtMs(lagMs, 2)} ms`;
    cell.title = text;
    cell.setAttribute('aria-label', text);
    cell.addEventListener('click', () => onSelect(rowCap.id));
    return cell;
  }

  function buildTable(shown, matrix, validIndex) {
    const table = el('table', 'an-matrix');
    table.setAttribute('aria-label', 'Pairwise similarity of bursts');
    const head = el('tr');
    head.append(el('th'));
    for (const { capture } of shown) head.append(el('th', null, labelFor(capture)));
    const thead = el('thead');
    thead.append(head);
    table.append(thead);
    const body = el('tbody');
    for (const row of shown) {
      const tr = el('tr');
      const rowIdx = validIndex.get(row.capture.id);
      const rowLabel = rowIdx === undefined ? `${labelFor(row.capture)} — no burst` : labelFor(row.capture);
      tr.append(el('th', rowIdx === undefined ? 'an-dim' : null, rowLabel));
      for (const col of shown) {
        const colIdx = validIndex.get(col.capture.id);
        if (rowIdx === undefined || colIdx === undefined) {
          tr.append(el('td', 'an-cell an-dim', '–'));
          continue;
        }
        const score = matrix.peaks[rowIdx * matrix.n + colIdx];
        const lag = matrix.lags[rowIdx * matrix.n + colIdx];
        tr.append(buildCell(row.capture, col.capture, score, lag));
      }
      body.append(tr);
    }
    table.append(body);
    return table;
  }

  /**
   * Mean same-club and different-club scores over unordered pairs. Null when either
   * group is empty. Unlabelled captures are ignored.
   */
  function summaryText(shown, matrix, validIndex) {
    const same = [];
    const diff = [];
    for (let i = 0; i < shown.length; i++) {
      for (let j = i + 1; j < shown.length; j++) {
        const a = shown[i].capture;
        const b = shown[j].capture;
        const ia = validIndex.get(a.id);
        const ib = validIndex.get(b.id);
        if (ia === undefined || ib === undefined || !a.clubId || !b.clubId) continue;
        const score = matrix.peaks[ia * matrix.n + ib];
        (a.clubId === b.clubId ? same : diff).push(score);
      }
    }
    if (same.length === 0 || diff.length === 0) return '';
    const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
    return (
      `Mean score, same club: ${mean(same).toFixed(2)} over ${same.length} pairs. ` +
      `Different clubs: ${mean(diff).toFixed(2)} over ${diff.length} pairs.`
    );
  }

  /**
   * Compare captures pairwise. Yields to the event loop between captures so the
   * page stays responsive; a newer render supersedes an older one.
   * @param {object[]} captures
   * @returns {Promise<void>}
   */
  async function render(captures) {
    const mine = ++token;
    matrixWrap.replaceChildren();
    summary.textContent = '';
    if (captures.length < 2) {
      status.textContent = 'Capture at least two bursts to compare them.';
      return;
    }
    const sorted = [...captures].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const shownCaptures = sorted.slice(0, SIMILARITY_MAX_CAPTURES);
    const truncated =
      captures.length > SIMILARITY_MAX_CAPTURES
        ? ` Showing the ${SIMILARITY_MAX_CAPTURES} newest of ${captures.length} captures.`
        : '';
    status.textContent = `Comparing…${truncated}`;

    const band = getBand();
    const shown = [];
    for (const capture of shownCaptures) {
      await yieldToEventLoop();
      if (mine !== token) return;
      shown.push({ capture, clip: clipFor(capture, band) });
    }

    const clips = shown.filter((s) => s.clip).map((s) => s.clip);
    const validIndex = new Map();
    shown.filter((s) => s.clip).forEach((s, i) => validIndex.set(s.capture.id, i));
    const matrix = similarityMatrix(clips);
    if (mine !== token) return;

    status.textContent = truncated.trim();
    matrixWrap.replaceChildren(buildTable(shown, matrix, validIndex));
    summary.textContent = summaryText(shown, matrix, validIndex);
  }

  return { render };
}

/** @returns {Promise<void>} resolves after pending tasks, so the page can paint */
function yieldToEventLoop() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Relative luminance of an sRGB triple (WCAG).
 * @param {number[]} rgb
 * @returns {number}
 */
function luminance(rgb) {
  const [r, g, b] = rgb.map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * WCAG contrast ratio between two sRGB triples.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
