// 補助金XBot - バズリサーチスクリプト
// X上の補助金関連バズツイートを分析し、投稿改善のインサイトを生成

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TwitterApi } from 'twitter-api-v2';
import { computeInsights, engagementScore } from './analyze-patterns.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REPO_ROOT = resolve(__dirname, '..');
const STATE_DIR = resolve(REPO_ROOT, 'state');
const INSIGHTS_FILE = resolve(STATE_DIR, 'buzz-insights.json');
const REPORTS_FILE = resolve(STATE_DIR, 'research-reports.json');
const COLLECTION_FILE = resolve(STATE_DIR, 'buzz-collection.json');
const SEEDS_FILE = resolve(STATE_DIR, 'buzz-seeds.json');
const HISTORY_FILE = resolve(STATE_DIR, 'history.json');
const DRY_RUN = process.env.DRY_RUN === '1';
const API_TIER = process.env.X_API_TIER || 'free';

// --- ユーティリティ ---

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf-8'));
  } catch {
    return null;
  }
}

async function writeJson(path, data) {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

function getClient() {
  const { X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET } = process.env;
  if (!X_API_KEY || !X_API_SECRET || !X_ACCESS_TOKEN || !X_ACCESS_SECRET) {
    return null;
  }
  return new TwitterApi({
    appKey: X_API_KEY,
    appSecret: X_API_SECRET,
    accessToken: X_ACCESS_TOKEN,
    accessSecret: X_ACCESS_SECRET,
  });
}

// --- データ収集 ---

/**
 * 自アカウントの直近ツイートからメトリクスを取得
 * Free tier でも自分のツイートは取得可能
 */
async function fetchOwnTweets(client) {
  if (!client) return [];
  try {
    // まず自分のユーザーIDを取得
    const me = await client.v2.me();
    const userId = me.data.id;

    const timeline = await client.v2.userTimeline(userId, {
      max_results: 20,
      'tweet.fields': 'public_metrics,created_at',
      exclude: 'retweets,replies',
    });

    const tweets = [];
    for (const tweet of timeline.data?.data || []) {
      const m = tweet.public_metrics || {};
      tweets.push({
        text: tweet.text,
        metrics: {
          likes: m.like_count || 0,
          retweets: m.retweet_count || 0,
          replies: m.reply_count || 0,
        },
        createdAt: tweet.created_at,
        source: 'own',
        tweetId: tweet.id,
      });
    }
    console.log(`   📊 自アカウントから ${tweets.length}件のツイートを取得`);
    return tweets;
  } catch (e) {
    console.warn(`   ⚠️ 自アカウントツイート取得失敗: ${e.message}`);
    return [];
  }
}

/**
 * X Search API で補助金関連のバズツイートを検索（Basic tier以上）
 */
async function searchBuzzTweets(client) {
  if (!client || API_TIER !== 'basic') return [];

  const queries = [
    '補助金 -is:retweet lang:ja',
    '助成金 申請 -is:retweet lang:ja',
  ];

  const allTweets = [];
  for (const query of queries) {
    try {
      const result = await client.v2.search(query, {
        max_results: 50,
        'tweet.fields': 'public_metrics,created_at',
        sort_order: 'relevancy',
      });

      for (const tweet of result.data?.data || []) {
        const m = tweet.public_metrics || {};
        const score = engagementScore({
          likes: m.like_count || 0,
          retweets: m.retweet_count || 0,
          replies: m.reply_count || 0,
        });
        // バズ閾値: エンゲージメントスコア20以上
        if (score >= 20) {
          allTweets.push({
            text: tweet.text,
            metrics: {
              likes: m.like_count || 0,
              retweets: m.retweet_count || 0,
              replies: m.reply_count || 0,
            },
            createdAt: tweet.created_at,
            source: 'search',
            tweetId: tweet.id,
          });
        }
      }
    } catch (e) {
      console.warn(`   ⚠️ Search API失敗 (${query}): ${e.message}`);
    }
  }
  console.log(`   🔍 Search APIから ${allTweets.length}件のバズツイートを取得`);
  return allTweets;
}

/**
 * 手動シードデータを読み込み
 */
async function loadSeeds() {
  const seeds = await readJson(SEEDS_FILE);
  if (!seeds || !Array.isArray(seeds)) return [];
  console.log(`   📋 シードデータから ${seeds.length}件を読み込み`);
  return seeds;
}

/**
 * 自分の投稿履歴からデータを読み込み
 */
async function loadOwnHistory() {
  const history = await readJson(HISTORY_FILE);
  if (!history || !Array.isArray(history)) return [];
  // history.json にはメトリクスがないので、シードと同形式に変換
  // メトリクスは API から取得したデータでマージされる
  return history.map(h => ({
    text: h.text,
    metrics: h.metrics || { likes: 0, retweets: 0, replies: 0 },
    createdAt: h.postedAt || h.date,
    source: 'history',
    tweetId: h.tweetId,
  }));
}

/**
 * 自アカウントのメトリクスを履歴データにマージ
 */
function mergeOwnMetrics(historyTweets, apiTweets) {
  const apiMap = new Map(apiTweets.map(t => [t.tweetId, t]));
  for (const h of historyTweets) {
    if (h.tweetId && apiMap.has(h.tweetId)) {
      h.metrics = apiMap.get(h.tweetId).metrics;
      h.source = 'own_with_metrics';
    }
  }
  return historyTweets;
}

/**
 * 分析結果の要約文を生成
 */
function buildReportSummary(insights) {
  const hooks = insights.topHookPatterns || [];
  const tags = insights.topHashtags || [];

  const PATTERN_LABELS = {
    urgency: '締切カウントダウン系',
    amount: '金額インパクト系',
    loss_aversion: '損失回避系（「知らないと損」）',
    question: '疑問形フック',
    novelty: '新着告知系',
    sharing: '共有・紹介系',
    other: 'その他',
  };

  const lines = [];
  if (hooks.length > 0) {
    const top = hooks[0];
    lines.push(`最も効果的なフック: ${PATTERN_LABELS[top.pattern] || top.pattern}（重み${top.weight.toFixed(2)}）`);
  }
  if (hooks.length >= 2) {
    const second = hooks[1];
    lines.push(`2位: ${PATTERN_LABELS[second.pattern] || second.pattern}（重み${second.weight.toFixed(2)}）`);
  }
  if (tags.length > 0) {
    const topTags = tags.slice(0, 3).map(t => t.tag).join(' ');
    lines.push(`推奨ハッシュタグ: ${topTags}`);
  }
  if (insights.ownPerformance) {
    lines.push(`自アカウント平均いいね: ${insights.ownPerformance.avgLikes}`);
  }
  return lines.join('。');
}

// --- メイン ---

async function main() {
  console.log('🔬 補助金XBot - バズリサーチ開始');
  console.log(`   DRY_RUN: ${DRY_RUN}`);
  console.log(`   API_TIER: ${API_TIER}`);

  const client = getClient();

  // データ収集
  const [seeds, ownTweetsApi, searchTweets, historyTweets] = await Promise.all([
    loadSeeds(),
    fetchOwnTweets(client),
    searchBuzzTweets(client),
    loadOwnHistory(),
  ]);

  // 自分の履歴にAPIメトリクスをマージ
  const mergedHistory = mergeOwnMetrics(historyTweets, ownTweetsApi);

  // 全データを統合（重複排除はtweetIdベース）
  const allTweets = [];
  const seen = new Set();

  for (const t of [...ownTweetsApi, ...searchTweets, ...seeds, ...mergedHistory]) {
    const key = t.tweetId || t.text?.slice(0, 50);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    allTweets.push(t);
  }

  console.log(`   📦 分析対象: 計${allTweets.length}件`);
  console.log(`      内訳: シード${seeds.length} / API自ツイート${ownTweetsApi.length} / 検索${searchTweets.length} / 履歴${mergedHistory.length}`);

  if (allTweets.length === 0) {
    console.log('⚠️ 分析対象がありません。buzz-seeds.json にデータを追加してください。');
    return;
  }

  // 既存インサイトを読み込み
  const existingInsights = await readJson(INSIGHTS_FILE);

  // 分析実行
  const insights = computeInsights(allTweets, existingInsights);

  // 自アカウントのパフォーマンスサマリーを追加
  const ownWithMetrics = ownTweetsApi.filter(t => t.metrics.likes > 0);
  if (ownWithMetrics.length > 0) {
    const best = ownWithMetrics.sort((a, b) => engagementScore(b.metrics) - engagementScore(a.metrics))[0];
    const avgLikes = ownWithMetrics.reduce((s, t) => s + t.metrics.likes, 0) / ownWithMetrics.length;
    insights.ownPerformance = {
      bestTweetId: best.tweetId,
      bestTweetLikes: best.metrics.likes,
      avgLikes: Math.round(avgLikes * 10) / 10,
      analyzedCount: ownWithMetrics.length,
    };
  }

  // 結果表示
  console.log('\n=== 分析結果 ===\n');
  console.log('📈 フックパターン（効果順）:');
  for (const h of insights.topHookPatterns.slice(0, 5)) {
    console.log(`   ${h.pattern}: weight=${h.weight.toFixed(2)} (${h.count}件)`);
    if (h.examples?.[0]) console.log(`      例: ${h.examples[0].slice(0, 50)}`);
  }

  console.log('\n#️⃣ ハッシュタグ（効果順）:');
  for (const t of insights.topHashtags.slice(0, 5)) {
    console.log(`   ${t.tag}: weight=${t.weight.toFixed(2)} (${t.count}件)`);
  }

  console.log('\n📐 構造:');
  console.log(`   最適行数: ${insights.structureInsights.optimalLineCount[0]}〜${insights.structureInsights.optimalLineCount[1]}行`);
  console.log(`   CTA含有率: ${(insights.structureInsights.ctaRate * 100).toFixed(0)}%`);

  if (insights.ownPerformance) {
    console.log('\n🤖 自アカウント:');
    console.log(`   平均いいね: ${insights.ownPerformance.avgLikes}`);
    console.log(`   ベストツイート: ${insights.ownPerformance.bestTweetLikes}いいね`);
  }

  if (DRY_RUN) {
    console.log('\n=== DRY RUN: 保存せずに終了 ===');
    return;
  }

  // 保存
  await writeJson(INSIGHTS_FILE, insights);
  console.log(`\n💾 インサイト保存: ${INSIGHTS_FILE}`);

  // レポート蓄積
  const report = {
    date: new Date().toISOString(),
    sources: {
      seeds: seeds.length,
      ownApi: ownTweetsApi.length,
      search: searchTweets.length,
      history: mergedHistory.length,
      total: allTweets.length,
    },
    hookRanking: insights.topHookPatterns.slice(0, 5).map(h => ({
      pattern: h.pattern,
      weight: Math.round(h.weight * 100) / 100,
      count: h.count,
      example: h.examples?.[0]?.slice(0, 60) || '',
    })),
    topHashtags: insights.topHashtags.slice(0, 5).map(t => ({
      tag: t.tag,
      weight: Math.round(t.weight * 100) / 100,
    })),
    structure: {
      optimalLines: insights.structureInsights.optimalLineCount,
      ctaRate: Math.round(insights.structureInsights.ctaRate * 100),
    },
    ownPerformance: insights.ownPerformance || null,
    summary: buildReportSummary(insights),
  };
  const reports = (await readJson(REPORTS_FILE)) || [];
  reports.push(report);
  await writeJson(REPORTS_FILE, reports);
  console.log(`📜 レポート保存: ${REPORTS_FILE} (計${reports.length}件)`);

  // バズツイート コレクション蓄積（毎回トップ5を保存）
  const ranked = allTweets
    .filter(t => t.text && t.metrics)
    .map(t => ({ ...t, score: engagementScore(t.metrics) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  if (ranked.length > 0) {
    const collection = (await readJson(COLLECTION_FILE)) || [];
    const existingTexts = new Set(collection.map(c => c.text?.slice(0, 50)));
    const batch = {
      collectedAt: new Date().toISOString(),
      tweets: ranked.map(t => ({
        text: t.text,
        source: t.source,
        score: t.score,
        metrics: t.metrics,
        tweetId: t.tweetId || null,
        createdAt: t.createdAt || null,
      })),
    };
    // 重複テキストは除外しつつバッチ追加
    batch.tweets = batch.tweets.filter(t => !existingTexts.has(t.text?.slice(0, 50)));
    if (batch.tweets.length > 0) {
      collection.push(batch);
      // 最大50バッチ（250ツイート相当）を保持
      while (collection.length > 50) collection.shift();
      await writeJson(COLLECTION_FILE, collection);
      console.log(`🏆 バズコレクション保存: ${batch.tweets.length}件追加 (累計${collection.length}バッチ)`);
    } else {
      console.log('🏆 バズコレクション: 新規ツイートなし');
    }
  }

  console.log('🎉 バズリサーチ完了');
}

main().catch(e => {
  console.error('💥 致命的エラー:', e);
  process.exit(1);
});
