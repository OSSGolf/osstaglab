/**
 * codebook.js - what each club's tag was observed to send.
 * Pure: every function returns a new object and never mutates its input. A codebook is plain
 * JSON, so it can be stored and reloaded; untrusted input goes through normalizeCodebook.
 *
 * Observations are ordered by recency: `at` decides, and array position breaks ties.
 */
import { median } from './dsp.js';
import { TAG_PROTOCOL } from './tag-decoder.js';

export const CODEBOOK_VERSION = 1;
export const MAX_OBSERVATIONS_PER_KIND = 20;

const DEFAULT_TONE_TOLERANCE_HZ = 25;
/** A frames event is solid when it repeated this often and at least this share of its frames agree. */
const SOLID_MIN_REPEATS = 3;
const SOLID_MIN_SHARE = 0.5;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}/;
/** Marks a frames observation as the frame a tag changes to when it is hit. */
export const HIT_ROLE = 'hit';

/**
 * @typedef {object} FramesObservation
 * @property {'frames'} kind
 * @property {string} at ISO date
 * @property {string|null} device
 * @property {number[]} symbols six non-zero integers
 * @property {number} restHz
 * @property {number} repeats
 * @property {number} frames
 * @property {'hit'} [role] present only on a hit frame; a resting frame has none
 */

/**
 * @typedef {object} ToneObservation
 * @property {'tone'} kind
 * @property {string} at
 * @property {string|null} device
 * @property {number} hz
 */

/**
 * @typedef {object} HopObservation
 * @property {'hop'} kind
 * @property {string} at
 * @property {string|null} device
 * @property {number} restHz
 * @property {number} offsetHz
 * @property {number} periodMs
 * @property {number} hops
 */

/** @typedef {FramesObservation|ToneObservation|HopObservation} Observation */

/**
 * @typedef {object} Codebook
 * @property {number} version
 * @property {number} revision save counter set by the server; a save built from a stale revision is refused
 * @property {Object<string, {observations: Observation[]}>} clubs
 */

/**
 * @typedef {object} FrameSummary
 * @property {number[]} symbols the most frequently observed symbol sequence
 * @property {number} restHz median rest tone of the observations with those symbols
 * @property {number} observations how many frames observations have those symbols
 * @property {boolean} consistent true when every frames observation has those symbols
 */

/**
 * @typedef {object} ClubSummary
 * @property {FrameSummary|null} frame the frame the tag repeats while it rests in the light
 * @property {FrameSummary|null} hitFrame the frame it changes to when hit; only the putter tag has shown one
 * @property {number|null} toneHz
 * @property {{restHz: number, offsetHz: number, periodMs: number}|null} hop
 */

/**
 * @param {unknown} v
 * @returns {boolean} true for a plain (non-array) object
 */
function isRecord(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * @param {unknown} v
 * @returns {boolean} true for a finite number
 */
function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * @param {unknown} v
 * @returns {boolean} true for an integer of zero or more
 */
function isCount(v) {
  return Number.isInteger(v) && v >= 0;
}

/**
 * @param {unknown} v
 * @returns {boolean} true for a string that starts with an ISO date and parses as a date
 */
function isIsoDate(v) {
  return typeof v === 'string' && ISO_DATE_PATTERN.test(v) && !Number.isNaN(Date.parse(v));
}

/**
 * @param {unknown} v
 * @returns {boolean} true for an array of exactly one frame's symbols, each a non-zero integer
 */
function isSymbolList(v) {
  return (
    Array.isArray(v) &&
    v.length === TAG_PROTOCOL.symbolsPerFrame &&
    v.every((s) => Number.isInteger(s) && s !== 0)
  );
}

/**
 * @param {Observation[]} observations
 * @returns {Observation[]} a new array, oldest first
 */
function sortByRecency(observations) {
  return observations
    .map((obs, index) => ({ obs, index, time: Date.parse(obs.at) }))
    .sort((a, b) => a.time - b.time || a.index - b.index)
    .map((entry) => entry.obs);
}

/**
 * Keep only the newest MAX_OBSERVATIONS_PER_KIND observations of each kind.
 * @param {Observation[]} observations
 * @returns {Observation[]} the kept observations, oldest first
 */
function capObservations(observations) {
  const sorted = sortByRecency(observations);
  const keptPerKind = new Map();
  const kept = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const kind = sorted[i].kind;
    const n = keptPerKind.get(kind) ?? 0;
    if (n < MAX_OBSERVATIONS_PER_KIND) {
      kept.push(sorted[i]);
      keptPerKind.set(kind, n + 1);
    }
  }
  return kept.reverse();
}

/**
 * Validate one observation of any kind and copy it into a clean shape.
 * @param {unknown} raw
 * @returns {Observation|null} the clean observation, or null when it is malformed
 */
function cleanObservation(raw) {
  if (!isRecord(raw) || !isIsoDate(raw.at)) return null;
  const at = raw.at;
  const device = typeof raw.device === 'string' ? raw.device : null;
  switch (raw.kind) {
    case 'frames':
      if (
        !isSymbolList(raw.symbols) ||
        !(isFiniteNumber(raw.restHz) && raw.restHz > 0) ||
        !isCount(raw.repeats) ||
        !isCount(raw.frames) ||
        raw.repeats > raw.frames ||
        !(raw.role === undefined || raw.role === HIT_ROLE)
      ) {
        return null;
      }
      return {
        kind: 'frames',
        at,
        device,
        symbols: [...raw.symbols],
        restHz: raw.restHz,
        repeats: raw.repeats,
        frames: raw.frames,
        ...(raw.role === HIT_ROLE ? { role: HIT_ROLE } : {}),
      };
    case 'tone':
      if (!(isFiniteNumber(raw.hz) && raw.hz > 0)) return null;
      return { kind: 'tone', at, device, hz: raw.hz };
    case 'hop':
      if (
        !(isFiniteNumber(raw.restHz) && raw.restHz > 0) ||
        !isFiniteNumber(raw.offsetHz) ||
        !(isFiniteNumber(raw.periodMs) && raw.periodMs > 0) ||
        !(Number.isInteger(raw.hops) && raw.hops >= 1)
      ) {
        return null;
      }
      return {
        kind: 'hop',
        at,
        device,
        restHz: raw.restHz,
        offsetHz: raw.offsetHz,
        periodMs: raw.periodMs,
        hops: raw.hops,
      };
    default:
      return null;
  }
}

/**
 * @param {unknown} codebook
 * @returns {void}
 * @throws {TypeError} when the value does not have the codebook shape
 */
function assertCodebook(codebook) {
  if (!isRecord(codebook) || !isRecord(codebook.clubs)) {
    throw new TypeError('expected a codebook object with a clubs map');
  }
}

/**
 * Summarise every club, in club id order.
 * @param {Codebook} codebook
 * @returns {{clubId: string, summary: ClubSummary}[]}
 */
function summarizeAll(codebook) {
  return Object.keys(codebook.clubs)
    .sort()
    .map((clubId) => ({ clubId, summary: clubSummary(codebook.clubs[clubId]) }));
}

/**
 * @returns {Codebook} an empty codebook
 */
export function emptyCodebook() {
  return { version: CODEBOOK_VERSION, revision: 0, clubs: {} };
}

/**
 * Turn untrusted parsed JSON into a clean codebook. Malformed clubs are dropped; malformed
 * observations are dropped; each kind is capped at MAX_OBSERVATIONS_PER_KIND, newest kept.
 * @param {unknown} raw
 * @returns {Codebook}
 * @throws {TypeError} when raw is not an object or its version is not CODEBOOK_VERSION
 */
export function normalizeCodebook(raw) {
  if (!isRecord(raw)) throw new TypeError('codebook must be an object');
  if (raw.version !== CODEBOOK_VERSION) {
    throw new TypeError(`unsupported codebook version ${raw.version}; expected ${CODEBOOK_VERSION}`);
  }
  const entries = [];
  if (isRecord(raw.clubs)) {
    for (const [clubId, entry] of Object.entries(raw.clubs)) {
      if (clubId.length === 0 || !isRecord(entry) || !Array.isArray(entry.observations)) continue;
      const observations = entry.observations.map(cleanObservation).filter((obs) => obs !== null);
      entries.push([clubId, { observations: capObservations(observations) }]);
    }
  }
  const revision = Number.isInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0;
  return { version: CODEBOOK_VERSION, revision, clubs: Object.fromEntries(entries) };
}

/**
 * @param {unknown} value parsed JSON
 * @returns {string} JSON with object keys in sorted order, so equal data gives equal text
 */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Whether normalizeCodebook keeps everything in a stored document. When it does not, the
 * file holds entries this code does not understand, and saving a normalised copy back
 * would delete them.
 * @param {unknown} raw parsed JSON as stored
 * @returns {boolean} false when normalising would drop or change anything other than
 *   filling in a missing revision; false too when raw is not a codebook at all
 */
export function isLosslessCodebook(raw) {
  if (!isRecord(raw)) return false;
  let clean;
  try {
    clean = normalizeCodebook(raw);
  } catch {
    return false;
  }
  return canonicalJson({ revision: 0, ...raw }) === canonicalJson(clean);
}

/**
 * Convert a decoder event into an observation.
 * @param {import('./tag-decoder.js').TagEvent} event
 * @param {{at: string, device?: string|null, role?: 'hit'}} options at is the ISO date of the
 *   observation; role 'hit' marks a frames event as the frame the tag sends after a hit
 * @returns {Observation}
 * @throws {RangeError} on an unknown event type, or an event or date that is malformed
 */
export function observationFromEvent(event, { at, device = null, role } = {}) {
  const type = isRecord(event) ? event.type : undefined;
  let raw;
  switch (type) {
    case 'frames':
      raw = {
        kind: 'frames',
        at,
        device,
        symbols: event.symbols,
        restHz: event.restHz,
        repeats: event.repeats,
        frames: event.frames,
        role,
      };
      break;
    case 'hop':
      raw = {
        kind: 'hop',
        at,
        device,
        restHz: event.restHz,
        offsetHz: event.offsetHz,
        periodMs: event.periodMs,
        hops: event.hops,
      };
      break;
    case 'tone':
      raw = { kind: 'tone', at, device, hz: event.hz };
      break;
    default:
      throw new RangeError(`Unknown tag event type "${type}"`);
  }
  const observation = cleanObservation(raw);
  if (!observation) throw new RangeError(`Malformed ${type} event or observation date "${at}"`);
  return observation;
}

/**
 * Append an observation to a club, keeping the newest MAX_OBSERVATIONS_PER_KIND of each kind.
 * @param {Codebook} codebook
 * @param {string} clubId
 * @param {Observation} observation
 * @returns {Codebook} a new codebook
 * @throws {TypeError} on a bad codebook or club id
 * @throws {RangeError} when the observation is malformed
 */
export function addObservation(codebook, clubId, observation) {
  assertCodebook(codebook);
  if (typeof clubId !== 'string' || clubId.length === 0) {
    throw new TypeError('clubId must be a non-empty string');
  }
  const clean = cleanObservation(observation);
  if (!clean) throw new RangeError('malformed observation');
  const existing = Object.hasOwn(codebook.clubs, clubId) ? codebook.clubs[clubId].observations : [];
  return {
    version: CODEBOOK_VERSION,
    revision: codebook.revision ?? 0,
    clubs: {
      ...codebook.clubs,
      [clubId]: { observations: capObservations([...existing, clean]) },
    },
  };
}

/**
 * @param {Codebook} codebook
 * @param {string} clubId
 * @returns {Codebook} a new codebook without that club (unchanged copy if it is absent)
 * @throws {TypeError} on a bad codebook
 */
export function removeClub(codebook, clubId) {
  assertCodebook(codebook);
  const kept = Object.entries(codebook.clubs).filter(([id]) => id !== clubId);
  return { version: CODEBOOK_VERSION, revision: codebook.revision ?? 0, clubs: Object.fromEntries(kept) };
}

/**
 * @param {FramesObservation[]} frames oldest first
 * @returns {FrameSummary|null} the most frequent symbol sequence, or null without frames
 */
function summarizeFrames(frames) {
  if (frames.length === 0) return null;
  // Group by symbols. Frames are oldest first, so the last index marks the most recent sighting.
  const groups = new Map();
  frames.forEach((f, index) => {
    const key = f.symbols.join(',');
    const group = groups.get(key) ?? { symbols: f.symbols, rests: [], lastIndex: -1 };
    group.rests.push(f.restHz);
    group.lastIndex = index;
    groups.set(key, group);
  });
  const [winner] = [...groups.values()].sort((a, b) => b.rests.length - a.rests.length || b.lastIndex - a.lastIndex);
  return {
    symbols: [...winner.symbols],
    restHz: median(winner.rests),
    observations: winner.rests.length,
    consistent: winner.rests.length === frames.length,
  };
}

/**
 * @param {ClubSummary} summary
 * @returns {FrameSummary[]} the club's resting frame and hit frame, whichever are known
 */
function knownFrames(summary) {
  return [summary.frame, summary.hitFrame].filter((f) => f !== null);
}

/**
 * Which of a club's saved frames a symbol sequence is, so a frame already known is saved
 * under the same role however the reading that carried it began.
 * @param {ClubSummary} summary
 * @param {number[]} symbols
 * @returns {'resting'|'hit'|null} null when it is neither saved frame
 */
export function savedFrameRole(summary, symbols) {
  const key = symbols.join(',');
  if (summary.frame && summary.frame.symbols.join(',') === key) return 'resting';
  if (summary.hitFrame && summary.hitFrame.symbols.join(',') === key) return HIT_ROLE;
  return null;
}

/**
 * Reduce one club's observations to what the app shows for it.
 * @param {{observations: Observation[]}} entry
 * @returns {ClubSummary}
 * @throws {TypeError} when entry has no observations array
 */
export function clubSummary(entry) {
  if (!isRecord(entry) || !Array.isArray(entry.observations)) {
    throw new TypeError('club entry must have an observations array');
  }
  const observations = sortByRecency(entry.observations);
  const frames = observations.filter((o) => o.kind === 'frames');
  const tones = observations.filter((o) => o.kind === 'tone');
  const hops = observations.filter((o) => o.kind === 'hop');

  let hop = null;
  if (hops.length > 0) {
    hop = {
      restHz: median(hops.map((h) => h.restHz)),
      offsetHz: median(hops.map((h) => h.offsetHz)),
      periodMs: median(hops.map((h) => h.periodMs)),
    };
  }

  return {
    frame: summarizeFrames(frames.filter((f) => f.role !== HIT_ROLE)),
    hitFrame: summarizeFrames(frames.filter((f) => f.role === HIT_ROLE)),
    toneHz: tones.length > 0 ? median(tones.map((t) => t.hz)) : null,
    hop,
  };
}

/**
 * Clubs whose resting frame or hit frame has exactly these symbols. The rest tone is not a
 * key: two clubs were measured with the same rest tone and different symbols.
 * @param {Codebook} codebook
 * @param {number[]} symbols
 * @returns {string[]} matching club ids, sorted
 * @throws {TypeError} when symbols is not an array
 */
export function matchFrame(codebook, symbols) {
  assertCodebook(codebook);
  if (!Array.isArray(symbols)) throw new TypeError('symbols must be an array');
  const key = symbols.join(',');
  return summarizeAll(codebook)
    .filter(({ summary }) => knownFrames(summary).some((f) => f.symbols.join(',') === key))
    .map(({ clubId }) => clubId);
}

/**
 * Clubs whose summary tone is within tolerance of hz (inclusive), nearest first.
 * @param {Codebook} codebook
 * @param {number} hz
 * @param {number} [toleranceHz=25]
 * @returns {string[]} matching club ids, nearest first; ties sorted by id
 * @throws {TypeError} when hz or the tolerance is not a finite number
 */
export function matchTone(codebook, hz, toleranceHz = DEFAULT_TONE_TOLERANCE_HZ) {
  assertCodebook(codebook);
  if (!isFiniteNumber(hz)) throw new TypeError('hz must be a finite number');
  if (!(isFiniteNumber(toleranceHz) && toleranceHz >= 0)) {
    throw new TypeError('toleranceHz must be a non-negative number');
  }
  return summarizeAll(codebook)
    .filter(({ summary }) => summary.toneHz !== null && Math.abs(summary.toneHz - hz) <= toleranceHz)
    .map(({ clubId, summary }) => ({ clubId, distance: Math.abs(summary.toneHz - hz) }))
    .sort((a, b) => a.distance - b.distance || (a.clubId < b.clubId ? -1 : a.clubId > b.clubId ? 1 : 0))
    .map((entry) => entry.clubId);
}

/**
 * Symbol sequences that are a resting frame or hit frame of two or more clubs.
 * @param {Codebook} codebook
 * @returns {{symbols: number[], clubIds: string[]}[]} one entry per collision, clubIds sorted
 */
export function collisions(codebook) {
  assertCodebook(codebook);
  /** @type {Map<string, {symbols: number[], clubIds: string[]}>} */
  const byKey = new Map();
  for (const { clubId, summary } of summarizeAll(codebook)) {
    for (const frame of knownFrames(summary)) {
      const key = frame.symbols.join(',');
      const group = byKey.get(key) ?? { symbols: [...frame.symbols], clubIds: [] };
      if (!group.clubIds.includes(clubId)) group.clubIds.push(clubId);
      byKey.set(key, group);
    }
  }
  return [...byKey.entries()]
    .filter(([, group]) => group.clubIds.length >= 2)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, group]) => group);
}

/**
 * Whether a frames event is good enough to save: it repeated at least SOLID_MIN_REPEATS times
 * and at least half of the frames seen agree with it.
 * @param {{repeats: number, frames: number}} event a frames event from the decoder
 * @returns {boolean}
 */
export function isSolidFrames(event) {
  return event.repeats >= SOLID_MIN_REPEATS && event.repeats >= event.frames * SOLID_MIN_SHARE;
}
