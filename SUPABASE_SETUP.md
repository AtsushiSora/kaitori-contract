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
  contractDownloadEndpoint: "https://xxxx.supabase.co/functions/v1/download-contract",
  contractConfirmEndpoint: "https://xxxx.supabase.co/functions/v1/confirm-contract",
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
- `contractDownloadEndpoint`: 期限付きトークンを検証して非公開の契約書PDFを返す
- `contractConfirmEndpoint`: 管理者ログインを検証し、確認完了メールとPDF URLをお客様へ送る

Edge Function側では7日間の有効期限と確認URL専用のランダムトークンを検証してからDBを操作します。
確認URLには32文字のランダムトークンだけを載せ、別送する8桁の開封パスコードと組み合わせて照合します。
URLとパスコードの両方がそろわない限り、契約内容は取得できません。
同意完了後は同じURLから再送信できません。

### Edge Functionsの配置

リポジトリには次の4つを用意しています。

- `supabase/functions/public-contract/index.ts`
- `supabase/functions/submit-consent/index.ts`
- `supabase/functions/download-contract/index.ts`
- `supabase/functions/confirm-contract/index.ts`

Supabase CLIを使う場合は、プロジェクトをリンクしてから次を実行します。

```bash
supabase db push
supabase functions deploy public-contract --no-verify-jwt
supabase functions deploy submit-consent --no-verify-jwt
supabase functions deploy download-contract --no-verify-jwt
supabase functions deploy confirm-contract --no-verify-jwt
```

お客様向け公開関数はSupabase Authのログインを要求しない代わりに、DBへ保存したトークンのハッシュ、有効期限、使用済み状態を関数内で必ず検証します。`confirm-contract`は関数内で管理者のSupabase Authセッションを検証します。`SUPABASE_SERVICE_ROLE_KEY`をHTMLやJavaScriptへ記載しないでください。

別ドメインへ移行するときはEdge FunctionのSecret `ALLOWED_ORIGINS` に許可するOriginをカンマ区切りで設定します。

### 署名受付・確認完了メール通知

お客様の署名受付を管理者へ通知し、管理者確認後にお客様へ契約完了メールを送る場合は、Edge FunctionのSecretを設定します。

```bash
supabase secrets set RESEND_API_KEY="re_xxx"
supabase secrets set ADMIN_NOTIFICATION_EMAIL="admin@example.com"
supabase secrets set NOTIFICATION_FROM_EMAIL="オーダーオート <contract@example.com>"
```

`NOTIFICATION_FROM_EMAIL`はResendで認証済みのドメインを使います。本人確認書類はメールに添付されません。未設定または送信失敗時は、管理画面内の通知に状態が残ります。

本人確認書類は非公開の `contract-files` Storageに保存され、自動削除は行いません。削除は管理者が運用方針に沿って実施します。

署名完了時には3ページのお客様控えPDFを非公開Storageへ保存します。この時点では契約は「確認待ち」です。管理者が内容と本人確認書類を確認して「確認完了・メール送信」を押した時に、30日間有効なダウンロードURLをお客様へ送信し、契約を「完了」にします。期限切れになってもPDFファイル自体は自動削除しません。

## 4. 本番前に必ずやること

- `npm run audit:production`が合格することを確認する
- `supabase-config.js` に本番値を設定する
- 管理者ユーザーをSupabase Authに作成する
- Edge Functionをデプロイする
- 本人確認書類の保存・削除ルールを決める
- GitHub Pages以外の本番ドメインを使う場合は`ALLOWED_ORIGINS`を設定する
- `PRODUCTION_OPERATIONS.md`に沿ってバックアップ復元テストを行う
