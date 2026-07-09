const STORAGE_KEY = "orderAutoContracts";
const COMPANY = {
  name: "オーダーオート",
  representative: "空 篤志",
  address: "広島県広島市佐伯区皆賀1-10-20",
  phone: "080-2912-8616",
};

const COMMON_CONSENTS = [
  "車両情報に間違いありません",
  "事故歴・修復歴・不具合について、知る限り正確に申告しました",
  "引渡し後の名義変更・抹消登録手続きに協力します",
];

const PAID_CONSENTS = [
  "表示された買取金額に同意します",
  "還付金等は買取金額に含まれることに同意します",
];

const ZERO_AMOUNT_CONSENTS = [
  "買取金額が0円であることに同意します",
  "引取後に買取代金を請求しません",
  "自動車重量税の還付を請求しません",
  "自賠責保険料の返戻金を請求しません",
  "リサイクル券・リサイクル料金の返金を請求しません",
  "自動車税種別割の還付を請求しません",
  "還付金等が発生する可能性を理解したうえで同意します",
];

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

function hasAmountInput(data) {
  return String(data?.purchaseAmount ?? "").trim() !== "";
}

function isZeroAmountContract(data) {
  if (data?.contractType === "free") return true;
  if (!hasAmountInput(data)) return false;
  const number = Number(data.purchaseAmount);
  return Number.isFinite(number) && number <= 0;
}

function amountLabel(data) {
  if (!hasAmountInput(data)) return "";
  return isZeroAmountContract(data) ? "0円" : yen(data.purchaseAmount);
}

function consentItems(data) {
  return [
    ...COMMON_CONSENTS,
    ...(isZeroAmountContract(data) ? ZERO_AMOUNT_CONSENTS : PAID_CONSENTS),
  ];
}

function normalizeContractMode(data) {
  if (!data || data.contractType !== "free") return;
  if (!hasAmountInput(data)) data.purchaseAmount = "0";
  data.contractType = "unified";
}

function contractNumberValue(contract) {
  const value = Number(contract?.contractNumber ?? contract?.data?.contractNumber);
  return Number.isInteger(value) && value > 0 ? value : 0;
}

function nextContractNumber() {
  const maxNumber = contracts.reduce((max, contract) => {
    return Math.max(max, contractNumberValue(contract));
  }, 0);
  return maxNumber + 1;
}

function ensureContractNumbers() {
  const used = new Set(
    contracts
      .map(contractNumberValue)
      .filter((value) => value > 0),
  );
  let nextNumber = 1;

  contracts
    .slice()
    .reverse()
    .forEach((contract) => {
      if (!contract || contractNumberValue(contract)) return;
      while (used.has(nextNumber)) nextNumber += 1;
      contract.contractNumber = nextNumber;
      used.add(nextNumber);
    });
}

function loadContracts() {
  try {
    contracts = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch (error) {
    contracts = [];
  }
  ensureContractNumbers();
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

function cloudEnabled() {
  return Boolean(window.OrderAutoCloud?.isConfigured() && window.OrderAutoCloud?.isAuthenticated());
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
  data.contractType = form.elements.contractType?.value || "unified";
  data.completionMethod = form.elements.completionMethod.value;
  data.consents = new FormData(form).getAll("consents");
  normalizeSellerNameFields(data);
  normalizePlateNumberFields(data);

  if (isZeroAmountContract(data) && !data.paymentMethod) {
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
  normalizeContractMode(data);
  Object.entries(data).forEach(([key, value]) => {
    if (key === "documents" || key === "consents") return;
    setFieldValue(form, key, value);
  });

  form.querySelectorAll('input[name="documents"]').forEach((checkbox) => {
    checkbox.checked = (data.documents || []).includes(checkbox.value);
  });

  renderConsents(data, data.consents || []);
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
    contractNumber: nextContractNumber(),
    status: "下書き",
    createdAt: formatDateTime(),
    updatedAt: formatDateTime(),
    completedAt: "",
    signedAt: "",
    signatureData: "",
    identityFiles: [],
    data: {
      contractType: "unified",
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

async function loadCloudContracts() {
  if (!cloudEnabled()) return;

  try {
    setSaveStatus("Supabaseから契約一覧を読み込み中です。", "pending");
    const cloudContracts = await window.OrderAutoCloud.listContracts();
    if (cloudContracts.length) {
      const localById = new Map(contracts.map((contract) => [contract.id, contract]));
      contracts = cloudContracts.map((cloudContract) => ({
        ...(localById.get(cloudContract.id) || {}),
        ...cloudContract,
      }));
      ensureContractNumbers();
      activeId = contracts[0]?.id || activeId;
      persistContracts();
      populateForm(currentContract());
      renderList();
    }
    setSaveStatus("Supabaseと同期しました。", "success");
  } catch (error) {
    setSaveStatus("Supabaseから契約一覧を読み込めませんでした。ローカル保存で続行します。", "warning");
  }
}

async function syncActiveContractToCloud() {
  if (!cloudEnabled()) return false;
  const contract = currentContract();
  if (!contract) return false;

  try {
    setSaveStatus("Supabaseへ保存中です。", "pending");
    const identitySummary = await window.OrderAutoCloud.uploadIdentityFiles(
      contract.id,
      contract.identityFiles || [],
    );
    const saved = await window.OrderAutoCloud.upsertContract(contract, identitySummary);
    if (saved) {
      contract.cloudSavedAt = formatDateTime();
      contract.consentStatus = saved.consentStatus || contract.consentStatus || "";
      persistContracts();
      renderList();
    }
    setSaveStatus("Supabaseへ保存しました。", "success");
    return true;
  } catch (error) {
    setSaveStatus("Supabaseへ保存できませんでした。この端末には保存済みです。", "warning");
    return false;
  }
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
    setSaveStatus("この端末に保存しました。Supabase設定後はクラウドにも保存できます。");
  }
  return saved;
}

function contractTitle(data) {
  return data.completionMethod === "paper" ? "車両売買契約書" : "電子車両売買契約書";
}

function contractTypeLabel(data) {
  return isZeroAmountContract(data) ? "売買契約（買取金額0円）" : "売買契約";
}

function completionLabel(data) {
  const labels = {
    paper: "紙で印刷",
    tablet: "タブレット署名",
    email: "メール電子同意",
  };
  return labels[data.completionMethod] || "紙で印刷";
}

function renderConsents(data, checkedItems = []) {
  const list = document.querySelector("#consent-list");
  list.innerHTML = consentItems(data)
    .map((text) => {
      const checked = checkedItems.includes(text) ? "checked" : "";
      return `<label><input type="checkbox" name="consents" value="${escapeHtml(text)}" ${checked} />${escapeHtml(text)}</label>`;
    })
    .join("");
}

function row(label, value) {
  return `<div><dt>${escapeHtml(label)}</dt><dd>${safeValue(value)}</dd></div>`;
}

function formValue(value) {
  return safeValue(value, "");
}

function dateParts(value) {
  const cleaned = String(value || "").trim();
  const match = cleaned.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return { year: "", month: "", day: "", raw: cleaned };
  return { year: match[1], month: String(Number(match[2])), day: String(Number(match[3])), raw: cleaned };
}

function dateLine(value) {
  const parts = dateParts(value);
  if (parts.year) {
    return `${escapeHtml(parts.year)} 年 ${escapeHtml(parts.month)} 月 ${escapeHtml(parts.day)} 日`;
  }
  return formValue(value) || "　 年 　月 　日";
}

function amountNumber(data) {
  if (!hasAmountInput(data)) return "";
  if (isZeroAmountContract(data)) return "0";
  const number = Number(data.purchaseAmount);
  if (!Number.isFinite(number) || number < 0) return "";
  return String(Math.round(number));
}

function yenBox(data) {
  const amount = amountNumber(data);
  return amount ? `${Number(amount).toLocaleString("ja-JP")}` : "";
}

function amountDigitCells(data) {
  const amount = amountNumber(data);
  const digits = amount ? amount.slice(-7).padStart(7, " ") : "       ";
  return Array.from(digits)
    .map((digit) => `<td>${escapeHtml(digit.trim())}</td>`)
    .join("");
}

function choiceMark(value, expected) {
  return String(value || "") === expected ? "●" : "○";
}

function documentCheck(documents, name) {
  return documents.includes(name) ? "☑" : "□";
}

function displayContractNumber(contract) {
  const number = contractNumberValue(contract);
  return number ? String(number) : "1";
}

function renderDocument(contract) {
  const data = contract?.data || getFormData();
  const documents = data.documents || [];
  const contractDate = dateParts(new Date().toISOString().slice(0, 10));
  const sellerBirth = dateParts(data.sellerBirthdate);
  const amount = yenBox(data);
  const signatureBlock = signatureData
    ? `<img class="signature-image" src="${signatureData}" alt="売主電子署名" />`
    : "";
  const bankLine = [data.bankName, data.branchName, data.accountType].filter(Boolean).join(" / ");
  const sellerPhone = [data.sellerPhone, data.sellerMobile].filter(Boolean).join(" / ");

  return `
    <article class="print-sheet vehicle-contract-sheet">
      <header class="vehicle-contract-head">
        <div class="contract-date">契約日： ${contractDate.year || "　"} 年 ${contractDate.month || "　"} 月 ${contractDate.day || "　"} 日</div>
        <h2>車両売買契約書</h2>
        <div class="contract-number">
          <span>（お客様控え）</span>
          契約書番号 No. ${escapeHtml(displayContractNumber(contract))}
        </div>
      </header>

      <p class="vehicle-contract-guide">お客様へ、裏面の契約条項をご確認いただきご承認いただいたうえで太枠線内にご記入ください。</p>

      <section class="vehicle-form-section">
        <h3>1.契約車両の表示及び状況 <span>査定ID：</span></h3>
        <table class="vehicle-form-table vehicle-info-table">
          <tr>
            <th>車　名</th>
            <td colspan="6">${formValue(data.carName)}</td>
            <th>車台番号</th>
            <td colspan="5">${formValue(data.chassisNumber)}</td>
          </tr>
          <tr>
            <th>グレード</th>
            <td colspan="6">${formValue(data.carGrade)}</td>
            <th>登録番号</th>
            <td colspan="5">${formValue(data.plateNumber)}</td>
          </tr>
          <tr>
            <th>年　式</th>
            <td colspan="2">${formValue(data.carYear)}</td>
            <th>色</th>
            <td colspan="3">${formValue(data.carColor)}</td>
            <th>在庫番号</th>
            <td colspan="5"></td>
          </tr>
          <tr>
            <th>走行距離</th>
            <td colspan="3">${formValue(data.mileage)}</td>
            <td colspan="9" class="condition-line">
              エンジンの不具合 ${choiceMark(data.defect, "無")}無・${choiceMark(data.defect, "有")}有　
              オートマミッションの不具合 ○無・○有　
              パワーステアリングの不具合 ○無・○有<br>
              サスペンションの不具合 ○無・○有　
              走行上の不都合 ${choiceMark(data.drivable, "可")}無・${choiceMark(data.drivable, "不可")}有
            </td>
          </tr>
          <tr>
            <th>駐車違反放置違反金未納</th>
            <td colspan="2">○無・○有</td>
            <th>修復歴</th>
            <td colspan="2">${choiceMark(data.repairHistory, "無")}無・${choiceMark(data.repairHistory, "有")}有</td>
            <th colspan="3">メーター戻し・交換・走行距離不明</th>
            <td colspan="2">○無・○有</td>
            <th>災害歴</th>
            <td>○無・○有</td>
          </tr>
        </table>
      </section>

      <section class="vehicle-form-section">
        <h3>2.売買契約金額 <small>（消費税等込み）</small></h3>
        <div class="amount-area">
          <table class="vehicle-form-table amount-table">
            <tr class="amount-labels">
              <th></th><th>百万</th><th>十万</th><th>万</th><th>千</th><th>百</th><th>十</th><th>一</th><th>円</th>
            </tr>
            <tr class="amount-digits">
              <td></td>${amountDigitCells(data)}<td>円</td>
            </tr>
          </table>
          <p>
            なお、左記価格は自賠責保険未経過保険料相当額、未経過自動車税、重量税、リサイクル預託金額を含むものとします。
          </p>
        </div>

        <table class="vehicle-form-table money-table">
          <tr>
            <th>自動車税（種別割）</th>
            <td>完納・未納・課税保留・減免</td>
            <th>未納金額</th>
            <td class="yen-field">円</td>
          </tr>
          <tr>
            <th>残債先</th>
            <td>${formValue(data.loanCompany)}</td>
            <th>残債金額</th>
            <td class="yen-field">円</td>
          </tr>
          <tr>
            <th rowspan="3" class="vertical-label">振込先</th>
            <td>${formValue(bankLine) || "銀行　　　　　　　　　支店"}</td>
            <th rowspan="3">口座番号<br><small>右詰めでご記入ください</small></th>
            <td rowspan="3">
              <div class="account-line">口座番号　${formValue(data.accountNumber)}</div>
              <div>カナ　${formValue(data.accountHolder)}</div>
              <div>漢字　${formValue(data.accountHolder)}</div>
            </td>
          </tr>
          <tr><td>普通・当座　${formValue(data.accountType)}</td></tr>
          <tr><td>ゆうちょ銀行　記号　　　　番号</td></tr>
          <tr>
            <th colspan="2">支払代金</th>
            <td colspan="2" class="yen-field">${escapeHtml(amount)} 円</td>
          </tr>
        </table>
      </section>

      <section class="vehicle-form-section">
        <h3>3.車両引渡期限、移転登録書類等 引渡期限及び支払期限</h3>
        <table class="vehicle-form-table deadline-table">
          <tr>
            <th>車両引渡期限</th>
            <td>${dateLine(data.pickupDate)}</td>
            <th>書類引渡期限</th>
            <td></td>
            <th>支払期限</th>
            <td>${dateLine(data.paymentDate)}</td>
          </tr>
        </table>
      </section>

      <section class="vehicle-form-section">
        <h3>4.特記事項</h3>
        <div class="special-note">${formValue(data.vehicleNote)}</div>
      </section>

      <section class="vehicle-form-section">
        <h3>5.お振込口座 <small>口座名義は原則として申込者（売主）またはご所有者のものに限ります。</small></h3>
        <table class="vehicle-form-table bank-table">
          <tr>
            <th rowspan="3" class="vertical-label">振込先</th>
            <td>${formValue(bankLine) || "銀行　　　　　　　　　支店"}</td>
            <th rowspan="3">口座番号<br><small>右詰めでご記入ください</small></th>
            <td rowspan="3">
              <div>口座番号　${formValue(data.accountNumber)}</div>
              <div>カナ　${formValue(data.accountHolder)}</div>
              <div>漢字　${formValue(data.accountHolder)}</div>
            </td>
          </tr>
          <tr><td>普通・当座　${formValue(data.accountType)}</td></tr>
          <tr><td>ゆうちょ銀行　記号　　　　番号</td></tr>
        </table>
        <p class="payment-note">支払代金は、原則として車両及び移転登録書類等の引渡しがいずれも完了した日の翌日を起算日とする金融機関の3営業日以内に、お振込いたします。</p>
      </section>

      <section class="vehicle-form-section">
        <h3>6.車両名義人 <small>申込者（売主）は、車両の名義人がご自身と異なる場合、正当な権限があることを保証します。</small></h3>
        <table class="vehicle-form-table owner-table">
          <tr><th>所有者</th><td>申込者・販売会社・信販会社・その他（名義人　　　　　　　　　）</td><th>申込者との関係</th><td></td></tr>
          <tr><th>使用者</th><td>申込者・その他（名義人　　　　　　　　　）</td><th>申込者との関係</th><td></td></tr>
        </table>
      </section>

      <p class="application-statement">
        売主は買主に対し、上記内容及び裏面の契約条項を承認し、上記車両について売買契約を締結します。
      </p>

      <section class="party-boxes">
        <div class="party-box buyer-box">
          <h3>買主</h3>
          <p class="buyer-address">${escapeHtml(COMPANY.address)}</p>
          <p class="buyer-company">${escapeHtml(COMPANY.name)}</p>
          <p class="buyer-rep">代表　${escapeHtml(COMPANY.representative)}</p>
          <div class="shop-line">店</div>
          <div>担当者</div>
          <div>TEL　${escapeHtml(COMPANY.phone)}</div>
        </div>
        <div class="party-box seller-box">
          <h3>売主</h3>
          <div class="seller-grid">
            <span>フリガナ</span><strong>${formValue(data.sellerKana)}</strong><em>印</em>
            <span>お名前</span><strong>${formValue(data.sellerName)}</strong><em></em>
            <span>〒</span><strong>${formValue(data.sellerAddress)}</strong><em></em>
            <span>ご住所</span><strong></strong><em></em>
            <span>電話</span><strong>${formValue(sellerPhone)}</strong><em></em>
            <span>生年月日</span><strong>${sellerBirth.year || "　"} 年 ${sellerBirth.month || "　"} 月 ${sellerBirth.day || "　"} 日</strong><em></em>
            <span>ご勤務先名</span><strong>${formValue(data.workplace)}</strong><em></em>
          </div>
          ${signatureBlock ? `<div class="seller-signature">${signatureBlock}</div>` : ""}
        </div>
      </section>

      <section class="identity-row">
        <div>身分証明書番号※左づめで記入</div>
        <div class="identity-cells"></div>
        <div>${documentCheck(documents, "本人確認書類")}本人であることを確認しました。</div>
        <div>社長</div>
        <div>拠点長</div>
      </section>
      <section class="identity-row identity-docs">
        <div>本人確認書類　${escapeHtml(data.identityType || "")}</div>
        <div>運転免許証　パスポート　健康保険証　その他（　　　）</div>
        <div>担当者署名</div>
        <div>管理者署名</div>
      </section>

      <footer class="vehicle-contract-footer">
        このたびはご利用ありがとうございました。<br>
        この書面は、お客様がお車を売却された事を証明する書類ですので、大切に保管してください。
      </footer>
    </article>
  `;
}

function unifiedTerms(data) {
  const zeroAmountItems = isZeroAmountContract(data)
    ? `
      <li>本契約における買取金額は0円とし、買主または引取事業者は売主に買取代金その他名目を問わず金銭を支払わない。</li>
      <li>売主は、自動車重量税、自賠責保険料、リサイクル料金、リサイクル券、自動車税種別割その他還付金、返戻金、精算金等を一切請求しない。</li>
      <li>引渡し後に還付金等が発生する場合、その受領権限および経済的利益は買主または引取事業者に帰属する。</li>
    `
    : `
      <li>売買代金は本契約書に表示された金額とし、買主は現金または振込により支払う。</li>
      <li>自動車重量税、自賠責保険料、リサイクル料金、自動車税種別割その他還付金等は売買代金に含まれ、売主は別途請求しない。</li>
    `;

  return `
    <ol class="terms-list">
      <li>売主は対象車両を買主または引取事業者に譲渡し、買主または引取事業者はこれを買い受け、または引き取る。</li>
      ${zeroAmountItems}
      <li>売主は事故歴、修復歴、不具合、残債、所有権留保その他重要事項を正確に申告する。</li>
      <li>申告内容に重大な誤りまたは虚偽がある場合、買主または引取事業者は契約解除または売買代金の減額を請求できる。</li>
      <li>本契約に関する紛争は、買主または引取事業者の所在地を管轄する裁判所を第一審の専属的合意管轄裁判所とする。</li>
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
  const isZeroAmount = isZeroAmountContract(data);
  const isTablet = data.completionMethod === "tablet";
  const isEmail = data.completionMethod === "email";

  document.querySelector('[name="paymentMethod"]').value = isZeroAmount
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
    `契約内容：${contractTypeLabel(data)}`,
    `車両：${safePlain(data.carName)} ${safePlain(data.plateNumber)}`,
    `金額：${amountLabel(data) || "未入力"}`,
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
    `契約内容：${contractTypeLabel(data)}`,
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
  if (cloudEnabled()) {
    return {
      id: contract?.id || activeId,
      contractNumber: contract?.contractNumber,
      cloudMode: true,
      createdAt: contract?.createdAt || formatDateTime(),
      expiresAt,
      company: COMPANY,
    };
  }

  return {
    id: contract?.id || activeId,
    contractNumber: contract?.contractNumber,
    createdAt: contract?.createdAt || formatDateTime(),
    expiresAt,
    data,
    company: COMPANY,
  };
}

async function generateConsentUrl() {
  saveActiveContract("送信済み");
  if (cloudEnabled()) {
    await syncActiveContractToCloud();
  }
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
      ensureContractNumbers();
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

async function submitCloudRecord() {
  saveActiveContract(currentContract()?.status || "下書き");

  if (cloudEnabled()) {
    await syncActiveContractToCloud();
    return;
  }

  setSaveStatus(
    "この端末には保存済みです。クラウド保存を使うにはsupabase-config.jsを設定してください。",
    "warning",
  );
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
    if (event.target.name === "purchaseAmount") {
      renderConsents(getFormData(), new FormData(form).getAll("consents"));
    }
    updateModePanels();
    updatePreview();
  });

  form.addEventListener("change", (event) => {
    if (event.target.name === "purchaseAmount") {
      renderConsents(getFormData(), new FormData(form).getAll("consents"));
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

  loadCloudContracts();
});
