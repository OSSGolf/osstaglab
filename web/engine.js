/**
 * engine.js - owns all audio for OSSTagLab: microphone capture, a 30 s ring
 * buffer, live spectrum frames, the band trigger with pre/post-roll capture,
 * and test-signal playback. No DOM access.
 *
 * Events (CustomEvent on the Engine instance):
 *   frame    detail {db, peak, bandDb, floorDb, triggerActive, absSample}
 *            db is a reused buffer; listeners must copy what they keep.
 *            absSample is the absolute index one past the newest sample analysed.
 *   trigger  detail {absSample, bandDb, floorDb}; absSample is the capture centre
 *   capture  detail {samples, sampleRate, source, preRollMs, trigger}
 *   error    detail {message}
 *   stopped  detail {reason: 'user' | 'device-ended'}
 */
import { BandTrigger, SpectrumAnalyzer, bandIndices, bandPowerDb } from './dsp.js';

const FFT_SIZE = 2048;
const HOP = 512;
const RING_SECONDS = 30;
// A freshly opened input delivers digital silence, then a switch-on transient. Frames
// ending inside this window are drawn but kept away from the trigger, so its noise
// floor is learned from real room audio rather than from silence.
const TRIGGER_SETTLE_SECONDS = 1;

const DEFAULT_TRIGGER = Object.freeze({
  loHz: 15000,
  hiHz: 22000,
  thresholdDb: 12,
  preRollMs: 500,
  postRollMs: 1500,
  armed: true,
});

const TEST_AMPLITUDE = 0.1;
const TEST_FADE_SECONDS = 0.005;
const SWEEP_SECONDS = 2;
const SWEEP_FROM_HZ = 14000;
const SWEEP_TO_HZ = 23000;
const FSK_WORD = 0xa5c3f00f;
const FSK_BITS = 32;
const FSK_BIT_SECONDS = 0.005;
const FSK_ZERO_HZ = 18000;
const FSK_ONE_HZ = 19000;

/**
 * Create the input AudioContext at the requested rate, falling back to the
 * browser default when the rate is refused.
 * @param {number} sampleRate
 * @returns {AudioContext}
 */
function createInputContext(sampleRate) {
  try {
    return new AudioContext({ sampleRate, latencyHint: 'interactive' });
  } catch {
    return new AudioContext();
  }
}

/**
 * @returns {Error} the error a cancelled start rejects with
 */
function abortError() {
  return new DOMException('Start was cancelled.', 'AbortError');
}

/**
 * @param {MediaStream|null} stream
 * @returns {void}
 */
function stopStream(stream) {
  if (stream) stream.getTracks().forEach((t) => t.stop());
}

/**
 * Close a context, ignoring the error for one that is already closing.
 * @param {AudioContext} ctx
 * @returns {Promise<void>}
 */
async function closeContext(ctx) {
  if (ctx.state !== 'closed') await ctx.close().catch(() => {});
}

/**
 * Raised-cosine fade gain for sample i of a total-length burst.
 * @param {number} i
 * @param {number} total
 * @param {number} fadeN fade length in samples
 * @returns {number} gain in [0, 1]
 */
function fadeGain(i, total, fadeN) {
  if (i < fadeN) return 0.5 - 0.5 * Math.cos((Math.PI * i) / fadeN);
  const fromEnd = total - 1 - i;
  if (fromEnd < fadeN) return 0.5 - 0.5 * Math.cos((Math.PI * fromEnd) / fadeN);
  return 1;
}

/**
 * Linear sine sweep from SWEEP_FROM_HZ to SWEEP_TO_HZ over SWEEP_SECONDS.
 * @param {number} sr playback sample rate
 * @returns {Float32Array}
 */
function sweepSignal(sr) {
  const total = Math.round(SWEEP_SECONDS * sr);
  const fadeN = Math.round(TEST_FADE_SECONDS * sr);
  const out = new Float32Array(total);
  const span = SWEEP_TO_HZ - SWEEP_FROM_HZ;
  for (let i = 0; i < total; i++) {
    const t = i / sr;
    const phase = 2 * Math.PI * (SWEEP_FROM_HZ * t + (span * t * t) / (2 * SWEEP_SECONDS));
    out[i] = TEST_AMPLITUDE * Math.sin(phase) * fadeGain(i, total, fadeN);
  }
  return out;
}

/**
 * Phase-continuous 2-FSK burst carrying FSK_WORD MSB first, 5 ms per bit.
 * @param {number} sr playback sample rate
 * @returns {Float32Array}
 */
function fskSignal(sr) {
  const samplesPerBit = FSK_BIT_SECONDS * sr;
  const total = Math.round(FSK_BITS * samplesPerBit);
  const fadeN = Math.round(TEST_FADE_SECONDS * sr);
  const out = new Float32Array(total);
  let phase = 0;
  for (let i = 0; i < total; i++) {
    const bitIndex = Math.min(FSK_BITS - 1, Math.floor(i / samplesPerBit));
    const bit = (FSK_WORD >>> (FSK_BITS - 1 - bitIndex)) & 1;
    phase += (2 * Math.PI * (bit ? FSK_ONE_HZ : FSK_ZERO_HZ)) / sr;
    out[i] = TEST_AMPLITUDE * Math.sin(phase) * fadeGain(i, total, fadeN);
  }
  return out;
}

export class Engine extends EventTarget {
  constructor() {
    super();
    /** @type {number} the input context's real sample rate while listening, else 0 */
    this.sampleRate = 0;
    /** @type {MediaTrackSettings|null} settings the browser applied to the track */
    this.trackSettings = null;
    /** @type {string} label of the microphone in use */
    this.deviceLabel = '';

    this._active = false;
    this._session = 0;
    this._ctx = null;
    this._stream = null;
    this._track = null;
    this._source = null;
    this._node = null;
    this._mute = null;
    this._playCtx = null;

    this._ring = null;
    this._written = 0;
    this._nextEnd = FFT_SIZE;

    this._cfg = { ...DEFAULT_TRIGGER };
    this._trigger = new BandTrigger({ thresholdDb: this._cfg.thresholdDb });
    this._pending = null;
    this._bandLo = 0;
    this._bandHi = 0;

    this._analyzer = new SpectrumAnalyzer(FFT_SIZE);
    this._scratch = new Float32Array(FFT_SIZE);
    this._db = new Float32Array(FFT_SIZE / 2 + 1);
    this._frameDetail = { db: this._db, peak: 0, bandDb: 0, floorDb: 0, triggerActive: false, absSample: 0 };
    this._frameEvent = new CustomEvent('frame', { detail: this._frameDetail });

    this._onEnded = () => {
      this._shutdown('device-ended').catch(() => {});
    };
  }

  /**
   * @returns {Promise<{deviceId: string, label: string}[]>} audio input devices;
   *   labels are empty until microphone permission has been granted
   */
  static async listInputs() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === 'audioinput')
      .map((d) => ({ deviceId: d.deviceId, label: d.label }));
  }

  /**
   * Open the microphone with processing off and start analysis.
   * Rejects with an AbortError if stop() is called before it completes.
   * @param {{deviceId?: string, sampleRate?: number}} [options]
   * @returns {Promise<void>}
   */
  async start({ deviceId = '', sampleRate = 48000 } = {}) {
    if (this._active) throw new Error('Already listening.');
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('The microphone is only available from http://127.0.0.1 or localhost.');
    }
    this._active = true;
    const session = ++this._session;
    const current = () => session === this._session;
    try {
      const ctx = createInputContext(sampleRate);
      this._ctx = ctx;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          voiceIsolation: false,
          channelCount: 1,
          sampleRate: { ideal: sampleRate },
        },
      });
      if (!current()) {
        stopStream(stream);
        throw abortError();
      }
      this._stream = stream;
      await ctx.audioWorklet.addModule('capture-worklet.js');
      if (!current()) throw abortError();
      await ctx.resume();
      if (!current()) throw abortError();
      this._buildGraph(ctx, stream);
    } catch (err) {
      // A stop() during start has already torn everything down; report it as a cancel
      // even if the awaited call failed because its context was closed underneath it.
      if (!current()) throw abortError();
      this._active = false;
      await this._teardown();
      throw err;
    }
  }

  /**
   * Stop listening and release the microphone and the input context. Also
   * closes the playback context. Safe to call at any time.
   * @returns {Promise<void>}
   */
  async stop() {
    await this._shutdown('user');
    if (this._playCtx) {
      const playCtx = this._playCtx;
      this._playCtx = null;
      await closeContext(playCtx);
    }
  }

  /**
   * Replace the trigger configuration. A change of band resets the adaptive
   * floor; a change of threshold alone keeps it.
   * @param {Partial<typeof DEFAULT_TRIGGER>} partial
   * @returns {void}
   */
  setTrigger(partial) {
    const prev = this._cfg;
    const next = { ...prev, ...partial };
    this._cfg = next;
    if (next.loHz !== prev.loHz || next.hiHz !== prev.hiHz) {
      this._trigger = new BandTrigger({ thresholdDb: next.thresholdDb });
      if (this.sampleRate) this._rebuildBand();
    } else if (next.thresholdDb !== prev.thresholdDb) {
      this._trigger.thresholdDb = next.thresholdDb;
    }
  }

  /**
   * The newest `length` samples, copied, or null when that range has been
   * overwritten or has not been recorded yet.
   * @param {number} startAbs absolute index of the first sample
   * @param {number} length
   * @returns {Float32Array|null}
   */
  snapshot(startAbs, length) {
    return this._snapshot(startAbs, length);
  }

  /**
   * @param {number} s seconds
   * @returns {Float32Array} the newest s seconds (fewer if less has been recorded)
   */
  lastSeconds(s) {
    if (!this._ring) return new Float32Array(0);
    const n = Math.min(Math.round(s * this.sampleRate), this._ring.length, this._written);
    return this._snapshot(this._written - n, n) ?? new Float32Array(0);
  }

  /**
   * Emit a manual capture of the newest `seconds` of audio.
   * @param {number} [seconds=3]
   * @returns {void}
   */
  captureLast(seconds = 3) {
    const samples = this.lastSeconds(seconds);
    if (samples.length === 0) {
      this._emit('error', { message: 'No audio to capture yet. Start listening first.' });
      return;
    }
    this._emit('capture', { samples, sampleRate: this.sampleRate, source: 'manual', trigger: null, preRollMs: 0 });
  }

  /**
   * Play samples through the speakers, resampled by playbackRate.
   * Works whether or not the microphone is running.
   * @param {Float32Array} samples
   * @param {number} sampleRate rate the samples were recorded at
   * @param {number} [rate=1] playbackRate; 0.125 shifts 18 kHz down to 2.25 kHz
   * @returns {() => void} stops playback
   */
  playSamples(samples, sampleRate, rate = 1) {
    if (samples.length === 0) return () => {};
    const ctx = this._playbackContext();
    const buffer = ctx.createBuffer(1, samples.length, sampleRate);
    buffer.copyToChannel(samples, 0);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    src.connect(ctx.destination);
    src.onended = () => src.disconnect();
    src.start();
    return () => {
      try {
        src.stop();
      } catch {
        // Already ended.
      }
    };
  }

  /**
   * Play a built-in test signal at unity rate.
   * @param {'sweep'|'fsk'} kind
   * @returns {() => void} stops playback
   */
  playTestSignal(kind) {
    if (kind !== 'sweep' && kind !== 'fsk') throw new RangeError(`Unknown test signal "${kind}"`);
    const sr = this._playbackContext().sampleRate;
    const samples = kind === 'sweep' ? sweepSignal(sr) : fskSignal(sr);
    return this.playSamples(samples, sr, 1);
  }

  /**
   * @param {AudioContext} ctx
   * @param {MediaStream} stream
   * @returns {void}
   */
  _buildGraph(ctx, stream) {
    const track = stream.getAudioTracks()[0];
    if (!track) throw new Error('The browser returned no audio track.');
    const source = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'capture', { numberOfInputs: 1, numberOfOutputs: 1 });
    const mute = ctx.createGain();
    mute.gain.value = 0;
    node.port.onmessage = (e) => this._onChunk(e.data);
    source.connect(node);
    node.connect(mute);
    mute.connect(ctx.destination);

    this._source = source;
    this._node = node;
    this._mute = mute;
    this._track = track;
    track.addEventListener('ended', this._onEnded);

    this.sampleRate = ctx.sampleRate;
    this.trackSettings = track.getSettings();
    this.deviceLabel = track.label;
    this._ring = new Float32Array(Math.round(RING_SECONDS * ctx.sampleRate));
    this._resetState();
    this._rebuildBand();
  }

  /**
   * Release every audio resource and clear per-session state. Idempotent.
   * @returns {Promise<void>}
   */
  async _teardown() {
    const { _ctx: ctx, _stream: stream, _track: track, _node: node, _source: source, _mute: mute } = this;
    this._ctx = null;
    this._stream = null;
    this._track = null;
    this._node = null;
    this._source = null;
    this._mute = null;
    if (track) track.removeEventListener('ended', this._onEnded);
    if (node) {
      node.port.onmessage = null;
      node.disconnect();
    }
    if (source) source.disconnect();
    if (mute) mute.disconnect();
    stopStream(stream);
    this._ring = null;
    this.sampleRate = 0;
    this.trackSettings = null;
    this.deviceLabel = '';
    this._resetState();
    if (ctx) await closeContext(ctx);
  }

  /**
   * @param {string} reason
   * @returns {Promise<void>}
   */
  async _shutdown(reason) {
    const wasActive = this._active;
    this._active = false;
    this._session++;
    await this._teardown();
    if (wasActive) this._emit('stopped', { reason });
  }

  /** @returns {void} */
  _resetState() {
    this._written = 0;
    this._nextEnd = FFT_SIZE;
    this._pending = null;
    this._trigger.reset();
  }

  /** @returns {void} */
  _rebuildBand() {
    const { lo, hi } = bandIndices(this.sampleRate, FFT_SIZE, this._cfg.loHz, this._cfg.hiHz);
    this._bandLo = lo;
    this._bandHi = hi;
  }

  /**
   * @param {Float32Array} chunk one worklet block
   * @returns {void}
   */
  _onChunk(chunk) {
    if (!this._active || !this._ring) return;
    this._write(chunk);
    while (this._active && this._nextEnd <= this._written) {
      this._processFrame(this._nextEnd);
      this._nextEnd += HOP;
    }
  }

  /**
   * Append a chunk to the ring. Chunks are 2048 samples, far below the ring size.
   * @param {Float32Array} chunk
   * @returns {void}
   */
  _write(chunk) {
    const ring = this._ring;
    const cap = ring.length;
    const pos = this._written % cap;
    const first = Math.min(chunk.length, cap - pos);
    ring.set(chunk.subarray(0, first), pos);
    if (first < chunk.length) ring.set(chunk.subarray(first), 0);
    this._written += chunk.length;
  }

  /**
   * Copy `len` samples starting at absolute index `startAbs` into `dst[0..len)`,
   * handling wrap-around. The caller guarantees the range is held in the ring.
   * @param {number} startAbs
   * @param {number} len
   * @param {Float32Array} dst
   * @returns {void}
   */
  _copyOut(startAbs, len, dst) {
    const ring = this._ring;
    const cap = ring.length;
    const pos = startAbs % cap;
    const first = Math.min(len, cap - pos);
    dst.set(ring.subarray(pos, pos + first), 0);
    if (first < len) dst.set(ring.subarray(0, len - first), first);
  }

  /**
   * Analyse the FFT_SIZE samples ending at `end`, emit a frame, then drive the trigger.
   * @param {number} end absolute index one past the newest sample of the frame
   * @returns {void}
   */
  _processFrame(end) {
    const scratch = this._scratch;
    this._copyOut(end - FFT_SIZE, FFT_SIZE, scratch);

    let peak = 0;
    for (let i = FFT_SIZE - HOP; i < FFT_SIZE; i++) {
      const a = Math.abs(scratch[i]);
      if (a > peak) peak = a;
    }

    const db = this._analyzer.powerDb(scratch, 0, this._db);
    const bandDb = bandPowerDb(db, this._bandLo, this._bandHi);
    const settled = end >= TRIGGER_SETTLE_SECONDS * this.sampleRate;
    const fired = settled && this._trigger.process(bandDb);
    const floorDb = this._trigger.floorDb;

    const detail = this._frameDetail;
    detail.peak = peak;
    detail.bandDb = bandDb;
    detail.floorDb = floorDb;
    detail.triggerActive = this._trigger.active;
    detail.absSample = end;
    this.dispatchEvent(this._frameEvent);
    if (!this._active) return;

    if (fired && this._cfg.armed && !this._pending) this._beginCapture(end, bandDb, floorDb);
    const pending = this._pending;
    if (pending) {
      if (bandDb > pending.peakDb) pending.peakDb = bandDb;
      if (this._written >= pending.endAbs) this._finishCapture();
    }
  }

  /**
   * @param {number} end frame end index of the firing frame
   * @param {number} bandDb
   * @param {number} floorDb
   * @returns {void}
   */
  _beginCapture(end, bandDb, floorDb) {
    const cfg = this._cfg;
    const sr = this.sampleRate;
    const fireAbs = end - FFT_SIZE / 2;
    const pre = Math.round((cfg.preRollMs * sr) / 1000);
    const post = Math.round((cfg.postRollMs * sr) / 1000);
    this._pending = {
      sampleRate: sr,
      fireAbs,
      pre,
      post,
      endAbs: fireAbs + post,
      peakDb: bandDb,
      floorDb,
      bandLoHz: cfg.loHz,
      bandHiHz: cfg.hiHz,
      thresholdDb: cfg.thresholdDb,
    };
    this._emit('trigger', { absSample: fireAbs, bandDb, floorDb });
  }

  /** @returns {void} */
  _finishCapture() {
    const p = this._pending;
    this._pending = null;
    const start = Math.max(0, p.fireAbs - p.pre);
    const samples = this._snapshot(start, p.fireAbs + p.post - start);
    if (!samples) {
      this._emit('error', { message: 'The trigger capture was overwritten before it could be read.' });
      return;
    }
    this._emit('capture', {
      samples,
      sampleRate: p.sampleRate,
      source: 'trigger',
      preRollMs: ((p.fireAbs - start) / p.sampleRate) * 1000,
      trigger: {
        bandLoHz: p.bandLoHz,
        bandHiHz: p.bandHiHz,
        thresholdDb: p.thresholdDb,
        peakDb: p.peakDb,
        floorDb: p.floorDb,
      },
    });
  }

  /**
   * @param {number} startAbs
   * @param {number} length
   * @returns {Float32Array|null}
   */
  _snapshot(startAbs, length) {
    const ring = this._ring;
    if (!ring || startAbs < 0 || length < 0 || length > ring.length) return null;
    if (startAbs + length > this._written) return null;
    if (startAbs < this._written - ring.length) return null;
    const out = new Float32Array(length);
    this._copyOut(startAbs, length, out);
    return out;
  }

  /** @returns {AudioContext} the playback context, created or resumed on demand */
  _playbackContext() {
    if (!this._playCtx || this._playCtx.state === 'closed') this._playCtx = new AudioContext();
    if (this._playCtx.state === 'suspended') this._playCtx.resume().catch(() => {});
    return this._playCtx;
  }

  /**
   * @param {string} type
   * @param {object} detail
   * @returns {void}
   */
  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
