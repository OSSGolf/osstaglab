import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CODEBOOK_VERSION,
  MAX_OBSERVATIONS_PER_KIND,
  emptyCodebook,
  normalizeCodebook,
  observationFromEvent,
  addObservation,
  removeClub,
  clubSummary,
  matchFrame,
  matchTone,
  collisions,
  isSolidFrames,
  isLosslessCodebook,
} from '../web/codebook.js';

const PUTTER = [-4, -2, -1, -3, -1, 1];
const WEDGE = [1, 3, 4, -3, 4, -3];
const IRON9 = [4, -1, -2, 1, -4, -3];

/** Recursively freezes an object so any mutation throws in strict mode. */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function at(day) {
  return `2026-11-${String(day).padStart(2, '0')}T10:00:00Z`;
}

function frameObs(symbols, restHz, day = 1, extra = {}) {
  return {
    kind: 'frames',
    at: at(day),
    device: null,
    symbols,
    restHz,
    repeats: 10,
    frames: 10,
    ...extra,
  };
}

function toneObs(hz, day = 1) {
  return { kind: 'tone', at: at(day), device: null, hz };
}

function hopObs(restHz, offsetHz, periodMs, day = 1) {
  return { kind: 'hop', at: at(day), device: null, restHz, offsetHz, periodMs, hops: 20 };
}

/** Builds a codebook from { clubId: observations[] }. */
function book(clubs) {
  let cb = emptyCodebook();
  for (const [clubId, observations] of Object.entries(clubs)) {
    for (const obs of observations) cb = addObservation(cb, clubId, obs);
  }
  return cb;
}

test('CODEBOOK_VERSION is 1 and the per-kind cap is 20', () => {
  assert.equal(CODEBOOK_VERSION, 1);
  assert.equal(MAX_OBSERVATIONS_PER_KIND, 20);
});

test('emptyCodebook has the version and no clubs, and is a fresh object each call', () => {
  const a = emptyCodebook();
  assert.deepEqual(a, { version: 1, revision: 0, clubs: {} });
  assert.notEqual(a, emptyCodebook());
  assert.notEqual(a.clubs, emptyCodebook().clubs);
});

test('normalizeCodebook throws TypeError for a non-object', () => {
  for (const raw of [null, undefined, 3, 'codebook', [], [{ version: 1 }]]) {
    assert.throws(() => normalizeCodebook(raw), TypeError);
  }
});

test('normalizeCodebook throws TypeError for a missing or wrong version', () => {
  assert.throws(() => normalizeCodebook({ clubs: {} }), TypeError);
  assert.throws(() => normalizeCodebook({ version: 2, clubs: {} }), TypeError);
  assert.throws(() => normalizeCodebook({ version: '1', clubs: {} }), TypeError);
});

test('normalizeCodebook accepts a valid codebook and returns an equal copy', () => {
  const raw = deepFreeze(book({ 'club-a': [frameObs(PUTTER, 17920), toneObs(18728)] }));
  const clean = normalizeCodebook(raw);
  assert.deepEqual(clean, raw);
  assert.notEqual(clean, raw);
});

test('normalizeCodebook drops malformed observations and keeps the good ones', () => {
  const raw = {
    version: 1,
    clubs: {
      good: {
        observations: [
          frameObs(PUTTER, 17920),
          { ...frameObs(PUTTER, 17920), symbols: [1, 2, 3] },
          { ...frameObs(PUTTER, 17920), symbols: [1, 0, 2, 3, 4, 5] },
          { ...frameObs(PUTTER, 17920), symbols: [1.5, 2, 3, 4, 5, 6] },
          { ...frameObs(PUTTER, 17920), restHz: NaN },
          { ...frameObs(PUTTER, 17920), repeats: 11 },
          { ...frameObs(PUTTER, 17920), at: 'not a date' },
          { ...frameObs(PUTTER, 17920), kind: 'wobble' },
          { kind: 'tone', at: at(1), hz: Infinity },
          { kind: 'tone', at: at(1), hz: '18000' },
          { kind: 'hop', at: at(1), restHz: 18830, offsetHz: 300, periodMs: 0, hops: 20 },
          { kind: 'hop', at: at(1), restHz: 18830, offsetHz: 300, periodMs: 121.7, hops: 0 },
          null,
          'tone',
          toneObs(18728),
        ],
      },
    },
  };
  const clean = normalizeCodebook(raw);
  assert.equal(clean.clubs.good.observations.length, 2);
  assert.equal(clean.clubs.good.observations[0].kind, 'frames');
  assert.equal(clean.clubs.good.observations[1].kind, 'tone');
});

test('normalizeCodebook drops malformed clubs and keeps well-formed ones', () => {
  const raw = {
    version: 1,
    clubs: {
      ok: { observations: [toneObs(18728)] },
      notObject: 'nope',
      noList: { observations: 'nope' },
      nullEntry: null,
    },
  };
  const clean = normalizeCodebook(raw);
  assert.deepEqual(Object.keys(clean.clubs), ['ok']);
});

test('normalizeCodebook tolerates a missing clubs map and an absent device', () => {
  assert.deepEqual(normalizeCodebook({ version: 1 }), { version: 1, revision: 0, clubs: {} });
  const clean = normalizeCodebook({
    version: 1,
    clubs: { a: { observations: [{ kind: 'tone', at: at(1), hz: 18728 }] } },
  });
  assert.equal(clean.clubs.a.observations[0].device, null);
});

test('normalizeCodebook keeps a club id of __proto__ as an ordinary key', () => {
  const raw = JSON.parse('{"version":1,"clubs":{"__proto__":{"observations":[]}}}');
  const clean = normalizeCodebook(raw);
  assert.equal(Object.getPrototypeOf(clean.clubs), Object.prototype);
  assert.deepEqual(Object.keys(clean.clubs), ['__proto__']);
});

test('normalizeCodebook enforces the per-kind cap, keeping the newest', () => {
  const observations = [];
  for (let i = 0; i < MAX_OBSERVATIONS_PER_KIND + 5; i++) {
    observations.push(toneObs(18000 + i, 1 + i));
  }
  const clean = normalizeCodebook({ version: 1, clubs: { a: { observations } } });
  const kept = clean.clubs.a.observations;
  assert.equal(kept.length, MAX_OBSERVATIONS_PER_KIND);
  assert.equal(kept[0].hz, 18005);
  assert.equal(kept.at(-1).hz, 18024);
});

test('observationFromEvent converts a frames event', () => {
  const event = {
    type: 'frames',
    startMs: 100,
    endMs: 1800,
    restHz: 17920,
    symbols: PUTTER,
    repeats: 9,
    frames: 10,
    periodMs: 172.7,
  };
  assert.deepEqual(observationFromEvent(event, { at: at(3), device: 'iPhone' }), {
    kind: 'frames',
    at: at(3),
    device: 'iPhone',
    symbols: PUTTER,
    restHz: 17920,
    repeats: 9,
    frames: 10,
  });
});

test('observationFromEvent converts a hop event and a tone event', () => {
  const hop = {
    type: 'hop',
    startMs: 0,
    endMs: 900,
    restHz: 18830,
    offsetHz: 300,
    periodMs: 121.7,
    hops: 7,
  };
  assert.deepEqual(observationFromEvent(hop, { at: at(2) }), {
    kind: 'hop',
    at: at(2),
    device: null,
    restHz: 18830,
    offsetHz: 300,
    periodMs: 121.7,
    hops: 7,
  });
  const tone = { type: 'tone', startMs: 0, endMs: 320, hz: 18728 };
  assert.deepEqual(observationFromEvent(tone, { at: at(2), device: 'mic' }), {
    kind: 'tone',
    at: at(2),
    device: 'mic',
    hz: 18728,
  });
});

test('observationFromEvent throws RangeError on an unknown event type', () => {
  assert.throws(
    () => observationFromEvent({ type: 'chirp', startMs: 0, endMs: 1 }, { at: at(1) }),
    RangeError,
  );
});

test('observationFromEvent throws RangeError on a malformed event or date', () => {
  const event = { type: 'tone', startMs: 0, endMs: 320, hz: 18728 };
  assert.throws(() => observationFromEvent(event, { at: 'yesterday' }), RangeError);
  assert.throws(() => observationFromEvent({ ...event, hz: NaN }, { at: at(1) }), RangeError);
});

test('addObservation appends and returns a new codebook without touching the input', () => {
  const before = deepFreeze(emptyCodebook());
  const after = addObservation(before, 'club-a', toneObs(18728));
  assert.deepEqual(before, { version: 1, revision: 0, clubs: {} });
  assert.equal(after.clubs['club-a'].observations.length, 1);
  assert.notEqual(after, before);
});

test('addObservation rejects a malformed observation and a bad club id', () => {
  const cb = emptyCodebook();
  assert.throws(() => addObservation(cb, 'club-a', { kind: 'tone', at: at(1), hz: -5 }), RangeError);
  assert.throws(() => addObservation(cb, '', toneObs(18728)), TypeError);
  assert.throws(() => addObservation(null, 'club-a', toneObs(18728)), TypeError);
});

test('addObservation keeps only the newest 20 observations of each kind', () => {
  let cb = emptyCodebook();
  for (let i = 0; i < 25; i++) cb = addObservation(cb, 'a', toneObs(18000 + i, 1 + i));
  for (let i = 0; i < 3; i++) cb = addObservation(cb, 'a', hopObs(18830, 300, 121.7, 1 + i));
  const obs = cb.clubs.a.observations;
  const tones = obs.filter((o) => o.kind === 'tone');
  assert.equal(tones.length, MAX_OBSERVATIONS_PER_KIND);
  assert.equal(tones[0].hz, 18005);
  assert.equal(tones.at(-1).hz, 18024);
  assert.equal(obs.filter((o) => o.kind === 'hop').length, 3);
});

test('addObservation orders by the at date, not by arrival, when deciding what is newest', () => {
  let cb = emptyCodebook();
  cb = addObservation(cb, 'a', toneObs(18500, 9));
  cb = addObservation(cb, 'a', toneObs(18600, 2));
  for (let i = 0; i < MAX_OBSERVATIONS_PER_KIND - 1; i++) {
    cb = addObservation(cb, 'a', toneObs(18000 + i, 10 + i));
  }
  const hz = cb.clubs.a.observations.map((o) => o.hz);
  assert.equal(hz.length, MAX_OBSERVATIONS_PER_KIND);
  assert.ok(!hz.includes(18600), 'the oldest-dated tone is the one dropped');
  assert.ok(hz.includes(18500));
});

test('addObservation does not let a 20-tone cap evict frames observations', () => {
  let cb = addObservation(emptyCodebook(), 'a', frameObs(PUTTER, 17920));
  for (let i = 0; i < 30; i++) cb = addObservation(cb, 'a', toneObs(18000 + i, 1 + i));
  assert.equal(cb.clubs.a.observations.filter((o) => o.kind === 'frames').length, 1);
});

test('removeClub deletes one club without mutating the input', () => {
  const before = deepFreeze(book({ a: [toneObs(18728)], b: [toneObs(18500)] }));
  const after = removeClub(before, 'a');
  assert.deepEqual(Object.keys(after.clubs), ['b']);
  assert.deepEqual(Object.keys(before.clubs), ['a', 'b']);
});

test('removeClub on an absent club returns an equal copy', () => {
  const before = deepFreeze(book({ a: [toneObs(18728)] }));
  const after = removeClub(before, 'missing');
  assert.deepEqual(after, before);
  assert.notEqual(after, before);
});

test('clubSummary of an empty club reports nothing', () => {
  assert.deepEqual(clubSummary({ observations: [] }), { frame: null, hitFrame: null, toneHz: null, hop: null });
});

test('clubSummary throws TypeError when there is no observations array', () => {
  assert.throws(() => clubSummary({}), TypeError);
  assert.throws(() => clubSummary(null), TypeError);
});

test('clubSummary takes the most frequent symbol sequence and its median rest', () => {
  const entry = {
    observations: [
      frameObs(PUTTER, 17900, 1),
      frameObs(PUTTER, 17920, 2),
      frameObs(WEDGE, 17830, 3),
      frameObs(PUTTER, 17940, 4),
    ],
  };
  const { frame } = clubSummary(entry);
  assert.deepEqual(frame.symbols, PUTTER);
  assert.equal(frame.restHz, 17920);
  assert.equal(frame.observations, 3);
  assert.equal(frame.consistent, false);
});

test('clubSummary breaks a frequency tie with the most recent sequence', () => {
  const older = {
    observations: [frameObs(PUTTER, 17920, 1), frameObs(WEDGE, 17830, 2)],
  };
  assert.deepEqual(clubSummary(older).frame.symbols, WEDGE);
  const newerPutter = {
    observations: [frameObs(WEDGE, 17830, 1), frameObs(PUTTER, 17920, 2)],
  };
  assert.deepEqual(clubSummary(newerPutter).frame.symbols, PUTTER);
});

test('clubSummary breaks ties by recency from at, not array position', () => {
  const entry = {
    observations: [frameObs(WEDGE, 17830, 5), frameObs(PUTTER, 17920, 2)],
  };
  assert.deepEqual(clubSummary(entry).frame.symbols, WEDGE);
});

test('clubSummary is consistent only when every frames observation agrees', () => {
  const agree = { observations: [frameObs(IRON9, 17910, 1), frameObs(IRON9, 17912, 2)] };
  assert.equal(clubSummary(agree).frame.consistent, true);
  assert.equal(clubSummary(agree).frame.observations, 2);
  const disagree = { observations: [frameObs(IRON9, 17910, 1), frameObs(PUTTER, 17912, 2)] };
  assert.equal(clubSummary(disagree).frame.consistent, false);
});

test('clubSummary reports the median tone and the median hop', () => {
  const entry = {
    observations: [
      toneObs(18700, 1),
      toneObs(18740, 2),
      toneObs(18800, 3),
      toneObs(18730, 4),
      hopObs(18830, 300, 121.7, 1),
      hopObs(18832, 300, 121.5, 2),
      hopObs(18820, 310, 122.1, 3),
    ],
  };
  const summary = clubSummary(entry);
  assert.equal(summary.toneHz, (18730 + 18740) / 2);
  assert.deepEqual(summary.hop, { restHz: 18830, offsetHz: 300, periodMs: 121.7 });
  assert.equal(summary.frame, null);
});

test('clubSummary gives a single median for an even count of tones', () => {
  const entry = { observations: [toneObs(18700, 1), toneObs(18800, 2)] };
  assert.equal(clubSummary(entry).toneHz, 18750);
});

test('two clubs with the same rest tone but different symbols do not match each other', () => {
  const cb = book({
    putter: [frameObs(PUTTER, 17920)],
    wedge: [frameObs(WEDGE, 17920)],
  });
  assert.deepEqual(matchFrame(cb, PUTTER), ['putter']);
  assert.deepEqual(matchFrame(cb, WEDGE), ['wedge']);
  assert.deepEqual(matchFrame(cb, IRON9), []);
});

test('matchFrame matches on symbols exactly, including length', () => {
  const cb = book({ putter: [frameObs(PUTTER, 17920)] });
  assert.deepEqual(matchFrame(cb, [-4, -2, -1, -3, -1]), []);
  assert.deepEqual(matchFrame(cb, [-4, -2, -1, -3, -1, 2]), []);
  assert.deepEqual(matchFrame(cb, [-4, -2, -1, -3, -1, 1]), ['putter']);
});

test('matchFrame returns sorted club ids and ignores clubs without frames', () => {
  const cb = book({
    zeta: [frameObs(PUTTER, 17920)],
    alpha: [frameObs(PUTTER, 17900)],
    tonal: [toneObs(18728)],
  });
  assert.deepEqual(matchFrame(cb, PUTTER), ['alpha', 'zeta']);
});

test('matchFrame rejects a non-array argument', () => {
  assert.throws(() => matchFrame(emptyCodebook(), 'abc'), TypeError);
});

test('matchTone returns clubs within tolerance, nearest first', () => {
  const cb = book({
    far: [toneObs(18750)],
    near: [toneObs(18735)],
    exact: [toneObs(18728)],
    gone: [toneObs(18500)],
  });
  assert.deepEqual(matchTone(cb, 18728), ['exact', 'near', 'far']);
});

test('matchTone includes the tolerance edge and excludes just beyond it', () => {
  const cb = book({ edge: [toneObs(18753)], beyond: [toneObs(18753.5)] });
  assert.deepEqual(matchTone(cb, 18728), ['edge']);
  assert.deepEqual(matchTone(cb, 18728, 25.5), ['edge', 'beyond']);
  assert.deepEqual(matchTone(cb, 18728, 0), []);
});

test('matchTone breaks equal distances by club id', () => {
  const cb = book({ b: [toneObs(18750)], a: [toneObs(18706)] });
  assert.deepEqual(matchTone(cb, 18728), ['a', 'b']);
});

test('matchTone ignores clubs without a tone and rejects bad arguments', () => {
  const cb = book({ frameOnly: [frameObs(PUTTER, 17920)] });
  assert.deepEqual(matchTone(cb, 17920), []);
  assert.throws(() => matchTone(cb, NaN), TypeError);
  assert.throws(() => matchTone(cb, 18728, -1), TypeError);
});

test('collisions reports symbol sequences shared by two or more clubs, with sorted ids', () => {
  const cb = book({
    zeta: [frameObs(PUTTER, 17920)],
    alpha: [frameObs(PUTTER, 17930)],
    wedge: [frameObs(WEDGE, 17830)],
  });
  assert.deepEqual(collisions(cb), [{ symbols: PUTTER, clubIds: ['alpha', 'zeta'] }]);
});

test('collisions is empty when every club has its own sequence or no frames', () => {
  const cb = book({
    putter: [frameObs(PUTTER, 17920)],
    wedge: [frameObs(WEDGE, 17830)],
    tonal: [toneObs(18728)],
  });
  assert.deepEqual(collisions(cb), []);
  assert.deepEqual(collisions(emptyCodebook()), []);
});

test('collisions compares each club summary, not every observation', () => {
  const cb = book({
    a: [frameObs(PUTTER, 17920, 1), frameObs(WEDGE, 17920, 2), frameObs(WEDGE, 17920, 3)],
    b: [frameObs(WEDGE, 17830, 1)],
  });
  assert.deepEqual(collisions(cb), [{ symbols: WEDGE, clubIds: ['a', 'b'] }]);
});

test('collisions sorts groups deterministically by symbols', () => {
  const cb = book({
    a1: [frameObs(WEDGE, 17830)],
    a2: [frameObs(WEDGE, 17830)],
    b1: [frameObs(PUTTER, 17920)],
    b2: [frameObs(PUTTER, 17920)],
  });
  const groups = collisions(cb);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((g) => g.clubIds), [
    ['b1', 'b2'],
    ['a1', 'a2'],
  ]);
});

test('isSolidFrames needs at least three repeats and half the frames agreeing', () => {
  assert.equal(isSolidFrames({ repeats: 3, frames: 6 }), true);
  assert.equal(isSolidFrames({ repeats: 3, frames: 7 }), false);
  assert.equal(isSolidFrames({ repeats: 2, frames: 2 }), false);
  assert.equal(isSolidFrames({ repeats: 10, frames: 10 }), true);
  assert.equal(isSolidFrames({ repeats: 5, frames: 10 }), true);
  assert.equal(isSolidFrames({ repeats: 4, frames: 9 }), false);
  assert.equal(isSolidFrames({ repeats: 5, frames: 9 }), true);
  assert.equal(isSolidFrames({ repeats: 0, frames: 0 }), false);
});

test('no function mutates a deep-frozen codebook', () => {
  const cb = deepFreeze(
    book({
      putter: [frameObs(PUTTER, 17920), toneObs(18728), hopObs(18830, 300, 121.7)],
      wedge: [frameObs(WEDGE, 17830)],
    }),
  );
  const snapshot = structuredClone(cb);
  const event = { type: 'tone', startMs: 0, endMs: 320, hz: 18700 };
  normalizeCodebook(cb);
  observationFromEvent(event, { at: at(4) });
  addObservation(cb, 'putter', toneObs(18600, 5));
  removeClub(cb, 'wedge');
  clubSummary(cb.clubs.putter);
  matchFrame(cb, PUTTER);
  matchTone(cb, 18728);
  collisions(cb);
  assert.deepEqual(cb, snapshot);
});

test('the revision is kept through normalise, add and remove, and defaults to 0 when unusable', () => {
  const loaded = normalizeCodebook({ version: 1, revision: 7, clubs: {} });
  assert.equal(loaded.revision, 7);
  const added = addObservation(loaded, 'club-a', toneObs(18728));
  assert.equal(added.revision, 7);
  assert.equal(removeClub(added, 'club-a').revision, 7);
  for (const revision of [-1, 1.5, '3', null, true]) {
    assert.equal(normalizeCodebook({ version: 1, revision, clubs: {} }).revision, 0);
  }
});

test('isLosslessCodebook is true only when normalising keeps everything', () => {
  const stored = addObservation(emptyCodebook(), 'club-a', toneObs(18728));
  assert.ok(isLosslessCodebook(stored));
  assert.ok(isLosslessCodebook(JSON.parse(JSON.stringify(stored))));
  const { revision, ...withoutRevision } = stored;
  assert.equal(revision, 0);
  assert.ok(isLosslessCodebook(withoutRevision), 'a missing revision is filled in, not lost');
  assert.ok(isLosslessCodebook({ clubs: stored.clubs, revision: 0, version: 1 }), 'key order does not matter');

  assert.ok(!isLosslessCodebook({ ...stored, note: 'hand-written' }), 'unknown top-level key');
  assert.ok(!isLosslessCodebook({ ...stored, clubs: { ...stored.clubs, b: { loft: 34 } } }), 'malformed club');
  const extraField = structuredClone(stored);
  extraField.clubs['club-a'].observations[0].comment = 'keep me';
  assert.ok(!isLosslessCodebook(extraField), 'unknown observation field');
  const badObservation = structuredClone(stored);
  badObservation.clubs['club-a'].observations.push({ kind: 'tone', at: at(2), hz: 'high' });
  assert.ok(!isLosslessCodebook(badObservation), 'malformed observation');
  assert.ok(!isLosslessCodebook({ version: 2, clubs: {} }), 'wrong version');
  assert.ok(!isLosslessCodebook(null));
});

/* ---------------------------- hit frames ---------------------------- */

const PUTTER_HIT = [1, 3, 4, 2, 4, -1];

function codebookWith(clubs) {
  return { version: CODEBOOK_VERSION, revision: 0, clubs };
}

test('a hit frame is summarised apart from the resting frame and does not make it inconsistent', () => {
  const entry = { observations: [frameObs(PUTTER, 17920, 1), frameObs(PUTTER_HIT, 17920, 2, { role: 'hit' })] };
  const summary = clubSummary(entry);
  assert.deepEqual(summary.frame.symbols, PUTTER);
  assert.equal(summary.frame.consistent, true);
  assert.deepEqual(summary.hitFrame.symbols, PUTTER_HIT);
});

test('matchFrame recognises a club by its hit frame as well as its resting frame', () => {
  const cb = codebookWith({
    putter: { observations: [frameObs(PUTTER, 17920, 1), frameObs(PUTTER_HIT, 17920, 2, { role: 'hit' })] },
  });
  assert.deepEqual(matchFrame(cb, PUTTER), ['putter']);
  assert.deepEqual(matchFrame(cb, PUTTER_HIT), ['putter']);
});

test('collisions reports a hit frame that is another club\'s resting frame, and not a club with itself', () => {
  const cb = codebookWith({
    putter: { observations: [frameObs(PUTTER, 17920, 1), frameObs(WEDGE, 17920, 2, { role: 'hit' })] },
    wedgeSW: { observations: [frameObs(WEDGE, 17830, 1)] },
    iron9: { observations: [frameObs(IRON9, 17910, 1), frameObs(IRON9, 17910, 2, { role: 'hit' })] },
  });
  assert.deepEqual(collisions(cb), [{ symbols: WEDGE, clubIds: ['putter', 'wedgeSW'] }]);
});

test('the hit role survives normalizing, and any other role makes the observation malformed', () => {
  const hit = frameObs(PUTTER_HIT, 17920, 2, { role: 'hit' });
  const raw = codebookWith({ putter: { observations: [frameObs(PUTTER, 17920, 1), hit] } });
  assert.equal(normalizeCodebook(raw).clubs.putter.observations[1].role, 'hit');
  assert.ok(!('role' in normalizeCodebook(raw).clubs.putter.observations[0]));
  assert.ok(isLosslessCodebook(raw));
  const bad = codebookWith({ putter: { observations: [frameObs(PUTTER, 17920, 1, { role: 'rest' })] } });
  assert.ok(!isLosslessCodebook(bad));
});

test('observationFromEvent marks a hit frame only when asked', () => {
  const event = { type: 'frames', symbols: PUTTER_HIT, restHz: 17920, repeats: 8, frames: 10 };
  assert.equal(observationFromEvent(event, { at: at(1), role: 'hit' }).role, 'hit');
  assert.ok(!('role' in observationFromEvent(event, { at: at(1) })));
  assert.throws(() => observationFromEvent(event, { at: at(1), role: 'other' }), RangeError);
});

test('savedFrameRole names which saved frame a symbol sequence is', async () => {
  const { savedFrameRole } = await import('../web/codebook.js');
  const summary = clubSummary({
    observations: [frameObs(PUTTER, 17920, 1), frameObs(PUTTER_HIT, 17920, 2, { role: 'hit' })],
  });
  assert.equal(savedFrameRole(summary, PUTTER), 'resting');
  assert.equal(savedFrameRole(summary, PUTTER_HIT), 'hit');
  assert.equal(savedFrameRole(summary, WEDGE), null);
});
