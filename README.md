# 補助金XBot 🤖

補助金・助成金の最新情報をX (Twitter) に自動投稿するbot。

親プロジェクト [補助金探しbot](../) が毎日 `index.html` を更新するたびに、新規・更新案件を自動検出してXに投稿します。

## 📦 構成

```
補助金XBot/
├── package.json
├── README.md             ← このファイル
├── SETUP.md              ← 初回セットアップ手順（X API設定）
└── scripts/
    ├── parse-subsidies.js      HTMLパーサー & diff検出
    ├── post-new-subsidies.js   毎日: 新規/更新ポスト
    └── post-weekly-summary.js  毎週日曜: 週次まとめスレッド
```

GitHub Actions ワークフローは親リポジトリの `.github/workflows/` にあります（GitHub Actionsの仕様上、サブフォルダに置けないため）。

- `.github/workflows/post-to-x.yml` — `index.html` 更新を検知して新規/更新ポスト
- `.github/workflows/weekly-summary.yml` — 毎週日曜10:00 JST（cron）に週次スレッド投稿

## 🚀 はじめに

初回のみ [SETUP.md](./SETUP.md) を見ながら以下を実施：

1. X bot 専用アカウント作成
2. X Developer Portal で App 作成（Read and write 権限）
3. API Key/Secret + Access Token/Secret を発行
4. GitHub Secrets に4つの値を登録
5. Actions タブで `dry_run: true` で動作確認

## 📝 投稿の種類

### 1. 新規ポスト（毎日・自動）
```
🆕【新着補助金】⭐推奨S
省力化投資補助金（一般型）第6回
💰 上限1,500万円・補助率1/2
📅 申請: 4/15〜5/30
📝 中小企業の生産性向上を支援する...
🔗 https://...
#補助金 #個人事業主 #中小企業
```

### 2. 更新ポスト（毎日・自動）
```
📢【更新】
IT導入補助金2026
📅 締切: 2026年5月12日 17:00
🔗 https://...
#補助金 #個人事業主 #中小企業
```

### 3. 週次まとめ（毎週日曜10:00 JST）
スレッド形式で1週間の新規・更新を最大8件まで投稿。

## 🛠 ローカルでテスト

```bash
cd 補助金XBot
npm install

# index.htmlのパーサーをテスト
npm run test:parse

# 投稿せず内容だけプレビュー
npm run test:dry-new
npm run test:dry-weekly
```

## ⚙ 環境変数

| 名前 | 説明 |
|------|------|
| `X_API_KEY` | Consumer Key |
| `X_API_SECRET` | Consumer Secret |
| `X_ACCESS_TOKEN` | bot アカウントの Access Token |
| `X_ACCESS_SECRET` | bot アカウントの Access Token Secret |
| `DRY_RUN` | `1` で投稿せずログのみ出力 |
| `MAX_POSTS_PER_RUN` | 1回の実行で投稿する最大件数（デフォ6） |
| `REPORT_URL` | 週次まとめに含めるレポートURL |

## 📊 仕組み

1. 親プロジェクトの毎日リサーチで `index.html` が更新される
2. `git push` をトリガーに `post-to-x.yml` workflow が起動
3. `git show HEAD~1:index.html` と現在の `index.html` を比較
4. 新規追加・更新（タイトル/金額/締切/詳細などの変更）された案件を検出
5. X API v2 で投稿

## 📄 ライセンス

Private project.
