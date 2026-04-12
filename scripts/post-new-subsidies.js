// 補助金XBot - 新規/更新ポスト
// git diff から index.html の旧版と新版を取得し、新規/更新を検出して X に投稿

import { execSync, execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TwitterApi } from 'twitter-api-v2';
import { parseSubsidies, diffSubsidies } from './parse-subsidies.js';
import {
  buildAmountHooks, buildHooks, CLOSING_LINES,
  buildNewOpeners, buildUpdateOpeners,
  applyInsightsToHooks, getInsightHashtags,
} from './tweet-templates.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REPO_ROOT = resolve(__dirname, '..');
// CI ではリサーチリポを /tmp/research-repo にクローンして参照
const RESEARCH_REPO = process.env.RESEARCH_REPO_PATH || '/tmp/research-repo';
const INDEX_PATH = resolve(REPO_ROOT, 'index.html');
const STATE_DIR = resolve(REPO_ROOT, 'state');
const STATE_FILE = resolve(STATE_DIR, 'posted.json');
const HISTORY_FILE = resolve(STATE_DIR, 'history.json');
const INSIGHTS_FILE = resolve(STATE_DIR, 'buzz-insights.json');
const DRAFT_FILE = resolve(STATE_DIR, 'claude-draft.json');
const GENERATE_SCRIPT = resolve(__dirname, 'generate-tweet.js');
const DRY_RUN = process.env.DRY_RUN === '1';
const FORCE_DAILY_PICK = process.env.FORCE_DAILY_PICK === '1';
const FORCE_POST = process.env.FORCE_POST === '1'; // 同日重複ガードを無視（テスト用）

/**
 * 文字列ハッシュ（バリエーション選択用）
 */
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/**
 * subsidy.id + 当日 で配列から1要素を選ぶ
 * → 同じ補助金でも日が変われば違う表現、同じ日でも補助金が違えば違う表現になる
 */
function pickVariant(arr, key = '') {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((now - start) / (1000 * 60 * 60 * 24));
  const idx = hashStr(key + ':' + dayOfYear) % arr.length;
  return arr[idx];
}

/**
 * 日本標準時の YYYY-MM-DD を取得
 */
function todayJST() {
  const now = new Date();
  const jstMs = now.getTime() + (9 * 60 - now.getTimezoneOffset()) * 60 * 1000;
  return new Date(jstMs).toISOString().slice(0, 10);
}

async function readState() {
  try {
    const content = await readFile(STATE_FILE, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

async function writeStateFile(state) {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

async function readHistory() {
  try {
    const content = await readFile(HISTORY_FILE, 'utf-8');
    return JSON.parse(content);
  } catch {
    return [];
  }
}

async function appendHistory(entry) {
  const history = await readHistory();
  history.push(entry);
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(HISTORY_FILE, JSON.stringify(history, null, 2) + '\n', 'utf-8');
}

/**
 * git から指定コミットの index.html を取得
 */
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
 * 直前にindex.htmlを変更したコミットを取得
 * （HEAD直前の親コミットではなく、index.htmlを実際に編集した最後のコミットの1つ前）
 */
function getPreviousIndexCommit() {
  try {
    const commits = execSync(
      'git log -3 --pretty=format:%H -- index.html',
      { cwd: RESEARCH_REPO, encoding: 'utf-8' }
    ).trim().split('\n').filter(Boolean);
    if (commits.length >= 2) return commits[1];
    if (commits.length === 1) return `${commits[0]}^`;
    return 'HEAD~1';
  } catch {
    return 'HEAD~1';
  }
}

/**
 * amount文字列から代表金額を抽出（「1億円」「4,000万円」「200万円」など）
 */
function extractAmountValue(s) {
  if (!s) return null;
  const t = stripHtml(s).replace(/\s+/g, '');
  // 「1億円」「1.5億円」
  let m = t.match(/(\d+(?:\.\d+)?)億円/);
  if (m) return `${m[1]}億円`;
  // 「4,000万円」「450万円」「50万円」（最大値を採用）
  const all = [...t.matchAll(/(\d+(?:,\d+)?)万円/g)];
  if (all.length === 0) return null;
  const nums = all.map(x => parseInt(x[1].replace(/,/g, ''), 10));
  const max = Math.max(...nums);
  return max >= 1000 ? `${max.toLocaleString()}万円` : `${max}万円`;
}


/**
 * フィールド文字列から「○○:」「○○：」のラベルや今年の年表記を取り除いて読みやすくする
 */
function humanize(s, maxLen = 0) {
  if (!s) return '';
  let t = stripHtml(s);
  t = t.replace(/^(第\d+次)?(公募)?(申請)?(募集)?(受付)?(期間|締切)[:：]\s*/, '');
  t = t.replace(/^(対象|要件|概要|内容|金額|補助額|補助率)[:：]\s*/, '');
  // 今年/来年の「YYYY年」表記は冗長なので削除
  const y = new Date().getFullYear();
  t = t.replace(new RegExp(`${y}年`, 'g'), '');
  t = t.replace(new RegExp(`${y + 1}年`, 'g'), '');
  // 全角スペースの連続を1つに
  t = t.replace(/\s+/g, ' ').trim();
  if (maxLen > 0 && t.length > maxLen) {
    t = t.slice(0, maxLen - 1) + '…';
  }
  return t;
}

/**
 * 新規補助金のポスト本文を生成（フック先頭の人間風文体）
 */
function buildNewPost(subsidy, insights) {
  const days = parseDeadlineDays(subsidy.deadline);
  const amt = extractAmountValue(subsidy.amount);
  const amtHooks = buildAmountHooks(amt);
  const rawOpeners = [
    ...buildHooks(subsidy, days, amt, amtHooks, stripHtml),
    ...buildNewOpeners(amt),
  ];
  const allOpeners = applyInsightsToHooks(rawOpeners, insights);
  const opener = pickVariant(allOpeners, subsidy.id + ':new');
  const closing = pickVariant(CLOSING_LINES, subsidy.id + ':close-new');

  const lines = [opener, '', subsidy.title];
  // 金額を本文の目立つ位置に必ず配置（タイトル直下）
  if (subsidy.amount) lines.push(humanize(subsidy.amount, 50));
  // URL付きの場合はdetailを省略（X スパムフィルター対策: 長文+URL で403になる）
  if (subsidy.detail && !subsidy.url) lines.push(humanize(subsidy.detail, 60));
  if (subsidy.deadline) lines.push('締切：' + humanize(subsidy.deadline, 40));

  lines.push('', closing);
  if (subsidy.url) lines.push(subsidy.url);

  return clipToTweet(lines.join('\n'));
}

/**
 * 締切文字列から残り日数を推定（YYYY-MM-DD / YYYY年MM月DD日 など対応）
 */
function parseDeadlineDays(deadlineStr) {
  if (!deadlineStr) return null;
  const s = stripHtml(deadlineStr);
  // 通年・常時受付などはスキップ
  if (/通年|随時|常時|未定|終了/.test(s)) return null;

  // YYYY年MM月DD日 / YYYY/MM/DD / YYYY-MM-DD を抽出
  const patterns = [
    /(\d{4})[年\/\-](\d{1,2})[月\/\-](\d{1,2})/,
    /(\d{1,2})[月\/\-](\d{1,2})日?/,
  ];
  let dt = null;
  let m = s.match(patterns[0]);
  if (m) {
    dt = new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
  } else {
    m = s.match(patterns[1]);
    if (m) {
      const now = new Date();
      let year = now.getFullYear();
      const cand = new Date(year, parseInt(m[1]) - 1, parseInt(m[2]));
      if (cand < now) cand.setFullYear(year + 1);
      dt = cand;
    }
  }
  if (!dt || isNaN(dt.getTime())) return null;
  const diffMs = dt.getTime() - Date.now();
  return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
}

/**
 * 「今日のピックアップ」候補から1件を選ぶ（日替わりローテーション）
 */
function pickDailySubsidy(subsidies) {
  const candidates = subsidies
    .filter(s => !s.isClosed)
    .map(s => ({ ...s, _days: parseDeadlineDays(s.deadline) }))
    .filter(s => s._days === null || (s._days >= 0 && s._days <= 90));

  if (candidates.length === 0) return null;

  // 締切が近いもの優先（締切日不明は後ろ）、推奨ランクS/A優先
  const rankScore = { S: 0, A: 1, B: 2, C: 3, D: 4 };
  candidates.sort((a, b) => {
    const da = a._days === null ? 9999 : a._days;
    const db = b._days === null ? 9999 : b._days;
    if (da !== db) return da - db;
    return (rankScore[a.rank] ?? 5) - (rankScore[b.rank] ?? 5);
  });

  // 上位10件から、今日の day-of-year でローテーション選出
  const top = candidates.slice(0, Math.min(10, candidates.length));
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((now - start) / (1000 * 60 * 60 * 24));
  return top[dayOfYear % top.length];
}

/**
 * 「今日のピックアップ」ポスト本文（フック先頭の人間風文体）
 */
function buildDailyPickPost(subsidy, insights) {
  const days = parseDeadlineDays(subsidy.deadline);
  const amt = extractAmountValue(subsidy.amount);
  const amtHooks = buildAmountHooks(amt);
  const rawHooks = buildHooks(subsidy, days, amt, amtHooks, stripHtml);
  const opener = pickVariant(applyInsightsToHooks(rawHooks, insights), subsidy.id + ':daily');
  const closing = pickVariant(CLOSING_LINES, subsidy.id + ':close-daily');

  const lines = [opener, '', subsidy.title];
  // 金額を本文の目立つ位置に必ず配置（タイトル直下）
  if (subsidy.amount) lines.push(humanize(subsidy.amount, 50));
  // URL付きの場合はdetailを省略（X スパムフィルター対策）
  if (subsidy.detail && !subsidy.url) lines.push(humanize(subsidy.detail, 60));
  if (subsidy.deadline) lines.push('締切：' + humanize(subsidy.deadline, 40));

  lines.push('', closing);
  if (subsidy.url) lines.push(subsidy.url);

  return clipToTweet(lines.join('\n'));
}

/**
 * 更新ポストの本文を生成（人間風文体・追記アナウンス）
 */
function buildUpdatePost(subsidy) {
  const deadlineChanged = subsidy.oldDeadline && subsidy.oldDeadline !== subsidy.deadline;
  const amountChanged = subsidy.oldAmount && subsidy.oldAmount !== subsidy.amount;

  const openers = buildUpdateOpeners(deadlineChanged, amountChanged);
  const opener = pickVariant(openers, subsidy.id + ':update');
  const closing = pickVariant(CLOSING_LINES, subsidy.id + ':close-update');

  const lines = [opener, '', subsidy.title];

  // 更新内容に関わらず、金額は必ず目立つ位置に表示
  if (subsidy.amount) lines.push(humanize(subsidy.amount, 50));

  if (deadlineChanged) lines.push('新しい締切：' + humanize(subsidy.deadline, 40));
  else if (subsidy.deadline) lines.push('締切：' + humanize(subsidy.deadline, 40));

  // 内容更新のみの場合は detail も追加（URL付きの場合は省略: X スパムフィルター対策）
  if (!deadlineChanged && !amountChanged && subsidy.detail && !subsidy.url) {
    lines.push(humanize(subsidy.detail, 60));
  }

  lines.push('', closing);
  if (subsidy.url) lines.push(subsidy.url);

  return clipToTweet(lines.join('\n'));
}

function stripHtml(s) {
  return (s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function truncate(s, n) {
  s = stripHtml(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/**
 * 280文字以内に収める（URLは t.co で23文字換算）
 */
function tweetDisplayLen(text) {
  const URL_LEN = 23;
  const urlRegex = /https?:\/\/\S+/g;
  const urls = text.match(urlRegex) || [];
  let len = text.length;
  for (const u of urls) len += URL_LEN - u.length;
  return len;
}

function clipToTweet(text) {
  if (tweetDisplayLen(text) <= 280) return text;

  const lines = text.split('\n');
  // URL行を特定（最後の URL を含む行）
  const urlLineIdx = [...lines].reverse().findIndex(l => /https?:\/\//.test(l));
  const urlIdx = urlLineIdx >= 0 ? lines.length - 1 - urlLineIdx : -1;

  // 候補となる本文行（タイトル以外、URL以外、空行以外）を後ろから順に削っていく
  for (let i = lines.length - 1; i >= 0; i--) {
    if (i === urlIdx) continue;
    if (!lines[i] || lines[i].length < 4) continue;
    while (lines[i].length > 4 && tweetDisplayLen(lines.join('\n')) > 280) {
      lines[i] = lines[i].slice(0, -2) + '…';
      if (lines[i].endsWith('……')) lines[i] = lines[i].slice(0, -1);
    }
    if (tweetDisplayLen(lines.join('\n')) <= 280) return lines.join('\n');
  }

  // 最終手段：末尾切り
  let out = lines.join('\n');
  while (tweetDisplayLen(out) > 280) out = out.slice(0, -1);
  return out.slice(0, -1) + '…';
}

/**
 * X APIクライアント初期化
 */
function getClient() {
  const { X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET } = process.env;
  if (!X_API_KEY || !X_API_SECRET || !X_ACCESS_TOKEN || !X_ACCESS_SECRET) {
    throw new Error('X API認証情報が環境変数に設定されていません (X_API_KEY/X_API_SECRET/X_ACCESS_TOKEN/X_ACCESS_SECRET)');
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

/**
 * 候補ポストにスコアをつける（高いほど優先）
 */
function scorePost(p) {
  let score = 0;
  // タイプ別ベース
  if (p.type === 'new') score += 50;
  else if (p.type === 'update') score += 25;
  else if (p.type === 'daily') score += 10;

  // 締切までの日数
  const days = parseDeadlineDays(p.subsidy.deadline);
  if (days !== null && days >= 0) {
    if (days <= 3) score += 100;
    else if (days <= 7) score += 60;
    else if (days <= 14) score += 35;
    else if (days <= 30) score += 15;
    else if (days <= 60) score += 5;
  }

  // 推奨ランク
  const rankScore = { S: 30, A: 20, B: 10, C: 5, D: 0 };
  score += rankScore[p.subsidy.rank] ?? 0;

  // 更新で締切や金額が変わった場合は加点
  if (p.type === 'update') {
    if (p.subsidy.oldDeadline && p.subsidy.oldDeadline !== p.subsidy.deadline) score += 25;
    if (p.subsidy.oldAmount && p.subsidy.oldAmount !== p.subsidy.amount) score += 20;
  }

  return score;
}

async function main() {
  console.log('🤖 補助金XBot - 新規/更新ポスト開始');
  console.log(`   DRY_RUN: ${DRY_RUN}`);

  // 同日内重複ガード（DRY_RUN/FORCE_POST/FORCE_DAILY_PICK 時はスキップ）
  const today = todayJST();
  if (!DRY_RUN && !FORCE_POST && !FORCE_DAILY_PICK) {
    const state = await readState();
    if (state && state.lastDate === today) {
      console.log(`✅ 本日(${today})はすでに投稿済み: ${state.lastSubsidyId} (${state.lastType})`);
      console.log('   1日1投稿のため、今回の実行はスキップします。');
      return;
    }
  }

  // バズインサイトを読み込み（なければ null で動作に影響なし）
  let insights = null;
  try {
    const raw = await readFile(INSIGHTS_FILE, 'utf-8');
    insights = JSON.parse(raw);
    console.log(`   🔬 バズインサイト読み込み済み (サンプル数: ${insights.sampleSize || 0})`);
  } catch {
    console.log('   🔬 バズインサイトなし（通常モードで動作）');
  }

  // 旧版（直前のindex.html変更コミット）と新版（現在のindex.html）を比較
  const newHtml = await readFile(INDEX_PATH, 'utf-8');
  const newList = parseSubsidies(newHtml);

  let added = [], updated = [];
  if (FORCE_DAILY_PICK) {
    console.log('   FORCE_DAILY_PICK=1 → diffをスキップして今日のピックアップを生成');
  } else {
    const prevCommit = getPreviousIndexCommit();
    console.log(`   前回index.html更新コミット: ${prevCommit}`);
    const oldHtml = readIndexAtCommit(prevCommit);
    const oldList = oldHtml ? parseSubsidies(oldHtml) : [];
    console.log(`   旧版: ${oldList.length}件 / 新版: ${newList.length}件`);
    ({ added, updated } = diffSubsidies(oldList, newList));
  }
  console.log(`   🆕 新規: ${added.length}件 / 📢 更新: ${updated.length}件`);

  // 候補プール（新規 + 更新 + 日次ピックアップ）
  const candidates = [];
  for (const s of added) candidates.push({ type: 'new', subsidy: s });
  for (const s of updated) candidates.push({ type: 'update', subsidy: s });
  if (candidates.length === 0) {
    const pick = pickDailySubsidy(newList);
    if (pick) {
      console.log('   新規/更新なし → 今日のピックアップから生成');
      candidates.push({ type: 'daily', subsidy: pick });
    } else {
      console.log('✅ ピックアップ候補もなし。終了します。');
      return;
    }
  }

  // スコア順にソートして1件だけ選ぶ
  candidates.sort((a, b) => scorePost(b) - scorePost(a));
  if (candidates.length > 1) {
    console.log(`   📋 ${candidates.length}件の候補からスコア最上位を1件選出:`);
    for (const c of candidates.slice(0, 5)) {
      console.log(`      [${c.type}] score=${scorePost(c)} ${c.subsidy.title}`);
    }
  }
  const best = candidates[0];

  console.log(`\n👉 投稿対象: [${best.type}] ${best.subsidy.title}`);

  // Claude AI でバズ文章を生成（失敗時はテンプレートにフォールバック）
  let text = null;
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      console.log('   🧠 Claude AI でツイート生成中...');
      const input = JSON.stringify({ type: best.type, subsidy: best.subsidy });
      execFileSync('node', [GENERATE_SCRIPT, input], {
        encoding: 'utf-8',
        timeout: 30_000,
        env: { ...process.env },
        stdio: ['pipe', 'inherit', 'inherit'],
      });
      const draft = JSON.parse(await readFile(DRAFT_FILE, 'utf-8'));
      if (draft.text && tweetDisplayLen(draft.text) <= 280) {
        text = draft.text;
        console.log('   ✅ Claude AI 生成テキスト採用');
      }
    } catch (e) {
      console.log(`   ⚠️ Claude AI 生成失敗（テンプレートにフォールバック）: ${e.message || 'exit code ' + e.status}`);
    }
  } else {
    console.log('   🧠 ANTHROPIC_API_KEY 未設定 → テンプレートモードで動作');
  }

  // テンプレートフォールバック
  if (!text) {
    if (best.type === 'new') text = buildNewPost(best.subsidy, insights);
    else if (best.type === 'update') text = buildUpdatePost(best.subsidy);
    else text = buildDailyPickPost(best.subsidy, insights);
  }

  if (DRY_RUN) {
    console.log('\n=== DRY RUN: 投稿予定の内容 ===\n');
    console.log(text);
    console.log(`\n(${text.length}文字)\n`);
    return;
  }

  const client = getClient();

  // 投稿試行（403時はテキストを変えてリトライ）
  const MAX_RETRY = 3;
  let tweetId = null;
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    try {
      const res = await client.v2.tweet(text);
      tweetId = res.data.id;
      console.log(`✅ 投稿成功: ${best.subsidy.title} → tweet ${tweetId}`);
      break;
    } catch (e) {
      lastError = e;
      const code = e.code || e.status || (e.data && e.data.status);
      console.error(`❌ 投稿失敗 (試行${attempt}/${MAX_RETRY}): code=${code} ${e.message || ''}`);

      if (code === 403 && attempt < MAX_RETRY) {
        console.log(`   🔄 403リジェクト → 別のテキストで再試行...`);
        const prevFirstLine = text.split('\n')[0];

        if (process.env.ANTHROPIC_API_KEY) {
          // Claudeに完全に別の文章を生成させる（URLなし）
          try {
            const input = JSON.stringify({
              type: best.type,
              subsidy: best.subsidy,
              noUrl: true,
              retryHint: `前回「${prevFirstLine}」で投稿がXに拒否された（重複判定）。以下を守れ：\n- 完全に違うフック（1行目）にしろ。前回と1文字も被るな\n- 文章の構成・順番も変えろ\n- URLは絶対に入れるな\n- 前回と同じ補助金名の表記も避けろ（略称や別の言い方にしろ）`,
            });
            execFileSync('node', [GENERATE_SCRIPT, input], {
              encoding: 'utf-8',
              timeout: 30_000,
              env: { ...process.env },
              stdio: ['pipe', 'inherit', 'inherit'],
            });
            const draft = JSON.parse(await readFile(DRAFT_FILE, 'utf-8'));
            if (draft.text && tweetDisplayLen(draft.text) <= 280) {
              text = draft.text;
              console.log(`   🧠 Claude再生成テキスト採用 (attempt ${attempt + 1})`);
              continue;
            }
          } catch {
            console.log(`   ⚠️ Claude再生成失敗`);
          }
        }

        // テンプレートフォールバック（URLなし）
        if (best.type === 'new') text = buildNewPost(best.subsidy, insights);
        else if (best.type === 'update') text = buildUpdatePost(best.subsidy);
        else text = buildDailyPickPost(best.subsidy, insights);
        text = text.replace(/\nhttps?:\/\/\S+/g, '');
        text = clipToTweet(text);
        console.log(`   📝 テンプレートフォールバック (attempt ${attempt + 1})`);
        continue;
      }

      // 403以外 or リトライ上限 → 失敗終了
      if (e.data) console.error('API response data:', JSON.stringify(e.data, null, 2));
      if (e.rateLimit) console.error('Rate limit:', JSON.stringify(e.rateLimit, null, 2));
      try { console.error('Full error:', JSON.stringify(e, null, 2)); } catch {}
      process.exit(1);
    }
  }

  if (!tweetId) {
    console.error('❌ 全リトライ失敗');
    try { console.error('Last error:', JSON.stringify(lastError, null, 2)); } catch {}
    process.exit(1);
  }

  // 状態ファイル更新
  await writeStateFile({
    lastDate: today,
    lastSubsidyId: best.subsidy.id,
    lastType: best.type,
    lastTitle: best.subsidy.title,
    lastTweetId: tweetId,
    lastPostedAt: new Date().toISOString(),
  });
  console.log(`💾 状態ファイル更新: ${STATE_FILE}`);

  // 投稿履歴に追加
  await appendHistory({
    date: today,
    type: best.type,
    title: best.subsidy.title,
    text,
    tweetId,
    postedAt: new Date().toISOString(),
  });
  console.log(`📜 履歴ファイル更新: ${HISTORY_FILE}`);

  console.log('🎉 完了');
}

main().catch(e => {
  console.error('💥 致命的エラー:', e);
  process.exit(1);
});
