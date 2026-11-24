/**
 * mapping.js - the club mapping station and the saved clubs table.
 *
 * The station sits at the top of the page and is everything needed to map a club with both
 * hands busy: which club is being mapped, what the tag is sending now, what is already saved
 * for that club, and whether the last reading was saved. The table and the decoded timeline
 * of one recording sit further down.
 * DOM only; decoding, the reading, the decision to save and the codebook live in tag-decoder.js,
 * reading.js, session.js and codebook.js.
 */
import { describeEvent, formatKHz, formatSymbols } from './tag-decoder.js';
import { clubSummary, collisions, emptyCodebook, isSolidFrames, matchFrame, matchTone } from './codebook.js';
import { emptyReading, isEmptyReading, readingParts, sameSymbols } from './reading.js';

const DASH = '—';
const NO_SUMMARY = { frame: null, hitFrame: null, toneHz: null, hop: null };

/**
 * @param {string} tag
 * @param {{className?: string, text?: string}} [props]
 * @param {...(Node|string)} children
 * @returns {HTMLElement}
 */
function el(tag, { className, text } = {}, ...children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  node.append(...children);
  return node;
}

/**
 * @param {string} text
 * @param {string} [className]
 * @returns {HTMLButtonElement}
 */
function button(text, className) {
  const node = /** @type {HTMLButtonElement} */ (el('button', { className, text }));
  node.type = 'button';
  return node;
}

/**
 * @param {{restHz: number, offsetHz: number, periodMs: number}} hop
 * @returns {string} for example "18.900 kHz, +407 Hz every 61 ms"
 */
function formatHop(hop) {
  const sign = hop.offsetHz >= 0 ? '+' : '−';
  return `${formatKHz(hop.restHz)}, ${sign}${Math.abs(hop.offsetHz).toFixed(0)} Hz every ${hop.periodMs.toFixed(0)} ms`;
}

/**
 * @param {number} ms
 * @returns {string} for example "0.48 s"
 */
function formatSeconds(ms) {
  return `${(ms / 1000).toFixed(2)} s`;
}

/**
 * One signal of the tag: what is heard now, and what is saved for the chosen club.
 * @param {string} label
 * @returns {{node: HTMLElement, set: (now: string|null, detail: string, saved: string|null, state: string) => void}}
 */
function createTile(label) {
  const now = el('output', { className: 'tile-now' });
  const detail = el('span', { className: 'tile-detail' });
  const saved = el('span', { className: 'tile-saved' });
  const node = el('div', { className: 'tile' }, el('span', { className: 'tile-label', text: label }), now, detail, saved);
  return {
    node,
    set(nowText, detailText, savedText, state) {
      now.textContent = nowText ?? DASH;
      detail.textContent = detailText;
      saved.textContent = savedText === null ? 'Nothing saved yet' : `Saved: ${savedText}`;
      node.dataset.state = state;
    },
  };
}

/**
 * @param {{chips: HTMLElement, layout: HTMLElement, station: HTMLElement, side: HTMLElement, saved: HTMLElement}} roots
 *   chips: the bar of club chips; layout: the element that holds the station and the side
 *   bar, told which mode the page is in; station: the reading in progress; side: the hits
 *   side bar shown while identifying; saved: the saved clubs table further down
 * @param {object} deps
 * @param {{id: string, name: string}[]} deps.clubs
 * @param {(id: string) => string} deps.clubName
 * @param {boolean} deps.autoSave whether saving automatically starts switched on
 * @param {(clubId: string) => void} deps.onClubChange a club chip was pressed
 * @param {() => void} deps.onIdentify the Identify chip was pressed: no club is chosen
 * @param {(clubId: string) => void} deps.onSave save the held reading to the chosen club
 * @param {() => void} deps.onClear forget the held reading
 * @param {(on: boolean) => void} deps.onAutoSaveChange
 * @param {(clubId: string) => void} deps.onRemoveClub delete a club's codebook entry
 * @returns {{
 *   club: () => string|null,
 *   recordIdentified: () => string[]|null,
 *   setHits: (count: number) => void,
 *   autoSave: () => boolean,
 *   setListening: (listening: boolean) => void,
 *   setReading: (reading: import('./reading.js').Reading, source?: string|null) => void,
 *   setBusy: (busy: boolean) => void,
 *   setCodebook: (codebook: object) => void,
 *   setClub: (clubId: string) => void,
 *   setMessage: (text: string, kind?: 'note'|'saved'|'error') => void,
 *   showDecoded: (title: string, events: import('./tag-decoder.js').TagEvent[]|null, note?: string, onUse?: (() => void)|null) => void,
 * }}
 */
export function createMappingView(roots, deps) {
  const { clubs, clubName } = deps;
  let codebook = emptyCodebook();
  let reading = emptyReading();
  /** Name of the recording the reading came from, or null for a live reading. */
  let source = null;
  let busy = false;
  let listening = false;
  let confirmingRemove = null;
  let clubId = clubs[0].id;
  /** True while no club is chosen: tags are named from what is saved and nothing is saved. */
  let identifying = false;
  /**
   * What each transmission heard while identifying turned out to be, oldest first.
   * @type {{who: string, hits: number}[]}
   */
  let identified = [];
  /** The reading last added to `identified`, so that it is not also counted as the one in progress. */
  let identifiedReading = null;
  /** Hits on the tag since the held reading began: the taps it answered. */
  let hits = 0;
  /** Whether the user has picked Identify or a club; until then the page picks for them. */
  let modeChosen = false;

  /* ------------------------------ station ------------------------------ */

  /** @type {Map<string, HTMLButtonElement>} */
  const chips = new Map();
  const chipRow = el('div', { className: 'chips' });
  const identifyChip = button('Identify', 'chip chip-identify');
  identifyChip.addEventListener('click', () => {
    modeChosen = true;
    if (identifying) return;
    identifying = true;
    identified = [];
    identifiedReading = null;
    deps.onIdentify();
    renderChips();
    renderReading();
  });
  chipRow.append(identifyChip);
  for (const c of clubs) {
    const chip = button(c.name, 'chip');
    chip.addEventListener('click', () => chooseClub(c.id, true));
    chips.set(c.id, chip);
    chipRow.append(chip);
  }

  const verdict = el('p', { className: 'map-verdict' });
  verdict.setAttribute('role', 'status');
  const toneTile = createTile('Wake tone');
  const frameTile = createTile('Resting frame');
  const hitTile = createTile('After a hit');
  const tiles = el('div', { className: 'tiles' }, toneTile.node, frameTile.node, hitTile.node);
  // The whole transmission laid out in time: wake tone, resting frame, tap, hit signal.
  const sequenceBar = el('div', { className: 'sequence-bar' });
  sequenceBar.setAttribute('aria-hidden', 'true');
  const sequenceText = el('p', { className: 'sequence-text' });
  const sequence = el('div', { className: 'sequence' }, sequenceBar, sequenceText);

  const saveBtn = button('Save', 'primary');
  saveBtn.addEventListener('click', () => deps.onSave(clubId));
  const clearBtn = button('Clear reading');
  clearBtn.addEventListener('click', () => deps.onClear());
  const autoBox = /** @type {HTMLInputElement} */ (el('input'));
  autoBox.type = 'checkbox';
  autoBox.checked = deps.autoSave;
  autoBox.addEventListener('change', () => deps.onAutoSaveChange(autoBox.checked));
  const autoLabel = el('label', { className: 'check' }, autoBox, ' Save by itself when the tag goes quiet');
  const message = el('p', { className: 'map-message' });
  message.setAttribute('role', 'status');
  const sourceNote = el('p', { className: 'note' });
  const actions = el('div', { className: 'map-actions' }, saveBtn, clearBtn, autoLabel);
  // While identifying, the three tiles give way to one line of what the club was known from.
  const evidence = el('p', { className: 'map-evidence' });

  // The side bar: hits per club, then every hit as it happened, newest first.
  const hitTotals = el('tbody');
  const hitTotalsTable = el('table', { className: 'hit-totals' }, hitTotals);
  const hitEmpty = el('p', { className: 'note', text: 'Light a tag and hit the club. Each hit is counted here.' });
  const hitLog = el('ol', { className: 'hit-log' });
  hitLog.setAttribute('role', 'log');
  hitLog.setAttribute('aria-label', 'Every hit, newest first');
  const clearHitsBtn = button('Clear hits');
  clearHitsBtn.addEventListener('click', () => {
    identified = [];
    // The transmission on screen was counted in what is cleared: it does not come back.
    identifiedReading = reading;
    hits = 0;
    renderReading();
  });
  roots.side.replaceChildren(
    el('div', { className: 'hit-side-inner' }, el('div', { className: 'hit-side-head' }, el('h2', { text: 'Hits' }), clearHitsBtn), hitEmpty, hitTotalsTable, el('h3', { className: 'hit-log-head', text: 'Log' }), hitLog)
  );
  roots.chips.replaceChildren(chipRow);

  roots.station.replaceChildren(
    verdict,
    tiles,
    evidence,
    sequence,
    actions,
    message,
    sourceNote
  );

  /* ------------------------------ saved clubs ------------------------------ */

  const progress = el('p', { className: 'note' });
  const tbody = el('tbody');
  const table = el(
    'table',
    {},
    el(
      'thead',
      {},
      el(
        'tr',
        {},
        ...['Club', 'Resting frame', 'Frame after a hit', 'Frame rest tone', 'Wake tone', 'Hop pattern', 'Readings', ''].map((h) => {
          const th = el('th', { text: h });
          th.scope = 'col';
          return th;
        })
      )
    ),
    tbody
  );

  const decodedTitle = el('h3', { className: 'map-subhead' });
  const decodedList = el('ol', { className: 'map-events' });
  const decodedNote = el('p', { className: 'note' });
  let useDecoded = null;
  const useBtn = button('Use as the reading');
  useBtn.addEventListener('click', () => {
    useDecoded?.();
    window.scrollTo({ top: 0 });
  });
  const decoded = el('div', { className: 'map-decoded' }, decodedTitle, decodedList, decodedNote, useBtn);
  decoded.hidden = true;

  roots.saved.replaceChildren(el('h2', { text: 'Saved clubs' }), progress, el('div', { className: 'table-wrap' }, table), decoded);

  /* ------------------------------ rendering ------------------------------ */

  /**
   * @returns {{clubs: string[], afterHit: boolean}|null} the saved clubs the held reading's
   *   frame belongs to (none for a frame nobody has), or null while no frame is read clearly.
   *   afterHit: it was known from the frame it sends after a hit.
   */
  function recognise() {
    const { frames, hitFrames } = reading;
    if (frames && isSolidFrames(frames)) return { clubs: matchFrame(codebook, frames.symbols), afterHit: false };
    if (hitFrames && isSolidFrames(hitFrames)) return { clubs: matchFrame(codebook, hitFrames.symbols), afterHit: true };
    return null;
  }

  /** @returns {import('./codebook.js').ClubSummary} what is saved for the club shown */
  function savedForClub() {
    const known = identifying ? recognise() : null;
    const id = identifying ? (known && known.clubs.length === 1 ? known.clubs[0] : null) : clubId;
    const entry = id === null ? undefined : codebook.clubs[id];
    return entry ? clubSummary(entry) : NO_SUMMARY;
  }

  /**
   * @param {string} id
   * @param {boolean} byHand true when the user chose it
   * @returns {void}
   */
  function chooseClub(id, byHand) {
    if (!chips.has(id)) return;
    // Only a chip pressed by hand ends identifying; a recognised or remembered club does not.
    if (identifying && !byHand) return;
    if (byHand) modeChosen = true;
    identifying = false;
    clubId = id;
    if (byHand) deps.onClubChange(id);
    renderChips();
    renderReading();
  }

  /** @returns {void} */
  function renderChips() {
    identifyChip.setAttribute('aria-pressed', String(identifying));
    for (const [id, chip] of chips) {
      const entry = codebook.clubs[id];
      const mapped = Boolean(entry && clubSummary(entry).frame);
      chip.setAttribute('aria-pressed', String(!identifying && id === clubId));
      chip.dataset.mapped = String(mapped);
      chip.textContent = mapped ? `✓ ${clubName(id)}` : clubName(id);
    }
  }

  /**
   * @param {number} count
   * @returns {string} for example "no hits", "1 hit", "3 hits"
   */
  function hitCount(count) {
    return count === 0 ? 'no hits' : count === 1 ? '1 hit' : `${count} hits`;
  }

  /** @returns {{text: string, state: string}} headline while identifying: the club, or why not */
  function identifyVerdict() {
    if (isEmptyReading(reading)) {
      return listening
        ? { text: 'Identifying. Light any tag.', state: 'idle' }
        : { text: 'Press Start listening, then light any tag.', state: 'idle' };
    }
    const known = recognise();
    if (known === null) {
      if (reading.frames) return { text: 'Reading the frame. Keep the light on.', state: 'idle' };
      if (reading.hop) return { text: 'Hit heard, but not the frame before it. Light the tag again.', state: 'warn' };
      return { text: 'Wake tone only. Hold the light longer.', state: 'warn' };
    }
    if (known.clubs.length === 0) return { text: 'Unknown tag. This frame is not saved for any club.', state: 'warn' };
    if (known.clubs.length > 1) {
      return { text: `This frame is saved for ${known.clubs.map(clubName).join(' and ')}.`, state: 'clash' };
    }
    // The count is the club's total since Identify was chosen: lit twice and hit once each
    // time, it has been hit twice.
    const who = clubName(known.clubs[0]);
    const total = passes().reduce((sum, p) => sum + (p.who === who ? p.hits : 0), 0);
    return { text: `${who}, ${hitCount(total)}`, state: 'known' };
  }

  /**
   * @param {{clubs: string[]}|null} known what recognise() made of a reading
   * @returns {string} the name a transmission is listed under
   */
  function nameOf(known) {
    if (known === null) return 'Not read';
    return known.clubs.length === 0 ? 'Unknown tag' : known.clubs.map(clubName).join(' or ');
  }

  /**
   * @returns {{who: string, hits: number}[]} every transmission since Identify was chosen,
   *   oldest first: the finished ones, then the one in progress once its club is known
   */
  function passes() {
    const known = isEmptyReading(reading) || reading === identifiedReading ? null : recognise();
    return known === null ? identified : [...identified, { who: nameOf(known), hits }];
  }

  /** @returns {void} */
  function renderIdentified() {
    const all = passes();
    // One line per hit, numbered per club, so the log reads as the hits happened.
    const totals = new Map();
    const lines = [];
    for (const [i, { who, hits: count }] of all.entries()) {
      // A tag that went quiet without a hit is worth a line; one still being heard is not yet.
      // A stretch of signal too short to name a club and with no hit in it (a brief flash of
      // light, the tail of a pattern after a dropout) is in the server's log but not listed.
      if (count === 0 && who === nameOf(null)) continue;
      if (count === 0 && i < identified.length) lines.push(`${who}, no hit`);
      for (let n = 0; n < count; n++) {
        totals.set(who, (totals.get(who) ?? 0) + 1);
        lines.push(`${who}, hit ${totals.get(who)}`);
      }
    }
    hitEmpty.hidden = all.length > 0;
    hitTotalsTable.hidden = totals.size === 0;
    hitTotals.replaceChildren(
      ...[...totals].map(([who, count]) => el('tr', {}, el('th', { text: who }), el('td', { text: String(count) })))
    );
    clearHitsBtn.disabled = all.length === 0;
    hitLog.replaceChildren(...lines.reverse().map((text) => el('li', { text })));
  }

  /** @returns {{text: string, state: string}} headline for the held reading */
  function verdictFor() {
    if (identifying) return identifyVerdict();
    if (isEmptyReading(reading)) {
      return listening
        ? { text: `Ready for the ${clubName(clubId)}. Light its tag and hold for 3 seconds.`, state: 'idle' }
        : { text: 'Press Start listening, then choose a club.', state: 'idle' };
    }
    const { frames, hitFrames, tone } = reading;
    if (frames) {
      if (!isSolidFrames(frames) && hitFrames) {
        const hitOf = matchFrame(codebook, hitFrames.symbols);
        return hitOf.length === 1
          ? { text: `This is the ${clubName(hitOf[0])}, after a hit.`, state: 'known' }
          : { text: 'Tapped too soon. Light the tag again and wait 2 seconds before tapping.', state: 'warn' };
      }
      if (!isSolidFrames(frames)) return { text: 'Reading the frame. Keep the light on.', state: 'idle' };
      const known = matchFrame(codebook, frames.symbols);
      if (known.length > 1) {
        return { text: `This frame is saved for ${known.map(clubName).join(' and ')}.`, state: 'clash' };
      }
      // One pass maps a club: light, resting frame, tap, hit signal, light away.
      const who = known.length === 1 ? `This is the ${clubName(known[0])}.` : `New tag, saving as the ${clubName(clubId)}.`;
      const next = hitFrames || reading.hop ? 'Hit heard. Take the light away.' : 'Now tap the club.';
      return { text: `${who} ${next}`, state: known.length === 1 ? 'known' : 'new' };
    }
    if (tone) {
      const near = matchTone(codebook, tone.hz);
      const who = near.length > 0 ? ` It matches the ${clubName(near[0])}.` : '';
      return { text: `Wake tone only.${who} Hold the light longer to get the frame.`, state: 'warn' };
    }
    return { text: 'Heard a tag, but no frame yet. Hold the light on it.', state: 'idle' };
  }

  /** @returns {void} */
  function renderSequence() {
    const parts = readingParts(reading);
    if (parts.length === 0) {
      sequenceBar.replaceChildren();
      sequenceText.textContent = 'The sequence of signals appears here: wake tone, resting frame, tap, hit.';
      return;
    }
    const t0 = parts[0].startMs;
    const span = Math.max(1, Math.max(...parts.map((p) => p.endMs)) - t0);
    sequenceBar.replaceChildren(
      ...parts.map((p) => {
        const block = el('span', { className: 'sequence-part', text: p.kind === 'tap' ? '' : p.label });
        block.dataset.kind = p.kind;
        block.style.left = `${((p.startMs - t0) / span) * 100}%`;
        block.style.width = p.kind === 'tap' ? '' : `${((p.endMs - p.startMs) / span) * 100}%`;
        return block;
      })
    );
    sequenceText.textContent = parts
      .map((p) =>
        p.kind === 'tap'
          ? `tap at ${formatSeconds(p.startMs - t0)}`
          : `${p.label} ${formatSeconds(p.startMs - t0)} to ${formatSeconds(p.endMs - t0)}`
      )
      .join(', ');
  }

  /** @returns {string} how long after the tap the hit signal began, when a tap was heard */
  function tapDelay() {
    const hit = reading.hitFrames ?? reading.hop;
    if (!hit || !reading.impact) return '';
    const ms = Math.max(0, hit.startMs - reading.impact.startMs);
    return `, ${(ms / 1000).toFixed(2)} s after the tap`;
  }

  /** @returns {void} */
  function renderReading() {
    const { frames, hitFrames, tone, hop } = reading;
    const saved = savedForClub();
    const v = verdictFor();
    verdict.textContent = v.text;
    verdict.dataset.state = v.state;

    toneTile.set(
      tone ? formatKHz(tone.hz) : null,
      '',
      saved.toneHz === null ? null : formatKHz(saved.toneHz),
      tone ? 'heard' : saved.toneHz === null ? 'empty' : 'saved'
    );

    const solid = Boolean(frames && isSolidFrames(frames));
    const differs = Boolean(solid && saved.frame && !sameSymbols(frames.symbols, saved.frame.symbols));
    frameTile.set(
      frames ? formatSymbols(frames.symbols) : null,
      frames ? `${frames.repeats} of ${frames.frames} frames agree${differs ? ', differs from saved' : ''}` : '',
      saved.frame ? formatSymbols(saved.frame.symbols) : null,
      differs ? 'clash' : solid ? 'heard' : frames ? 'weak' : saved.frame ? 'saved' : 'empty'
    );

    // A hit shows as a hop pattern on most tags and as a second frame on the putter's.
    const hitNow = hitFrames ? formatSymbols(hitFrames.symbols) : hop ? formatHop(hop) : null;
    const hitSaved = saved.hitFrame ? formatSymbols(saved.hitFrame.symbols) : saved.hop ? formatHop(saved.hop) : null;
    hitTile.set(
      hitNow,
      hitNow ? `${hitFrames ? 'second frame' : 'hop pattern'}${tapDelay()}` : '',
      hitSaved,
      hitNow ? 'heard' : hitSaved ? 'saved' : 'empty'
    );

    renderSequence();
    actions.hidden = identifying;
    tiles.hidden = identifying;
    evidence.hidden = !identifying;
    evidence.textContent = [
      frames ? `Frame ${formatSymbols(frames.symbols)}, ${frames.repeats} of ${frames.frames} agree` : '',
      tone ? `wake tone ${formatKHz(tone.hz)}` : '',
      hitNow ? `after a hit ${hitNow}` : '',
    ]
      .filter(Boolean)
      .join('; ');
    roots.side.hidden = !identifying;
    roots.layout.dataset.mode = identifying ? 'identify' : 'map';
    renderIdentified();
    saveBtn.disabled = busy || !(solid || (hitFrames && isSolidFrames(hitFrames)) || tone || hop);
    saveBtn.textContent = `Save as ${clubName(clubId)}`;
    clearBtn.disabled = isEmptyReading(reading);
    sourceNote.textContent = source
      ? `Taken from a recording (${source}). Live listening resumes when you save or clear it.`
      : '';
  }

  /**
   * @param {string} id
   * @returns {HTMLElement} the remove control for one codebook row
   */
  function removeButton(id) {
    const confirming = confirmingRemove === id;
    const btn = button(confirming ? `Remove ${clubName(id)} readings` : 'Remove', confirming ? 'alert' : undefined);
    btn.disabled = busy;
    btn.addEventListener('click', () => {
      if (confirming) {
        confirmingRemove = null;
        deps.onRemoveClub(id);
      } else {
        confirmingRemove = id;
        renderCodebook();
      }
    });
    btn.addEventListener('blur', () => {
      if (confirmingRemove === id) {
        confirmingRemove = null;
        renderCodebook();
      }
    });
    return btn;
  }

  /** @returns {void} */
  function renderCodebook() {
    const clashing = new Set(collisions(codebook).flatMap((c) => c.clubIds));
    let mapped = 0;
    const rows = clubs.map((club) => {
      const entry = codebook.clubs[club.id];
      const summary = entry ? clubSummary(entry) : NO_SUMMARY;
      if (summary.frame) mapped++;
      const symbolsCell = el('td', { className: 'map-symbols', text: summary.frame ? formatSymbols(summary.frame.symbols) : DASH });
      if (summary.frame && !summary.frame.consistent) {
        symbolsCell.append(' ', el('span', { className: 'warning', text: 'readings disagree' }));
      }
      if (clashing.has(club.id)) {
        symbolsCell.append(' ', el('span', { className: 'error', text: 'same as another club' }));
      }
      const count = entry ? entry.observations.length : 0;
      const tr = el(
        'tr',
        {},
        el('td', { text: club.name }),
        symbolsCell,
        el('td', { className: 'map-symbols', text: summary.hitFrame ? formatSymbols(summary.hitFrame.symbols) : DASH }),
        el('td', { text: summary.frame ? formatKHz(summary.frame.restHz) : DASH }),
        el('td', { text: summary.toneHz === null ? DASH : formatKHz(summary.toneHz) }),
        el('td', { text: summary.hop ? formatHop(summary.hop) : DASH }),
        el('td', { text: count ? String(count) : DASH }),
        el('td', {}, ...(count ? [removeButton(club.id)] : []))
      );
      if (!summary.frame) tr.className = 'map-unmapped';
      return tr;
    });
    tbody.replaceChildren(...rows);
    progress.textContent = `${mapped} of ${clubs.length} clubs have a saved resting frame.`;
  }

  renderChips();
  renderReading();
  renderCodebook();

  return {
    club: () => (identifying ? null : clubId),
    recordIdentified() {
      if (!identifying || isEmptyReading(reading)) return null;
      const known = recognise();
      identified.push({ who: nameOf(known), hits });
      identifiedReading = reading;
      renderReading();
      return known === null ? null : known.clubs;
    },
    setHits(count) {
      if (count === hits) return;
      hits = count;
      renderReading();
    },
    autoSave: () => autoBox.checked,
    setListening(value) {
      listening = value;
      renderReading();
    },
    setReading(value, from = null) {
      reading = value;
      source = from;
      renderReading();
    },
    setBusy(value) {
      busy = value;
      renderReading();
      renderCodebook();
    },
    setCodebook(value) {
      codebook = value;
      confirmingRemove = null;
      // With clubs already mapped, the page opens identifying them; with none, mapping.
      if (!modeChosen && !identifying && Object.values(codebook.clubs).some((entry) => clubSummary(entry).frame)) {
        identifying = true;
      }
      renderChips();
      renderCodebook();
      renderReading();
    },
    setClub(id) {
      chooseClub(id, false);
    },
    setMessage(text, kind = 'note') {
      message.textContent = text;
      message.dataset.kind = kind;
    },
    showDecoded(title, events, note = '', onUse = null) {
      decoded.hidden = false;
      useDecoded = onUse;
      useBtn.hidden = !(onUse && events && events.length > 0);
      decodedTitle.textContent = title;
      decodedNote.textContent = events && events.length === 0 ? 'No tag signal found in this recording.' : note;
      decodedList.replaceChildren(
        ...(events ?? []).map((e) =>
          el(
            'li',
            {},
            el('span', { className: 'map-time', text: `${formatSeconds(e.startMs)} to ${formatSeconds(e.endMs)}` }),
            ' ',
            describeEvent(e)
          )
        )
      );
    },
  };
}
