/**
 * app.js - DOM wiring for OSSTagLab. Engine owns audio, api.js owns the
 * server, clubs.js owns labels; this module connects them to the page and
 * mounts the analysis modules when they are present.
 */
import { Engine } from './engine.js';
import * as api from './api.js';
import { CLUBS, clubName } from './clubs.js';
import { bandIndices, colorLUT, decodeWav, encodeWav, stft } from './dsp.js';
import { ToneTracker, classify, decodeTagSignals } from './tag-decoder.js';
import {
  HIT_ROLE,
  addObservation,
  clubSummary,
  emptyCodebook,
  isLosslessCodebook,
  isSolidFrames,
  matchFrame,
  normalizeCodebook,
  observationFromEvent,
  removeClub,
} from './codebook.js';
import { PART_COLORS, emptyReading, isEmptyReading, labelEvents, mergeReading } from './reading.js';
import { closeSession, eventsToSave, hitsOf, newSession, settleSave, stepSession } from './session.js';
import { createMappingView } from './mapping.js';
import { concat, silence, synthFrames, synthHop, synthTone } from './tag-synth.js';

const SETTINGS_KEY = 'ossTagLab.settings.v1';
const SETTING_IDS = [
  'device', 'sampleRate',
  'dispLo', 'dispHi', 'dispFloor', 'dispCeil',
  'trigLo', 'trigHi', 'trigThresh', 'preRoll', 'postRoll', 'armed',
  'club', 'note', 'autoSave', 'slowSpeed',
];
const DISPLAY_IDS = ['dispLo', 'dispHi', 'dispFloor', 'dispCeil'];
const TRIGGER_IDS = ['trigLo', 'trigHi', 'trigThresh', 'preRoll', 'postRoll', 'armed'];

const DEFAULTS = {
  dispLo: 0,
  dispHi: 24000,
  dispFloor: -130,
  dispCeil: -40,
  trigLo: 15000,
  trigHi: 22000,
  trigThresh: 12,
  preRoll: 500,
  postRoll: 1500,
};
const FALLBACK_RATE = 48000;
const MIN_DISPLAY_SPAN_HZ = 100;
const MAX_ROLL_MS = 10000;
const ZOOM_PAD_HZ = 2000;
const TICK_STEPS_HZ = [500, 1000, 2000, 5000];
const CLIP_LEVEL = 0.99;
const CLIP_HOLD_MS = 2000;
const METER_INTERVAL_MS = 66;
const TRIGGER_MARK_PX = 8;
const CAPTURE_LAST_SECONDS = 3;
const CAPTURE_LONG_SECONDS = 20;
const MAX_IMPORT_SECONDS = 20;
const LIVE_DECODE_INTERVAL_MS = 250;
const LIVE_WINDOW_SECONDS = 8;
const READING_KIND_LABELS = { frames: 'frame', tone: 'tone', hop: 'hop pattern' };
const HIT_FRAME_LABEL = 'frame after a hit';
const RELIGHT_NOTE = 'Light the tag again and hold for 3 seconds before tapping, or press Save if the tiles are right.';
/** What the station says when a reading was not saved by itself, by the session's reason. */
const REFUSAL_NOTES = Object.freeze({
  'no-frame': () => `Not saved by itself: the resting frame was not read clearly. ${RELIGHT_NOTE}`,
  'too-brief': () => `Not saved by itself: the resting frame was heard too briefly to be sure of. ${RELIGHT_NOTE}`,
  'no-wake': () =>
    'Not saved by itself: the start of this signal was not heard, so the resting frame is not certain. Light the tag again, or press Save if the tiles are right.',
  'order-unknown': () =>
    'Not saved by itself: the start of this signal was not heard, so the resting frame is not certain. Light the tag again, or press Save if the tiles are right.',
  differs: (club) =>
    `Not saved by itself: the ${club} already has a different resting frame. Press Save to add it anyway, or Clear reading.`,
  'club-changed': (club) =>
    `Not saved by itself: the club was changed while this reading was being heard. Press Save to save it as the ${club}, or Clear reading.`,
});
const AUTO_SAVE_KEY = 'ossTagLab.autoSave.v1';
const LOW_RATE_NOTE = 'The sample rate of this recording is too low to hold the tag band.';
const CODEBOOK_LOSSY_NOTE =
  'codebook.json holds entries this app does not understand. Saving is off so they are not erased.';
const HTTP_CONFLICT = 409;
/** A made-up tag for checking the decoder through the speakers; no real club uses these values. */
const SYNTH_TAG = Object.freeze({
  sampleRate: 48000,
  gapMs: 300,
  frames: { restHz: 17900, symbols: [2, -3, 1, -4, 3, -2], repeats: 12, amplitude: 0.1 },
  tone: { hz: 19200, ms: 320, amplitude: 0.1 },
  hop: { restHz: 18850, offsetHz: 350, periodMs: 90, hops: 20, amplitude: 0.1 },
});
const LOAD_CONCURRENCY = 4;
const THUMB_W = 160;
const THUMB_H = 48;
const THUMB_FFT = 512;
const THUMB_HOP = 256;
const THUMB_PAD_HZ = 2000;
const SOURCE_LABELS = { trigger: 'Trigger', manual: 'Manual', import: 'Imported' };
const SCOPE_LABEL_BG = 'rgba(11, 20, 24, 0.75)';

const $ = (id) => document.getElementById(id);
const engine = new Engine();

const state = {
  listening: false,
  starting: false,
  capturing: false,
  captures: [],
  selected: null,
  confirmingDelete: null,
  nextLocalId: 1,
  display: null,
  trigger: null,
  meter: { peak: 0, bandDb: -Infinity, floorDb: -Infinity },
  clipUntil: 0,
  playStop: null,
};

const savedSettings = loadSettings();
let deviceChoice = typeof savedSettings.device === 'string' ? savedSettings.device : '';
let palette = {};
let analysisView = null;
let similarityView = null;
let mappingView = null;

const live = {
  tracker: null,
  fedAbs: 0,
  newestAbs: 0,
  /**
   * Live event times run on one clock that never goes backwards: each tracker's own time
   * (which restarts at 0) plus the clock value when that tracker was started.
   */
  originMs: 0,
  /** Absolute sample the running tracker started at: live time `originMs`. */
  originAbs: 0,
  nowMs: 0,
  /** Tracker time of the first window of the running tracker; later windows have slid. */
  firstWindowMs: null,
  /** Everything decoded in the current live window, on the live clock. */
  events: [],
  /** The live reading, the club it belongs to and whether it has been judged: see session.js. */
  session: newSession(),
  /**
   * A reading taken from a recording, with the recording's name. While set it is the one
   * shown and saved, and live audio is not read.
   * @type {{source: string, reading: object}|null}
   */
  pinned: null,
  codebook: emptyCodebook(),
  /** False until the stored codebook has loaded with nothing lost; saving is refused until then. */
  codebookUsable: false,
  saving: false,
};

const scope = {
  canvas: null,
  ctx: null,
  overlay: null,
  octx: null,
  wrap: null,
  w: 0,
  h: 0,
  column: null,
  map: false,
  /** Samples between spectrogram columns, measured from the engine's frames. */
  hopSamples: 0,
  /** True while the overlay carries marks that must scroll with the spectrogram. */
  marked: false,
  rowLo: null,
  rowHi: null,
  lut: colorLUT(),
};

const saveErrors = new WeakMap();
const savingNow = new WeakSet();
const thumbs = new WeakMap();
const decodedCache = new WeakMap();

/* ------------------------------------------------------------------ */
/* Settings persistence                                                */
/* ------------------------------------------------------------------ */

/** @returns {object} saved settings, or {} when none or unreadable */
function loadSettings() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** @returns {void} */
function persistSettings() {
  const values = {};
  for (const id of SETTING_IDS) {
    const el = $(id);
    values[id] = el.type === 'checkbox' ? el.checked : el.value;
  }
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(values));
  } catch {
    // Storage unavailable: settings are simply not kept.
  }
}

/**
 * @param {object} saved
 * @returns {void}
 */
function applySettings(saved) {
  for (const id of SETTING_IDS) {
    if (!(id in saved)) continue;
    const el = $(id);
    const value = saved[id];
    if (el.type === 'checkbox') {
      el.checked = Boolean(value);
    } else if (el.tagName === 'SELECT') {
      if ([...el.options].some((o) => o.value === String(value))) el.value = String(value);
    } else {
      el.value = String(value);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Reading controls                                                    */
/* ------------------------------------------------------------------ */

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/**
 * @param {string} id input element id
 * @param {number} fallback used when the field is empty or not a number
 * @returns {number}
 */
function readNumber(id, fallback) {
  const raw = $(id).value.trim();
  const n = raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** @returns {number} the input's sample rate while listening, else the picker value */
function currentSampleRate() {
  return engine.sampleRate || Number($('sampleRate').value) || FALLBACK_RATE;
}

/** @returns {{loHz: number, hiHz: number, floorDb: number, ceilDb: number}} clamped display range */
function readDisplay() {
  const nyq = currentSampleRate() / 2;
  let loHz = clamp(readNumber('dispLo', DEFAULTS.dispLo), 0, nyq);
  let hiHz = clamp(readNumber('dispHi', DEFAULTS.dispHi), 0, nyq);
  if (hiHz < loHz) [loHz, hiHz] = [hiHz, loHz];
  if (hiHz - loHz < MIN_DISPLAY_SPAN_HZ) hiHz = Math.min(nyq, loHz + MIN_DISPLAY_SPAN_HZ);
  const floorDb = readNumber('dispFloor', DEFAULTS.dispFloor);
  let ceilDb = readNumber('dispCeil', DEFAULTS.dispCeil);
  if (ceilDb <= floorDb) ceilDb = floorDb + 1;
  return { loHz, hiHz, floorDb, ceilDb };
}

/**
 * Write a normalised display range back into the inputs.
 * @param {{loHz: number, hiHz: number, floorDb: number, ceilDb: number}} d
 * @returns {void}
 */
function writeDisplayInputs(d) {
  $('dispLo').value = String(Math.round(d.loHz));
  $('dispHi').value = String(Math.round(d.hiHz));
  $('dispFloor').value = String(Math.round(d.floorDb));
  $('dispCeil').value = String(Math.round(d.ceilDb));
}

/** @returns {{loHz: number, hiHz: number, thresholdDb: number, preRollMs: number, postRollMs: number, armed: boolean}} */
function readTrigger() {
  const a = readNumber('trigLo', DEFAULTS.trigLo);
  const b = readNumber('trigHi', DEFAULTS.trigHi);
  return {
    loHz: Math.min(a, b),
    hiHz: Math.max(a, b),
    thresholdDb: readNumber('trigThresh', DEFAULTS.trigThresh),
    preRollMs: clamp(readNumber('preRoll', DEFAULTS.preRoll), 0, MAX_ROLL_MS),
    postRollMs: clamp(readNumber('postRoll', DEFAULTS.postRoll), 0, MAX_ROLL_MS),
    armed: $('armed').checked,
  };
}

/**
 * Re-read the display inputs into state and redraw everything that depends on them.
 * @param {{write?: boolean}} [options] write: also write the normalised values back to the inputs
 * @returns {void}
 */
function refreshDisplay({ write = false } = {}) {
  state.display = readDisplay();
  if (write) writeDisplayInputs(state.display);
  scope.map = false;
  drawOverlay();
  analysisView?.refresh();
}

/* ------------------------------------------------------------------ */
/* Spectrogram                                                         */
/* ------------------------------------------------------------------ */

/**
 * Read the palette tokens once, for canvas drawing.
 * @returns {{scope: string, scopeInk: string, signal: string, fontUi: string}}
 */
function readPalette() {
  const style = getComputedStyle(document.documentElement);
  const token = (name) => style.getPropertyValue(name).trim();
  return {
    scope: token('--scope'),
    scopeInk: token('--scope-ink'),
    signal: token('--signal'),
    fontUi: token('--font-ui'),
  };
}

/** @returns {void} */
function resizeScope() {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(scope.wrap.clientWidth * dpr));
  const h = Math.max(1, Math.round(scope.wrap.clientHeight * dpr));
  scope.canvas.width = w;
  scope.canvas.height = h;
  scope.overlay.width = w;
  scope.overlay.height = h;
  scope.w = w;
  scope.h = h;
  scope.column = scope.ctx.createImageData(1, h);
  scope.ctx.fillStyle = palette.scope;
  scope.ctx.fillRect(0, 0, w, h);
  scope.map = false;
  drawOverlay();
}

/**
 * Build the row-to-bin span table for the current display range and height.
 * Each pixel row covers a frequency span; the row shows the maximum bin in it.
 * @param {number} bins number of one-sided bins in each frame
 * @returns {void}
 */
function buildScopeMap(bins) {
  const { loHz, hiHz } = state.display;
  const h = scope.h;
  if (!scope.rowLo || scope.rowLo.length !== h) {
    scope.rowLo = new Int32Array(h);
    scope.rowHi = new Int32Array(h);
  }
  const binHz = engine.sampleRate / ((bins - 1) * 2);
  const span = hiHz - loHz;
  const maxBin = bins - 1;
  for (let y = 0; y < h; y++) {
    const fTop = hiHz - (y / h) * span;
    const fBot = hiHz - ((y + 1) / h) * span;
    const lo = clamp(Math.floor(fBot / binHz), 0, maxBin);
    scope.rowLo[y] = lo;
    scope.rowHi[y] = clamp(Math.ceil(fTop / binHz), lo, maxBin);
  }
  scope.map = true;
}

/**
 * @param {number} db
 * @param {number} floorDb
 * @param {number} scale 255 / (ceilDb - floorDb)
 * @returns {number} palette index in [0, 255]
 */
function lutIndex(db, floorDb, scale) {
  const i = Math.round((db - floorDb) * scale);
  return i < 0 ? 0 : i > 255 ? 255 : i;
}

/**
 * Scroll the spectrogram one device pixel left and paint the newest column.
 * @param {Float32Array} db dB spectrum for this frame
 * @returns {void}
 */
function drawColumn(db) {
  if (!scope.column) return;
  if (!scope.map) buildScopeMap(db.length);
  const { floorDb, ceilDb } = state.display;
  const scale = 255 / (ceilDb - floorDb);
  const out = scope.column.data;
  const lut = scope.lut;
  const { rowLo, rowHi } = scope;
  for (let y = 0; y < scope.h; y++) {
    let max = -Infinity;
    for (let k = rowLo[y]; k <= rowHi[y]; k++) {
      if (db[k] > max) max = db[k];
    }
    const s = lutIndex(max, floorDb, scale) * 4;
    const d = y * 4;
    out[d] = lut[s];
    out[d + 1] = lut[s + 1];
    out[d + 2] = lut[s + 2];
    out[d + 3] = 255;
  }
  scope.ctx.drawImage(scope.canvas, -1, 0);
  scope.ctx.putImageData(scope.column, scope.w - 1, 0);
}

/**
 * @param {number} span Hz
 * @returns {number} tick spacing giving at most 12 ticks
 */
function tickStep(span) {
  return TICK_STEPS_HZ.find((s) => span / s <= 12) ?? TICK_STEPS_HZ[TICK_STEPS_HZ.length - 1];
}

/**
 * Redraw the frequency axis and the trigger band edges. Called on settings
 * changes and resize, never per frame.
 * @returns {void}
 */
function drawOverlay() {
  const c = scope.octx;
  if (!c || !state.display) return;
  const { w, h } = scope;
  const dpr = window.devicePixelRatio || 1;
  c.clearRect(0, 0, w, h);

  const { loHz, hiHz } = state.display;
  const span = hiHz - loHz;
  if (span <= 0) return;
  const yOf = (hz) => ((hiHz - hz) / span) * h;

  c.font = `${Math.round(11 * dpr)}px ${palette.fontUi}`;
  c.textBaseline = 'middle';
  c.textAlign = 'left';
  const labelH = Math.round(14 * dpr);
  const step = tickStep(span);
  for (let hz = Math.ceil(loHz / step) * step; hz <= hiHz; hz += step) {
    const y = yOf(hz);
    const label = `${hz / 1000} kHz`;
    c.fillStyle = SCOPE_LABEL_BG;
    c.fillRect(6 * dpr, y - labelH / 2, c.measureText(label).width + 8 * dpr, labelH);
    c.fillStyle = palette.scopeInk;
    c.fillRect(0, Math.round(y), Math.round(8 * dpr), Math.max(1, Math.round(dpr)));
    c.fillText(label, 10 * dpr, y);
  }

  c.setLineDash([4 * dpr, 4 * dpr]);
  c.strokeStyle = palette.signal;
  c.lineWidth = Math.max(1, dpr);
  for (const hz of [state.trigger.loHz, state.trigger.hiHz]) {
    if (hz < loHz || hz > hiHz) continue;
    const y = Math.round(yOf(hz)) + 0.5;
    c.beginPath();
    c.moveTo(0, y);
    c.lineTo(w, y);
    c.stroke();
  }
  c.setLineDash([]);
  drawMarks(c, yOf);
}

/** @returns {boolean} true when the held reading is live and has parts to mark */
function hasMarks() {
  return state.listening && live.pinned === null && scope.hopSamples > 0 && !isEmptyReading(live.session.reading);
}

/**
 * Outline, on the spectrogram, each stretch the decoder has named: the wake tone, the
 * resting frame, the tap and the signal after the hit. This is what the reading is made
 * from, drawn where it was heard, so it can be checked by eye.
 * @param {CanvasRenderingContext2D} c the overlay context
 * @param {(hz: number) => number} yOf frequency to overlay y
 * @returns {void}
 */
function drawMarks(c, yOf) {
  scope.marked = hasMarks();
  if (!scope.marked) return;
  const dpr = window.devicePixelRatio || 1;
  const { w, h } = scope;
  const sampleRate = currentSampleRate();
  const xOf = (ms) => {
    const abs = live.originAbs + ((ms - live.originMs) * sampleRate) / 1000;
    return w - 1 - (live.newestAbs - abs) / scope.hopSamples;
  };
  c.lineWidth = Math.max(2, 2 * dpr);
  c.font = `600 ${Math.round(11 * dpr)}px ${palette.fontUi}`;
  c.textBaseline = 'bottom';
  // The held reading says which frame is the resting one, so the outlines agree with the tiles.
  const { reading } = live.session;
  const own = live.events.filter((e) => e.endMs > reading.sinceMs);
  for (const part of labelEvents(own, reading.frames ? reading.frames.symbols : null)) {
    const x0 = xOf(part.startMs);
    const x1 = xOf(part.endMs);
    if (x1 < 0) continue;
    const color = PART_COLORS[part.kind];
    c.strokeStyle = color;
    c.fillStyle = color;
    if (part.loHz === null) {
      c.fillRect(Math.round(x0), 0, Math.max(2, 2 * dpr), h);
      c.fillText(part.label, x0 + 4 * dpr, h - 2 * dpr);
      continue;
    }
    // Never thinner than a few pixels, so a narrow band still shows at full range.
    const yTop = Math.min(yOf(part.hiHz), yOf((part.loHz + part.hiHz) / 2) - 4 * dpr);
    const yBottom = Math.max(yOf(part.loHz), yOf((part.loHz + part.hiHz) / 2) + 4 * dpr);
    c.strokeRect(x0, yTop, Math.max(2, x1 - x0), yBottom - yTop);
    c.fillText(part.label, Math.max(x0, 2 * dpr), yTop - 2 * dpr);
  }
}

/* ------------------------------------------------------------------ */
/* Meters and trigger state                                            */
/* ------------------------------------------------------------------ */

/**
 * @param {number} db
 * @returns {string} the value with one decimal, or a minus infinity sign when silent
 */
function formatDb(db) {
  if (!Number.isFinite(db) || db < -120) return '−∞';
  return db.toFixed(1);
}

/** @returns {void} */
function renderMeters() {
  const m = state.meter;
  const live = state.listening;
  $('peakOut').textContent = live ? `${formatDb(20 * Math.log10(m.peak))} dBFS` : '—';
  $('bandOut').textContent = live ? `${formatDb(m.bandDb)} dB` : '—';
  $('floorOut').textContent = live ? `${formatDb(m.floorDb)} dB` : '—';
  $('clipInd').hidden = !(live && performance.now() < state.clipUntil);
}

/** @returns {void} */
function updateTriggerState() {
  const el = $('trigState');
  let text = 'Idle';
  if (state.listening && state.capturing) text = 'Capturing';
  else if (state.listening && state.trigger.armed) text = 'Armed';
  el.textContent = text;
  el.dataset.state = text.toLowerCase();
}

/**
 * @param {string} message
 * @returns {void}
 */
function setStatus(message) {
  const el = $('status');
  el.textContent = message;
  el.hidden = message === '';
}

/* ------------------------------------------------------------------ */
/* Listening                                                           */
/* ------------------------------------------------------------------ */

/**
 * @param {Error & {name: string}} err
 * @returns {string} plain-words message for a failed start
 */
function startErrorMessage(err) {
  switch (err.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return "Microphone access was blocked. Allow it for this page in the browser's site settings, then start again.";
    case 'NotFoundError':
      return 'No microphone was found. Connect one, or pick another in the list.';
    case 'OverconstrainedError':
      return 'That microphone or sample rate is not available. Pick another and try again.';
    default:
      return `Could not start listening: ${err.message}`;
  }
}

/**
 * @param {boolean|undefined} value
 * @returns {string}
 */
function onOff(value) {
  if (value === true) return 'on';
  if (value === false) return 'off';
  return 'not reported';
}

/**
 * Warnings for processing the browser has left on, or a rate mismatch.
 * @param {MediaTrackSettings} s
 * @returns {string[]}
 */
function inputWarnings(s) {
  const out = [];
  const processing = [
    ['echoCancellation', 'echo cancellation'],
    ['noiseSuppression', 'noise suppression'],
    ['autoGainControl', 'automatic gain control'],
    ['voiceIsolation', 'voice isolation'],
  ];
  for (const [key, label] of processing) {
    if (s[key] === true) out.push(`The browser reports ${label} is still on — captures may be filtered.`);
  }
  if (s.sampleRate && s.sampleRate !== engine.sampleRate) {
    out.push(
      `The microphone runs at ${s.sampleRate} Hz but the audio context at ${engine.sampleRate} Hz, ` +
        'so the browser resamples and the 15–22 kHz band may be altered.',
    );
  }
  return out;
}

/** @returns {void} */
function renderInputReport() {
  const box = $('inputReport');
  box.replaceChildren();
  if (!state.listening) return;
  const s = engine.trackSettings ?? {};
  const rows = [
    ['Context rate', `${engine.sampleRate} Hz`],
    ['Track rate', s.sampleRate ? `${s.sampleRate} Hz` : 'not reported'],
    ['Channels', s.channelCount ? String(s.channelCount) : 'not reported'],
    ['Echo cancellation', onOff(s.echoCancellation)],
    ['Noise suppression', onOff(s.noiseSuppression)],
    ['Auto gain control', onOff(s.autoGainControl)],
    ['Voice isolation', onOff(s.voiceIsolation)],
  ];
  const dl = document.createElement('dl');
  for (const [label, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    dl.append(dt, dd);
  }
  box.append(dl);
  const warnings = inputWarnings(s);
  // The details stay folded away unless there is something wrong to read.
  $('inputDetails').open = warnings.length > 0;
  for (const warning of warnings) {
    const p = document.createElement('p');
    p.className = 'warning';
    p.textContent = warning;
    box.append(p);
  }
}

/** @returns {void} */
function renderListening() {
  const busy = state.listening || state.starting;
  const btn = $('listenBtn');
  btn.textContent = busy ? 'Stop listening' : 'Start listening';
  btn.classList.toggle('listening', state.listening);
  $('spectroEmpty').hidden = state.listening;
  $('device').disabled = busy;
  $('sampleRate').disabled = busy;
  renderInputReport();
  updateTriggerState();
}

/** @returns {Promise<void>} */
async function populateDevices() {
  const select = $('device');
  let inputs = [];
  try {
    inputs = await Engine.listInputs();
  } catch (err) {
    setStatus(`Could not list microphones: ${err.message}`);
  }
  select.replaceChildren(new Option('Default microphone', ''));
  inputs.forEach((input, i) => select.append(new Option(input.label || `Microphone ${i + 1}`, input.deviceId)));
  select.value = [...select.options].some((o) => o.value === deviceChoice) ? deviceChoice : '';
}

/** @returns {Promise<void>} */
async function startListening() {
  state.starting = true;
  setStatus('');
  renderListening();
  try {
    await engine.start({ deviceId: $('device').value, sampleRate: Number($('sampleRate').value) });
    state.listening = true;
    live.newestAbs = 0;
    startLiveDecoder(0);
    // A reading left from before listening stopped is not carried into this run.
    live.session = newSession(live.nowMs, mappingView.club());
    showReading();
    mappingView.setListening(true);
    engine.setTrigger(state.trigger);
    refreshDisplay();
    renderListening();
    await populateDevices();
  } catch (err) {
    if (err.name !== 'AbortError') setStatus(startErrorMessage(err));
  } finally {
    state.starting = false;
    renderListening();
  }
}

/** @returns {Promise<void>} */
async function onListenClick() {
  if (state.listening || state.starting) await engine.stop();
  else await startListening();
}

/* ------------------------------------------------------------------ */
/* Engine events                                                       */
/* ------------------------------------------------------------------ */

/**
 * @param {CustomEvent} event
 * @returns {void}
 */
function onFrame(event) {
  const d = event.detail;
  drawColumn(d.db);
  if (d.absSample > live.newestAbs && live.newestAbs > 0) scope.hopSamples = d.absSample - live.newestAbs;
  const m = state.meter;
  m.peak = d.peak;
  m.bandDb = d.bandDb;
  m.floorDb = d.floorDb;
  live.newestAbs = d.absSample;
  // The marks scroll with the picture, so they are redrawn with every column while shown.
  if (scope.marked || hasMarks()) drawOverlay();
  if (d.peak >= CLIP_LEVEL) state.clipUntil = performance.now() + CLIP_HOLD_MS;
}

/** @returns {void} */
function onTrigger() {
  state.capturing = true;
  updateTriggerState();
  scope.ctx.fillStyle = palette.signal;
  scope.ctx.fillRect(scope.w - 1, 0, 1, TRIGGER_MARK_PX);
}

/**
 * @param {CustomEvent} event
 * @returns {void}
 */
function onCapture(event) {
  const d = event.detail;
  state.capturing = false;
  updateTriggerState();
  const capture = makeCapture({
    samples: d.samples,
    sampleRate: d.sampleRate,
    source: d.source,
    trigger: d.trigger,
    preRollMs: d.preRollMs,
  });
  addCapture(capture);
  selectCapture(capture);
}

/**
 * @param {CustomEvent} event
 * @returns {void}
 */
function onStopped(event) {
  state.listening = false;
  state.capturing = false;
  live.tracker = null;
  // Stopped while a tag was still being identified: what was heard so far is listed and logged.
  const closed = closeSession(live.session);
  if (closed !== live.session) {
    live.session = closed;
    if (mappingView.club() === null && live.pinned === null) logIdentified(closed, mappingView.recordIdentified());
  }
  mappingView.setListening(false);
  state.meter = { peak: 0, bandDb: -Infinity, floorDb: -Infinity };
  renderListening();
  if (event.detail.reason === 'device-ended') {
    setStatus('The microphone stopped or was disconnected, so listening has stopped.');
  }
}

/** @returns {void} */
function wireEngine() {
  engine.addEventListener('frame', onFrame);
  engine.addEventListener('trigger', onTrigger);
  engine.addEventListener('capture', onCapture);
  engine.addEventListener('error', (e) => setStatus(e.detail.message));
  engine.addEventListener('stopped', onStopped);
}

/* ------------------------------------------------------------------ */
/* Captures: model                                                     */
/* ------------------------------------------------------------------ */

/**
 * Build an in-memory capture from fresh audio or an import.
 * @param {{samples: Float32Array, sampleRate: number, source?: string, trigger?: object|null, preRollMs?: number, imported?: boolean}} fields
 * @returns {object} capture (see the shared capture shape)
 */
function makeCapture({ samples, sampleRate, source = 'manual', trigger = null, preRollMs = 0, imported = false }) {
  return {
    id: `local-${state.nextLocalId++}`,
    saved: false,
    sampleRate,
    samples,
    createdAt: new Date().toISOString(),
    clubId: $('club').value || null,
    note: $('note').value,
    source: imported ? 'import' : source,
    trigger,
    preRollMs,
    device: imported ? 'Imported file' : engine.deviceLabel || 'Default microphone',
    inputSettings: imported ? {} : { ...engine.trackSettings, contextSampleRate: engine.sampleRate },
  };
}

/**
 * Turn server metadata plus decoded audio into a capture.
 * @param {object} meta
 * @param {number} sampleRate decoded rate
 * @param {Float32Array} samples decoded audio
 * @returns {object}
 */
function captureFromMeta(meta, sampleRate, samples) {
  return {
    id: meta.id,
    saved: true,
    sampleRate,
    samples,
    createdAt: meta.createdAt ?? meta.savedAt ?? '',
    clubId: meta.clubId ?? null,
    note: meta.note ?? '',
    source: meta.source ?? 'trigger',
    trigger: meta.trigger ?? null,
    preRollMs: meta.preRollMs ?? 0,
    device: meta.device ?? '',
    inputSettings: meta.inputSettings ?? {},
  };
}

/**
 * The fields the server stores: a capture minus samples, saved and id.
 * @param {object} c
 * @returns {object}
 */
function metaOf(c) {
  return {
    sampleRate: c.sampleRate,
    createdAt: c.createdAt,
    clubId: c.clubId,
    note: c.note,
    source: c.source,
    trigger: c.trigger,
    preRollMs: c.preRollMs,
    device: c.device,
    inputSettings: c.inputSettings,
  };
}

/**
 * Insert a capture into the list (newest first) and the table. Saves it if
 * auto-save is on. Selection is the caller's choice.
 * @param {object} capture
 * @returns {void}
 */
function addCapture(capture) {
  const list = state.captures;
  let index = list.findIndex((c) => c.createdAt < capture.createdAt);
  if (index < 0) index = list.length;
  list.splice(index, 0, capture);
  const tbody = $('capRows');
  tbody.insertBefore(buildRow(capture), tbody.rows[index] ?? null);
  markSelected();
  setCapEmpty();
  if (!capture.saved && $('autoSave').checked) saveOne(capture);
}

/**
 * @param {object} capture
 * @returns {void}
 */
function removeCapture(capture) {
  const index = state.captures.indexOf(capture);
  if (index < 0) return;
  state.captures.splice(index, 1);
  $('capRows').rows[index].remove();
  if (state.selected === capture) selectCapture(null);
  setCapEmpty();
}

/**
 * Re-render one capture's row in place.
 * @param {object} capture
 * @returns {void}
 */
function replaceRow(capture) {
  const index = state.captures.indexOf(capture);
  if (index < 0) return;
  $('capRows').rows[index].replaceWith(buildRow(capture));
  markSelected();
}

/** @returns {void} */
function markSelected() {
  [...$('capRows').rows].forEach((tr, i) => {
    tr.classList.toggle('selected', state.captures[i] === state.selected);
  });
}

/** @returns {void} */
function setCapEmpty() {
  $('capEmpty').hidden = state.captures.length > 0;
}

/**
 * @param {object|null} capture
 * @returns {void}
 */
function selectCapture(capture) {
  state.selected = capture;
  markSelected();
  analysisView?.show(capture);
  showDecodedFor(capture);
}

/**
 * @param {string} id
 * @returns {void}
 */
function selectById(id) {
  const capture = state.captures.find((c) => c.id === id);
  if (capture) selectCapture(capture);
}

/* ------------------------------------------------------------------ */
/* Captures: table                                                     */
/* ------------------------------------------------------------------ */

/**
 * @param {string} hex '#RRGGBB'
 * @returns {number[]} [r, g, b]
 */
function hexRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Paint the thumbnail: stft over the trigger band +/- THUMB_PAD_HZ.
 * @param {ImageData} img
 * @param {{frames: number, bins: number, data: Float32Array}} spec
 * @param {{lo: number, hi: number}} band
 * @returns {void}
 */
function paintThumb(img, spec, band) {
  const { floorDb, ceilDb } = state.display;
  const scale = 255 / (ceilDb - floorDb);
  const bandBins = band.hi - band.lo + 1;
  const lut = scope.lut;
  for (let x = 0; x < THUMB_W; x++) {
    const frame = Math.min(spec.frames - 1, Math.floor((x * spec.frames) / THUMB_W));
    const rowStart = frame * spec.bins;
    for (let y = 0; y < THUMB_H; y++) {
      const k = band.lo + Math.min(bandBins - 1, Math.floor(((THUMB_H - 1 - y) * bandBins) / THUMB_H));
      const s = lutIndex(spec.data[rowStart + k], floorDb, scale) * 4;
      const d = (y * THUMB_W + x) * 4;
      img.data[d] = lut[s];
      img.data[d + 1] = lut[s + 1];
      img.data[d + 2] = lut[s + 2];
      img.data[d + 3] = 255;
    }
  }
}

/**
 * @param {object} capture
 * @returns {HTMLCanvasElement}
 */
function renderThumbnail(capture) {
  const canvas = document.createElement('canvas');
  canvas.width = THUMB_W;
  canvas.height = THUMB_H;
  canvas.className = 'thumb';
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(THUMB_W, THUMB_H);
  const [br, bg, bb] = hexRgb(palette.scope);
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = br;
    img.data[i + 1] = bg;
    img.data[i + 2] = bb;
    img.data[i + 3] = 255;
  }
  const sr = capture.sampleRate;
  const band = bandIndices(
    sr,
    THUMB_FFT,
    Math.max(0, state.trigger.loHz - THUMB_PAD_HZ),
    Math.min(sr / 2, state.trigger.hiHz + THUMB_PAD_HZ),
  );
  const spec = stft(capture.samples, THUMB_FFT, THUMB_HOP);
  if (spec.frames > 0) paintThumb(img, spec, band);
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/**
 * @param {object} capture
 * @returns {HTMLCanvasElement} cached thumbnail, computed once per capture
 */
function thumbnailFor(capture) {
  let canvas = thumbs.get(capture);
  if (!canvas) {
    canvas = renderThumbnail(capture);
    thumbs.set(capture, canvas);
  }
  return canvas;
}

/**
 * @param {HTMLSelectElement} select
 * @returns {void}
 */
function fillClubOptions(select) {
  select.replaceChildren(new Option('Unlabelled', ''), ...CLUBS.map((c) => new Option(c.name, c.id)));
}

/**
 * @param {string} text
 * @param {string} className
 * @returns {HTMLSpanElement}
 */
function makeSpan(text, className) {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  return span;
}

/**
 * @param {string} label
 * @param {() => void} onClick
 * @param {string} [variant] extra class, e.g. 'alert'
 * @returns {HTMLButtonElement}
 */
function button(label, onClick, variant = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  if (variant) b.classList.add(variant);
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

/**
 * @param {...(Node|string|Array)} content
 * @returns {HTMLTableCellElement}
 */
function cell(...content) {
  const td = document.createElement('td');
  td.append(...content.flat());
  return td;
}

/**
 * @param {string} iso
 * @returns {string} local time of day, or a dash for an unreadable time
 */
function timeOfDay(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/**
 * @param {object} capture
 * @returns {string}
 */
function peakOverFloor(capture) {
  const t = capture.trigger;
  return t ? `${(t.peakDb - t.floorDb).toFixed(1)} dB` : '—';
}

/**
 * @param {object} capture
 * @returns {Array<Node|string>}
 */
function clubSelectFor(capture) {
  const select = document.createElement('select');
  select.className = 'club-select';
  select.setAttribute('aria-label', 'Club for this capture');
  fillClubOptions(select);
  select.value = capture.clubId ?? '';
  select.addEventListener('change', () => setCaptureClub(capture, select.value || null));
  return [select];
}

/**
 * @param {object} capture
 * @param {string|null} clubId
 * @returns {Promise<void>}
 */
async function setCaptureClub(capture, clubId) {
  capture.clubId = clubId;
  if (!capture.saved) return;
  try {
    await api.patchCapture(capture.id, { clubId });
  } catch (err) {
    setStatus(`Could not update the club on the server: ${err.message}`);
  }
}

/**
 * @param {object} capture
 * @returns {Array<Node|string>}
 */
function savedContent(capture) {
  if (capture.saved) return [makeSpan('Saved', 'ok')];
  if (savingNow.has(capture)) return ['Saving…'];
  const parts = ['Not saved', button('Save', () => saveOne(capture))];
  const error = saveErrors.get(capture);
  if (error) parts.push(makeSpan(error, 'error'));
  return parts;
}

/**
 * @param {object} capture
 * @returns {Array<Node|string>}
 */
function actionButtons(capture) {
  if (state.confirmingDelete === capture) {
    return [
      'Delete? ',
      button('Yes', () => confirmDelete(capture), 'alert'),
      button('No', () => setConfirming(null)),
    ];
  }
  return [
    button('Play', () => startPlayback(() => engine.playSamples(capture.samples, capture.sampleRate, 1))),
    button('Play slowed', () => {
      const rate = Number($('slowSpeed').value);
      startPlayback(() => engine.playSamples(capture.samples, capture.sampleRate, rate));
    }),
    button('Download WAV', () => downloadCapture(capture)),
    button('Delete', () => setConfirming(capture), 'alert'),
  ];
}

/**
 * @param {object} capture
 * @returns {HTMLTableRowElement}
 */
function buildRow(capture) {
  const tr = document.createElement('tr');
  tr.addEventListener('click', () => selectCapture(capture));
  tr.append(
    cell(thumbnailFor(capture)),
    cell(timeOfDay(capture.createdAt)),
    cell(clubSelectFor(capture)),
    cell(SOURCE_LABELS[capture.source] ?? capture.source),
    cell(peakOverFloor(capture)),
    cell(`${(capture.samples.length / capture.sampleRate).toFixed(2)} s`),
    cell(savedContent(capture)),
    cell(actionButtons(capture)),
  );
  return tr;
}

/**
 * @param {object|null} capture the capture awaiting delete confirmation, or null
 * @returns {void}
 */
function setConfirming(capture) {
  const previous = state.confirmingDelete;
  state.confirmingDelete = capture;
  for (const c of new Set([previous, capture])) {
    if (c) replaceRow(c);
  }
}

/**
 * @param {object} capture
 * @returns {Promise<void>}
 */
async function confirmDelete(capture) {
  state.confirmingDelete = null;
  if (capture.saved) {
    try {
      await api.deleteCapture(capture.id);
    } catch (err) {
      setStatus(`Could not delete the capture: ${err.message}`);
      replaceRow(capture);
      return;
    }
  }
  removeCapture(capture);
}

/**
 * Save one capture to the server. Failures are shown on its row.
 * @param {object} capture
 * @returns {Promise<void>}
 */
async function saveOne(capture) {
  if (capture.saved || savingNow.has(capture)) return;
  savingNow.add(capture);
  saveErrors.delete(capture);
  replaceRow(capture);
  try {
    const meta = await api.saveCapture(metaOf(capture), encodeWav(capture.samples, capture.sampleRate));
    capture.id = meta.id;
    capture.saved = true;
  } catch (err) {
    saveErrors.set(capture, `Not saved: ${err.message}`);
  } finally {
    savingNow.delete(capture);
    replaceRow(capture);
  }
}

/**
 * @param {object} capture
 * @returns {void}
 */
function downloadCapture(capture) {
  const blob = new Blob([encodeWav(capture.samples, capture.sampleRate)], { type: 'audio/wav' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `capture-${capture.createdAt.replace(/[:.]/g, '-')}-${capture.clubId ?? 'unlabelled'}.wav`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * @param {() => (() => void)} play starts playback and returns its stop function
 * @returns {void}
 */
function startPlayback(play) {
  stopPlayback();
  try {
    state.playStop = play();
  } catch (err) {
    setStatus(`Playback failed: ${err.message}`);
  }
}

/** @returns {void} */
function stopPlayback() {
  if (state.playStop) {
    state.playStop();
    state.playStop = null;
  }
}

/* ------------------------------------------------------------------ */
/* Captures: loading and importing                                     */
/* ------------------------------------------------------------------ */

/**
 * Run `worker` over `items` with at most `limit` in flight.
 * @template T
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<void>} worker
 * @returns {Promise<void>}
 */
async function runLimited(items, limit, worker) {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await worker(item);
    }
  });
  await Promise.all(lanes);
}

/** @returns {Promise<void>} */
async function loadServerCaptures() {
  let metas;
  try {
    metas = await api.listCaptures();
  } catch (err) {
    setStatus(`The capture server is not reachable (${err.message}). Working with in-memory captures only.`);
    return;
  }
  let failed = 0;
  await runLimited(metas, LOAD_CONCURRENCY, async (meta) => {
    try {
      const decoded = decodeWav(await api.fetchCaptureWav(meta.id));
      addCapture(captureFromMeta(meta, decoded.sampleRate, decoded.samples));
    } catch (err) {
      failed++;
      console.error(`Could not load capture ${meta.id}`, err);
    }
  });
  if (failed > 0) setStatus(`${failed} saved capture${failed === 1 ? '' : 's'} could not be loaded.`);
}

/**
 * @param {File} file
 * @returns {Promise<void>}
 */
async function importWav(file) {
  try {
    const { sampleRate, samples } = decodeWav(await file.arrayBuffer());
    const seconds = samples.length / sampleRate;
    if (seconds > MAX_IMPORT_SECONDS) {
      // Too long to keep as a capture (a phone recording, say), but still worth decoding.
      const events = decodeOrNull(samples, sampleRate);
      mappingView.showDecoded(
        `Decoded signals in ${file.name} (${seconds.toFixed(1)} s)`,
        events,
        events ? `Not added to Captures: only clips up to ${MAX_IMPORT_SECONDS} s are kept.` : LOW_RATE_NOTE,
        () => useAsReading(events, `Imported file ${file.name}`)
      );
      $('mapping').scrollIntoView({ block: 'nearest' });
      return;
    }
    const capture = makeCapture({ samples, sampleRate, imported: true });
    addCapture(capture);
    selectCapture(capture);
  } catch (err) {
    setStatus(`Could not load ${file.name}: ${err.message}`);
  }
}

/**
 * @param {Event} event change event on the file input
 * @returns {Promise<void>}
 */
async function onWavChosen(event) {
  const input = event.currentTarget;
  const file = input.files?.[0];
  input.value = '';
  if (file) await importWav(file);
}

/* ------------------------------------------------------------------ */
/* Analysis modules                                                    */
/* ------------------------------------------------------------------ */

/**
 * @param {HTMLElement} el
 * @param {string} text
 * @returns {void}
 */
function showPlaceholder(el, text) {
  const p = document.createElement('p');
  p.className = 'placeholder';
  p.textContent = text;
  el.replaceChildren(p);
}

/** @returns {Promise<void>} */
async function mountAnalysis() {
  const analysisEl = $('analysis');
  const similarityEl = $('similarity');
  const getBand = () => ({ loHz: state.trigger.loHz, hiHz: state.trigger.hiHz });
  try {
    const mod = await import('./analysis.js');
    analysisView = mod.createAnalysisView(analysisEl, {
      getBand,
      getDisplayRange: () => ({ ...state.display }),
      getMarks: (capture) => labelEvents(decodedEvents(capture) ?? []),
    });
    similarityView = mod.createSimilarityView(similarityEl, {
      getBand,
      clubName,
      onSelect: selectById,
    });
    analysisView.show(state.selected);
  } catch (err) {
    analysisView = null;
    similarityView = null;
    console.error('Analysis module not loaded', err);
    showPlaceholder(analysisEl, 'Analysis module not loaded');
    showPlaceholder(similarityEl, 'Analysis module not loaded');
  }
}

/* ------------------------------------------------------------------ */
/* Club mapping: live decoding and the codebook                        */
/* ------------------------------------------------------------------ */

/**
 * Start a fresh tone tracker for the audio that begins at `fromAbs`.
 * @param {number} fromAbs absolute sample index the tracker will be fed from
 * @returns {void}
 */
function startLiveDecoder(fromAbs) {
  live.fedAbs = fromAbs;
  live.originAbs = fromAbs;
  live.originMs = live.nowMs;
  live.firstWindowMs = null;
  try {
    live.tracker = new ToneTracker(engine.sampleRate);
  } catch (err) {
    live.tracker = null;
    setStatus(`Live decoding is off: ${err.message}.`);
  }
}

/**
 * Feed the tracker the audio that arrived since the last call and refresh the reading.
 * @returns {void}
 */
function feedLiveDecoder() {
  if (!live.tracker || !state.listening) return;
  const length = live.newestAbs - live.fedAbs;
  if (length <= 0) return;
  const chunk = engine.snapshot(live.fedAbs, length);
  if (!chunk) {
    // The page was stalled for longer than the ring holds, so the audio in between is gone.
    startLiveDecoder(live.newestAbs);
    return;
  }
  live.tracker.push(chunk);
  live.fedAbs = live.newestAbs;
  live.tracker.trim(LIVE_WINDOW_SECONDS);
  const track = live.tracker.track();
  live.nowMs = live.originMs + track.startMs + track.hz.length * track.hopMs;
  if (live.firstWindowMs === null) live.firstWindowMs = track.startMs;
  if (live.pinned !== null) return;

  const device = engine.deviceLabel || null;
  const events = classify(track).map((e) => ({
    ...e,
    startMs: e.startMs + live.originMs,
    endMs: e.endMs + live.originMs,
    device,
  }));
  live.events = events;
  const before = live.session;
  const chip = mappingView.club();
  const { session, action } = stepSession(before, {
    events,
    nowMs: live.nowMs,
    clubId: chip,
    codebook: live.codebook,
    autoSave: mappingView.autoSave(),
    windowStartMs: track.startMs > live.firstWindowMs ? live.originMs + track.startMs : -Infinity,
  });
  live.session = session;
  // A new reading starts: the note about the last one no longer describes what is on screen.
  const wasOver = isEmptyReading(before.reading) || before.judgedMs !== null;
  if (wasOver && session.judgedMs === null && !isEmptyReading(session.reading)) mappingView.setMessage('');
  // The reading was recognised as another saved club: it is that club's.
  if (chip !== null && session.clubId !== chip) showClub(session.clubId);
  mappingView.setHits(hitsOf(session).length);
  showReading();
  // While identifying, each transmission is listed and logged once, when the tag has gone quiet.
  if (chip === null && before.judgedMs === null && session.judgedMs !== null) {
    logIdentified(session, mappingView.recordIdentified());
  }
  if (action) performAction(action);
}

/**
 * Send one identified transmission to the server's log, so a run can be checked
 * afterwards without anyone reading the screen. Times are in ms from when the tag began.
 * @param {import('./session.js').Session} session the session just judged
 * @param {string[]|null} heard the saved clubs its frame belongs to; null when no frame was read
 * @returns {Promise<void>}
 */
async function logIdentified(session, heard) {
  const { frames, hitFrames, tone, hop } = session.reading;
  const t0 = session.startedMs;
  const span = (e) => ({ startMs: Math.round(e.startMs - t0), endMs: Math.round(e.endMs - t0) });
  const frame = (f) => f && { symbols: f.symbols, repeats: f.repeats, frames: f.frames, restHz: Math.round(f.restHz), ...span(f) };
  try {
    await api.logIdentification({
      heard,
      hits: hitsOf(session).length,
      taps: session.taps.map((t) => ({ atMs: Math.round(t.startMs - t0), riseDb: Math.round(t.riseDb) })),
      answers: session.answers.map((a) => ({ ...span(a), fromRest: a.fromRest })),
      durationMs: Math.round(session.lastHeardMs - t0),
      frames: frame(frames),
      hitFrames: frame(hitFrames),
      tone: tone && { hz: Math.round(tone.hz), ...span(tone) },
      hop: hop && {
        restHz: Math.round(hop.restHz),
        offsetHz: Math.round(hop.offsetHz),
        periodMs: hop.periodMs,
        hops: hop.hops,
        ...span(hop),
      },
    });
  } catch (err) {
    mappingView.setMessage(`This identification was not logged: ${err.message}`, 'error');
  }
}

/**
 * Carry out what the session decided when the tag went quiet: save the reading, or say why
 * it was not saved. Each reading is decided once, so a save that fails is not tried again.
 * @param {import('./session.js').SessionAction} action
 * @returns {Promise<void>}
 */
async function performAction(action) {
  if (action.type === 'refuse') {
    mappingView.setMessage(REFUSAL_NOTES[action.reason](clubName(action.clubId)), 'error');
    return;
  }
  if (live.saving) {
    mappingView.setMessage('Not saved by itself: another save was still running. Press Save.', 'error');
    return;
  }
  if (await storeReading(action.clubId, action.events)) {
    live.session = settleSave(live.session, action.judgedMs);
    showReading();
  }
}

/** @returns {object} the reading shown: the one taken from a recording, else the live one */
function heldReading() {
  return live.pinned ? live.pinned.reading : live.session.reading;
}

/** @returns {void} */
function showReading() {
  mappingView.setReading(heldReading(), live.pinned ? live.pinned.source : null);
}

/**
 * Show a club as the chosen one and remember it, as when its chip is pressed.
 * @param {string} clubId
 * @returns {void}
 */
function showClub(clubId) {
  mappingView.setClub(clubId);
  rememberClub(clubId);
}

/**
 * @param {string} clubId the club now chosen in the station
 * @returns {void}
 */
function rememberClub(clubId) {
  $('club').value = clubId;
  persistSettings();
}

/**
 * Forget the held reading. Audio already heard stays forgotten: only what begins from now
 * on can start a new reading.
 * @returns {void}
 */
function clearReading() {
  live.pinned = null;
  live.session = newSession(live.nowMs, mappingView.club());
  showReading();
}

/**
 * Make a recording's decoded signals the held reading, so they can be saved to a club.
 * Live audio is not merged into it; Clear or Save returns to live reading.
 * @param {object[]} events
 * @param {string} source where the recording came from
 * @returns {void}
 */
function useAsReading(events, source) {
  const reading = mergeReading(emptyReading(), events.map((e) => ({ ...e, device: source })));
  live.pinned = { source, reading };
  // A frame that exactly one saved club has is that club's reading.
  const known = reading.frames && isSolidFrames(reading.frames) ? matchFrame(live.codebook, reading.frames.symbols) : [];
  if (known.length === 1 && known[0] !== mappingView.club()) showClub(known[0]);
  showReading();
  mappingView.setMessage('');
}

/**
 * Show a freshly loaded or stored codebook, and decide whether saving over it is safe.
 * @param {unknown} raw the document as the server holds it
 * @returns {void}
 * @throws {TypeError} when raw is not a codebook this version understands
 */
function adoptCodebook(raw) {
  live.codebook = normalizeCodebook(raw);
  live.codebookUsable = isLosslessCodebook(raw);
  mappingView.setCodebook(live.codebook);
}

/** @returns {Promise<void>} */
async function loadCodebook() {
  live.codebookUsable = false;
  try {
    adoptCodebook(await api.getCodebook());
    mappingView.setMessage(live.codebookUsable ? '' : CODEBOOK_LOSSY_NOTE, live.codebookUsable ? 'note' : 'error');
  } catch (err) {
    mappingView.setMessage(`Could not load the saved clubs, so saving is off: ${err.message}`, 'error');
  }
}

/**
 * Store a changed codebook on the server and show the stored result. One save runs at a
 * time, and nothing is sent unless the stored codebook was loaded whole: a save built on
 * an empty or partial copy would erase what is on disk.
 * @param {object} next
 * @param {string} doneMessage shown when the save succeeds
 * @returns {Promise<boolean>} true when saved
 */
async function storeCodebook(next, doneMessage) {
  if (live.saving) return false;
  if (!live.codebookUsable) {
    mappingView.setMessage('Not saved: the saved clubs did not load cleanly. Reload the page first.', 'error');
    return false;
  }
  live.saving = true;
  mappingView.setBusy(true);
  try {
    adoptCodebook(await api.putCodebook(next));
    mappingView.setMessage(doneMessage, 'saved');
    return true;
  } catch (err) {
    if (err.status === HTTP_CONFLICT) {
      await loadCodebook();
      if (live.codebookUsable) {
        mappingView.setMessage('Not saved: the saved clubs were changed in another window. They are reloaded; save again.', 'error');
      }
    } else {
      mappingView.setMessage(`Not saved: ${err.message}`, 'error');
    }
    return false;
  } finally {
    live.saving = false;
    mappingView.setBusy(false);
  }
}

/**
 * Store events of a reading as observations of one club.
 * @param {string} clubId
 * @param {import('./session.js').SavedEvent[]} toSave
 * @returns {Promise<boolean>} true when saved
 */
async function storeReading(clubId, toSave) {
  if (toSave.length === 0) return false;
  const at = new Date().toISOString();
  let next = live.codebook;
  for (const { event, role } of toSave) {
    next = addObservation(next, clubId, observationFromEvent(event, { at, device: event.device ?? null, role }));
  }
  const kinds = toSave.map(({ event, role }) => (role === HIT_ROLE ? HIT_FRAME_LABEL : READING_KIND_LABELS[event.type]));
  return storeCodebook(next, `Saved ${kinds.join(', ')} for the ${clubName(clubId)}.`);
}

/**
 * Save the held reading to the club shown, because Save was pressed.
 * @param {string} clubId
 * @returns {Promise<void>}
 */
async function saveReading(clubId) {
  const pinned = live.pinned;
  const { judgedMs } = live.session;
  const entry = live.codebook.clubs[clubId];
  if (!(await storeReading(clubId, eventsToSave(heldReading(), entry ? clubSummary(entry) : null)))) return;
  if (pinned !== null || judgedMs === null) {
    // A recording's reading, or a tag still sending: start again from now.
    if (live.pinned === pinned) clearReading();
    return;
  }
  // The tag had gone quiet: anything that began since, while the save ran, is kept.
  live.session = settleSave(live.session, judgedMs);
  showReading();
}

/**
 * @param {string} clubId
 * @returns {Promise<void>}
 */
async function removeClubReadings(clubId) {
  await storeCodebook(removeClub(live.codebook, clubId), `Removed the ${clubName(clubId)} readings.`);
}

/**
 * @param {Float32Array} samples
 * @param {number} sampleRate
 * @returns {object[]|null} decoded events, or null when the rate cannot hold the tag band
 */
function decodeOrNull(samples, sampleRate) {
  try {
    return decodeTagSignals(samples, sampleRate);
  } catch (err) {
    if (err instanceof RangeError) return null;
    throw err;
  }
}

/**
 * @param {object} capture
 * @returns {object[]|null} the capture's decoded events, decoded once; null when its rate is too low
 */
function decodedEvents(capture) {
  if (!decodedCache.has(capture)) decodedCache.set(capture, decodeOrNull(capture.samples, capture.sampleRate));
  return decodedCache.get(capture);
}

/**
 * Show the decoded timeline of the selected capture.
 * @param {object|null} capture
 * @returns {void}
 */
function showDecodedFor(capture) {
  if (!capture) return;
  const events = decodedEvents(capture);
  mappingView.showDecoded('Decoded signals in the selected capture', events, events ? '' : LOW_RATE_NOTE, () =>
    useAsReading(events, capture.device || 'Recording')
  );
}

/** @returns {Float32Array} a made-up tag: frames, then a tone, then a hop pattern */
function syntheticTag() {
  const sampleRate = SYNTH_TAG.sampleRate;
  const gap = silence(sampleRate, SYNTH_TAG.gapMs);
  return concat(
    gap,
    synthFrames({ sampleRate, ...SYNTH_TAG.frames }),
    gap,
    synthTone({ sampleRate, ...SYNTH_TAG.tone }),
    gap,
    synthHop({ sampleRate, ...SYNTH_TAG.hop }),
    gap
  );
}

/** @returns {void} */
function mountMapping() {
  mappingView = createMappingView(
    { chips: $('clubChips'), layout: $('bench'), station: $('mapping'), side: $('hitSide'), saved: $('mappingSaved') },
    {
      clubs: CLUBS,
      clubName,
      autoSave: readAutoSave(),
      onAutoSaveChange: writeAutoSave,
      onClubChange: rememberClub,
      onIdentify: clearReading,
      onSave: saveReading,
      onClear: clearReading,
      onRemoveClub: removeClubReadings,
    }
  );
  if ($('club').value) mappingView.setClub($('club').value);
}

/** @returns {boolean} whether saving by itself is switched on; on unless switched off before */
function readAutoSave() {
  try {
    return localStorage.getItem(AUTO_SAVE_KEY) !== 'off';
  } catch {
    return true;
  }
}

/**
 * @param {boolean} on
 * @returns {void}
 */
function writeAutoSave(on) {
  try {
    localStorage.setItem(AUTO_SAVE_KEY, on ? 'on' : 'off');
  } catch {
    // Storage unavailable: the choice lasts until the page is reloaded.
  }
}

/* ------------------------------------------------------------------ */
/* Controls                                                            */
/* ------------------------------------------------------------------ */

/**
 * @param {number} loHz
 * @param {number} hiHz
 * @returns {void}
 */
function setDisplayRange(loHz, hiHz) {
  $('dispLo').value = String(Math.round(loHz));
  $('dispHi').value = String(Math.round(hiHz));
  refreshDisplay({ write: true });
  persistSettings();
}

/** @returns {void} */
function zoomToTagBand() {
  const nyq = currentSampleRate() / 2;
  setDisplayRange(Math.max(0, state.trigger.loHz - ZOOM_PAD_HZ), Math.min(nyq, state.trigger.hiHz + ZOOM_PAD_HZ));
}

/** @returns {void} */
function onTriggerEdit() {
  state.trigger = readTrigger();
  engine.setTrigger(state.trigger);
  drawOverlay();
  analysisView?.refresh();
  updateTriggerState();
  persistSettings();
}

/**
 * Space captures the last few seconds, unless focus is in a form control.
 * @param {KeyboardEvent} e
 * @returns {void}
 */
function onKeyDown(e) {
  if (e.code !== 'Space' || e.repeat || e.defaultPrevented) return;
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  const t = e.target;
  if (t instanceof HTMLElement && (['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(t.tagName) || t.isContentEditable)) {
    return;
  }
  e.preventDefault();
  engine.captureLast(CAPTURE_LAST_SECONDS);
}

/** @returns {void} */
function wireControls() {
  $('listenBtn').addEventListener('click', onListenClick);
  $('device').addEventListener('change', () => {
    deviceChoice = $('device').value;
    persistSettings();
  });
  $('sampleRate').addEventListener('change', () => {
    refreshDisplay();
    persistSettings();
  });

  for (const id of DISPLAY_IDS) {
    $(id).addEventListener('input', () => {
      refreshDisplay();
      persistSettings();
    });
    $(id).addEventListener('change', () => {
      refreshDisplay({ write: true });
      persistSettings();
    });
  }
  $('zoomBtn').addEventListener('click', zoomToTagBand);
  $('fullBtn').addEventListener('click', () => setDisplayRange(0, currentSampleRate() / 2));

  for (const id of TRIGGER_IDS) {
    $(id).addEventListener('input', onTriggerEdit);
    $(id).addEventListener('change', onTriggerEdit);
  }

  for (const id of ['club', 'autoSave', 'slowSpeed']) $(id).addEventListener('change', persistSettings);
  $('club').addEventListener('change', () => {
    if ($('club').value) mappingView.setClub($('club').value);
  });
  $('note').addEventListener('input', persistSettings);

  $('captureBtn').addEventListener('click', () => engine.captureLast(CAPTURE_LAST_SECONDS));
  $('captureLongBtn').addEventListener('click', () => engine.captureLast(CAPTURE_LONG_SECONDS));
  $('loadWavBtn').addEventListener('click', () => $('wavFile').click());
  $('wavFile').addEventListener('change', onWavChosen);

  $('sweepBtn').addEventListener('click', () => startPlayback(() => engine.playTestSignal('sweep')));
  $('fskBtn').addEventListener('click', () => startPlayback(() => engine.playTestSignal('fsk')));
  $('synthTagBtn').addEventListener('click', () =>
    startPlayback(() => engine.playSamples(syntheticTag(), SYNTH_TAG.sampleRate, 1))
  );

  $('compareBtn').addEventListener('click', () => similarityView?.render(state.captures));

  document.addEventListener('keydown', onKeyDown);
  window.addEventListener('resize', resizeScope);
  window.addEventListener('pagehide', () => {
    stopPlayback();
    engine.stop();
  });
}

/** @returns {void} */
function init() {
  scope.canvas = $('spectrogram');
  scope.overlay = $('overlay');
  scope.wrap = $('scope');
  scope.ctx = scope.canvas.getContext('2d');
  scope.octx = scope.overlay.getContext('2d');
  palette = readPalette();

  fillClubOptions($('club'));
  applySettings(savedSettings);
  state.display = readDisplay();
  state.trigger = readTrigger();
  engine.setTrigger(state.trigger);

  mountMapping();
  wireEngine();
  wireControls();
  resizeScope();
  renderListening();
  setCapEmpty();
  setInterval(renderMeters, METER_INTERVAL_MS);
  setInterval(feedLiveDecoder, LIVE_DECODE_INTERVAL_MS);

  populateDevices();
  loadServerCaptures();
  loadCodebook();
  mountAnalysis();
}

init();
