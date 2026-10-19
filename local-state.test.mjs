import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState, importStateBackup, loadLocalState, saveLocalState } from './local-state.mjs';

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };
}

test('fresh browser storage starts empty rather than publishing a sample quiz result', () => {
  const state = loadLocalState(memoryStorage());
  assert.deepEqual(state.sessions, []);
  assert.deepEqual(state.cards, []);
  assert.deepEqual(state.ankiGradeEvents, []);
});

test('quiz progress round-trips through browser local storage', () => {
  const storage = memoryStorage();
  const state = createEmptyState();
  state.sessions.push({ id: 'quiz-1', date: '2020-01-03', correct: 5, total: 10, items: [] });
  state.ankiGradeEvents.push({ id: 'quiz-1::card-1', status: 'pending' });
  assert.equal(saveLocalState(state, storage), true);
  assert.deepEqual(loadLocalState(storage), state);
});

test('backup import rejects malformed data and merges valid browser backups', () => {
  const existing = createEmptyState();
  existing.sessions.push({ id: 'old', date: '2020-01-02', correct: 1, total: 2 });
  assert.throws(() => importStateBackup('{broken', existing), /valid JSON/i);
  const imported = createEmptyState();
  imported.sessions.push({ id: 'new', date: '2020-01-03', correct: 2, total: 3 });
  const merged = importStateBackup(JSON.stringify(imported), existing);
  assert.deepEqual(merged.sessions.map(({ id }) => id).sort(), ['new', 'old']);
});
