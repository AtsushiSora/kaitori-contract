import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const rootPath = fileURLToPath(new URL("../", import.meta.url));
const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function serveStatic() {
  return new Promise((resolve) => {
    const server = createServer(async (request, response) => {
      try {
        const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
        const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
        const path = normalize(join(rootPath, relative));
        if (!path.startsWith(rootPath)) throw new Error("Invalid path");
        const info = await stat(path);
        const file = info.isDirectory() ? join(path, "index.html") : path;
        response.writeHead(200, {
          "Content-Type": mimeTypes[extname(file)] || "application/octet-stream",
          "Cache-Control": "no-store",
        });
        response.end(await readFile(file));
      } catch {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Not found");
      }
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function logPass(label) {
  console.log(`PASS  ${label}`);
}

const server = await serveStatic();
const address = server.address();
const baseUrl = `http://127.0.0.1:${address.port}`;
let browser;

try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  page.on("dialog", (dialog) => dialog.accept());
  await page.goto(`${baseUrl}/admin.html`);
  await page.locator("#test-login").click();
  await page.waitForURL(/contract\.html/);
  assert.equal(await page.locator('[data-app-view="top"]').isVisible(), true);
  logPass("テスト用ログインから契約トップへ移動");

  await page.locator('[data-app-page="create"]').first().click();
  assert.match(page.url(), /#create$/);
  assert.equal(await page.locator('[data-app-view="create"]').isVisible(), true);
  logPass("トップから契約書作成ページへ移動");

  const legends = await page.locator("#contract-form fieldset > legend").allTextContents();
  assert.deepEqual(legends, ["車両情報", "金額・引取情報", "車両名義人", "売主情報", "契約方法"]);
  logPass("入力項目がPDFの上から順に表示");

  await page.locator('[name="carName"]').fill("テスト車両");
  await page.locator('[name="chassisNumber"]').fill("TEST-1234567");
  await page.locator('[name="purchaseAmount"]').fill("1100001");
  await page.locator('[name="sellerLastName"]').fill("山田");
  await page.locator('[name="sellerFirstName"]').fill("太郎");
  await page.locator('[name="sellerPostalCode"]').fill("7300000");
  await page.locator('[name="completionMethod"]').selectOption("paper");
  await page.locator("#save-contract").click();

  const stored = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((item) => item.toLowerCase().includes("contract"));
    return key ? localStorage.getItem(key) : "";
  });
  assert.match(stored, /テスト車両/);
  logPass("下書きを端末内に保存");

  await page.locator('[aria-label="メインナビゲーション"] a[href="#list"]').click();
  assert.equal(await page.locator("#contract-list").getByText("テスト車両").count() > 0, true);
  await page.locator("#contract-search").fill("テスト車両");
  assert.equal(await page.locator("#contract-list").getByText("テスト車両").count() > 0, true);
  logPass("契約一覧への反映と検索");

  await page.locator("#new-contract").click();
  assert.equal(await page.locator('[name="carName"]').inputValue(), "");
  logPass("新規契約で入力値をクリア");

  const pdfResponse = await page.request.get(`${baseUrl}/templates/order_auto_blank_shop_template.pdf`);
  assert.equal(pdfResponse.ok(), true);
  assert.match(pdfResponse.headers()["content-type"], /application\/pdf/);
  assert.equal((await pdfResponse.body()).subarray(0, 5).toString(), "%PDF-");
  logPass("A4契約書PDFテンプレートを配信");

  await context.close();
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

console.log("\nE2Eテストに合格しました。");
