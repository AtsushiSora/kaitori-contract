import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function text(path) {
  return readFile(new URL(path, root), "utf8");
}

async function browserFiles() {
  const names = await readdir(root);
  return names.filter((name) => /\.(?:html|js)$/i.test(name));
}

test("ブラウザ公開ファイルにサーバー秘密鍵を含めない", async () => {
  const files = await browserFiles();
  for (const file of files) {
    const source = await text(file);
    assert.doesNotMatch(source, /SUPABASE_SERVICE_ROLE_KEY/i, `${file} に秘密鍵名があります`);
    assert.doesNotMatch(source, /service_role\s*[:=]/i, `${file} にservice role設定があります`);
  }
});

test("管理者ログインのパスワード入力は1つだけ", async () => {
  const [source, authSource] = await Promise.all([text("admin.html"), text("admin-auth.js")]);
  const passwordInputs = source.match(/<input\b[^>]*type="password"[^>]*>/gi) || [];
  assert.equal(passwordInputs.length, 1);
  assert.doesNotMatch(source, /パス(?:ワード|コード)確認/);
  assert.doesNotMatch(authSource, /orderAutoAdminCredential|PBKDF2|adminSetup/);
});

test("ログイン後は同一サイト内にだけ遷移する", async () => {
  const source = await text("admin.js");
  assert.match(source, /destination\.origin !== window\.location\.origin/);
});

test("メール本文の空白をプラス記号へ変換しない", async () => {
  const source = await text("contract.js");
  assert.match(source, /subject=\$\{encodeMailtoValue\(subject\)\}&body=\$\{encodeMailtoValue\(emailBody\.value\)\}/);
  assert.doesNotMatch(source, /new URLSearchParams\(\{\s*subject,\s*body: emailBody\.value/);
});

test("会社電話番号は画面・通知・契約書PDFで新番号に統一する", async () => {
  const files = await browserFiles();
  const sources = await Promise.all(files.map((file) => text(file)));
  const combined = sources.join("\n");
  const contractSource = await text("contract.js");

  assert.doesNotMatch(combined, /080-2912-8616|08029128616/);
  assert.match(combined, /070-8996-6421/);
  assert.match(combined, /07089966421/);
  assert.match(contractSource, /pdfWhiteRect\(145, 1405, 225, 42\)/);
  assert.match(contractSource, /pdfField\(152, 1438, COMPANY\.phone, 13\)/);
});

test("お客様同意画面のチェックボックスはタップしやすい大きさ", async () => {
  const source = await text("styles.css");
  assert.match(source, /\.consent-list input\s*\{[\s\S]*?width:\s*26px;[\s\S]*?height:\s*26px;/);
});

test("お客様の個人・法人郵便番号から住所を自動入力する", async () => {
  const [html, source] = await Promise.all([text("consent.html"), text("consent.js")]);
  assert.match(html, /id="remote-seller-postal-status"/);
  assert.match(html, /id="remote-corporate-postal-status"/);
  assert.match(source, /https:\/\/zipcloud\.ibsnet\.co\.jp\/api\/search/);
  assert.match(source, /setupRemotePostalLookup\("remote-seller-postal", "remote-seller-address"/);
  assert.match(source, /setupRemotePostalLookup\("remote-corporate-postal", "remote-corporate-address"/);
  assert.match(source, /住所を自動入力できませんでした。住所を手入力してください。/);
});

test("お客様がお勤め先を入力し契約データへ保存できる", async () => {
  const [html, consentSource, submitSource, contractSource] = await Promise.all([
    text("consent.html"),
    text("consent.js"),
    text("supabase/functions/submit-consent/index.ts"),
    text("contract.js"),
  ]);
  assert.match(html, /お勤め先<input id="remote-seller-workplace"/);
  assert.match(html, /お勤め先電話番号<input id="remote-seller-workplace-phone"/);
  assert.match(consentSource, /sellerWorkplace: sellerInputValue\("remote-seller-workplace"\)/);
  assert.match(consentSource, /sellerWorkplacePhone: sellerInputValue\("remote-seller-workplace-phone"\)/);
  assert.match(submitSource, /sellerWorkplace: clean\(source\.sellerWorkplace, 120\)/);
  assert.match(submitSource, /sellerWorkplacePhone: clean\(source\.sellerWorkplacePhone, 30\)/);
  assert.match(contractSource, /pdfField\(690, 1546, data\.sellerWorkplace, 7\.5\)/);
  assert.match(contractSource, /pdfField\(704, 1568, data\.sellerWorkplacePhone, 7\.5\)/);
});

test("管理画面内通知は個別削除と確認済み一括削除ができる", async () => {
  const [html, contractSource, apiSource] = await Promise.all([
    text("contract.html"),
    text("contract.js"),
    text("supabase-api.js"),
  ]);
  assert.match(html, /id="delete-read-notifications"/);
  assert.match(contractSource, /data-delete-notification/);
  assert.match(contractSource, /deleteReadAdminNotifications/);
  assert.match(apiSource, /admin_notifications\?id=eq\.\$\{encodeURIComponent\(id\)\}[\s\S]*method: "DELETE"/);
  assert.match(apiSource, /admin_notifications\?read_at=not\.is\.null[\s\S]*method: "DELETE"/);
});

test("メール・LINE契約は案内から完了通知まで同じ手順で表示する", async () => {
  const contractHtml = await text("contract.html");
  const contractSource = await text("contract.js");
  const consentHtml = await text("consent.html");
  const consentSource = await text("consent.js");
  assert.match(contractHtml, /<legend>お客様名<\/legend>[\s\S]*name="customerName"[\s\S]*<legend>車両情報<\/legend>/);
  assert.match(contractHtml, /id="remote-recipient-email"[^>]+type="email"/);
  assert.match(contractHtml, /name="sellerEmail"/);
  assert.match(contractSource, /function customerGreeting/);
  assert.match(contractSource, /if \(!name \|\| name === "お客様"\) return "お客様"/);
  assert.match(contractSource, /customerNameValue\(data\)/);
  assert.match(contractSource, /【ご契約の手順】/);
  assert.match(contractSource, /function buildLineMessage/);
  assert.match(contractSource, /copyText\(field\.value\.trim\(\)\)/);
  assert.match(contractSource, /確認完了メールに記載されたURLからお客様控えPDFを保存/);
  assert.match(consentHtml, /内容確認[\s\S]*重要事項[\s\S]*同意・署名[\s\S]*契約完了/);
  assert.match(consentHtml, /id="consent-complete-section"/);
  assert.match(consentHtml, /id="remote-seller-email-note"[^>]+hidden/);
  assert.match(consentSource, /function showCompletionScreen/);
  assert.match(consentSource, /prefilledRecipientEmail/);
  assert.match(contractSource, /saveRemoteRecipientEmail\("送信済み", \{ required: true \}\)/);
  assert.match(consentSource, /【署名完了】車両売買契約の確認をお願いします/);
  assert.doesNotMatch(consentSource, /result\.downloadUrl/);
  assert.match(consentSource, /const ORDER_AUTO_EMAIL = "info@order-auto\.com"/);
  assert.doesNotMatch(consentSource, /sora29128616@gmail\.com/);
});

test("契約番号は日本時間の日付6桁と日別連番2桁で重複なく採番する", async () => {
  const contractSource = await text("contract.js");
  const apiSource = await text("supabase-api.js");
  const schema = await text("supabase-schema.sql");
  assert.match(contractSource, /timeZone:\s*"Asia\/Tokyo"/);
  assert.match(contractSource, /String\(nextSequence\)\.padStart\(2, "0"\)/);
  assert.match(contractSource, /nextSequence > 99/);
  assert.match(apiSource, /rest\/v1\/rpc\/assign_contract_number/);
  assert.match(schema, /add column if not exists contract_number text/i);
  assert.match(schema, /create unique index if not exists contracts_contract_number_key/i);
  assert.match(schema, /pg_advisory_xact_lock/);
  assert.match(schema, /to_char\(sequence_date_jst, 'YYMMDD'\).*lpad\(sequence_value::text, 2, '0'\)/s);
  assert.match(schema, /grant execute on function public\.assign_contract_number\(text, text\) to authenticated/i);
});

test("契約データと本人確認ファイルは認証済み管理者だけが扱える", async () => {
  const schema = await text("supabase-schema.sql");
  assert.match(schema, /alter table public\.contracts enable row level security/i);
  assert.match(schema, /alter table public\.consent_events enable row level security/i);
  assert.match(schema, /to authenticated[\s\S]*using \(true\)[\s\S]*with check \(true\)/i);
  assert.match(schema, /values \('contract-files', 'contract-files', false\)/i);
  assert.doesNotMatch(schema, /grant[^;]+\bto\s+(?:anon|public)\b/i);
});

test("顧客・買取車両一覧と車両書類を既存の非公開保存領域で管理する", async () => {
  const [html, contractSource, apiSource] = await Promise.all([
    text("contract.html"),
    text("contract.js"),
    text("supabase-api.js"),
  ]);
  assert.match(html, /data-app-view="customers"/);
  assert.match(html, /data-app-view="vehicles"/);
  assert.match(html, /id="vehicle-document-input"[^>]+application\/pdf/);
  assert.match(contractSource, /function customerGroups\(\)/);
  assert.match(contractSource, /function vehicleGroups\(\)/);
  assert.match(contractSource, /category:\s*"vehicle"/);
  assert.match(apiSource, /file\.category === "vehicle" \? "vehicle" : "identity"/);
  assert.doesNotMatch(apiSource, /publicUrl|getPublicUrl/);
});

test("お客様向けURLは期限・ワンタイムトークン・完了済みを検証する", async () => {
  const source = await text("supabase/functions/public-contract/index.ts");
  assert.match(source, /constantTimeEqual\(tokenHash, contract\.remote_access_hash/);
  assert.match(source, /query\.set\("remote_link_hash", `eq\.\$\{linkHash\}`\)/);
  assert.match(source, /remote_access_hash: `eq\.\$\{tokenHash\}`/);
  assert.match(source, /Date\.now\(\) > expiresAt/);
  assert.match(source, /failedAttempts >= 5/);
  assert.match(source, /15 \* 60 \* 1000/);
  assert.match(source, /contract\.remote_used_at \|\| \["確認待ち", "完了"\]\.includes\(contract\.consent_status\)/);
  assert.match(source, /PUBLIC_DATA_FIELDS/);
  assert.doesNotMatch(source, /signature_data/);
  assert.doesNotMatch(source, /identity_files/);
  assert.match(source, /status: "署名待ち"/);
});

test("クラウド確認URLは契約データを埋め込まず短いトークンだけを公開する", async () => {
  const contractSource = await text("contract.js");
  const consentSource = await text("consent.js");
  assert.match(contractSource, /new Uint8Array\(24\)/);
  assert.match(contractSource, /const accessCredential = `\$\{accessToken\}\.\$\{passcode\}`/);
  assert.match(contractSource, /url\.hash = `r=\$\{accessToken\}`/);
  assert.match(contractSource, /isConfigured\(\) && !cloudEnabled\(\)/);
  assert.match(contractSource, /署名済みの契約は確認URLを再発行できません/);
  assert.doesNotMatch(contractSource, /暗号化URL生成/);
  assert.match(consentSource, /decodeShortAccessToken/);
  assert.match(consentSource, /getContract\("", accessCredential\)/);
});

test("電子同意は必須情報が揃った時だけ確認待ちとして保存する", async () => {
  const source = await text("supabase/functions/submit-consent/index.ts");
  assert.match(source, /required\.every\(\(item\) => checked\.includes\(item\)\)/);
  assert.match(source, /!customerName[\s\S]*!allChecked[\s\S]*comparableName\(customerName\)[\s\S]*!validSignature/);
  assert.match(source, /value\.startsWith\("data:image\/png;base64,"\)/);
  assert.match(source, /validEmail/);
  assert.match(source, /status: "確認待ち"/);
  assert.match(source, /consent_status: "確認待ち"/);
  assert.match(source, /remote_used_at: completedAt/);
});

test("遠隔契約は個人・法人、免許証条件、完了ロック、管理通知を備える", async () => {
  const [html, consentSource, submitSource, schema, apiSource, contractSource] = await Promise.all([
    text("consent.html"),
    text("consent.js"),
    text("supabase/functions/submit-consent/index.ts"),
    text("supabase-schema.sql"),
    text("supabase-api.js"),
    text("contract.js"),
  ]);
  assert.match(html, /value="individual"[\s\S]*value="corporate"/);
  assert.match(html, /運転免許証（表面・必須）/);
  assert.match(html, /記載なし（添付不要）[\s\S]*記載あり（添付する）/);
  assert.match(consentSource, /licenseBackStatus === "has_entries"/);
  assert.match(submitSource, /sellerType === "corporate"/);
  assert.match(submitSource, /customer-license-\$\{document\.side\}/);
  assert.match(submitSource, /contract-files/);
  assert.match(submitSource, /安全のため、このメールには本人確認書類を添付していません/);
  assert.match(submitSource, /admin_notifications/);
  assert.match(schema, /prevent_completed_contract_overwrite/);
  assert.match(schema, /old\.status = '完了'/);
  assert.match(schema, /create table if not exists public\.admin_notifications/);
  assert.match(apiSource, /listAdminNotifications/);
  assert.match(contractSource, /function reviseCompletedContract/);
  assert.match(contractSource, /parentContractId/);
});

test("管理者確認後にだけ契約完了PDFの期限付きURLを発行する", async () => {
  const [submitSource, confirmSource, downloadSource, migration, confirmationMigration, downloadHtml, downloadJs, config, contractSource] = await Promise.all([
    text("supabase/functions/submit-consent/index.ts"),
    text("supabase/functions/confirm-contract/index.ts"),
    text("supabase/functions/download-contract/index.ts"),
    text("supabase/migrations/20260829000000_customer_pdf_download.sql"),
    text("supabase/migrations/20260829010000_admin_contract_confirmation.sql"),
    text("download.html"),
    text("download.js"),
    text("supabase-config.js"),
    text("contract.js"),
  ]);
  assert.match(submitSource, /validCustomerPdf/);
  assert.match(submitSource, /customer-copy\.pdf/);
  assert.doesNotMatch(submitSource, /customerDownloadUrl|downloadToken/);
  assert.match(confirmSource, /DOWNLOAD_LINK_DAYS = 30/);
  assert.match(confirmSource, /download_access_hash: downloadAccessHash/);
  assert.match(confirmSource, /お客様控え契約書PDF（30日間有効）/);
  assert.match(confirmSource, /authenticatedUser\(request\)/);
  assert.match(confirmSource, /contract\.consent_status !== "確認待ち"/);
  assert.doesNotMatch(confirmSource, /contract\.consent_status !== "確認待ち" \|\| contract\.status !== "確認待ち"/);
  assert.match(confirmSource, /emailId = await sendCustomerEmail/);
  assert.match(confirmSource, /status: "確認待ち"[\s\S]*confirmation_email_status: "sending"[\s\S]*emailId = await sendCustomerEmail[\s\S]*status: "完了"/);
  assert.match(confirmSource, /status: "完了"/);
  assert.match(confirmSource, /consent_status: "完了"/);
  assert.match(downloadSource, /sha256Hex\(token\)/);
  assert.match(downloadSource, /download_access_expires_at/);
  assert.match(downloadSource, /contract-files/);
  assert.match(downloadSource, /Content-Type": "application\/pdf"/);
  assert.match(downloadSource, /Deno\.env\.get\("SUPABASE_SERVICE_ROLE_KEY"\)/);
  assert.doesNotMatch(downloadSource, /eyJ[A-Za-z0-9_-]{20,}/);
  assert.match(migration, /download_access_hash/);
  assert.match(migration, /customer_pdf_path/);
  assert.match(confirmationMigration, /reviewed_at/);
  assert.match(downloadHtml, /noindex,nofollow/);
  assert.match(downloadJs, /window\.location\.hash/);
  assert.match(config, /contractDownloadEndpoint/);
  assert.match(config, /contractConfirmEndpoint/);
  assert.match(contractSource, /result\?\.emailStatus !== "sent"/);
  assert.match(contractSource, /契約は確認待ちのままです/);
});

test("公開Edge Functionは許可オリジン限定・キャッシュ禁止", async () => {
  const source = await text("supabase/functions/_shared/http.ts");
  assert.match(source, /ALLOWED_ORIGINS/);
  assert.match(source, /https:\/\/atsushisora\.github\.io/);
  assert.match(source, /"Cache-Control": "no-store"/);
  assert.match(source, /Access-Control-Allow-Origin/);
});

test("店控えベースPDFは実体のあるPDFファイル", async () => {
  const file = "templates/order_auto_blank_shop_template.pdf";
  const value = await readFile(new URL(file, root));
  assert.equal(value.subarray(0, 5).toString(), "%PDF-", `${file} がPDFではありません`);
  assert.ok(value.length > 10_000, `${file} の容量が小さすぎます`);
});
