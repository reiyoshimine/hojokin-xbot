// 補助金XBot - HTMLパーサー
// index.html から補助金カードをパースして JSON 配列を返す

import * as cheerio from 'cheerio';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * HTMLコンテンツから補助金カードをパース
 * @param {string} html - index.html の中身
 * @returns {Array<Object>} 補助金オブジェクトの配列
 */
export function parseSubsidies(html) {
  const $ = cheerio.load(html);
  const subsidies = [];

  // tab-report 内の .card のみを対象
  $('#tab-report .card').each((_, el) => {
    const $card = $(el);

    // 終了済み（opacity が指定されているもの）はスキップ
    const style = $card.attr('style') || '';
    const isClosed = /opacity:\s*0\./.test(style);

    const title = $card.find('h3').first().text().trim();
    if (!title) return;

    // バッジ
    const badges = [];
    $card.find('.badges .badge').each((_, b) => {
      badges.push($(b).text().trim());
    });

    // 推奨ランク（recommend-a, recommend-b...）
    let rank = null;
    const recommendDiv = $card.find('[class*="recommend-"]').first();
    const rankClass = (recommendDiv.attr('class') || '').match(/recommend-([a-z])/i);
    if (rankClass) rank = rankClass[1].toUpperCase();
    // .recommend-rank span のテキストもチェック
    const rankSpan = $card.find('.recommend-rank').first().text().trim();
    if (rankSpan && !rank) rank = rankSpan;

    const detail = $card.find('.detail').first().text().trim();
    const amount = $card.find('.amount').first().text().trim();
    const deadline = $card.find('.deadline').first().text().trim();
    const eligibility = $card.find('.eligibility').first().text().trim();
    const recommendReason = $card.find('.recommend-reason').first().text().trim();

    // 主要URL（最初のソースリンク）
    const url = $card.find('.source a').first().attr('href') || '';

    // カテゴリ（card のクラスから判定）
    const cardClasses = ($card.attr('class') || '').split(/\s+/);
    const categories = cardClasses.filter(c =>
      ['national', 'local', 'medical', 'employment', 'facility', 'finance', 'inbound'].includes(c)
    );

    // 一意IDの生成（タイトルベース）
    const id = generateId(title);

    subsidies.push({
      id,
      title,
      badges,
      rank,
      detail,
      amount,
      deadline,
      eligibility,
      recommendReason,
      url,
      categories,
      isClosed,
    });
  });

  return subsidies;
}

/**
 * タイトルから一意IDを生成（順序と空白に依存しない）
 */
function generateId(title) {
  return title
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .replace(/[【】（）()「」『』、。・〜~\-]/g, '')
    .toLowerCase();
}

/**
 * 補助金オブジェクトの「内容ハッシュ」を生成
 * これが変わったら「更新あり」と判定
 */
export function contentHash(subsidy) {
  const fields = [
    subsidy.title,
    subsidy.amount,
    subsidy.deadline,
    subsidy.detail,
    subsidy.rank || '',
    subsidy.badges.join(','),
  ];
  return fields.join('|||');
}

/**
 * 旧と新のリストを比較して、新規/更新/終了を返す
 */
export function diffSubsidies(oldList, newList) {
  const oldMap = new Map(oldList.map(s => [s.id, s]));
  const newMap = new Map(newList.map(s => [s.id, s]));

  const added = [];
  const updated = [];
  const removed = [];

  for (const [id, sub] of newMap) {
    if (sub.isClosed) continue; // 終了済みはスキップ
    if (!oldMap.has(id)) {
      added.push(sub);
    } else {
      const oldHash = contentHash(oldMap.get(id));
      const newHash = contentHash(sub);
      if (oldHash !== newHash) {
        updated.push({
          ...sub,
          oldDeadline: oldMap.get(id).deadline,
          oldAmount: oldMap.get(id).amount,
        });
      }
    }
  }

  for (const [id, sub] of oldMap) {
    if (!newMap.has(id) && !sub.isClosed) {
      removed.push(sub);
    }
  }

  return { added, updated, removed };
}

// CLI として実行された場合（日本語パス対応）
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const filePath = process.argv[2] || resolve(__dirname, '../../index.html');
  const html = await readFile(filePath, 'utf-8');
  const subsidies = parseSubsidies(html);
  console.log(`✅ パース完了: ${subsidies.length}件の補助金を検出`);
  console.log(JSON.stringify(subsidies, null, 2));
}
