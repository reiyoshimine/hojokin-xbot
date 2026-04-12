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
  const { type, subsidy } = JSON.parse(process.argv[2]);
  console.log(`🤖 Claude AIツイート生成: [${type}] ${subsidy.title}`);

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
    .map(t => t.text)
    .join('\n---\n');

  // 過去の自分の投稿（直近5件）
  const recentPosts = (history || [])
    .slice(-5)
    .map(h => h.text)
    .join('\n---\n');

  // バズインサイト要約
  const insightSummary = insights ? [
    `効果的なフック: ${(insights.topHookPatterns || []).slice(0, 3).map(p => `${p.pattern}(${p.weight})`).join(', ')}`,
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
    subsidy.url ? `URL: ${subsidy.url}` : null,
    subsidy.rank ? `推奨ランク: ${subsidy.rank}` : null,
    type === 'update' && subsidy.oldDeadline ? `旧締切: ${subsidy.oldDeadline}` : null,
    type === 'update' && subsidy.oldAmount ? `旧金額: ${subsidy.oldAmount}` : null,
  ].filter(Boolean).join('\n');

  const typeLabel = type === 'new' ? '新規補助金の告知' : type === 'update' ? '補助金の更新情報' : '今日のピックアップ紹介';

  const prompt = `あなたは補助金情報の X アカウント @japanhojokin の中の人です。
以下の補助金情報について、バズるツイートを1つ書いてください。

## 投稿の種類
${typeLabel}

## 補助金データ
${subsidyInfo}

## バズ分析の結果（どんなツイートが伸びるか）
${insightSummary}

## 実際にバズった補助金ツイートの実例
${buzzExamples || '（実例なし）'}

## 自分の過去の投稿（同じ表現を避けること）
${recentPosts || '（履歴なし）'}

## ルール（厳守）
1. 280文字以内（URLは23文字換算）。必ず280文字以内に収めること
2. 冒頭1行目が最重要。スクロールを止める「フック」を書く。疑問形、驚き、損失回避、緊急性のどれかを使う
3. 口語体で、人間が普通にツイートしてるように書く。堅い表現・お役所言葉は絶対NG
4. 具体的な数字（金額、日数、割合）を必ず含める
5. 最後にCTA（行動喚起）の一言を入れる
6. URLがある場合は最終行にURLだけを置く（URL前に空行を入れる）
7. ハッシュタグは0〜2個まで（入れなくてもOK）
8. 絵文字は使わない
9. 「〜です」「〜ます」の丁寧語は使わない。「〜だ」「〜する」「〜な」の常体で
10. 過去の投稿と同じフックや表現は使わない
11. HTMLタグは使わない。プレーンテキストのみ

## 出力形式
ツイート本文だけを出力してください。説明や前置きは不要です。`;

  const client = new Anthropic();
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }],
  });

  let finalText = response.content[0].text.trim();

  // URL確認: 補助金にURLがあるのに生成テキストにない場合は追加
  if (subsidy.url && !finalText.includes(subsidy.url)) {
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
