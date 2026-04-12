// 補助金XBot - 週次まとめポスト（スレッド投稿）
// 過去7日間のgit履歴から新規/更新された補助金を集計してスレッド投稿

import { execSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TwitterApi } from 'twitter-api-v2';
import { parseSubsidies, diffSubsidies } from './parse-subsidies.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REPO_ROOT = resolve(__dirname, '..');
// CI ではリサーチリポを /tmp/research-repo にクローンして参照
const RESEARCH_REPO = process.env.RESEARCH_REPO_PATH || '/tmp/research-repo';
const INDEX_PATH = resolve(REPO_ROOT, 'index.html');
const DRY_RUN = process.env.DRY_RUN === '1';
const MAX_ITEMS_IN_THREAD = 8;

function readIndexAtCommit(commitRef) {
  try {
    return execSync(`git show ${commitRef}:index.html`, {
      cwd: RESEARCH_REPO,
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch (e) {
    console.warn(`⚠️ git show ${commitRef}:index.html 失敗:`, e.message);
    return null;
  }
}

/**
 * 7日前のコミットを取得
 */
function getCommitFrom7DaysAgo() {
  try {
    const result = execSync(
      `git rev-list -1 --before="7 days ago" HEAD -- index.html`,
      { cwd: RESEARCH_REPO, encoding: 'utf-8' }
    ).trim();
    return result || null;
  } catch {
    return null;
  }
}

function stripHtml(s) {
  return (s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function truncate(s, n) {
  s = stripHtml(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function tweetDisplayLen(text) {
  const URL_LEN = 23;
  const urls = text.match(/https?:\/\/\S+/g) || [];
  let len = text.length;
  for (const u of urls) len += URL_LEN - u.length;
  return len;
}

function clipToTweet(text) {
  if (tweetDisplayLen(text) <= 280) return text;
  const lines = text.split('\n');
  const urlLineIdx = [...lines].reverse().findIndex(l => /https?:\/\//.test(l));
  const urlIdx = urlLineIdx >= 0 ? lines.length - 1 - urlLineIdx : -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (i === urlIdx) continue;
    if (!lines[i] || lines[i].length < 4) continue;
    while (lines[i].length > 4 && tweetDisplayLen(lines.join('\n')) > 280) {
      lines[i] = lines[i].slice(0, -2) + '…';
      if (lines[i].endsWith('……')) lines[i] = lines[i].slice(0, -1);
    }
    if (tweetDisplayLen(lines.join('\n')) <= 280) return lines.join('\n');
  }
  let out = lines.join('\n');
  while (tweetDisplayLen(out) > 280) out = out.slice(0, -1);
  return out.slice(0, -1) + '…';
}

function formatDate(d) {
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function humanize(s, maxLen = 0) {
  if (!s) return '';
  let t = stripHtml(s);
  t = t.replace(/^(第\d+次)?(公募)?(申請)?(募集)?(受付)?(期間|締切)[:：]\s*/, '');
  t = t.replace(/^(対象|要件|概要|内容|金額|補助額|補助率)[:：]\s*/, '');
  const y = new Date().getFullYear();
  t = t.replace(new RegExp(`${y}年`, 'g'), '');
  t = t.replace(new RegExp(`${y + 1}年`, 'g'), '');
  t = t.replace(/\s+/g, ' ').trim();
  if (maxLen > 0 && t.length > maxLen) t = t.slice(0, maxLen - 1) + '…';
  return t;
}

/**
 * ヘッダーツイート（スレッド先頭・人間っぽい文体）
 */
function buildHeaderTweet(addedCount, updatedCount, dateFrom, dateTo) {
  const lines = [
    `今週の補助金まとめ（${formatDate(dateFrom)}〜${formatDate(dateTo)}）。`,
    ``,
  ];
  if (addedCount > 0 && updatedCount > 0) {
    lines.push(`新規${addedCount}件、更新${updatedCount}件ありました。`);
  } else if (addedCount > 0) {
    lines.push(`新規が${addedCount}件出てきました。`);
  } else {
    lines.push(`今週は新規はなしですが、${updatedCount}件アップデートがあったのでまとめておきます。`);
  }
  lines.push(``, `クリニック開業・個人事業主・中小企業向けの内容を中心にまとめてます。気になるのがあればチェックしてみてください。`);
  return clipToTweet(lines.join('\n'));
}

/**
 * アイテムツイート（返信ツリー・人間っぽい文体）
 */
function buildItemTweet(subsidy, index, total, type) {
  const typeLabel = type === 'new' ? '新着' : '更新';
  const lines = [
    `${index}/${total}（${typeLabel}）`,
    ``,
    subsidy.title,
  ];
  if (subsidy.detail) lines.push(humanize(subsidy.detail, 70));

  const meta = [];
  if (subsidy.amount) meta.push(humanize(subsidy.amount, 50));
  if (subsidy.deadline) meta.push('締切：' + humanize(subsidy.deadline, 45));
  if (meta.length > 0) lines.push(meta.join(' / '));

  if (subsidy.url) {
    lines.push(``);
    lines.push(subsidy.url);
  }
  return clipToTweet(lines.join('\n'));
}

/**
 * フッターツイート（人間っぽい文体）
 */
function buildFooterTweet(reportUrl) {
  const url = reportUrl || 'https://reiyoshimine.github.io/subsidy-research-bot/';
  return clipToTweet(
    [
      `フルリストはこちらで毎日アップデートしてます。`,
      `締切や金額の変更も追っかけてるので、よかったら覗いてみてください。`,
      ``,
      url,
    ].join('\n')
  );
}

function getClient() {
  const { X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET } = process.env;
  if (!X_API_KEY || !X_API_SECRET || !X_ACCESS_TOKEN || !X_ACCESS_SECRET) {
    throw new Error('X API認証情報が環境変数に設定されていません');
  }
  return new TwitterApi({
    appKey: X_API_KEY,
    appSecret: X_API_SECRET,
    accessToken: X_ACCESS_TOKEN,
    accessSecret: X_ACCESS_SECRET,
  });
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log('🤖 補助金XBot - 週次まとめポスト開始');
  console.log(`   DRY_RUN: ${DRY_RUN}`);

  const oldCommit = getCommitFrom7DaysAgo();
  const oldHtml = oldCommit ? readIndexAtCommit(oldCommit) : null;
  const newHtml = await readFile(INDEX_PATH, 'utf-8');

  const newList = parseSubsidies(newHtml);
  const oldList = oldHtml ? parseSubsidies(oldHtml) : [];

  console.log(`   過去7日比較: 旧版${oldList.length}件 → 新版${newList.length}件`);

  const { added, updated } = diffSubsidies(oldList, newList);
  console.log(`   🆕 新規: ${added.length}件 / 📢 更新: ${updated.length}件`);

  if (added.length === 0 && updated.length === 0) {
    console.log('✅ 今週の変更なし。投稿せずに終了します。');
    return;
  }

  const dateTo = new Date();
  const dateFrom = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  // ツイート組み立て
  const allItems = [
    ...added.map(s => ({ subsidy: s, type: 'new' })),
    ...updated.map(s => ({ subsidy: s, type: 'update' })),
  ].slice(0, MAX_ITEMS_IN_THREAD);

  const tweets = [];
  tweets.push(buildHeaderTweet(added.length, updated.length, dateFrom, dateTo));
  allItems.forEach((item, i) => {
    tweets.push(buildItemTweet(item.subsidy, i + 1, allItems.length, item.type));
  });
  tweets.push(buildFooterTweet(process.env.REPORT_URL));

  if (DRY_RUN) {
    console.log('\n=== DRY RUN: スレッド投稿予定 ===\n');
    tweets.forEach((t, i) => {
      console.log(`--- ツイート ${i + 1}/${tweets.length} (${t.length}文字) ---`);
      console.log(t);
      console.log();
    });
    return;
  }

  const client = getClient();
  let lastTweetId = null;
  for (let i = 0; i < tweets.length; i++) {
    try {
      const opts = lastTweetId ? { reply: { in_reply_to_tweet_id: lastTweetId } } : {};
      const res = await client.v2.tweet(tweets[i], opts);
      lastTweetId = res.data.id;
      console.log(`✅ ${i + 1}/${tweets.length} 投稿成功 → tweet ${lastTweetId}`);
    } catch (e) {
      console.error(`❌ ${i + 1}/${tweets.length} 投稿失敗:`, e.message || e);
      // スレッドが途切れたら以降は中止
      break;
    }
    await sleep(2500);
  }

  console.log('🎉 週次まとめスレッド完了');
}

main().catch(e => {
  console.error('💥 致命的エラー:', e);
  process.exit(1);
});
