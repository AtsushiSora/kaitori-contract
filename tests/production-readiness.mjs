import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const checks = [];

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

function check(label, ok, detail) {
  checks.push({ label, ok, detail });
}

const [adminHtml, adminJs, adminAuthJs, indexHtml] = await Promise.all([
  source("admin.html"),
  source("admin.js"),
  source("admin-auth.js"),
  source("index.html"),
]);

check(
  "管理画面のテスト用ログインを削除",
  !/test-login|テスト用ログイン/.test(`${adminHtml}\n${adminJs}\n${adminAuthJs}`),
  "本番切替時にテスト用ログインのボタン・処理・セッションを削除してください。",
);
check(
  "トップページのテスト案内を削除",
  !/テスト用ログイン/.test(indexHtml),
  "本番用トップページからテスト用の案内を削除してください。",
);

for (const item of checks) {
  console.log(`${item.ok ? "PASS" : "BLOCK"}  ${item.label}`);
  if (!item.ok) console.log(`       ${item.detail}`);
}

const blocked = checks.filter((item) => !item.ok);
if (blocked.length) {
  console.error(`\n本番公開を止める項目が${blocked.length}件あります。現在はテスト運用中のため想定どおりです。`);
  process.exitCode = 1;
} else {
  console.log("\n本番公開用のコード監査に合格しました。");
}
