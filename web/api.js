/**
 * api.js - client for the OSSTagLab server's /api/captures, /api/codebook and
 * /api/identifications endpoints (same origin).
 *
 * Every function throws an Error on failure. The message is the server's
 * {error} text when it sent one, otherwise the HTTP status; a network failure
 * gets a message saying the server could not be reached.
 */

const BASE = '/api/captures';
const CODEBOOK = '/api/codebook';
const IDENTIFICATIONS = '/api/identifications';

/**
 * @param {string} url
 * @param {RequestInit} [init]
 * @returns {Promise<Response>} a 2xx response
 * @throws {Error} with a `status` property holding the HTTP status when the server answered
 */
async function request(url, init) {
  let res;
  try {
    res = await fetch(url, init);
  } catch {
    throw new Error('Could not reach the capture server. Is server.py running?');
  }
  if (!res.ok) {
    const error = new Error(await errorMessage(res));
    error.status = res.status;
    throw error;
  }
  return res;
}

/**
 * @param {Response} res a non-2xx response
 * @returns {Promise<string>} the server's error text, or the HTTP status
 */
async function errorMessage(res) {
  try {
    const body = await res.json();
    if (body && typeof body.error === 'string' && body.error) return body.error;
  } catch {
    // Body was not JSON; fall through to the status.
  }
  return `Server responded with HTTP ${res.status}`;
}

/**
 * @returns {Promise<object[]>} capture metadata, newest first
 */
export async function listCaptures() {
  const res = await request(BASE);
  const body = await res.json();
  return Array.isArray(body.captures) ? body.captures : [];
}

/**
 * Store a capture: metadata in the query string, WAV bytes as the body.
 * @param {object} meta capture metadata (no samples)
 * @param {ArrayBuffer} wavArrayBuffer encoded WAV file
 * @returns {Promise<object>} stored metadata including the server id
 */
export async function saveCapture(meta, wavArrayBuffer) {
  const url = `${BASE}?meta=${encodeURIComponent(JSON.stringify(meta))}`;
  const res = await request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'audio/wav' },
    body: wavArrayBuffer,
  });
  return res.json();
}

/**
 * @param {string} id server capture id
 * @returns {Promise<ArrayBuffer>} the stored WAV bytes
 */
export async function fetchCaptureWav(id) {
  const res = await request(`${BASE}/${encodeURIComponent(id)}.wav`);
  return res.arrayBuffer();
}

/**
 * Shallow-merge a JSON patch into a stored capture.
 * @param {string} id
 * @param {object} patch
 * @returns {Promise<object>} updated metadata
 */
export async function patchCapture(id, patch) {
  const res = await request(`${BASE}/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  return res.json();
}

/**
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function deleteCapture(id) {
  await request(`${BASE}/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/**
 * @returns {Promise<{version: number, clubs: object}>} the stored codebook
 *   (the empty codebook when none has been saved yet)
 */
export async function getCodebook() {
  const res = await request(CODEBOOK);
  return res.json();
}

/**
 * Replace the stored codebook. The server validates it and rejects anything
 * that is not {version: 1, clubs: {...}}.
 * @param {{version: number, clubs: object}} codebook
 * @returns {Promise<{version: number, clubs: object}>} the stored codebook
 */
export async function putCodebook(codebook) {
  const res = await request(CODEBOOK, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(codebook),
  });
  return res.json();
}

/**
 * Append one identified transmission to the server's log (identifications.jsonl).
 * @param {object} entry what was heard: the club, the taps, the signals
 * @returns {Promise<object>} the entry as stored, with the time it was logged
 */
export async function logIdentification(entry) {
  const res = await request(IDENTIFICATIONS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entry),
  });
  return res.json();
}
