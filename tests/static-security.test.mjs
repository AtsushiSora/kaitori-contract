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

test("契約データと本人確認ファイルは認証済み管理者だけが扱える", async () => {
  const schema = await text("supabase-schema.sql");
  assert.match(schema, /alter table public\.contracts enable row level security/i);
  assert.match(schema, /alter table public\.consent_events enable row level security/i);
  assert.match(schema, /to authenticated[\s\S]*using \(true\)[\s\S]*with check \(true\)/i);
  assert.match(schema, /values \('contract-files', 'contract-files', false\)/i);
  assert.doesNotMatch(schema, /grant[^;]+\bto\s+(?:anon|public)\b/i);
});

test("お客様向けURLは期限・ワンタイムトークン・完了済みを検証する", async () => {
  const source = await text("supabase/functions/public-contract/index.ts");
  assert.match(source, /constantTimeEqual\(tokenHash, contract\.remote_access_hash/);
  assert.match(source, /query\.set\("remote_access_hash", `eq\.\$\{tokenHash\}`\)/);
  assert.match(source, /Date\.now\(\) > expiresAt/);
  assert.match(source, /contract\.remote_used_at \|\| contract\.consent_status === "完了"/);
  assert.match(source, /PUBLIC_DATA_FIELDS/);
  assert.doesNotMatch(source, /signature_data/);
  assert.doesNotMatch(source, /identity_files/);
});

test("クラウド確認URLは契約データを埋め込まず短いトークンだけを公開する", async () => {
  const contractSource = await text("contract.js");
  const consentSource = await text("consent.js");
  assert.match(contractSource, /new Uint8Array\(24\)/);
  assert.match(contractSource, /const accessCredential = `\$\{accessToken\}\.\$\{passcode\}`/);
  assert.match(contractSource, /url\.hash = `r=\$\{accessToken\}`/);
  assert.match(contractSource, /isConfigured\(\) && !cloudEnabled\(\)/);
  assert.match(contractSource, /完了済みの契約は確認URLを再発行できません/);
  assert.doesNotMatch(contractSource, /暗号化URL生成/);
  assert.match(consentSource, /decodeShortAccessToken/);
  assert.match(consentSource, /getContract\("", accessCredential\)/);
});

test("電子同意は氏名・全チェック・画像署名が揃わないと完了しない", async () => {
  const source = await text("supabase/functions/submit-consent/index.ts");
  assert.match(source, /required\.every\(\(item\) => checked\.includes\(item\)\)/);
  assert.match(source, /!customerName[\s\S]*!allChecked[\s\S]*!validSignature/);
  assert.match(source, /value\.startsWith\("data:image\/png;base64,"\)/);
  assert.match(source, /status: "完了"/);
  assert.match(source, /consent_status: "完了"/);
  assert.match(source, /remote_used_at: completedAt/);
});

test("公開Edge Functionは許可オリジン限定・キャッシュ禁止", async () => {
  const source = await text("supabase/functions/_shared/http.ts");
  assert.match(source, /ALLOWED_ORIGINS/);
  assert.match(source, /https:\/\/atsushisora\.github\.io/);
  assert.match(source, /"Cache-Control": "no-store"/);
  assert.match(source, /Access-Control-Allow-Origin/);
});

test("PDFテンプレートは実体のあるPDFファイル", async () => {
  for (const file of [
    "templates/order_auto_blank_customer_template.pdf",
    "templates/order_auto_blank_shop_template.pdf",
  ]) {
    const value = await readFile(new URL(file, root));
    assert.equal(value.subarray(0, 5).toString(), "%PDF-", `${file} がPDFではありません`);
    assert.ok(value.length > 10_000, `${file} の容量が小さすぎます`);
  }
});
