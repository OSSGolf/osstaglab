/**
 * session.js - the live mapping session: what is held, which club it belongs to, and the
 * one decision to save it or not. Pure: no DOM, no network, no clock of its own.
 *
 * The page feeds stepSession the decoder's events several times a second and carries out
 * the action it returns. The rules, each of which exists because breaking it saved wrong
 * data on real recordings:
 *
 *   - A transmission is judged once, when nothing has been heard for AUTO_SAVE_QUIET_MS.
 *     Saved or refused, the reading is then frozen: later decodes of the sliding window,
 *     which read a transmission differently as it slides out, cannot change it or have it
 *     judged again.
 *   - A frozen reading stays until the next signal begins after the judged point. That
 *     signal starts a new reading; it is never merged into the old one.
 *   - A reading belongs to the club chosen when it began, or the one it was recognised as.
 *     When the club is changed by hand while a reading is held, the reading does not save
 *     by itself.
 *
 * All times share the one live clock that never goes backwards.
 */
import { HIT_ROLE, clubSummary, isSolidFrames, matchFrame, savedFrameRole } from './codebook.js';
import {
  autoSaveBlock,
  emptyReading,
  isEmptyReading,
  isFirmFrames,
  mergeReading,
  sameSymbols,
} from './reading.js';

/**
 * @typedef {import('./reading.js').Reading} Reading
 * @typedef {import('./tag-decoder.js').TagEvent} TagEvent
 * @typedef {import('./tag-decoder.js').FramesEvent} FramesEvent
 * @typedef {import('./codebook.js').Codebook} Codebook
 * @typedef {import('./codebook.js').ClubSummary} ClubSummary
 */

/**
 * The tag has finished sending when nothing but taps has been heard for this long. A tag's
 * own pauses are shorter: the wake tone ends about 0.5 s before the resting frame begins,
 * and the dropouts measured inside a hit frame were under 0.5 s.
 */
export const AUTO_SAVE_QUIET_MS = 1500;

/**
 * An event that begins this close to the start of a window that has slid is a view cut by
 * the window, not a signal that began there: a decoded signal is at least 40 ms long, and
 * one that really began at the edge was heard whole for the 8 s before.
 */
const WINDOW_EDGE_MS = 50;

/**
 * Two taps heard closer together than this are one: the same click read at slightly
 * different times by successive decodes of the sliding window.
 */
const SAME_TAP_MS = 150;

/**
 * A tap is a hit on the tag when the tag answers it with its hit signal (a hop pattern, or
 * the putter's second frame): the signal begins no later than ANSWER_WITHIN_MS after the
 * tap, and is still being sent ANSWER_HOLDS_MS after the later of the two.
 *
 * Measured on the bench, 2026-11-20. A first hit starts the signal 0 to 12 ms later; the
 * faint driver's is picked up 230 to 430 ms later. A hit while the signal is already running
 * does not restart it (the 7 iron's hops kept their rhythm straight through a second hit),
 * so there the tap itself is the only mark and the running signal is what vouches for it.
 * A flashlight switched off or put down ends the signal at that instant, which is how those
 * clicks are told from hits.
 */
const ANSWER_WITHIN_MS = 500;
const ANSWER_HOLDS_MS = 300;

/**
 * A click this soon after a hit is the same hit: the club rattling or bouncing off what it
 * struck. Measured on a 56 degree wedge hit once: a second click 301 ms after the hit and
 * 16 dB quieter. Hits made on purpose on the bench were never closer than about a second.
 */
const SAME_HIT_MS = 500;

/**
 * The hit signal beginning straight out of the resting frame is a hit whether or not its
 * click was heard: the tag only leaves its resting frame when it is struck. The resting
 * frame must have ended no longer than REST_BEFORE_ANSWER_MS before the signal began (the
 * faint driver's pattern was picked up 420 ms after its frame ended) and no later than
 * REST_AFTER_ANSWER_MS after. A hit signal that resumes after a dropout follows more hit
 * signal, not the resting frame, and is not a new hit. Measured on the putter hit twice in
 * one lighting: the second hit's click was too soft to register, yet its hit frame came
 * back after 2.2 s of resting frame.
 */
const REST_BEFORE_ANSWER_MS = 600;
const REST_AFTER_ANSWER_MS = 100;

/**
 * @typedef {'no-frame'|'too-brief'|'order-unknown'|'no-wake'|'differs'|'club-changed'} RefusalReason
 */

/**
 * @typedef {object} Session
 * @property {Reading} reading what is held
 * @property {number} floorMs only events that begin at or after this can enter the reading
 * @property {number} lastHeardMs when the newest signal of this reading ended; -Infinity before any
 * @property {number|null} judgedMs the `lastHeardMs` this reading was judged at; null until it is.
 *   A judged reading is frozen.
 * @property {RefusalReason|null} refusal why the judged reading was not saved by itself
 * @property {number} startedMs when the earliest signal ever held in this reading began;
 *   Infinity before any. The reading itself can let go of its earliest signal as a long
 *   transmission goes on; this does not move.
 * @property {{startMs: number, riseDb: number}[]} taps every tap or strike heard since this
 *   reading began, oldest first. Kept apart from the reading, which holds one, and unlike
 *   the sliding window it never forgets one.
 * @property {{startMs: number, endMs: number, fromRest: boolean}[]} answers the stretches of
 *   this reading in which the tag was sending its hit signal: hop patterns, and runs of the
 *   frame held as the hit frame. Oldest first, none overlapping. fromRest: the stretch
 *   began straight out of the resting frame, which only a hit causes.
 * @property {string|null} clubId the club the reading belongs to; null while only identifying
 * @property {number|null} clubChangedAtMs when the club was last changed by hand while a
 *   reading was held; null when it has not been
 * @property {string|null} pickedFor symbols of the frame the club was last recognised from,
 *   so recognition chooses the club once per frame
 */

/**
 * @typedef {object} SavedEvent one event of a reading and the role it is saved under
 * @property {TagEvent} event
 * @property {'hit'|undefined} role 'hit' for the frame a tag sends after a hit
 */

/**
 * @typedef {object} SessionAction
 * @property {'save'|'refuse'} type
 * @property {string} clubId the club the reading belongs to
 * @property {number} judgedMs identifies the reading judged; pass it to settleSave
 * @property {SavedEvent[]} [events] for 'save': what to save, in order
 * @property {RefusalReason} [reason] for 'refuse'
 */

/**
 * @param {number} [floorMs] only signals that begin at or after this are heard
 * @param {string|null} [clubId]
 * @returns {Session} a session holding nothing
 */
export function newSession(floorMs = -Infinity, clubId = null) {
  return {
    reading: emptyReading(floorMs),
    floorMs,
    lastHeardMs: -Infinity,
    judgedMs: null,
    refusal: null,
    startedMs: Infinity,
    taps: [],
    answers: [],
    clubId,
    clubChangedAtMs: null,
    pickedFor: null,
  };
}

/**
 * @param {Reading} reading
 * @returns {number} when the earliest signal held in the reading began
 */
function beganMs(reading) {
  const held = [reading.frames, reading.hitFrames, reading.tone, reading.hop].filter((e) => e !== null);
  return Math.min(...held.map((e) => e.startMs));
}

/**
 * @param {{startMs: number, riseDb: number}[]} taps the taps counted so far
 * @param {TagEvent[]} events the newest decode of the window
 * @param {number} sinceMs when the reading began; Infinity when it holds nothing
 * @returns {{startMs: number, riseDb: number}[]} the taps heard since then, each once
 */
function countTaps(taps, events, sinceMs) {
  const out = taps.filter((t) => t.startMs >= sinceMs);
  for (const e of events) {
    if (e.type !== 'impact' || e.startMs < sinceMs) continue;
    if (out.some((t) => Math.abs(t.startMs - e.startMs) < SAME_TAP_MS)) continue;
    out.push({ startMs: e.startMs, riseDb: e.riseDb });
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

/**
 * @param {{startMs: number, endMs: number}[]} answers the stretches of hit signal noted so far
 * @param {TagEvent[]} events the newest decode of the window
 * @param {(e: TagEvent) => boolean} cut whether an event is a view cut by the window's edge
 * @param {Reading} reading
 * @param {number} sinceMs when the reading began; Infinity when it holds nothing
 * @returns {{startMs: number, endMs: number}[]} the stretches of hit signal since then
 */
function noteAnswers(answers, events, cut, reading, sinceMs) {
  const isAnswer = (e) =>
    e.type === 'hop' ||
    (e.type === 'frames' && reading.hitFrames !== null && sameSymbols(e.symbols, reading.hitFrames.symbols));
  // The resting frame: the frame the reading holds as such, or before one is held, any
  // frame that is not the hit frame.
  const isRest = (e) =>
    e.type === 'frames' && (reading.frames !== null ? sameSymbols(e.symbols, reading.frames.symbols) : !isAnswer(e));
  const restEnds = events.filter(isRest).map((e) => e.endMs);
  // Straight out of the resting frame: the frame ended just before, with no other stretch
  // of hit signal in between (that would make this one a resumption after a dropout).
  const fromRest = (startMs, others) =>
    restEnds.some(
      (ms) =>
        ms >= startMs - REST_BEFORE_ANSWER_MS &&
        ms <= startMs + REST_AFTER_ANSWER_MS &&
        !others.some((a) => a.startMs < startMs && a.endMs > ms)
    );
  let out = answers.filter((a) => a.endMs >= sinceMs);
  for (const e of events) {
    if (!isAnswer(e) || e.endMs < sinceMs) continue;
    const touching = out.filter((a) => a.startMs <= e.endMs && e.startMs <= a.endMs);
    // A view cut by the window's edge starts where the window does, not where the signal
    // did: it can lengthen a stretch already noted, never begin one.
    if (touching.length === 0 && cut(e)) continue;
    const startMs = Math.min(cut(e) ? Infinity : e.startMs, ...touching.map((a) => a.startMs));
    const merged = {
      startMs,
      endMs: Math.max(e.endMs, ...touching.map((a) => a.endMs)),
      fromRest:
        touching.some((a) => a.fromRest) ||
        fromRest(
          startMs,
          out.filter((a) => !touching.includes(a))
        ),
    };
    out = [...out.filter((a) => !touching.includes(a)), merged];
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

/**
 * The hits on the tag in this session's reading. Two things make a hit:
 *   - the tag's hit signal beginning straight out of its resting frame, click heard or not;
 *   - a tap the tag answers: one heard while the hit signal is running, or just before it
 *     begins. A tap heard with the signal's beginning is that same hit.
 * A click the tag did not answer (a flashlight switch, a club put down, a tap too light for
 * the tag) is not a hit.
 * @param {Session} session
 * @returns {{startMs: number, riseDb: number|null}[]} oldest first; riseDb is null for a
 *   hit known only from the tag's answer
 */
export function hitsOf(session) {
  const answered = (t) =>
    session.answers.some(
      (a) => a.startMs <= t.startMs + ANSWER_WITHIN_MS && a.endMs >= Math.max(t.startMs, a.startMs) + ANSWER_HOLDS_MS
    );
  const taps = session.taps.filter(answered);
  const onsets = session.answers
    .filter((a) => a.fromRest && a.endMs - a.startMs >= ANSWER_HOLDS_MS)
    .map((a) => ({ startMs: a.startMs, riseDb: null }));
  /** @type {{startMs: number, riseDb: number|null}[]} */
  const hits = [];
  // In time order, with a tap ahead of an onset at the same instant so that the hit keeps
  // the tap's time and loudness.
  const marks = [...taps, ...onsets].sort((a, b) => a.startMs - b.startMs || (a.riseDb === null ? 1 : -1));
  for (const mark of marks) {
    const last = hits[hits.length - 1];
    if (last && mark.startMs - last.startMs < SAME_HIT_MS) continue;
    hits.push(mark);
  }
  return hits;
}

/**
 * @param {Reading} reading
 * @param {TagEvent} event
 * @returns {boolean} true when the event is a frame the reading already holds
 */
function confirmsHeld(reading, event) {
  if (event.type !== 'frames') return false;
  return [reading.frames, reading.hitFrames].some((f) => f !== null && sameSymbols(f.symbols, event.symbols));
}

/**
 * What to save from a reading, and under which role each frame goes. A frame the club
 * already has keeps its saved role; a new one takes the role it was heard in.
 * @param {Reading} reading
 * @param {ClubSummary|null} savedSummary what the club already has, or null for none
 * @param {{bySelf?: boolean}} [options] bySelf: the save is not checked by anyone, so only
 *   what is certain goes in: a hit frame must be firm or already saved for the club, and
 *   the tone must have come before the resting frame, as a wake tone does. A tone after it
 *   can be another tag waking.
 * @returns {SavedEvent[]} empty when the reading has nothing worth saving
 */
export function eventsToSave(reading, savedSummary, { bySelf = false } = {}) {
  const { frames, hitFrames, tone, hop } = reading;
  const roleOf = (event) => {
    const known = savedSummary ? savedFrameRole(savedSummary, event.symbols) : null;
    const asHit = known === null ? event === hitFrames : known === HIT_ROLE;
    return asHit ? HIT_ROLE : undefined;
  };
  /** @type {SavedEvent[]} */
  const out = [];
  if (frames && isSolidFrames(frames)) out.push({ event: frames, role: roleOf(frames) });
  if (hitFrames && isSolidFrames(hitFrames)) {
    const known = savedSummary !== null && savedFrameRole(savedSummary, hitFrames.symbols) !== null;
    if (!bySelf || known || isFirmFrames(hitFrames)) out.push({ event: hitFrames, role: roleOf(hitFrames) });
  }
  if (tone && (!bySelf || !frames || tone.startMs < frames.startMs)) out.push({ event: tone, role: undefined });
  if (hop) out.push({ event: hop, role: undefined });
  return out;
}

/**
 * Take in the newest decode of the live window and decide what, if anything, to do.
 * @param {Session} session
 * @param {object} input
 * @param {TagEvent[]} input.events every event in the current window, on the live clock
 * @param {number} input.nowMs live time of the newest audio decoded
 * @param {string|null} input.clubId the club chip shown now, or null when no club is chosen
 *   and tags are only being identified: nothing is then saved or refused
 * @param {Codebook} input.codebook what is saved
 * @param {boolean} input.autoSave whether saving by itself is switched on
 * @param {number} [input.windowStartMs] live time the window begins at, once it has slid
 *   (dropped audio it used to hold); -Infinity while it still begins where listening did
 * @returns {{session: Session, action: SessionAction|null}} the new session (the one passed
 *   in is not changed). `session.clubId` differing from `input.clubId` means the reading was
 *   recognised as that club: show it as the chosen one.
 */
export function stepSession(session, { events, nowMs, clubId, codebook, autoSave, windowStartMs = -Infinity }) {
  // A view cut by the window's trailing edge can confirm a frame already held, but brings
  // nothing new: cut short, a transmission reads differently, and its start is not its start.
  const cut = (e) => e.startMs < windowStartMs + WINDOW_EDGE_MS;
  const usable = events.filter(
    (e) => e.startMs >= session.floorMs && (e.type === 'impact' || !cut(e) || confirmsHeld(session.reading, e))
  );
  const signals = usable.filter((e) => e.type !== 'impact');

  let s = session;
  if (s.judgedMs !== null) {
    // Frozen. Only a signal that began after the judged point ends that, with a new reading.
    if (signals.length === 0) return { session: s.clubId === clubId ? s : { ...s, clubId }, action: null };
    s = newSession(s.judgedMs, clubId);
  }

  let { clubChangedAtMs } = s;
  if (isEmptyReading(s.reading)) clubChangedAtMs = null;
  else if (clubId !== s.clubId) clubChangedAtMs = nowMs;

  const lastHeardMs = Math.max(s.lastHeardMs, ...signals.map((e) => e.endMs));
  const reading = mergeReading(s.reading, usable);

  // The first time a frame reads solidly and belongs to exactly one saved club, the reading
  // is that club's. A choice made by hand afterwards stands until another frame is read.
  let { pickedFor } = s;
  let club = clubId;
  const solid = reading.frames !== null && isSolidFrames(reading.frames) ? reading.frames : null;
  if (reading.frames === null) pickedFor = null;
  if (solid && solid.symbols.join(',') !== pickedFor) {
    pickedFor = solid.symbols.join(',');
    const known = matchFrame(codebook, solid.symbols);
    if (known.length === 1 && known[0] !== club) {
      club = known[0];
      clubChangedAtMs = null;
    }
  }

  /** @type {Session} */
  const startedMs = isEmptyReading(reading) ? Infinity : Math.min(s.startedMs, beganMs(reading));
  const taps = countTaps(s.taps, usable, startedMs);
  const answers = noteAnswers(s.answers, events.filter((e) => e.startMs >= s.floorMs), cut, reading, startedMs);
  const next = { ...s, reading, lastHeardMs, startedMs, taps, answers, clubId: club, clubChangedAtMs, pickedFor };
  if (isEmptyReading(reading) || nowMs - lastHeardMs < AUTO_SAVE_QUIET_MS) return { session: next, action: null };

  // The tag has gone quiet: judge this reading, once.
  const judged = { ...next, judgedMs: lastHeardMs, floorMs: lastHeardMs };
  if (!autoSave || clubId === null) return { session: judged, action: null };
  const entry = codebook.clubs[club];
  const summary = entry ? clubSummary(entry) : null;
  // A club chosen by hand after the reading began may not be the club it was heard for,
  // unless the frame is one that club alone already has.
  const recognised = solid !== null && matchFrame(codebook, solid.symbols).join() === club;
  const changedMidway = clubChangedAtMs !== null && beganMs(reading) < clubChangedAtMs && !recognised;
  const reason = changedMidway ? 'club-changed' : autoSaveBlock(reading, summary?.frame ? summary.frame.symbols : null);
  if (reason !== null) {
    return { session: { ...judged, refusal: reason }, action: { type: 'refuse', clubId: club, judgedMs: lastHeardMs, reason } };
  }
  const toSave = eventsToSave(reading, summary, { bySelf: true });
  return { session: judged, action: { type: 'save', clubId: club, judgedMs: lastHeardMs, events: toSave } };
}

/**
 * Listening has ended: whatever is held is all there will be of this reading, so it is
 * judged now without waiting for the quiet time. Nothing is saved by this.
 * @param {Session} session
 * @returns {Session} the session with its reading frozen; unchanged when it holds nothing
 *   or was already judged
 */
export function closeSession(session) {
  if (session.judgedMs !== null || isEmptyReading(session.reading)) return session;
  return { ...session, judgedMs: session.lastHeardMs, floorMs: session.lastHeardMs };
}

/**
 * The save of a judged reading went through: let go of that reading. A signal that began
 * while the save was in flight is kept: if it already started a new reading the session is
 * left alone, and otherwise everything after the judged point can still be heard.
 * @param {Session} session
 * @param {number} judgedMs the `judgedMs` of the save action
 * @returns {Session}
 */
export function settleSave(session, judgedMs) {
  return session.judgedMs === judgedMs ? newSession(judgedMs, session.clubId) : session;
}
