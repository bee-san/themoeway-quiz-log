import { fsrsReviewKey, applyImportedOutcomes } from './study.mjs';
import { mergeSharedStates } from './shared.mjs';

export const STORAGE_KEY = 'kotoba-replay-v1';

export function createEmptyState() {
  return { sessions: [], cards: [], reviewStates: {}, reviewEvents: [], userGlosses: {}, ankiGradeEvents: [] };
}

export function migrateLocalState(saved) {
  const userGlosses = {};
  for (const [key, gloss] of Object.entries(saved.userGlosses && typeof saved.userGlosses === 'object' ? saved.userGlosses : {})) {
    userGlosses[key] = typeof gloss === 'string'
      ? { text: gloss, updatedAt: '1970-01-01T00:00:00.000Z' }
      : { text: String(gloss?.text ?? ''), updatedAt: String(gloss?.updatedAt ?? '1970-01-01T00:00:00.000Z') };
  }
  const value = {
    ...createEmptyState(), ...saved,
    sessions: Array.isArray(saved.sessions) ? saved.sessions : [],
    cards: Array.isArray(saved.cards) ? saved.cards : [],
    reviewStates: saved.reviewStates && typeof saved.reviewStates === 'object' ? saved.reviewStates : {},
    reviewEvents: Array.isArray(saved.reviewEvents) ? saved.reviewEvents : [],
    userGlosses,
    ankiGradeEvents: Array.isArray(saved.ankiGradeEvents) ? saved.ankiGradeEvents : [],
  };
  for (const [key, review] of Object.entries(value.reviewStates)) {
    if (!key.endsWith('::reading') && !key.endsWith('::meaning') && review?.due) {
      delete value.reviewStates[key];
      const lastEvent = value.reviewEvents.filter((event) => event.cardId === key)
        .sort((a, b) => String(a.reviewedAt).localeCompare(String(b.reviewedAt))).at(-1);
      const mode = lastEvent?.reviewMode || (lastEvent?.source === 'kotoba-import' ? 'reading' : 'meaning');
      value.reviewStates[fsrsReviewKey(key, mode)] = review;
    }
  }
  if (!saved.reviewStates) {
    for (const session of value.sessions) {
      const missed = new Set(session.missed || []);
      const wrong = value.cards.filter((card) => missed.has(card.kanji) && !card.mastered)
        .map(({ kanji, reading }) => ({ kanji, reading }));
      applyImportedOutcomes(value, { ...session, id: `legacy-${session.id}`, wrong }, new Date());
    }
  }
  return value;
}

export function loadLocalState(storage = globalThis.localStorage) {
  try {
    const saved = storage?.getItem(STORAGE_KEY);
    if (!saved) return createEmptyState();
    const value = JSON.parse(saved);
    if (!value || typeof value !== 'object' || !Array.isArray(value.sessions) || !Array.isArray(value.cards)) return createEmptyState();
    return migrateLocalState(value);
  } catch {
    return createEmptyState();
  }
}

export function saveLocalState(state, storage = globalThis.localStorage) {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function importStateBackup(text, currentState = createEmptyState()) {
  let parsed;
  try {
    parsed = JSON.parse(String(text ?? ''));
  } catch {
    throw new Error('Backup is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.sessions) || !Array.isArray(parsed.cards)) {
    throw new Error('Backup does not contain TheMoeWay quiz data.');
  }
  const imported = migrateLocalState(parsed);
  const merged = migrateLocalState(mergeSharedStates(currentState, imported));
  const ankiEvents = new Map();
  for (const event of [...(imported.ankiGradeEvents || []), ...(currentState.ankiGradeEvents || [])]) {
    if (!event?.id) continue;
    const previous = ankiEvents.get(String(event.id));
    if (!previous || event.status === 'applied' || event.status === 'unknown') ankiEvents.set(String(event.id), event);
  }
  merged.ankiGradeEvents = [...ankiEvents.values()];
  return merged;
}
