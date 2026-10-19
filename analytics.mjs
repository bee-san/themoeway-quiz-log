function accuracy(session) {
  const correct = Number(session?.correct);
  const total = Number(session?.total);
  return total > 0 && Number.isFinite(correct) && Number.isFinite(total)
    ? (correct / total) * 100
    : null;
}

export function buildQuizAnalytics(sessions = []) {
  const history = (Array.isArray(sessions) ? sessions : [])
    .map((session, index) => ({
      id: String(session?.id ?? index),
      date: String(session?.date ?? ''),
      correct: Number(session?.correct),
      total: Number(session?.total),
      accuracy: accuracy(session),
      index,
    }))
    .filter((session) => session.accuracy !== null && session.correct >= 0 && session.correct <= session.total)
    .sort((a, b) => a.date.localeCompare(b.date) || a.index - b.index);

  const quizCount = history.length;
  const averageAccuracy = quizCount
    ? history.reduce((sum, session) => sum + session.accuracy, 0) / quizCount
    : null;
  const recent = history.slice(-6);
  let trendPerQuiz = null;
  let forecast = null;

  if (recent.length >= 3) {
    const xMean = (recent.length - 1) / 2;
    const yMean = recent.reduce((sum, point) => sum + point.accuracy, 0) / recent.length;
    const numerator = recent.reduce((sum, point, index) => sum + (index - xMean) * (point.accuracy - yMean), 0);
    const denominator = recent.reduce((sum, _, index) => sum + (index - xMean) ** 2, 0);
    const slope = denominator ? numerator / denominator : 0;
    const predicted = Math.max(0, Math.min(100, yMean + slope * (recent.length - xMean)));
    const latestTotal = recent.at(-1).total;
    trendPerQuiz = Math.round(slope * 10) / 10;
    forecast = {
      accuracy: Math.round(predicted * 10) / 10,
      expectedCorrect: Math.round((predicted / 100) * latestTotal),
      total: latestTotal,
      sampleSize: recent.length,
    };
  }

  return {
    quizCount,
    averageAccuracy: averageAccuracy === null ? null : Math.round(averageAccuracy * 10) / 10,
    trendPerQuiz,
    forecast,
    history: history.map(({ id, date, correct, total, accuracy: score }) => ({
      id, date, correct, total, accuracy: Math.round(score * 10) / 10,
    })),
  };
}
