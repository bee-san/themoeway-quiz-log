import test from 'node:test';
import assert from 'node:assert/strict';
import { applyImportedOutcomes, getDueReviewCards, matchesReading, normalizeDictionaryTerms, parseKotobaReport, scheduleFsrsReview, hasWrittenMeaning, searchDictionaryTerms } from './app.mjs';
import { mergeSharedStates, parseItemOutcomes, stableQuizSessionId } from './shared.mjs';
import { buildQuizAnalytics } from './analytics.mjs';
import { FREQUENCY_TIERS, getDailyReviewCapacity, limitDailyReviewQueue, normalizeFrequencyTier } from './study.mjs';

const report = `Final Scores
@《Practice》 SampleLearner has 7 points
Unanswered Questions (3)
猫 (ねこ)
走る (はしる)
青い (あおい)
Game Report`;

test('parses the Kotoba score and all unanswered vocabulary', () => {
  const result = parseKotobaReport(report, '2020-01-02');
  assert.equal(result.correct, 7);
  assert.equal(result.total, 10);
  assert.equal(result.date, '2020-01-02');
  assert.deepEqual(result.wrong.map(({ kanji, reading }) => [kanji, reading]), [
    ['猫', 'ねこ'], ['走る', 'はしる'], ['青い', 'あおい'],
  ]);
});

test('rejects text that is not a Kotoba game report', () => {
  assert.throws(() => parseKotobaReport('hello'), /Kotoba game result/i);
});

test('accepts any non-empty typed meaning for self-review', () => {
  assert.equal(hasWrittenMeaning('to be, exist, stay'), true);
  assert.equal(hasWrittenMeaning('anything I remember'), true);
  assert.equal(hasWrittenMeaning('   '), false);
});

test('normalizes dictionary entries into stable expression-reading cards', () => {
  const cards = normalizeDictionaryTerms([
    { term: 'いる', reading: 'いる', frequency: 123, rank: 'Student' },
    { term: '猫', reading: 'ねこ', frequency: 450, rank: 'Beginner' },
    { term: 'いる', reading: 'いる', frequency: 123, rank: 'Student' },
    { term: '', reading: '', frequency: 99999, rank: '' },
  ]);
  assert.equal(cards.length, 2);
  assert.equal(cards[0].id, 'いる::いる');
  assert.equal(cards[1].id, '猫::ねこ');
  const sourced = normalizeDictionaryTerms([['由比ヶ浜', 'ゆいがはま', 123, 0, 'term_bank_1:7']]);
  assert.equal(sourced[0].id, 'term_bank_1:7');
  assert.equal(cards.find((card) => card.term === 'いる').reading, 'いる');
  assert.equal(cards.some((card) => Object.hasOwn(card, 'meaning')), false);
});

test('collapses combined source frequency labels into the nine single tiers', () => {
  const sourceLabels = [
    'Student, Immortal, Mythic', 'Trainee, Mythic', 'Debut, Immortal', 'Major, Immortal, Mythic',
    'Prima, Mythic', 'Divine, Immortal', 'Eternal, Immortal, Mythic', 'Immortal, Mythic', 'Mythic',
  ];
  const expected = ['Student', 'Trainee', 'Debut', 'Major', 'Prima', 'Divine', 'Eternal', 'Immortal', 'Mythic'];
  const terms = normalizeDictionaryTerms(sourceLabels.map((rank, index) => [`term${index}`, `reading${index}`, index, rank, `id${index}`]));
  assert.deepEqual(terms.map((term) => term.rank), expected);
  assert.deepEqual(FREQUENCY_TIERS, expected);
  assert.equal(normalizeFrequencyTier(' trainee, Mythic '), 'Trainee');
  assert.equal(normalizeFrequencyTier('Unknown, Mythic'), '');
});

test('forecasts the next quiz from at least three dated score records', () => {
  const sessions = [
    { date: '2026-01-03', correct: 6, total: 10 },
    { date: '2026-01-02', correct: 4, total: 10 },
    { date: '2026-01-01', correct: 2, total: 10 },
  ];
  const analytics = buildQuizAnalytics(sessions);
  assert.equal(analytics.quizCount, 3);
  assert.equal(analytics.forecast.accuracy, 80);
  assert.equal(analytics.forecast.expectedCorrect, 8);
  assert.equal(analytics.forecast.total, 10);
  assert.equal(buildQuizAnalytics(sessions.slice(0, 2)).forecast, null);
});

test('limits FSRS queue to ten reviews per local day without counting quiz grades', () => {
  const now = new Date(2026, 9, 18, 12, 0, 0);
  const due = Array.from({ length: 15 }, (_, index) => ({ id: `due-${index}` }));
  const events = [
    ...Array.from({ length: 3 }, (_, index) => ({ id: `review-${index}`, source: 'review-queue', reviewedAt: now.toISOString() })),
    { id: 'quiz-grade', source: 'kotoba-import', reviewedAt: now.toISOString() },
  ];
  assert.deepEqual(getDailyReviewCapacity(events, now, 10), { completed: 3, remaining: 7, limit: 10 });
  assert.equal(limitDailyReviewQueue(due, events, now, 10).length, 7);
});

test('matches both kana and romanized readings', () => {
  assert.equal(matchesReading('いる', ['いる']), true);
  assert.equal(matchesReading('iru', ['いる']), true);
  assert.equal(matchesReading('neko', ['ねこ']), true);
  assert.equal(matchesReading('hon', ['ほん']), true);
  assert.equal(matchesReading('onna', ['おんな']), true);
  assert.equal(matchesReading('irune', ['いる']), false);
});

test('FSRS review states use the requested rating and persist dates', () => {
  const now = new Date('2020-01-02T17:00:00.000Z');
  const again = scheduleFsrsReview(null, 'Again', now);
  assert.equal(again.last_review, now.toISOString());
  assert.ok(Date.parse(again.due) > now.getTime());
  const good = scheduleFsrsReview(again, 'Good', new Date(now.getTime() + 60_000));
  assert.equal(good.reps, 2);
  assert.ok(Date.parse(good.due) > Date.parse(good.last_review));
});

test('imported wrong terms schedule FSRS Again once; score-only results add no item reviews', () => {
  const state = { cards: [], reviewStates: {}, reviewEvents: [] };
  const result = {
    id: 'run-1', date: '2020-01-02', correct: 1, total: 2,
    wrong: [{ kanji: '猫', reading: 'ねこ' }],
  };
  applyImportedOutcomes(state, result, new Date('2020-01-02T17:00:00.000Z'));
  const card = state.cards.find((item) => item.kanji === '猫');
  assert.ok(card);
  assert.equal(state.reviewStates[`${card.id}::reading`].reps, 1);
  assert.equal(state.reviewEvents.length, 1);
  applyImportedOutcomes(state, result, new Date('2020-01-02T17:00:00.000Z'));
  assert.equal(state.reviewStates[`${card.id}::reading`].reps, 1);
  assert.equal(state.reviewEvents.length, 1);

  const meaningState = scheduleFsrsReview(state.reviewStates[`${card.id}::meaning`], 'Good', new Date('2020-01-02T18:00:00.000Z'));
  state.reviewStates[`${card.id}::meaning`] = meaningState;
  assert.equal(state.reviewStates[`${card.id}::reading`].reps, 1);
  assert.equal(state.reviewStates[`${card.id}::meaning`].reps, 1);

  applyImportedOutcomes(state, { id: 'run-2', date: '2020-01-02', correct: 5, total: 5 }, new Date('2020-01-02T18:00:00.000Z'));
  assert.equal(state.reviewEvents.length, 1);
});

test('correct imported item outcomes schedule Good in the reading lane', () => {
  const state = { cards: [], reviewStates: {}, reviewEvents: [] };
  applyImportedOutcomes(state, {
    id: 'run-outcomes', date: '2020-01-02', correct: 1, total: 2,
    wrong: [{ kanji: '猫', reading: 'ねこ' }],
    outcomes: [{ kanji: 'いる', reading: 'いる', rating: 'Good' }],
  }, new Date('2020-01-02T17:00:00.000Z'));
  const wrongCard = state.cards.find((card) => card.kanji === '猫');
  const rightCard = state.cards.find((card) => card.kanji === 'いる');
  assert.equal(state.reviewStates[`${wrongCard.id}::reading`].reps, 1);
  assert.equal(state.reviewStates[`${rightCard.id}::reading`].reps, 1);
  assert.equal(wrongCard.mastered, false);
  assert.equal(rightCard.mastered, true);
  assert.deepEqual(state.reviewEvents.map((event) => event.rating).sort(), ['Again', 'Good']);
});

test('due-review queue includes only expired FSRS cards from dictionary and imported terms', () => {
  const now = new Date('2020-01-02T17:00:00.000Z');
  const terms = [
    { id: 'due::だい', term: '題', reading: 'だい' },
    { id: 'later::あと', term: '後', reading: 'あと' },
  ];
  const state = {
    cards: [{ id: 'custom-word', kanji: '猫', reading: 'ねこ', meaning: 'special' }],
    reviewStates: {
      'due::だい::reading': { due: '2020-01-02T16:00:00.000Z' },
      'later::あと::reading': { due: '2020-01-02T18:00:00.000Z' },
      'custom-word::meaning': { due: '2020-01-02T16:30:00.000Z' },
    },
  };
  const due = getDueReviewCards(terms, state, now);
  assert.deepEqual(due.map((item) => [item.id, item.reviewMode]), [['due::だい', 'reading'], ['custom-word', 'meaning']]);
});

test('parses explicit per-word outcomes without guessing aggregate-only answers', () => {
  assert.deepEqual(parseItemOutcomes('猫 (ねこ) = Again\nいる (いる) = Good'), [
    { kanji: '猫', reading: 'ねこ', rating: 'Again' },
    { kanji: 'いる', reading: 'いる', rating: 'Good' },
  ]);
  assert.deepEqual(parseItemOutcomes('猫 (ねこ) = wrong\nいる (いる) = right'), [
    { kanji: '猫', reading: 'ねこ', rating: 'Again' },
    { kanji: 'いる', reading: 'いる', rating: 'Good' },
  ]);
  assert.throws(() => parseItemOutcomes('猫 = Good'), /expression \(reading\)/i);
  assert.throws(() => parseItemOutcomes('猫 (ねこ) = Good\n猫 (ねこ) = Again'), /duplicate/i);
});

test('searches by expression or kana/romaji reading with rank filtering and bounded results', () => {
  const terms = [
    { id: '1:1', term: '入る', reading: 'はいる', rank: 'Beginner' },
    { id: '1:2', term: 'いる', reading: 'いる', rank: 'Student' },
    { id: '1:3', term: '要る', reading: 'いる', rank: 'Student' },
    { id: '1:4', term: 'いる', reading: 'いる', rank: 'Beginner' },
  ];
  assert.deepEqual(searchDictionaryTerms(terms, 'iru', 'Student', 1).map((term) => term.id), ['1:2']);
  assert.deepEqual(searchDictionaryTerms(terms, '要る').map((term) => term.id), ['1:3']);
});

test('creates a stable import id from normalized quiz outcomes', () => {
  const result = { date: '2020-01-02', correct: 3, total: 8, wrong: [{ kanji: '青空', reading: 'あおぞら' }] };
  assert.equal(stableQuizSessionId(result), stableQuizSessionId({ ...result, wrong: [...result.wrong].reverse() }));
  assert.notEqual(stableQuizSessionId(result), stableQuizSessionId({ ...result, date: '2020-01-03' }));
});

test('merges concurrent FSRS events, sessions, cards, and latest gloss across devices', () => {
  const left = {
    sessions: [{ id: 'run-a', date: '2020-01-02', correct: 3, total: 8, missed: ['猫'] }],
    cards: [{ id: 'card-a', kanji: '猫', reading: 'ねこ' }],
    reviewStates: {},
    reviewEvents: [{ id: 'event-a', cardId: 'card-a', reviewMode: 'reading', rating: 'Again', reviewedAt: '2020-01-02T17:00:00.000Z' }],
    userGlosses: { 'card-a': { text: 'old gloss', updatedAt: '2020-01-02T17:00:00.000Z' } },
  };
  const right = {
    sessions: [{ id: 'run-b', date: '2020-01-02', correct: 6, total: 10, missed: [] }],
    cards: [{ id: 'card-b', kanji: 'いる', reading: 'いる' }],
    reviewStates: {},
    reviewEvents: [
      { id: 'event-a', cardId: 'card-a', reviewMode: 'reading', rating: 'Again', reviewedAt: '2020-01-02T17:00:00.000Z' },
      { id: 'event-b', cardId: 'card-a', reviewMode: 'reading', rating: 'Good', reviewedAt: '2020-01-02T17:05:00.000Z' },
      { id: 'event-c', cardId: 'card-a', reviewMode: 'meaning', rating: 'Hard', reviewedAt: '2020-01-02T17:06:00.000Z' },
    ],
    userGlosses: { 'card-a': { text: 'new gloss', updatedAt: '2020-01-02T17:10:00.000Z' } },
  };
  const merged = mergeSharedStates(left, right);
  assert.deepEqual(merged.sessions.map((item) => item.id).sort(), ['run-a', 'run-b']);
  assert.deepEqual(merged.cards.map((item) => item.id).sort(), ['card-a', 'card-b']);
  assert.equal(merged.reviewEvents.length, 3);
  assert.equal(merged.reviewStates['card-a::reading'].reps, 2);
  assert.equal(merged.reviewStates['card-a::meaning'].reps, 1);
  assert.equal(merged.userGlosses['card-a'].text, 'new gloss');
});
