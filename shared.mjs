import { fsrsReviewKey, resolveItemOutcomes, scheduleFsrsReview } from './study.mjs';

const EMPTY_STATE = {
  sessions: [],
  cards: [],
  reviewStates: {},
  reviewEvents: [],
  userGlosses: {},
};

export function parseItemOutcomes(text) {
  const outcomes = [];
  const seen = new Set();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = line.trim().normalize('NFKC').match(/^(.+?)\s*\(([^)]+)\)\s*(?:=|:|-)\s*(Again|Hard|Good|Easy|correct|right|wrong|incorrect)\s*$/i);
    if (!match) throw new Error(`Invalid per-word outcome: “${line.trim()}”. Use expression (reading) = Again/Hard/Good/Easy.`);
    const kanji = match[1].trim();
    const reading = match[2].trim();
    if (!kanji || !reading) throw new Error('Each per-word outcome needs an expression and reading.');
    const key = `${kanji}\u0000${reading}`;
    if (seen.has(key)) throw new Error(`Duplicate per-word outcome for ${kanji} (${reading}).`);
    seen.add(key);
    const label = match[3].toLowerCase();
    const rating = label === 'right' || label === 'correct' ? 'Good'
      : label === 'wrong' || label === 'incorrect' ? 'Again'
        : label[0].toUpperCase() + label.slice(1);
    outcomes.push({ kanji, reading, rating });
  }
  return outcomes;
}

function canonicalOutcomes(result) {
  return resolveItemOutcomes(result)
    .map(({ kanji, reading, rating }) => [kanji, reading, rating])
    .sort((a, b) => a.join('\u0000').localeCompare(b.join('\u0000')));
}

export function stableQuizSessionId(result) {
  const canonical = JSON.stringify([
    String(result?.date ?? ''),
    Number(result?.correct ?? 0),
    Number(result?.total ?? 0),
    canonicalOutcomes(result),
  ]);
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `kotoba-${hash.toString(16).padStart(8, '0')}`;
}

function normalizeGloss(value) {
  if (typeof value === 'string') return { text: value, updatedAt: '1970-01-01T00:00:00.000Z' };
  if (value && typeof value === 'object') {
    return {
      text: String(value.text ?? ''),
      updatedAt: String(value.updatedAt ?? '1970-01-01T00:00:00.000Z'),
    };
  }
  return { text: '', updatedAt: '1970-01-01T00:00:00.000Z' };
}

function pickLatest(left, right, timestampKey = 'updatedAt') {
  const leftTime = Date.parse(left?.[timestampKey] || left?.last_review || 0) || 0;
  const rightTime = Date.parse(right?.[timestampKey] || right?.last_review || 0) || 0;
  return rightTime > leftTime ? right : left;
}

function reviewModeFor(event) {
  return event.reviewMode === 'reading' || event.reviewMode === 'meaning'
    ? event.reviewMode
    : event.source === 'kotoba-import' ? 'reading' : 'meaning';
}

export function mergeSharedStates(local = {}, remote = {}) {
  const left = { ...EMPTY_STATE, ...local };
  const right = { ...EMPTY_STATE, ...remote };

  const sessions = new Map();
  for (const session of [...(right.sessions || []), ...(left.sessions || [])]) {
    if (session?.id != null) sessions.set(String(session.id), session);
  }

  const cards = new Map();
  for (const card of [...(right.cards || []), ...(left.cards || [])]) {
    if (card?.id == null) continue;
    const id = String(card.id);
    cards.set(id, cards.has(id) ? pickLatest(cards.get(id), card) : card);
  }

  const events = new Map();
  for (const event of [...(right.reviewEvents || []), ...(left.reviewEvents || [])]) {
    if (!event?.id || !event?.cardId || !event?.rating || !event?.reviewedAt) continue;
    const id = String(event.id);
    events.set(id, events.has(id) ? pickLatest(events.get(id), event, 'reviewedAt') : event);
  }
  const reviewEvents = [...events.values()].sort((a, b) =>
    String(a.reviewedAt).localeCompare(String(b.reviewedAt)) || String(a.id).localeCompare(String(b.id)));

  const reviewStates = {};
  for (const event of reviewEvents) {
    const mode = reviewModeFor(event);
    const key = fsrsReviewKey(String(event.cardId), mode);
    reviewStates[key] = scheduleFsrsReview(reviewStates[key], event.rating, new Date(event.reviewedAt));
  }
  const eventKeys = new Set(reviewEvents.map((event) => fsrsReviewKey(String(event.cardId), reviewModeFor(event))));
  for (const state of [right.reviewStates || {}, left.reviewStates || {}]) {
    for (const [key, card] of Object.entries(state)) {
      if (card?.due && !eventKeys.has(key)) {
        reviewStates[key] = reviewStates[key] ? pickLatest(reviewStates[key], card, 'last_review') : card;
      }
    }
  }

  const userGlosses = {};
  for (const key of new Set([...Object.keys(right.userGlosses || {}), ...Object.keys(left.userGlosses || {})])) {
    const a = normalizeGloss(left.userGlosses?.[key]);
    const b = normalizeGloss(right.userGlosses?.[key]);
    userGlosses[key] = pickLatest(a, b);
  }

  return {
    ...right,
    ...left,
    sessions: [...sessions.values()],
    cards: [...cards.values()],
    reviewStates,
    reviewEvents,
    userGlosses,
  };
}
