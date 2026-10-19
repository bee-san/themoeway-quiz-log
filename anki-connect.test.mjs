import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDeckQuery,
  connectToAnki,
  gradeOutcomesWithAnki,
  mapOutcomesToCards,
  normalizeAnkiEndpoint,
} from './anki-connect.mjs';

const note = (noteId, cardId, expression, reading) => ({
  noteId,
  cards: [cardId],
  fields: {
    Expression: { value: expression },
    Reading: { value: reading },
  },
});

test('AnkiConnect endpoint is loopback-only and accepts a configurable local port', () => {
  assert.equal(normalizeAnkiEndpoint('http://127.0.0.1:8766/'), 'http://127.0.0.1:8766');
  assert.equal(normalizeAnkiEndpoint('http://localhost:8765'), 'http://localhost:8765');
  assert.throws(() => normalizeAnkiEndpoint('http://anki.example:8765'), /this device/i);
  assert.throws(() => normalizeAnkiEndpoint('https://127.0.0.1:8766'), /http/i);
});

test('Anki search query safely quotes the selected deck name', () => {
  assert.equal(buildDeckQuery('TheMoeWay::Frequency::Trainee'), 'deck:"TheMoeWay::Frequency::Trainee"');
  assert.throws(() => buildDeckQuery('  '), /deck/i);
});

test('maps only exact expression and reading matches with one card', () => {
  const outcomes = [
    { kanji: '猫', reading: 'ねこ', rating: 'Again' },
    { kanji: '青空', reading: 'あおぞら', rating: 'Good' },
  ];
  const mapped = mapOutcomesToCards(outcomes, [
    note(1, 101, '猫', 'ねこ · Trainee · frequency 18 · ID 1:42'),
    note(2, 102, '猫', 'いぬ'),
  ]);
  assert.deepEqual(mapped.map(({ status, cardId }) => [status, cardId]), [
    ['matched', 101], ['unmatched', null],
  ]);
});

test('does not grade duplicate or multi-card note matches', () => {
  const duplicate = note(1, 101, '猫', 'ねこ');
  const other = note(2, 102, '猫', 'ねこ');
  const multiCard = { ...note(3, 103, '走る', 'はしる'), cards: [103, 104] };
  const mapped = mapOutcomesToCards([
    { kanji: '猫', reading: 'ねこ', rating: 'Again' },
    { kanji: '走る', reading: 'はしる', rating: 'Good' },
  ], [duplicate, other, multiCard]);
  assert.deepEqual(mapped.map(({ status }) => status), ['ambiguous', 'ambiguous']);
});

test('connect requests permission before reading deck names', async () => {
  const actions = [];
  const fetchImpl = async (_url, request) => {
    const body = JSON.parse(request.body);
    actions.push(body.action);
    const results = {
      requestPermission: { permission: 'granted', version: 6, requireApiKey: false },
      deckNames: ['TheMoeWay::Frequency::Trainee'],
    };
    return new Response(JSON.stringify({ result: results[body.action], error: null }), { status: 200 });
  };
  const result = await connectToAnki('http://127.0.0.1:8766', { fetchImpl });
  assert.deepEqual(actions, ['requestPermission', 'deckNames']);
  assert.deepEqual(result, { version: 6, decks: ['TheMoeWay::Frequency::Trainee'] });
});

test('grades a matching outcome only after Anki review history confirms the rating', async () => {
  const actions = [];
  const reviews = { '101': [] };
  let reviewId = 2_000;
  const fetchImpl = async (_url, request) => {
    const body = JSON.parse(request.body);
    actions.push(body.action);
    let result;
    if (body.action === 'findNotes') result = [1];
    else if (body.action === 'notesInfo') result = [note(1, 101, '猫', 'ねこ')];
    else if (body.action === 'getReviewsOfCards') result = { '101': reviews['101'] };
    else if (body.action === 'gradeNow') {
      assert.deepEqual(body.params, { cards: [101], ease: 1 });
      reviews['101'].push({ id: ++reviewId, ease: 1 });
      result = true;
    } else throw new Error(`Unexpected action ${body.action}`);
    return new Response(JSON.stringify({ result, error: null }), { status: 200 });
  };
  const result = await gradeOutcomesWithAnki({
    endpoint: 'http://127.0.0.1:8766',
    deckName: 'TheMoeWay::Frequency::Trainee',
    outcomes: [
      { kanji: '猫', reading: 'ねこ', rating: 'Again' },
      { kanji: '青空', reading: 'あおぞら', rating: 'Good' },
    ],
    fetchImpl,
  });
  assert.deepEqual(result.outcomes.map(({ status }) => status), ['applied', 'unmatched']);
  assert.deepEqual(actions, ['findNotes', 'notesInfo', 'getReviewsOfCards', 'gradeNow', 'getReviewsOfCards']);
});

test('does not report success when Anki review history cannot verify the new grade', async () => {
  const fetchImpl = async (_url, request) => {
    const body = JSON.parse(request.body);
    const results = {
      findNotes: [1],
      notesInfo: [note(1, 101, '猫', 'ねこ')],
      getReviewsOfCards: { '101': [] },
      gradeNow: true,
    };
    return new Response(JSON.stringify({ result: results[body.action], error: null }), { status: 200 });
  };
  const result = await gradeOutcomesWithAnki({
    endpoint: 'http://127.0.0.1:8766',
    deckName: 'Trainee',
    outcomes: [{ kanji: '猫', reading: 'ねこ', rating: 'Good' }],
    fetchImpl,
  });
  assert.equal(result.outcomes[0].status, 'unknown');
});
