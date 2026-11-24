import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { decodeWav } from '../web/dsp.js';
import {
  ATTACH_BEFORE_MS,
  AUTO_SAVE_MIN_REPEATS,
  autoSaveBlock,
  emptyReading,
  isEmptyReading,
  labelEvents,
  mergeReading,
  sameSymbols,
} from '../web/reading.js';
import { ToneTracker, classify } from '../web/tag-decoder.js';
import { addNoise, concat, silence, synthFrames, synthHop, synthTone } from '../web/tag-synth.js';

const PUTTER = [-4, -2, -1, -3, -1, 1];
const SAND_WEDGE = [1, 3, 4, -3, 4, -3];

/**
 * @param {number[]} symbols
 * @param {number} startMs
 * @param {number} endMs
 * @param {number} repeats
 * @param {number} [frames]
 * @returns {object} a frames event
 */
function frames(symbols, startMs, endMs, repeats, frames = repeats) {
  return { type: 'frames', startMs, endMs, restHz: 17900, symbols, repeats, frames, periodMs: 172.7 };
}

const tone = (hz, startMs, endMs) => ({ type: 'tone', startMs, endMs, hz });
const hop = (startMs, endMs, hops = 10, restHz = 18900) => ({
  type: 'hop',
  startMs,
  endMs,
  restHz,
  offsetHz: 400,
  periodMs: 60.7,
  hops,
});

/* ---------------------------- unit cases ---------------------------- */

test('emptyReading holds nothing and carries its start time', () => {
  assert.ok(isEmptyReading(emptyReading()));
  assert.equal(emptyReading().sinceMs, -Infinity);
  assert.equal(emptyReading(1234).sinceMs, 1234);
  assert.ok(!isEmptyReading({ ...emptyReading(), tone: tone(18800, 0, 300) }));
});

test('sameSymbols compares element by element', () => {
  assert.ok(sameSymbols(PUTTER, [...PUTTER]));
  assert.ok(!sameSymbols(PUTTER, SAND_WEDGE));
  assert.ok(!sameSymbols(PUTTER, PUTTER.slice(0, 5)));
});

test('mergeReading does not change the previous reading', () => {
  const prev = Object.freeze(emptyReading());
  const next = mergeReading(prev, [frames(PUTTER, 0, 1000, 5)]);
  assert.notEqual(next, prev);
  assert.deepEqual(prev, emptyReading());
  assert.deepEqual(next.frames.symbols, PUTTER);
});

test('a growing transmission replaces its own earlier read', () => {
  let reading = mergeReading(emptyReading(), [frames(PUTTER, 0, 400, 1, 2)]);
  assert.equal(reading.frames.repeats, 1);
  reading = mergeReading(reading, [frames(PUTTER, 0, 1500, 7, 8)]);
  assert.equal(reading.frames.repeats, 7);
});

test('a transmission sliding out of the window does not shrink the held read', () => {
  let reading = mergeReading(emptyReading(), [frames(PUTTER, 0, 3300, 19), hop(3300, 6000, 30)]);
  reading = mergeReading(reading, [frames(PUTTER, 1500, 3300, 10), hop(5000, 6000, 15)]);
  reading = mergeReading(reading, [frames(PUTTER, 2700, 3300, 4), hop(5800, 6000, 3)]);
  assert.equal(reading.frames.repeats, 19);
  assert.equal(reading.hop.hops, 30);
});

test('a solid read is held when the window, sliding past it, later shows only a weak piece of it', () => {
  const solid = mergeReading(emptyReading(), [frames(PUTTER, 0, 3000, 15, 17)]);
  const later = mergeReading(solid, [frames([4, 4, 4, 4, 4, 4], 2800, 3000, 1, 1)]);
  assert.deepEqual(later.frames.symbols, PUTTER);
  assert.equal(later.frames.repeats, 15);
  const piece = mergeReading(solid, [frames(PUTTER, 2000, 3000, 2, 6)]);
  assert.equal(piece.frames.repeats, 15);
});

test('a frame that carries on for longer than the window holds keeps its start and its best read, and its end moves on', () => {
  let reading = mergeReading(emptyReading(), [frames(PUTTER, 0, 8000, 46)]);
  reading = mergeReading(reading, [frames(PUTTER, 2000, 10000, 46)]);
  assert.equal(reading.frames.startMs, 0);
  assert.equal(reading.frames.endMs, 10000);
  // So the hit frame that follows 10 s in is still this tag changing its frame.
  reading = mergeReading(reading, [frames(PUTTER, 2500, 10100, 45), frames(PUTTER_HIT, 10100, 10800, 4)]);
  assert.deepEqual(reading.frames.symbols, PUTTER);
  assert.deepEqual(reading.hitFrames.symbols, PUTTER_HIT);
});

test('a longer decode of the same transmission replaces an early read, even one that looked solid', () => {
  // As heard on a putter recording: 3 of 4 agree early on, 3 of 7 by the end.
  const misread = [-4, -2, -1, -3, -1, -1];
  let reading = mergeReading(emptyReading(), [frames(misread, 1500, 2250, 3, 4)]);
  assert.equal(autoSaveBlock(reading, null), 'too-brief');
  reading = mergeReading(reading, [frames(misread, 1500, 2900, 3, 7)]);
  assert.equal(reading.frames.frames, 7);
  assert.equal(autoSaveBlock(reading, null), 'no-frame');
  // The longer decode may also read a symbol differently: it is still the same transmission.
  reading = mergeReading(reading, [frames(PUTTER, 1510, 4000, 12, 14)]);
  assert.deepEqual(reading.frames.symbols, PUTTER);
  assert.equal(reading.hitFrames, null);
});

test('a hop pattern that began before the frame belongs to the tag before', () => {
  const before = hop(0, 2900, 40);
  const wedge = frames(SAND_WEDGE, 3000, 6000, 15);
  let reading = mergeReading(emptyReading(), [before]);
  assert.equal(reading.hop, before);
  reading = mergeReading(reading, [before, wedge]);
  assert.equal(reading.hop, null);
  const own = hop(6000, 8000, 16, 18820);
  reading = mergeReading(reading, [before, wedge, own]);
  assert.equal(reading.hop, own);
});

test('a hop pattern that began well after the frame stopped belongs to another tag', () => {
  const putter = frames(PUTTER, 1500, 6500, 20);
  const later = hop(7500, 8300, 9);
  const reading = mergeReading(emptyReading(), [putter, later]);
  assert.equal(reading.hop, null);
  assert.deepEqual(reading.frames.symbols, PUTTER);
});

test('a steady stretch on the frames’ own rest tone is not a wake tone', () => {
  const reading = mergeReading(emptyReading(), [tone(17884, 3290, 3440), frames(PUTTER, 3440, 6000, 9, 10)]);
  assert.equal(reading.tone, null);
});

test('the reading is held after the tag goes quiet', () => {
  const heard = mergeReading(emptyReading(), [frames(PUTTER, 0, 3000, 15), tone(19815, 3200, 3500)]);
  assert.deepEqual(mergeReading(heard, []), heard);
});

test('a later, separate tone or hop pattern replaces the held one', () => {
  let reading = mergeReading(emptyReading(), [tone(18728, 0, 300), hop(400, 2000)]);
  reading = mergeReading(reading, [tone(18728, 0, 300), tone(18735, 4000, 4200), hop(400, 2000), hop(5000, 5400, 5)]);
  assert.equal(reading.tone.hz, 18735);
  assert.equal(reading.hop.startMs, 5000);
});

test('a different solid frame is a different tag: the old tone and hop are dropped and stay dropped', () => {
  const putterEvents = [frames(PUTTER, 0, 3000, 15), tone(19815, 3100, 3400), hop(3500, 5000)];
  let reading = mergeReading(emptyReading(), putterEvents);
  const wedge = frames(SAND_WEDGE, 9000, 11000, 10);
  reading = mergeReading(reading, [...putterEvents, wedge]);
  assert.deepEqual(reading.frames.symbols, SAND_WEDGE);
  assert.equal(reading.tone, null);
  assert.equal(reading.hop, null);
  // The putter's events are still inside the window on the following merges.
  reading = mergeReading(reading, [...putterEvents, wedge]);
  reading = mergeReading(reading, [...putterEvents, wedge]);
  assert.equal(reading.tone, null);
  assert.equal(reading.hop, null);
});

test('a tone heard long before the first solid frame belongs to another tag', () => {
  const stray = tone(19815, 0, 300);
  let reading = mergeReading(emptyReading(), [stray]);
  assert.equal(reading.tone.hz, 19815);
  const wedge = frames(SAND_WEDGE, 300 + ATTACH_BEFORE_MS + 500, 6000, 10);
  reading = mergeReading(reading, [stray, wedge]);
  reading = mergeReading(reading, [stray, wedge]);
  assert.equal(reading.tone, null);
});

test('a tone just before the frames is the same tag (tap, then light)', () => {
  const tap = tone(18728, 0, 400);
  const wedge = frames(SAND_WEDGE, 1000, 4000, 15);
  let reading = mergeReading(emptyReading(), [tap]);
  reading = mergeReading(reading, [tap, wedge]);
  reading = mergeReading(reading, [tap, wedge]);
  assert.equal(reading.tone.hz, 18728);
});

test('a new tag keeps its own tone heard after its frames began', () => {
  const putter = mergeReading(emptyReading(), [frames(PUTTER, 0, 3000, 15), tone(19815, 3100, 3400)]);
  const wedge = mergeReading(putter, [frames(SAND_WEDGE, 9000, 11000, 10), tone(18728, 11100, 11400)]);
  assert.deepEqual(wedge.frames.symbols, SAND_WEDGE);
  assert.equal(wedge.tone.hz, 18728);
});

test('a weak read of other symbols does not count as a different tag', () => {
  const putter = mergeReading(emptyReading(), [frames(PUTTER, 0, 3000, 15), tone(19815, 3100, 3400)]);
  const noisy = mergeReading(putter, [frames(SAND_WEDGE, 6000, 6300, 1, 2)]);
  assert.deepEqual(noisy.frames.symbols, PUTTER);
  assert.equal(noisy.tone.hz, 19815);
});

test('events that ended before the reading began are ignored on every merge', () => {
  const old = [frames(PUTTER, 0, 3000, 15), tone(19815, 3100, 3400), hop(3500, 5000)];
  let reading = emptyReading(5000);
  reading = mergeReading(reading, old);
  reading = mergeReading(reading, old);
  assert.ok(isEmptyReading(reading));
  reading = mergeReading(reading, [...old, tone(18728, 6000, 6300)]);
  assert.equal(reading.tone.hz, 18728);
  assert.equal(reading.frames, null);
});

test('a tone on the rest frequency at the start of a hop pattern is the pattern itself', () => {
  let reading = mergeReading(emptyReading(), [tone(18905, 1000, 1150)]);
  assert.equal(reading.tone.hz, 18905);
  reading = mergeReading(reading, [hop(1000, 2500, 20, 18900)]);
  assert.equal(reading.tone, null);
  assert.equal(reading.hop.hops, 20);
});

test('a tone 100 Hz below a hop pattern is a real tone', () => {
  const reading = mergeReading(emptyReading(), [hop(0, 2000, 30, 18900), tone(18800, 2000, 2300)]);
  assert.equal(reading.tone.hz, 18800);
});

/* ---------------- the live loop, with the real decoder ---------------- */

const SR = 48000;
const TICK_MS = 250;
const WINDOW_S = 8;

/**
 * Run audio through the same loop the page runs: feed 250 ms, trim to 8 s, classify, merge.
 * @param {Float32Array} audio
 * @param {(reading: object, nowMs: number) => object} [between] called after each tick; may
 *   return a replacement reading (to simulate Clear)
 * @returns {object} the final reading
 */
function runLive(audio, between = (r) => r) {
  const tracker = new ToneTracker(SR);
  const step = Math.round((TICK_MS * SR) / 1000);
  let reading = emptyReading();
  for (let at = 0; at < audio.length; at += step) {
    tracker.push(audio.subarray(at, Math.min(audio.length, at + step)));
    tracker.trim(WINDOW_S);
    reading = mergeReading(reading, classify(tracker.track()));
    reading = between(reading, ((at + step) / SR) * 1000);
  }
  return reading;
}

const noisy = (audio, seed) => addNoise(audio, 0.0005, seed);
const putterFrames = (repeats) => synthFrames({ sampleRate: SR, restHz: 17920, symbols: PUTTER, repeats });
const wedgeFrames = (repeats) => synthFrames({ sampleRate: SR, restHz: 17830, symbols: SAND_WEDGE, repeats });

test('live: one tag then another does not carry the first tag’s tone across', () => {
  const audio = noisy(
    concat(
      silence(SR, 500),
      putterFrames(12),
      silence(SR, 200),
      synthTone({ sampleRate: SR, hz: 19815, ms: 320 }),
      silence(SR, 2500),
      wedgeFrames(12),
      silence(SR, 3000)
    ),
    1
  );
  const reading = runLive(audio);
  assert.deepEqual(reading.frames.symbols, SAND_WEDGE);
  assert.equal(reading.tone, null);
});

test('live: a tone alone, then much later another tag’s frames, does not keep the tone', () => {
  const audio = noisy(
    concat(silence(SR, 500), synthTone({ sampleRate: SR, hz: 19815, ms: 320 }), silence(SR, 3000), wedgeFrames(12), silence(SR, 2000)),
    2
  );
  const reading = runLive(audio);
  assert.deepEqual(reading.frames.symbols, SAND_WEDGE);
  assert.equal(reading.tone, null);
});

test('live: tap then light keeps the tone with the frames', () => {
  const audio = noisy(
    concat(silence(SR, 500), synthTone({ sampleRate: SR, hz: 18728, ms: 320 }), silence(SR, 600), wedgeFrames(15), silence(SR, 2000)),
    3
  );
  const reading = runLive(audio);
  assert.deepEqual(reading.frames.symbols, SAND_WEDGE);
  assert.ok(reading.tone, 'tone kept');
  assert.ok(Math.abs(reading.tone.hz - 18728) < 15);
});

test('live: the full read survives the transmission sliding out of the window', () => {
  const audio = noisy(concat(silence(SR, 500), putterFrames(20), silence(SR, 12000)), 4);
  const reading = runLive(audio);
  assert.deepEqual(reading.frames.symbols, PUTTER);
  assert.ok(reading.frames.repeats >= 18, `repeats ${reading.frames.repeats}`);
  assert.ok(Math.abs(reading.frames.periodMs - 172.7) < 2);
});

test('live: a hop pattern is held whole and never leaves a tone behind', () => {
  for (const leadMs of [500, 560, 620, 680]) {
    const audio = noisy(
      concat(silence(SR, leadMs), synthHop({ sampleRate: SR, restHz: 18830, offsetHz: 300, periodMs: 121.7, hops: 30 }), silence(SR, 12000)),
      5
    );
    const reading = runLive(audio);
    assert.ok(reading.hop, `hop held (lead ${leadMs})`);
    assert.ok(reading.hop.hops >= 27, `hops ${reading.hop.hops} (lead ${leadMs})`);
    assert.equal(reading.tone, null, `no tone (lead ${leadMs})`);
  }
});

test('live: a cleared reading stays clear while the old audio is still in the window', () => {
  const audio = noisy(concat(silence(SR, 500), putterFrames(12), silence(SR, 4000)), 6);
  let cleared = false;
  const reading = runLive(audio, (r, nowMs) => {
    if (!cleared && nowMs >= 3500) {
      cleared = true;
      assert.deepEqual(r.frames.symbols, PUTTER);
      return emptyReading(nowMs);
    }
    return r;
  });
  assert.ok(cleared);
  assert.ok(isEmptyReading(reading));
});

/* ---------------------------- a tag that changes its frame ---------------------------- */

const PUTTER_HIT = [1, 3, 4, 2, 4, -1];

test('a second frame that carries straight on is held as the hit frame of the same tag', () => {
  let reading = mergeReading(emptyReading(), [frames(PUTTER, 1000, 2700, 9)]);
  reading = mergeReading(reading, [frames(PUTTER, 1000, 2700, 9), frames(PUTTER_HIT, 2700, 4500, 8)]);
  assert.deepEqual(reading.frames.symbols, PUTTER);
  assert.deepEqual(reading.hitFrames.symbols, PUTTER_HIT);
  assert.equal(reading.sinceMs, 1000 - ATTACH_BEFORE_MS);
});

test('the hit frame stays the hit frame after the first frame has left the window', () => {
  let reading = mergeReading(emptyReading(), [frames(PUTTER, 1000, 2700, 9), frames(PUTTER_HIT, 2700, 4500, 8)]);
  reading = mergeReading(reading, [frames(PUTTER_HIT, 3600, 6000, 12)]);
  assert.deepEqual(reading.frames.symbols, PUTTER);
  assert.equal(reading.hitFrames.repeats, 12);
});

test('the first frame returning after the hit frame changes nothing', () => {
  let reading = mergeReading(emptyReading(), [frames(PUTTER, 1000, 2700, 9), frames(PUTTER_HIT, 2700, 4500, 8)]);
  reading = mergeReading(reading, [frames(PUTTER_HIT, 2700, 4500, 8), frames(PUTTER, 4500, 6000, 7)]);
  assert.deepEqual(reading.frames.symbols, PUTTER);
  assert.deepEqual(reading.hitFrames.symbols, PUTTER_HIT);
});

test('another frame after a pause, or on another rest tone, is another tag', () => {
  const held = mergeReading(emptyReading(), [frames(PUTTER, 1000, 2700, 9)]);
  const later = mergeReading(held, [frames(SAND_WEDGE, 4000, 6000, 9)]);
  assert.deepEqual(later.frames.symbols, SAND_WEDGE);
  assert.equal(later.hitFrames, null);
  const otherRest = mergeReading(held, [{ ...frames(SAND_WEDGE, 2700, 4500, 9), restHz: 17830 }]);
  assert.deepEqual(otherRest.frames.symbols, SAND_WEDGE);
  assert.equal(otherRest.hitFrames, null);
});

test('a new tag clears the hit frame of the one before', () => {
  let reading = mergeReading(emptyReading(), [frames(PUTTER, 1000, 2700, 9), frames(PUTTER_HIT, 2700, 4500, 8)]);
  reading = mergeReading(reading, [frames(SAND_WEDGE, 9000, 11000, 9)]);
  assert.deepEqual(reading.frames.symbols, SAND_WEDGE);
  assert.equal(reading.hitFrames, null);
});

test('a weak read is never taken as a hit frame', () => {
  const reading = mergeReading(emptyReading(), [frames(PUTTER, 1000, 2700, 9), frames(PUTTER_HIT, 2700, 3100, 1, 4)]);
  assert.deepEqual(reading.frames.symbols, PUTTER);
  assert.equal(reading.hitFrames, null);
});

test('a hit frame that follows a briefly heard resting frame is still held as the hit frame', () => {
  const brief = frames(PUTTER, 1000, 1350, 1, 2);
  const reading = mergeReading(emptyReading(), [brief, frames(PUTTER_HIT, 1350, 3000, 8)]);
  assert.deepEqual(reading.frames.symbols, PUTTER);
  assert.deepEqual(reading.hitFrames.symbols, PUTTER_HIT);
  // The resting frame firms up when it returns, and the hit frame is kept.
  const later = mergeReading(reading, [frames(PUTTER_HIT, 1350, 3000, 8), frames(PUTTER, 3000, 4800, 9)]);
  assert.equal(later.frames.repeats, 9);
  assert.deepEqual(later.hitFrames.symbols, PUTTER_HIT);
});

test('a solid read still replaces a weak misread of the same frame', () => {
  const misread = frames([-4, -2, -1, -3, -1, 2], 1000, 1350, 1, 2);
  const reading = mergeReading(emptyReading(), [misread, frames(PUTTER, 1350, 3000, 8)]);
  assert.deepEqual(reading.frames.symbols, PUTTER);
  assert.equal(reading.hitFrames, null);
});

/* ---------------------------- saving without a button press ---------------------------- */

test('a reading saves by itself only with a solid resting frame that fits the club', () => {
  const solid = mergeReading(emptyReading(), [tone(19815, 100, 480), frames(PUTTER, 1000, 2700, 9)]);
  assert.equal(autoSaveBlock(solid, null), null);
  assert.equal(autoSaveBlock(solid, PUTTER), null);
  assert.equal(autoSaveBlock(solid, SAND_WEDGE), 'differs');
});

test('a frame the club does not have yet saves by itself only when heard from the wake tone on', () => {
  // Listening began mid-transmission: this could be the hit frame, with the tap never heard.
  const midway = mergeReading(emptyReading(), [frames(PUTTER_HIT, 1000, 2700, 9)]);
  assert.equal(autoSaveBlock(midway, null), 'no-wake');
  assert.equal(autoSaveBlock(midway, PUTTER), 'no-wake');
  // The same frame is fine once it is the one the club already has.
  const known = mergeReading(emptyReading(), [frames(PUTTER, 1000, 2700, 9)]);
  assert.equal(autoSaveBlock(known, PUTTER), null);
});

test('a wake tone alone, a weak frame, or a hit frame without its resting frame does not save by itself', () => {
  const toneOnly = mergeReading(emptyReading(), [tone(19800, 0, 380)]);
  assert.equal(autoSaveBlock(toneOnly, null), 'no-frame');
  const weak = mergeReading(emptyReading(), [frames(PUTTER, 1000, 1350, 1, 2)]);
  assert.equal(autoSaveBlock(weak, null), 'no-frame');
  const hitOnly = mergeReading(emptyReading(), [frames(PUTTER, 1000, 1350, 1, 2), frames(PUTTER_HIT, 1350, 3000, 8)]);
  assert.equal(autoSaveBlock(hitOnly, null), 'no-frame');
});

test('a hit frame after a short dropout still belongs to the same tag', () => {
  // Measured on the putter: 0.32 s of silence between the resting frame and the hit frame.
  const reading = mergeReading(emptyReading(), [
    frames(PUTTER, 2080, 3160, 2, 4),
    frames(PUTTER_HIT, 3480, 4580, 5),
    frames(PUTTER, 4750, 6500, 8, 10),
  ]);
  assert.deepEqual(reading.frames.symbols, PUTTER);
  assert.equal(reading.frames.repeats, 8);
  assert.deepEqual(reading.hitFrames.symbols, PUTTER_HIT);
});

/* ---------------------------- taps ---------------------------- */

const tap = (startMs) => ({ type: 'impact', startMs, endMs: startMs + 40, riseDb: 30 });

test('a frame that begins after a tap is the hit frame, however long the dropout before it', () => {
  const reading = mergeReading(emptyReading(), [
    frames(PUTTER, 2000, 3100, 5),
    tap(3000),
    frames(PUTTER_HIT, 4090, 5200, 5),
  ]);
  assert.deepEqual(reading.frames.symbols, PUTTER);
  assert.deepEqual(reading.hitFrames.symbols, PUTTER_HIT);
  assert.equal(reading.impact.startMs, 3000);
});

test('a held frame that began after a tap gives way to the frame from before the tap', () => {
  // The hit frame was read first because the resting frame was still weak.
  let reading = mergeReading(emptyReading(), [frames(PUTTER_HIT, 3480, 4580, 5)]);
  reading = mergeReading(reading, [frames(PUTTER, 2080, 3160, 4), tap(2390), frames(PUTTER_HIT, 3480, 4580, 5)]);
  assert.deepEqual(reading.frames.symbols, PUTTER);
  assert.deepEqual(reading.hitFrames.symbols, PUTTER_HIT);
});

test('a tap with no change of signal is only a noise', () => {
  const reading = mergeReading(emptyReading(), [frames(PUTTER, 2000, 5000, 15), tap(3000)]);
  assert.equal(reading.hitFrames, null);
  assert.equal(reading.impact, null);
  assert.ok(isEmptyReading(mergeReading(emptyReading(), [tap(3000)])));
});

test('the tap just before a hop pattern is kept with it', () => {
  const reading = mergeReading(emptyReading(), [frames(SAND_WEDGE, 1440, 3150, 9), tap(1000), tap(3141), hop(3150, 6500, 27)]);
  assert.equal(reading.impact.startMs, 3141);
});

/* ---------------------------- naming the stretches ---------------------------- */

test('labelEvents names wake tone, resting frame, tap, hit frame and the resting frame returning', async () => {
  const { labelEvents } = await import('../web/reading.js');
  // A putter recording whose stretches were marked by hand, as the decoder reports it.
  const parts = labelEvents([
    tone(19815, 510, 910),
    frames(PUTTER, 1510, 2460, 2, 4),
    tap(2390),
    frames(PUTTER_HIT, 2460, 2990, 2, 3),
    frames(PUTTER_HIT, 3480, 4580, 5, 6),
    frames(PUTTER, 4750, 6500, 8, 10),
  ]);
  assert.deepEqual(
    parts.map((p) => [p.kind, p.startMs, p.endMs]),
    [
      ['wake', 510, 910],
      ['resting', 1510, 2460],
      ['tap', 2390, 2430],
      ['hit', 2460, 4580],
      ['resting', 4750, 6500],
    ]
  );
  assert.ok(parts[1].loHz < 17500 && parts[1].hiHz > 18300);
  assert.equal(parts[2].loHz, null);
});

test('labelEvents names a hop pattern as the signal after a hit', async () => {
  const { labelEvents } = await import('../web/reading.js');
  const parts = labelEvents([frames(SAND_WEDGE, 1440, 3150, 9), tap(3141), hop(3150, 6500, 27, 18816)]);
  assert.deepEqual(parts.map((p) => p.kind), ['resting', 'tap', 'hit']);
  assert.ok(parts[2].loHz < 18816 && parts[2].hiHz > 19216);
  assert.deepEqual(labelEvents([]), []);
});

/* ---------------------------- which frame is the resting one ---------------------------- */

const IRON9 = [4, -1, -2, 1, -4, -3];

/** A putter recording whose stretches were marked by hand, as the decoder first reported it: both early reads weak. */
const ANNOTATED = [
  tone(19815, 510, 910),
  frames(PUTTER, 1510, 2460, 2, 4),
  tap(2390),
  frames(PUTTER_HIT, 2460, 2990, 2, 3),
  frames(PUTTER_HIT, 3480, 4580, 5, 6),
  frames(PUTTER, 4750, 6500, 8, 10),
];

test('a weak hit frame does not displace the weak resting frame before it', () => {
  const reading = mergeReading(emptyReading(), ANNOTATED);
  assert.deepEqual(reading.frames.symbols, PUTTER);
  assert.equal(reading.frames.repeats, 8);
  assert.deepEqual(reading.hitFrames.symbols, PUTTER_HIT);
  assert.equal(reading.impact.startMs, 2390);
  assert.equal(autoSaveBlock(reading, null), null);
});

test('the annotated capture arriving piece by piece never holds the hit frame as the resting one', () => {
  let reading = emptyReading();
  for (let n = 1; n <= ANNOTATED.length; n++) {
    reading = mergeReading(reading, ANNOTATED.slice(0, n));
    if (reading.frames) assert.deepEqual(reading.frames.symbols, PUTTER, `after ${n} events`);
  }
  assert.deepEqual(reading.hitFrames.symbols, PUTTER_HIT);
});

test('a held frame set off by a tap becomes the hit frame when the resting frame returns', () => {
  // Listening began as the tag was tapped: the hit frame is the first one read solidly.
  let reading = mergeReading(emptyReading(), [tap(472), frames(PUTTER_HIT, 700, 2650, 7, 10)]);
  assert.deepEqual(reading.frames.symbols, PUTTER_HIT);
  reading = mergeReading(reading, [tap(472), frames(PUTTER_HIT, 700, 2650, 7, 10), frames(PUTTER, 2870, 6500, 10, 19)]);
  assert.deepEqual(reading.frames.symbols, PUTTER);
  assert.deepEqual(reading.hitFrames.symbols, PUTTER_HIT);
  assert.equal(reading.impact.startMs, 472);
  assert.equal(autoSaveBlock(reading, null), null);
});

test('a tap that sounded the wake tone does not make the resting frame a hit frame', () => {
  // Tap on a covered tag, wake tone, resting frame; then the hit frame, its tap not heard.
  const reading = mergeReading(emptyReading(), [
    tap(3180),
    tone(19800, 3770, 4170),
    frames(PUTTER, 4770, 6500, 10),
    frames(PUTTER_HIT, 6500, 8000, 8),
  ]);
  assert.deepEqual(reading.frames.symbols, PUTTER);
  assert.deepEqual(reading.hitFrames.symbols, PUTTER_HIT);
  // The wake tone places the resting frame, so the order is known without the tap.
  assert.equal(reading.impact, null);
  assert.equal(autoSaveBlock(reading, null), null);
});

test('two frames with neither a tap nor a wake tone to order them do not save by themselves', () => {
  const reading = mergeReading(emptyReading(), [frames(PUTTER_HIT, 1000, 2700, 9), frames(PUTTER, 2700, 4500, 8)]);
  assert.ok(reading.hitFrames);
  assert.equal(autoSaveBlock(reading, null), 'order-unknown');
  assert.equal(autoSaveBlock(reading, SAND_WEDGE), 'order-unknown');
});

test('another tag waking on the same rest tone is another tag, whatever taps were heard', () => {
  // Putter and 9 iron rest within 20 Hz of each other. Measured: 9 iron, two taps, putter wake tone, putter frames.
  const iron = frames(IRON9, 1420, 4760, 19);
  let reading = mergeReading(emptyReading(), [iron]);
  reading = mergeReading(reading, [iron, tap(9680), tap(9880), tone(19800, 10270, 10670), frames(PUTTER, 11270, 13000, 10)]);
  assert.deepEqual(reading.frames.symbols, PUTTER);
  assert.equal(reading.hitFrames, null);
  assert.equal(reading.tone.hz, 19800);
  assert.equal(reading.impact, null);
});

test('a wake tone between two frames that follow closely still means another tag', () => {
  const reading = mergeReading(emptyReading(), [
    frames(IRON9, 1000, 2700, 9),
    tone(19800, 2100, 2500),
    frames(PUTTER, 3000, 4800, 9),
  ]);
  assert.deepEqual(reading.frames.symbols, PUTTER);
  assert.equal(reading.hitFrames, null);
});

test('a tap long before a frame began did not set it off', () => {
  const reading = mergeReading(emptyReading(), [frames(IRON9, 2000, 3100, 5), tap(3000), frames(PUTTER, 6000, 7500, 8)]);
  assert.deepEqual(reading.frames.symbols, PUTTER);
  assert.equal(reading.hitFrames, null);
});

test('labelEvents takes the frame after the wake tone as the resting one, however weakly it was read', () => {
  // A putter capture as decoded: the resting frame 3 of 7, the hit frame solid.
  const parts = labelEvents([
    tone(19808, 500, 860),
    frames(PUTTER, 1500, 3250, 3, 7),
    tap(3020),
    frames(PUTTER_HIT, 3250, 5190, 6, 11),
  ]);
  assert.deepEqual(parts.map((p) => p.kind), ['wake', 'resting', 'tap', 'hit']);
});

test('labelEvents takes the frame a tap ends as the resting one when no wake tone was heard', () => {
  const parts = labelEvents([frames(PUTTER, 20, 700, 1, 3), tap(472), frames(PUTTER_HIT, 700, 2650, 7, 10)]);
  assert.deepEqual(parts.map((p) => p.kind), ['resting', 'tap', 'hit']);
});

/**
 * @param {string} name a file in test/fixtures
 * @returns {Float32Array} its samples; fixtures are recorded at SR
 */
function fixture(name) {
  const buf = fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
  const { sampleRate, samples } = decodeWav(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  assert.equal(sampleRate, SR);
  return samples;
}

test('live: fixture putter-tap-hit-return.wav holds the resting frame, the tap and the hit frame', () => {
  const reading = runLive(fixture('putter-tap-hit-return.wav'), (r) => {
    // At no tick may the hit frame be the one that would be saved for the club.
    const hitHeldAsResting = r.frames !== null && sameSymbols(r.frames.symbols, PUTTER_HIT);
    assert.ok(!(hitHeldAsResting && autoSaveBlock(r, null) === null));
    return r;
  });
  assert.deepEqual(reading.frames.symbols, PUTTER);
  assert.deepEqual(reading.hitFrames.symbols, PUTTER_HIT);
  assert.ok(reading.impact && Math.abs(reading.impact.startMs - 940) < 60, 'tap held');
  // The clip starts after the wake tone, but the tap heard between the two frames fixes their
  // order. The resting frame is on for under a second either side of the hit, though: too
  // brief to save for a club that has no frame yet, enough for one that already has it.
  assert.ok(reading.frames.repeats < AUTO_SAVE_MIN_REPEATS);
  assert.equal(autoSaveBlock(reading, null), 'too-brief');
  assert.equal(autoSaveBlock(reading, PUTTER), null);
});

test('labelEvents told which frame is the resting one names every frame by it', () => {
  const events = [
    frames(PUTTER_HIT, 1000, 3000, 9),
    { type: 'impact', startMs: 1100, endMs: 1120, riseDb: 30 },
    frames(PUTTER, 3200, 5000, 9),
    frames([-4, -2, -1, -3, -1, -1], 5300, 6200, 1, 3),
  ];
  // Left to itself it takes the first solid frame as the resting one.
  assert.deepEqual(labelEvents(events).filter((p) => p.kind !== 'tap').map((p) => p.kind), ['resting', 'hit']);
  // Told, it names the hit frame, the resting frame, and a misread of the resting frame.
  const told = labelEvents(events, PUTTER).filter((p) => p.kind !== 'tap');
  assert.deepEqual(told.map((p) => p.kind), ['hit', 'resting']);
  assert.equal(told[1].endMs, 6200);
});

test('a hit frame read in two pieces keeps the start of the first, so its delay after the tap is right', () => {
  // The annotated putter capture: the hit frame is unreadable from 2.99 to 3.48 s.
  const reading = mergeReading(emptyReading(), [
    tone(19815, 510, 910),
    frames(PUTTER, 1510, 2450, 4, 5),
    tap(2390),
    frames(PUTTER_HIT, 2450, 2990, 3),
    frames(PUTTER_HIT, 3480, 4580, 5, 6),
    frames(PUTTER, 4750, 6500, 9, 10),
  ]);
  assert.deepEqual(reading.hitFrames.symbols, PUTTER_HIT);
  assert.equal(reading.hitFrames.repeats, 5);
  assert.equal(reading.hitFrames.startMs, 2450);
  assert.equal(reading.impact.startMs, 2390);
});
