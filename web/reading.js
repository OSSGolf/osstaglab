/**
 * reading.js - what the app currently believes the tag in front of it is sending.
 * Pure: no DOM, no network.
 *
 * The live decoder re-reads a sliding window several times a second, so one transmission
 * arrives over and over: first partial, then complete, then shrinking as it slides out of
 * the window. A reading keeps the best view of each signal and holds it after the tag goes
 * quiet, so there is time to choose a club and save it.
 *
 * All event times must share one clock that never goes backwards.
 */
import { isSolidFrames } from './codebook.js';
import { REST_MATCH_HZ, isOtherFrame } from './tag-decoder.js';

/**
 * @typedef {import('./tag-decoder.js').FramesEvent} FramesEvent
 * @typedef {import('./tag-decoder.js').ToneEvent} ToneEvent
 * @typedef {import('./tag-decoder.js').HopEvent} HopEvent
 * @typedef {import('./tag-decoder.js').ImpactEvent} ImpactEvent
 * @typedef {import('./tag-decoder.js').TagEvent} TagEvent
 */

/**
 * @typedef {object} Reading
 * @property {FramesEvent|null} frames the frame that identifies the tag
 * @property {FramesEvent|null} hitFrames the frame the same tag changed to without a pause
 * @property {ToneEvent|null} tone
 * @property {HopEvent|null} hop
 * @property {ImpactEvent|null} impact the tap or strike heard just before the tag's hit signal
 * @property {number} sinceMs events that ended at or before this time are not this tag's
 */

/**
 * A tone that ended this long before a frame began can still belong to the same tag: a tap
 * on a covered tag sounds the tone, and frames follow once it is lit. A hop pattern gets no
 * such allowance: it is a tag's answer to a hit, so it never comes before that tag's frame.
 */
export const ATTACH_BEFORE_MS = 1500;

/**
 * A tag that changes its frame carries on, on the same rest tone, after a dropout of up to
 * about 0.3 s. A different tag cannot follow this closely: it sounds its wake tone and its
 * frames start about 0.9 s after that tone began.
 */
const SAME_TAG_GAP_MS = 600;
/**
 * The tag answers a tap with its hit signal: a hop pattern within about 10 ms, or on the
 * putter a second frame 0.06 to 1.1 s later. Frame starts are only known to about a frame.
 */
const HIT_AFTER_TAP_MS = 1500;
const TAP_SLACK_MS = 200;
/**
 * A tag's resting frame begins about 0.9 s after its wake tone begins (measured 0.87 to
 * 1.07 s on putter, sand wedge and 9 iron); frame starts are only known to about a frame.
 */
const WAKE_TO_FRAMES_MIN_MS = 700;
const WAKE_TO_FRAMES_MAX_MS = 1200;
/** A frame returning within this long of its last read is the same transmission carrying on. */
const RESUME_GAP_MS = 3000;
/**
 * Two decodes of one transmission begin within this of each other: a frame start is only
 * known to about half a frame, and a view cut by the sliding window begins later by one
 * decode interval (250 ms) or more.
 */
const SAME_START_MS = 100;
/**
 * A resting frame saves by itself only when at least this many frames agree. In live decodes
 * of recorded tags the wrong frames that read "solid" while a transmission was still
 * arriving had 3 of 3, 3 of 4, 4 of 5 and 3 of 6 frames agreeing (a putter
 * recording, last symbol read as -1 for +1): never more than 4. A tag lit for the
 * 2 to 3 s the app asks for sends 11 to 17 frames.
 */
export const AUTO_SAVE_MIN_REPEATS = 5;

/** How far before the hop pattern's own start its opening, mistaken for a tone, can begin. */
const HOP_LEAD_MS = 100;

/**
 * @param {number} [sinceMs] ignore everything that ended at or before this time
 * @returns {Reading}
 */
export function emptyReading(sinceMs = -Infinity) {
  return { frames: null, hitFrames: null, tone: null, hop: null, impact: null, sinceMs };
}

/**
 * @param {Reading} reading
 * @returns {boolean} true when nothing has been heard
 */
export function isEmptyReading(reading) {
  return !reading.frames && !reading.tone && !reading.hop;
}

/**
 * @param {number[]} a
 * @param {number[]} b
 * @returns {boolean}
 */
export function sameSymbols(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Choose between the held event and newly decoded ones of the same kind. An event that
 * starts after the held one ended is a new event and replaces it. Anything else is another
 * decode of the held event, and the fuller one is kept, so a transmission sliding out of
 * the window does not shrink what was read.
 * @template {TagEvent} T
 * @param {T|null} held
 * @param {T[]} candidates
 * @param {(event: T) => number} fullness
 * @returns {T|null}
 */
function pickFullest(held, candidates, fullness) {
  let best = held;
  for (const c of [...candidates].sort((a, b) => a.startMs - b.startMs)) {
    if (!best || c.startMs >= best.endMs || fullness(c) > fullness(best)) best = c;
  }
  return best;
}

/**
 * @param {FramesEvent} held
 * @param {FramesEvent} next
 * @returns {boolean} true when `next` is the held tag carrying on with another frame
 */
function continuesTag(held, next) {
  return (
    next.startMs >= held.startMs &&
    next.startMs <= held.endMs + SAME_TAG_GAP_MS &&
    sameRest(held, next)
  );
}

/**
 * @param {ImpactEvent[]} impacts
 * @param {number} startMs when a signal began
 * @returns {ImpactEvent[]} the taps that signal can be the answer to: heard shortly before it began
 */
function tapsJustBefore(impacts, startMs) {
  return impacts.filter((i) => i.startMs <= startMs + TAP_SLACK_MS && i.startMs >= startMs - HIT_AFTER_TAP_MS);
}

/**
 * @param {ImpactEvent[]} impacts
 * @param {FramesEvent} before
 * @param {FramesEvent} after
 * @returns {boolean} true when a tap was heard after `before` began and shortly before `after`
 *   began: a tap long before `after` did not set it off
 */
function tapBetween(impacts, before, after) {
  return tapsJustBefore(impacts, after.startMs).some((i) => i.startMs > before.startMs);
}

/**
 * @param {ToneEvent[]} tones
 * @param {number} fromMs
 * @param {number} toMs
 * @returns {boolean} true when a tone began after `fromMs` and before `toMs`
 */
function toneStartedBetween(tones, fromMs, toMs) {
  return tones.some((t) => t.startMs > fromMs && t.startMs < toMs);
}

/**
 * @param {ToneEvent[]} tones
 * @param {FramesEvent} frames
 * @returns {boolean} true when the frame began where a resting frame does: about 0.9 s
 *   after a wake tone began
 */
function followsWakeTone(tones, frames) {
  return tones.some(
    (t) => frames.startMs - t.startMs >= WAKE_TO_FRAMES_MIN_MS && frames.startMs - t.startMs <= WAKE_TO_FRAMES_MAX_MS
  );
}

/**
 * @param {FramesEvent} first the frame heard first
 * @param {ImpactEvent[]} impacts
 * @param {ToneEvent[]} tones
 * @returns {boolean} true when `first` itself began as the answer to a tap: a tap shortly
 *   before it, with no wake tone in between (a tap on a covered tag sounds the wake tone, and
 *   the frame that follows that is the resting one)
 */
function beganAfterTap(first, impacts, tones) {
  return tapsJustBefore(impacts, first.startMs).some((i) => !toneStartedBetween(tones, i.startMs, first.startMs));
}

/**
 * @param {FramesEvent} a
 * @param {FramesEvent} b
 * @returns {boolean} true when the two frames are on one rest tone, as one tag's frames are
 */
function sameRest(a, b) {
  return Math.abs(a.restHz - b.restHz) <= REST_MATCH_HZ;
}

/**
 * @param {FramesEvent} held
 * @param {FramesEvent} next
 * @returns {boolean} true when `next` is a newer decode of the transmission `held` was read
 *   from, covering all of it: it begins where `held` did and ends no earlier. A view cut by
 *   the sliding window begins later and is not one.
 */
function regrows(held, next) {
  return (
    next.startMs <= held.startMs + SAME_START_MS &&
    next.endMs >= held.endMs &&
    sameRest(held, next) &&
    !isOtherFrame(held.symbols, next.symbols)
  );
}

/**
 * @param {{repeats: number, frames: number}} frames a frames event
 * @returns {boolean} true when the frame was read well enough to be saved without anyone
 *   checking it: solid, and agreed on by at least AUTO_SAVE_MIN_REPEATS frames
 */
export function isFirmFrames(frames) {
  return isSolidFrames(frames) && frames.repeats >= AUTO_SAVE_MIN_REPEATS;
}

/**
 * Choose which frames events to hold: the one that identifies the tag, and the frame that
 * tag changed to, if it did. The first frame heard is taken as the identifying one, which is
 * the order a tag sends them in after waking, unless a tap shows that it is the hit frame.
 * @param {FramesEvent|null} heldFrames
 * @param {FramesEvent|null} heldHit
 * @param {FramesEvent[]} candidates
 * @param {ImpactEvent[]} impacts taps heard in the same window
 * @param {ToneEvent[]} tones tones heard in the same window
 * @returns {{frames: FramesEvent|null, hitFrames: FramesEvent|null}}
 */
function pickFrames(heldFrames, heldHit, candidates, impacts, tones) {
  let best = heldFrames;
  let hit = heldHit;
  for (const c of [...candidates].sort((a, b) => a.startMs - b.startMs)) {
    if (!best) {
      best = c;
      continue;
    }
    if (hit && sameSymbols(c.symbols, hit.symbols)) {
      if (c.repeats > hit.repeats) {
        // A hit frame read in pieces (a stretch between them unreadable) is one signal: it
        // began where its first piece began, which is what times it against the tap.
        const resumed = c.startMs > hit.startMs && c.startMs - hit.endMs <= RESUME_GAP_MS;
        hit = resumed ? { ...c, startMs: hit.startMs } : c;
      }
      continue;
    }
    if (regrows(best, c)) {
      // The longer decode of the same transmission replaces the shorter one, even when it
      // reads less firmly or differs by a misread: an early read that looked solid must not
      // outlive the evidence against it.
      best = c;
      continue;
    }
    if (sameSymbols(c.symbols, best.symbols)) {
      const firmer = isSolidFrames(c) && !isSolidFrames(best);
      if (firmer || (isSolidFrames(c) === isSolidFrames(best) && c.repeats > best.repeats)) {
        // The same frame heard again soon after (it returns after a hit frame) is one
        // transmission: it began when the first read of it began.
        const resumed = c.startMs > best.startMs && c.startMs - best.endMs <= RESUME_GAP_MS;
        best = resumed ? { ...c, startMs: best.startMs } : c;
      } else if (c.endMs > best.endMs && c.startMs <= best.endMs + RESUME_GAP_MS) {
        // A view that reads no better still shows the frame carrying on: a tag lit for longer
        // than the window holds must not look as if it stopped where its best read ended.
        best = { ...best, endMs: c.endMs };
      }
      continue;
    }
    // One tag's two frames share a rest tone, and no wake tone sounds between them: a tone
    // there is another tag waking, even on the same rest tone (putter and 9 iron share one).
    const [earlier, later] = c.startMs < best.startMs ? [c, best] : [best, c];
    const oneTag = sameRest(best, c) && !toneStartedBetween(tones, earlier.startMs, later.startMs);
    const changed = oneTag && (continuesTag(earlier, later) || tapBetween(impacts, earlier, later));
    const eitherSolid = isSolidFrames(c) || isSolidFrames(best);
    if (changed && later === best && isSolidFrames(c) && isSolidFrames(best) && tapBetween(impacts, c, best)) {
      // The held frame began after a tap and this one before it: the held one is the hit frame.
      hit = best;
      best = c;
    } else if (changed && later === c && isSolidFrames(c) && (isSolidFrames(best) || isOtherFrame(best.symbols, c.symbols))) {
      if (!tapBetween(impacts, best, c) && beganAfterTap(best, impacts, tones)) {
        // The held frame was itself set off by a tap, and this one followed with no tap:
        // the held one is the hit frame and this is the resting frame returning.
        hit = best;
        best = c;
      } else {
        // The tag changed its frame. The earlier frame stays the identifying one even when it
        // was heard too briefly to be solid: a hit frame must never be saved as the resting one.
        hit = c;
      }
    } else if (changed && later === c && !eitherSolid && isOtherFrame(best.symbols, c.symbols)) {
      // Two brief reads, the second where the tag changes its frame: the first is still the
      // resting one. Replacing it here would let the hit frame firm up as the identifying one.
      hit = c;
    } else if (isSolidFrames(c) !== isSolidFrames(best)) {
      // A solid read is never displaced by a weak one.
      if (isSolidFrames(c)) {
        best = c;
        hit = null;
      }
    } else if (c.startMs >= best.startMs) {
      // Different symbols on equal footing: the later transmission is the tag in front now.
      best = c;
      hit = null;
    }
  }
  return { frames: best, hitFrames: hit };
}

/**
 * @param {ToneEvent|null} tone
 * @param {HopEvent|null} hop
 * @returns {boolean} true when the tone is really the opening of the hop pattern
 */
function isHopOpening(tone, hop) {
  return Boolean(
    tone &&
      hop &&
      Math.abs(tone.hz - hop.restHz) <= REST_MATCH_HZ &&
      tone.startMs >= hop.startMs - HOP_LEAD_MS &&
      tone.startMs < hop.endMs
  );
}

/** How far a frame's symbols reach from its rest tone, and the margin drawn around a signal. */
const FRAME_REACH_HZ = 400;
const PART_MARGIN_HZ = 120;

/**
 * @typedef {object} ReadingPart one stretch of the held reading, in time and frequency
 * @property {'wake'|'resting'|'tap'|'hit'} kind
 * @property {string} label
 * @property {number} startMs
 * @property {number} endMs
 * @property {number|null} loHz null for a tap, which has no frequency of its own
 * @property {number|null} hiHz
 */

const PART_LABELS = Object.freeze({ wake: 'Wake tone', resting: 'Resting frame', tap: 'Tap', hit: 'After a hit' });

/**
 * One event as a stretch to draw: its label and the band of frequencies it occupies.
 * @param {TagEvent} event
 * @param {'wake'|'resting'|'tap'|'hit'} kind what the event is in the sequence a tag sends
 * @returns {ReadingPart}
 */
function partOf(event, kind) {
  let edges = null;
  if (event.type === 'tone') edges = [event.hz, event.hz];
  else if (event.type === 'frames') edges = [event.restHz - FRAME_REACH_HZ, event.restHz + FRAME_REACH_HZ];
  else if (event.type === 'hop') edges = [event.restHz, event.restHz + event.offsetHz];
  return {
    kind,
    label: PART_LABELS[kind],
    startMs: event.startMs,
    endMs: event.endMs,
    loHz: edges ? Math.min(...edges) - PART_MARGIN_HZ : null,
    hiHz: edges ? Math.max(...edges) + PART_MARGIN_HZ : null,
  };
}

/**
 * The held reading laid out as the sequence a tag sends: wake tone, resting frame, the tap,
 * and the signal after the hit.
 * @param {Reading} reading
 * @returns {ReadingPart[]} in time order
 */
export function readingParts(reading) {
  const { frames, hitFrames, tone, hop, impact } = reading;
  const hit = hitFrames ?? hop;
  /** @type {ReadingPart[]} */
  const parts = [];
  if (tone) parts.push(partOf(tone, 'wake'));
  if (frames) {
    // The resting frame can return after the hit; this part ends where the hit signal begins.
    const endMs = hit && hit.startMs > frames.startMs ? Math.min(frames.endMs, hit.startMs) : frames.endMs;
    parts.push({ ...partOf(frames, 'resting'), endMs });
  }
  if (impact) parts.push(partOf(impact, 'tap'));
  if (hit) parts.push(partOf(hit, 'hit'));
  return parts.sort((a, b) => a.startMs - b.startMs);
}

/** Outline colour of each kind of stretch on the dark spectrograms; style.css uses the same for the sequence bar. */
export const PART_COLORS = Object.freeze({ wake: '#6EE06E', resting: '#6C9BFF', tap: '#FF5FD2', hit: '#FFE14A' });

/** Stretches of one kind closer together than this are drawn as one. */
const PART_JOIN_MS = 600;

/**
 * Name every decoded stretch of a recording or of the live window by its place in the
 * sequence a tag sends, so the segmentation can be drawn and checked by eye. A frame that is
 * the resting frame, or a misread of it, is named resting wherever it appears, so the resting
 * frame is named again when it returns; any other frame is the hit frame.
 *
 * Which frame is the resting one is taken from `restingSymbols` when given: the live page
 * passes the held reading's, so the outlines always agree with the tiles. For a recording it
 * is worked out here: the frame that follows the wake tone; failing that, the last one a tap
 * ends; failing that, the first frame heard that is also read solidly somewhere.
 * @param {TagEvent[]} events
 * @param {number[]|null} [restingSymbols] symbols of the frame already known to be the resting one
 * @returns {ReadingPart[]} in time order
 */
export function labelEvents(events, restingSymbols = null) {
  const sorted = [...events].sort((a, b) => a.startMs - b.startMs);
  const framesEvents = /** @type {FramesEvent[]} */ (sorted.filter((e) => e.type === 'frames'));
  const tones = /** @type {ToneEvent[]} */ (sorted.filter((e) => e.type === 'tone'));
  const impacts = /** @type {ImpactEvent[]} */ (sorted.filter((e) => e.type === 'impact'));
  // A brief first read counts when the same frame is read solidly anywhere in the events.
  const solid = framesEvents.filter(isSolidFrames);
  const changesAtTap = (f) =>
    framesEvents.some((g) => !sameSymbols(f.symbols, g.symbols) && sameRest(f, g) && tapBetween(impacts, f, g));
  const found =
    framesEvents.find((f) => followsWakeTone(tones, f)) ??
    framesEvents.findLast(changesAtTap) ??
    framesEvents.find((f) => solid.some((g) => sameSymbols(f.symbols, g.symbols))) ??
    framesEvents[0] ??
    null;
  const resting = restingSymbols ?? (found ? found.symbols : null);
  const kindOf = (e) => {
    if (e.type === 'tone') return 'wake';
    if (e.type === 'impact') return 'tap';
    if (e.type === 'hop') return 'hit';
    return resting && !isOtherFrame(e.symbols, resting) ? 'resting' : 'hit';
  };
  /** @type {ReadingPart[]} */
  const parts = [];
  for (const e of sorted) {
    const part = partOf(e, kindOf(e));
    const last = parts.findLast((p) => p.kind !== 'tap');
    if (last && part.kind !== 'tap' && last.kind === part.kind && e.startMs - last.endMs <= PART_JOIN_MS) {
      last.endMs = Math.max(last.endMs, e.endMs);
      last.loHz = Math.min(last.loHz, part.loHz);
      last.hiHz = Math.max(last.hiHz, part.hiHz);
    } else {
      parts.push(part);
    }
  }
  return parts;
}

/**
 * Why a reading must not be saved without the user pressing Save, or null when it may be.
 * Saving by itself needs the tag's identity: a solidly read resting frame that does not
 * contradict what the club already has. When the tag sent two frames, it also needs to be
 * known which is which: the tap that set off the hit frame was heard, or the resting frame
 * began where one does after the wake tone. A lone frame the club does not have yet must
 * have been heard from the wake tone on: a frame already sending when listening began could
 * be the hit frame, with the tap and the resting frame never heard. And a frame the club does
 * not have yet must be firm (see AUTO_SAVE_MIN_REPEATS): a brief read can be a misread.
 * @param {Reading} reading
 * @param {number[]|null} savedSymbols the club's saved resting frame, or null when it has none
 * @returns {'no-frame'|'too-brief'|'order-unknown'|'no-wake'|'differs'|null}
 */
export function autoSaveBlock(reading, savedSymbols) {
  if (!reading.frames || !isSolidFrames(reading.frames)) return 'no-frame';
  const fromWake = Boolean(reading.tone && followsWakeTone([reading.tone], reading.frames));
  const tapFixesOrder = Boolean(reading.hitFrames && reading.impact);
  if (reading.hitFrames && !tapFixesOrder && !fromWake) return 'order-unknown';
  const alreadySaved = Boolean(savedSymbols && sameSymbols(reading.frames.symbols, savedSymbols));
  if (!alreadySaved && !isFirmFrames(reading.frames)) return 'too-brief';
  if (!alreadySaved && !fromWake && !tapFixesOrder) return 'no-wake';
  if (savedSymbols && !alreadySaved) return 'differs';
  return null;
}

/**
 * Fold the newest decode of the sliding window into the held reading.
 * @param {Reading} prev
 * @param {TagEvent[]} events every event in the current window
 * @returns {Reading} a new reading; `prev` is not changed
 */
export function mergeReading(prev, events) {
  const current = events.filter((e) => e.endMs > prev.sinceMs);
  const { frames, hitFrames } = pickFrames(
    prev.frames,
    prev.hitFrames,
    /** @type {FramesEvent[]} */ (current.filter((e) => e.type === 'frames')),
    /** @type {ImpactEvent[]} */ (current.filter((e) => e.type === 'impact')),
    /** @type {ToneEvent[]} */ (current.filter((e) => e.type === 'tone'))
  );

  // A solid frame where there was none, or with other symbols, is a tag newly identified.
  // From here on only signals near or after that frame are its own: an earlier tag's tone
  // is still inside the window and must not be picked up again on later merges.
  const identified =
    frames !== null &&
    isSolidFrames(frames) &&
    !(prev.frames && isSolidFrames(prev.frames) && sameSymbols(prev.frames.symbols, frames.symbols));
  const sinceMs = identified ? Math.max(prev.sinceMs, frames.startMs - ATTACH_BEFORE_MS) : prev.sinceMs;

  const own = (e) => e !== null && e.endMs > sinceMs;
  // A hop pattern is the tag's answer to a hit: it takes over from that tag's frame, with no
  // pause (none in the nine recordings that hold both). One that began before the frame
  // is the tag before, still hopping while this one was lit; one that began well after the
  // frame stopped is another tag.
  const ownHop = (e) =>
    own(e) && (frames === null || (e.startMs >= frames.startMs && e.startMs <= frames.endMs + SAME_TAG_GAP_MS));
  const hop = pickFullest(
    ownHop(prev.hop) ? prev.hop : null,
    /** @type {HopEvent[]} */ (current.filter((e) => e.type === 'hop' && ownHop(e))),
    (e) => e.hops
  );
  // A weak stretch of frames can decode as a steady tone on the frames' own rest tone. A wake
  // tone is nowhere near it: the ones measured sit 0.8 to 1.9 kHz above.
  const isRestTone = (e) => frames !== null && Math.abs(e.hz - frames.restHz) <= REST_MATCH_HZ;
  const ownTone = (e) => own(e) && !isHopOpening(e, hop) && !isRestTone(e);
  const tone = pickFullest(
    ownTone(prev.tone) ? prev.tone : null,
    /** @type {ToneEvent[]} */ (current.filter((e) => e.type === 'tone' && ownTone(e))),
    (e) => e.endMs - e.startMs
  );
  // The tap that set off the hit signal: the last one heard shortly before that signal began.
  const hitStartMs = hitFrames ? hitFrames.startMs : hop ? hop.startMs : null;
  const taps =
    hitStartMs === null
      ? []
      : tapsJustBefore(/** @type {ImpactEvent[]} */ (current.filter((e) => e.type === 'impact')), hitStartMs);
  const impact = hitStartMs === null ? null : taps[taps.length - 1] ?? prev.impact ?? null;
  return { frames, hitFrames, tone, hop, impact, sinceMs };
}
