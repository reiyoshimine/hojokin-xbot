# 補助金XBot

X（旧Twitter）に補助金情報を自動投稿するBot。
データソースは別リポ `subsidy-research-bot` の `index.html`。

## アカウント
- X: @japanhojokin

## ファイル構成
- `scripts/post-new-subsidies.js` — 日次投稿（新規/更新/ピックアップ）
- `scripts/post-weekly-summary.js` — 週次まとめスレッド
- `scripts/parse-subsidies.js` — index.html パーサー（共有ライブラリ）
- `state/posted.json` — 同日重複投稿防止の状態ファイル

## X投稿ルール
- 1日1投稿（posted.json で管理）
- 投稿テキストは「フック先頭・口語・具体的使い道・締めの一言」で人間風に
- URL付きの場合は detail（説明文）を省略（Xスパムフィルター対策）
- 280文字以内（URL は t.co で23文字換算）

## データソース
- リサーチリポ: `reiyoshimine/subsidy-research-bot`
- CI では `/tmp/research-repo` にクローンして index.html を参照
- git diff で旧版/新版を比較し、新規・更新を検出

## GitHub Secrets（必要）
- `X_API_KEY` / `X_API_SECRET` — X Developer App 認証
- `X_ACCESS_TOKEN` / `X_ACCESS_SECRET` — X ユーザートークン

## 自動Git同期ルール
- コミットメッセージは日本語で簡潔に記述
