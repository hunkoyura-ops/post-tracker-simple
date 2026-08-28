function validateMetrics(metrics, creatorFollowers) {
  const flags = [];

  if (metrics.likes !== null && metrics.views !== null && metrics.likes > metrics.views) {
    flags.push("Лайків більше ніж переглядів — ймовірна помилка розпізнавання");
  }

  const reach = metrics.reach ?? metrics.views;
  if (reach !== null && reach > 0) {
    const engagements =
      (metrics.likes ?? 0) + (metrics.comments ?? 0) + (metrics.shares ?? 0) + (metrics.saves ?? 0);
    const er = engagements / reach;
    if (er > 1) {
      flags.push(`ER ${(er * 100).toFixed(0)}% — фізично неможливо, перевірити вручну`);
    }
  }

  if (metrics.reach !== null && creatorFollowers > 0) {
    const multiplier = metrics.reach / creatorFollowers;
    if (multiplier > 20) {
      flags.push(
        `Охоплення в ${multiplier.toFixed(1)}x більше підписників — або вірусний пост, або помилка зчитування`
      );
    }
  }

  for (const [key, value] of Object.entries(metrics)) {
    if (typeof value === "number" && value < 0) {
      flags.push(`Від'ємне значення в полі ${key}`);
    }
  }

  if (metrics.views === null && metrics.reach === null && metrics.impressions === null) {
    flags.push("Не вдалося розпізнати жодної метрики охоплення — потрібен ручний ввід");
  }

  return flags;
}

export { validateMetrics };
