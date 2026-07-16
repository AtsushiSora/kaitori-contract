# Supabase本番設定

## 1. 設定ファイル

`supabase-config.js` にSupabaseの値を入れます。

```js
window.ORDER_AUTO_SUPABASE = {
  url: "https://xxxx.supabase.co",
  anonKey: "public-anon-key",
  storageBucket: "contract-files",
  publicContractEndpoint: "https://xxxx.supabase.co/functions/v1/public-contract",
  consentSubmitEndpoint: "https://xxxx.supabase.co/functions/v1/submit-consent",
};
```

## 2. DBとStorage

Supabase SQL Editorで `supabase-schema.sql` を実行します。

このSQLは管理者ログイン済みユーザーだけが契約データと本人確認書類を扱える設定です。
匿名ユーザーに契約データを直接読ませたり更新させたりしません。

## 3. お客様同意の自動反映

お客様ページはログインなしで使うため、DBを直接公開せず、Edge Functionを通します。

- `publicContractEndpoint`: 暗号化URLを開いたお客様に契約内容を返す
- `consentSubmitEndpoint`: お客様の同意結果を保存し、契約ステータスを同意済みにする

Edge Function側では7日間の有効期限と確認URL専用のランダムトークンを検証してからDBを操作します。
確認URLには32文字のランダムトークンだけを載せ、別送する8桁の開封パスコードと組み合わせて照合します。
URLとパスコードの両方がそろわない限り、契約内容は取得できません。
同意完了後は同じURLから再送信できません。

### Edge Functionsの配置

リポジトリには次の2つを用意しています。

- `supabase/functions/public-contract/index.ts`
- `supabase/functions/submit-consent/index.ts`

Supabase CLIを使う場合は、プロジェクトをリンクしてから次を実行します。

```bash
supabase functions deploy public-contract --no-verify-jwt
supabase functions deploy submit-consent --no-verify-jwt
```

公開関数はSupabase Authのログインを要求しない代わりに、DBへ保存したトークンのハッシュ、有効期限、使用済み状態を関数内で必ず検証します。`SUPABASE_SERVICE_ROLE_KEY`をHTMLやJavaScriptへ記載しないでください。

別ドメインへ移行するときはEdge FunctionのSecret `ALLOWED_ORIGINS` に許可するOriginをカンマ区切りで設定します。

## 4. 本番前に必ずやること

- `npm run audit:production`が合格することを確認する
- `supabase-config.js` に本番値を設定する
- 管理者ユーザーをSupabase Authに作成する
- Edge Functionをデプロイする
- 本人確認書類の保存・削除ルールを決める
- GitHub Pages以外の本番ドメインを使う場合は`ALLOWED_ORIGINS`を設定する
- `PRODUCTION_OPERATIONS.md`に沿ってバックアップ復元テストを行う
