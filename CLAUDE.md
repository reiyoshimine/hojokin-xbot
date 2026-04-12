# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

補助金情報をX（@japanhojokin）に自動投稿するBot。データソースは別リポ `reiyoshimine/subsidy-research-bot` の `index.html`。

## コマンド

```bash
npm install                  # 依存インストール
npm run test:parse           # パーサー単体テスト（../index.html を読む）
npm run test:dry-new         # 日次投稿のドライラン（DRY_RUN=1）
npm run test:dry-weekly      # 週次投稿のドライラン（DRY_RUN=1）
npm run post:new             # 日次投稿（本番）
npm run post:weekly          # 週次投稿（本番）
npm run research             # バズリサーチ実行
npm run test:dry-research    # バズリサーチのドライラン
```

ローカルテストには `index.html` が必要。リサーチリポからコピーするか `npm run test:parse path/to/index.html` でパス指定。

## アーキテクチャ

**ESM (type: "module")** / Node.js >= 20 / 依存: `cheerio`, `twitter-api-v2`

### スクリプト間の関係

```
parse-subsidies.js     ← 共有ライブラリ（parseSubsidies, diffSubsidies, contentHash）
tweet-templates.js     ← フック文・締めの一言・オープナー + applyInsightsToHooks()
analyze-patterns.js    ← バズパターン分析ライブラリ（フック分類・ハッシュタグ・構造分析）
  ↑ import
post-new-subsidies.js  — 日次: git diff で新規/更新検出 → 1日1投稿（posted.json で重複防止）
post-weekly-summary.js — 週次: 7日前のコミットと比較 → スレッド形式で最大8件投稿
research-buzz.js       — バズリサーチ: 自ツイート分析+シードデータ → buzz-insights.json 生成
```

### データフロー

```
[リサーチ部隊 - 1日2回 06:00/18:00 JST]
自アカウントのメトリクス + buzz-seeds.json → research-buzz.js → buzz-insights.json

[投稿部隊 - 毎日 12:00 JST]
index.html → parse → diff → 候補選出 → buzz-insights.json でフック確率調整 → 投稿
```

1. リサーチリポの `index.html` を cheerio でパース → 補助金オブジェクト配列
2. `diffSubsidies(oldList, newList)` で新規/更新/終了を検出（`contentHash` で変更判定）
3. `buzz-insights.json` のパターン重みでフック選択確率を調整（`applyInsightsToHooks`）
4. 投稿テキストを組み立て → X API v2 で投稿
5. `state/posted.json` に最終投稿情報を記録（同日重複防止）

### CI（GitHub Actions）

- `post-to-x.yml`: `repository_dispatch` + 毎日 12:00 JST cron。投稿後 `posted.json` を自動コミット。
- `weekly-summary.yml`: 毎週日曜 10:00 JST cron。スレッド投稿。
- `research-buzz.yml`: 1日2回（06:00/18:00 JST）。バズ分析 → `buzz-insights.json` を自動コミット。
- リサーチリポのクローンには `RESEARCH_REPO_TOKEN`（PAT）を使用。

## X投稿ルール

- 1日1投稿（`posted.json` の `lastDate` で管理、`FORCE_POST=1` でオーバーライド可）
- 投稿テキストは「フック先頭・口語・具体的使い道・締めの一言」で人間風に
- URL付きの場合は detail を省略（Xスパムフィルター対策）
- 280文字以内（URL は t.co で23文字換算、`tweetDisplayLen` / `clipToTweet` で制御）
- 投稿優先順位: 新規(rank順) → 更新(締切変更優先) → ピックアップ(未投稿+高rank)

## 環境変数

- `X_API_KEY` / `X_API_SECRET` / `X_ACCESS_TOKEN` / `X_ACCESS_SECRET` — X API認証
- `DRY_RUN=1` — 投稿せずログのみ
- `FORCE_POST=1` — 同日重複ガード無視（テスト用）
- `FORCE_DAILY_PICK=1` — ピックアップ強制
- `MAX_POSTS_PER_RUN` — 1回の最大投稿数（デフォ6）
- `RESEARCH_REPO_PATH` — リサーチリポのローカルパス（デフォ `/tmp/research-repo`）
- `X_API_TIER` — X APIプラン（`free` or `basic`）。`basic` でSearch API有効化

## コミットルール

- コミットメッセージは日本語で簡潔に記述
