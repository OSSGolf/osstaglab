/**
 * The live mapping session, run the way the page runs it: audio in 250 ms pieces through the
 * tone tracker, an 8 s window, classify, stepSession, and the save carried out at once.
 *
 * The fixtures are cut from longer recordings (tools/clip.mjs). What must never happen, whatever
 * the timing: a reading saved under the wrong club, a hit frame saved as a resting frame or
 * the other way round, another tag's tone, hop pattern or frame saved with this tag's, or
 * one transmission saved twice.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { decodeWav } from '../web/dsp.js';
import { ToneTracker, classify } from '../web/tag-decoder.js';
import { addObservation, emptyCodebook, observationFromEvent } from '../web/codebook.js';
import { AUTO_SAVE_MIN_REPEATS, emptyReading, mergeReading } from '../web/reading.js';
import { AUTO_SAVE_QUIET_MS, closeSession, eventsToSave, hitsOf, newSession, settleSave, stepSession } from '../web/session.js';

const SR = 48000;
const TICK_SAMPLES = SR / 4;
const WINDOW_S = 8;

/** What each tag sends, as measured on recordings of it. */
const TAGS = {
  putter: { rest: [-4, -2, -1, -3, -1, 1], hit: [1, 3, 4, 2, 4, -1], toneHz: 19810, hop: null },
  wedgeSW: { rest: [1, 3, 4, -3, 4, -3], hit: null, toneHz: 18720, hop: { restHz: 18822, offsetHz: 300, periodMs: 122 } },
  iron9: { rest: [4, -1, -2, 1, -4, -3], hit: null, toneHz: 18803, hop: { restHz: 18904, offsetHz: 408, periodMs: 61 } },
};
const TONE_MATCH_HZ = 45;
const HOP_MATCH_HZ = 45;

/**
 * @param {string} name a file in test/fixtures, without its extension
 * @returns {Float32Array}
 */
function fixture(name) {
  const buf = fs.readFileSync(new URL(`./fixtures/${name}.wav`, import.meta.url));
  const { sampleRate, samples } = decodeWav(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  assert.equal(sampleRate, SR);
  return Float32Array.from(samples);
}

/** One second of the room with no tag sending, repeated to fill the pauses. */
const ROOM = fixture('room-noise');

/**
 * @param {number} seconds
 * @returns {Float32Array} room noise of that length
 */
function room(seconds) {
  const out = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < out.length; i++) out[i] = ROOM[i % ROOM.length];
  return out;
}

/**
 * @param {...Float32Array} parts
 * @returns {Float32Array} the parts end to end, each faded in and out over 5 ms so that a
 *   join is not heard as a click
 */
function join(...parts) {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  const fade = Math.round(0.005 * SR);
  let at = 0;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      const gain = Math.min(1, i / fade, (part.length - 1 - i) / fade);
      out[at + i] = part[i] * gain;
    }
    at += part.length;
  }
  return out;
}

/**
 * The decoder's side of the live loop.
 * @param {Float32Array} audio
 * @returns {{nowMs: number, windowStartMs: number, events: object[]}[]} one entry per 250 ms
 */
function decodeLive(audio) {
  const tracker = new ToneTracker(SR);
  const ticks = [];
  let firstWindowMs = null;
  for (let at = 0; at < audio.length; at += TICK_SAMPLES) {
    tracker.push(audio.subarray(at, Math.min(audio.length, at + TICK_SAMPLES)));
    tracker.trim(WINDOW_S);
    const track = tracker.track();
    if (firstWindowMs === null) firstWindowMs = track.startMs;
    ticks.push({
      nowMs: track.startMs + track.hz.length * track.hopMs,
      windowStartMs: track.startMs > firstWindowMs ? track.startMs : -Infinity,
      events: classify(track),
    });
  }
  return ticks;
}

/**
 * A codebook that already holds the given clubs, as a full pass over them would leave it.
 * @param {string[]} clubs
 * @returns {object}
 */
function codebookWith(clubs) {
  const at = '2026-11-01T00:00:00.000Z';
  let codebook = emptyCodebook();
  for (const clubId of clubs) {
    const tag = TAGS[clubId];
    const frame = (symbols, role) => ({ kind: 'frames', at, device: null, symbols, restHz: 17900, repeats: 10, frames: 10, ...(role ? { role } : {}) });
    codebook = addObservation(codebook, clubId, frame(tag.rest));
    if (tag.hit) codebook = addObservation(codebook, clubId, frame(tag.hit, 'hit'));
    codebook = addObservation(codebook, clubId, { kind: 'tone', at, device: null, hz: tag.toneHz });
    if (tag.hop) codebook = addObservation(codebook, clubId, { kind: 'hop', at, device: null, ...tag.hop, hops: 20 });
  }
  return codebook;
}
const EVERY_CLUB = Object.keys(TAGS);

/**
 * The session's side of the live loop, as app.js runs it, with every save succeeding at once.
 * @param {{nowMs: number, windowStartMs: number, events: object[]}[]} ticks
 * @param {{atMs: number, clubId: string}[]} chips the chip chosen at the start, then each press
 * @param {object} codebook
 * @returns {{saves: object[], refusals: object[], session: object}}
 */
function runSession(ticks, chips, codebook) {
  let chip = chips[0].clubId;
  let pressed = 0;
  let session = newSession(0, chip);
  const saves = [];
  const refusals = [];
  for (const { nowMs, windowStartMs, events } of ticks) {
    while (pressed + 1 < chips.length && chips[pressed + 1].atMs <= nowMs) chip = chips[++pressed].clubId;
    const out = stepSession(session, { events, nowMs, clubId: chip, codebook, autoSave: true, windowStartMs });
    session = out.session;
    chip = session.clubId;
    if (!out.action) continue;
    if (out.action.type === 'refuse') {
      refusals.push({ nowMs, reason: out.action.reason });
      continue;
    }
    const { clubId, judgedMs } = out.action;
    const observations = out.action.events.map(({ event, role }) => ({
      ...observationFromEvent(event, { at: new Date(1.7e12 + nowMs).toISOString(), role }),
      startMs: event.startMs,
    }));
    for (const { startMs, ...observation } of observations) codebook = addObservation(codebook, clubId, observation);
    saves.push({ nowMs, clubId, judgedMs, observations });
    session = settleSave(session, judgedMs);
  }
  return { saves, refusals, session };
}

/**
 * @param {{clubId: string, observations: object[]}} save
 * @returns {string[]} everything in the save that is not what that club's tag sends
 */
function wrongData(save) {
  const tag = TAGS[save.clubId];
  if (!tag) return [`saved under ${save.clubId}, which has no tag here`];
  const same = (a, b) => b !== null && a.join() === b.join();
  const wrong = [];
  for (const o of save.observations) {
    if (o.kind === 'frames' && o.role === 'hit' && !same(o.symbols, tag.hit)) wrong.push(`hit frame ${o.symbols}`);
    if (o.kind === 'frames' && o.role !== 'hit' && !same(o.symbols, tag.rest)) wrong.push(`resting frame ${o.symbols}`);
    if (o.kind === 'tone' && Math.abs(o.hz - tag.toneHz) > TONE_MATCH_HZ) wrong.push(`tone ${o.hz.toFixed(0)} Hz`);
    if (o.kind === 'hop') {
      const fits = tag.hop && Math.abs(o.restHz - tag.hop.restHz) <= HOP_MATCH_HZ && Math.abs(o.offsetHz - tag.hop.offsetHz) <= HOP_MATCH_HZ;
      if (!fits) wrong.push(`hop pattern on ${o.restHz.toFixed(0)} Hz`);
    }
  }
  return wrong;
}

/**
 * @param {object[]} saves
 * @param {string} where what was run, for the failure message
 * @returns {void}
 */
function assertNothingWrong(saves, where) {
  for (const save of saves) {
    assert.deepEqual(wrongData(save), [], `${where}: saved under ${save.clubId} at ${save.nowMs.toFixed(0)} ms`);
    const waited = save.nowMs - save.judgedMs;
    assert.ok(waited < AUTO_SAVE_QUIET_MS + 300, `${where}: saved ${waited.toFixed(0)} ms after the tag went quiet`);
  }
}

const kindsOf = (save) => save.observations.map((o) => (o.kind === 'frames' ? (o.role === 'hit' ? 'hit' : 'resting') : o.kind));

/** The fixtures, with the club each was recorded from and where its last signal ends. */
const CLIPS = {
  putterWake: { club: 'putter', audio: fixture('putter-taps-wake-rest') },
  putterHit: { club: 'putter', audio: fixture('putter-tap-hit-return') },
  putterWeak: { club: 'putter', audio: fixture('putter-weak-rest-tap-hit') },
  putterMisread: { club: 'putter', audio: fixture('putter-misread-then-quiet') },
  iron9: { club: 'iron9', audio: fixture('iron9-wake-tap-hop') },
  sandWedge: { club: 'wedgeSW', audio: fixture('sandwedge-wake-tap-hop') },
};
const TAIL_S = 6;
const alone = (clip) => decodeLive(join(clip.audio, room(TAIL_S)));

/* ------------------------------ one club at a time ------------------------------ */

test('one pass over a 9 iron saves its resting frame, wake tone and hop pattern, about 1.5 s after it goes quiet', () => {
  const { saves, refusals } = runSession(alone(CLIPS.iron9), [{ atMs: 0, clubId: 'iron9' }], emptyCodebook());
  assert.equal(saves.length, 1);
  assert.deepEqual(kindsOf(saves[0]), ['resting', 'tone', 'hop']);
  assertNothingWrong(saves, 'iron9');
  assert.deepEqual(refusals, []);
});

test('one pass over a sand wedge saves its resting frame, wake tone and hop pattern', () => {
  const { saves } = runSession(alone(CLIPS.sandWedge), [{ atMs: 0, clubId: 'wedgeSW' }], emptyCodebook());
  assert.equal(saves.length, 1);
  assert.deepEqual(kindsOf(saves[0]), ['resting', 'tone', 'hop']);
  assertNothingWrong(saves, 'sand wedge');
});

test('a putter heard from its wake tone saves its resting frame and tone', () => {
  const { saves } = runSession(alone(CLIPS.putterWake), [{ atMs: 0, clubId: 'putter' }], emptyCodebook());
  assert.equal(saves.length, 1);
  assert.deepEqual(kindsOf(saves[0]), ['resting', 'tone']);
  assertNothingWrong(saves, 'putter');
});

test('a putter already saved gets its resting and hit frames again, each under its own role', () => {
  const { saves } = runSession(alone(CLIPS.putterHit), [{ atMs: 0, clubId: 'putter' }], codebookWith(EVERY_CLUB));
  assert.equal(saves.length, 1);
  assert.deepEqual(kindsOf(saves[0]), ['resting', 'hit']);
  assertNothingWrong(saves, 'putter, saved before');
});

test(`a resting frame agreed on by fewer than ${AUTO_SAVE_MIN_REPEATS} frames is not saved for a new club`, () => {
  const { saves, refusals } = runSession(alone(CLIPS.putterHit), [{ atMs: 0, clubId: 'putter' }], emptyCodebook());
  assert.deepEqual(saves, []);
  assert.deepEqual(refusals.map((r) => r.reason), ['too-brief']);
});

test('a tag recognised from its frame is saved to its own club, whatever chip was chosen', () => {
  const { saves } = runSession(alone(CLIPS.iron9), [{ atMs: 0, clubId: 'putter' }], codebookWith(EVERY_CLUB));
  assert.equal(saves.length, 1);
  assert.equal(saves[0].clubId, 'iron9');
  assertNothingWrong(saves, 'iron9 under the putter chip');
});

test('a new tag heard under a chip that has another frame is refused, not saved', () => {
  const { saves, refusals } = runSession(alone(CLIPS.iron9), [{ atMs: 0, clubId: 'putter' }], codebookWith(['putter']));
  assert.deepEqual(saves, []);
  assert.deepEqual(refusals.map((r) => r.reason), ['differs']);
});

/* ------------------------------ repros from recordings ---------------------------- */

test('a pass refused when the tag went quiet is never saved later, whatever chip is pressed afterwards', () => {
  // Seen on a putter recording: the resting frame reads weakly before the tap. The old loop
  // refused it at the quiet point, then saved it 4.8 s later when the sliding window happened
  // to read the frame solidly, under whichever chip was chosen by then.
  const ticks = decodeLive(join(CLIPS.putterWeak.audio, room(12)));
  for (const pressMs of [null, 4500, 5000, 6000, 9000]) {
    for (const codebook of [emptyCodebook(), codebookWith(['iron9', 'wedgeSW'])]) {
      const chips = [{ atMs: 0, clubId: 'putter' }, ...(pressMs === null ? [] : [{ atMs: pressMs, clubId: 'driver' }])];
      const { saves, refusals } = runSession(ticks, chips, codebook);
      assert.deepEqual(saves, [], `chip pressed at ${pressMs}`);
      assert.equal(refusals.length, 1, `refused once (chip pressed at ${pressMs})`);
    }
  }
});

test('a misread that looked solid while the tag was still sending is not saved when the tag stops', () => {
  // Seen on a putter recording: the last symbol reads -1 for +1 in three or four early
  // frames. The old loop held that early read and saved it as a new club's resting frame.
  for (const cutS of [2.0, 2.2, 2.4, 2.9]) {
    const audio = CLIPS.putterMisread.audio.subarray(0, Math.round(cutS * SR));
    for (const codebook of [emptyCodebook(), codebookWith(EVERY_CLUB)]) {
      const { saves, refusals } = runSession(decodeLive(join(audio, room(TAIL_S))), [{ atMs: 0, clubId: 'putter' }], codebook);
      assert.deepEqual(saves, [], `tag stops at ${cutS} s`);
      assert.equal(refusals.length, 1, `refused once (tag stops at ${cutS} s)`);
    }
  }
});

/* ------------------------------ one club after another ------------------------------ */

const PAIRS = [
  ['putterWake', 'iron9'],
  ['iron9', 'putterWake'],
  ['sandWedge', 'putterWake'],
  ['iron9', 'iron9'],
  ['putterWake', 'putterHit'],
  ['putterWeak', 'iron9'],
  ['iron9', 'putterHit'],
];
const GAPS_S = [1, 2.5, 4.5];
/** When the next club's chip is pressed, after the first tag went quiet; null for as the second tag starts. */
const PRESS_AFTER_QUIET_MS = [null, 500, 1000, 2000, 5000];

/** @type {Map<Float32Array, number>} */
const quietTimes = new Map();

/**
 * @param {Float32Array} audio one clip
 * @returns {number} when its last tag signal ends, in ms
 */
function quietAt(audio) {
  if (!quietTimes.has(audio)) {
    const tracker = new ToneTracker(SR);
    tracker.push(audio);
    const signals = classify(tracker.track()).filter((e) => e.type !== 'impact');
    quietTimes.set(audio, Math.max(...signals.map((e) => e.endMs)));
  }
  return quietTimes.get(audio);
}

for (const [first, second] of PAIRS) {
  test(`${first} then ${second}: nothing wrong is saved at any gap or chip timing, with the clubs new or saved`, () => {
    const a = CLIPS[first];
    const b = CLIPS[second];
    const sameClub = a.club === b.club;
    let saved = 0;
    for (const gapS of GAPS_S) {
      const ticks = decodeLive(join(a.audio, room(gapS), b.audio, room(TAIL_S)));
      const secondStartsMs = (a.audio.length / SR + gapS) * 1000;
      for (const pressMs of PRESS_AFTER_QUIET_MS) {
        for (const [bookName, codebook] of [['new', emptyCodebook()], ['saved', codebookWith(EVERY_CLUB)]]) {
          const where = `gap ${gapS} s, chip ${pressMs ?? 'at second'}, clubs ${bookName}`;
          const chips = [{ atMs: 0, clubId: a.club }, { atMs: pressMs === null ? secondStartsMs : quietAt(a.audio) + pressMs, clubId: b.club }];
          const { saves } = runSession(ticks, chips, codebook);
          assertNothingWrong(saves, where);
          saved += saves.length;
          for (const save of saves) {
            const starts = save.observations.map((o) => o.startMs);
            const fromFirst = starts.some((ms) => ms < secondStartsMs);
            const fromSecond = starts.some((ms) => ms >= secondStartsMs);
            if (!sameClub) assert.ok(!(fromFirst && fromSecond), `${where}: one save holds signals of both tags`);
          }
          const ofFirst = saves.filter((s) => s.observations.some((o) => o.kind === 'frames' && o.startMs < secondStartsMs));
          const ofSecond = saves.filter((s) => s.observations.some((o) => o.kind === 'frames' && o.startMs >= secondStartsMs));
          assert.ok(ofFirst.length <= 1 && ofSecond.length <= 1, `${where}: a transmission was saved twice`);
        }
      }
    }
    assert.ok(saved > 0, 'the pair is not refused every time');
  });
}

test('with a pause between clubs and the chip pressed in it, both clubs are saved in one pass each', () => {
  const a = CLIPS.sandWedge;
  const b = CLIPS.iron9;
  const ticks = decodeLive(join(a.audio, room(4.5), b.audio, room(TAIL_S)));
  const chips = [{ atMs: 0, clubId: a.club }, { atMs: quietAt(a.audio) + 2000, clubId: b.club }];
  const { saves } = runSession(ticks, chips, emptyCodebook());
  assert.deepEqual(saves.map((s) => s.clubId), ['wedgeSW', 'iron9']);
  assert.deepEqual(saves.map(kindsOf), [['resting', 'tone', 'hop'], ['resting', 'tone', 'hop']]);
  assertNothingWrong(saves, 'sand wedge then 9 iron');
});

/* ------------------------------ listening begins mid-transmission ------------------------------ */

test('listening that begins part-way through a transmission never saves anything wrong', () => {
  let saved = 0;
  for (const clip of [CLIPS.putterHit, CLIPS.putterWeak, CLIPS.iron9, CLIPS.sandWedge, CLIPS.putterWake]) {
    for (let fromS = 0.5; fromS <= 3; fromS += 0.5) {
      const ticks = decodeLive(join(clip.audio.subarray(Math.round(fromS * SR)), room(TAIL_S)));
      for (const codebook of [emptyCodebook(), codebookWith(EVERY_CLUB)]) {
        const { saves } = runSession(ticks, [{ atMs: 0, clubId: clip.club }], codebook);
        assert.ok(saves.length <= 1);
        assertNothingWrong(saves, `${clip.club} from ${fromS} s`);
        saved += saves.length;
      }
    }
  }
  assert.ok(saved > 0);
});

/* ------------------------------ the rules, on made-up events ------------------------------ */

const PUTTER = TAGS.putter.rest;
const PUTTER_HIT = TAGS.putter.hit;
const frames = (symbols, startMs, endMs, repeats, total = repeats) => ({ type: 'frames', startMs, endMs, restHz: 17912, symbols, repeats, frames: total, periodMs: 171.7 });
const tone = (hz, startMs, endMs) => ({ type: 'tone', startMs, endMs, hz });
const hop = (startMs, endMs, hops = 10) => ({ type: 'hop', startMs, endMs, restHz: 18904, offsetHz: 408, periodMs: 61, hops });
const impact = (startMs) => ({ type: 'impact', startMs, endMs: startMs + 20, riseDb: 30 });

/**
 * @param {object} session
 * @param {object[]} events
 * @param {number} nowMs
 * @param {object} [more] other stepSession inputs
 * @returns {{session: object, action: object|null}}
 */
function step(session, events, nowMs, more = {}) {
  return stepSession(session, { events, nowMs, clubId: 'putter', codebook: emptyCodebook(), autoSave: true, ...more });
}

const WAKE = tone(19810, 500, 900);
const REST = frames(PUTTER, 1500, 4000, 14);

test('a reading is judged once, when nothing has been heard for the quiet time', () => {
  let { session, action } = step(newSession(0), [WAKE, REST], 4000 + AUTO_SAVE_QUIET_MS - 1);
  assert.equal(action, null);
  ({ session, action } = step(session, [WAKE, REST], 4000 + AUTO_SAVE_QUIET_MS));
  assert.equal(action.type, 'save');
  assert.equal(action.clubId, 'putter');
  assert.deepEqual(action.events.map((e) => e.event.type), ['frames', 'tone']);
  // The save has not come back yet, or failed: the same reading is not offered again.
  for (const nowMs of [5750, 6000, 9000]) {
    ({ session, action } = step(session, [WAKE, REST], nowMs));
    assert.equal(action, null);
  }
});

test('a tap alone does not keep a transmission open', () => {
  let { session, action } = step(newSession(0), [WAKE, REST], 4250);
  ({ session, action } = step(session, [WAKE, REST, impact(5000)], 4000 + AUTO_SAVE_QUIET_MS));
  assert.equal(action.type, 'save');
});

test('a refused reading is frozen: later decodes of the same audio neither change it nor save it', () => {
  const weak = frames(PUTTER, 1500, 4000, 1, 8);
  let { session, action } = step(newSession(0), [WAKE, weak], 5500);
  assert.deepEqual([action.type, action.reason], ['refuse', 'no-frame']);
  const held = session.reading;
  // The window slides: the same frames now read solidly, and a tone shows up that was missed.
  const later = [tone(19810, 1000, 1300), frames(PUTTER, 1750, 4000, 9, 10)];
  for (const nowMs of [9500, 9750, 10000]) {
    ({ session, action } = step(session, later, nowMs, { windowStartMs: nowMs - 8000 }));
    assert.equal(action, null);
    assert.equal(session.reading, held);
  }
  // Nor does pressing another chip save it.
  ({ session, action } = step(session, later, 10250, { clubId: 'driver' }));
  assert.equal(action, null);
  assert.equal(session.refusal, 'no-frame');
});

test('the next signal after a judged reading starts a new reading; the old one is dropped', () => {
  const weak = frames(PUTTER, 1500, 4000, 1, 8);
  let { session } = step(newSession(0), [WAKE, weak], 5500);
  const nextWake = tone(18803, 7000, 7400);
  const nextRest = frames(TAGS.iron9.rest, 7900, 10000, 12);
  ({ session } = step(session, [WAKE, weak, nextWake], 7500, { clubId: 'iron9' }));
  assert.equal(session.reading.frames, null);
  assert.equal(session.reading.tone.hz, 18803);
  let action;
  ({ session, action } = step(session, [weak, nextWake, nextRest], 11500, { clubId: 'iron9' }));
  assert.equal(action.type, 'save');
  assert.equal(action.clubId, 'iron9');
  assert.deepEqual(action.events.map((e) => e.event), [nextRest, nextWake]);
});

test('a chip pressed while a reading is held stops that reading saving by itself', () => {
  let { session, action } = step(newSession(0), [WAKE, REST], 4250);
  ({ session, action } = step(session, [WAKE, REST], 4500, { clubId: 'driver' }));
  ({ session, action } = step(session, [WAKE, REST], 5500, { clubId: 'driver' }));
  assert.deepEqual([action.type, action.reason, action.clubId], ['refuse', 'club-changed', 'driver']);
});

test('a chip pressed before the tag is lit is the club the reading belongs to', () => {
  // A stray tone starts a reading; the chip is pressed; then, before that tone has been
  // judged, the tag is lit.
  const stray = tone(19000, 100, 300);
  let { session, action } = step(newSession(0), [stray], 500, { clubId: 'driver' });
  ({ session, action } = step(session, [stray], 1000));
  const wake = tone(19810, 1200, 1600);
  const rest = frames(PUTTER, 2100, 5000, 14);
  ({ session, action } = step(session, [stray, wake, rest], 6500));
  assert.equal(action.type, 'save');
  assert.equal(action.clubId, 'putter');
});

test('a reading recognised as a saved club goes to that club, and pressing that club’s chip changes nothing', () => {
  const codebook = codebookWith(['putter']);
  let { session, action } = step(newSession(0), [WAKE, REST], 4250, { clubId: 'driver', codebook });
  assert.equal(session.clubId, 'putter');
  ({ session, action } = step(session, [WAKE, REST], 5500, { clubId: 'putter', codebook }));
  assert.equal(action.type, 'save');
  assert.equal(action.clubId, 'putter');
});

test('with saving by itself switched off, the reading is still frozen when the tag goes quiet', () => {
  let { session, action } = step(newSession(0), [WAKE, REST], 5500, { autoSave: false });
  assert.equal(action, null);
  assert.equal(session.judgedMs, 4000);
  const held = session.reading;
  ({ session, action } = step(session, [frames(PUTTER_HIT, 2000, 4000, 9)], 10000, { autoSave: true, windowStartMs: 2000 }));
  assert.equal(action, null);
  assert.equal(session.reading, held);
});

test('with no club chosen a tag is only identified: nothing is saved or refused, known tag or not', () => {
  const saved = addObservation(emptyCodebook(), 'putter', observationFromEvent(REST, { at: '2026-11-20T00:00:00.000Z' }));
  for (const codebook of [emptyCodebook(), saved]) {
    let { session, action } = step(newSession(0, null), [WAKE, REST], 5500, { clubId: null, codebook });
    assert.equal(action, null);
    assert.equal(session.judgedMs, 4000);
    // The same audio decoded again, and then the next tag, still save nothing.
    ({ session, action } = step(session, [WAKE, REST], 6000, { clubId: null, codebook }));
    assert.equal(action, null);
    ({ session, action } = step(session, [frames(PUTTER_HIT, 7000, 9000, 9)], 11000, { clubId: null, codebook }));
    assert.equal(action, null);
    assert.equal(session.judgedMs, 9000);
  }
});

test('every tap heard since the reading began is counted once, however often the window is decoded', () => {
  const click = (startMs, riseDb = 30) => ({ type: 'impact', startMs, endMs: startMs + 20, riseDb });
  const idle = { clubId: null };
  // The flashlight's click before the tag wakes is not a hit on this tag.
  let { session } = step(newSession(0, null), [click(100), WAKE, REST, click(2500)], 3000, idle);
  assert.deepEqual(session.taps.map((t) => t.startMs), [2500]);
  // The same click read 40 ms later by the next decode, and two more taps.
  ({ session } = step(session, [WAKE, REST, click(2540), click(3100, 24), click(3600)], 4000, idle));
  assert.deepEqual(session.taps.map((t) => t.startMs), [2500, 3100, 3600]);
  assert.equal(session.taps[1].riseDb, 24);
  // The window has slid past the first taps: they stay counted.
  ({ session } = step(session, [REST, click(3600)], 5500, idle));
  assert.equal(session.taps.length, 3);
  assert.equal(session.judgedMs, 4000);
  // Judged: a click afterwards belongs to nothing, and the next tag starts from none.
  ({ session } = step(session, [click(6000)], 6500, idle));
  assert.equal(session.taps.length, 3);
  ({ session } = step(session, [tone(19810, 7000, 7400), click(7600)], 7700, idle));
  assert.deepEqual(session.taps.map((t) => t.startMs), [7600]);
});

test('a tap is a hit only when the tag answers it: three hits on a 7 iron, two flashlight clicks ignored', () => {
  // Times measured on a recording: taps at 4.31, 10.53 and 23.49 s were hits; the
  // clicks at 25.94 and 26.17 s, as the light was put down and the signal ended, were not.
  const IRON7 = [-4, -2, 2, 3, -4, -3];
  const click = (startMs, riseDb) => ({ type: 'impact', startMs, endMs: startMs + 20, riseDb });
  const hopFrom = (startMs, endMs) => ({ type: 'hop', startMs, endMs, restHz: 18784, offsetHz: 405, periodMs: 61, hops: 30 });
  const idle = { clubId: null };
  let { session } = step(newSession(0, null), [frames(IRON7, 0, 4322, 25), click(4310, 38), hopFrom(4322, 6000)], 6000, idle);
  assert.equal(hitsOf(session).length, 1);
  ({ session } = step(session, [hopFrom(4322, 10713), click(10533, 30), hopFrom(10733, 12000)], 12000, idle));
  assert.equal(hitsOf(session).length, 2);
  // The window has slid: the pattern is seen cut at its edge, which is not a new answer.
  ({ session } = step(session, [hopFrom(16000, 17000), frames(IRON7, 17200, 23494, 30), click(20000, 30)], 23400, {
    ...idle,
    windowStartMs: 16000,
  }));
  assert.equal(hitsOf(session).length, 2, 'a tap the tag did not answer, and a cut view, add nothing');
  ({ session } = step(
    session,
    [frames(IRON7, 17200, 23494, 30), click(23494, 30), hopFrom(23494, 25936), click(25937, 25), click(26167, 21)],
    26200,
    { ...idle, windowStartMs: 18200 }
  ));
  assert.deepEqual(hitsOf(session).map((t) => t.startMs), [4310, 10533, 23494]);
  assert.equal(session.taps.length, 6);
});

test('listening that ends before the quiet time freezes what is held, once, and an empty session is left alone', () => {
  const empty = newSession(0, null);
  assert.equal(closeSession(empty), empty);
  const { session } = step(empty, [WAKE, REST], 4200, { clubId: null });
  assert.equal(session.judgedMs, null);
  const closed = closeSession(session);
  assert.equal(closed.judgedMs, 4000);
  assert.equal(closed.reading, session.reading);
  assert.equal(closeSession(closed), closed);
});

test('a hit while the hit signal is already running counts; a click as the signal ends does not', () => {
  const IRON9 = [4, -1, -2, 1, -4, -3];
  const click = (startMs) => ({ type: 'impact', startMs, endMs: startMs + 20, riseDb: 30 });
  const hopFrom = (startMs, endMs) => ({ type: 'hop', startMs, endMs, restHz: 18904, offsetHz: 409, periodMs: 61, hops: 30 });
  const idle = { clubId: null };
  let { session } = step(newSession(0, null), [frames(IRON9, 0, 2000, 12), click(2000), hopFrom(2010, 3500), click(3000)], 3500, idle);
  assert.deepEqual(hitsOf(session).map((t) => t.startMs), [2000, 3000]);
  ({ session } = step(session, [frames(IRON9, 0, 2000, 12), hopFrom(2010, 8000)], 8000, idle));
  // The pattern has slid past the window's edge and is seen cut: it still vouches for a tap.
  ({ session } = step(session, [hopFrom(4000, 12000), click(11000), click(11990)], 12100, { ...idle, windowStartMs: 4000 }));
  assert.deepEqual(hitsOf(session).map((t) => t.startMs), [2000, 3000, 11000]);
  assert.deepEqual(session.answers, [{ startMs: 2010, endMs: 12000, fromRest: true }]);
});

test('the club rattling 0.3 s after a hit is the same hit, not a second one', () => {
  // Times measured on a recording, 56 degree wedge hit once: clicks at 4551 ms (31 dB) and 4852 ms (15 dB),
  // the hit pattern running from 4561 ms; then the light put down after the signal ended.
  const WEDGE56 = [1, 3, 4, -3, 4, -3];
  const click = (startMs, riseDb) => ({ type: 'impact', startMs, endMs: startMs + 20, riseDb });
  const hop = { type: 'hop', startMs: 4561, endMs: 6755, restHz: 18823, offsetHz: 301, periodMs: 122, hops: 18 };
  const idle = { clubId: null };
  let { session } = step(newSession(0, null), [frames(WEDGE56, 923, 4561, 9), click(4551, 31), click(4852, 15), hop], 6800, idle);
  assert.deepEqual(hitsOf(session).map((t) => t.startMs), [4551]);
  // A second hit a second later is its own hit.
  ({ session } = step(session, [click(4551, 31), click(4852, 15), { ...hop, endMs: 7500 }, click(5600, 30)], 7500, idle));
  assert.deepEqual(hitsOf(session).map((t) => t.startMs), [4551, 5600]);
});

test('the faint driver, whose pattern is picked up 430 ms after the tap, is one hit, heard or not; a pattern with no resting frame before it is none', () => {
  const DRIVER = [-2, 3, -2, -3, -4, -3];
  const hopFrom = (startMs, endMs) => ({ type: 'hop', startMs, endMs, restHz: 18859, offsetHz: 406, periodMs: 101, hops: 20 });
  const tapAt = { type: 'impact', startMs: 5440, endMs: 5460, riseDb: 30 };
  const idle = { clubId: null };
  let { session } = step(newSession(0, null), [frames(DRIVER, 850, 5460, 26), tapAt, hopFrom(5880, 8780)], 8800, idle);
  assert.equal(hitsOf(session).length, 1);
  // The click was too soft to register: the pattern beginning out of the resting frame is the hit.
  ({ session } = step(newSession(0, null), [frames(DRIVER, 850, 5460, 26), hopFrom(5880, 8780)], 8800, idle));
  assert.deepEqual(hitsOf(session), [{ startMs: 5880, riseDb: null }]);
  // The tail of a pattern after a dropout, with no resting frame before it, is not a hit.
  ({ session } = step(newSession(0, null), [hopFrom(5880, 8780)], 8800, idle));
  assert.equal(hitsOf(session).length, 0);
});

test('the putter hit twice in one lighting is two hits, though the second click was not heard', () => {
  // Times measured on a recording: tap at 2512 ms, hit frame 2564 to 4683 ms, resting frame back, hit frame
  // again 6903 to 9055 ms with no click heard, then the light put down at 9564 and 9790 ms.
  const click = (startMs, riseDb) => ({ type: 'impact', startMs, endMs: startMs + 20, riseDb });
  const idle = { clubId: null };
  const heard = [
    frames(PUTTER, 1001, 2564, 9),
    click(2512, 22),
    frames(PUTTER_HIT, 2564, 4683, 12),
    frames(PUTTER, 4683, 6903, 13),
    frames(PUTTER_HIT, 6903, 9055, 12),
    frames(PUTTER, 9055, 9829, 4),
    click(9564, 35),
    click(9790, 26),
  ];
  // Fed as it grew, the way the live window sees it.
  let session = newSession(0, null);
  for (const nowMs of [2400, 3600, 5000, 7600, 9900]) {
    ({ session } = step(
      session,
      heard.filter((e) => e.startMs < nowMs).map((e) => ({ ...e, endMs: Math.min(e.endMs, nowMs) })),
      nowMs,
      idle
    ));
  }
  assert.deepEqual(hitsOf(session).map((h) => [h.startMs, h.riseDb]), [[2512, 22], [6903, null]]);
});

test('a hit pattern that drops out and comes back is still one hit', () => {
  // Times measured on a recording, 56 degree wedge hit once: the pattern read as 2240 to 3684 and 3722 to 4527 ms.
  const WEDGE56 = [1, 3, 4, -3, 4, -3];
  const hopFrom = (startMs, endMs) => ({ type: 'hop', startMs, endMs, restHz: 18823, offsetHz: 301, periodMs: 122, hops: 10 });
  const tapAt = { type: 'impact', startMs: 2232, endMs: 2252, riseDb: 33 };
  const { session } = step(
    newSession(0, null),
    [frames(WEDGE56, 899, 2240, 7), tapAt, hopFrom(2240, 3684), hopFrom(4300, 5200)],
    5300,
    { clubId: null }
  );
  assert.deepEqual(hitsOf(session).map((h) => h.startMs), [2232]);
  // A dropout only 0.4 s into the pattern (9 wood, from a recording): the pattern coming
  // back is within reach of the resting frame's end, but more pattern lies between them.
  const early = step(
    newSession(0, null),
    [frames(WEDGE56, 900, 2008, 6), { ...tapAt, startMs: 1993 }, hopFrom(2008, 2408), hopFrom(2496, 4282)],
    4300,
    { clubId: null }
  );
  assert.deepEqual(hitsOf(early.session).map((h) => h.startMs), [1993]);
});

test('a view cut by the sliding window confirms a held frame but never brings in a new one', () => {
  const hit = frames(PUTTER_HIT, 4000, 9000, 20);
  let { session } = step(newSession(0), [WAKE, REST, impact(3950), hit], 9000);
  assert.deepEqual(session.reading.hitFrames.symbols, PUTTER_HIT);
  // The window now begins at 3000: the resting frame is cut short and reads as something else.
  const cut = frames([-2, -2, -1, -3, -1, 1], 3000, 4000, 5, 6);
  ({ session } = step(session, [cut, impact(3950), frames(PUTTER_HIT, 4000, 9250, 21)], 9250, { windowStartMs: 3000 }));
  assert.deepEqual(session.reading.frames.symbols, PUTTER);
  assert.deepEqual(session.reading.hitFrames.symbols, PUTTER_HIT);
  assert.equal(session.reading.hitFrames.repeats, 21);
});

test('a new session hears only what begins after it was made: Stop then Start, and Clear', () => {
  let { session, action } = step(newSession(5000), [WAKE, REST], 5500);
  assert.equal(action, null);
  assert.equal(session.reading.frames, null);
  // A transmission still going when the session was made is not picked up half-way.
  ({ session, action } = step(session, [frames(PUTTER, 1500, 6000, 25)], 7500));
  assert.equal(action, null);
  assert.equal(session.reading.frames, null);
});

test('when a save comes back, a transmission that began while it ran is kept', () => {
  let { session, action } = step(newSession(0), [WAKE, REST], 5500);
  assert.equal(action.type, 'save');
  const nextWake = tone(18803, 5600, 6000);
  // Not yet heard when the save comes back: everything after the judged point can still be.
  let settled = settleSave(session, action.judgedMs);
  assert.equal(settled.reading.frames, null);
  ({ session: settled } = step(settled, [WAKE, REST, nextWake], 6000, { clubId: 'iron9' }));
  assert.equal(settled.reading.tone, nextWake);
  assert.equal(settled.reading.frames, null);
  // Already heard when the save comes back: the new reading is left as it is.
  ({ session } = step(session, [WAKE, REST, nextWake], 6000, { clubId: 'iron9' }));
  assert.equal(settleSave(session, action.judgedMs), session);
  assert.equal(session.reading.tone, nextWake);
});

test('saving by itself leaves out a tone that came after the resting frame and a hit frame read too briefly', () => {
  const lateTone = tone(18720, 4200, 4600);
  const briefHit = frames(PUTTER_HIT, 4000, 4700, 3);
  const reading = { ...mergeReading(emptyReading(), [REST]), tone: lateTone, hitFrames: briefHit };
  assert.deepEqual(eventsToSave(reading, null, { bySelf: true }).map((e) => e.event), [REST]);
  // Pressing Save saves what the tiles show.
  assert.deepEqual(eventsToSave(reading, null).map((e) => [e.event, e.role]), [[REST, undefined], [briefHit, 'hit'], [lateTone, undefined]]);
});

test('a frame the club already has is saved under its saved role, whichever way round it was heard', () => {
  const summary = { frame: { symbols: PUTTER }, hitFrame: { symbols: PUTTER_HIT }, toneHz: null, hop: null };
  const backwards = { ...emptyReading(), frames: frames(PUTTER_HIT, 0, 2000, 9), hitFrames: frames(PUTTER, 2000, 4000, 9) };
  assert.deepEqual(eventsToSave(backwards, summary).map((e) => e.role), ['hit', undefined]);
});

test('a hop pattern that began before the frame is the tag before, and is not saved with this one', () => {
  const earlier = hop(0, 2800, 40);
  let { session, action } = step(newSession(0), [earlier], 2800, { clubId: 'iron9' });
  const wake = tone(19810, 2900, 3300);
  const rest = frames(PUTTER, 3800, 6000, 12);
  ({ session, action } = step(session, [earlier, wake, rest], 7500));
  assert.equal(session.reading.hop, null);
  // The chip was pressed while the 9 iron was still hopping, so this one waits for Save.
  assert.deepEqual([action.type, action.reason], ['refuse', 'club-changed']);
});
