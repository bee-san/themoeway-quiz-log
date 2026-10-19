import { applyImportedOutcomes, FREQUENCY_TIERS, fsrsReviewKey, getDailyReviewCapacity, getDueReviewCards, limitDailyReviewQueue, matchesReading, normalizeDictionaryTerms, resolveItemOutcomes, scheduleFsrsReview, searchDictionaryTerms } from './study.mjs';
import { connectToAnki, DEFAULT_ANKI_ENDPOINT, gradeOutcomesWithAnki } from './anki-connect.mjs';
import { createEmptyState, importStateBackup, loadLocalState, saveLocalState } from './local-state.mjs';
import { buildQuizAnalytics } from './analytics.mjs';
import { parseItemOutcomes, stableQuizSessionId } from './shared.mjs';
export { applyImportedOutcomes, FREQUENCY_TIERS, fsrsReviewKey, getDailyReviewCapacity, getDueReviewCards, limitDailyReviewQueue, matchesReading, normalizeDictionaryTerms, resolveItemOutcomes, scheduleFsrsReview, searchDictionaryTerms } from './study.mjs';
export { buildQuizAnalytics } from './analytics.mjs';
export { mergeSharedStates, parseItemOutcomes, stableQuizSessionId } from './shared.mjs';
export { buildDeckQuery, connectToAnki, DEFAULT_ANKI_ENDPOINT, gradeOutcomesWithAnki, invokeAnki, mapOutcomesToCards, normalizeAnkiEndpoint } from './anki-connect.mjs';

export function parseKotobaReport(text, date = new Date().toISOString().slice(0, 10)) {
  const source = String(text ?? '');
  const scoreMatch = source.match(/has\s+(\d+)\s+points?/i);
  const missedMatch = source.match(/Unanswered Questions\s*\((\d+)\)/i);
  if (!scoreMatch || !missedMatch) {
    throw new Error('Could not find a Kotoba game result (score and unanswered-question summary).');
  }

  const sectionStart = source.indexOf(missedMatch[0]) + missedMatch[0].length;
  const rest = source.slice(sectionStart);
  const sectionEnd = rest.search(/\n\s*(?:Game Report|Quiz Command Builder|Say k!lb)\b/i);
  const unansweredText = sectionEnd >= 0 ? rest.slice(0, sectionEnd) : rest;
  const wrong = [];
  for (const line of unansweredText.split(/\r?\n/)) {
    const match = line.trim().match(/^(?:[-•]\s*)?([^\s(]+)\s+\(([^)]+)\)\s*$/u);
    if (match) wrong.push({ kanji: match[1], reading: match[2].trim() });
  }

  const unanswered = Number(missedMatch[1]);
  if (wrong.length !== unanswered) {
    throw new Error(`Found ${wrong.length} unanswered words, but the report says ${unanswered}.`);
  }
  return {
    date,
    correct: Number(scoreMatch[1]),
    total: Number(scoreMatch[1]) + unanswered,
    wrong,
  };
}

export function hasWrittenMeaning(value) {
  return String(value ?? '').trim().length > 0;
}

export function accuracy(correct, total) {
  return total > 0 ? Math.round((correct / total) * 1000) / 10 : 0;
}

const STORAGE_KEY = 'kotoba-replay-v1';
const DATASET_SIZE = 243795;
const DICTIONARY_URL = './data/tmw-terms.json.gz';

function cloneSeed() {
  return createEmptyState();
}

function migrateState(saved) {
  const userGlosses = {};
  for (const [key, gloss] of Object.entries(saved.userGlosses && typeof saved.userGlosses === 'object' ? saved.userGlosses : {})) {
    userGlosses[key] = typeof gloss === 'string'
      ? { text: gloss, updatedAt: '1970-01-01T00:00:00.000Z' }
      : { text: String(gloss?.text ?? ''), updatedAt: String(gloss?.updatedAt ?? '1970-01-01T00:00:00.000Z') };
  }
  const value = {
    ...saved,
    sessions: Array.isArray(saved.sessions) ? saved.sessions : [],
    cards: Array.isArray(saved.cards) ? saved.cards : [],
    reviewStates: saved.reviewStates && typeof saved.reviewStates === 'object' ? saved.reviewStates : {},
    reviewEvents: Array.isArray(saved.reviewEvents) ? saved.reviewEvents : [],
    userGlosses,
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

function loadState() {
  return loadLocalState();
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function renderSyncedState() {
  renderOverview();
  renderHistory();
  if (currentView === 'review') renderReview();
  if (currentView === 'anki' && dictionaryTerms) renderDeckCount();
}

async function persistSharedState() {
  if (!sharedSyncAvailable) return;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const snapshot = JSON.parse(JSON.stringify(state));
    const response = await fetch('/api/state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({ expectedRevision: sharedRevision, state: snapshot }),
    });
    const result = await response.json();
    if (response.status === 409) {
      sharedRevision = result.revision;
      state = migrateState(mergeSharedStates(state, result.state || {}));
      writeLocalState();
      renderSyncedState();
      continue;
    }
    if (!response.ok) throw new Error(result.error || `Shared save failed (${response.status})`);
    sharedRevision = result.revision;
    if (stableJson(snapshot) === stableJson(state)) {
      setSharedSyncStatus('Progress shared across this Tailscale network.');
      return;
    }
  }
  throw new Error('Progress changed repeatedly during sync; retrying.');
}

async function syncSharedState() {
  if (sharedSyncPromise) return sharedSyncPromise;
  sharedSyncPromise = (async () => {
    setSharedSyncStatus('Connecting to private shared storage…');
    const response = await fetch('/api/state', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Private sync service is unavailable (${response.status})`);
    const payload = await response.json();
    if (!Number.isInteger(payload.revision) || (payload.state !== null && validateClientState(payload.state))) {
      throw new Error('Private sync returned invalid state.');
    }
    sharedRevision = payload.revision;
    const merged = migrateState(mergeSharedStates(state, payload.state || {}));
    state = merged;
    writeLocalState();
    renderSyncedState();
    sharedSyncAvailable = true;
    if (payload.state === null || stableJson(merged) !== stableJson(payload.state)) {
      await persistSharedState();
    } else {
      setSharedSyncStatus('Progress shared across this Tailscale network.');
    }
  })().catch((error) => {
    setSharedSyncWarning(error);
  }).finally(() => { sharedSyncPromise = null; });
  return sharedSyncPromise;
}

function validateClientState(value) {
  return !value || typeof value !== 'object'
    || !Array.isArray(value.sessions) || !Array.isArray(value.cards)
    || !value.reviewStates || typeof value.reviewStates !== 'object'
    || !Array.isArray(value.reviewEvents) || !value.userGlosses || typeof value.userGlosses !== 'object';
}

function writeLocalState() {
  if (saveLocalState(state)) return true;
  const status = document.querySelector('#sync-status');
  if (status) status.textContent = 'Browser storage is full or unavailable. Download a backup and clear space.';
  return false;
}

function saveState() {
  writeLocalState();
  setSharedSyncStatus('Saved in this browser only. Download backups to move devices.');
}

function getUserGloss(id) {
  const gloss = state.userGlosses?.[id];
  return typeof gloss === 'string' ? gloss : String(gloss?.text ?? '');
}

function setSharedSyncStatus(message) {
  const status = document.querySelector('#sync-status');
  if (status) status.textContent = message;
}

function setSharedSyncWarning(error) {
  sharedSyncAvailable = false;
  setSharedSyncStatus(`Shared sync unavailable; saved locally. ${String(error?.message || error || 'Retrying…')}`);
}

function safeText(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function uniqueCards(cards) {
  return [...new Map(cards.map((card) => [card.kanji, card])).values()];
}

function localDateValue(date = new Date()) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

function reviewDueCount() {
  const now = Date.now();
  return Object.values(state.reviewStates || {}).filter((review) => Date.parse(review.due) <= now).length;
}

const DAILY_REVIEW_LIMIT = 10;

const ANKI_ENDPOINT_STORAGE_KEY = 'themoeway-quiz-log-anki-endpoint-v1';
const ANKI_DECK_STORAGE_KEY = 'themoeway-quiz-log-anki-deck-v1';

let state;
let sharedSyncAvailable = false;
let sharedRevision = 0;
let sharedSaveTimer = null;
let sharedRetryTimer = null;
let sharedSyncPromise = null;
let ankiEndpoint = DEFAULT_ANKI_ENDPOINT;
let selectedAnkiDeck = '';
let ankiApiKey = '';
let ankiConnected = false;
let ankiDecks = [];
let currentView = 'scores';
let currentCardId = null;
let practiceQueue = [];
let revealedId = null;
let typedMeaning = '';
let currentReviewTerm = null;
let reviewPhase = 'idle';
let reviewFeedback = '';
let reviewQueue = [];
let dictionaryTerms = null;
let dictionaryByRank = new Map();
let dictionaryPromise = null;
let searchTimer = null;
let currentStudyTerm = null;
let studyMode = 'random';
let promptMode = 'reading';
let studyPhase = 'idle';
let studyFeedback = '';
let lastRandomTermId = null;

function drawChart() {
  const host = document.querySelector('#score-chart');
  if (!host) return;
  const analytics = buildQuizAnalytics(state.sessions);
  const history = analytics.history.slice(-12);
  const forecast = analytics.forecast;
  const width = 760;
  const height = 260;
  const left = 58;
  const right = width - 24;
  const top = 22;
  const bottom = height - 45;
  const plottedCount = history.length + (forecast ? 1 : 0);
  const x = (index) => plottedCount < 2 ? (left + right) / 2 : left + (index / (plottedCount - 1)) * (right - left);
  const y = (value) => bottom - (value / 100) * (bottom - top);
  const grid = [0, 25, 50, 75, 100].map((tick) => `
    <line x1="${left}" y1="${y(tick)}" x2="${right}" y2="${y(tick)}" class="chart-grid" />
    <text x="${left - 12}" y="${y(tick) + 4}" text-anchor="end" class="chart-label">${tick}%</text>`).join('');
  const points = history.map((session, index) => ({
    x: x(index), y: y(session.accuracy), value: session.accuracy,
    label: `${session.correct}/${session.total}`, date: session.date,
  }));
  const path = points.length > 1 ? `<path d="${points.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ')}" class="chart-line" />` : '';
  const projected = forecast && points.length ? `<path d="M ${points.at(-1).x} ${points.at(-1).y} L ${x(points.length)} ${y(forecast.accuracy)}" class="chart-projection" /><circle cx="${x(points.length)}" cy="${y(forecast.accuracy)}" r="6" class="chart-projection-dot" /><text x="${x(points.length)}" y="${y(forecast.accuracy) - 13}" text-anchor="middle" class="chart-value">est.</text>` : '';
  const dots = points.map((point, index) => `
    <circle cx="${point.x}" cy="${point.y}" r="6" class="chart-dot" />
    <text x="${point.x}" y="${point.y - 13}" text-anchor="middle" class="chart-value">${point.label}</text>
    ${(index === 0 || index === points.length - 1 || index % 2 === 0) ? `<text x="${point.x}" y="${height - 13}" text-anchor="middle" class="chart-label">${safeText(point.date.slice(5))}</text>` : ''}`).join('');
  host.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Quiz score history. ${points.map((point) => `${point.date}: ${point.label}, ${point.value} percent`).join('; ')}${forecast ? `; forecast ${forecast.expectedCorrect} of ${forecast.total}` : ''}">${grid}${path}${projected}${dots}</svg>`;
}

function renderOverview() {
  const analytics = buildQuizAnalytics(state.sessions);
  const latest = analytics.history.at(-1);
  const total = analytics.quizCount;
  const pendingAnki = pendingAnkiEvents().length;
  const latestScore = document.querySelector('#latest-score');
  if (latestScore) latestScore.innerHTML = latest ? `${latest.correct}<small>/${latest.total}</small>` : '—';
  const latestDate = document.querySelector('#latest-date');
  if (latestDate) latestDate.textContent = latest ? latest.date : 'No quiz logged yet';
  const latestSummary = document.querySelector('#latest-summary');
  if (latestSummary) latestSummary.textContent = latest
    ? `${latest.accuracy}% correct${state.sessions.find((session) => String(session.id) === latest.id)?.source ? ` · ${state.sessions.find((session) => String(session.id) === latest.id).source}` : ''}`
    : 'Add your first weekly result to start the trend.';
  const forecastScore = document.querySelector('#forecast-score');
  const forecastNote = document.querySelector('#forecast-note');
  if (forecastScore) forecastScore.textContent = analytics.forecast ? `~${analytics.forecast.expectedCorrect}/${analytics.forecast.total}` : '—';
  if (forecastNote) forecastNote.textContent = analytics.forecast
    ? `~${analytics.forecast.accuracy}% from the last ${analytics.forecast.sampleSize} quizzes · rough trend, not a promise.`
    : `${Math.max(0, 3 - total)} more quiz${3 - total === 1 ? '' : 'zes'} to unlock an estimate.`;
  const quizCount = document.querySelector('#stat-quizzes');
  if (quizCount) quizCount.textContent = String(total);
  const average = document.querySelector('#stat-average');
  if (average) average.textContent = analytics.averageAccuracy === null ? '—' : `${analytics.averageAccuracy}%`;
  const trend = document.querySelector('#stat-trend');
  if (trend) trend.textContent = analytics.trendPerQuiz === null
    ? 'Need 3 quizzes'
    : `${analytics.trendPerQuiz > 0 ? '+' : ''}${analytics.trendPerQuiz} pp / quiz`;
  const dueStat = document.querySelector('#stat-due');
  if (dueStat) dueStat.textContent = String(pendingAnki);
  drawChart();
  renderHistory();
}

function renderHistory() {
  const host = document.querySelector('#history-list');
  if (!host) return;
  const sessions = [...state.sessions].sort((a, b) => b.date.localeCompare(a.date));
  host.innerHTML = sessions.map((session) => `
    <article class="history-row">
      <div><strong>${safeText(session.date)}</strong><div class="muted">${safeText(session.source || 'Quiz')} · ${session.correct}/${session.total}</div></div>
      <strong class="history-score">${accuracy(session.correct, session.total)}%</strong>
      <span class="muted">${(session.missed || []).length} missed</span>
    </article>`).join('') || '<p class="empty">No quizzes logged yet. Your scores will appear here.</p>';
}

function reviewQueueSnapshot() {
  const due = getDueReviewCards(dictionaryTerms || [], state, new Date());
  const capacity = getDailyReviewCapacity(state.reviewEvents, new Date(), DAILY_REVIEW_LIMIT);
  const available = limitDailyReviewQueue(due, state.reviewEvents, new Date(), DAILY_REVIEW_LIMIT);
  reviewQueue = available;
  return { due, capacity, available };
}

function renderReview() {
  const host = document.querySelector('#review-card');
  if (!host) return;
  const { due, capacity, available } = reviewQueueSnapshot();
  const counter = document.querySelector('#review-due-count');
  if (counter) counter.textContent = `${due.length} due · ${capacity.completed}/${capacity.limit} today`;

  if (reviewPhase === 'graded') {
    host.innerHTML = `<div class="review-finished"><p class="eyebrow">Saved to FSRS</p><p class="review-feedback">${reviewFeedback}</p><button class="button primary" data-action="continue-review">Next card</button></div>`;
    return;
  }
  if (!due.length) {
    host.innerHTML = `<div class="review-finished"><p class="eyebrow">Review queue</p><h2>Nothing due</h2><p>Quiz misses enter this queue automatically. Reviews are limited to ${DAILY_REVIEW_LIMIT} a day.</p><button class="button secondary" data-action="refresh-reviews">Check again</button></div>`;
    return;
  }
  if (!capacity.remaining) {
    host.innerHTML = `<div class="review-finished"><p class="eyebrow">Daily limit reached</p><h2>That’s enough for today.</h2><p>${due.length} overdue card${due.length === 1 ? '' : 's'} will carry over. The limit resets tomorrow.</p></div>`;
    return;
  }
  if (reviewPhase === 'idle') {
    host.innerHTML = `<div class="review-finished"><p class="eyebrow">Capped review queue</p><h2>${available.length} card${available.length === 1 ? '' : 's'} available</h2><p>Only words attached to quiz outcomes are reviewed here. Maximum ${DAILY_REVIEW_LIMIT} SRS cards per day.</p><button class="button primary" data-action="begin-review">Start review</button></div>`;
    return;
  }

  const term = available.find((item) => item.id === currentReviewTerm?.id && item.reviewMode === currentReviewTerm?.reviewMode) || available[0];
  currentReviewTerm = term;
  const cardTitle = term.term || term.kanji || 'Japanese term';
  const rank = term.rank ? `<span class="term-meta">${safeText(term.rank)}</span>` : '';
  const front = `<div class="review-front"><p class="eyebrow">${term.reviewMode === 'reading' ? 'Recall the reading' : 'Recall the meaning'}</p><div class="jp-word" lang="ja">${safeText(cardTitle)}</div>${rank}</div>`;
  if (reviewPhase === 'revealed') {
    const answer = term.reviewMode === 'reading'
      ? `<div class="review-answer"><span class="muted">Reading</span><strong lang="ja">${safeText(term.reading || 'No reading saved')}</strong></div>`
      : `<div class="review-answer"><span class="muted">Your saved meaning</span><strong>${safeText(getUserGloss(term.id) || term.meaning || 'No gloss saved. Rate your recall honestly.')}</strong></div>`;
    host.innerHTML = `${front}${answer}<div class="rating-row" role="group" aria-label="Rate this review"><button id="rating-again" class="button rating-again" data-action="rate-review" data-rating="Again">Again <kbd>1</kbd></button><button class="button" data-action="rate-review" data-rating="Hard">Hard <kbd>2</kbd></button><button class="button" data-action="rate-review" data-rating="Good">Good <kbd>3</kbd></button><button class="button" data-action="rate-review" data-rating="Easy">Easy <kbd>4</kbd></button></div><p class="keyboard-hint">Keyboard: 1 Again · 2 Hard · 3 Good · 4 Easy</p>`;
    return;
  }
  host.innerHTML = `${front}<div class="review-controls"><button class="button primary" data-action="reveal-review">Show answer <kbd>Space</kbd></button><p class="keyboard-hint">Think first, then reveal and rate. Your schedule is shared privately.</p></div>`;
}

function addReviewQueueRating(rating) {
  const term = currentReviewTerm;
  if (!term) return;
  const reviewedAt = new Date();
  const reviewKey = fsrsReviewKey(term.id, term.reviewMode);
  state.reviewStates[reviewKey] = scheduleFsrsReview(state.reviewStates[reviewKey], rating, reviewedAt);
  state.reviewEvents.push({
    id: `review-queue:${reviewedAt.getTime()}:${Math.random().toString(36).slice(2, 8)}:${term.id}`,
    cardId: term.id,
    reviewMode: term.reviewMode,
    rating,
    source: 'review-queue',
    reviewedAt: reviewedAt.toISOString(),
  });
  reviewFeedback = `${term.term || term.kanji} · ${rating} · next due ${formatDue(state.reviewStates[reviewKey].due)}.`;
  reviewPhase = 'graded';
  saveState();
  renderOverview();
  renderReview();
  document.querySelector('[data-action="continue-review"]')?.focus();
}

function handleReviewKeyboard(event) {
  if (currentView !== 'review' || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
  if (event.code === 'Space' && reviewPhase === 'question') {
    event.preventDefault();
    document.querySelector('[data-action="reveal-review"]')?.click();
    return;
  }
  if (reviewPhase === 'revealed' && /^[1-4]$/.test(event.key)) {
    event.preventDefault();
    const rating = { 1: 'Again', 2: 'Hard', 3: 'Good', 4: 'Easy' }[event.key];
    document.querySelector(`[data-action="rate-review"][data-rating="${rating}"]`)?.click();
  }
}

function activeCards() {
  return uniqueCards(state.cards).filter((card) => !card.mastered);
}

function recordReview(cardId, rating, source) {
  const reviewedAt = new Date();
  const eventId = `${source}:${reviewedAt.getTime()}:${Math.random().toString(36).slice(2, 8)}:${cardId}`;
  const reviewKey = fsrsReviewKey(cardId, 'meaning');
  state.reviewStates[reviewKey] = scheduleFsrsReview(state.reviewStates[reviewKey], rating, reviewedAt);
  state.reviewEvents.push({ id: eventId, cardId, reviewMode: 'meaning', rating, source, reviewedAt: reviewedAt.toISOString() });
  saveState();
  renderOverview();
  renderHistory();
}

function renderPractice() {
  const host = document.querySelector('#practice-card');
  if (!host) return;
  const active = activeCards();
  if (!practiceQueue.length || !practiceQueue.some((id) => active.some((card) => card.id === id))) {
    practiceQueue = active.map((card) => card.id);
  }
  const card = active.find((item) => item.id === currentCardId) || active.find((item) => item.id === practiceQueue[0]);
  currentCardId = card?.id ?? null;
  document.querySelector('#practice-count').textContent = `${active.length} left to learn`;
  if (!card) {
    host.innerHTML = `<div class="finished"><div class="checkmark">✓</div><h2>All caught up</h2><p>You marked every missed word as known. You can restart this list whenever you like.</p><button class="button secondary" data-action="restart">Review all missed words again</button></div>`;
    return;
  }
  const shown = revealedId === card.id;
  host.innerHTML = `<div class="word-stage"><span class="prompt-label">Write any meaning you remember</span><div class="jp-word" lang="ja">${safeText(card.kanji)}</div></div>
    <div class="answer-area">
      <label for="meaning-input">Your meaning</label>
      <textarea id="meaning-input" rows="2" placeholder="Type a meaning in your own words">${safeText(typedMeaning)}</textarea>
      ${shown ? `<div class="reference"><div class="reference-heading">Answer</div><div class="reading" lang="ja">${safeText(card.reading || 'Reading not recorded')}</div><p>${safeText(card.meaning || 'No reference meaning saved yet. Add one below if you know it.')}</p><label for="reference-input">Reference meaning <span class="muted">(optional)</span></label><textarea id="reference-input" rows="2" placeholder="Add a gloss for next time">${safeText(card.meaning || '')}</textarea><button class="button subtle" data-action="save-reference" data-id="${safeText(card.id)}">Save meaning</button>
        <div class="self-grade"><button class="button primary" data-action="grade-known" data-id="${safeText(card.id)}">I knew it</button><button class="button secondary" data-action="grade-again" data-id="${safeText(card.id)}">Still learning</button></div></div>` : `<button class="button primary full" data-action="reveal" data-id="${safeText(card.id)}">Show answer</button>`}
      ${card.yourAnswer ? `<p class="old-answer">Quiz answer: <code>${safeText(card.yourAnswer)}</code></p>` : ''}
    </div>`;
  document.querySelector('#meaning-input')?.addEventListener('input', (event) => { typedMeaning = event.target.value; });
}

async function loadDictionary() {
  if (dictionaryTerms) return dictionaryTerms;
  if (dictionaryPromise) return dictionaryPromise;
  const status = document.querySelector('#study-status');
  if (status) status.textContent = 'Loading the 243,795-term dictionary…';
  dictionaryPromise = (async () => {
    const response = await fetch(DICTIONARY_URL);
    if (!response.ok) throw new Error(`Dictionary download failed (${response.status}).`);
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('This browser cannot decompress the local dictionary. Use a recent Safari, Chrome, or Firefox.');
    }
    const compressed = await response.arrayBuffer();
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'));
    const payload = await new Response(stream).json();
    if (!Array.isArray(payload.terms) || !Array.isArray(payload.ranks)) throw new Error('The frequency dictionary file is invalid.');
    dictionaryTerms = normalizeDictionaryTerms(payload.terms.map((row) => ({
      id: row[4], term: row[0], reading: row[1], frequency: row[2], rank: payload.ranks[row[3]] || '',
    })));
    if (!dictionaryTerms.length) throw new Error('The frequency dictionary has no usable terms.');
    dictionaryByRank = new Map();
    for (const term of dictionaryTerms) {
      const bucket = dictionaryByRank.get(term.rank) || [];
      bucket.push(term);
      dictionaryByRank.set(term.rank, bucket);
    }
    const rankFilter = document.querySelector('#deck-tier');
    if (rankFilter) {
      const previousTier = rankFilter.value;
      rankFilter.innerHTML = `<option value="">Choose a tier</option>${FREQUENCY_TIERS.map((rank) => `<option value="${safeText(rank)}">${safeText(rank)}</option>`).join('')}`;
      if (FREQUENCY_TIERS.includes(previousTier)) rankFilter.value = previousTier;
    }
    if (status) status.textContent = `${dictionaryTerms.length.toLocaleString()} terms loaded. The file contains expressions and readings, not English definitions.`;
    renderDeckCount();
    renderSearchResults();
    renderOverview();
    return dictionaryTerms;
  })().catch((error) => {
    dictionaryPromise = null;
    if (status) status.textContent = `${error.message} Check that data/tmw-terms.json.gz is present.`;
    throw error;
  });
  return dictionaryPromise;
}

function currentStudyOptions() {
  studyMode = document.querySelector('#study-mode')?.value || studyMode;
  promptMode = document.querySelector('#prompt-mode')?.value || promptMode;
}

function selectedRank() {
  return document.querySelector('#deck-tier')?.value || '';
}

function renderDeckCount() {
  const host = document.querySelector('#deck-match-count');
  const rank = selectedRank() || 'Trainee';
  const link = document.querySelector('#tier-apkg-link');
  if (link) {
    link.href = `./downloads/themoeway-${rank.toLowerCase()}-typing.apkg`;
    link.textContent = `Download ${rank} typing deck (.apkg)`;
  }
  if (!host || !dictionaryTerms) return;
  const count = dictionaryByRank.get(rank)?.length || 0;
  host.textContent = `${count.toLocaleString()} terms in this deck`;
}

function renderSearchResults() {
  const host = document.querySelector('#search-results');
  const status = document.querySelector('#search-status');
  if (!host || !status || !dictionaryTerms) return;
  const query = document.querySelector('#deck-search')?.value || '';
  if (!query.trim()) {
    host.innerHTML = '';
    status.textContent = 'Search by expression, kana, or romaji; results are capped at 12.';
    return;
  }
  const results = searchDictionaryTerms(dictionaryTerms, query, selectedRank(), 12);
  host.innerHTML = results.map((term) => `<button type="button" class="search-result" data-action="study-selected" data-id="${safeText(term.id)}"><span class="jp-small" lang="ja">${safeText(term.term)}</span><span lang="ja">${safeText(term.reading)}</span><span class="muted">${safeText(term.rank)}${term.frequency ? ` · ${safeText(term.frequency)}` : ''}</span></button>`).join('');
  status.textContent = results.length ? `${results.length}${results.length === 12 ? '+' : ''} matching terms shown.` : 'No matching terms in this frequency tier.';
}

function chooseNextStudyTerm() {
  if (!dictionaryTerms?.length) return null;
  const rank = selectedRank();
  if (studyMode === 'due') {
    const due = getDueReviewCards(dictionaryTerms, state, new Date()).filter((term) => !rank || term.rank === rank)[0] || null;
    if (due) {
      promptMode = due.reviewMode;
      document.querySelector('#prompt-mode').value = promptMode;
    }
    return due;
  }
  const pool = rank ? (dictionaryByRank.get(rank) || []) : dictionaryTerms;
  if (!pool.length) return null;
  if (pool.length === 1) return pool[0];
  let index = Math.floor(Math.random() * pool.length);
  if (pool[index].id === lastRandomTermId) index = (index + 1 + Math.floor(Math.random() * (pool.length - 1))) % pool.length;
  return pool[index];
}

function formatDue(value) {
  const due = new Date(value);
  return due.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function renderStudyCard(term) {
  currentStudyTerm = term;
  const host = document.querySelector('#study-question');
  if (!host) return;
  if (!term) {
    studyPhase = 'idle';
    const dueMode = studyMode === 'due';
    const emptyMessage = dueMode
      ? (selectedRank() ? `Nothing is due in ${selectedRank()}. Choose All frequency tiers or another tier to review different cards.` : 'Nothing is due yet. FSRS will bring your reviewed terms back at the scheduled time.')
      : 'Draw a random term from the TMW frequency dictionary.';
    host.innerHTML = `<div class="finished"><div class="checkmark">${dueMode ? '✓' : 'こ'}</div><h2>${dueMode ? 'No reviews due' : 'Ready when you are'}</h2><p>${safeText(emptyMessage)}</p><button class="button primary" data-action="start-study">${dueMode ? 'Check due reviews' : 'Draw a random term'}</button></div>`;
    return;
  }
  lastRandomTermId = studyMode === 'random' ? term.id : lastRandomTermId;
  const rank = term.rank ? `<span class="term-meta">${safeText(term.rank)}${term.frequency ? ` · frequency ${safeText(term.frequency)}` : ''}</span>` : '';
  const gloss = getUserGloss(term.id) || term.meaning || '';
  let content = '';
  if (studyPhase === 'question') {
    content = promptMode === 'reading'
      ? `<label for="study-answer">Reading · kana or romaji</label><input id="study-answer" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="e.g. iru or いる"><button class="button primary full" data-action="submit-reading">Check reading</button><p class="form-status" id="study-feedback" role="status"></p>`
      : `<label for="study-answer">Write any meaning you remember</label><textarea id="study-answer" rows="2" placeholder="Your own words are fine"></textarea><button class="button primary full" data-action="reveal-meaning">Show reading</button><p class="form-status" id="study-feedback" role="status"></p>`;
  } else if (studyPhase === 'revealed') {
    content = `<div class="reference"><div class="reference-heading">Reading</div><div class="reading" lang="ja">${safeText(term.reading)}</div><p>${safeText(gloss || 'No gloss is included in this frequency deck. Add your own if you know it.')}</p><label for="gloss-input">Your reference meaning <span class="muted">(optional, shared privately)</span></label><textarea id="gloss-input" rows="2" placeholder="Add a gloss for next time">${safeText(gloss)}</textarea><button class="button subtle" data-action="save-gloss">Save meaning</button><div class="self-grade" aria-label="Rate recall"><button class="button subtle rating-again" data-action="rate-study" data-rating="Again">Again</button><button class="button subtle" data-action="rate-study" data-rating="Hard">Hard</button><button class="button secondary" data-action="rate-study" data-rating="Good">Good</button><button class="button primary" data-action="rate-study" data-rating="Easy">Easy</button></div></div>`;
  } else if (studyPhase === 'graded') {
    content = `<div class="graded-result" role="status">${studyFeedback}</div><button class="button primary full" data-action="start-study">Next term</button>`;
  } else {
    content = `<p class="muted">Choose a session and draw a term.</p>`;
  }
  host.innerHTML = `<div class="word-stage"><span class="prompt-label">${promptMode === 'reading' ? 'Type the reading' : 'Recall a meaning'}</span><div class="jp-word" lang="ja">${safeText(term.term)}</div>${rank}</div><div class="answer-area">${content}</div>`;
  document.querySelector('#study-answer')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && promptMode === 'reading' && studyPhase === 'question') {
      event.preventDefault();
      submitReadingAnswer();
    }
  });
}

function addStudyReview(term, rating) {
  const reviewedAt = new Date();
  const eventId = `study:${reviewedAt.getTime()}:${Math.random().toString(36).slice(2, 8)}:${term.id}`;
  const reviewKey = fsrsReviewKey(term.id, promptMode);
  state.reviewStates[reviewKey] = scheduleFsrsReview(state.reviewStates[reviewKey], rating, reviewedAt);
  state.reviewEvents.push({ id: eventId, cardId: term.id, reviewMode: promptMode, rating, source: 'study', reviewedAt: reviewedAt.toISOString() });
  saveState();
  renderOverview();
}

function submitReadingAnswer() {
  const field = document.querySelector('#study-answer');
  const answer = field?.value.trim() || '';
  const feedback = document.querySelector('#study-feedback');
  if (!answer) {
    if (feedback) feedback.textContent = 'Type a reading first.';
    field?.focus();
    return;
  }
  const correct = matchesReading(answer, currentStudyTerm.reading);
  const rating = correct ? 'Good' : 'Again';
  addStudyReview(currentStudyTerm, rating);
  studyPhase = 'graded';
  const reading = safeText(currentStudyTerm.reading);
  studyFeedback = correct
    ? `<strong class="feedback-good">Correct.</strong> ${reading} · FSRS: Good · next due ${safeText(formatDue(state.reviewStates[fsrsReviewKey(currentStudyTerm.id, 'reading')].due))}`
    : `<strong class="feedback-wrong">Not quite.</strong> The reading is <span lang="ja">${reading}</span> · FSRS: Again · next due ${safeText(formatDue(state.reviewStates[fsrsReviewKey(currentStudyTerm.id, 'reading')].due))}`;
  renderStudyCard(currentStudyTerm);
}

function setView(view) {
  currentView = view;
  document.querySelectorAll('[data-view]').forEach((button) => {
    button.setAttribute('aria-current', button.dataset.view === view ? 'page' : 'false');
  });
  document.querySelectorAll('.view').forEach((section) => {
    section.hidden = section.id !== `${view}-view`;
  });
  if (view === 'review') renderReview();
  if (view === 'anki') {
    renderAnkiPanel();
    loadDictionary().then(renderDeckCount).catch(() => {});
  }
  if (view === 'history') renderHistory();
}

function saveAndRender() {
  saveState();
  renderOverview();
  renderHistory();
  if (currentView === 'anki') renderAnkiPanel();
}

function pendingAnkiEvents() {
  return (state.ankiGradeEvents || []).filter((event) => ['pending', 'unmatched', 'ambiguous'].includes(event.status));
}

function queueAnkiOutcomes(sessionId, items) {
  state.ankiGradeEvents ??= [];
  const known = new Set(state.ankiGradeEvents.map((event) => event.id));
  for (const item of items) {
    const id = `anki:${sessionId}:${encodeURIComponent(item.kanji)}:${encodeURIComponent(item.reading)}`;
    if (known.has(id)) continue;
    state.ankiGradeEvents.push({
      id, sessionId, kanji: item.kanji, reading: item.reading, rating: item.rating,
      status: 'pending', createdAt: new Date().toISOString(),
    });
    known.add(id);
  }
}

function setAnkiStatus(message) {
  const status = document.querySelector('#anki-connection-status');
  if (status) status.textContent = message;
}

function renderAnkiPanel() {
  const endpoint = document.querySelector('#anki-endpoint');
  if (endpoint) endpoint.value = ankiEndpoint;
  const select = document.querySelector('#anki-deck');
  if (select) {
    const decks = ankiDecks.length ? ankiDecks : [];
    select.innerHTML = `<option value="">${decks.length ? 'Choose the deck that contains quiz words' : 'Connect to load your Anki decks'}</option>${decks.map((deck) => `<option value="${safeText(deck)}">${safeText(deck)}</option>`).join('')}`;
    if (decks.includes(selectedAnkiDeck)) select.value = selectedAnkiDeck;
    select.disabled = !ankiConnected;
  }
  const pending = document.querySelector('#anki-pending-count');
  if (pending) pending.textContent = `${pendingAnkiEvents().length} outcomes waiting`;
  const applyButton = document.querySelector('[data-action="apply-pending-anki"]');
  if (applyButton) applyButton.disabled = !ankiConnected || !selectedAnkiDeck || !pendingAnkiEvents().length;
}

function loadAnkiPreferences() {
  try {
    ankiEndpoint = localStorage.getItem(ANKI_ENDPOINT_STORAGE_KEY) || DEFAULT_ANKI_ENDPOINT;
    selectedAnkiDeck = localStorage.getItem(ANKI_DECK_STORAGE_KEY) || '';
  } catch {
    ankiEndpoint = DEFAULT_ANKI_ENDPOINT;
    selectedAnkiDeck = '';
  }
}

async function connectAnkiFromForm() {
  const endpointInput = document.querySelector('#anki-endpoint');
  const apiKeyInput = document.querySelector('#anki-api-key');
  try {
    ankiEndpoint = endpointInput?.value || DEFAULT_ANKI_ENDPOINT;
    ankiApiKey = apiKeyInput?.value || '';
    localStorage.setItem(ANKI_ENDPOINT_STORAGE_KEY, ankiEndpoint);
    setAnkiStatus('Requesting permission and loading Anki decks…');
    const connection = await connectToAnki(ankiEndpoint, { apiKey: ankiApiKey });
    ankiConnected = true;
    ankiDecks = connection.decks;
    const savedDeck = localStorage.getItem(ANKI_DECK_STORAGE_KEY) || '';
    selectedAnkiDeck = ankiDecks.includes(savedDeck) ? savedDeck
      : ankiDecks.find((deck) => deck === 'TheMoeWay::Frequency::Trainee') || '';
    if (selectedAnkiDeck) localStorage.setItem(ANKI_DECK_STORAGE_KEY, selectedAnkiDeck);
    renderAnkiPanel();
    setAnkiStatus(`Connected to AnkiConnect API v${connection.version}. Quiz results grade only exact matches in the selected deck.`);
  } catch (error) {
    ankiConnected = false;
    ankiDecks = [];
    renderAnkiPanel();
    setAnkiStatus(error?.message || 'Could not connect to AnkiConnect.');
  }
}

async function applyAnkiEvents(eventIds) {
  const selected = (state.ankiGradeEvents || []).filter((event) => eventIds.includes(event.id)
    && ['pending', 'unmatched', 'ambiguous'].includes(event.status));
  if (!selected.length) return { applied: 0, unmatched: 0, ambiguous: 0, unknown: 0 };
  if (!ankiConnected || !selectedAnkiDeck) throw new Error('Connect to Anki and choose a deck first.');
  setAnkiStatus(`Matching ${selected.length} word outcome${selected.length === 1 ? '' : 's'} in ${selectedAnkiDeck}…`);
  const result = await gradeOutcomesWithAnki({
    endpoint: ankiEndpoint,
    deckName: selectedAnkiDeck,
    outcomes: selected.map(({ kanji, reading, rating }) => ({ kanji, reading, rating })),
    apiKey: ankiApiKey,
  });
  result.outcomes.forEach((outcome, index) => {
    const event = selected[index];
    const target = state.ankiGradeEvents.find((candidate) => candidate.id === event.id);
    if (!target) return;
    target.status = outcome.status;
    target.cardId = outcome.cardId ?? null;
    target.noteId = outcome.noteId ?? null;
    target.updatedAt = new Date().toISOString();
  });
  saveState();
  renderOverview();
  renderAnkiPanel();
  const applied = result.outcomes.filter((outcome) => outcome.status === 'applied').length;
  const unmatched = result.outcomes.filter((outcome) => outcome.status === 'unmatched').length;
  const ambiguous = result.outcomes.filter((outcome) => outcome.status === 'ambiguous').length;
  const unknown = result.outcomes.filter((outcome) => outcome.status === 'unknown').length;
  const message = `Verified ${applied} Anki grade${applied === 1 ? '' : 's'}; ${unmatched} unmatched; ${ambiguous} ambiguous; ${unknown} uncertain.`;
  setAnkiStatus(result.error ? `${message} ${result.error}` : message);
  return { applied, unmatched, ambiguous, unknown };
}

async function applyPendingAnkiEvents() {
  if (!ankiConnected || !selectedAnkiDeck) {
    setAnkiStatus('Connect to Anki and choose a deck first.');
    return;
  }
  const pending = pendingAnkiEvents();
  const sessionIds = [...new Set(pending.map((event) => event.sessionId))];
  sessionIds.sort((a, b) => {
    const left = state.sessions.find((session) => session.id === a)?.date || '';
    const right = state.sessions.find((session) => session.id === b)?.date || '';
    return left.localeCompare(right);
  });
  for (const sessionId of sessionIds) {
    try {
      await applyAnkiEvents(pending.filter((event) => event.sessionId === sessionId).map((event) => event.id));
    } catch (error) {
      setAnkiStatus(`No grade was sent for this batch. ${error?.message || error}`);
      return;
    }
  }
}

function selectAnkiDeck(deck) {
  selectedAnkiDeck = ankiDecks.includes(deck) ? deck : '';
  if (selectedAnkiDeck) localStorage.setItem(ANKI_DECK_STORAGE_KEY, selectedAnkiDeck);
  else localStorage.removeItem(ANKI_DECK_STORAGE_KEY);
  renderAnkiPanel();
}


function initialize() {
  if (typeof document === 'undefined' || !document.querySelector('#app')) return;
  state = loadState();
  loadAnkiPreferences();
  document.querySelector('#app').innerHTML = `
    <header class="topbar"><a class="brand" href="#scores" aria-label="TheMoeWay Quiz Log home"><span class="brand-mark">MW</span><span>TheMoeWay <span class="brand-accent">Quiz Log</span></span></a><div class="top-actions"><button class="button secondary export" data-action="export">Backup</button><button class="button subtle" data-action="import-backup">Restore</button><input id="backup-file" type="file" accept="application/json,.json" hidden></div></header>
    <main class="shell">
      <section class="page-intro"><div><p class="eyebrow">Weekly quiz tracker</p><h1>Scores and words worth revisiting.</h1><p class="intro-copy">Log each quiz, follow your score trend, and send identified word grades to Anki.</p></div><button class="button primary" data-action="focus-quiz-form">Log a quiz</button></section>
      <nav class="tabs" aria-label="Main navigation"><button data-view="scores" aria-controls="scores-view" aria-current="page">Scores</button><button data-view="anki" aria-controls="anki-view" aria-current="false">AnkiConnect</button></nav>
      <section class="view" id="scores-view">
        <div class="summary-grid"><article class="summary-card latest-card"><div><p class="eyebrow">Most recent quiz</p><strong id="latest-score" class="big-score">—</strong><p id="latest-date" class="summary-date">No quiz logged yet</p></div><p id="latest-summary" class="summary-note">Add your first weekly result to start the trend.</p></article><article class="summary-card forecast-card"><p class="eyebrow">Next quiz estimate</p><strong id="forecast-score" class="big-score">—</strong><p id="forecast-note" class="summary-note">Log 3 quizzes to unlock an estimate.</p></article></div>
        <div class="stats-grid"><article class="stat"><span>Quiz results</span><strong id="stat-quizzes">0</strong></article><article class="stat"><span>Average accuracy</span><strong id="stat-average">—</strong></article><article class="stat"><span>Trend</span><strong id="stat-trend">Need 3 quizzes</strong></article><article class="stat"><span>Pending Anki grades</span><strong id="stat-due">0</strong></article></div>
        <article class="panel chart-panel"><div class="panel-heading"><div><p class="eyebrow">Your record</p><h2>Quiz scores over time</h2></div><span class="chart-key"><i></i> Actual <i class="forecast-key"></i> Estimate</span></div><div id="score-chart" class="chart-wrap"></div><p class="chart-note">The estimate is a simple trend from up to six recent quizzes. It needs at least three results and is not a guarantee.</p></article>
        <article id="quiz-entry" class="panel import-panel"><div class="panel-heading"><div><p class="eyebrow">After your weekly quiz</p><h2>Log a result</h2></div></div><p class="muted">Identified wrong answers become Again and right answers Good in your selected Anki deck. Only exact expression-and-reading matches are graded; score-only results never invent word grades. If Anki is disconnected, word outcomes wait in this browser.</p><form id="manual-form" class="quiz-form"><label>Quiz source<select name="source"><option value="TheMoeWay">TheMoeWay</option><option value="KotobaAPP">KotobaAPP</option><option value="Other">Other</option></select></label><label>Date<input name="date" type="date" required></label><label>Correct<input name="correct" type="number" min="0" required></label><label>Total questions<input name="total" type="number" min="1" required></label><label class="outcome-field" for="manual-outcomes">Identifiable word outcomes <span class="muted">(optional)</span></label><textarea id="manual-outcomes" name="outcomes" rows="4" placeholder="One per line: expression (reading) = right / wrong\nExample: 特別 (とくべつ) = wrong"></textarea><p class="muted form-help">You can also use Again / Hard / Good / Easy. Leave blank if you only have the total score.</p><div class="form-actions"><button class="button primary" type="submit">Save quiz</button><span id="manual-status" class="form-status" role="status"></span></div></form><details class="legacy-entry"><summary>Import an older KotobaAPP report</summary><label for="report-date">Quiz date</label><input id="report-date" type="date"><label for="report-input">Game report</label><textarea id="report-input" rows="6" placeholder="Paste the report including its unanswered-question summary."></textarea><label for="report-outcomes">Known right answers <span class="muted">(optional)</span></label><textarea id="report-outcomes" rows="3" placeholder="One per line: expression (reading) = right"></textarea><div class="form-actions"><button class="button secondary" data-action="import-report">Import report</button><span id="import-status" class="form-status" role="status"></span></div></details></article>
        <article class="panel"><div class="panel-heading"><div><p class="eyebrow">All recorded runs</p><h2>Quiz history</h2></div></div><div id="history-list" class="history-list"></div></article>
      </section>
      <section class="view" id="anki-view" hidden><div class="section-heading"><div><p class="eyebrow">Quiz grades to Anki</p><h2>Connect AnkiConnect</h2><p class="muted">Anki schedules and reviews the words; this page keeps your quiz log in this browser.</p></div></div><article class="panel anki-connect-panel"><form id="anki-connection-form" class="quiz-form"><label>Local AnkiConnect URL<input id="anki-endpoint" type="url" value="http://127.0.0.1:8766" required></label><label>API key <span class="muted">(only if your add-on requires one; kept in memory)</span><input id="anki-api-key" type="password" autocomplete="off"></label><div class="form-actions"><button class="button primary" type="submit">Connect to Anki</button><span id="anki-connection-status" class="form-status" role="status">Not connected. Open Anki on this device, then connect.</span></div></form><label for="anki-deck">Deck containing your quiz words</label><select id="anki-deck" disabled><option value="">Connect to load your Anki decks</option></select><div class="form-actions"><span id="anki-pending-count" class="muted">0 outcomes waiting</span><button class="button secondary" data-action="apply-pending-anki" disabled>Apply pending grades</button></div><div class="anki-note"><strong>Local connection and privacy</strong><p>Use the app in a browser on the same computer as Anki. AnkiConnect Extended must allow this site’s origin; approve its permission prompt. Keep its web bind address on loopback. Quiz history and settings stay in this browser’s local storage; use Backup/Restore to move them.</p></div></article><article class="panel deck-panel"><div class="panel-heading"><div><p class="eyebrow">Type-answer decks</p><h2>Import a frequency tier</h2><p class="muted">The front shows the expression and asks you to type its reading, like the quiz. The answer shows the reading and frequency details.</p></div></div><label for="deck-tier">Frequency tier</label><select id="deck-tier"><option value="">Choose a tier</option>${FREQUENCY_TIERS.map((tier) => `<option value="${safeText(tier)}">${safeText(tier)}</option>`).join('')}</select><p id="deck-match-count" class="muted">243,795 terms total</p><a class="button primary" id="tier-apkg-link" href="./downloads/themoeway-trainee-typing.apkg" download>Download Trainee typing deck (.apkg)</a><p id="study-status" class="study-status" role="status">Each package has gentle Anki limits: 5 new cards and 10 reviews a day.</p></article></section>
      <footer><span id="sync-status" role="status" aria-live="polite">Saved in this browser only. Download backups to move devices.</span> · Quiz data stays in local storage · <button class="text-button" data-action="export">Download backup</button></footer>
    </main>`;

  document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', (event) => {
    event.preventDefault();
    setView(button.dataset.view);
  }));
  document.querySelector('#deck-tier').addEventListener('change', renderDeckCount);
  document.querySelector('#anki-connection-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    await connectAnkiFromForm();
  });
  document.querySelector('#anki-deck').addEventListener('change', (event) => selectAnkiDeck(event.target.value));
  document.querySelector('#backup-file').addEventListener('change', async (event) => {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    try {
      if (!confirm('Merge this backup into the quiz history stored in this browser?')) return;
      state = importStateBackup(await file.text(), state);
      saveAndRender();
      setSharedSyncStatus('Backup merged and saved in this browser.');
    } catch (error) {
      setSharedSyncStatus(error?.message || 'Could not restore this backup.');
    } finally {
      event.currentTarget.value = '';
    }
  });
  document.querySelector('#app').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    if (action === 'import-backup') {
      document.querySelector('#backup-file').click();
    } else if (action === 'apply-pending-anki') {
      await applyPendingAnkiEvents();
    } else if (action === 'focus-quiz-form') {
      setView('scores');
      document.querySelector('#quiz-entry').scrollIntoView({ behavior: 'smooth', block: 'start' });
      document.querySelector('#manual-form [name="source"]').focus();
    } else if (action === 'import-report') {
      const date = document.querySelector('#report-date').value;
      const status = document.querySelector('#import-status');
      try {
        if (!date) throw new Error('Choose the quiz date first.');
        const result = parseKotobaReport(document.querySelector('#report-input').value, date);
        const outcomes = parseItemOutcomes(document.querySelector('#report-outcomes').value);
        const items = resolveItemOutcomes({ ...result, outcomes });
        const id = stableQuizSessionId({ ...result, outcomes });
        const missed = items.filter((item) => item.rating === 'Again').map((item) => item.kanji);
        const duplicate = state.sessions.some((session) => session.id === id || (
          session.date === result.date && session.correct === result.correct && session.total === result.total
          && Array.isArray(session.missed) && JSON.stringify([...session.missed].sort()) === JSON.stringify([...result.wrong.map((item) => item.kanji)].sort())
        ));
        if (duplicate) throw new Error('That KotobaAPP result is already in your history.');
        state.sessions.push({ id, date: result.date, correct: result.correct, total: result.total, source: 'KotobaAPP', missed, items });
        queueAnkiOutcomes(id, items);
        document.querySelector('#report-input').value = '';
        document.querySelector('#report-outcomes').value = '';
        saveAndRender();
        if (items.length && ankiConnected && selectedAnkiDeck) {
          try {
            await applyAnkiEvents(state.ankiGradeEvents.filter((event) => event.sessionId === id).map((event) => event.id));
            status.textContent = `Saved ${result.correct}/${result.total}; Anki result: ${document.querySelector('#anki-connection-status')?.textContent || 'check connection status'}`;
          } catch (error) {
            status.textContent = `Saved ${result.correct}/${result.total}; grades are waiting in this browser. ${error.message}`;
          }
        } else {
          status.textContent = items.length
            ? `Saved ${result.correct}/${result.total}; ${items.length} word grades are waiting for AnkiConnect.`
            : `Saved ${result.correct}/${result.total}. No per-word grades were guessed.`;
        }
      } catch (error) {
        status.textContent = error.message;
      }
    } else if (action === 'export') {
      const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = 'themoeway-quiz-backup.json';
      link.click();
      URL.revokeObjectURL(link.href);
    }
  });


  document.querySelector('#manual-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const correct = Number(form.get('correct'));
    const total = Number(form.get('total'));
    const date = String(form.get('date'));
    const source = String(form.get('source') || 'TheMoeWay');
    const status = document.querySelector('#manual-status');
    try {
      if (!date || correct < 0 || total < 1 || correct > total) throw new Error('Enter a valid date, correct count, and total.');
      const input = { date, correct, total, outcomes: parseItemOutcomes(form.get('outcomes')) };
      const items = resolveItemOutcomes(input);
      const id = stableQuizSessionId(input);
      if (state.sessions.some((session) => session.id === id)) throw new Error('That result is already in your history.');
      state.sessions.push({ id, date, correct, total, source, missed: items.filter((item) => item.rating === 'Again').map((item) => item.kanji), items });
      queueAnkiOutcomes(id, items);
      event.currentTarget.reset();
      document.querySelector('#manual-form [name="date"]').value = localDateValue();
      saveAndRender();
      if (items.length && ankiConnected && selectedAnkiDeck) {
        try {
          await applyAnkiEvents(state.ankiGradeEvents.filter((grade) => grade.sessionId === id).map((grade) => grade.id));
          status.textContent = `Saved ${correct}/${total} from ${source}; ${document.querySelector('#anki-connection-status')?.textContent || 'Anki result saved'}`;
        } catch (error) {
          status.textContent = `Saved ${correct}/${total}; grades are waiting in this browser. ${error.message}`;
        }
      } else {
        status.textContent = items.length
          ? `Saved ${correct}/${total}; ${items.length} word grades are waiting for AnkiConnect.`
          : `Saved ${correct}/${total} from ${source}. No per-word grades were guessed.`;
      }
    } catch (error) {
      status.textContent = error.message;
    }
  });

  const dateInput = document.querySelector('#manual-form [name="date"]');
  dateInput.value = localDateValue();
  document.querySelector('#report-date').value = localDateValue();
  document.querySelector('#deck-tier').value = 'Trainee';
  renderOverview();
  renderHistory();
  renderAnkiPanel();
  renderDeckCount();
}

if (typeof document !== 'undefined') initialize();
