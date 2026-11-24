import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { decodeWav } from '../web/dsp.js';
import {
  ToneTracker,
  classify,
  decodeTagSignals,
  formatSymbols,
  formatKHz,
  describeEvent,
  TAG_PROTOCOL,
} from '../web/tag-decoder.js';
import { synthFrames, synthTone, synthHop, silence, concat, addNoise } from '../web/tag-synth.js';
import { isSolidFrames } from '../web/codebook.js';

const SR = 48000;
const AMP = 0.05;
const GAP_MS = 150;
const NOISE_RMS = 0.0005;
const SEED = 7;

const PUTTER = { restHz: 17920, symbols: [-4, -2, -1, -3, -1, 1] };
const WEDGE = { restHz: 17830, symbols: [1, 3, 4, -3, 4, -3] };
const IRON9 = { restHz: 17910, symbols: [4, -1, -2, 1, -4, -3] };

/** Wraps a signal in the silence the decoder expects, with a little noise. */
function recording(signal, { sampleRate = SR, noiseRms = NOISE_RMS, seed = SEED } = {}) {
  const x = concat(silence(sampleRate, GAP_MS), signal, silence(sampleRate, GAP_MS));
  return addNoise(x, noiseRms, seed);
}

function frames(club, repeats = 10, sampleRate = SR) {
  return synthFrames({ sampleRate, restHz: club.restHz, symbols: club.symbols, repeats, amplitude: AMP });
}

function tone(hz, ms, sampleRate = SR) {
  return synthTone({ sampleRate, hz, ms, amplitude: AMP });
}

function hop(restHz, offsetHz, periodMs, hops, sampleRate = SR) {
  return synthHop({ sampleRate, restHz, offsetHz, periodMs, hops, amplitude: AMP });
}

function decodeFixture(name) {
  const buf = fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
  const { sampleRate, samples } = decodeWav(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  return decodeTagSignals(samples, sampleRate);
}

function ofType(events, type) {
  return events.filter((e) => e.type === type);
}

test('TAG_PROTOCOL carries the measured timing', () => {
  assert.equal(TAG_PROTOCOL.framePeriodMs, 172.7);
  assert.equal(TAG_PROTOCOL.symbolsPerFrame, 6);
});

test('putter frames decode exactly at 48 kHz', () => {
  const events = decodeTagSignals(recording(frames(PUTTER)), SR);
  assert.equal(events.length, 1);
  const [e] = events;
  assert.equal(e.type, 'frames');
  assert.deepEqual(e.symbols, PUTTER.symbols);
  assert.ok(e.repeats >= 8, `repeats ${e.repeats}`);
  assert.ok(Math.abs(e.restHz - PUTTER.restHz) <= 15, `restHz ${e.restHz}`);
  assert.ok(Math.abs(e.periodMs - TAG_PROTOCOL.framePeriodMs) <= 2, `periodMs ${e.periodMs}`);
});

test('sand wedge frames decode exactly at 48 kHz', () => {
  const [e] = decodeTagSignals(recording(frames(WEDGE)), SR);
  assert.equal(e.type, 'frames');
  assert.deepEqual(e.symbols, WEDGE.symbols);
  assert.ok(e.repeats >= 8);
  assert.ok(Math.abs(e.restHz - WEDGE.restHz) <= 15);
});

test('9 iron frames decode exactly at 48 kHz', () => {
  const [e] = decodeTagSignals(recording(frames(IRON9)), SR);
  assert.equal(e.type, 'frames');
  assert.deepEqual(e.symbols, IRON9.symbols);
  assert.ok(e.repeats >= 8);
  assert.ok(Math.abs(e.restHz - IRON9.restHz) <= 15);
});

test('putter frames decode exactly at 44100 Hz', () => {
  const sr = 44100;
  const events = decodeTagSignals(recording(frames(PUTTER, 10, sr), { sampleRate: sr }), sr);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'frames');
  assert.deepEqual(events[0].symbols, PUTTER.symbols);
  assert.ok(Math.abs(events[0].restHz - PUTTER.restHz) <= 15);
});

test('frames still decode with noise RMS a tenth of the signal amplitude', () => {
  const events = decodeTagSignals(recording(frames(PUTTER), { noiseRms: 0.005, seed: 11 }), SR);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'frames');
  assert.deepEqual(events[0].symbols, PUTTER.symbols);
});

test('a 320 ms tone at 18728 Hz gives exactly one tone event', () => {
  const events = decodeTagSignals(recording(tone(18728, 320)), SR);
  assert.equal(events.length, 1);
  const [e] = events;
  assert.equal(e.type, 'tone');
  assert.ok(Math.abs(e.hz - 18728) <= 10, `hz ${e.hz}`);
  assert.ok(Math.abs(e.endMs - e.startMs - 320) <= 40, `duration ${e.endMs - e.startMs}`);
});

test('hop pattern +300 Hz every 121.7 ms decodes as one hop event', () => {
  const events = decodeTagSignals(recording(hop(18830, 300, 121.7, 20)), SR);
  assert.equal(events.length, 1);
  const [e] = events;
  assert.equal(e.type, 'hop');
  assert.ok(Math.abs(e.restHz - 18830) <= 15, `restHz ${e.restHz}`);
  assert.ok(Math.abs(e.offsetHz - 300) <= 40, `offsetHz ${e.offsetHz}`);
  assert.ok(Math.abs(e.periodMs - 121.7) <= 1.5, `periodMs ${e.periodMs}`);
});

test('hop pattern +400 Hz every 60.7 ms decodes as one hop event', () => {
  const events = decodeTagSignals(recording(hop(18900, 400, 60.7, 30)), SR);
  assert.equal(events.length, 1);
  const [e] = events;
  assert.equal(e.type, 'hop');
  assert.ok(Math.abs(e.restHz - 18900) <= 15, `restHz ${e.restHz}`);
  assert.ok(Math.abs(e.offsetHz - 400) <= 40, `offsetHz ${e.offsetHz}`);
  assert.ok(Math.abs(e.periodMs - 60.7) <= 1.5, `periodMs ${e.periodMs}`);
});

test('frames, 300 ms of silence, then a tone decode as two events in order', () => {
  const x = recording(concat(frames(PUTTER), silence(SR, 300), tone(18728, 320)));
  const events = decodeTagSignals(x, SR);
  assert.deepEqual(
    events.map((e) => e.type),
    ['frames', 'tone'],
  );
  assert.deepEqual(events[0].symbols, PUTTER.symbols);
  assert.ok(events[0].endMs <= events[1].startMs);
});

test('frames immediately followed by a hop pattern on another rest tone decode as frames then hop', () => {
  const x = recording(concat(frames(PUTTER), hop(18830, 300, 121.7, 20)));
  const events = decodeTagSignals(x, SR);
  assert.deepEqual(
    events.map((e) => e.type),
    ['frames', 'hop'],
  );
  assert.deepEqual(events[0].symbols, PUTTER.symbols);
  assert.ok(Math.abs(events[1].restHz - 18830) <= 15);
});

test('a hop pattern immediately followed by a tone 100 Hz below its rest decodes as hop then tone', () => {
  const x = recording(concat(hop(18830, 300, 121.7, 20), tone(18730, 320)));
  const events = decodeTagSignals(x, SR);
  assert.deepEqual(
    events.map((e) => e.type),
    ['hop', 'tone'],
  );
  assert.ok(Math.abs(events[1].hz - 18730) <= 10);
});

test('silence yields no events', () => {
  assert.deepEqual(decodeTagSignals(silence(SR, 1000), SR), []);
});

test('noise alone yields no events', () => {
  const x = addNoise(silence(SR, 1000), NOISE_RMS, SEED);
  assert.deepEqual(decodeTagSignals(x, SR), []);
});

test('noise plus a few single-sample clicks of amplitude 0.5 yields taps and no tag signal', () => {
  const x = addNoise(silence(SR, 1000), NOISE_RMS, SEED);
  for (const at of [10000, 22000, 31000, 40500]) x[at] = 0.5;
  const events = decodeTagSignals(x, SR);
  assert.equal(events.length, 4);
  assert.ok(events.every((e) => e.type === 'impact' && e.riseDb > 15));
  assert.ok(Math.abs(events[0].startMs - (10000 / SR) * 1000) < 12, `startMs ${events[0].startMs}`);
});

test('a loud stretch longer than a click is not a tap', () => {
  const x = addNoise(silence(SR, 2000), NOISE_RMS, SEED);
  for (let i = 24000; i < 48000; i++) x[i] += 0.2 * Math.sin((2 * Math.PI * 4000 * i) / SR);
  assert.deepEqual(decodeTagSignals(x, SR), []);
});

test('fixture putter-two-frames.wav has one tap, before the second frame begins', () => {
  const events = decodeFixture('putter-two-frames.wav');
  const taps = ofType(events, 'impact');
  const second = ofType(events, 'frames')[1];
  assert.equal(taps.length, 1);
  assert.ok(taps[0].startMs < second.startMs && second.startMs - taps[0].startMs < 1500);
});

test('streaming gives identical tracks however the audio is chunked', () => {
  const x = recording(frames(PUTTER, 3));
  const trackOf = (chunk) => {
    const tracker = new ToneTracker(SR);
    for (let at = 0; at < x.length; at += chunk) tracker.push(x.subarray(at, at + chunk));
    return tracker.track();
  };
  const plain = (track) => Array.from(track.hz, (v) => (Number.isNaN(v) ? null : v));
  const reference = plain(trackOf(x.length));
  for (const chunk of [2048, 37, 1]) {
    assert.deepEqual(plain(trackOf(chunk)), reference, `chunk size ${chunk}`);
  }
});

test('trim keeps times absolute, so a trimmed decode matches the full decode', () => {
  const x = recording(concat(silence(SR, 1000), tone(18728, 320)));
  const [full] = decodeTagSignals(x, SR);
  const tracker = new ToneTracker(SR);
  tracker.push(x);
  tracker.trim(0.6);
  const [trimmed] = classify(tracker.track());
  assert.equal(full.type, 'tone');
  assert.equal(trimmed.type, 'tone');
  assert.ok(Math.abs(trimmed.startMs - full.startMs) <= tracker.hopMs, `${trimmed.startMs} vs ${full.startMs}`);
});

test('ToneTracker rejects a sample rate that cannot hold the tag band', () => {
  assert.throws(() => new ToneTracker(32000), RangeError);
});

test('formatSymbols writes signed steps with a true minus sign', () => {
  assert.equal(formatSymbols([4, -1, 0]), '+4 −1 0');
});

test('formatKHz writes kilohertz to three decimals', () => {
  assert.equal(formatKHz(18800), '18.800 kHz');
});

test('describeEvent names the symbols for frames', () => {
  const text = describeEvent({
    type: 'frames',
    startMs: 0,
    endMs: 1700,
    restHz: 17920,
    symbols: PUTTER.symbols,
    repeats: 9,
    frames: 10,
    periodMs: 172.7,
  });
  assert.ok(text.length > 0);
  assert.ok(text.includes(formatSymbols(PUTTER.symbols)));
});

test('describeEvent names the rest tone and jump for hops', () => {
  const text = describeEvent({
    type: 'hop',
    startMs: 0,
    endMs: 2000,
    restHz: 18830,
    offsetHz: 300,
    periodMs: 121.7,
    hops: 20,
  });
  assert.ok(text.includes(formatKHz(18830)));
  assert.ok(text.includes('300'));
});

test('describeEvent names the frequency for a tone', () => {
  const text = describeEvent({ type: 'tone', startMs: 0, endMs: 320, hz: 18728 });
  assert.ok(text.length > 0);
  assert.ok(text.includes(formatKHz(18728)));
});

test('describeEvent throws RangeError for an unknown event type', () => {
  assert.throws(() => describeEvent({ type: 'chirp', startMs: 0, endMs: 1 }), RangeError);
});

test('fixture putter-frames.wav decodes to the putter frames', () => {
  const events = decodeFixture('putter-frames.wav');
  const frameEvents = ofType(events, 'frames');
  assert.equal(frameEvents.length, 1);
  assert.deepEqual(frameEvents[0].symbols, PUTTER.symbols);
  // The clip holds 14 frame periods; real frames are noisier than synthetic ones.
  assert.ok(frameEvents[0].frames >= 10, `frames ${frameEvents[0].frames}`);
  assert.ok(frameEvents[0].repeats >= 6, `repeats ${frameEvents[0].repeats}`);
  assert.ok(Math.abs(frameEvents[0].restHz - 17918) < 15);
  assert.ok(Math.abs(frameEvents[0].periodMs - TAG_PROTOCOL.framePeriodMs) < 2);
});

test('fixture iron9-frames.wav decodes to the 9 iron frames', () => {
  const frameEvents = ofType(decodeFixture('iron9-frames.wav'), 'frames');
  assert.equal(frameEvents.length, 1);
  assert.deepEqual(frameEvents[0].symbols, IRON9.symbols);
  assert.ok(frameEvents[0].frames >= 12, `frames ${frameEvents[0].frames}`);
  assert.ok(frameEvents[0].repeats >= 10, `repeats ${frameEvents[0].repeats}`);
  assert.ok(Math.abs(frameEvents[0].restHz - 17909) < 15);
});

test('fixture sandwedge-frames-tone.wav decodes frames then a tone near 18730 Hz', () => {
  const events = decodeFixture('sandwedge-frames-tone.wav');
  const frameEvents = ofType(events, 'frames');
  const toneEvents = ofType(events, 'tone');
  assert.equal(frameEvents.length, 1);
  assert.equal(toneEvents.length, 1);
  assert.deepEqual(frameEvents[0].symbols, WEDGE.symbols);
  assert.ok(Math.abs(toneEvents[0].hz - 18730) <= 15, `hz ${toneEvents[0].hz}`);
  assert.ok(frameEvents[0].startMs < toneEvents[0].startMs);
});

test('fixture iron9-frames-hop.wav decodes frames then a hop at 18900 Hz rest, +405 Hz, 60.7 ms', () => {
  const events = decodeFixture('iron9-frames-hop.wav');
  const frameEvents = ofType(events, 'frames');
  const hopEvents = ofType(events, 'hop');
  assert.equal(frameEvents.length, 1);
  assert.deepEqual(frameEvents[0].symbols, IRON9.symbols);
  assert.equal(hopEvents.length, 1);
  assert.ok(Math.abs(hopEvents[0].restHz - 18900) <= 15, `restHz ${hopEvents[0].restHz}`);
  assert.ok(Math.abs(hopEvents[0].offsetHz - 405) <= 30, `offsetHz ${hopEvents[0].offsetHz}`);
  assert.ok(Math.abs(hopEvents[0].periodMs - 60.7) <= 1.5, `periodMs ${hopEvents[0].periodMs}`);
});

test('fixture sandwedge-hop.wav decodes a hop at 18831 Hz rest, +300 Hz, 122 ms', () => {
  const hopEvents = ofType(decodeFixture('sandwedge-hop.wav'), 'hop');
  assert.equal(hopEvents.length, 1);
  assert.ok(Math.abs(hopEvents[0].restHz - 18831) <= 15, `restHz ${hopEvents[0].restHz}`);
  assert.ok(Math.abs(hopEvents[0].offsetHz - 300) <= 30, `offsetHz ${hopEvents[0].offsetHz}`);
  assert.ok(Math.abs(hopEvents[0].periodMs - 122) <= 1.5, `periodMs ${hopEvents[0].periodMs}`);
});

const PUTTER_SECOND = { restHz: PUTTER.restHz, symbols: [1, 3, 4, 2, 4, -1] };

test('a tag that changes its frame without pausing decodes as two frames events in order', () => {
  const events = decodeTagSignals(recording(concat(frames(PUTTER, 8), frames(PUTTER_SECOND, 8))), SR);
  assert.deepEqual(events.map((e) => e.type), ['frames', 'frames']);
  assert.deepEqual(events[0].symbols, PUTTER.symbols);
  assert.deepEqual(events[1].symbols, PUTTER_SECOND.symbols);
  assert.ok(events[0].repeats >= 6 && events[1].repeats >= 6, `repeats ${events[0].repeats}, ${events[1].repeats}`);
  assert.equal(events[0].endMs, events[1].startMs);
});

test('a frame that returns after another decodes as three frames events', () => {
  const signal = concat(frames(PUTTER, 6), frames(PUTTER_SECOND, 6), frames(PUTTER, 6));
  const events = decodeTagSignals(recording(signal), SR);
  assert.deepEqual(
    events.map((e) => e.symbols),
    [PUTTER.symbols, PUTTER_SECOND.symbols, PUTTER.symbols]
  );
});

test('noisy frames of one tag are not split into several events', () => {
  const events = decodeTagSignals(recording(frames(PUTTER, 20), { noiseRms: AMP / 10 }), SR);
  assert.equal(ofType(events, 'frames').length, 1);
});

test('fixture putter-two-frames.wav decodes the putter frame, then its second frame', () => {
  const frameEvents = ofType(decodeFixture('putter-two-frames.wav'), 'frames');
  assert.deepEqual(
    frameEvents.map((e) => e.symbols),
    [PUTTER.symbols, PUTTER_SECOND.symbols]
  );
  assert.ok(frameEvents[1].repeats >= 5, `repeats ${frameEvents[1].repeats}`);
  assert.ok(Math.abs(frameEvents[0].restHz - frameEvents[1].restHz) < 15);
});

test('synthesised pieces have exactly the protocol length, with no drift', () => {
  assert.equal(
    frames(PUTTER, 10).length,
    Math.round((10 * TAG_PROTOCOL.framePeriodMs * SR) / 1000),
  );
  assert.equal(hop(18830, 300, 121.7, 20).length, Math.round((20 * 121.7 * SR) / 1000));
  assert.equal(tone(18728, 320).length, (320 * SR) / 1000);
});

test('synthesiser fades its pieces in and out from zero', () => {
  const x = frames(PUTTER, 2);
  assert.equal(x[0], 0);
  assert.equal(x[x.length - 1], 0);
});

test('addNoise is reproducible for a seed and leaves its input unchanged', () => {
  const clean = tone(18728, 50);
  const before = Float32Array.from(clean);
  const a = addNoise(clean, NOISE_RMS, SEED);
  const b = addNoise(clean, NOISE_RMS, SEED);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, clean);
  assert.deepEqual(clean, before);
});

test('synthesiser rejects invalid arguments with RangeError', () => {
  assert.throws(() => synthFrames({ sampleRate: 0, restHz: 17920, symbols: [1], repeats: 1 }), RangeError);
  assert.throws(() => synthFrames({ sampleRate: SR, restHz: 17920, symbols: [], repeats: 1 }), RangeError);
  assert.throws(() => synthFrames({ sampleRate: SR, restHz: 17920, symbols: [1], repeats: 0 }), RangeError);
  assert.throws(
    () => synthFrames({ sampleRate: SR, restHz: 17920, symbols: [1, 2, 3, 4, 5, 6, 7, 8, 9], repeats: 1 }),
    RangeError,
  );
  assert.throws(() => synthTone({ sampleRate: SR, hz: 18000, ms: 0 }), RangeError);
  assert.throws(() => synthHop({ sampleRate: SR, restHz: 18000, offsetHz: 300, periodMs: 10, hops: 1 }), RangeError);
  assert.throws(() => silence(SR, -5), RangeError);
});

/* Cases added after review: edges the synthetic happy paths did not reach. */

test('every frame is read, including one that opens the transmission with no rest before it', () => {
  for (const repeats of [1, 2, 10]) {
    const events = decodeTagSignals(recording(frames(IRON9, repeats)), SR);
    const frameEvents = ofType(events, 'frames');
    assert.equal(frameEvents.length, 1, `one frames event for ${repeats} repeats`);
    assert.deepEqual(frameEvents[0].symbols, IRON9.symbols);
    assert.equal(frameEvents[0].frames, repeats);
    assert.equal(frameEvents[0].repeats, repeats);
  }
});

test('a single frame has no period', () => {
  const [event] = decodeTagSignals(recording(frames(WEDGE, 1)), SR);
  assert.equal(event.periodMs, null);
  assert.match(describeEvent(event), /1 of 1 frames agree/);
});

test('tones outside the tag band are not reported at a made-up in-band frequency', () => {
  for (const hz of [16300, 16450, 21050, 21100]) {
    const events = decodeTagSignals(recording(tone(hz, 320)), SR);
    assert.deepEqual(events, [], `nothing for ${hz} Hz`);
  }
});

test('tones just inside the band edges are reported at their true frequency', () => {
  for (const hz of [16600, 20900]) {
    const events = decodeTagSignals(recording(tone(hz, 320)), SR);
    assert.equal(events.length, 1, `one event for ${hz} Hz`);
    assert.ok(Math.abs(events[0].hz - hz) < 10, `${events[0].hz} for ${hz}`);
  }
});

test('the first two hops of a pattern are not mistaken for a tone', () => {
  for (const [periodMs, offsetHz] of [[121.7, 300], [60.7, 400], [90, 350]]) {
    const events = decodeTagSignals(recording(hop(18830, offsetHz, periodMs, 2)), SR);
    assert.deepEqual(ofType(events, 'tone'), [], `no tone at ${periodMs} ms`);
  }
});

test('a hop pattern cut off by the end of the recording is still a hop pattern', () => {
  const whole = recording(hop(18900, 400, 60.7, 30));
  const cut = whole.subarray(0, Math.round(0.9 * SR));
  const events = decodeTagSignals(cut, SR);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'hop');
  assert.ok(Math.abs(events[0].periodMs - 60.7) < 1.5);
});

test('a tone and a hop pattern decode at 44100 Hz', () => {
  const sr = 44100;
  const toneEvents = decodeTagSignals(recording(tone(18728, 320, sr), { sampleRate: sr }), sr);
  assert.equal(toneEvents.length, 1);
  assert.ok(Math.abs(toneEvents[0].hz - 18728) < 10);
  const hopEvents = decodeTagSignals(recording(hop(18830, 300, 121.7, 20, sr), { sampleRate: sr }), sr);
  assert.equal(hopEvents.length, 1);
  assert.equal(hopEvents[0].type, 'hop');
  assert.ok(Math.abs(hopEvents[0].periodMs - 121.7) < 1.5);
  assert.ok(Math.abs(hopEvents[0].offsetHz - 300) < 40);
});

test('pushing after a trim continues the same track', () => {
  const audio = recording(concat(frames(PUTTER, 6), silence(SR, 400), tone(19815, 320)));
  const whole = new ToneTracker(SR);
  whole.push(audio);
  const split = Math.round(1.2 * SR);
  const trimmed = new ToneTracker(SR);
  trimmed.push(audio.subarray(0, split));
  trimmed.trim(0.3);
  trimmed.push(audio.subarray(split));
  const a = whole.track();
  const b = trimmed.track();
  const skipped = Math.round((b.startMs - a.startMs) / a.hopMs);
  assert.ok(skipped > 0);
  assert.equal(b.hz.length, a.hz.length - skipped);
  const nanAsNull = (track, from) => Array.from(track.hz.subarray(from)).map((v) => (Number.isNaN(v) ? null : v));
  assert.deepEqual(nanAsNull(b, 0), nanAsNull(a, skipped));
});

test('a tag sending no symbol 0 is never read as one', () => {
  // A symbol is a departure from rest. A read with a 0 in it means a slot was missed, and
  // the frame is discarded rather than reported.
  const audio = recording(synthFrames({ sampleRate: SR, restHz: 17900, symbols: [2, 2, 2], repeats: 6, amplitude: AMP }));
  assert.deepEqual(ofType(decodeTagSignals(audio, SR), 'frames'), []);
});

/* ---------------------------- weak symbols, taps and timing ---------------------------- */

test('a sample or two in digital silence is not a tap', () => {
  // A muted input has no room level for a sound to stand above.
  const x = new Float32Array(3 * SR);
  x[SR] = 1e-6;
  for (let i = 0; i < 10; i++) x[2 * SR + i] = i % 2 ? 1e-4 : -1e-4;
  assert.deepEqual(decodeTagSignals(x, SR), []);
});

test('fixture putter-weak-first-symbol.wav reads frames whose first symbol is barely heard', () => {
  // From the fifth frame on the −4 is lost, so the first audible departure comes late.
  const frameEvents = ofType(decodeFixture('putter-weak-first-symbol.wav'), 'frames');
  assert.equal(frameEvents.length, 1);
  assert.deepEqual(frameEvents[0].symbols, PUTTER.symbols);
  assert.ok(frameEvents[0].frames >= 14 && frameEvents[0].frames <= 16, `frames ${frameEvents[0].frames}`);
  assert.ok(frameEvents[0].repeats >= 12, `repeats ${frameEvents[0].repeats}`);
});

test('fixture putter-distorted-last-symbol.wav does not yield a solid frame the tag never sent', () => {
  // The last symbol reads −1 for about 4 ms in this capture. No read of it may become solid.
  const frameEvents = ofType(decodeFixture('putter-distorted-last-symbol.wav'), 'frames');
  for (const e of frameEvents) {
    const known = e.symbols.join() === PUTTER.symbols.join();
    assert.ok(known || !isSolidFrames(e), `solid ${formatSymbols(e.symbols)}, ${e.repeats} of ${e.frames}`);
  }
});

test('fixture putter-tap-hit-return.wav decodes resting frame, tap, hit frame and the resting frame again', () => {
  const events = decodeFixture('putter-tap-hit-return.wav');
  const frameEvents = ofType(events, 'frames');
  const taps = ofType(events, 'impact');
  assert.deepEqual(
    frameEvents.map((e) => e.symbols),
    [PUTTER.symbols, PUTTER_SECOND.symbols, PUTTER_SECOND.symbols, PUTTER.symbols]
  );
  assert.equal(taps.length, 1);
  // Timing restarts at the tap: the frames on each side are read from their own side, solidly.
  for (const e of frameEvents) assert.ok(isSolidFrames(e), `${formatSymbols(e.symbols)}: ${e.repeats} of ${e.frames}`);
  assert.ok(Math.abs(frameEvents[1].startMs - taps[0].startMs) < 200);
  assert.ok(Math.abs(frameEvents[3].startMs - 3300) < 100, `resting returns at ${frameEvents[3].startMs}`);
});

test('a stretch where no frame agrees with the vote is not reported', () => {
  for (const name of ['putter-tap-hit-return.wav', 'putter-weak-first-symbol.wav', 'putter-two-frames.wav']) {
    for (const e of ofType(decodeFixture(name), 'frames')) assert.ok(e.repeats > 0, `${name}: ${e.repeats} of ${e.frames}`);
  }
});
