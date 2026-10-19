import { matchesReading } from './study.mjs';

export const DEFAULT_ANKI_ENDPOINT = 'http://127.0.0.1:8766';
export const ANKI_API_VERSION = 6;

const ALLOWED_ACTIONS = new Set([
  'requestPermission', 'version', 'deckNames', 'findNotes', 'notesInfo', 'getReviewsOfCards', 'gradeNow',
]);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const EASE_BY_RATING = Object.freeze({ Again: 1, Hard: 2, Good: 3, Easy: 4 });

export function normalizeAnkiEndpoint(value) {
  let url;
  try {
    url = new URL(String(value ?? '').trim());
  } catch {
    throw new Error('Enter a valid local AnkiConnect URL.');
  }
  if (url.protocol !== 'http:') throw new Error('AnkiConnect must use local HTTP.');
  if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error('For safety, AnkiConnect must be on this device (127.0.0.1 or localhost).');
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('Use only the local AnkiConnect address and port, without a path or credentials.');
  }
  if (!url.port) throw new Error('Enter the AnkiConnect port.');
  return url.origin;
}

export function buildDeckQuery(deckName) {
  const deck = String(deckName ?? '').trim();
  if (!deck) throw new Error('Choose an Anki deck first.');
  return `deck:"${deck.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

export async function invokeAnki(endpoint, action, params = {}, options = {}) {
  if (!ALLOWED_ACTIONS.has(action)) throw new Error(`Anki action is not allowed: ${action}`);
  const url = normalizeAnkiEndpoint(endpoint);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('This browser does not support fetch.');
  const body = { action, version: ANKI_API_VERSION, params };
  if (options.apiKey) body.key = String(options.apiKey);
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new Error(`Cannot reach AnkiConnect at ${url}. Keep Anki open and allow this site's origin in AnkiConnect. ${error?.message || ''}`.trim());
  }
  if (!response.ok) throw new Error(`AnkiConnect returned HTTP ${response.status}.`);
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('AnkiConnect returned invalid JSON.');
  }
  if (!payload || typeof payload !== 'object' || !Object.hasOwn(payload, 'result')) {
    throw new Error('AnkiConnect returned an unexpected response.');
  }
  if (payload.error) throw new Error(String(payload.error));
  return payload.result;
}

export async function connectToAnki(endpoint, options = {}) {
  const url = normalizeAnkiEndpoint(endpoint);
  const permission = await invokeAnki(url, 'requestPermission', {}, options);
  if (permission?.permission === 'denied') {
    throw new Error('AnkiConnect permission was denied. Allow this site\'s origin in Anki.');
  }
  if (permission?.permission && permission.permission !== 'granted') {
    throw new Error('AnkiConnect did not grant permission to this site.');
  }
  if (permission?.requireApiKey && !options.apiKey) {
    throw new Error('AnkiConnect requires an API key. Enter it for this session and reconnect.');
  }
  const version = Number(permission?.version ?? await invokeAnki(url, 'version', {}, options));
  if (!Number.isFinite(version) || version < ANKI_API_VERSION) {
    throw new Error(`AnkiConnect API version 6 or later is required; received ${permission?.version ?? version}.`);
  }
  const decks = await invokeAnki(url, 'deckNames', {}, options);
  if (!Array.isArray(decks) || !decks.every((deck) => typeof deck === 'string')) {
    throw new Error('AnkiConnect returned an invalid deck list.');
  }
  return { version, decks };
}

function cleanField(value) {
  return String(value?.value ?? value ?? '')
    .replace(/<br\s*\/?\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .normalize('NFC');
}

function getField(fields, names) {
  const pairs = Object.entries(fields || {});
  for (const name of names) {
    const found = pairs.find(([fieldName]) => fieldName.toLowerCase() === name.toLowerCase());
    if (found) return cleanField(found[1]);
  }
  return '';
}

function noteExpression(note) {
  return getField(note?.fields, ['Expression', 'Term', 'Word', 'Vocabulary', 'Front']);
}

function noteReadings(note) {
  let value = getField(note?.fields, ['Reading', 'Kana', 'Pronunciation', 'Back']);
  value = value.replace(/^reading\s*:\s*/i, '').split(/\s*[·|｜]\s*/u)[0].trim();
  return value.split(/[、,，;；]/u).map((reading) => reading.trim()).filter(Boolean);
}

function sameExpression(left, right) {
  return cleanField(left).normalize('NFKC') === cleanField(right).normalize('NFKC');
}

function cardIdentifier(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

export function mapOutcomesToCards(outcomes, notes) {
  const mapped = (outcomes || []).map((item) => {
    const expression = String(item?.kanji ?? item?.term ?? '').trim();
    const reading = String(item?.reading ?? '').trim();
    if (!expression || !reading || !Object.hasOwn(EASE_BY_RATING, item?.rating)) {
      return { ...item, status: 'unmatched', cardId: null, noteId: null };
    }
    const candidates = (notes || []).filter((note) => (
      sameExpression(expression, noteExpression(note))
      && matchesReading(reading, noteReadings(note))
    ));
    if (candidates.length !== 1) {
      return { ...item, status: candidates.length ? 'ambiguous' : 'unmatched', cardId: null, noteId: null };
    }
    const note = candidates[0];
    const cards = Array.isArray(note.cards) ? note.cards : [];
    if (cards.length !== 1) return { ...item, status: 'ambiguous', cardId: null, noteId: note.noteId ?? null };
    const cardId = cardIdentifier(cards[0]);
    if (cardId === null) return { ...item, status: 'unmatched', cardId: null, noteId: note.noteId ?? null };
    return { ...item, status: 'matched', cardId, noteId: note.noteId ?? null, ease: EASE_BY_RATING[item.rating] };
  });

  const cardCounts = new Map();
  for (const item of mapped) {
    if (item.status === 'matched') cardCounts.set(item.cardId, (cardCounts.get(item.cardId) || 0) + 1);
  }
  return mapped.map((item) => item.status === 'matched' && cardCounts.get(item.cardId) > 1
    ? { ...item, status: 'ambiguous', cardId: null, noteId: null }
    : item);
}

function reviewsFor(reviewMap, cardId) {
  const reviews = reviewMap?.[String(cardId)] ?? reviewMap?.[cardId];
  return Array.isArray(reviews) ? reviews : [];
}

function maxReviewId(reviews) {
  return reviews.reduce((max, review) => Math.max(max, Number(review?.id) || 0), 0);
}

export async function gradeOutcomesWithAnki({ endpoint, deckName, outcomes, fetchImpl = globalThis.fetch, apiKey = '' }) {
  const url = normalizeAnkiEndpoint(endpoint);
  const options = { fetchImpl, apiKey };
  const noteIds = await invokeAnki(url, 'findNotes', { query: buildDeckQuery(deckName) }, options);
  if (!Array.isArray(noteIds)) throw new Error('AnkiConnect returned invalid note IDs.');
  const notes = noteIds.length ? await invokeAnki(url, 'notesInfo', { notes: noteIds }, options) : [];
  if (!Array.isArray(notes)) throw new Error('AnkiConnect returned invalid note details.');
  let planned = mapOutcomesToCards(outcomes, notes);
  const matched = planned.filter((item) => item.status === 'matched');
  if (!matched.length) return { outcomes: planned, error: '' };

  const allCardIds = matched.map((item) => item.cardId);
  const before = await invokeAnki(url, 'getReviewsOfCards', { cards: allCardIds }, options);
  const startingIds = new Map(allCardIds.map((cardId) => [cardId, maxReviewId(reviewsFor(before, cardId))]));
  const groups = new Map();
  for (const item of matched) {
    if (!groups.has(item.ease)) groups.set(item.ease, []);
    groups.get(item.ease).push(item.cardId);
  }

  let error = '';
  for (const [ease, cardIds] of groups) {
    try {
      const result = await invokeAnki(url, 'gradeNow', { cards: cardIds, ease }, options);
      if (result !== true) throw new Error('AnkiConnect did not confirm the grade operation.');
      const after = await invokeAnki(url, 'getReviewsOfCards', { cards: cardIds }, options);
      const verified = new Set(cardIds.filter((cardId) => reviewsFor(after, cardId).some((review) => (
        Number(review?.id) > startingIds.get(cardId) && Number(review?.ease) === ease
      ))));
      planned = planned.map((item) => item.status === 'matched' && item.ease === ease
        ? { ...item, status: verified.has(item.cardId) ? 'applied' : 'unknown' }
        : item);
      if (verified.size !== cardIds.length) error = 'AnkiConnect accepted the request, but its review history did not verify every card. Do not retry unknown grades until you check Anki.';
    } catch (failure) {
      error = failure?.message || 'AnkiConnect could not confirm the grade operation. Check Anki before retrying.';
      planned = planned.map((item) => item.status === 'matched' && item.ease === ease
        ? { ...item, status: 'unknown' }
        : item);
      break;
    }
  }
  return { outcomes: planned, error };
}
