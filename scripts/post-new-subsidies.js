// 補助金XBot - 新規/更新ポスト
// git diff から index.html の旧版と新版を取得し、新規/更新を検出して X に投稿

import { execSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
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
const STATE_DIR = resolve(REPO_ROOT, 'state');
const STATE_FILE = resolve(STATE_DIR, 'posted.json');
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
 * 金額を中心に据えたフック候補（amtがあれば必ず使える）
 */
function buildAmountHooks(amt) {
  if (!amt) return [];
  return [
    `上限${amt}まで補助される制度、案外知らない人多い。`,
    `${amt}まで補助される補助金、知ってましたか？`,
    `補助上限${amt}。これ知らないと普通に損してるやつ。`,
    `${amt}補助される制度って、ちゃんと存在してます。`,
    `${amt}までもらえる補助金。「自費でやろう」としてた人、ちょっと待って。`,
    `補助上限${amt}の制度、対象なら絶対使った方がいい。`,
    `${amt}補助って聞くと、ちょっと身を乗り出すよね。`,
    `「補助上限${amt}」の制度、知ってる人だけ得してる。`,
    `${amt}って、知らないだけで諦めるには大きすぎる金額。`,
    `補助の上限が${amt}。対象なら使わない手がない。`,
  ];
}

/**
 * 補助金の属性からフック文（1行目）の候補リストを生成
 * 同じカテゴリでも10〜15個用意し、毎回違う表現になるようにする
 */
function buildHooks(subsidy, days) {
  const amt = extractAmountValue(subsidy.amount);
  const amtHooks = buildAmountHooks(amt);
  // 緊急（締切3日以内）— 緊急性を最優先しつつ、金額入りも混ぜる
  if (days !== null && days >= 0 && days <= 3) {
    const urgent = [
      `あと${days}日で締切。これ知らない人、今すぐ動かないとマジで終わる。`,
      `${days}日後が締切。本気で出すなら今日からじゃないと厳しい。`,
      `気づいたら締切まで${days}日しかない。これは急がないとアウト。`,
      `締切まで残り${days}日。準備期間ほぼゼロ、即決推奨。`,
      `あと${days}日。「やろうかな」って迷ってる時間ないやつ。`,
      `カウントダウン${days}日。動くか諦めるか、決めるなら今。`,
      `もう${days}日切ってる。これ気づいてない人、絶対損してる。`,
      `締切${days}日前。最後のチャンス、ほんとに最後。`,
    ];
    if (amt) {
      urgent.push(
        `補助上限${amt}なのに、あと${days}日で締切。これ気づいてない人多すぎ。`,
        `${amt}まで補助される補助金が、あと${days}日で締切。動くなら今。`,
        `${amt}もらえる制度の締切が${days}日後。気づいた人が勝ち。`,
      );
    }
    return urgent;
  }
  // 緊急（締切1週間以内）
  if (days !== null && days >= 0 && days <= 7) {
    const urgent = [
      `あと${days}日で締切。これ知らないままだと損するやつ。`,
      `締切まで残り${days}日。出すならもう動かないと間に合わない。`,
      `${days}日後が締切なので急ぎでシェアしておきます。`,
      `気づいたら締切まで一週間切ってる補助金。`,
      `あと${days}日で締切。準備に最低1週間はかかるから、ほぼギリギリ。`,
      `締切が${days}日後。「やってみよう」を今日中に決めないと厳しい。`,
      `あと${days}日。これ申請したい人、今夜から動き始めるくらいでちょうど。`,
      `気づくと締切まで${days}日。これは急ぎ案件として共有。`,
    ];
    if (amt) {
      urgent.push(
        `${amt}補助される制度、締切まであと${days}日。動くなら今週中。`,
        `補助上限${amt}の補助金、締切${days}日前。これは知らないと損。`,
        `${amt}まで出る補助金が、あと${days}日で締切。気づいた人が勝つやつ。`,
        `${amt}補助。締切まで${days}日しかないので、対象なら即動いて。`,
      );
    }
    return urgent;
  }
  // 締切3週間以内
  if (days !== null && days >= 0 && days <= 21) {
    const urgent = [
      `締切まで残り${days}日。今から動けばまだ間に合う補助金。`,
      `申請期限まで${days}日。準備に2週間は必要だから、ほぼ最後のチャンス。`,
      `あと${days}日で締切。スピード勝負だけど対象なら絶対やった方がいい。`,
      `気づいたらあと${days}日。出せる人は早めに動いた方がいいやつ。`,
      `締切が${days}日後。「やってみるか」迷ってる人、迷う時間がもう少ない。`,
      `締切まで残り${days}日の補助金、対象に当てはまる人いたらシェア。`,
      `あと${days}日で締切。これ準備期間考えると、来週には動き始めたい。`,
      `${days}日後が締切。早めに知ってる人ほど得するやつ。`,
    ];
    if (amt) {
      urgent.push(
        `補助上限${amt}の制度、締切まであと${days}日。これは見逃したくない。`,
        `${amt}まで補助される補助金、締切${days}日前。準備するなら今週から。`,
        `${amt}補助の制度、締切${days}日後。今から動けばまだ間に合う。`,
        `${amt}って大きい金額だけど、あと${days}日で締切。動くか今決めて。`,
      );
    }
    return urgent;
  }
  // 金額が大きい（1億円系）
  const amountStr = stripHtml(subsidy.amount || '');
  const hasOku = /1億|億円/.test(amountStr);
  const hasBig = /[3-9],?000万|1,?\d{3}万/.test(amountStr);
  if (hasOku) {
    return [
      `上限1億円まで出る補助金、案外知らない人多い。`,
      `補助上限1億円。知ってる人だけ得してるやつ。`,
      `「補助上限1億円」って聞くと、ちょっと身を乗り出すよね。`,
      `1億円まで補助される制度、対象なら絶対使った方がいい。`,
      `補助の上限が1億円。設備投資考えてる人、これは絶対チェック推奨。`,
      `上限1億の補助金。「自費でやろう」としてた人、ちょっと待って。`,
      `これ補助上限1億円。聞き間違いじゃなくて、本当に1億。`,
      `補助上限1億。対象に当てはまる人は人生変わるかもしれないやつ。`,
      `1億円補助の制度って、ちゃんと存在してるんですよね、これが。`,
      `上限1億円。設備更新を「いつかやる」って先延ばしにしてる人向け。`,
      ...amtHooks,
    ];
  }
  // 1,000万円超系
  if (hasBig) {
    return [
      `${amt || '1,000万円超'}まで補助される制度、知ってましたか？`,
      `これ大型の補助金、補助上限${amt || '数千万円'}。設備投資考えてる人は要チェック。`,
      `けっこう大きめの補助金、ひとつ共有しておきます。上限${amt || '数千万円'}。`,
      `補助額が大きいやつ（上限${amt || '数千万円'}）。新規投資を控えてる人いたら見ておいて。`,
      `これ補助額${amt || '数千万円'}。対象なら絶対動いた方がいい。`,
      `桁が違う補助金。「数百万」じゃなくて${amt || '数千万円'}のやつ。`,
      `設備や新規事業への投資にがっつり使えるサイズ（上限${amt || '数千万円'}）。`,
      `補助額のレンジが広い制度。上限${amt || '数千万円'}までいける。`,
      `これ申請通れば一気に投資のハードルが下がるやつ。上限${amt || '数千万円'}。`,
      ...amtHooks,
    ];
  }
  // 札幌・北海道
  if (subsidy.categories?.includes('local')) {
    const base = [
      `札幌・北海道の事業者向け、これ知っておいて損ないやつ。`,
      `北海道の人だけ使える補助金、見つけたので共有。`,
      `札幌で事業やってる人向けに一件。これ意外と通りやすい。`,
      `北海道限定の補助金。地元事業者の特権なので使わないと損。`,
      `札幌の事業者向け制度。同業の人にもぜひ教えてあげて。`,
      `北海道の人なら見ておくべきやつ。地方限定は競争率が低めで狙い目。`,
      `札幌・北海道で事業やってる人、この制度はチェック必須。`,
      `地元・北海道の補助金。地域内なら採択率も悪くない。`,
      `北海道の事業者だけが使えるやつ、見落としてる人多い印象。`,
    ];
    if (amt) base.push(
      `札幌・北海道の事業者向けに上限${amt}の補助金。これ知らないとほんと損。`,
      `北海道限定で${amt}まで補助される制度。地元の特権、使い倒したい。`,
      `${amt}補助される北海道の制度。地元事業者なら絶対チェック。`,
    );
    return [...base, ...amtHooks];
  }
  // 医療・クリニック
  if (subsidy.categories?.includes('medical')) {
    const base = [
      `医療機関やクリニック向けの補助金、ひとつメモしておきます。`,
      `クリニック運営してる人向け、これ使えるやつ。`,
      `医療系の補助金、知っておいて損ない一件。`,
      `開業医・診療所向けの制度。これ知らないと普通に損してる。`,
      `医療機関なら使える補助金。同業の人に教えてあげて。`,
      `クリニック向けに使い勝手いい制度、見つけたので共有。`,
      `医療・ヘルスケア系の補助金、対象なら申請する価値あり。`,
      `診療所運営してる人、これ知ってたら結構助かるはず。`,
      `医療法人・個人開業医、両方使える制度をひとつ。`,
    ];
    if (amt) base.push(
      `医療機関・クリニック向けで補助上限${amt}。対象なら申請しない手はない。`,
      `クリニック運営してる人向けに${amt}の補助金。これ知らないとマジで損。`,
      `${amt}まで補助される医療系の制度。開業医・診療所なら要チェック。`,
    );
    return [...base, ...amtHooks];
  }
  // 雇用・助成金
  if (subsidy.categories?.includes('employment')) {
    const base = [
      `人を雇ってる事業者なら使える助成金、知ってましたか？`,
      `従業員いる事業者向けの助成金を一件。`,
      `雇用系の助成金、案外知られてないやつ。`,
      `これ採用や人事まわりで使える助成金。労務担当の人は必チェック。`,
      `スタッフ雇ってる事業所向け。「気づいたら申請期限」になりがちなので早めに。`,
      `労務系の助成金。条件満たしてる人、申請しないと普通にもったいない。`,
      `従業員の処遇改善や育成に使える制度、見落としてる人多い。`,
      `これ正社員化や賃上げで使えるやつ。経営者なら必ず把握しておきたい。`,
      `助成金は申請しないとゼロ。ちゃんと取りに行く価値あるやつ。`,
    ];
    if (amt) base.push(
      `1人あたり${amt}まで支給される助成金。スタッフ雇ってる事業所は必チェック。`,
      `${amt}もらえる助成金。条件さえ合えば、申請しないのは普通にもったいない。`,
      `これ${amt}支給の助成金。労務まわり整ってる事業者なら絶対見逃したくない。`,
    );
    return [...base, ...amtHooks];
  }
  // 融資
  if (subsidy.categories?.includes('finance')) {
    const base = [
      `事業資金の調達、これ知ってると選択肢広がります。`,
      `融資制度のひとつ、メモしておきます。`,
      `創業や運転資金の調達考えてる人、これは押さえておきたい。`,
      `金利・条件まわりが優遇された融資制度。資金繰りで悩む前に見ておくと吉。`,
      `事業資金を調達するなら、まずこの選択肢を検討する価値あり。`,
    ];
    return [...base, ...amtHooks];
  }
  // デフォルト
  const def = [
    `今日見つけた補助金をひとつ共有しておきます。`,
    `知らない人多いけど、これ結構使える補助金。`,
    `これは知っておいて損ない補助金、ひとつ。`,
    `良さそうな補助金見つけたのでメモ。`,
    `気になる人多そうな補助金、ひとつ共有。`,
    `「これは使える」って思った補助金を一件。`,
    `見落とされがちだけど、対象範囲が広い補助金。`,
    `普通に良い制度なのに、なぜか知名度低めなやつ。`,
    `条件さえ合えばかなり使い勝手いい補助金。`,
    `今朝チェックしてて目に留まった一件をシェア。`,
    `知ってる人だけが得してる補助金、ひとつ紹介。`,
    `「これ知らなかった」って言われがちな制度。`,
  ];
  return [...def, ...amtHooks];
}

/**
 * 締めの一言（URLの直前に置く・20種類以上）
 * 命令/体言止め/質問/感想/注意 を混ぜてバラエティを出す
 */
const CLOSING_LINES = [
  // 推奨・命令
  '気になる人は詳細チェックしてみて。',
  '対象になりそうな人は要チェック。',
  '対象なら絶対やった方がいい。',
  '見ておいて損はないはず。',
  'まず要件だけでも確認推奨。',
  'とりあえずブクマしておくと吉。',
  'まずは要件、ざっと目を通すだけでもアリ。',
  // 体言止め
  '詳細はリンク先で。',
  '元ソースは下のリンクから。',
  '詳細・要件は公式ページから。',
  // 質問
  '対象の人、もう動いてますか？',
  '使えそうな人、まわりにいませんか？',
  'これ知ってた人、どれくらいいるんだろう。',
  // 感想
  '個人的にこれはアツい。',
  '正直これは使いたいやつ。',
  'これは知っといて損なし。',
  '対象なら、迷う理由がほぼないやつ。',
  // 注意喚起
  '要件は必ず原文で確認を。',
  '締切前は混むので早めの動きを。',
  '申請考える人は要件チェックから。',
  '情報は変わることがあるので、最終確認は公式で。',
  // ゆるめ
  '気になる人はぜひ。',
  'ピンと来たらリンクへ。',
  '使いどころありそうな人いたら共有もどうぞ。',
  'ひとまずメモしておくだけでも価値あるやつ。',
];

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
function buildNewPost(subsidy) {
  const days = parseDeadlineDays(subsidy.deadline);
  const amt = extractAmountValue(subsidy.amount);
  // 新規告知型のフックも混ぜる（金額入りも追加）
  const newOpeners = [
    '新しく公募が始まった補助金、一件シェア。',
    '今日チェックしてたら新規で出てきた補助金。',
    '新規で出てきたやつ、知っておいて損ないので共有。',
    '新規公募の補助金、対象なら見逃したくないやつ。',
    '新しく出てきた一件、これは結構良さそう。',
  ];
  if (amt) {
    newOpeners.push(
      `新しく公募が始まった補助金。補助上限${amt}。`,
      `新規で出てきた${amt}補助の制度、シェアしておきます。`,
      `${amt}まで補助される制度が新規公募スタート。これは要チェック。`,
    );
  }
  // subsidy.id ベースで、属性フックと新規告知をミックスして抽選
  const allOpeners = [...buildHooks(subsidy, days), ...newOpeners];
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
function buildDailyPickPost(subsidy) {
  const days = parseDeadlineDays(subsidy.deadline);
  const opener = pickVariant(buildHooks(subsidy, days), subsidy.id + ':daily');
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

  let openers;
  if (deadlineChanged && amountChanged) {
    openers = [
      '前に紹介した補助金、締切と補助額がアップデートされてました。',
      'こちらの制度、締切も補助額も両方変更されてます。要再チェック。',
      '締切も金額も変わってる重要アップデート、ひとつ。',
    ];
  } else if (deadlineChanged) {
    openers = [
      '前に出てた補助金、締切情報が更新されてたので追記。',
      'これ締切変わってました。気になってた人は再チェック推奨。',
      '締切のアップデートが出てたのでお知らせ。',
      '締切日が動いてました。これチェック忘れてる人いそう。',
      '前に紹介したやつ、締切が確定したので改めて共有。',
    ];
  } else if (amountChanged) {
    openers = [
      '補助額が変わってたのでお知らせ。',
      'これ補助額アップデートされてました。条件によっては前より良くなってる。',
      '金額の改定が出てたので追記しておきます。',
    ];
  } else {
    openers = [
      '前に紹介した補助金、内容追記があったので共有。',
      'こちらの補助金、要件が更新されてました。',
      '情報のアップデート、ひとつ。',
      '見落としてた人向けに、変更点を共有しておきます。',
      '気づいたら制度内容にアップデート入ってました。',
    ];
  }
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

  // 本文生成
  let text;
  if (best.type === 'new') text = buildNewPost(best.subsidy);
  else if (best.type === 'update') text = buildUpdatePost(best.subsidy);
  else text = buildDailyPickPost(best.subsidy);

  console.log(`\n👉 投稿対象: [${best.type}] ${best.subsidy.title}`);

  if (DRY_RUN) {
    console.log('\n=== DRY RUN: 投稿予定の内容 ===\n');
    console.log(text);
    console.log(`\n(${text.length}文字)\n`);
    return;
  }

  const client = getClient();
  let tweetId = null;
  try {
    const res = await client.v2.tweet(text);
    tweetId = res.data.id;
    console.log(`✅ 投稿成功: ${best.subsidy.title} → tweet ${tweetId}`);
  } catch (e) {
    console.error(`❌ 投稿失敗:`, e.message || e);
    if (e.data) console.error('API response data:', JSON.stringify(e.data, null, 2));
    if (e.errors) console.error('API errors:', JSON.stringify(e.errors, null, 2));
    if (e.code) console.error('Error code:', e.code);
    if (e.rateLimit) console.error('Rate limit:', JSON.stringify(e.rateLimit, null, 2));
    // twitter-api-v2 stores full response in e.data or e
    try { console.error('Full error:', JSON.stringify(e, null, 2)); } catch {}
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

  console.log('🎉 完了');
}

main().catch(e => {
  console.error('💥 致命的エラー:', e);
  process.exit(1);
});
