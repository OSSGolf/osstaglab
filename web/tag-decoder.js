/**
 * tag-decoder.js - turns microphone audio into the three signals a club tag sends.
 * Pure: no DOM, no network. Shared by the app page, the Node tools and the tests.
 *
 * Two stages:
 *   ToneTracker  audio -> one dominant frequency per millisecond (NaN when no tone stands out)
 *   classify     that frequency track -> events
 *
 * A tag sends one tone at a time and holds a "rest" frequency between symbols, so every
 * signal is described by its rest tone and its departures from it:
 *   frames  six ~10 ms symbols on a 100 Hz grid, one per 20.6 ms slot, repeated every ~172 ms
 *   hop     a single ~18 ms jump repeated at a fixed interval
 *   tone    a steady tone with no departures
 */
import { FFT, median } from './dsp.js';

/**
 * Tag timing. The grid, symbol and slot figures are measured; the synthesiser uses the same
 * numbers, so tests exercise real timing.
 */
export const TAG_PROTOCOL = Object.freeze({
  gridHz: 100,
  symbolsPerFrame: 6,
  symbolMs: 10,
  slotMs: 20.6,
  /**
   * The synthesiser's nominal frame period, not a measurement: real tags measured 171.65 ms
   * (putter, 9 iron) and 172.45 to 172.52 ms (sand wedge). The decoder does not use it; it
   * measures each tag's period (see CLASSIFY.fillPeriodMs).
   */
  framePeriodMs: 172.7,
  hopMs: 18,
});

/**
 * Two rest tones within this of each other are one tag's rest tone. A tag's rest tone was
 * measured to wander by under 20 Hz between captures, and a tag that switches signal moves
 * it by about 1 kHz.
 */
export const REST_MATCH_HZ = 50;

/**
 * Two reads that differ in this many symbols are different frames, not misreads of one: the
 * putter's two frames differ in all six, and misreads seen on the bench differ in one or two.
 */
const FRAME_CHANGE_SYMBOLS = 4;

const TRACK = Object.freeze({
  /** One symbol long: grid tones 100 Hz apart are then orthogonal, and noise jitter is lowest. */
  windowMs: 10,
  hopMs: 1,
  /** Zero-padding factor: the FFT is the next power of two at or above this many windows. */
  padFactor: 4,
  /** A tone is searched for here ... */
  bandLoHz: 16500,
  bandHiHz: 21000,
  /** ... and must stand this far above the median level across this wider band. */
  noiseLoHz: 15000,
  noiseHiHz: 22000,
  minSnrDb: 15,
});

/**
 * A tap or strike on the club is a broadband click, far below the tag band. Measured on the
 * bench: 20-33 dB above the room for 10-115 ms, once per tap.
 */
const IMPACT = Object.freeze({
  bandLoHz: 2000,
  bandHiHz: 8000,
  /** Above the median level of the track by this much. */
  riseDb: 15,
  /** Loud stretches closer than this are one impact. */
  mergeMs: 60,
  /** Longer than this is speech or music, not a click. */
  maxMs: 300,
  /** Level reported for digital silence, so levels stay finite. */
  floorDb: -200,
  /**
   * The room's level is the median of the hops that carry any sound at all. With fewer than
   * this share of such hops (a muted or gated input) there is no room level to stand above.
   */
  minAudibleShare: 0.2,
});

const CLASSIFY = Object.freeze({
  /** Silence shorter than this inside a transmission is bridged. */
  bridgeGapMs: 30,
  minBurstMs: 40,
  /** A run of hops within this of the run's mean is one held tone. */
  steadyToleranceHz: 40,
  /** Held this long, a tone is the rest tone: data symbols and hops are all shorter. */
  minRestRunMs: 25,
  /** Rest runs further apart than this belong to different signals. */
  restChangeHz: REST_MATCH_HZ,
  /** A hop counts as away from the rest tone beyond this. */
  departureHz: 50,
  frameMinMs: 95,
  frameMaxMs: 130,
  /** Each symbol is read from this part of its slot, clear of the edges. */
  slotReadFromMs: 3.5,
  slotReadToMs: 7,
  /** A symbol must sit this close to a grid tone, and enough of its slot must be audible. */
  maxGridErrorHz: 35,
  minSlotFill: 0.5,
  /**
   * A frame's first symbol is often weak or cut short, so its first audible departure comes
   * late: measured 4 to 8 ms late on the putter, which puts every symbol outside the part of
   * its slot that is read. The true start is searched for this far around the first departure.
   */
  startSearchEarlyMs: 10,
  startSearchLateMs: 6,
  /** The part of a 10 ms symbol where the track sits on its grid tone, clear of both ramps. */
  symbolCoreFromMs: 1.5,
  symbolCoreToMs: 9,
  /**
   * Frame period assumed until a tag's own has been measured: midway between the tags
   * measured (putter and 9 iron 171.65 ms, sand wedge 172.45 to 172.52 ms).
   */
  fillPeriodMs: 172.2,
  /** Two recognised frames measure the period when they are a whole number of periods apart, within this per period. */
  periodToleranceMs: 2,
  /** Periods that must be spanned by recognised frames before the measured period is used. */
  minPeriodsMeasured: 3,
  /** A predicted frame with fewer symbols heard than this is not counted as a frame. */
  minSymbolsHeard: 3,
  /** A frame read with this many symbols unheard, and the rest matching, still counts as a repeat. */
  maxMissedSymbols: 1,
  blipMinMs: 6,
  blipMaxMs: 32,
  minHopBlips: 3,
  /** A jump at least this long and this far is a real hop, not the sag at the end of a steady tone. */
  realHopMinMs: 12,
  realHopMinHz: 150,
  /** Share of blip intervals that must match the median interval for a hop pattern. */
  hopRegularity: 0.6,
  hopIntervalTolerance: 0.15,
  minToneMs: 120,
  /** A single tone holds still for at least this share of its length. */
  minToneSteadiness: 0.75,
});

/**
 * @typedef {object} ToneTrack
 * @property {Float64Array} hz dominant frequency per hop; NaN where no tone stands out
 * @property {Float64Array} [impactDb] level of the 2-8 kHz impact band per hop
 * @property {number} hopMs time between consecutive entries
 * @property {number} startMs time of entry 0, measured from the first sample ever pushed
 */

/**
 * @typedef {object} FramesEvent
 * @property {'frames'} type
 * @property {number} startMs
 * @property {number} endMs
 * @property {number} restHz
 * @property {number[]} symbols grid steps from the rest tone, one per symbol
 * @property {number} repeats frames that agree with `symbols` (a per-position vote): no symbol
 *   read differently, and at most one not heard
 * @property {number} frames frames seen, including ones that read differently or not at all
 * @property {number|null} periodMs median time between frame starts
 */

/**
 * @typedef {object} HopEvent
 * @property {'hop'} type
 * @property {number} startMs
 * @property {number} endMs
 * @property {number} restHz
 * @property {number} offsetHz size of the jump, signed
 * @property {number} periodMs median time between jumps
 * @property {number} hops jumps seen
 */

/**
 * @typedef {object} ToneEvent
 * @property {'tone'} type
 * @property {number} startMs
 * @property {number} endMs
 * @property {number} hz
 */

/**
 * @typedef {object} ImpactEvent a tap or strike heard as a broadband click; not sent by the tag
 * @property {'impact'} type
 * @property {number} startMs
 * @property {number} endMs
 * @property {number} riseDb peak level above the track's median level in the impact band
 */

/** @typedef {FramesEvent|HopEvent|ToneEvent|ImpactEvent} TagEvent */

/**
 * @param {number} n
 * @returns {number} the smallest power of two >= n
 */
function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/**
 * Streaming dominant-tone tracker. Push audio in any chunk sizes; read the track at any time.
 * Because a tag sends one tone at a time, the peak of a zero-padded spectrum places that
 * tone to within a few hertz even though the window is only one symbol long.
 */
export class ToneTracker {
  /**
   * @param {number} sampleRate Hz; must put the tag band below Nyquist
   * @throws {RangeError} when the sample rate is too low to hold the tag band
   */
  constructor(sampleRate) {
    if (!(sampleRate / 2 > TRACK.bandHiHz)) {
      throw new RangeError(`Sample rate ${sampleRate} Hz cannot represent the ${TRACK.bandHiHz} Hz tag band`);
    }
    /** @type {number} */
    this.sampleRate = sampleRate;
    this._window = Math.round((TRACK.windowMs * sampleRate) / 1000);
    this._hop = Math.round((TRACK.hopMs * sampleRate) / 1000);
    /** @type {number} exact time between track entries */
    this.hopMs = (this._hop / sampleRate) * 1000;

    const size = nextPow2(this._window * TRACK.padFactor);
    this._size = size;
    this._fft = new FFT(size);
    this._re = new Float64Array(size);
    this._im = new Float64Array(size);
    this._taper = new Float64Array(this._window);
    for (let i = 0; i < this._window; i++) {
      this._taper[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / this._window);
    }

    const bin = (hz) => Math.round((hz * size) / sampleRate);
    const top = size / 2 - 1;
    this._bandLo = bin(TRACK.bandLoHz);
    this._bandHi = Math.min(top - 1, bin(TRACK.bandHiHz));
    // The noise band must contain the search band's neighbours: _analyse reads one bin past each edge.
    this._noiseLo = Math.min(bin(TRACK.noiseLoHz), this._bandLo - 1);
    this._noiseHi = Math.min(top, bin(TRACK.noiseHiHz));
    /** Half-width of a Hann main lobe in padded bins, plus a guard bin each side. */
    this._lobe = Math.ceil((2 * size) / this._window) + 2;
    this._power = new Float64Array(size / 2);
    this._noise = new Float64Array(this._noiseHi - this._noiseLo + 1);
    this._minSnr = Math.pow(10, TRACK.minSnrDb / 10);
    this._impactLo = bin(IMPACT.bandLoHz);
    this._impactHi = bin(IMPACT.bandHiHz);

    /** Samples not yet consumed: always shorter than one window after push returns. */
    this._pending = new Float32Array(0);
    /** @type {number[]} */
    this._hz = [];
    /** @type {number[]} level of the impact band, one entry per `_hz` entry */
    this._impactDb = [];
    /** Track entries dropped by trim(); keeps times absolute. */
    this._dropped = 0;
  }

  /**
   * @param {Float32Array|Float64Array} samples the next audio, contiguous with the last push
   * @returns {void}
   */
  push(samples) {
    const joined = new Float32Array(this._pending.length + samples.length);
    joined.set(this._pending, 0);
    joined.set(samples, this._pending.length);
    let at = 0;
    while (at + this._window <= joined.length) {
      this._hz.push(this._analyse(joined, at));
      at += this._hop;
    }
    this._pending = joined.slice(at);
  }

  /**
   * Forget everything older than the newest `seconds`.
   * @param {number} seconds
   * @returns {void}
   */
  trim(seconds) {
    const keep = Math.ceil((seconds * 1000) / this.hopMs);
    const drop = this._hz.length - keep;
    if (drop > 0) {
      this._hz.splice(0, drop);
      this._impactDb.splice(0, drop);
      this._dropped += drop;
    }
  }

  /**
   * @returns {ToneTrack} a copy of the current track
   */
  track() {
    return {
      hz: Float64Array.from(this._hz),
      impactDb: Float64Array.from(this._impactDb),
      hopMs: this.hopMs,
      startMs: this._dropped * this.hopMs + (this._window / 2 / this.sampleRate) * 1000,
    };
  }

  /**
   * @param {Float32Array} x
   * @param {number} at first sample of the window
   * @returns {number} dominant frequency in Hz, or NaN
   */
  _analyse(x, at) {
    const re = this._re;
    const im = this._im;
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < this._window; i++) re[i] = x[at + i] * this._taper[i];
    this._fft.forward(re, im);

    let low = 0;
    for (let k = this._impactLo; k <= this._impactHi; k++) low += re[k] * re[k] + im[k] * im[k];
    this._impactDb.push(low > 0 ? Math.max(IMPACT.floorDb, 10 * Math.log10(low)) : IMPACT.floorDb);

    const power = this._power;
    for (let k = this._noiseLo; k <= this._noiseHi; k++) power[k] = re[k] * re[k] + im[k] * im[k];
    let peak = this._bandLo;
    for (let k = this._bandLo; k <= this._bandHi; k++) if (power[k] > power[peak]) peak = k;
    // A tone just outside the band leaks into it through its skirt and sidelobes. If anything
    // in the surrounding noise band is stronger than the in-band peak, that is what happened.
    for (let k = this._noiseLo; k <= this._noiseHi; k++) {
      if ((k < this._bandLo || k > this._bandHi) && power[k] > power[peak]) return NaN;
    }

    let n = 0;
    for (let k = this._noiseLo; k <= this._noiseHi; k++) {
      if (Math.abs(k - peak) > this._lobe) this._noise[n++] = power[k];
    }
    const floor = median(this._noise.subarray(0, n));
    if (!(power[peak] > floor * this._minSnr) || power[peak] === 0) return NaN;

    // Parabolic interpolation on log power around the peak bin.
    const a = Math.log(power[peak - 1] || Number.MIN_VALUE);
    const b = Math.log(power[peak]);
    const c = Math.log(power[peak + 1] || Number.MIN_VALUE);
    const curve = a - 2 * b + c;
    const shift = curve === 0 ? 0 : Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / curve));
    return ((peak + shift) * this.sampleRate) / this._size;
  }
}

/**
 * Taps and strikes: short stretches where the impact band stands well above its usual level.
 * @param {ToneTrack} track
 * @returns {ImpactEvent[]} in time order; empty for a track without impact levels, or one
 *   that is mostly digital silence
 */
function findImpacts(track) {
  const { impactDb, hopMs, startMs } = track;
  if (!impactDb || impactDb.length === 0) return [];
  // Digital silence sits at the floor; counted in, it would make any sound at all a tap.
  const audible = impactDb.filter((db) => db > IMPACT.floorDb);
  if (audible.length < impactDb.length * IMPACT.minAudibleShare) return [];
  const threshold = median(audible) + IMPACT.riseDb;
  /** @type {{from: number, to: number, peak: number}[]} */
  const loud = [];
  for (let i = 0; i < impactDb.length; i++) {
    if (impactDb[i] < threshold) continue;
    const last = loud[loud.length - 1];
    if (last && (i - last.to) * hopMs <= IMPACT.mergeMs) {
      last.to = i + 1;
      last.peak = Math.max(last.peak, impactDb[i]);
    } else {
      loud.push({ from: i, to: i + 1, peak: impactDb[i] });
    }
  }
  return loud
    .filter((s) => (s.to - s.from) * hopMs <= IMPACT.maxMs)
    .map((s) => ({
      type: 'impact',
      startMs: startMs + s.from * hopMs,
      endMs: startMs + s.to * hopMs,
      riseDb: s.peak - (threshold - IMPACT.riseDb),
    }));
}

/**
 * Stretches of track where a tone is present, bridging short dropouts.
 * @param {ToneTrack} track
 * @returns {{from: number, to: number}[]} hop index ranges, `to` exclusive
 */
function findBursts(track) {
  const { hz, hopMs } = track;
  const bridge = CLASSIFY.bridgeGapMs / hopMs;
  const bursts = [];
  let from = -1;
  let last = -1;
  for (let i = 0; i <= hz.length; i++) {
    const live = i < hz.length && !Number.isNaN(hz[i]);
    if (live) {
      if (from < 0) from = i;
      last = i;
    } else if (from >= 0 && (i === hz.length || i - last > bridge)) {
      if ((last + 1 - from) * hopMs >= CLASSIFY.minBurstMs) bursts.push({ from, to: last + 1 });
      from = -1;
    }
  }
  return bursts;
}

/**
 * Runs inside a burst where the tone holds still long enough to be a rest tone.
 * @param {ToneTrack} track
 * @param {{from: number, to: number}} burst
 * @returns {{from: number, to: number, hz: number}[]} `to` exclusive; hz is the run's median
 */
function findRestRuns(track, burst) {
  const { hz, hopMs } = track;
  const minHops = CLASSIFY.minRestRunMs / hopMs;
  const runs = [];
  let from = -1;
  let sum = 0;
  const close = (to) => {
    if (from >= 0 && to - from >= minHops) runs.push({ from, to, hz: median(hz.subarray(from, to)) });
    from = -1;
  };
  for (let i = burst.from; i < burst.to; i++) {
    const v = hz[i];
    if (Number.isNaN(v)) {
      close(i);
    } else if (from >= 0 && Math.abs(v - sum / (i - from)) <= CLASSIFY.steadyToleranceHz) {
      sum += v;
    } else {
      close(i);
      from = i;
      sum = v;
    }
  }
  close(burst.to);
  return runs;
}

/**
 * Read one frame's symbols by sampling the middle of each slot.
 * @param {ToneTrack} track
 * @param {number} from hop index where the frame starts
 * @param {number} restHz
 * @returns {(number|null)[]} grid steps per symbol; null for a slot where no symbol was heard
 */
function readFrame(track, from, restHz) {
  const { hz, hopMs } = track;
  const symbols = [];
  for (let s = 0; s < TAG_PROTOCOL.symbolsPerFrame; s++) {
    const slotMs = s * TAG_PROTOCOL.slotMs;
    const lo = from + Math.round((slotMs + CLASSIFY.slotReadFromMs) / hopMs);
    const hi = from + Math.round((slotMs + CLASSIFY.slotReadToMs) / hopMs);
    const heard = [];
    for (let i = lo; i < Math.min(hi, hz.length); i++) if (!Number.isNaN(hz[i])) heard.push(hz[i] - restHz);
    const offset = median(heard);
    const step = Math.round(offset / TAG_PROTOCOL.gridHz);
    const readable =
      heard.length >= (hi - lo) * CLASSIFY.minSlotFill &&
      Math.abs(offset - step * TAG_PROTOCOL.gridHz) <= CLASSIFY.maxGridErrorHz;
    // A slot that reads as the rest tone is a symbol that was not heard: symbols are never 0.
    symbols.push(readable && step !== 0 ? step : null);
  }
  return symbols;
}

/**
 * How well a frame starting at `from` lines up with the symbols in the track: for each slot,
 * the number of hops in the symbol's core that sit on one grid tone other than the rest tone.
 * @param {ToneTrack} track
 * @param {number} from hop index where the frame would start
 * @param {number} restHz
 * @returns {number} hops on a symbol, summed over the frame's slots
 */
function symbolOverlap(track, from, restHz) {
  const { hz, hopMs } = track;
  let total = 0;
  for (let s = 0; s < TAG_PROTOCOL.symbolsPerFrame; s++) {
    const slotMs = s * TAG_PROTOCOL.slotMs;
    const lo = from + Math.round((slotMs + CLASSIFY.symbolCoreFromMs) / hopMs);
    const hi = from + Math.round((slotMs + CLASSIFY.symbolCoreToMs) / hopMs);
    /** @type {Map<number, number>} */
    const onStep = new Map();
    let most = 0;
    for (let i = Math.max(lo, 0); i < Math.min(hi, hz.length); i++) {
      const offset = hz[i] - restHz;
      const step = Math.round(offset / TAG_PROTOCOL.gridHz);
      // NaN (no tone) fails this comparison, as it should.
      if (step === 0 || !(Math.abs(offset - step * TAG_PROTOCOL.gridHz) <= CLASSIFY.maxGridErrorHz)) continue;
      const count = (onStep.get(step) ?? 0) + 1;
      onStep.set(step, count);
      if (count > most) most = count;
    }
    total += most;
  }
  return total;
}

/**
 * Read one frame whose start is only roughly known: slide the start around `near` to where
 * the six slots best cover the symbols in the track, then read the symbols there.
 * @param {ToneTrack} track
 * @param {number} near hop index of the frame's first audible departure, or its predicted start
 * @param {number} restHz
 * @returns {{at: number, symbols: (number|null)[]}} the start used and the symbols read from it
 */
function readFrameNear(track, near, restHz) {
  const early = Math.round(CLASSIFY.startSearchEarlyMs / track.hopMs);
  const late = Math.round(CLASSIFY.startSearchLateMs / track.hopMs);
  let at = near;
  let best = symbolOverlap(track, near, restHz);
  // Nearest first, so that equal overlaps leave the start where it was found.
  for (let shift = 1; shift <= Math.max(early, late); shift++) {
    for (const candidate of [near - shift, near + shift]) {
      if (candidate < 0 || candidate < near - early || candidate > near + late) continue;
      const overlap = symbolOverlap(track, candidate, restHz);
      if (overlap > best) {
        best = overlap;
        at = candidate;
      }
    }
  }
  return { at, symbols: readFrame(track, at, restHz) };
}

/**
 * The frame period of the tag being heard, measured from its recognised frames. Tags differ:
 * the nominal period is off by up to half a millisecond a frame, which adds up over a gap.
 * @param {{at: number}[][]} sections recognised frames in time order, grouped so that no tap
 *   falls inside a group (frame timing restarts at a tap)
 * @param {number} hopMs
 * @returns {number} the period in hops; the nominal one when too few frames were recognised
 */
function measurePeriod(sections, hopMs) {
  const nominal = CLASSIFY.fillPeriodMs / hopMs;
  let hops = 0;
  let periods = 0;
  for (const found of sections) {
    for (let i = 1; i < found.length; i++) {
      const gap = found[i].at - found[i - 1].at;
      const count = Math.round(gap / nominal);
      if (count >= 1 && Math.abs(gap / count - nominal) <= CLASSIFY.periodToleranceMs / hopMs) {
        hops += gap;
        periods += count;
      }
    }
  }
  return periods >= CLASSIFY.minPeriodsMeasured ? hops / periods : nominal;
}

/**
 * Frames repeat on a fixed period, but a weak first or last symbol makes some too short to
 * be recognised on their own. Read those too, at the places the recognised frames predict.
 * A tap restarts the tag's frame timing, so frames are only predicted from recognised frames
 * on the same side of every tap.
 * @param {ToneTrack} track
 * @param {{at: number, symbols: (number|null)[]}[]} found frames recognised on their own, in time order
 * @param {number} from hop index where the stretch starts
 * @param {number} to hop index where it ends (exclusive)
 * @param {number} restHz
 * @param {number[]} tapsAt hop indices of the taps heard
 * @returns {{at: number, symbols: (number|null)[]}[]} `found` plus the frames between and around them, in time order
 */
function fillFrames(track, found, from, to, restHz, tapsAt) {
  const { hopMs } = track;
  const frameHops = ((TAG_PROTOCOL.symbolsPerFrame - 1) * TAG_PROTOCOL.slotMs + TAG_PROTOCOL.symbolMs) / hopMs;
  const edges = [from, ...tapsAt.filter((t) => t > from && t < to).sort((x, y) => x - y), to];
  const sections = edges.slice(1).map((edge, k) => found.filter((f) => f.at >= edges[k] && f.at < edge));
  const period = measurePeriod(sections, hopMs);
  const all = [...found];
  sections.forEach((anchors, k) => {
    if (anchors.length === 0) return;
    // Each gap is filled from the recognised frame nearest to it, so clock drift stays small.
    const expected = new Set();
    for (const anchor of anchors) {
      for (let at = anchor.at - period; at >= edges[k]; at -= period) expected.add(Math.round(at));
      for (let at = anchor.at + period; at < edges[k + 1] && at + frameHops <= to; at += period) expected.add(Math.round(at));
    }
    const nearest = (at) => anchors.reduce((best, f) => (Math.abs(f.at - at) < Math.abs(best.at - at) ? f : best));
    for (const at of [...expected].sort((x, y) => x - y)) {
      const anchor = nearest(at);
      const steps = Math.round((at - anchor.at) / period);
      if (steps === 0 || Math.round(anchor.at + steps * period) !== at) continue;
      if (all.some((f) => Math.abs(f.at - at) < period / 2)) continue;
      const frame = readFrameNear(track, at, restHz);
      const heard = frame.symbols.filter((step) => step !== null).length;
      if (heard >= CLASSIFY.minSymbolsHeard) all.push(frame);
    }
  });
  return all.sort((x, y) => x.at - y.at);
}

/**
 * @param {(number|null)[][]} reads one entry per frame seen
 * @returns {(number|null)[]} the most common reading of each symbol position; null where no
 *   read has one
 */
function consensus(reads) {
  const symbols = [];
  for (let s = 0; s < TAG_PROTOCOL.symbolsPerFrame; s++) {
    const votes = new Map();
    for (const read of reads) {
      if (read[s] !== null) votes.set(read[s], (votes.get(read[s]) ?? 0) + 1);
    }
    const winner = [...votes.entries()].sort((x, y) => y[1] - x[1])[0];
    symbols.push(winner ? winner[0] : null);
  }
  return symbols;
}

/**
 * Combine repeated reads of one frame by voting on each symbol position separately, so a
 * frame with one bad symbol still supports the other five.
 * @param {(number|null)[][]} reads one entry per frame seen
 * @returns {{symbols: number[], repeats: number}|null} null unless every position has a
 *   winner: a position where no frame heard a symbol means this is not a frame.
 */
function voteFrames(reads) {
  const symbols = consensus(reads);
  if (symbols.some((step) => step === null)) return null;
  // A read agrees when nothing it heard contradicts the vote and it missed at most one symbol.
  const repeats = reads.filter(
    (read) =>
      read.every((step, s) => step === null || step === symbols[s]) &&
      read.filter((step) => step === null).length <= CLASSIFY.maxMissedSymbols
  ).length;
  return { symbols: /** @type {number[]} */ (symbols), repeats };
}

/**
 * @param {(number|null)[]} a one frame's symbols; null where none was heard
 * @param {(number|null)[]} b
 * @returns {boolean} true when the two readings cannot be the same frame
 */
export function isOtherFrame(a, b) {
  const differing = a.filter((step, s) => step !== null && b[s] !== null && step !== b[s]).length;
  return differing >= FRAME_CHANGE_SYMBOLS;
}

/**
 * A tag can change the frame it sends without pausing. Split the frames of one stretch into
 * consecutive runs that each carry one frame, so two frames are never voted into a blend.
 * A tap is where a tag changes its frame, so the frames before and after one are compared as
 * separate groups: noisy reads just after the tap are then not outvoted by the frames before.
 * @template {{at: number, symbols: (number|null)[]}} F
 * @param {F[]} frames in time order
 * @param {number[]} tapsAt hop indices of the taps heard
 * @returns {F[][]} one or more runs, in time order
 */
function splitByContent(frames, tapsAt) {
  const read = (run) => consensus(run.map((f) => f.symbols));
  /** @type {F[][]} */
  const runs = [];
  for (const frame of frames) {
    const run = runs[runs.length - 1];
    const tapped = run && tapsAt.some((t) => t > run[run.length - 1].at && t <= frame.at);
    if (run && !tapped && !isOtherFrame(frame.symbols, read(run))) run.push(frame);
    else runs.push([frame]);
  }
  // One odd read is a misread, not a change of frame: fold it into the run before it, then
  // rejoin runs that the misread had separated.
  /** @type {F[][]} */
  const merged = [];
  for (const run of runs) {
    const last = merged[merged.length - 1];
    if (last && (run.length < 2 || last.length < 2 || !isOtherFrame(read(run), read(last)))) last.push(...run);
    else merged.push(run);
  }
  return merged;
}

/**
 * @param {number[]} starts event start times in ms, ascending
 * @returns {number|null} median interval, or null with fewer than two starts
 */
function medianInterval(starts) {
  if (starts.length < 2) return null;
  return median(starts.slice(1).map((t, i) => t - starts[i]));
}

/**
 * Classify one stretch that shares a rest tone.
 * @param {ToneTrack} track
 * @param {{from: number, to: number, hz: number}[]} runs the stretch's rest runs, in order
 * @param {number} start hop index where the stretch starts; before the first rest run when
 *   the tag was already sending as the stretch began
 * @param {number} end hop index where the stretch ends (exclusive)
 * @param {ImpactEvent[]} impacts taps heard anywhere in the track
 * @returns {TagEvent[]}
 */
function classifySegment(track, runs, start, end, impacts) {
  const { hz, hopMs, startMs } = track;
  const restHz = median(runs.map((r) => r.hz));
  const time = (hop) => startMs + hop * hopMs;
  const segStart = runs[0].from;

  /** @type {{at: number, symbols: (number|null)[]}[]} */
  const frames = [];
  /** @type {{at: number, ms: number, offsetHz: number}[]} */
  const blips = [];
  // Departures live in the gaps between rest runs: before the first, between each pair, after the last.
  for (let r = -1; r < runs.length; r++) {
    const gapFrom = r < 0 ? start : runs[r].to;
    const gapTo = r + 1 < runs.length ? runs[r + 1].from : end;
    let first = -1;
    let last = -1;
    const offsets = [];
    for (let i = gapFrom; i < gapTo; i++) {
      const off = hz[i] - restHz;
      if (Math.abs(off) > CLASSIFY.departureHz) {
        if (first < 0) first = i;
        last = i;
        offsets.push(off);
      }
    }
    if (first < 0) continue;
    const lengthMs = (last + 1 - first) * hopMs;
    if (lengthMs >= CLASSIFY.frameMinMs && lengthMs <= CLASSIFY.frameMaxMs) {
      frames.push(readFrameNear(track, first, restHz));
    } else if (lengthMs >= CLASSIFY.blipMinMs && lengthMs <= CLASSIFY.blipMaxMs) {
      blips.push({ at: first, ms: lengthMs, offsetHz: median(offsets) });
    }
  }

  const tapsAt = impacts.map((i) => (i.startMs - startMs) / hopMs);
  if (frames.length > 0) frames.splice(0, frames.length, ...fillFrames(track, frames, start, end, restHz, tapsAt));

  /** @type {TagEvent[]} */
  const events = [];
  const firstHeard = Math.min(segStart, ...frames.map((f) => f.at), ...blips.map((b) => b.at));
  const span = { startMs: time(firstHeard), endMs: time(end) };

  const frameRuns = frames.length > 0 ? splitByContent(frames, tapsAt) : [];
  frameRuns.forEach((run, k) => {
    const vote = voteFrames(run.map((f) => f.symbols));
    // A run in which no frame agrees with the vote is noise read at a frame's place.
    if (!vote || vote.repeats === 0) return;
    events.push({
      type: 'frames',
      // Each run lasts until the next one's first frame.
      startMs: k === 0 ? span.startMs : time(run[0].at),
      endMs: k + 1 < frameRuns.length ? time(frameRuns[k + 1][0].at) : span.endMs,
      restHz,
      symbols: vote.symbols,
      repeats: vote.repeats,
      frames: run.length,
      periodMs: medianInterval(run.map((f) => time(f.at))),
    });
  });

  if (blips.length >= CLASSIFY.minHopBlips) {
    const starts = blips.map((b) => time(b.at));
    const period = medianInterval(starts);
    const intervals = starts.slice(1).map((t, i) => t - starts[i]);
    const regular = intervals.filter((d) => Math.abs(d - period) <= period * CLASSIFY.hopIntervalTolerance);
    if (regular.length >= intervals.length * CLASSIFY.hopRegularity) {
      events.push({
        type: 'hop',
        ...span,
        restHz,
        offsetHz: median(blips.map((b) => b.offsetHz)),
        periodMs: period,
        hops: blips.length,
      });
    }
  }

  // One or two real hops are the opening of a hop pattern, not a tone with glitches.
  const hasRealHop = blips.some(
    (b) => b.ms >= CLASSIFY.realHopMinMs && Math.abs(b.offsetHz) >= CLASSIFY.realHopMinHz
  );
  if (events.length === 0 && !hasRealHop) {
    // Measured between the first and last held stretch, so a fading tail does not count against it.
    const toneEnd = runs[runs.length - 1].to;
    const steadyHops = runs.reduce((n, r) => n + (r.to - r.from), 0);
    const longEnough = (toneEnd - segStart) * hopMs >= CLASSIFY.minToneMs;
    if (longEnough && steadyHops >= (toneEnd - segStart) * CLASSIFY.minToneSteadiness) {
      events.push({ type: 'tone', startMs: time(segStart), endMs: time(toneEnd), hz: restHz });
    }
  }
  return events;
}

/**
 * Find every tag signal in a tone track.
 * @param {ToneTrack} track
 * @returns {TagEvent[]} in time order
 */
export function classify(track) {
  /** @type {TagEvent[]} */
  const events = [];
  const impacts = findImpacts(track);
  for (const burst of findBursts(track)) {
    const runs = findRestRuns(track, burst);
    let from = 0;
    let start = burst.from;
    for (let i = 1; i <= runs.length; i++) {
      // A stretch ends where the rest tone moves: the tag has switched to another signal.
      const moved = i < runs.length && Math.abs(runs[i].hz - runs[from].hz) > CLASSIFY.restChangeHz;
      if (i === runs.length || moved) {
        const end = i < runs.length ? runs[i].from : burst.to;
        events.push(...classifySegment(track, runs.slice(from, i), start, end, impacts));
        from = i;
        start = end;
      }
    }
  }
  events.push(...impacts);
  return events.sort((a, b) => a.startMs - b.startMs);
}

/**
 * Decode a whole recording in one call.
 * @param {Float32Array|Float64Array} samples
 * @param {number} sampleRate
 * @returns {TagEvent[]}
 */
export function decodeTagSignals(samples, sampleRate) {
  const tracker = new ToneTracker(sampleRate);
  tracker.push(samples);
  return classify(tracker.track());
}

/**
 * @param {number[]} symbols
 * @returns {string} for example "+4 −1 −2 +1 −4 −3"
 */
export function formatSymbols(symbols) {
  return symbols.map((s) => (s > 0 ? `+${s}` : s < 0 ? `−${-s}` : '0')).join(' ');
}

/**
 * @param {number} hz
 * @returns {string} for example "18.800 kHz"
 */
export function formatKHz(hz) {
  return `${(hz / 1000).toFixed(3)} kHz`;
}

/**
 * One-line description of an event, without its time.
 * @param {TagEvent} event
 * @returns {string}
 */
export function describeEvent(event) {
  switch (event.type) {
    case 'frames':
      return `Data frames ${formatSymbols(event.symbols)}, rest ${formatKHz(event.restHz)}, ${event.repeats} of ${event.frames} frames agree`;
    case 'hop': {
      const sign = event.offsetHz >= 0 ? '+' : '−';
      return `Hop pattern, rest ${formatKHz(event.restHz)}, jumps ${sign}${Math.abs(event.offsetHz).toFixed(0)} Hz every ${event.periodMs.toFixed(1)} ms, ${event.hops} jumps`;
    }
    case 'impact':
      return `Tap or strike, ${event.riseDb.toFixed(0)} dB above the room`;
    case 'tone':
      return `Single tone ${formatKHz(event.hz)} for ${(event.endMs - event.startMs).toFixed(0)} ms`;
    default:
      throw new RangeError(`Unknown tag event type "${event.type}"`);
  }
}
