import { createEmptyCard, fsrs, Rating } from 'ts-fsrs';

const scheduler = fsrs({ enable_fuzz: false });
const ratingByName = {
  Again: Rating.Again,
  Hard: Rating.Hard,
  Good: Rating.Good,
  Easy: Rating.Easy,
};

export const FREQUENCY_TIERS = Object.freeze([
  'Student', 'Trainee', 'Debut', 'Major', 'Prima', 'Divine', 'Eternal', 'Immortal', 'Mythic',
]);

export function normalizeFrequencyTier(value) {
  const sourceLabel = String(value ?? '').split(',')[0].trim().toLowerCase();
  return FREQUENCY_TIERS.find((tier) => tier.toLowerCase() === sourceLabel) || '';
}

export function normalizeDictionaryTerms(rows) {
  const unique = new Map();
  for (const row of rows || []) {
    const term = String(Array.isArray(row) ? row[0] : row?.term ?? row?.expression ?? '').trim();
    const reading = String(Array.isArray(row) ? row[1] : row?.reading ?? '').trim();
    if (!term || !reading) continue;
    const id = String(Array.isArray(row) ? row[4] ?? '' : row?.id ?? row?.sourceId ?? '') || `${term}::${reading}`;
    const rawFrequency = Array.isArray(row) ? row[2] : row?.frequency;
    const frequency = Number.isFinite(Number(rawFrequency)) ? Number(rawFrequency) : null;
    const rank = normalizeFrequencyTier(Array.isArray(row) ? row[3] ?? '' : row?.rank ?? '');
    if (!unique.has(id)) unique.set(id, { id, term, reading, frequency, rank });
  }
  return [...unique.values()];
}

const ROMAJI = {
  kya: 'きゃ', kyu: 'きゅ', kyo: 'きょ', sha: 'しゃ', shu: 'しゅ', sho: 'しょ',
  cha: 'ちゃ', chu: 'ちゅ', cho: 'ちょ', nya: 'にゃ', nyu: 'にゅ', nyo: 'にょ',
  hya: 'ひゃ', hyu: 'ひゅ', hyo: 'ひょ', mya: 'みゃ', myu: 'みゅ', myo: 'みょ',
  rya: 'りゃ', ryu: 'りゅ', ryo: 'りょ', gya: 'ぎゃ', gyu: 'ぎゅ', gyo: 'ぎょ',
  ja: 'じゃ', ju: 'じゅ', jo: 'じょ', bya: 'びゃ', byu: 'びゅ', byo: 'びょ',
  pya: 'ぴゃ', pyu: 'ぴゅ', pyo: 'ぴょ',
  shi: 'し', chi: 'ち', tsu: 'つ', fu: 'ふ', ji: 'じ', ye: 'いぇ', wi: 'うぃ', we: 'うぇ',
  ka: 'か', ki: 'き', ku: 'く', ke: 'け', ko: 'こ', sa: 'さ', si: 'し', su: 'す', se: 'せ', so: 'そ',
  ta: 'た', ti: 'ち', tu: 'つ', te: 'て', to: 'と', na: 'な', ni: 'に', nu: 'ぬ', ne: 'ね', no: 'の',
  ha: 'は', hi: 'ひ', hu: 'ふ', he: 'へ', ho: 'ほ', ma: 'ま', mi: 'み', mu: 'む', me: 'め', mo: 'も',
  ya: 'や', yi: 'い', yu: 'ゆ', ye2: 'いぇ', yo: 'よ', ra: 'ら', ri: 'り', ru: 'る', re: 'れ', ro: 'ろ',
  wa: 'わ', wo: 'を', ga: 'が', gi: 'ぎ', gu: 'ぐ', ge: 'げ', go: 'ご', za: 'ざ', zi: 'じ', zu: 'ず', ze: 'ぜ', zo: 'ぞ',
  da: 'だ', di: 'ぢ', du: 'づ', de: 'で', do: 'ど', ba: 'ば', bi: 'び', bu: 'ぶ', be: 'べ', bo: 'ぼ',
  pa: 'ぱ', pi: 'ぴ', pu: 'ぷ', pe: 'ぺ', po: 'ぽ', a: 'あ', i: 'い', u: 'う', e: 'え', o: 'お',
};

function toHiragana(value) {
  const input = String(value ?? '').normalize('NFKC').toLowerCase().replace(/[\s・,，、]/g, '');
  let output = '';
  for (let index = 0; index < input.length;) {
    const char = input[index];
    if (char === '-') {
      output += 'ー';
      index += 1;
      continue;
    }
    if (char === 'n' && input[index + 1] === "'") {
      output += 'ん';
      index += 2;
      continue;
    }
    if (char === 'n' && (index + 1 === input.length || !'aiueoy'.includes(input[index + 1]))) {
      output += 'ん';
      index += 1;
      continue;
    }
    if (index + 1 < input.length && char === input[index + 1] && /[bcdfghjklmpqrstvwxyz]/.test(char) && char !== 'n') {
      output += 'っ';
      index += 1;
      continue;
    }
    let matched = false;
    for (const size of [3, 2, 1]) {
      const syllable = input.slice(index, index + size);
      if (ROMAJI[syllable]) {
        output += ROMAJI[syllable];
        index += size;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    const code = input.charCodeAt(index);
    output += code >= 0x30a1 && code <= 0x30f6 ? String.fromCharCode(code - 0x60) : char;
    index += 1;
  }
  return output;
}

export function searchDictionaryTerms(terms, query, rank = '', limit = 20) {
  const raw = String(query ?? '').trim().toLowerCase();
  if (!raw) return [];
  const kana = toHiragana(raw);
  const boundedLimit = Math.max(1, Math.min(50, Number(limit) || 20));
  const results = [];
  for (const term of terms || []) {
    if (rank && term.rank !== rank) continue;
    const expression = String(term.term ?? '').toLowerCase();
    const reading = String(term.reading ?? '').toLowerCase();
    if (expression.includes(raw) || reading.includes(raw) || toHiragana(reading).includes(kana)) {
      results.push(term);
      if (results.length >= boundedLimit) break;
    }
  }
  return results;
}

export function matchesReading(answer, acceptedReadings) {
  const normalized = toHiragana(answer);
  if (!normalized) return false;
  const values = Array.isArray(acceptedReadings) ? acceptedReadings : String(acceptedReadings ?? '').split(/[、,，]/);
  return values.some((reading) => toHiragana(reading) === normalized);
}

function restoreCard(previous, now) {
  if (!previous) return createEmptyCard(now);
  return {
    ...previous,
    due: previous.due instanceof Date ? previous.due : new Date(previous.due),
    last_review: previous.last_review == null
      ? null
      : previous.last_review instanceof Date ? previous.last_review : new Date(previous.last_review),
  };
}

export function fsrsReviewKey(cardId, mode) {
  if (mode !== 'reading' && mode !== 'meaning') throw new Error(`Unknown review mode: ${mode}`);
  return `${cardId}::${mode}`;
}

export function scheduleFsrsReview(previous, rating, reviewedAt = new Date()) {
  const now = reviewedAt instanceof Date ? reviewedAt : new Date(reviewedAt);
  const selectedRating = typeof rating === 'number' ? rating : ratingByName[rating];
  if (![Rating.Again, Rating.Hard, Rating.Good, Rating.Easy].includes(selectedRating)) {
    throw new Error(`Unknown FSRS rating: ${rating}`);
  }
  const { card } = scheduler.next(restoreCard(previous, now), now, selectedRating);
  return {
    ...card,
    due: card.due.toISOString(),
    last_review: card.last_review ? card.last_review.toISOString() : null,
  };
}

export function resolveItemOutcomes(result) {
  const outcomes = new Map();
  const add = (item, rating) => {
    const kanji = String(item?.kanji ?? item?.term ?? '').trim();
    const reading = String(item?.reading ?? '').trim();
    if (!kanji || !reading) return;
    const selected = rating ?? item?.rating ?? 'Again';
    if (!['Again', 'Hard', 'Good', 'Easy'].includes(selected)) return;
    outcomes.set(`${kanji}\u0000${reading}`, { kanji, reading, rating: selected });
  };
  for (const item of Array.isArray(result?.wrong) ? result.wrong : []) add(item, 'Again');
  for (const item of Array.isArray(result?.outcomes) ? result.outcomes : []) add(item, item.rating || 'Good');
  return [...outcomes.values()];
}

export function applyImportedOutcomes(state, result, reviewedAt = new Date()) {
  state.cards ??= [];
  state.reviewStates ??= {};
  state.reviewEvents ??= [];
  const outcomes = resolveItemOutcomes(result);
  const sessionId = String(result?.id ?? `${result?.date ?? 'unknown'}:${result?.correct ?? 0}/${result?.total ?? 0}`);
  const existingEvents = new Set(state.reviewEvents.map((event) => event.id));
  for (const item of outcomes) {
    const { kanji, reading, rating } = item;
    if (!kanji || !reading) continue;
    let card = state.cards.find((candidate) => candidate.kanji === kanji && candidate.reading === reading);
    if (!card) card = state.cards.find((candidate) => candidate.kanji === kanji);
    if (!card) {
      card = {
        id: `imported::${encodeURIComponent(kanji)}::${encodeURIComponent(reading)}`,
        kanji,
        term: kanji,
        reading,
        meaning: '',
        yourAnswer: '',
        mastered: rating !== 'Again',
      };
      state.cards.push(card);
    } else {
      card.reading = reading;
      card.mastered = rating !== 'Again';
    }
    const eventId = `kotoba:${sessionId}:${card.id}`;
    if (existingEvents.has(eventId)) continue;
    const reviewKey = fsrsReviewKey(card.id, 'reading');
    state.reviewStates[reviewKey] = scheduleFsrsReview(state.reviewStates[reviewKey], rating, reviewedAt);
    state.reviewEvents.push({
      id: eventId,
      cardId: card.id,
      reviewMode: 'reading',
      rating,
      source: 'kotoba-import',
      sessionId,
      reviewedAt: (reviewedAt instanceof Date ? reviewedAt : new Date(reviewedAt)).toISOString(),
    });
    existingEvents.add(eventId);
  }
  return state;
}

export function getDueReviewCards(dictionaryTerms, state, now = new Date()) {
  const termsById = new Map((dictionaryTerms || []).map((term) => [term.id, term]));
  for (const card of state?.cards || []) {
    if (!termsById.has(card.id)) {
      termsById.set(card.id, {
        id: card.id,
        term: card.term || card.kanji,
        reading: card.reading,
        meaning: card.meaning || '',
        custom: true,
      });
    }
  }
  const timestamp = (now instanceof Date ? now : new Date(now)).getTime();
  const due = [];
  for (const [key, review] of Object.entries(state?.reviewStates || {})) {
    let cardId = key;
    let reviewMode = 'meaning';
    if (key.endsWith('::reading')) {
      cardId = key.slice(0, -'::reading'.length);
      reviewMode = 'reading';
    } else if (key.endsWith('::meaning')) {
      cardId = key.slice(0, -'::meaning'.length);
      reviewMode = 'meaning';
    }
    const term = termsById.get(cardId);
    if (term && Date.parse(review.due) <= timestamp) {
      due.push({ ...term, review, reviewMode });
    }
  }
  return due.sort((a, b) => Date.parse(a.review.due) - Date.parse(b.review.due));
}

function localDayKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function getDailyReviewCapacity(reviewEvents, now = new Date(), limit = 10) {
  const normalizedLimit = Math.max(0, Math.floor(Number(limit) || 0));
  const today = localDayKey(now);
  const completed = (Array.isArray(reviewEvents) ? reviewEvents : []).filter((event) =>
    event?.source === 'review-queue' && localDayKey(event.reviewedAt) === today).length;
  return { completed, remaining: Math.max(0, normalizedLimit - completed), limit: normalizedLimit };
}

export function limitDailyReviewQueue(dueCards, reviewEvents, now = new Date(), limit = 10) {
  const capacity = getDailyReviewCapacity(reviewEvents, now, limit);
  return (Array.isArray(dueCards) ? dueCards : []).slice(0, capacity.remaining);
}
