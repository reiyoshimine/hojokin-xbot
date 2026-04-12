// 補助金XBot - Claude AIツイート生成スクリプト
// 補助金データ + バズ分析データを元に、Claudeがバズるツイート本文を生成
// post-new-subsidies.js から呼ばれ、生成結果を state/claude-draft.json に保存

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = resolve(__dirname, '..', 'state');
const DRAFT_FILE = resolve(STATE_DIR, 'claude-draft.json');

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf-8')); }
  catch { return null; }
}

function tweetDisplayLen(text) {
  const urls = text.match(/https?:\/\/\S+/g) || [];
  let len = text.length;
  for (const u of urls) len += 23 - u.length;
  return len;
}

async function main() {
  const { type, subsidy, retryHint, noUrl } = JSON.parse(process.argv[2]);
  console.log(`🤖 Claude AIツイート生成: [${type}] ${subsidy.title}${retryHint ? ' (リトライ)' : ''}`);

  const [collection, insights, history] = await Promise.all([
    readJson(resolve(STATE_DIR, 'buzz-collection.json')),
    readJson(resolve(STATE_DIR, 'buzz-insights.json')),
    readJson(resolve(STATE_DIR, 'history.json')),
  ]);

  // バズツイート実例（上位5件）
  const buzzExamples = (collection || [])
    .flatMap(b => b.tweets || [])
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, 5)
    .map(t => `[スコア: ${t.score}] ${t.text}`)
    .join('\n---\n');

  // 過去の自分の投稿（直近10件、重複回避用）
  const recentPosts = (history || [])
    .slice(-10)
    .map(h => h.text)
    .join('\n---\n');

  // バズインサイト要約
  const insightSummary = insights ? [
    `最も効果的なフックパターン: ${(insights.topHookPatterns || []).slice(0, 3).map(p => `${p.pattern}(重み${p.weight})`).join(' > ')}`,
    `推奨ハッシュタグ: ${(insights.topHashtags || []).slice(0, 3).map(t => t.tag).join(' ')}`,
    `最適行数: ${insights.structureInsights?.optimalLineCount?.join('〜')}行`,
    `CTA含有率: ${Math.round((insights.structureInsights?.ctaRate || 0) * 100)}%`,
  ].join('\n') : 'インサイトなし';

  // 補助金情報
  const subsidyInfo = [
    `名前: ${subsidy.title}`,
    subsidy.amount ? `金額: ${subsidy.amount}` : null,
    subsidy.deadline ? `締切: ${subsidy.deadline}` : null,
    subsidy.detail ? `詳細: ${subsidy.detail}` : null,
    !noUrl && subsidy.url ? `URL: ${subsidy.url}` : null,
    subsidy.rank ? `推奨ランク: ${subsidy.rank}` : null,
    type === 'update' && subsidy.oldDeadline ? `旧締切: ${subsidy.oldDeadline}` : null,
    type === 'update' && subsidy.oldAmount ? `旧金額: ${subsidy.oldAmount}` : null,
  ].filter(Boolean).join('\n');

  const typeLabel = type === 'new' ? '新規補助金の告知' : type === 'update' ? '補助金の更新情報' : '今日のピックアップ紹介';

  const prompt = `あなたは補助金情報のXアカウント @japanhojokin の中の人だ。
以下の補助金について、Xでバズるツイートを1つ書け。

## 最重要: バズるための戦略
上のバズ実例を徹底的に分析して、以下の要素を盗め：
- **1行目のフック**: 実例の冒頭を参考に、思わずスクロールを止める一言を書く。「知らないと損」「まだ知らない人が多い」「○○万円が○日で締切」のような、読者が「自分のこと？」と感じるフレーズ
- **数字の使い方**: 金額や日数の見せ方を実例から学ぶ。丸い数字、具体的な期限、補助率
- **構成**: 実例の改行の入れ方、情報の出す順番、CTAの書き方をマネる
- **読者の自分ごと化**: 「自分には関係ない」→「実は対象」の流れが鉄板

## 投稿の種類
${typeLabel}

## 補助金データ
${subsidyInfo}

## バズ分析の結果
${insightSummary}

## 実際にバズった補助金ツイートの実例（これを徹底的に参考にしろ）
${buzzExamples || '（実例なし）'}

## 自分の過去の投稿（これらと被らない表現にしろ）
${recentPosts || '（履歴なし）'}

## ルール（厳守）
1. 280文字以内（URLは23文字換算）
2. 1行目でスクロールを止めろ。フックが命
3. 口語体。人間がツイートしてるように自然に。堅い表現NG
4. 具体的な数字（金額・日数・割合）を必ず入れろ
5. 最後にCTA（行動喚起）を入れろ
6. ${noUrl ? 'URLは入れるな' : 'URLがある場合は最終行にURLだけを置け（URL前に空行）'}
7. ハッシュタグは0〜2個
8. 絵文字は使うな
9. 「〜です」「〜ます」NG。「〜だ」「〜する」の常体で
10. 過去の投稿のフックや言い回しを絶対に再利用するな。毎回新鮮な表現にしろ
11. HTMLタグ禁止

## 出力
ツイート本文のみ。説明・前置き・補足は一切不要。${retryHint ? `\n\n## 追加指示（最優先）\n${retryHint}` : ''}`;

  const client = new Anthropic();
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }],
  });

  let finalText = response.content[0].text.trim();

  // URL追加（noUrlでない場合のみ）
  if (!noUrl && subsidy.url && !finalText.includes(subsidy.url)) {
    finalText = finalText.replace(/\n*$/, '') + '\n\n' + subsidy.url;
  }

  const displayLen = tweetDisplayLen(finalText);
  if (displayLen > 280) {
    console.warn(`⚠️ 生成テキストが${displayLen}文字（280超過）→ フォールバック`);
    process.exit(2);
  }

  console.log(`\n=== Claude生成ツイート (${displayLen}文字) ===\n`);
  console.log(finalText);

  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(DRAFT_FILE, JSON.stringify({
    generatedAt: new Date().toISOString(),
    type,
    subsidyTitle: subsidy.title,
    text: finalText,
    displayLen,
  }, null, 2) + '\n', 'utf-8');
  console.log(`\n💾 保存: ${DRAFT_FILE}`);
}

main().catch(e => {
  console.error('💥 Claude生成失敗:', e.message);
  process.exit(2);
});
