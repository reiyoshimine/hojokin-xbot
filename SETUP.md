# 補助金XBot セットアップ手順

このドキュメントは、補助金XBotを動かすために**あなた（ユーザー）が手作業でやる必要のあること**をまとめたものです。コード側の準備はすでに完了しています。

---

## ステップ1: X (Twitter) bot 専用アカウントを作成

1. https://x.com を開く（既存アカウントから一度ログアウト）
2. 「アカウント作成」→ 新しいメールアドレスまたは電話番号で作成
3. ユーザー名の例: `@subsidy_jp_bot` `@hojokin_bot` など
4. プロフィール文の例:
   ```
   📊 補助金・助成金の最新情報を毎日自動配信
   🏥 開業医・個人事業主・中小企業向け
   🤖 自動投稿bot
   ```
5. 作成完了したら**ログアウトせず保持**

---

## ステップ2: X Developer Portal でアプリ作成

> 既存のDeveloperアカウントを持っているとのことなので、そこに新しいProject/Appを追加します。

1. https://developer.x.com/en/portal/dashboard を開く
2. 新しい **Project** を作成（例: `Subsidy Bot`）
3. その中に新しい **App** を作成（例: `subsidy-bot-app`）
4. **重要: User authentication settings の設定**
   - 「Set up」をクリック
   - **App permissions**: `Read and write` を選択（Read onlyだと投稿できません）
   - **Type of App**: `Web App, Automated App or Bot`
   - **Callback URI**: `http://localhost:3000/callback`（ダミーでOK）
   - **Website URL**: `https://github.com/reiyoshimine/subsidy-research-bot`
   - 「Save」

---

## ステップ3: bot アカウントでアプリを認可してトークンを発行

> 重要: API Key/Secret は「アプリのもの」、Access Token/Secret は「ログイン中のbotアカウントのもの」です。**bot アカウントでXにログインした状態で**以下を行ってください。

1. Developer Portal で先ほど作ったAppを開く
2. **「Keys and tokens」タブ**を開く
3. 以下の4つを発行・コピーしてメモ帳などに保存:
   - `API Key` (= Consumer Key)
   - `API Key Secret` (= Consumer Secret)
   - `Access Token` ← これが**botアカウント**のトークン
   - `Access Token Secret`

> ⚠️ Access Token を発行する前に、Step 2で「Read and write」に設定していることを必ず確認してください。Read only のままトークンを発行すると、投稿時に 403 Forbidden になります。後から権限を変更した場合は、Access Tokenを **Regenerate** してください。

---

## ステップ4: GitHub Secrets に登録

1. https://github.com/reiyoshimine/subsidy-research-bot を開く
2. **Settings** → **Secrets and variables** → **Actions** をクリック
3. **「New repository secret」**を4回押して、以下を登録:

| Name | Value |
|------|-------|
| `X_API_KEY` | Step3でコピーしたAPI Key |
| `X_API_SECRET` | Step3でコピーしたAPI Key Secret |
| `X_ACCESS_TOKEN` | Step3でコピーしたAccess Token |
| `X_ACCESS_SECRET` | Step3でコピーしたAccess Token Secret |

---

## ステップ5: 動作確認（ドライランで投稿内容をプレビュー）

1. https://github.com/reiyoshimine/subsidy-research-bot/actions を開く
2. 左サイドバーの **「補助金XBot - 新規/更新ポスト」** をクリック
3. **「Run workflow」** ボタン → `dry_run: true` を選んで実行
4. 完了後、ログを開いて「DRY RUN: 投稿予定の内容」を確認

問題なければ `dry_run: false` で本番投稿テスト。

---

## ステップ6: 自動運転スタート

これ以降は**完全自動**です：

| 動作 | タイミング | 内容 |
|------|-----------|------|
| 新規/更新ポスト | 毎日`index.html`が更新されるたび | 検出した新規・更新案件を最大6件投稿 |
| 週次まとめ | 毎週日曜 10:00 JST | 過去7日間のサマリーをスレッド投稿 |

---

## トラブルシューティング

### ❌ 403 Forbidden (Your client is not permitted to perform this action)
→ App permissionsが Read only のままです。Step2に戻り Read and writeに変更し、Access Tokenを **Regenerate** してください。

### ❌ 401 Unauthorized
→ GitHub Secretsの値をコピペし直してください。前後のスペース・改行が混入していないか確認。

### ❌ 429 Too Many Requests
→ Free tierは月1,500ポスト・15分あたりの上限あり。`MAX_POSTS_PER_RUN` を下げてください（workflow yamlで調整可）。

### ❌ 投稿はされたが文字化け
→ `package.json`の`type: module`が消えていないか確認。

---

## ローカルテスト方法（任意）

```bash
cd 補助金XBot
npm install

# パーサー単体テスト
npm run test:parse

# ドライラン（環境変数なしでもOK）
npm run test:dry-new
npm run test:dry-weekly

# 本番投稿テスト（環境変数を設定して実行）
export X_API_KEY=...
export X_API_SECRET=...
export X_ACCESS_TOKEN=...
export X_ACCESS_SECRET=...
npm run post:new
```

---

セットアップで困ったらこのファイルをClaude Codeに見せて相談してください。
