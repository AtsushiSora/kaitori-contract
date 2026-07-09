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

Edge Function側では契約ID、URL有効期限、必要に応じて追加トークンを検証してからDBを操作します。

## 4. 本番前に必ずやること

- テスト用ログインを削除する
- `supabase-config.js` に本番値を設定する
- 管理者ユーザーをSupabase Authに作成する
- Edge Functionをデプロイする
- 本人確認書類の保存・削除ルールを決める
