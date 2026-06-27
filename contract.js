const STORAGE_KEY = "orderAutoContracts";
const CLOUD_FORM_NAME = "contract-record";
const COMPANY = {
  name: "オーダーオート",
  representative: "空 篤志",
  address: "広島県広島市佐伯区皆賀1-10-20",
  phone: "080-2912-8616",
};

const CONSENTS = {
  sale: [
    "車両情報に間違いありません",
    "事故歴・修復歴・不具合について、知る限り正確に申告しました",
    "表示された買取金額に同意します",
    "還付金等は買取金額に含まれることに同意します",
    "引渡し後の名義変更・抹消登録手続きに協力します",
  ],
  free: [
    "買取金額が0円であることに同意します",
    "引取後に買取代金を請求しません",
    "自動車重量税の還付を請求しません",
    "自賠責保険料の返戻金を請求しません",
    "リサイクル券・リサイクル料金の返金を請求しません",
    "自動車税種別割の還付を請求しません",
    "還付金等が発生する可能性を理解したうえで同意します",
  ],
};

let contracts = [];
let activeId = "";
let activeFilter = "all";
let signatureData = "";
let identityFiles = [];
let isDrawing = false;

const CRYPTO_ITERATIONS = 200000;
const MAX_IDENTITY_FILES = 4;
const MAX_IDENTITY_FILE_BYTES = 8 * 1024 * 1024;
const IDENTITY_IMAGE_MAX_EDGE = 1600;
const IDENTITY_IMAGE_QUALITY = 0.82;

function formatDate(date = new Date()) {
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function formatDateTime(date = new Date()) {
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function createContractId() {
  const stamp = new Date()
    .toISOString()
    .replace(/\D/g, "")
    .slice(0, 14);
  return `ORD-${stamp}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function safeValue(value, fallback = "未入力") {
  const cleaned = String(value ?? "").trim();
  return cleaned ? escapeHtml(cleaned) : fallback;
}

function joinName(lastName, firstName) {
  return [lastName, firstName]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .join(" ");
}

function splitLegacyName(name) {
  const cleaned = String(name ?? "").trim();
  if (!cleaned) return ["", ""];
  const parts = cleaned.split(/\s+/);
  if (parts.length === 1) return [parts[0], ""];
  return [parts[0], parts.slice(1).join(" ")];
}

function normalizeSellerNameFields(data) {
  if (!data.sellerLastName && !data.sellerFirstName && data.sellerName) {
    const [lastName, firstName] = splitLegacyName(data.sellerName);
    data.sellerLastName = lastName;
    data.sellerFirstName = firstName;
  }

  if (!data.sellerLastKana && !data.sellerFirstKana && data.sellerKana) {
    const [lastKana, firstKana] = splitLegacyName(data.sellerKana);
    data.sellerLastKana = lastKana;
    data.sellerFirstKana = firstKana;
  }

  data.sellerName = joinName(data.sellerLastName, data.sellerFirstName) || String(data.sellerName ?? "").trim();
  data.sellerKana = joinName(data.sellerLastKana, data.sellerFirstKana) || String(data.sellerKana ?? "").trim();
  return data;
}

function joinPlateNumber(area, classification, kana, digits) {
  return [area, classification, kana, digits]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .join(" ");
}

function splitPlateNumber(plateNumber) {
  const cleaned = String(plateNumber ?? "").trim();
  if (!cleaned) return ["", "", "", ""];
  const parts = cleaned.split(/\s+/);
  if (parts.length >= 4) {
    return [parts[0], parts[1], parts[2], parts.slice(3).join(" ")];
  }
  return [cleaned, "", "", ""];
}

function normalizePlateNumberFields(data) {
  if (!data.plateArea && !data.plateClass && !data.plateKana && !data.plateNumberDigits && data.plateNumber) {
    const [area, classification, kana, digits] = splitPlateNumber(data.plateNumber);
    data.plateArea = area;
    data.plateClass = classification;
    data.plateKana = kana;
    data.plateNumberDigits = digits;
  }

  data.plateNumber =
    joinPlateNumber(data.plateArea, data.plateClass, data.plateKana, data.plateNumberDigits) ||
    String(data.plateNumber ?? "").trim();
  return data;
}

function yen(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return "0円";
  }
  return `${number.toLocaleString("ja-JP")}円`;
}

function loadContracts() {
  try {
    contracts = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch (error) {
    contracts = [];
  }
}

function persistContracts() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(contracts));
    return true;
  } catch (error) {
    setSaveStatus(
      "ブラウザの保存容量を超えました。本人確認写真を減らすか、JSON出力後に不要な契約を整理してください。",
      "warning",
    );
    return false;
  }
}

function currentContract() {
  return contracts.find((contract) => contract.id === activeId);
}

function setSaveStatus(message, tone = "neutral") {
  const status = document.querySelector("#cloud-save-status");
  if (!status) return;
  status.textContent = message;
  status.dataset.tone = tone;
}

function dataUrlSize(dataUrl) {
  const base64 = String(dataUrl || "").split(",")[1] || "";
  return Math.round((base64.length * 3) / 4);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0KB";
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result || "")));
    reader.addEventListener("error", reject);
    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image));
    image.addEventListener("error", reject);
    image.src = dataUrl;
  });
}

async function compressIdentityImage(file) {
  if (!file.type.startsWith("image/")) {
    throw new Error("画像ファイルだけ添付できます。");
  }

  if (file.size > MAX_IDENTITY_FILE_BYTES) {
    throw new Error("1枚あたり8MB以下の画像を選択してください。");
  }

  const originalDataUrl = await readFileAsDataUrl(file);
  const image = await loadImage(originalDataUrl);
  const scale = Math.min(1, IDENTITY_IMAGE_MAX_EDGE / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0, width, height);
  const dataUrl = canvas.toDataURL("image/jpeg", IDENTITY_IMAGE_QUALITY);

  return {
    id: `ID-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: file.name,
    type: "image/jpeg",
    size: dataUrlSize(dataUrl),
    originalSize: file.size,
    width,
    height,
    addedAt: formatDateTime(),
    dataUrl,
  };
}

function identityFileSummary(files = identityFiles) {
  return files.map(({ dataUrl, ...file }) => file);
}

function renderIdentityFiles() {
  const list = document.querySelector("#identity-photo-list");
  if (!list) return;

  if (!identityFiles.length) {
    list.innerHTML = '<p class="empty-state">本人確認書類の写真は未添付です。</p>';
    return;
  }

  list.innerHTML = identityFiles
    .map((file, index) => {
      return `
        <div class="identity-photo-item">
          <img src="${file.dataUrl}" alt="${escapeHtml(file.name)}" />
          <div>
            <strong>${escapeHtml(file.name || `本人確認写真${index + 1}`)}</strong>
            <span>${escapeHtml(formatBytes(file.size))} / ${escapeHtml(file.width)}x${escapeHtml(file.height)}</span>
          </div>
          <button class="mini-button" type="button" data-remove-identity-photo="${index}">削除</button>
        </div>
      `;
    })
    .join("");
}

function getFormData() {
  const form = document.querySelector("#contract-form");
  const data = Object.fromEntries(new FormData(form).entries());
  data.documents = new FormData(form).getAll("documents");
  data.contractType = form.elements.contractType.value;
  data.completionMethod = form.elements.completionMethod.value;
  data.consents = new FormData(form).getAll("consents");
  normalizeSellerNameFields(data);
  normalizePlateNumberFields(data);

  if (data.contractType === "free") {
    data.purchaseAmount = "0";
    data.paymentMethod = "支払いなし";
  }

  return data;
}

function setFieldValue(form, name, value) {
  const field = form.elements[name];
  if (!field) return;

  if (field instanceof RadioNodeList) {
    const item = Array.from(field).find((option) => option.value === value);
    if (item) item.checked = true;
    return;
  }

  field.value = value ?? "";
}

function populateForm(contract) {
  const form = document.querySelector("#contract-form");
  form.reset();

  const data = contract?.data || {};
  normalizeSellerNameFields(data);
  normalizePlateNumberFields(data);
  Object.entries(data).forEach(([key, value]) => {
    if (key === "documents" || key === "consents") return;
    setFieldValue(form, key, value);
  });

  form.querySelectorAll('input[name="documents"]').forEach((checkbox) => {
    checkbox.checked = (data.documents || []).includes(checkbox.value);
  });

  renderConsents(data.contractType || "sale", data.consents || []);
  signatureData = contract?.signatureData || "";
  identityFiles = Array.isArray(contract?.identityFiles) ? contract.identityFiles : [];
  renderIdentityFiles();
  updateModePanels();
  updatePreview();
}

function createBlankContract() {
  const id = createContractId();
  const contract = {
    id,
    status: "下書き",
    createdAt: formatDateTime(),
    updatedAt: formatDateTime(),
    completedAt: "",
    signedAt: "",
    signatureData: "",
    identityFiles: [],
    data: {
      contractType: "sale",
      completionMethod: "paper",
      purchaseAmount: "",
      paymentMethod: "振込",
    },
  };

  contracts.unshift(contract);
  activeId = id;
  persistContracts();
  populateForm(contract);
  renderList();
}

function saveActiveContract(status) {
  const existing = currentContract();
  if (!existing) return;

  existing.data = getFormData();
  existing.signatureData = signatureData;
  existing.identityFiles = identityFiles;
  existing.status = status || existing.status || "下書き";
  existing.updatedAt = formatDateTime();
  const saved = persistContracts();
  renderList();
  updatePreview();
  if (saved) {
    setSaveStatus("この端末に保存しました。Netlify保存で管理画面にも送信できます。");
  }
  return saved;
}

function contractTitle(data) {
  if (data.contractType === "free") {
    return data.completionMethod === "paper"
      ? "車両無償引取契約書"
      : "電子車両無償引取契約書";
  }

  return data.completionMethod === "paper"
    ? "車両売買契約書"
    : "電子車両売買契約書";
}

function contractTypeLabel(data) {
  return data.contractType === "free" ? "買取金額0円 / 無償引取" : "買取金額あり";
}

function completionLabel(data) {
  const labels = {
    paper: "紙で印刷",
    tablet: "タブレット署名",
    email: "メール電子同意",
  };
  return labels[data.completionMethod] || "紙で印刷";
}

function renderConsents(type, checkedItems = []) {
  const list = document.querySelector("#consent-list");
  list.innerHTML = CONSENTS[type]
    .map((text) => {
      const checked = checkedItems.includes(text) ? "checked" : "";
      return `<label><input type="checkbox" name="consents" value="${escapeHtml(text)}" ${checked} />${escapeHtml(text)}</label>`;
    })
    .join("");
}

function row(label, value) {
  return `<div><dt>${escapeHtml(label)}</dt><dd>${safeValue(value)}</dd></div>`;
}

function renderDocument(contract) {
  const data = contract?.data || getFormData();
  const consents = data.consents || [];
  const documents = data.documents || [];
  const attachedIdentityFiles = Array.isArray(contract?.identityFiles)
    ? contract.identityFiles
    : identityFiles;
  const title = contractTitle(data);
  const isFree = data.contractType === "free";
  const isElectronic = data.completionMethod !== "paper";

  const amount = isFree ? "0円" : yen(data.purchaseAmount);
  const signatureBlock = signatureData
    ? `<img class="signature-image" src="${signatureData}" alt="売主電子署名" />`
    : '<span class="signature-placeholder">未署名</span>';

  return `
    <article class="print-sheet">
      <header class="document-header">
        <div>
          <p>契約番号：${safeValue(contract?.id || activeId)}</p>
          <p>契約日：${formatDate()}</p>
        </div>
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(contractTypeLabel(data))} / ${escapeHtml(completionLabel(data))}</p>
      </header>

      <section class="document-section">
        <h3>当事者</h3>
        <dl class="document-dl">
          ${row("売主氏名", data.sellerName)}
          ${row("フリガナ", data.sellerKana)}
          ${row("売主住所", data.sellerAddress)}
          ${row("電話番号", data.sellerPhone)}
          ${row("メール", data.sellerEmail)}
          ${row("買主 / 引取事業者", COMPANY.name)}
          ${row("代表者", COMPANY.representative)}
          ${row("所在地", COMPANY.address)}
          ${row("電話番号", COMPANY.phone)}
        </dl>
      </section>

      <section class="document-section">
        <h3>車両情報</h3>
        <dl class="document-dl">
          ${row("車名", data.carName)}
          ${row("グレード", data.carGrade)}
          ${row("年式", data.carYear)}
          ${row("登録番号", data.plateNumber)}
          ${row("車台番号", data.chassisNumber)}
          ${row("走行距離", data.mileage)}
          ${row("車検満了日", data.inspectionDate)}
          ${row("色", data.carColor)}
          ${row("修復歴", data.repairHistory)}
          ${row("不具合", data.defect)}
          ${row("自走可否", data.drivable)}
          ${row("鍵の本数", data.keyCount)}
        </dl>
      </section>

      <section class="document-section">
        <h3>契約内容</h3>
        <dl class="document-dl">
          ${row("契約区分", contractTypeLabel(data))}
          ${row("買取金額", amount)}
          ${row("支払方法", data.paymentMethod)}
          ${row("支払予定日", data.paymentDate)}
          ${row("引取予定日", data.pickupDate)}
          ${row("引取場所", data.pickupPlace)}
          ${row("振込先", [data.bankName, data.branchName, data.accountType, data.accountNumber, data.accountHolder].filter(Boolean).join(" / "))}
        </dl>
      </section>

      <section class="document-section">
        <h3>重要事項確認</h3>
        <ul class="document-checks">
          ${CONSENTS[data.contractType || "sale"]
            .map((item) => `<li>${consents.includes(item) ? "☑" : "□"} ${escapeHtml(item)}</li>`)
            .join("")}
        </ul>
      </section>

      <section class="document-section">
        <h3>必要書類</h3>
        <p>${documents.length ? documents.map(escapeHtml).join("、") : "未確認"}</p>
      </section>

      <section class="document-section">
        <h3>本人確認書類写真</h3>
        <p>${
          attachedIdentityFiles.length
            ? `添付済み：${attachedIdentityFiles.map((file) => escapeHtml(file.name || "本人確認写真")).join("、")}`
            : "未添付"
        }</p>
      </section>

      <section class="document-section">
        <h3>契約条項</h3>
        ${isFree ? freeTerms() : saleTerms()}
      </section>

      <section class="document-section signature-section">
        <h3>${isElectronic ? "電子契約記録" : "署名欄"}</h3>
        ${
          isElectronic
            ? `
              <dl class="document-dl">
                ${row("契約成立日時", contract?.completedAt)}
                ${row("同意日時", contract?.signedAt || contract?.completedAt)}
                ${row("送信先メール", data.sellerEmail)}
                ${row("保存形式", "ブラウザ保存 / 印刷PDF")}
              </dl>
              <div class="signature-box">
                <strong>売主電子署名</strong>
                ${signatureBlock}
              </div>
            `
            : `
              <div class="paper-signatures">
                <div>
                  <strong>甲 売主</strong>
                  <p>住所：</p>
                  <p>氏名：</p>
                  <p>署名・押印：</p>
                </div>
                <div>
                  <strong>乙 買主 / 引取事業者</strong>
                  <p>${escapeHtml(COMPANY.name)}</p>
                  <p>代表者 ${escapeHtml(COMPANY.representative)}</p>
                  <p>署名・押印：</p>
                </div>
              </div>
            `
        }
      </section>
    </article>
  `;
}

function saleTerms() {
  return `
    <ol class="terms-list">
      <li>売主は対象車両を買主に売り渡し、買主はこれを買い受ける。</li>
      <li>売買代金は本契約書に表示された金額とし、買主は現金または振込により支払う。</li>
      <li>自動車重量税、自賠責保険料、リサイクル料金、自動車税種別割その他還付金等は売買代金に含まれ、売主は別途請求しない。</li>
      <li>売主は事故歴、修復歴、不具合、残債、所有権留保その他重要事項を正確に申告する。</li>
      <li>申告内容に重大な誤りまたは虚偽がある場合、買主は契約解除または売買代金の減額を請求できる。</li>
      <li>本契約に関する紛争は、買主所在地を管轄する裁判所を第一審の専属的合意管轄裁判所とする。</li>
    </ol>
  `;
}

function freeTerms() {
  return `
    <ol class="terms-list">
      <li>売主は対象車両を引取事業者に無償で譲渡し、引取事業者はこれを引き取る。</li>
      <li>本契約における車両代金は0円とし、引取事業者は売主に買取代金その他名目を問わず金銭を支払わない。</li>
      <li>売主は、自動車重量税、自賠責保険料、リサイクル料金、リサイクル券、自動車税種別割その他還付金、返戻金、精算金等を一切請求しない。</li>
      <li>引渡し後に還付金等が発生する場合、その受領権限および経済的利益は引取事業者に帰属する。</li>
      <li>売主は事故歴、修復歴、不具合、残債、所有権留保その他重要事項を正確に申告する。</li>
      <li>本契約に関する紛争は、引取事業者所在地を管轄する裁判所を第一審の専属的合意管轄裁判所とする。</li>
    </ol>
  `;
}

function updatePreview() {
  const preview = document.querySelector("#contract-preview");
  const status = document.querySelector("#preview-status");
  const contract = currentContract();
  const previewContract = {
    ...(contract || {}),
    id: contract?.id || activeId,
    data: getFormData(),
    signatureData,
  };

  preview.innerHTML = renderDocument(previewContract);
  status.textContent = contract?.status || "下書き";
  document.querySelector("#editor-title").textContent = contract
    ? `${contract.id} を編集中`
    : "新規契約作成";
  buildEmailBody();
}

function renderList() {
  const list = document.querySelector("#contract-list");
  const query = document.querySelector("#contract-search").value.trim().toLowerCase();

  const filtered = contracts.filter((contract) => {
    const data = contract.data || {};
    const text = [contract.id, data.sellerName, data.sellerPhone, data.carName, data.plateNumber]
      .join(" ")
      .toLowerCase();
    const statusOk = activeFilter === "all" || contract.status === activeFilter;
    return statusOk && (!query || text.includes(query));
  });

  if (!filtered.length) {
    list.innerHTML = '<p class="empty-state">契約データはまだありません。</p>';
    return;
  }

  list.innerHTML = filtered
    .map((contract) => {
      const data = contract.data || {};
      const active = contract.id === activeId ? "active" : "";
      return `
        <button class="contract-list-item ${active}" type="button" data-id="${contract.id}">
          <span>
            <strong>${safeValue(data.sellerName, "氏名未入力")}</strong>
            <small>${safeValue(data.carName, "車名未入力")} / ${escapeHtml(contractTypeLabel(data))}</small>
          </span>
          <em>${escapeHtml(contract.status)}</em>
        </button>
      `;
    })
    .join("");
}

function updateModePanels() {
  const data = getFormData();
  const isFree = data.contractType === "free";
  const isTablet = data.completionMethod === "tablet";
  const isEmail = data.completionMethod === "email";

  document.querySelector('[name="purchaseAmount"]').disabled = isFree;
  document.querySelector('[name="paymentMethod"]').value = isFree
    ? "支払いなし"
    : document.querySelector('[name="paymentMethod"]').value || "振込";
  document.querySelector("#signature-panel").hidden = !isTablet;
  document.querySelector("#email-panel").hidden = !isEmail;
}

function buildEmailBody() {
  const data = getFormData();
  const url = document.querySelector("#email-url").value.trim() || "【確認URLをここに入力】";
  const passcode = document.querySelector("#consent-passcode").value.trim();
  const body = [
    `${safePlain(data.sellerName, "お客様")} 様`,
    "",
    "オーダーオートです。",
    "車両契約の内容確認をお願いいたします。",
    "",
    `契約区分：${contractTypeLabel(data)}`,
    `車両：${safePlain(data.carName)} ${safePlain(data.plateNumber)}`,
    `金額：${data.contractType === "free" ? "0円" : yen(data.purchaseAmount)}`,
    "",
    `確認URL：${url}`,
    "",
    "確認URLは暗号化されています。",
    "開封パスコードは安全のため、このメールには記載していません。",
    "別途お伝えするパスコードを入力し、内容をご確認のうえ、重要事項に同意して契約を完了してください。",
    passcode ? "" : "※先に「暗号化URL生成」を押して確認URLとパスコードを作成してください。",
    "",
    "オーダーオート",
    `代表 ${COMPANY.representative}`,
    COMPANY.address,
    `TEL ${COMPANY.phone}`,
  ].join("\n");

  document.querySelector("#email-body").value = body;
}

function buildLineMessage() {
  const data = getFormData();
  const url = document.querySelector("#email-url").value.trim() || "【確認URL】";

  return [
    `${safePlain(data.sellerName, "お客様")} 様`,
    "",
    "オーダーオートです。",
    "車両契約の内容確認をお願いします。",
    "",
    `契約区分：${contractTypeLabel(data)}`,
    `車両：${safePlain(data.carName)} ${safePlain(data.plateNumber)}`,
    "",
    `確認URL：${url}`,
    "",
    "開封パスコードは安全のため、このLINEには記載していません。",
    "別途お伝えする8桁のパスコードを入力して確認してください。",
  ].join("\n");
}

function bytesToBase64Url(bytes) {
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function generatePasscode() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const number = bytes.reduce((acc, byte) => acc * 256 + byte, 0) % 100000000;
  return String(number).padStart(8, "0");
}

async function deriveEncryptionKey(passcode, salt) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passcode),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: CRYPTO_ITERATIONS,
      hash: "SHA-256",
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
}

async function encryptPayload(payload, passcode) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveEncryptionKey(passcode, salt);
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);

  return {
    v: 1,
    kdf: "PBKDF2-SHA256",
    iterations: CRYPTO_ITERATIONS,
    salt: bytesToBase64Url(salt),
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
  };
}

function buildConsentPayload(contract = currentContract()) {
  const data = getFormData();
  const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
  return {
    id: contract?.id || activeId,
    createdAt: contract?.createdAt || formatDateTime(),
    expiresAt,
    data,
    company: COMPANY,
  };
}

async function generateConsentUrl() {
  saveActiveContract("送信済み");
  const payload = buildConsentPayload();
  const passcode = generatePasscode();
  const encrypted = await encryptPayload(payload, passcode);
  const encoded = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(encrypted)));
  const url = new URL("consent.html", window.location.href);
  url.hash = `payload=${encoded}`;
  document.querySelector("#email-url").value = url.toString();
  document.querySelector("#consent-passcode").value = passcode;
  buildEmailBody();
  setSaveStatus(
    "暗号化した確認URLと開封パスコードを生成しました。パスコードは別送してください。",
    "success",
  );
}

async function copyConsentUrl() {
  const field = document.querySelector("#email-url");
  if (!field.value.trim()) {
    await generateConsentUrl();
  }

  try {
    await navigator.clipboard.writeText(field.value);
    setSaveStatus("お客様確認URLをコピーしました。", "success");
  } catch (error) {
    field.select();
    setSaveStatus("URL欄を選択しました。手動でコピーしてください。", "warning");
  }
}

async function copyConsentPasscode() {
  const field = document.querySelector("#consent-passcode");
  if (!field.value.trim()) {
    await generateConsentUrl();
  }

  try {
    await navigator.clipboard.writeText(field.value);
    setSaveStatus("開封パスコードをコピーしました。URLとは別経路で送ってください。", "success");
  } catch (error) {
    field.select();
    setSaveStatus("パスコード欄を選択しました。手動でコピーしてください。", "warning");
  }
}

async function copyLineMessage() {
  if (!document.querySelector("#email-url").value.trim()) {
    await generateConsentUrl();
  }

  const message = buildLineMessage();

  try {
    await navigator.clipboard.writeText(message);
    setSaveStatus("LINE送信用の文面をコピーしました。パスコードは別送してください。", "success");
  } catch (error) {
    setSaveStatus("LINE文面をコピーできませんでした。URLコピーを使って手動で送ってください。", "warning");
  }
}

async function handleIdentityPhotoSelect(event) {
  const files = Array.from(event.target.files || []);
  event.target.value = "";
  if (!files.length) return;

  const available = MAX_IDENTITY_FILES - identityFiles.length;
  if (available <= 0) {
    setSaveStatus(`本人確認書類の写真は最大${MAX_IDENTITY_FILES}枚までです。`, "warning");
    return;
  }

  const selected = files.slice(0, available);
  if (files.length > available) {
    setSaveStatus(`最大${MAX_IDENTITY_FILES}枚までのため、先頭${available}枚だけ追加します。`, "warning");
  } else {
    setSaveStatus("本人確認書類の写真を読み込み中です。", "pending");
  }

  try {
    const compressed = [];
    for (const file of selected) {
      compressed.push(await compressIdentityImage(file));
    }
    identityFiles = [...identityFiles, ...compressed];
    renderIdentityFiles();
    const saved = saveActiveContract(currentContract()?.status || "下書き");
    if (saved) {
      setSaveStatus("本人確認書類の写真を添付しました。この端末内に保存されています。", "success");
    }
  } catch (error) {
    setSaveStatus(error.message || "本人確認書類の写真を読み込めませんでした。", "warning");
  }
}

function exportContracts() {
  const payload = {
    exportedAt: formatDateTime(),
    source: "order-auto-contract-system",
    contracts,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `order-auto-contracts-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  setSaveStatus("契約データのJSONバックアップを出力しました。", "success");
}

function importContractsFile(file) {
  if (!file) return;

  const reader = new FileReader();
  reader.addEventListener("load", () => {
    try {
      const parsed = JSON.parse(String(reader.result || "{}"));
      const imported = Array.isArray(parsed) ? parsed : parsed.contracts;

      if (!Array.isArray(imported)) {
        throw new Error("Invalid contract backup");
      }

      const existingIds = new Set(contracts.map((contract) => contract.id));
      const normalized = imported
        .filter((contract) => contract && contract.id && contract.data)
        .map((contract) => {
          if (!existingIds.has(contract.id)) return contract;
          return {
            ...contract,
            id: `${contract.id}-IMPORT-${Date.now()}`,
            updatedAt: formatDateTime(),
          };
        });

      contracts = [...normalized, ...contracts];
      activeId = contracts[0]?.id || "";
      persistContracts();
      populateForm(currentContract());
      renderList();
      setSaveStatus(`${normalized.length}件の契約データを取り込みました。`, "success");
    } catch (error) {
      setSaveStatus("JSONを取り込めませんでした。ファイル内容を確認してください。", "warning");
    }
  });
  reader.readAsText(file);
}

function buildCloudPayload(contract = currentContract()) {
  const data = getFormData();
  const snapshot = {
    id: contract?.id || activeId,
    status: contract?.status || "下書き",
    createdAt: contract?.createdAt || "",
    updatedAt: contract?.updatedAt || "",
    completedAt: contract?.completedAt || "",
    signedAt: contract?.signedAt || "",
    data,
    signatureSaved: Boolean(signatureData),
    identityFiles: identityFileSummary(contract?.identityFiles || identityFiles),
    savedAt: formatDateTime(),
  };

  return {
    "form-name": CLOUD_FORM_NAME,
    contractId: snapshot.id,
    status: snapshot.status || "下書き",
    contractType: contractTypeLabel(data),
    completionMethod: completionLabel(data),
    sellerName: data.sellerName || "",
    sellerLastName: data.sellerLastName || "",
    sellerFirstName: data.sellerFirstName || "",
    sellerPhone: data.sellerPhone || "",
    sellerEmail: data.sellerEmail || "",
    identityPhotoCount: String(identityFiles.length),
    carName: data.carName || "",
    plateNumber: data.plateNumber || "",
    plateArea: data.plateArea || "",
    plateClass: data.plateClass || "",
    plateKana: data.plateKana || "",
    plateNumberDigits: data.plateNumberDigits || "",
    purchaseAmount: data.contractType === "free" ? "0" : data.purchaseAmount || "",
    contractJson: JSON.stringify(snapshot),
    previewText: document.querySelector("#contract-preview")?.innerText || "",
  };
}

async function submitCloudRecord() {
  saveActiveContract(currentContract()?.status || "下書き");
  setSaveStatus("Netlifyへ送信中です。", "pending");

  const payload = buildCloudPayload();

  try {
    const response = await fetch("/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(payload).toString(),
      keepalive: true,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const contract = currentContract();
    if (contract) {
      contract.cloudSavedAt = formatDateTime();
      persistContracts();
    }
    setSaveStatus("Netlify Formsに送信しました。管理画面のFormsで確認できます。", "success");
  } catch (error) {
    setSaveStatus(
      "この端末には保存済みです。Netlify公開環境ではFormsへ送信されます。",
      "warning",
    );
  }
}

function safePlain(value, fallback = "未入力") {
  const cleaned = String(value ?? "").trim();
  return cleaned || fallback;
}

async function openEmail() {
  if (!document.querySelector("#email-url").value.trim()) {
    await generateConsentUrl();
  }
  saveActiveContract("送信済み");
  const data = getFormData();
  const subject = `契約内容確認のお願い（${contractTitle(data)}）`;
  const params = new URLSearchParams({
    subject,
    body: document.querySelector("#email-body").value,
  });
  window.location.href = `mailto:${encodeURIComponent(data.sellerEmail || "")}?${params.toString()}`;
}

function setupSignatureCanvas() {
  const canvas = document.querySelector("#signature-canvas");
  const context = canvas.getContext("2d");
  context.lineWidth = 4;
  context.lineCap = "round";
  context.strokeStyle = "#17211f";

  function point(event) {
    const rect = canvas.getBoundingClientRect();
    const touch = event.touches?.[0];
    const clientX = touch ? touch.clientX : event.clientX;
    const clientY = touch ? touch.clientY : event.clientY;
    return {
      x: ((clientX - rect.left) / rect.width) * canvas.width,
      y: ((clientY - rect.top) / rect.height) * canvas.height,
    };
  }

  function start(event) {
    event.preventDefault();
    isDrawing = true;
    const next = point(event);
    context.beginPath();
    context.moveTo(next.x, next.y);
  }

  function move(event) {
    if (!isDrawing) return;
    event.preventDefault();
    const next = point(event);
    context.lineTo(next.x, next.y);
    context.stroke();
  }

  function stop() {
    isDrawing = false;
  }

  canvas.addEventListener("mousedown", start);
  canvas.addEventListener("mousemove", move);
  window.addEventListener("mouseup", stop);
  canvas.addEventListener("touchstart", start, { passive: false });
  canvas.addEventListener("touchmove", move, { passive: false });
  window.addEventListener("touchend", stop);

  document.querySelector("#clear-signature").addEventListener("click", () => {
    context.clearRect(0, 0, canvas.width, canvas.height);
    signatureData = "";
    saveActiveContract("署名待ち");
  });

  document.querySelector("#save-signature").addEventListener("click", () => {
    signatureData = canvas.toDataURL("image/png");
    const contract = currentContract();
    if (contract) contract.signedAt = formatDateTime();
    saveActiveContract("署名待ち");
  });
}

function setupEvents() {
  const form = document.querySelector("#contract-form");

  document.querySelector("#admin-logout").addEventListener("click", () => {
    window.OrderAutoAdminAuth.logout();
  });

  form.addEventListener("input", (event) => {
    if (event.target.name === "contractType") {
      renderConsents(form.elements.contractType.value, []);
    }
    updateModePanels();
    updatePreview();
  });

  form.addEventListener("change", (event) => {
    if (event.target.name === "contractType") {
      renderConsents(form.elements.contractType.value, []);
    }
    updateModePanels();
    updatePreview();
  });

  document.querySelector("#new-contract").addEventListener("click", createBlankContract);
  document.querySelector("#export-contracts").addEventListener("click", exportContracts);
  document.querySelector("#import-contracts").addEventListener("click", () => {
    document.querySelector("#import-contract-file").click();
  });
  document.querySelector("#import-contract-file").addEventListener("change", (event) => {
    importContractsFile(event.target.files?.[0]);
    event.target.value = "";
  });
  document.querySelector("#save-contract").addEventListener("click", () => saveActiveContract("下書き"));
  document.querySelector("#cloud-save-contract").addEventListener("click", submitCloudRecord);
  document.querySelector("#complete-contract").addEventListener("click", () => {
    const contract = currentContract();
    if (contract) contract.completedAt = formatDateTime();
    saveActiveContract("完了");
    submitCloudRecord();
  });
  document.querySelector("#print-contract").addEventListener("click", () => {
    saveActiveContract(currentContract()?.status || "下書き");
    window.print();
  });
  document.querySelector("#generate-consent-url").addEventListener("click", () => {
    generateConsentUrl();
  });
  document.querySelector("#copy-consent-url").addEventListener("click", copyConsentUrl);
  document.querySelector("#copy-line-message").addEventListener("click", copyLineMessage);
  document.querySelector("#copy-consent-passcode").addEventListener("click", copyConsentPasscode);
  document.querySelector("#open-email").addEventListener("click", openEmail);
  document.querySelector("#email-url").addEventListener("input", buildEmailBody);
  document.querySelector("#contract-search").addEventListener("input", renderList);
  document.querySelector("#identity-photo-input").addEventListener("change", handleIdentityPhotoSelect);
  document.querySelectorAll("[data-date-picker]").forEach((button) => {
    button.addEventListener("click", () => {
      const field = form.elements[button.dataset.datePicker];
      if (!field) return;
      if (typeof field.showPicker === "function") {
        field.showPicker();
      } else {
        field.focus();
      }
    });
  });
  document.querySelector("#identity-photo-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove-identity-photo]");
    if (!button) return;
    const index = Number(button.dataset.removeIdentityPhoto);
    identityFiles = identityFiles.filter((_, itemIndex) => itemIndex !== index);
    renderIdentityFiles();
    saveActiveContract(currentContract()?.status || "下書き");
    setSaveStatus("本人確認書類の写真を削除しました。", "success");
  });

  document.querySelector("#contract-list").addEventListener("click", (event) => {
    const item = event.target.closest("[data-id]");
    if (!item) return;
    saveActiveContract();
    activeId = item.dataset.id;
    populateForm(currentContract());
    renderList();
  });

  document.querySelectorAll(".status-tabs button").forEach((button) => {
    button.addEventListener("click", () => {
      activeFilter = button.dataset.filter;
      document.querySelectorAll(".status-tabs button").forEach((item) => {
        item.classList.toggle("active", item === button);
      });
      renderList();
    });
  });
}

document.addEventListener("DOMContentLoaded", () => {
  loadContracts();
  setupEvents();
  setupSignatureCanvas();

  if (!contracts.length) {
    createBlankContract();
  } else {
    activeId = contracts[0].id;
    populateForm(currentContract());
    renderList();
  }
});
