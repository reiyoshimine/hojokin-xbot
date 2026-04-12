// 補助金XBot - Claude AIツイート生成プロンプトビルダー
// candidate.json + バズデータからプロンプトを組み立てて stdout に出力
// claude-code-action から呼ばれ、生成結果は state/claude-draft.json に保存される

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = resolve(__dirname, '..', 'state');

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf-8')); }
  catch { return null; }
}

async function main() {
  const candidate = await readJson(resolve(STATE_DIR, 'candidate.json'));
  if (!candidate) {
    console.error('candidate.json が見つかりません');
    process.exit(1);
  }

  const { type, subsidy } = candidate;
  const collection = await readJson(resolve(STATE_DIR, 'buzz-collection.json'));
  const insights = await readJson(resolve(STATE_DIR, 'buzz-insights.json'));
  const history = await readJson(resolve(STATE_DIR, 'history.json'));

  // バズツイート実例
  const buzzExamples = (collection || [])
    .flatMap(b => b.tweets || [])
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, 5)
    .map(t => t.text)
    .join('\n---\n');

  // 過去の自分の投稿
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

  // プロンプトを stdout に出力
  console.log(`あなたは補助金情報の X アカウント @japanhojokin の中の人です。
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
ツイート本文だけを出力してください。説明や前置きは不要です。`);
}

main().catch(e => {
  console.error('エラー:', e.message);
  process.exit(1);
});
