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
  browser = await chromium.launch({
    channel: process.env.CI ? undefined : "chrome",
    headless: true,
  });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  page.on("dialog", (dialog) => dialog.accept());
  await context.route("https://cumvescylyetumupupmc.supabase.co/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname === "/auth/v1/token") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          access_token: "e2e-test-token",
          refresh_token: "e2e-test-refresh",
          expires_in: 3600,
          user: { id: "e2e-admin", email: "admin@example.test" },
        }),
      });
      return;
    }
    if (request.method() === "GET" && url.pathname === "/rest/v1/contracts") {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
      return;
    }
    if (request.method() === "GET" && url.pathname === "/rest/v1/admin_notifications") {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
      return;
    }
    if (request.method() === "PATCH" && url.pathname === "/rest/v1/admin_notifications") {
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    if (request.method() === "POST" && url.pathname === "/rest/v1/contracts") {
      const body = request.postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([{ ...body, created_at: new Date().toISOString() }]),
      });
      return;
    }
    if (request.method() === "PATCH" && url.pathname === "/rest/v1/contracts") {
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    if (request.method() === "POST" && url.pathname === "/rest/v1/rpc/assign_contract_number") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify("26081101"),
      });
      return;
    }
    if (request.method() === "PUT" && url.pathname.startsWith("/storage/v1/object/contract-files/")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      return;
    }
    await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });
  await page.goto(`${baseUrl}/admin.html`);
  await page.locator("#admin-email").fill("admin@example.test");
  await page.locator("#admin-passcode").fill("e2e-password");
  await page.locator("#admin-submit").click();
  await page.waitForURL(/contract\.html/);
  assert.equal(await page.locator('[data-app-view="top"]').isVisible(), true);
  logPass("管理者ログインから契約トップへ移動");

  const createCardBox = await page.locator(".top-action-card-wide").boundingBox();
  const listCardBox = await page.getByRole("button", { name: /契約一覧/ }).boundingBox();
  const paperCardBox = await page.locator('[data-list-mode="paper"]').boundingBox();
  const remoteCardBox = await page.getByRole("button", { name: /メール・LINEで契約/ }).boundingBox();
  const tabletCardBox = await page.locator('[data-list-mode="tablet"]').boundingBox();
  const customerCardBox = await page.getByRole("button", { name: /顧客一覧/ }).boundingBox();
  const vehicleCardBox = await page.getByRole("button", { name: /買取車両一覧/ }).boundingBox();
  assert.ok(createCardBox && listCardBox && paperCardBox && remoteCardBox && tabletCardBox && customerCardBox && vehicleCardBox);
  assert.ok(createCardBox.width > listCardBox.width * 1.8);
  assert.ok(Math.abs(paperCardBox.y - tabletCardBox.y) < 2 && paperCardBox.x < tabletCardBox.x);
  assert.ok(Math.abs(remoteCardBox.y - listCardBox.y) < 2 && remoteCardBox.x < listCardBox.x);
  assert.ok(Math.abs(customerCardBox.y - vehicleCardBox.y) < 2 && customerCardBox.x < vehicleCardBox.x);
  logPass("トップメニューを指定順の横長1段と2列3段で表示");

  await page.locator('[data-list-mode="paper"]').click();
  assert.match(page.url(), /#list-paper$/);
  assert.equal(await page.locator('[data-app-view="list"]').isVisible(), true);
  assert.equal(await page.locator("#list-view-title").textContent(), "紙で印刷");
  logPass("トップの紙で印刷から契約選択一覧へ移動");

  await page.locator('[aria-label="メインナビゲーション"] a[href="#top"]').click();
  await page.locator('[data-list-mode="tablet"]').click();
  assert.match(page.url(), /#list-tablet$/);
  assert.equal(await page.locator("#list-view-title").textContent(), "対面電子署名");
  logPass("トップの対面電子署名から契約選択一覧へ移動");

  await page.locator('[aria-label="メインナビゲーション"] a[href="#top"]').click();
  await page.locator(".top-action-card-wide").click();
  assert.match(page.url(), /#create$/);
  assert.equal(await page.locator('[name="completionMethod"]').inputValue(), "paper");
  assert.equal(await page.locator("#signature-panel").isHidden(), true);
  logPass("トップの契約書作成から新規入力へ移動");

  const legends = await page.locator("#contract-form fieldset > legend").allTextContents();
  assert.deepEqual(legends, ["車両情報", "金額・引取情報", "車両名義人", "売主情報", "契約方法"]);
  logPass("入力項目がPDFの上から順に表示");

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileToolbarLayout = await page
    .locator('[data-app-view="create"] .workspace-toolbar')
    .evaluate((toolbar) => {
      const title = toolbar.querySelector("#editor-title").getBoundingClientRect();
      const buttons = [...toolbar.querySelectorAll(".toolbar-actions .button")].map((button) =>
        button.getBoundingClientRect(),
      );
      return {
        titleBottom: title.bottom,
        firstButtonTop: buttons[0].top,
        firstButtonWidth: buttons[0].width,
        firstRowDifference: Math.abs(buttons[0].top - buttons[1].top),
        thirdButtonDifference: Math.abs(buttons[0].top - buttons[2].top),
        printButtonWidth: buttons.at(-1).width,
        hasHorizontalOverflow: toolbar.scrollWidth > toolbar.clientWidth,
      };
    });
  assert.ok(mobileToolbarLayout.titleBottom < mobileToolbarLayout.firstButtonTop);
  assert.ok(mobileToolbarLayout.firstButtonWidth > 90);
  assert.ok(mobileToolbarLayout.firstRowDifference < 2);
  assert.ok(mobileToolbarLayout.thirdButtonDifference < 2);
  assert.ok(mobileToolbarLayout.printButtonWidth > mobileToolbarLayout.firstButtonWidth * 2.8);
  assert.equal(mobileToolbarLayout.hasHorizontalOverflow, false);
  logPass("スマホ縦向きの作成画面で見出しと3列操作ボタンを整列");

  const mobileDeadlineLayout = await page.locator(".deadline-input-group").evaluate((group) => {
    const labels = [...group.children].map((item) => item.getBoundingClientRect());
    return {
      singleColumn: labels.every((label, index) => index === 0 || label.top > labels[index - 1].bottom),
      labelsFit: labels.every((label) => label.left >= group.getBoundingClientRect().left && label.right <= group.getBoundingClientRect().right),
      hasHorizontalOverflow: group.scrollWidth > group.clientWidth,
    };
  });
  assert.equal(mobileDeadlineLayout.singleColumn, true);
  assert.equal(mobileDeadlineLayout.labelsFit, true);
  assert.equal(mobileDeadlineLayout.hasHorizontalOverflow, false);
  logPass("スマホ縦向きの期限入力を重なりのない1列で表示");
  await page.setViewportSize({ width: 1280, height: 720 });

  await page.locator('[name="carName"]').fill("テスト車両");
  await page.locator('[name="chassisNumber"]').fill("TEST-1234567");
  await page.locator('[name="purchaseAmount"]').fill("1100001");
  await page.locator('[name="sellerLastName"]').fill("山田");
  await page.locator('[name="sellerFirstName"]').fill("太郎");
  await page.locator('[name="sellerPostalCode"]').fill("7300000");
  await page.locator('[name="sellerMobile"]').fill("09012345678");
  await page.locator('[name="sellerAddress"]').fill("広島県広島市中区テスト町1-2-3");
  await page.locator("#vehicle-document-type").selectOption("車検証");
  await page.locator("#vehicle-document-input").setInputFiles({
    name: "test-registration.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\n%%EOF\n"),
  });
  await page.waitForFunction(() =>
    document.querySelector("#vehicle-document-list")?.textContent.includes("test-registration.pdf"),
  );
  assert.match(await page.locator("#vehicle-document-list").textContent(), /車検証 \/ test-registration\.pdf/);
  await page.locator('[name="completionMethod"]').selectOption("paper");
  await page.locator("#save-contract").click();
  await page.waitForFunction(() =>
    document.querySelector("#cloud-save-status")?.textContent.includes("Supabaseへ保存しました"),
  );
  assert.equal(await page.locator("#cloud-save-contract").count(), 0);
  assert.match(await page.locator("#contract-preview").textContent(), /\d{8}/);

  const stored = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((item) => item.toLowerCase().includes("contract"));
    return key ? localStorage.getItem(key) : "";
  });
  assert.match(stored, /テスト車両/);
  assert.match(stored, /test-registration\.pdf/);
  logPass("車両書類付き下書きを端末内とSupabaseへ同時保存");

  await page.locator("#complete-contract").click();
  await page.waitForURL(/#list$/);
  const completedContractItem = page
    .locator("article.contract-list-item")
    .filter({ hasText: "テスト車両" });
  assert.equal(await completedContractItem.locator("em").textContent(), "完了");
  logPass("完了にすると保存後に契約一覧へ移動");

  await completedContractItem.getByRole("button", { name: "複製して修正" }).click();
  await page.locator("#save-contract").click();
  await page.waitForFunction(() =>
    document.querySelector("#cloud-save-status")?.textContent.includes("Supabaseへ保存しました"),
  );
  await page.locator('[aria-label="メインナビゲーション"] a[href="#list"]').click();
  assert.equal(await page.locator("#contract-list").getByText("テスト車両").count() > 0, true);
  await page.locator("#contract-search").fill("テスト車両");
  assert.equal(await page.locator("#contract-list").getByText("テスト車両").count() > 0, true);
  logPass("契約一覧への反映と検索");

  await page.locator('[aria-label="メインナビゲーション"] a[href="#top"]').click();
  await page.getByRole("button", { name: /顧客一覧/ }).click();
  assert.match(page.url(), /#customers$/);
  assert.match(await page.locator("#customer-list").textContent(), /山田 太郎/);
  await page.locator("#customer-search").fill("09012345678");
  assert.equal(await page.locator("#customer-list .management-card").count(), 1);
  logPass("保存済み契約から顧客一覧と検索を自動生成");

  await page.locator('[data-app-view="customers"] [data-app-page="top"]').click();
  await page.getByRole("button", { name: /買取車両一覧/ }).click();
  assert.match(page.url(), /#vehicles$/);
  assert.match(await page.locator("#vehicle-list").textContent(), /テスト車両/);
  await page.locator("#vehicle-list .management-card").click();
  assert.match(await page.locator("#vehicle-list").textContent(), /車検証/);
  assert.match(await page.locator("#vehicle-list").textContent(), /test-registration\.pdf/);
  logPass("保存済み契約から買取車両一覧と車両書類を自動生成");

  await page.locator('[aria-label="メインナビゲーション"] a[href="#top"]').click();
  await page.locator('[data-app-view="top"] [data-list-mode="paper"]').click();
  const paperContractItem = page.locator("article.contract-list-item").filter({ hasText: "テスト車両" }).first();
  assert.equal(await paperContractItem.getByRole("button", { name: "この契約を印刷" }).count(), 1);
  assert.equal(await paperContractItem.getByRole("button", { name: "編集" }).count(), 0);
  logPass("紙で印刷は一覧から対象契約だけを選択");

  const printPdfDataUrl = await page.evaluate(async () => {
    const pdf = await buildContractPrintPdf(currentContract());
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(pdf);
    });
  });
  const printPdf = Buffer.from(printPdfDataUrl.split(",")[1], "base64");
  const printPdfSource = printPdf.toString("latin1");
  const printedPageCount = (printPdfSource.match(/\/Type\s*\/Page\b/g) || []).length;
  assert.equal(printedPageCount, 4);
  assert.equal((printPdfSource.match(/\/MediaBox \[0 0 595\.28 841\.89\]/g) || []).length, 4);
  assert.equal((printPdfSource.match(/595\.28 0 0 841\.89 0 0 cm/g) || []).length, 4);
  const printPagePromise = context.waitForEvent("page");
  await paperContractItem.getByRole("button", { name: "この契約を印刷" }).click();
  const printPage = await printPagePromise;
  await printPage.waitForURL(/^blob:/);
  assert.match(printPage.url(), /^blob:/);
  await printPage.close();
  logPass("A4全面PDFが表面・条項・店控え・条項の4ページで生成される");

  await page.locator('[aria-label="メインナビゲーション"] a[href="#top"]').click();
  await page.locator('[data-app-view="top"] [data-list-mode="tablet"]').click();
  const tabletContractItem = page.locator("article.contract-list-item").filter({ hasText: "テスト車両" }).first();
  await tabletContractItem.getByRole("button", { name: "この契約に署名" }).click();
  assert.match(page.url(), /#create$/);
  assert.equal(await page.locator('[name="carName"]').inputValue(), "テスト車両");
  assert.equal(await page.locator('[name="completionMethod"]').inputValue(), "tablet");
  assert.equal(await page.locator("#signature-panel").isVisible(), true);
  logPass("対面電子署名は一覧の契約情報を署名画面へ反映");

  await page.evaluate(() => {
    localStorage.setItem("orderAutoSupabaseSession", JSON.stringify({
      access_token: "e2e-test-token",
      refresh_token: "e2e-test-refresh",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    }));
  });
  await page.locator('[aria-label="メインナビゲーション"] a[href="#top"]').click();
  await page.locator('[data-app-view="top"] [data-list-mode="remote"]').click();
  assert.equal(await page.locator("#list-view-title").textContent(), "メール・LINEで契約");
  const testContractItem = page.locator("article.contract-list-item").filter({ hasText: "テスト車両" }).first();
  assert.equal(await testContractItem.getByRole("button", { name: "編集" }).count(), 0);
  await testContractItem.getByRole("button", { name: "メール・LINEで送る" }).click();
  assert.match(page.url(), /#remote$/);
  assert.equal(await page.locator(".remote-progress li").count(), 6);
  await page.locator("#generate-consent-url").click();
  await page.waitForFunction(() => document.querySelector("#email-url")?.value);
  const shortUrl = await page.locator("#email-url").inputValue();
  assert.match(shortUrl, /\/consent\.html#r=[A-Za-z0-9_-]{32}$/);
  assert.ok(shortUrl.length < 150, `確認URLが長すぎます: ${shortUrl.length}文字`);
  assert.match(await page.locator("#consent-passcode").inputValue(), /^\d{8}$/);
  assert.match(await page.locator("#email-body").inputValue(), new RegExp(shortUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(await page.locator("#email-body").inputValue(), /契約番号：26081101/);
  logPass("メール・LINE契約は一覧の契約情報を送信画面へ反映");
  logPass("クラウド契約で短い確認URLと別送パスコードを生成");

  await page.evaluate(() => localStorage.removeItem("orderAutoSupabaseSession"));
  await page.locator("#generate-consent-url").click();
  assert.equal(await page.locator("#email-url").inputValue(), shortUrl);
  assert.match(await page.locator("#cloud-save-status").textContent(), /再ログイン/);
  logPass("ログイン期限切れ時は旧式の長いURLを発行しない");

  await page.locator('[aria-label="メインナビゲーション"] a[href="#list"]').click();
  await page.locator("#new-contract").click();
  assert.equal(await page.locator('[name="carName"]').inputValue(), "");
  logPass("新規契約で入力値をクリア");

  const pdfResponse = await page.request.get(`${baseUrl}/templates/order_auto_blank_shop_template.pdf`);
  assert.equal(pdfResponse.ok(), true);
  assert.match(pdfResponse.headers()["content-type"], /application\/pdf/);
  assert.equal((await pdfResponse.body()).subarray(0, 5).toString(), "%PDF-");
  logPass("A4契約書PDFテンプレートを配信");

  await page.goto(`${baseUrl}/consent.html`);
  assert.equal(await page.getByRole("heading", { name: "メール・LINEでご契約" }).isVisible(), true);
  assert.equal(await page.locator("#consent-guide li").count(), 7);
  assert.equal(await page.locator("#consent-progress li").count(), 4);
  logPass("お客様向けに7手順と4段階の進行表示を用意");
  await page.evaluate(() => {
    document.querySelector("#consent-check-section").hidden = false;
    document.querySelector("#customer-consents").innerHTML =
      '<label><input type="checkbox" name="customerConsent" />重要事項を確認しました</label>';
  });
  const consentCheckboxBox = await page.locator('[name="customerConsent"]').boundingBox();
  assert.ok(consentCheckboxBox?.width >= 26 && consentCheckboxBox?.height >= 26);
  logPass("同意チェックボックスを押しやすい大きさで表示");

  await context.close();
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

console.log("\nE2Eテストに合格しました。");
