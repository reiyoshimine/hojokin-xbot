// 補助金XBot - バズパターン分析ライブラリ
// ツイートデータからエンゲージメントの高いパターンを抽出

/**
 * エンゲージメントスコアを計算
 */
export function engagementScore(metrics) {
  const { likes = 0, retweets = 0, replies = 0 } = metrics || {};
  return likes + retweets * 2 + replies * 1.5;
}

/**
 * フック文（1行目）のパターンを分類
 */
function classifyHook(firstLine) {
  if (!firstLine) return 'other';
  if (/あと\d+日|残り\d+日|締切まで|締切.?日前|カウントダウン/.test(firstLine)) return 'urgency';
  if (/\d+万円|\d+億円|上限|補助額|補助上限/.test(firstLine)) return 'amount';
  if (/知らない.?損|もったいない|損してる|見逃/.test(firstLine)) return 'loss_aversion';
  if (/知ってた|知ってました|ですか？|いませんか/.test(firstLine)) return 'question';
  if (/新しく|新規|始まった|出てきた/.test(firstLine)) return 'novelty';
  if (/共有|シェア|メモ|紹介/.test(firstLine)) return 'sharing';
  return 'other';
}

/**
 * ツイート群からフックパターンの効果を分析
 */
export function analyzeHookPatterns(tweets) {
  const patternStats = {};

  for (const t of tweets) {
    const firstLine = (t.text || '').split('\n')[0].trim();
    const pattern = classifyHook(firstLine);
    const score = engagementScore(t.metrics);

    if (!patternStats[pattern]) {
      patternStats[pattern] = { totalScore: 0, count: 0, examples: [] };
    }
    patternStats[pattern].totalScore += score;
    patternStats[pattern].count += 1;
    if (patternStats[pattern].examples.length < 3) {
      patternStats[pattern].examples.push(firstLine);
    }
  }

  return Object.entries(patternStats)
    .map(([pattern, stats]) => ({
      pattern,
      avgEngagement: stats.count > 0 ? stats.totalScore / stats.count : 0,
      count: stats.count,
      examples: stats.examples,
    }))
    .sort((a, b) => b.avgEngagement - a.avgEngagement);
}

/**
 * ハッシュタグの効果を分析
 */
export function analyzeHashtags(tweets) {
  const tagStats = {};

  for (const t of tweets) {
    const tags = (t.text || '').match(/#[^\s#]+/g) || [];
    const score = engagementScore(t.metrics);

    for (const tag of tags) {
      if (!tagStats[tag]) tagStats[tag] = { totalScore: 0, count: 0 };
      tagStats[tag].totalScore += score;
      tagStats[tag].count += 1;
    }
  }

  return Object.entries(tagStats)
    .map(([tag, stats]) => ({
      tag,
      avgEngagement: stats.count > 0 ? stats.totalScore / stats.count : 0,
      frequency: stats.count / Math.max(tweets.length, 1),
      count: stats.count,
    }))
    .sort((a, b) => b.avgEngagement - a.avgEngagement);
}

/**
 * ツイート構造の分析
 */
export function analyzeStructure(tweets) {
  if (tweets.length === 0) return { optimalLineCount: [4, 7], avgEmojiDensity: 0.02, ctaRate: 0.8 };

  const scored = tweets.map(t => ({
    text: t.text || '',
    score: engagementScore(t.metrics),
  }));

  // 上位25%を「成功ツイート」とする
  scored.sort((a, b) => b.score - a.score);
  const topQuarter = scored.slice(0, Math.max(1, Math.floor(scored.length * 0.25)));

  const lineCounts = topQuarter.map(t => t.text.split('\n').filter(l => l.trim()).length);
  const emojiCounts = topQuarter.map(t => {
    const emojis = t.text.match(/[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu) || [];
    return emojis.length / Math.max(t.text.length, 1);
  });
  const ctaCount = topQuarter.filter(t =>
    /チェック|確認|見て|詳細|リンク|ぜひ|推奨|動いて/.test(t.text)
  ).length;

  const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
  const sortedLines = [...lineCounts].sort((a, b) => a - b);

  return {
    optimalLineCount: [
      sortedLines[Math.floor(sortedLines.length * 0.25)] || 4,
      sortedLines[Math.floor(sortedLines.length * 0.75)] || 7,
    ],
    avgEmojiDensity: avg(emojiCounts),
    ctaRate: ctaCount / topQuarter.length,
  };
}

/**
 * 新しいツイートデータを既存インサイトにマージ（指数減衰で鮮度を保持）
 */
export function computeInsights(tweets, existingInsights = null) {
  const DECAY = 0.95;

  const hookPatterns = analyzeHookPatterns(tweets);
  const hashtags = analyzeHashtags(tweets);
  const structure = analyzeStructure(tweets);

  // 重みの正規化（最大を1.0に）
  const maxHookEng = Math.max(...hookPatterns.map(h => h.avgEngagement), 1);
  const normalizedHooks = hookPatterns.map(h => ({
    pattern: h.pattern,
    weight: h.avgEngagement / maxHookEng,
    avgEngagement: h.avgEngagement,
    count: h.count,
    examples: h.examples,
  }));

  const maxTagEng = Math.max(...hashtags.map(h => h.avgEngagement), 1);
  const normalizedTags = hashtags.slice(0, 10).map(h => ({
    tag: h.tag,
    weight: h.avgEngagement / maxTagEng,
    frequency: h.frequency,
    count: h.count,
  }));

  // 既存インサイトとマージ（指数減衰）
  if (existingInsights && existingInsights.topHookPatterns) {
    for (const newH of normalizedHooks) {
      const old = existingInsights.topHookPatterns.find(o => o.pattern === newH.pattern);
      if (old) {
        newH.weight = old.weight * DECAY + newH.weight * (1 - DECAY);
      }
    }
  }

  if (existingInsights && existingInsights.topHashtags) {
    for (const newT of normalizedTags) {
      const old = existingInsights.topHashtags.find(o => o.tag === newT.tag);
      if (old) {
        newT.weight = old.weight * DECAY + newT.weight * (1 - DECAY);
      }
    }
  }

  const existingSampleSize = existingInsights?.sampleSize || 0;

  return {
    version: 1,
    lastUpdated: new Date().toISOString(),
    sampleSize: existingSampleSize + tweets.length,
    topHookPatterns: normalizedHooks,
    topHashtags: normalizedTags,
    structureInsights: structure,
  };
}
