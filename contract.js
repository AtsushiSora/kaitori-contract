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
let activePreviewCopy = "customer";
let activeAppPage = "top";
let signatureData = "";
let identityFiles = [];
const identityPreviewUrls = new Map();
let isDrawing = false;

const CRYPTO_ITERATIONS = 200000;
const MAX_IDENTITY_FILES = 4;
const MAX_IDENTITY_FILE_BYTES = 8 * 1024 * 1024;
const IDENTITY_IMAGE_MAX_EDGE = 1600;
const IDENTITY_IMAGE_QUALITY = 0.82;
const POSTAL_CODE_API_URL = "https://zipcloud.ibsnet.co.jp/api/search";

let postalLookupTimer = 0;
let lastPostalLookup = "";

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

function postalCodeDigits(value) {
  return String(value ?? "").replace(/\D/g, "").slice(0, 7);
}

function formatPostalCode(value) {
  const digits = postalCodeDigits(value);
  if (digits.length !== 7) return value;
  return `${digits.slice(0, 3)}-${digits.slice(3)}`;
}

async function fillAddressFromPostalCode(force = false) {
  const form = document.querySelector("#contract-form");
  const postalField = form?.elements.sellerPostalCode;
  const addressField = form?.elements.sellerAddress;
  if (!postalField || !addressField) return;

  const digits = postalCodeDigits(postalField.value);
  if (digits.length !== 7) return;
  if (!force && digits === lastPostalLookup) return;

  lastPostalLookup = digits;

  try {
    const response = await fetch(`${POSTAL_CODE_API_URL}?zipcode=${encodeURIComponent(digits)}`);
    if (!response.ok) throw new Error("postal lookup failed");
    const result = await response.json();
    const record = result?.results?.[0];
    if (!record) {
      setSaveStatus("郵便番号に該当する住所が見つかりませんでした。", "warning");
      return;
    }

    if (postalCodeDigits(postalField.value) !== digits) return;

    postalField.value = formatPostalCode(digits);
    addressField.value = `${record.address1 || ""}${record.address2 || ""}${record.address3 || ""}`;
    setSaveStatus("郵便番号から住所を自動入力しました。", "success");
    updatePreview();
  } catch (error) {
    setSaveStatus("住所を自動入力できませんでした。住所は手入力してください。", "warning");
  }
}

function schedulePostalCodeLookup(force = false) {
  window.clearTimeout(postalLookupTimer);
  postalLookupTimer = window.setTimeout(() => {
    fillAddressFromPostalCode(force);
  }, force ? 0 : 350);
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

function renderIdentityFiles() {
  const list = document.querySelector("#identity-photo-list");
  if (!list) return;

  if (!identityFiles.length) {
    list.innerHTML = '<p class="empty-state">本人確認書類の写真は未添付です。</p>';
    return;
  }

  list.innerHTML = identityFiles
    .map((file, index) => {
      const previewUrl = file.dataUrl || identityPreviewUrls.get(file.storagePath) || "";
      const preview = previewUrl
        ? `<img src="${escapeHtml(previewUrl)}" alt="${escapeHtml(file.name || `本人確認写真${index + 1}`)}" />`
        : '<div class="identity-photo-placeholder">保存済み</div>';
      return `
        <div class="identity-photo-item">
          ${preview}
          <div>
            <strong>${escapeHtml(file.name || `本人確認写真${index + 1}`)}</strong>
            <span>${escapeHtml(formatBytes(file.size))} / ${escapeHtml(file.width)}x${escapeHtml(file.height)}</span>
          </div>
          <button class="mini-button" type="button" data-remove-identity-photo="${index}">削除</button>
        </div>
      `;
    })
    .join("");

  hydrateIdentityPreviews();
}

async function hydrateIdentityPreviews() {
  if (!cloudEnabled() || !window.OrderAutoCloud?.getPrivateFileUrl) return;
  const pending = identityFiles.filter(
    (file) => file.storagePath && !file.dataUrl && !identityPreviewUrls.has(file.storagePath),
  );
  if (!pending.length) return;

  await Promise.all(
    pending.map(async (file) => {
      identityPreviewUrls.set(file.storagePath, "");
      try {
        const url = await window.OrderAutoCloud.getPrivateFileUrl(file.storagePath);
        identityPreviewUrls.set(file.storagePath, url);
      } catch (error) {
        identityPreviewUrls.set(file.storagePath, "");
      }
    }),
  );
  renderIdentityFiles();
}

function getFormData() {
  const form = document.querySelector("#contract-form");
  const data = Object.fromEntries(new FormData(form).entries());
  data.documents = new FormData(form).getAll("documents");
  data.contractType = form.elements.contractType?.value || "unified";
  data.completionMethod = form.elements.completionMethod?.value || "paper";
  data.consents = new FormData(form).getAll("consents");
  syncSellerBirthdate(data);
  normalizeSellerNameFields(data);
  normalizePlateNumberFields(data);
  if (!hasLoan(data)) {
    data.loanStatus = "無";
    data.loanCompany = "";
    data.loanTransferDate = "";
    data.loanBalanceAmount = "";
  }
  if (!hasBankTransfer(data)) {
    data.bankTransferStatus = "無";
    data.bankName = "";
    data.branchName = "";
    data.accountType = "";
    data.accountNumber = "";
    data.accountHolderKana = "";
    data.accountHolder = "";
  }

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

  if (field.type === "checkbox") {
    field.checked = Boolean(value);
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
  splitSellerBirthdate(data);
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

function defaultContractData() {
  return {
    contractType: "unified",
    completionMethod: "paper",
    purchaseAmount: "",
    recycleDepositAmount: "",
    automobileTaxStatus: "完納",
    loanStatus: "無",
    bankTransferStatus: "無",
    paymentMethod: "振込",
    engineDefect: "無",
    transmissionDefect: "無",
    powerSteeringDefect: "無",
    suspensionDefect: "無",
    drivingDefect: "無",
    parkingViolationUnpaid: "無",
    repairHistory: "無",
    meterIssue: "無",
    disasterHistory: "無",
  };
}

function createContractRecord(data = defaultContractData(), status = "下書き") {
  return {
    id: createContractId(),
    contractNumber: nextContractNumber(),
    status,
    createdAt: formatDateTime(),
    updatedAt: formatDateTime(),
    completedAt: "",
    signedAt: "",
    signatureData: "",
    identityFiles: [],
    data,
  };
}

function createBlankContract() {
  const contract = createContractRecord();

  contracts.unshift(contract);
  activeId = contract.id;
  persistContracts();
  populateForm(contract);
  renderList();
  renderRemoteSelectedContract();
}

function clearContractForm(showStatus = true) {
  activeId = "";
  signatureData = "";
  identityFiles = [];
  populateForm({ data: defaultContractData(), signatureData: "", identityFiles: [] });
  renderList();
  renderRemoteSelectedContract();
  clearRemoteSendFields();
  if (showStatus) {
    setSaveStatus("入力内容をクリアしました。保存済みの契約は削除していません。", "success");
  }
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
      activeId = activeAppPage === "create" ? "" : contracts[0]?.id || activeId;
      persistContracts();
      if (activeAppPage === "create") {
        clearContractForm(false);
      } else {
        populateForm(currentContract());
      }
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
      identitySummary.forEach((file, index) => {
        const localDataUrl = contract.identityFiles?.[index]?.dataUrl;
        if (file.storagePath && localDataUrl) {
          identityPreviewUrls.set(file.storagePath, localDataUrl);
        }
      });
      contract.identityFiles = identitySummary;
      identityFiles = identitySummary;
      contract.cloudSavedAt = formatDateTime();
      contract.consentStatus = saved.consentStatus || contract.consentStatus || "";
      persistContracts();
      renderList();
      renderIdentityFiles();
    }
    setSaveStatus("Supabaseへ保存しました。", "success");
    return true;
  } catch (error) {
    setSaveStatus("Supabaseへ保存できませんでした。この端末には保存済みです。", "warning");
    return false;
  }
}

function saveActiveContract(status, options = {}) {
  const createIfMissing = Boolean(options.createIfMissing);
  let existing = currentContract();

  if (!existing) {
    if (!createIfMissing) return false;
    existing = createContractRecord(getFormData(), status || "下書き");
    existing.signatureData = signatureData;
    existing.identityFiles = identityFiles;
    contracts.unshift(existing);
    activeId = existing.id;
  }

  existing.data = getFormData();
  existing.signatureData = signatureData;
  existing.identityFiles = identityFiles;
  existing.status = status || existing.status || "下書き";
  existing.updatedAt = formatDateTime();
  const saved = persistContracts();
  renderList();
  renderRemoteSelectedContract();
  updatePreview();
  if (saved) {
    setSaveStatus("この端末に保存しました。Supabase設定後はクラウドにも保存できます。");
  }
  return saved;
}

async function deleteContract(id) {
  const target = contracts.find((contract) => contract.id === id);
  if (!target) return;

  const label = target.data?.sellerName || target.data?.carName || `契約番号${contractNumberValue(target) || target.id}`;
  const confirmed = window.confirm(`${label} を削除します。よろしいですか？`);
  if (!confirmed) return;

  contracts = contracts.filter((contract) => contract.id !== id);
  if (activeId === id) {
    activeId = contracts[0]?.id || "";
  }
  persistContracts();

  if (activeId) {
    populateForm(currentContract());
  } else {
    document.querySelector("#contract-form").reset();
    signatureData = "";
    identityFiles = [];
    renderIdentityFiles();
    updateModePanels();
    updatePreview();
  }
  renderList();
  setAppPage("list");

  if (cloudEnabled() && window.OrderAutoCloud?.deleteContract) {
    try {
      setSaveStatus("Supabaseから削除中です。", "pending");
      await window.OrderAutoCloud.deleteContract(id);
      setSaveStatus("契約を削除しました。", "success");
    } catch (error) {
      setSaveStatus("この端末から削除しました。Supabase側の削除は確認してください。", "warning");
    }
  } else {
    setSaveStatus("契約を削除しました。", "success");
  }
  renderRemoteSelectedContract();
}

function contractTitle(data) {
  return data.completionMethod === "paper" ? "車両売買契約書" : "電子車両売買契約書";
}

function contractTypeLabel(data) {
  return isZeroAmountContract(data) ? "売買契約（買取金額0円）" : "売買契約";
}

function renderConsents(data, checkedItems = []) {
  const list = document.querySelector("#consent-list");
  if (!list) return;
  list.innerHTML = consentItems(data)
    .map((text) => {
      const checked = checkedItems.includes(text) ? "checked" : "";
      return `<label><input type="checkbox" name="consents" value="${escapeHtml(text)}" ${checked} />${escapeHtml(text)}</label>`;
    })
    .join("");
}

function dateParts(value) {
  const cleaned = String(value || "").trim();
  const match = cleaned.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return { year: "", month: "", day: "", raw: cleaned };
  return { year: match[1], month: String(Number(match[2])), day: String(Number(match[3])), raw: cleaned };
}

function pad2(value) {
  return String(value || "").padStart(2, "0");
}

function joinDateParts(year, month, day) {
  if (!year || !month || !day) return "";
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function splitSellerBirthdate(data) {
  const parts = dateParts(data?.sellerBirthdate);
  if (!parts.year) return;
  data.sellerBirthYear = parts.year;
  data.sellerBirthMonth = parts.month;
  data.sellerBirthDay = parts.day;
}

function syncSellerBirthdate(data) {
  data.sellerBirthdate = joinDateParts(
    data.sellerBirthYear,
    data.sellerBirthMonth,
    data.sellerBirthDay,
  );
  return data.sellerBirthdate;
}

function populateBirthdateSelects() {
  const form = document.querySelector("#contract-form");
  if (!form?.elements.sellerBirthYear) return;

  const currentYear = new Date().getFullYear();
  const yearOptions = ['<option value="">年</option>'];
  for (let year = currentYear; year >= 1920; year -= 1) {
    yearOptions.push(`<option value="${year}">${year}年</option>`);
  }

  const monthOptions = ['<option value="">月</option>'];
  for (let month = 1; month <= 12; month += 1) {
    monthOptions.push(`<option value="${month}">${month}月</option>`);
  }

  const dayOptions = ['<option value="">日</option>'];
  for (let day = 1; day <= 31; day += 1) {
    dayOptions.push(`<option value="${day}">${day}日</option>`);
  }

  form.elements.sellerBirthYear.innerHTML = yearOptions.join("");
  form.elements.sellerBirthMonth.innerHTML = monthOptions.join("");
  form.elements.sellerBirthDay.innerHTML = dayOptions.join("");
}

function timeText(value) {
  const cleaned = String(value || "").trim();
  const match = cleaned.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return cleaned;
  return String(Number(match[1]));
}

function amountNumber(data) {
  if (!hasAmountInput(data)) return "";
  if (isZeroAmountContract(data)) return "0";
  const number = Number(data.purchaseAmount);
  if (!Number.isFinite(number) || number < 0) return "";
  return String(Math.round(number));
}

function automobileTaxUnpaidAmountNumber(data) {
  if (data?.automobileTaxStatus !== "未納") return "0";
  const number = Number(data.automobileTaxUnpaidAmount);
  if (!Number.isFinite(number) || number < 0) return "0";
  return String(Math.round(number));
}

function recycleDepositAmountNumber(data) {
  const raw = String(data?.recycleDepositAmount ?? "").trim();
  if (!raw) return "";
  const number = Number(raw);
  if (!Number.isFinite(number) || number < 0) return "";
  return String(Math.round(number));
}

function dotSeparatedAmount(value) {
  const digits = onlyDigits(value);
  if (!digits) return "";
  return Number(digits).toLocaleString("ja-JP").replaceAll(",", ".");
}

function hasLoan(data) {
  return String(data?.loanStatus || "無") === "有";
}

function loanBalanceAmountNumber(data) {
  if (!hasLoan(data)) return "";
  const number = Number(data.loanBalanceAmount);
  if (!Number.isFinite(number) || number < 0) return "";
  return String(Math.round(number));
}

function hasBankTransfer(data) {
  return String(data?.bankTransferStatus || "無") === "有";
}

function paymentAmountNumber(data) {
  const amount = Number(amountNumber(data) || 0);
  const unpaidAmount = Number(automobileTaxUnpaidAmountNumber(data) || 0);
  const loanAmount = Number(loanBalanceAmountNumber(data) || 0);
  if (!Number.isFinite(amount) || !Number.isFinite(unpaidAmount) || !Number.isFinite(loanAmount)) return "";
  return String(Math.max(Math.round(amount - unpaidAmount - loanAmount), 0));
}

function yesNoValue(value, fallback = "無") {
  return String(value || "") === "有" ? "有" : String(value || "") === "無" ? "無" : fallback;
}

function legacyDrivingDefectValue(data) {
  if (data?.drivingDefect) return data.drivingDefect;
  if (data?.drivable === "不可") return "有";
  if (data?.drivable === "可") return "無";
  return "無";
}

function displayContractNumber(contract) {
  const number = contractNumberValue(contract);
  return number ? String(number) : "1";
}

function onlyDigits(value) {
  return String(value ?? "").replace(/\D/g, "");
}

function pdfField(x, y, value, size = 9, anchor = "start") {
  const text = String(value ?? "").trim();
  if (!text) return "";
  return `<text x="${x}" y="${y}" font-size="${size * 2}" font-weight="700" text-anchor="${anchor}">${escapeHtml(text)}</text>`;
}

function splitPdfLines(value, maxChars = 44, maxLines = 2) {
  const cleaned = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!cleaned) return [];

  const lines = [];
  let rest = cleaned;
  while (rest && lines.length < maxLines) {
    if (rest.length <= maxChars) {
      lines.push(rest);
      rest = "";
      break;
    }
    lines.push(rest.slice(0, maxChars));
    rest = rest.slice(maxChars).trim();
  }

  if (rest && lines.length) {
    const lastIndex = lines.length - 1;
    lines[lastIndex] = `${lines[lastIndex].slice(0, Math.max(0, maxChars - 3))}...`;
  }

  return lines;
}

function pdfMultilineField(x, y, value, size = 7.2, lineHeight = 15) {
  const lines = splitPdfLines(value, 64, 2);
  const adjustedSize = String(value ?? "").length > 64 ? 6.7 : size;
  return lines
    .map((line, index) => pdfField(x, y + index * lineHeight, line, adjustedSize))
    .join("");
}

function pdfWhiteRect(x, y, width, height) {
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="#fff" />`;
}

function pdfBox(x, y, width, height, strokeWidth = 1.1) {
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="none" stroke="#000" stroke-width="${strokeWidth}" />`;
}

function pdfCircle(x, y, radius = 7.5) {
  return `<circle cx="${x}" cy="${y}" r="${radius}" fill="none" stroke="#000" stroke-width="1.3" />`;
}

function pdfOval(x, y, width, height) {
  return `<ellipse cx="${x}" cy="${y}" rx="${width / 2}" ry="${height / 2}" fill="none" stroke="#000" stroke-width="1.3" />`;
}

function pdfLine(x1, y1, x2, y2, width = 1.1) {
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#000" stroke-width="${width}" />`;
}

function pdfIdentityNumberCells(x, y, value) {
  const cellWidth = 24;
  const cellCount = 12;
  const digits = onlyDigits(value).slice(0, cellCount);
  const boxes = Array.from({ length: cellCount })
    .map((_, index) => pdfBox(x + index * cellWidth, y, cellWidth, 30, 0.9))
    .join("");
  const chars = digits
    .split("")
    .map((char, index) => pdfField(x + index * cellWidth + cellWidth / 2, y + 22, char, 7.2, "middle"))
    .join("");
  return `${boxes}${chars}`;
}

function pdfCheckbox(x, y, checked = false) {
  return `
    ${pdfBox(x, y, 13, 13, 1)}
    ${
      checked
        ? `<path d="M ${x + 2.5} ${y + 7} L ${x + 5.5} ${y + 10} L ${x + 11} ${y + 3}" fill="none" stroke="#000" stroke-width="1.4" />`
        : ""
    }
  `;
}

function pdfYesNoCircle(value, noX, yesX, y) {
  const selectedX = yesNoValue(value) === "有" ? yesX : noX;
  return pdfCircle(selectedX, y, 9.5);
}

function pdfTaxStatusCircle(value) {
  const positions = {
    完納: [210, 523, 64, 27],
    未納: [278, 523, 64, 27],
    課税保留: [352, 523, 104, 27],
    減免: [421, 523, 64, 27],
  };
  const selected = positions[String(value || "完納")] || positions["完納"];
  return pdfOval(...selected);
}

function pdfAccountTypeCircle(value) {
  const positions = {
    普通: [524, 962],
    当座: [524, 980],
    その他: [524, 998],
  };
  const selected = positions[String(value || "普通")];
  return selected ? pdfCircle(selected[0], selected[1], 6.5) : "";
}

function pdfOwnerTypeCircle(value) {
  const positions = {
    売主: [186, 1134, 68, 20],
    販売会社: [274, 1134, 78, 20],
    信販会社: [368, 1134, 78, 20],
    その他: [452, 1134, 64, 20],
  };
  const selected = positions[String(value || "売主")];
  return selected ? pdfOval(...selected) : "";
}

function pdfUserTypeCircle(value) {
  const positions = {
    売主: [186, 1166, 68, 20],
    その他: [258, 1166, 64, 20],
  };
  const selected = positions[String(value || "売主")];
  return selected ? pdfOval(...selected) : "";
}

function pdfDeadlineText(parts, timeValue) {
  const time = timeText(timeValue);
  const hasDate = Boolean(parts?.year || parts?.month || parts?.day);
  if (!hasDate && !time) return "";
  const dateText = hasDate ? `${parts.year}年　${parts.month}月　${parts.day}日` : "";
  return [dateText, time].filter(Boolean).join(" ");
}

function pdfDeadlineLine(rectX, rectY, rectWidth, rectHeight, textX, textY, parts, timeValue) {
  const text = pdfDeadlineText(parts, timeValue);
  if (!text) return "";
  return `${pdfWhiteRect(rectX, rectY, rectWidth, rectHeight)}${pdfField(textX, textY, text, 7.2)}`;
}

function pdfIdentityTypeOval(value) {
  const positions = {
    運転免許証: [176, 1656, 68, 20],
    パスポート: [255, 1659, 62, 20],
    マイナンバー: [337, 1659, 78, 20],
    マイナンバーカード: [337, 1659, 78, 20],
    健康保険証: [423, 1659, 76, 20],
    その他: [506, 1659, 70, 20],
  };
  const selected = positions[String(value || "")];
  return selected ? pdfOval(...selected) : "";
}

function pdfShopIdentityFooter(data) {
  const y = 1600;

  return `
    ${pdfSpacedFields([296, 320, 344, 368, 392, 416, 440, 464, 488, 512, 536, 560], y + 24, data.identityNumber, 7.2)}
    ${pdfCheckbox(62, y + 17, data.identityConfirmed)}
    ${pdfIdentityTypeOval(data.identityType)}
    ${pdfField(1090, y + 24, data.staffSignatureName, 5.8)}
    ${pdfField(1090, y + 58, data.managerSignatureName, 5.8)}
  `;
}

function pdfSpacedFields(xPositions, y, value, size = 9) {
  const chars = onlyDigits(value).slice(-xPositions.length).padStart(xPositions.length, " ").split("");
  return chars
    .map((char, index) => {
      if (!char.trim()) return "";
      return pdfField(xPositions[index], y, char, size, "middle");
    })
    .join("");
}

function pdfSpacedFieldsWithoutOnes(xPositions, y, value, size = 9) {
  const digits = onlyDigits(value);
  if (!digits) return "";
  return pdfSpacedFields(xPositions, y, digits.slice(0, -1) || "0", size);
}

function pdfLeftAlignedDigits(xPositions, y, value, size = 9) {
  return onlyDigits(value)
    .slice(0, xPositions.length)
    .split("")
    .map((char, index) => pdfField(xPositions[index], y, char, size, "middle"))
    .join("");
}

function pdfDateParts(value) {
  const parts = dateParts(value);
  return {
    year: parts.year || "",
    month: parts.month || "",
    day: parts.day || "",
  };
}

function contractTemplateData(contract) {
  const data = contract?.data || getFormData();
  const contractDate = pdfDateParts(new Date().toISOString().slice(0, 10));
  const pickupDate = pdfDateParts(data.pickupDate);
  const documentDate = pdfDateParts(data.documentDeliveryDate);
  const paymentDate = pdfDateParts(data.paymentDate);
  const loanTransferDate = pdfDateParts(data.loanTransferDate);
  const sellerBirth = pdfDateParts(data.sellerBirthdate);

  return {
    contractNumber: displayContractNumber(contract),
    contractDate,
    completionMethod: data.completionMethod || "paper",
    signatureData: contract?.signatureData || signatureData,
    carName: data.carName,
    carGrade: data.carGrade,
    carYear: data.carYear,
    carColor: data.carColor,
    chassisNumber: data.chassisNumber,
    plateNumber: data.plateNumber,
    mileage: data.mileage,
    engineDefect: yesNoValue(data.engineDefect || data.defect),
    transmissionDefect: yesNoValue(data.transmissionDefect),
    powerSteeringDefect: yesNoValue(data.powerSteeringDefect),
    suspensionDefect: yesNoValue(data.suspensionDefect),
    drivingDefect: yesNoValue(legacyDrivingDefectValue(data)),
    parkingViolationUnpaid: yesNoValue(data.parkingViolationUnpaid),
    repairHistory: yesNoValue(data.repairHistory),
    meterIssue: yesNoValue(data.meterIssue),
    disasterHistory: yesNoValue(data.disasterHistory),
    automobileTaxStatus: data.automobileTaxStatus || "完納",
    automobileTaxUnpaidAmount: automobileTaxUnpaidAmountNumber(data),
    recycleDepositAmount: dotSeparatedAmount(recycleDepositAmountNumber(data)),
    amount: amountNumber(data) || "0",
    paymentAmount: paymentAmountNumber(data) || "0",
    loanStatus: hasLoan(data) ? "有" : "無",
    loanCompany: hasLoan(data) ? data.loanCompany : "",
    loanTransferDate,
    loanBalanceAmount: loanBalanceAmountNumber(data),
    pickupDate,
    pickupTime: data.pickupTime,
    documentDate,
    documentDeliveryTime: data.documentDeliveryTime,
    paymentDate,
    paymentTime: data.paymentTime,
    vehicleNote: data.vehicleNote,
    bankTransferStatus: hasBankTransfer(data) ? "有" : "無",
    bankName: hasBankTransfer(data) ? data.bankName : "",
    branchName: hasBankTransfer(data) ? data.branchName : "",
    accountType: hasBankTransfer(data) ? data.accountType : "",
    accountNumber: hasBankTransfer(data) ? data.accountNumber : "",
    accountHolderKana: hasBankTransfer(data) ? data.accountHolderKana : "",
    accountHolder: hasBankTransfer(data) ? data.accountHolder : "",
    ownerType: data.ownerType || "売主",
    ownerName: data.ownerName,
    ownerRelationship: data.ownerRelationship,
    userType: data.userType || "売主",
    userName: data.userName,
    userRelationship: data.userRelationship,
    sellerKana: data.sellerKana,
    sellerName: data.sellerName,
    sellerPostalCode: data.sellerPostalCode,
    sellerAddress: data.sellerAddress,
    sellerHomePhone: data.sellerHomePhone || data.sellerPhone,
    sellerMobile: data.sellerMobile,
    sellerWorkplace: data.sellerWorkplace || data.workplace,
    sellerWorkplacePhone: data.sellerWorkplacePhone,
    identityNumber: data.identityNumber,
    identityType: data.identityType,
    identityConfirmed: Boolean(data.identityConfirmed || data.documents?.includes?.("本人確認書類")),
    staffSignatureName: data.staffSignatureName,
    managerSignatureName: data.managerSignatureName,
    sellerBirth,
  };
}


const CONTRACT_TERMS_DATE = "2026.8.1";
const CONTRACT_TERMS_PARAGRAPHS = [
  `第1条（契約の目的） 本契約は、本契約書表面記載の売主（以下「売主」という。）が、表面記載の買主（以下「買主」という。）に対して、表面記載の車両（以下「契約車両」という。）を表面記載の売買契約金額で売り渡す際の売主及び買主間の権利義務を定めることを目的とする。`,
  `第2条（契約の成立時期） 本契約は、売主が契約車両を買主に売り渡すことに同意し、売主及び買主が本契約書表面の署名欄に署名又は記名押印することにより成立する。また、買主は売主に対し本契約書を交付し、売主は保管する。`,
  `第3条（契約車両の引渡し）`,
  `1. 売主は、買主又は買主の指定する第三者に対して、売主及び買主が合意した車両引渡期限までに売主及び買主が合意した場所（但し、買主の営業所又は売主の住所若しくは居所に限る。）にて契約車両を引き渡し、買主は、これを引き受け、車両受領証を売主に対し発行する。但し、買主は、移転登録書類等（次条第1項において定義される。）の引渡し及び契約車両に関して債務（ローン残債、自動車税（種別割）未納金、放置違反金等）があるときの当該債務の完済がなされる時まで、契約車両の引渡しを受けないことができる。`,
  `2. 契約車両の運搬費用等は引渡しの時をもって区分し、契約車両の引渡しまでに要する費用は、売主の負担とし、引渡し後に要する費用は買主の負担とする。`,
  `第4条（移転登録書類等の引渡し等）`,
  `1. 売主は、次の各号に掲げる契約車両の名義変更等に必要な書類のうち、買主が指定する書類（以下「移転登録書類等」という。）を自己の費用と責任において完備し、本契約書表面記載の「書類引渡期限」までに買主に引き渡すものとする。`,
  `(1) 契約車両所有者の印鑑証明書、住民票（所有者が法人のときには当該法人の商業・法人登記簿謄本）、戸籍の附票、委任状、譲渡証明書、有効期間内の自動車税（種別割）納税証明書、その他契約車両の名義変更手続に必要な書類`,
  `(2) 自動車検査証`,
  `(3) 自動車損害賠償責任保険の証書`,
  `(4) 契約車両について使用済自動車の再資源化等に関する法律に基づき同法所定の料金が預託されているときにはリサイクル券`,
  `(5) 自動車税（種別割）の還付に関する委任状、譲渡通知書、譲渡確認書`,
  `(6) 自動車損害賠償責任保険料等の還付等に関する委任状`,
  `(7) 前各号の他、買主が売主に対し、作成又は交付を依頼した契約車両の所有権移転手続き等に必要な書類`,
  `2. 移転登録書類等のうち、印鑑証明書、住民票、商業・法人登記簿謄本、戸籍の附票等、買主が特定した有効期限がある書類については、売主から買主への第3条に基づく契約車両の引渡し及び本条に基づく移転登録書類等の引渡しがいずれも全て完了したときから2ヶ月以上の有効期限があるものとする。`,
  `3. 契約車両の名義変更については、買主が一切の責任を負うものとし、売主は、買主又は買主の指定する行政書士等の代理人に対し、契約車両の移転登録手続等に要する書類の作成・交付の代理権又は代行権限を予め付与する。`,
  `4. 前項の規定にかかわらず、第1項に定める移転登録書類等の引渡しの後、移転登録書類等が失効、紛失、毀損等したときには、売主は買主からの移転登録書類等の再引渡し請求に協力し、買主は、売主が当該協力のために現実に支出した合理的な範囲の費用を負担する。`,
  `第5条（支払い条件等）`,
  `1. 買主は、本契約書表面記載のとおり売主から買主への第3条に基づく契約車両の引渡し及び第4条に基づく移転登録書類等の引渡しがいずれも完了した後、売主及び買主が合意した期限内に売買契約金額より、次の各号に定める支払いまでに買主に判明した売主が負担すべき債務（以下「未納金等」という。）を差し引いた金額（以下「支払代金」という。）を売主に対して本契約書表面記載の方法により支払うものとする。但し、支払い後に新たに未納金等が判明した場合における、買主の売主に対する損害賠償その他の請求（第8条第3項、第8条第5項に基づく請求を含む。）を妨げるものではない。`,
  `(1) 契約車両にかかるローン残債総額`,
  `(2) 売主がカーナビゲーション・オーディオ等のパーツの返却を希望した場合のパーツ取外し工賃`,
  `(3) その他前号に定めるものの他、支払いまでに買主に判明した売主が負担すべき契約車両にかかる債務`,
  `2. 買主は、売主の本契約違反により生じた費用、損害額以外について前項の支払代金債務と相殺してはならない。`,
  `3. 売主は、買主が第1項の支払期限までに支払代金を支払わない場合、本契約を解除することができる。この場合、買主は契約車両について契約車両の引渡し時の原状に復する義務を負う。`,
  `第6条（契約車両の種類又は品質等に関する申告義務）`,
  `1. 売主は契約車両につき、本契約締結時の自己に判明している範囲でその使用状況その他の契約車両の種類又は品質に関して本契約の内容に適合しないもの（以下「不適合」という。）がある場合にはその程度等を誠実に買主に対し申告しなければならないものとする。`,
  `2. 売主及び買主は、本契約書の所要事項を正確かつ確実に記載、申告を行なうものとし、記載漏れ、誤記載、虚偽の記載等のないように留意するものとし、記載漏れ等を発見したときは、直ちに相手方に報告し、訂正しなければならない。`,
  `第7条（担保権等の処理）`,
  `1. 契約車両に関して債務があるときには、売主は、直ちに当該債務を完済しなければならないものとする。`,
  `2. 契約車両につき、譲渡担保権等の担保権の設定又は差押え等（以下「担保権等」という。）の事実が判明したときには、売主は、買主が当該事実を知った日から10日以内に担保権等を消滅させる処理を行なうものとする。`,
  `3. 前項の処理に要する費用は、売主の負担とする。`,
  `第8条（契約の解除）`,
  `1. 次の各号のいずれかに該当する事由が生じた場合には、買主は売主に協議を求めるものとし、両者で十分な協議を行ってもなお合意に至らなかった場合又は協議が不能なときは、買主は売主に催告し（第5号及び第6号の場合、催告は不要）本契約を解除することができる。`,
  `(1) 売主が、第3条の定めに従い車両引渡期限までに契約車両を引き渡さないとき`,
  `(2) 売主が、第4条の定めに従い書類引渡期限までに移転登録書類等を引き渡さないとき`,
  `(3) 売主が、買主に対し、金銭債務を負担している場合（買主が売主に代わり契約車両にかかる未納金等を支払った場合等）で当該債務の弁済をしないとき`,
  `(4) 前条第2項の担保権等を消滅させる処理がなされないとき`,
  `(5) 契約車両につき、中古自動車取引業界における一般的かつ標準的な車両検査（修復歴の基準については一般財団法人日本自動車査定協会が定める基準、走行距離に関する不適合においては一般社団法人日本オートオークション協議会への照会を実施）において判明しない不適合があることが判明したとき`,
  `(6) 本契約締結日から第3条の契約車両の引渡しまでの間に契約車両に買主の責めに帰さない破損等の変化が生じたとき`,
  `2. 買主は、前項を除き、契約車両に修復歴があることを原因として、本契約を解除することはできない。`,
  `3. 第1項各号のいずれかに該当する事由が生じた場合に買主に損害が生じたときには、買主は、第1項の解除と同時又は解除をすることなく、かかる損害（実際に発生した損害に限る。逸失利益は含まれない。）の賠償を請求することができるものとする。但し、第1項の解除をすることなく損害の賠償を請求する場合、買主は契約車両をオートオークションで売却し、契約車両の資産価値を確定したうえで、損害額を算定し損害の賠償を請求しなければならない。`,
  `4. 第1項の解除権及び第3項の損害賠償請求権の行使期間は買主が、第1項各号に掲げる事由に該当することを知った時から3カ月間とする。`,
  `5. 売主が次の各号のいずれかに該当した場合には、買主は何時でも売主に対し事前に通知又は催告を行なうことなく、直ちに本契約を解除することができ、買主に損害が生じたときは、解除と同時又は解除をすることなく、買主は売主に対し、かかる損害（逸失利益を含む。）の賠償を請求することができるものとする。`,
  `(1) 監督官庁から事業の取消、停止等の処分を受けたとき`,
  `(2) 解散又は事業の全部若しくは重要な一部を第三者に譲渡しようとしたとき`,
  `(3) 事業の廃止又は休止をしたとき`,
  `(4) 資本減少、合併又は会社分割の決議をしたとき`,
  `(5) 自己の財産につき、第三者より仮差押、仮処分、強制執行等の債権保全行為を受け契約の履行が困難と認められるとき`,
  `(6) 破産、特別清算、民事再生、会社更生手続、その他これらに類する諸手続等の申し立てを受け又は自ら申し立てたとき`,
  `(7) 支払停止若しくは支払不能に陥ったとき又は金融機関から取引停止処分を受けたとき`,
  `(8) 振り出した手形又は小切手が、不渡りとなったとき`,
  `(9) 買主への著しい背信行為や社会的信用を損なう行為を実行し又は計画したとき`,
  `(10) 反社会的勢力（暴力団、暴力団員、その他これらに準ずるものをいう。）に該当することが判明したとき`,
  `6. 売主は本契約締結日から第3条に定める契約車両の引渡しを行った日の翌日までは、買主に通知することにより何等の負担なく本契約を解除することができるものとする。`,
  `7. 解除事由のいかんを問わず、売主又は買主により本契約が解除された場合、買主は売主に対し、解除日から7日以内に、買主が既に第5条の支払代金を支払っているときは支払代金の返還及び損害賠償（但し、第6項の解除の場合、損害賠償は発生しない。以下本条において同じ。）の支払いを求めることができるものとする。`,
  `8. 本契約の解除時において買主が契約車両を受領している場合、買主は、売主からの支払代金の返還及び損害賠償の支払いが完了するまで契約車両を留置できるものとする。なお、売主からの支払代金の返還及び損害賠償の支払いがなされたときは、買主は売主に対し、当該返還日から7日以内に、買主の指定する日時に売主が契約車両を引き渡した場所において契約車両を引き取ることを請求することができるものとする。`,
  `9. 解除事由のいかんを問わず、売主又は買主により本契約が解除されたにもかかわらず前項の期限内に売主が支払代金の返還及び損害賠償の支払いをしないとき、又は、売主が正当事由なく契約車両を引き取らないときは、買主は、契約車両を任意に処分し、契約車両を任意に処分した代金を支払代金及び損害に充当することができ、残余がある場合は、売主に交付する。`,
  `第9条（契約車両内残置物の処置等）`,
  `1. 売主は、第3条の契約車両引渡しの際、原則として、契約車両に残置物なく、引渡すものとする。万一、引渡後の契約車両に残置物がある場合、買主は、売主が残置物について、所有権及び占有権を放棄したものとみなし、残置物を任意に処分することができる。`,
  `2. 売主は、カーナビゲーション等の情報記録機能を有する機器（以下「情報機器」という。）を装備した状態のまま契約車両を買主に対して引き渡す場合、売主の責任において情報機器の初期化等を行なうものとする。`,
  `3. 売主が、車両内に残置物を残置したこと及び情報機器の情報消去を怠ったことにより当該残置物及び当該情報機器に記録された情報が第三者に提供され、売主に損害が発生した場合であっても、買主は責任を負わない。`,
  `4. 前各項の定めは本契約が無効、取消し、又は解除された場合であっても有効とする。`,
  `第10条（管轄裁判所） 本契約に関し売主及び買主間で紛争が生じた場合、訴訟の必要があるときは訴額に応じ、売主の住所地の地方裁判所又は簡易裁判所を第一審の専属的合意管轄裁判所とし、調停の必要があるときは、売主の住所地の簡易裁判所を専属的合意管轄裁判所とする。`,
  `第11条（規定外事項） 本契約に定めのない事項又は本契約の解釈に疑義が生じたときは、関係法令を斟酌して、その都度、売主及び買主は誠意をもって協議し、解決するものとする。`,
  `第12条（個人情報の取扱い）`,
  `1. 買主は、売主の個人情報を以下の目的以外には利用いたしません。`,
  `(1) 定期点検、車検等のサービスのご案内等をする為、郵便、電話、電子メール等の方法によりお知らせすること。`,
  `(2) 自動車、部用品、サービス商品、保険、クレジットカード等の当社で取り扱う商品、あるいは各種イベント・キャンペーン等の開催について、郵便、電話、電子メール等の方法によりご案内すること。`,
  `(3) 商品企画・開発あるいは顧客満足度向上策検討のため、アンケート調査を実施すること。`,
  `(4) お客様とのお取引に関するご相談、ご要望に対応すること。`,
  `(5) 売掛金等の債権の確認やご請求等を郵便、電話、電子メール等の方法によりご案内すること。`,
  `(6) 以下の個人情報を口頭、電話、ファクシミリ、書面または電子媒体により、信用販売会社、損害保険会社等の当社の提携する会社に提供すること。ただし、ご本人のお申し出により第三者への提供を停止いたします。停止方法につきましては、当社のお客様相談室もしくは最寄の店舗までお問合せください。`,
  `2. 買主は売主の個人情報を前項（6）で定めた提供先を除き、正当な理由のない限りご本人様の許可なく第三者へ提供いたしません。但し、個人情報保護法において定められた以下の場合を除きます。`,
  `(1) 法令に基づく場合`,
  `(2) 人の生命、身体又は財産の保護のために必要がある場合であって、ご本人様の同意を得ることが困難であるとき。`,
  `(3) 公衆衛生の向上又は児童の健全な育成の推進のために特に必要がある場合であってご本人様の同意を得ることが困難であるとき。`,
  `(4) 国の機関もしくは地方公共団体又はその委託を受けた者が法令の定める事務を遂行することに対して協力する必要がある場合であって、ご本人様の同意を得ることにより当該事務の遂行に支障を及ぼすおそれがあるとき。`,
  `3. 買主は売主がご本人様の個人情報の確認、訂正等を希望される場合、買主の定める書面（以下開示請求書と称します）の提出により開示に応じます。開示請求書等の入手方法につきましては、買主のお客様相談室（下記に記載）もしくは最寄りの営業所までお問い合わせください。なお、開示請求のお手続きの際にはご本人様であることを確認できるもの（運転免許証等 氏名、生年月日、住所等の記載があるもの）をご用意ください。`,
  `4. 個人情報の取扱いに関する問い合わせ窓口 オーダーオート 〒731-5124 広島県広島市佐伯区皆賀1-10-20 TEL 080-2912-8616`,
  `5. 買主は売主の個人情報の取扱いに関係する日本の法令、その他の規範を遵守いたします。`,
  `6. 買主は売主の個人情報について適切な安全措置を講ずることによって、漏えい、改ざん、紛失等の危険防止に努めます。`,
  `7. 買主は個人情報の取扱いについて、定期的に監査を行い、常に継続的改善を行います。`,
  `以上`,
  CONTRACT_TERMS_DATE,
];

function contractTermsTextUnits(value) {
  return Array.from(String(value || "")).reduce((total, char) => {
    if (/^[ -~]$/.test(char)) return total + 0.55;
    if (/^[、。，．・（）「」『』［］【】]$/.test(char)) return total + 0.5;
    return total + 1;
  }, 0);
}

function splitContractTermsLine(value, maxUnits = 58) {
  const text = String(value || "").trim();
  if (!text) return [];
  const lines = [];
  let line = "";
  let units = 0;

  Array.from(text).forEach((char) => {
    const charUnits = contractTermsTextUnits(char);
    if (line && units + charUnits > maxUnits) {
      lines.push(line);
      line = char;
      units = charUnits;
      return;
    }
    line += char;
    units += charUnits;
  });

  if (line) lines.push(line);
  return lines;
}

function contractTermsLines() {
  return CONTRACT_TERMS_PARAGRAPHS.flatMap((paragraph) => {
    const isHeading = /^第\d+条/.test(paragraph);
    const wrapped = splitContractTermsLine(paragraph, isHeading ? 46 : 49).map((line) => ({ line, isHeading }));
    return [...wrapped, { line: "", isHeading: false, isSpacer: true }];
  });
}

function splitContractTermsColumns(lines) {
  const half = Math.floor(lines.length / 2);
  let splitIndex = half;

  for (let offset = 0; offset < 32; offset += 1) {
    const candidates = [half + offset, half - offset];
    const blankIndex = candidates.find((index) => index > 0 && index < lines.length && lines[index]?.isSpacer);
    if (blankIndex) {
      splitIndex = blankIndex + 1;
      break;
    }
  }

  return [lines.slice(0, splitIndex), lines.slice(splitIndex)];
}

function contractTermsSvg() {
  const columns = splitContractTermsColumns(contractTermsLines());
  const title = "契 約 条 項";
  const leftX = 118;
  const rightX = 630;
  const topY = 96;
  const lineHeight = 15.6;
  const spacerHeight = 5.0;

  const columnMarkup = columns
    .map((column, columnIndex) => {
      const x = columnIndex === 0 ? leftX : rightX;
      let y = topY;
      return column
        .map((item) => {
          if (item.isSpacer) {
            y += spacerHeight;
            return "";
          }
          const markup = `<text x="${x}" y="${y.toFixed(1)}" font-size="8.2" font-weight="400">${escapeHtml(item.line)}</text>`;
          y += lineHeight;
          return markup;
        })
        .join("");
    })
    .join("");

  return `
    <svg class="pdf-contract-svg pdf-terms-svg" viewBox="0 0 1191 1684" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="契約条項">
      <rect x="0" y="0" width="1191" height="1684" fill="#fff" />
      <g transform="translate(-30 -16) scale(1.05)">
        <rect x="86" y="42" width="1019" height="1566" fill="none" stroke="#b8b8b8" stroke-width="0.45" opacity="0.45" />
        <line x1="595.5" y1="88" x2="595.5" y2="1565" stroke="#8c8c8c" stroke-width="0.55" opacity="0.65" />
        <g fill="#000" font-family="Hiragino Mincho ProN, Yu Mincho, YuMincho, serif">
          <text x="595.5" y="72" font-family="Hiragino Kaku Gothic ProN, Yu Gothic, Meiryo, sans-serif" font-size="22" font-weight="600" text-anchor="middle">${title}</text>
          ${columnMarkup}
        </g>
      </g>
    </svg>
  `;
}

function contractTemplateSvg(contract, copyType = "customer") {
  const templateFile = copyType === "shop" ? "order_auto_blank_shop.png" : "order_auto_blank_customer.png";
  const imageUrl = new URL(`templates/${templateFile}?v=20260712-template`, window.location.href).href;
  const data = contractTemplateData(contract);
  const isShopCopy = copyType === "shop";

  return `
    <svg class="pdf-contract-svg" viewBox="0 0 1191 1684" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="車両売買契約書">
      <image href="${escapeHtml(imageUrl)}" x="0" y="0" width="1191" height="1684" preserveAspectRatio="none" />
      <g fill="#000" font-family="Hiragino Kaku Gothic ProN, Yu Gothic, Meiryo, sans-serif">
        ${pdfField(202, 72, data.contractDate.year, 8.5, "end")}
        ${pdfField(282, 72, data.contractDate.month, 8.5, "end")}
        ${pdfField(356, 72, data.contractDate.day, 8.5, "end")}
        ${pdfField(1052, 70, data.contractNumber, 10)}

        ${pdfField(180, 188, data.carName, 10)}
        ${pdfField(180, 240, data.carGrade, 10)}
        ${pdfField(224, 290, data.carYear, 8.5)}
        ${pdfField(712, 188, data.chassisNumber, 9)}
        ${pdfField(712, 240, data.plateNumber, 9)}
        ${pdfField(712, 293, data.carColor, 9)}
        ${pdfSpacedFields([215, 252, 290, 328, 366, 404], 348, data.mileage, 9)}
        ${pdfYesNoCircle(data.engineDefect, 614, 642, 320)}
        ${pdfYesNoCircle(data.transmissionDefect, 839, 869, 320)}
        ${pdfYesNoCircle(data.powerSteeringDefect, 1084, 1110, 320)}
        ${pdfYesNoCircle(data.suspensionDefect, 647, 677, 338)}
        ${pdfYesNoCircle(data.drivingDefect, 812, 841, 338)}
        ${pdfYesNoCircle(data.parkingViolationUnpaid, 274, 304, 374)}
        ${pdfYesNoCircle(data.repairHistory, 432, 472, 374)}
        ${pdfYesNoCircle(data.meterIssue, 782, 819, 375)}
        ${pdfYesNoCircle(data.disasterHistory, 1066, 1103, 375)}

        ${pdfSpacedFields([161, 234, 307, 380, 453, 526, 593], 480, data.amount, 13)}
        ${pdfField(870, 456, data.recycleDepositAmount, 8.5, "middle")}
        ${pdfSpacedFields([660, 733, 806, 879, 952, 1026, 1093], 762, data.paymentAmount, 10)}
        ${pdfTaxStatusCircle(data.automobileTaxStatus)}
        ${data.automobileTaxUnpaidAmount !== "0" ? pdfSpacedFieldsWithoutOnes([733, 806, 879, 953, 1026], 538, data.automobileTaxUnpaidAmount, 10) : ""}
        ${
          data.loanStatus === "有"
            ? `
              ${pdfField(70, 598, data.loanCompany, 7.8)}
              ${pdfField(372, 598, data.loanTransferDate.year, 7.2, "end")}
              ${pdfField(412, 598, data.loanTransferDate.month, 7.2, "end")}
              ${pdfField(454, 598, data.loanTransferDate.day, 7.2, "end")}
              ${pdfSpacedFields([660, 733, 806, 879, 952, 1026, 1093], 596, data.loanBalanceAmount, 10)}
            `
            : ""
        }

        ${pdfDeadlineLine(350, 812, 176, 24, 362, 832, data.pickupDate, data.pickupTime)}
        ${pdfDeadlineLine(648, 812, 176, 24, 660, 832, data.documentDate, data.documentDeliveryTime)}
        ${pdfDeadlineLine(936, 812, 176, 24, 928, 832, data.paymentDate, data.paymentTime)}
        ${pdfMultilineField(205, 878, data.vehicleNote)}
        ${
          data.bankTransferStatus === "有"
            ? `
              ${pdfField(155, 988, data.bankName, 7.4, "middle")}
              ${pdfField(395, 988, data.branchName, 7.4, "middle")}
              ${pdfAccountTypeCircle(data.accountType)}
              ${pdfLeftAlignedDigits([604, 638, 672, 714, 748, 782, 816], 1000, data.accountNumber, 7.4)}
              ${pdfField(990, 982, data.accountHolderKana, 7.2, "middle")}
              ${pdfField(990, 1028, data.accountHolder, 7.2, "middle")}
            `
            : ""
        }
        ${pdfOwnerTypeCircle(data.ownerType)}
        ${pdfField(610, 1134, data.ownerName, 7.2)}
        ${pdfField(920, 1134, data.ownerRelationship, 7.2)}
        ${pdfUserTypeCircle(data.userType)}
        ${pdfField(410, 1166, data.userName, 7.2)}
        ${pdfField(920, 1166, data.userRelationship, 7.2)}

        ${pdfField(690, 1308, data.sellerKana, 8)}
        ${pdfField(690, 1338, data.sellerName, 9.5)}
        ${
          data.completionMethod !== "paper" && data.signatureData
            ? `
              <rect x="1090" y="1302" width="34" height="34" fill="#fff" />
              <text x="1016" y="1296" font-size="8" font-weight="700">電子サイン</text>
              <image href="${escapeHtml(data.signatureData)}" x="1006" y="1300" width="120" height="60" preserveAspectRatio="xMidYMid meet" />
            `
            : ""
        }
        ${pdfField(704, 1396, data.sellerPostalCode, 7.8)}
        ${pdfField(690, 1418, data.sellerAddress, 7.8)}
        ${pdfLine(581, 1450, 1134, 1450, 1)}
        ${pdfField(704, 1468, data.sellerHomePhone, 7.6)}
        ${pdfField(704, 1488, data.sellerMobile, 7.6)}
        ${pdfField(850, 1506, data.sellerBirth.year, 7.3)}
        ${pdfField(966, 1506, data.sellerBirth.month, 7.3)}
        ${pdfField(1056, 1506, data.sellerBirth.day, 7.3)}
        ${pdfField(690, 1546, data.sellerWorkplace, 7.5)}
        ${pdfField(704, 1568, data.sellerWorkplacePhone, 7.5)}
        ${isShopCopy ? pdfShopIdentityFooter(data) : ""}
      </g>
    </svg>
  `;
}

function printTemplateContract(contract) {
  const printWindow = window.open("", "_blank");
  if (!printWindow) {
    setSaveStatus("印刷画面を開けませんでした。ブラウザのポップアップ許可を確認してください。", "warning");
    return;
  }

  printWindow.document.write(`
    <!doctype html>
    <html lang="ja">
      <head>
        <meta charset="UTF-8" />
        <title>車両売買契約書</title>
        <style>
          @page {
            size: 210mm 297mm;
            margin: 0;
          }

          * {
            box-sizing: border-box;
          }

          html,
          body {
            margin: 0;
            background: #fff;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
          }

          .pdf-contract-svg {
            display: block;
            width: 210mm !important;
            max-width: none !important;
            height: 297mm !important;
            background: #fff;
          }

          .print-page {
            display: block;
            width: 210mm;
            height: 297mm;
            margin: 0;
            padding: 0;
            overflow: hidden;
            break-after: page;
            page-break-after: always;
          }

          .print-page:last-of-type {
            break-after: auto;
            page-break-after: auto;
          }

          @media screen {
            body {
              display: grid;
              justify-content: center;
              padding: 16px;
              background: #e5e5e5;
            }
            .pdf-contract-svg { box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18); }
            .print-page { margin-bottom: 16px; }
          }

          @media print {
            html,
            body {
              width: 210mm;
              min-height: 297mm;
              padding: 0;
              overflow: visible;
            }
            .pdf-contract-svg { box-shadow: none; }
          }
        </style>
      </head>
      <body>
        <div class="print-page">${contractTemplateSvg(contract, "customer")}</div>
        <div class="print-page">${contractTermsSvg()}</div>
        <div class="print-page">${contractTemplateSvg(contract, "shop")}</div>
        <div class="print-page">${contractTermsSvg()}</div>
        <script>
          window.addEventListener("load", () => {
            setTimeout(() => window.print(), 250);
          });
        <\/script>
      </body>
    </html>
  `);
  printWindow.document.close();
}

function textBytes(value) {
  return new TextEncoder().encode(value);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function buildImagePdf(imagePages) {
  const pages = Array.isArray(imagePages) ? imagePages : [imagePages];
  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const chunks = [];
  const offsets = [];
  let length = 0;

  const add = (chunk) => {
    const bytes = typeof chunk === "string" ? textBytes(chunk) : chunk;
    chunks.push(bytes);
    length += bytes.length;
  };

  const addObject = (id, body) => {
    offsets[id] = length;
    add(`${id} 0 obj\n${body}\nendobj\n`);
  };

  const addImageObject = (id, imageBytes, imageWidth, imageHeight) => {
    offsets[id] = length;
    add(
      `${id} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${imageWidth} /Height ${imageHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${imageBytes.length} >>\nstream\n`,
    );
    add(imageBytes);
    add("\nendstream\nendobj\n");
  };

  const pageObjectIds = pages.map((_, index) => 3 + index * 3);
  const objectCount = 3 + pages.length * 3;

  add("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  addObject(1, "<< /Type /Catalog /Pages 2 0 R >>");
  addObject(2, `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`);

  pages.forEach((page, index) => {
    const pageObjectId = 3 + index * 3;
    const imageObjectId = pageObjectId + 1;
    const contentObjectId = pageObjectId + 2;
    const content = `q\n${pageWidth} 0 0 ${pageHeight} 0 0 cm\n/Im0 Do\nQ\n`;

    addObject(
      pageObjectId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Im0 ${imageObjectId} 0 R >> >> /Contents ${contentObjectId} 0 R >>`,
    );
    addImageObject(imageObjectId, page.imageBytes, page.imageWidth, page.imageHeight);
    addObject(contentObjectId, `<< /Length ${textBytes(content).length} >>\nstream\n${content}endstream`);
  });

  const xrefOffset = length;
  add(`xref\n0 ${objectCount}\n0000000000 65535 f \n`);
  for (let id = 1; id < objectCount; id += 1) {
    add(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
  }
  add(`trailer\n<< /Size ${objectCount} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);

  return new Blob(chunks, { type: "application/pdf" });
}

async function svgToPdfImagePage(svg) {
  const svgBlob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const svgUrl = URL.createObjectURL(svgBlob);
  const image = new Image();
  image.decoding = "async";

  try {
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = reject;
      image.src = svgUrl;
    });

    const imageWidth = 1191;
    const imageHeight = 1684;
    const canvas = document.createElement("canvas");
    canvas.width = imageWidth;
    canvas.height = imageHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas context is unavailable.");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, imageWidth, imageHeight);
    context.drawImage(image, 0, 0, imageWidth, imageHeight);

    const jpegData = canvas.toDataURL("image/jpeg", 0.94);
    return {
      imageBytes: base64ToBytes(jpegData.split(",")[1]),
      imageWidth,
      imageHeight,
    };
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
}

function contractPdfFilename(contract) {
  const data = contract?.data || getFormData();
  const contractNumber = displayContractNumber(contract);
  const sellerName = [data.sellerLastName, data.sellerFirstName].filter(Boolean).join("");
  const baseName = ["車両売買契約書", "お客様控え", contractNumber ? `No${contractNumber}` : "", sellerName]
    .filter(Boolean)
    .join("-");
  return `${baseName.replace(/[\\/:*?"<>|]/g, "_")}.pdf`;
}

async function downloadCustomerPdf(contract) {
  const pages = await Promise.all([
    svgToPdfImagePage(contractTemplateSvg(contract, "customer")),
    svgToPdfImagePage(contractTermsSvg()),
  ]);
  const pdfBlob = buildImagePdf(pages);
  const pdfUrl = URL.createObjectURL(pdfBlob);
  const link = document.createElement("a");
  link.href = pdfUrl;
  link.download = contractPdfFilename(contract);
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(pdfUrl), 1500);
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

  preview.innerHTML = contractTemplateSvg(previewContract, activePreviewCopy);
  status.textContent = contract?.status || "下書き";
  document.querySelector("#editor-title").textContent = contract
    ? `${contract.id} を編集中`
    : "新規契約作成";
  buildEmailBody();
}

function setPreviewCopy(copyType) {
  activePreviewCopy = copyType === "shop" ? "shop" : "customer";
  document.querySelectorAll("[data-preview-copy]").forEach((button) => {
    button.classList.toggle("active", button.dataset.previewCopy === activePreviewCopy);
  });
  updatePreview();
}

function setAppPage(page, updateHash = true) {
  const nextPage = ["top", "create", "list", "remote"].includes(page) ? page : "top";
  const previousPage = activeAppPage;

  if (previousPage === "create" && nextPage !== "create") {
    clearContractForm(false);
  }

  activeAppPage = nextPage;

  document.querySelectorAll("[data-app-view]").forEach((view) => {
    view.hidden = view.dataset.appView !== activeAppPage;
  });

  document.querySelectorAll("[data-app-page]").forEach((button) => {
    button.classList.toggle("active", button.dataset.appPage === activeAppPage);
  });

  if (activeAppPage === "remote") {
    renderRemoteSelectedContract();
    buildEmailBody();
  }

  if (updateHash) {
    const pageHashes = {
      top: "#top",
      create: "#create",
      list: "#list",
      remote: "#remote",
    };
    const nextHash = pageHashes[activeAppPage] || "#top";
    if (window.location.hash !== nextHash) {
      history.replaceState(null, "", nextHash);
    }
  }
}

function appPageFromHash() {
  const hash = window.location.hash.replace("#", "");
  if (hash === "create" || hash === "contract-app") return "create";
  if (hash === "list" || hash === "contracts") return "list";
  if (hash === "remote" || hash === "mail" || hash === "line") return "remote";
  return "top";
}

function renderList() {
  const list = document.querySelector("#contract-list");
  const query = document.querySelector("#contract-search").value.trim().toLowerCase();

  const filtered = contracts.filter((contract) => {
    const data = contract.data || {};
    const text = [contract.id, data.sellerName, data.sellerPhone, data.sellerHomePhone, data.sellerMobile, data.carName, data.plateNumber]
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
        <article class="contract-list-item ${active}" data-id="${contract.id}">
          <button class="contract-list-main" type="button" data-edit-contract="${contract.id}">
            <span>
              <strong>${safeValue(data.sellerName, "氏名未入力")}</strong>
              <small>${safeValue(data.carName, "車名未入力")} / ${escapeHtml(contractTypeLabel(data))}</small>
            </span>
          </button>
          <em>${escapeHtml(contract.status)}</em>
          <div class="contract-list-actions">
            <button class="mini-button" type="button" data-send-remote-contract="${contract.id}">メール・LINE契約</button>
            <button class="mini-button" type="button" data-edit-contract="${contract.id}">編集</button>
            <button class="mini-button danger" type="button" data-delete-contract="${contract.id}">削除</button>
          </div>
        </article>
      `;
    })
    .join("");
}

function clearRemoteSendFields() {
  const emailUrl = document.querySelector("#email-url");
  const passcodeField = document.querySelector("#consent-passcode");
  if (emailUrl) emailUrl.value = "";
  if (passcodeField) passcodeField.value = "";
  buildEmailBody();
}

function selectRemoteContract(id) {
  if (activeId && currentContract()) {
    saveActiveContract(currentContract()?.status || "下書き");
  }
  activeId = id;
  populateForm(currentContract());
  renderList();
  renderRemoteSelectedContract();
  clearRemoteSendFields();
  setSaveStatus("送信する契約書を選択しました。確認URL生成へ進んでください。", "success");
}

function renderRemoteSelectedContract() {
  const target = document.querySelector("#remote-selected-contract");
  if (!target) return;

  const contract = currentContract();
  if (!contract) {
    target.innerHTML = `
      <div class="remote-empty-state">
        <p>送信する契約が選択されていません。</p>
        <button class="button button-outline" type="button" data-app-page="list">契約一覧へ</button>
      </div>
    `;
    return;
  }

  const data = contract.data || {};
  target.innerHTML = `
    <article class="remote-contract-item active">
      <div>
        <span>契約番号 ${escapeHtml(contractNumberValue(contract) || "-")}</span>
        <strong>${safeValue(data.sellerName, "氏名未入力")}</strong>
        <small>${safeValue(data.carName, "車名未入力")} / ${escapeHtml(contract.status || "下書き")}</small>
      </div>
      <button class="mini-button" type="button" data-app-page="list">契約を変更</button>
    </article>
  `;
}

function updateModePanels() {
  const data = getFormData();
  const isZeroAmount = isZeroAmountContract(data);
  const taxUnpaidField = document.querySelector("#automobile-tax-unpaid-field");
  const taxUnpaidInput = document.querySelector('[name="automobileTaxUnpaidAmount"]');
  const loanDetailFields = document.querySelector("#loan-detail-fields");
  const loanInputs = loanDetailFields ? loanDetailFields.querySelectorAll("input, select, textarea") : [];
  const bankDetailFields = document.querySelector("#bank-detail-fields");
  const bankInputs = bankDetailFields ? bankDetailFields.querySelectorAll("input, select, textarea") : [];

  const paymentMethod = document.querySelector('[name="paymentMethod"]');
  if (paymentMethod) {
    paymentMethod.value = isZeroAmount ? "支払いなし" : paymentMethod.value || "振込";
  }
  if (taxUnpaidField) {
    taxUnpaidField.hidden = data.automobileTaxStatus !== "未納";
  }
  if (taxUnpaidInput) {
    taxUnpaidInput.disabled = data.automobileTaxStatus !== "未納";
  }
  if (loanDetailFields) {
    loanDetailFields.hidden = !hasLoan(data);
  }
  loanInputs.forEach((input) => {
    input.disabled = !hasLoan(data);
  });
  if (bankDetailFields) {
    bankDetailFields.hidden = !hasBankTransfer(data);
  }
  bankInputs.forEach((input) => {
    input.disabled = !hasBankTransfer(data);
  });
  const signaturePanel = document.querySelector("#signature-panel");
  const emailPanel = document.querySelector("#email-panel");
  if (signaturePanel) {
    signaturePanel.hidden = data.completionMethod !== "tablet";
  }
  if (emailPanel) {
    emailPanel.hidden = data.completionMethod !== "email";
  }
}

function buildEmailBody() {
  const emailBody = document.querySelector("#email-body");
  const emailUrl = document.querySelector("#email-url");
  const passcodeField = document.querySelector("#consent-passcode");
  if (!emailBody || !emailUrl || !passcodeField) return;
  const data = getFormData();
  const url = emailUrl.value.trim() || "【確認URLをここに入力】";
  const passcode = passcodeField.value.trim();
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
    "確認URLは安全なランダムトークンで保護されています。",
    "開封パスコードは安全のため、このメールには記載していません。",
    "別途お伝えするパスコードを入力し、内容をご確認のうえ、重要事項に同意して契約を完了してください。",
    passcode ? "" : "※先に「確認URL生成」を押して確認URLとパスコードを作成してください。",
    "",
    "オーダーオート",
    `代表 ${COMPANY.representative}`,
    COMPANY.address,
    `TEL ${COMPANY.phone}`,
  ].join("\n");

  emailBody.value = body;
}

function buildLineMessage() {
  const data = getFormData();
  const url = document.querySelector("#email-url")?.value.trim() || "【確認URL】";

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

function buildConsentPayload(contract = currentContract(), accessToken = "", expiresAt = 0) {
  const data = getFormData();
  const validUntil = expiresAt || Date.now() + 7 * 24 * 60 * 60 * 1000;
  if (cloudEnabled()) {
    return {
      id: contract?.id || activeId,
      contractNumber: contract?.contractNumber,
      cloudMode: true,
      createdAt: contract?.createdAt || formatDateTime(),
      expiresAt: validUntil,
      accessToken,
      company: COMPANY,
    };
  }

  return {
    id: contract?.id || activeId,
    contractNumber: contract?.contractNumber,
    createdAt: contract?.createdAt || formatDateTime(),
    expiresAt: validUntil,
    data,
    company: COMPANY,
  };
}

async function generateConsentUrl() {
  const emailUrl = document.querySelector("#email-url");
  const passcodeField = document.querySelector("#consent-passcode");
  if (!emailUrl || !passcodeField) return;
  const selectedContract = currentContract();
  if (!selectedContract) {
    setSaveStatus("契約一覧から送信する契約を選択してください。", "warning");
    return;
  }
  if (selectedContract.status === "完了" || selectedContract.consentStatus === "完了") {
    setSaveStatus("完了済みの契約は確認URLを再発行できません。", "warning");
    return;
  }
  if (window.OrderAutoCloud?.isConfigured() && !cloudEnabled()) {
    setSaveStatus(
      "管理者ログインの有効期限が切れています。再ログインしてから確認URLを生成してください。",
      "warning",
    );
    return;
  }
  saveActiveContract("送信済み");
  const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
  const passcode = generatePasscode();
  const url = new URL("consent.html", window.location.href);

  if (cloudEnabled()) {
    const synced = await syncActiveContractToCloud();
    if (!synced) return;
    const accessToken = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(24)));
    const accessCredential = `${accessToken}.${passcode}`;
    try {
      await window.OrderAutoCloud.createConsentAccess(
        currentContract().id,
        accessCredential,
        expiresAt,
      );
    } catch (error) {
      setSaveStatus("お客様確認URLの安全な公開設定に失敗しました。再度お試しください。", "warning");
      return;
    }
    url.hash = `r=${accessToken}`;
  } else {
    const payload = buildConsentPayload(currentContract(), "", expiresAt);
    const encrypted = await encryptPayload(payload, passcode);
    const encoded = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(encrypted)));
    url.hash = `payload=${encoded}`;
  }

  emailUrl.value = url.toString();
  passcodeField.value = passcode;
  buildEmailBody();
  setSaveStatus(
    cloudEnabled()
      ? "短い確認URLと開封パスコードを生成しました。パスコードは別送してください。"
      : "暗号化した確認URLと開封パスコードを生成しました。パスコードは別送してください。",
    "success",
  );
}

async function copyConsentUrl() {
  const field = document.querySelector("#email-url");
  if (!field) return;
  if (!field.value.trim()) {
    await generateConsentUrl();
  }
  if (!field.value.trim()) return;

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
  if (!field) return;
  if (!field.value.trim()) {
    await generateConsentUrl();
  }
  if (!field.value.trim()) return;

  try {
    await navigator.clipboard.writeText(field.value);
    setSaveStatus("開封パスコードをコピーしました。URLとは別経路で送ってください。", "success");
  } catch (error) {
    field.select();
    setSaveStatus("パスコード欄を選択しました。手動でコピーしてください。", "warning");
  }
}

async function copyLineMessage() {
  const emailUrl = document.querySelector("#email-url");
  if (!emailUrl) return;
  if (!emailUrl.value.trim()) {
    await generateConsentUrl();
  }
  if (!emailUrl.value.trim()) return;

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
  saveActiveContract(currentContract()?.status || "下書き", { createIfMissing: true });

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
  const emailUrl = document.querySelector("#email-url");
  const emailBody = document.querySelector("#email-body");
  if (!emailUrl || !emailBody) return;
  if (!emailUrl.value.trim()) {
    await generateConsentUrl();
  }
  if (!emailUrl.value.trim()) return;
  saveActiveContract("送信済み");
  const data = getFormData();
  const subject = `契約内容確認のお願い（${contractTitle(data)}）`;
  const params = new URLSearchParams({
    subject,
    body: emailBody.value,
  });
  window.location.href = `mailto:${encodeURIComponent(data.sellerEmail || "")}?${params.toString()}`;
}

function setupSignatureCanvas() {
  const canvas = document.querySelector("#signature-canvas");
  if (!canvas) return;
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

  document.querySelector("#clear-signature")?.addEventListener("click", () => {
    context.clearRect(0, 0, canvas.width, canvas.height);
    signatureData = "";
    saveActiveContract("署名待ち");
  });

  document.querySelector("#save-signature")?.addEventListener("click", () => {
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
    if (event.target.name === "sellerPostalCode" && postalCodeDigits(event.target.value).length === 7) {
      schedulePostalCodeLookup();
    }
    updateModePanels();
    updatePreview();
  });

  form.addEventListener("change", (event) => {
    if (event.target.name === "purchaseAmount") {
      renderConsents(getFormData(), new FormData(form).getAll("consents"));
    }
    if (event.target.name === "sellerPostalCode") {
      schedulePostalCodeLookup(true);
    }
    updateModePanels();
    updatePreview();
  });

  document.querySelectorAll("[data-app-page]").forEach((button) => {
    button.addEventListener("click", () => {
      const page = button.dataset.appPage;
      if (page === "create") {
        clearContractForm(false);
        const completionMethod = button.dataset.completionMethod;
        if (completionMethod && form.elements.completionMethod) {
          form.elements.completionMethod.value = completionMethod;
          updateModePanels();
          updatePreview();
        }
      }
      setAppPage(page);
    });
  });

  window.addEventListener("hashchange", () => {
    setAppPage(appPageFromHash(), false);
  });

  document.querySelector("#new-contract").addEventListener("click", () => {
    createBlankContract();
    setAppPage("create");
  });
  document.querySelector("#clear-contract-form")?.addEventListener("click", () => {
    clearContractForm(true);
  });
  document.querySelector("#remote-selected-contract")?.addEventListener("click", (event) => {
    const pageButton = event.target.closest("[data-app-page]");
    if (!pageButton) return;
    setAppPage(pageButton.dataset.appPage);
  });
  document.querySelector("#export-contracts").addEventListener("click", exportContracts);
  document.querySelector("#import-contracts").addEventListener("click", () => {
    document.querySelector("#import-contract-file").click();
  });
  document.querySelector("#import-contract-file").addEventListener("change", (event) => {
    importContractsFile(event.target.files?.[0]);
    event.target.value = "";
  });
  document.querySelector("#save-contract").addEventListener("click", () => {
    saveActiveContract("下書き", { createIfMissing: true });
  });
  document.querySelector("#cloud-save-contract").addEventListener("click", submitCloudRecord);
  document.querySelectorAll("[data-preview-copy]").forEach((button) => {
    button.addEventListener("click", () => setPreviewCopy(button.dataset.previewCopy));
  });
  document.querySelector("#complete-contract").addEventListener("click", () => {
    const contract = currentContract();
    if (contract) contract.completedAt = formatDateTime();
    saveActiveContract("完了", { createIfMissing: true });
    submitCloudRecord();
  });
  document.querySelector("#print-contract").addEventListener("click", () => {
    saveActiveContract(currentContract()?.status || "下書き", { createIfMissing: true });
    printTemplateContract(currentContract());
  });
  document.querySelector("#download-customer-pdf").addEventListener("click", async () => {
    saveActiveContract(currentContract()?.status || "下書き", { createIfMissing: true });
    try {
      setSaveStatus("お客様控えPDFを作成しています。", "pending");
      await downloadCustomerPdf(currentContract());
      setSaveStatus("お客様控えPDFを端末に保存しました。", "success");
    } catch (error) {
      console.error(error);
      setSaveStatus("PDF保存に失敗しました。もう一度お試しください。", "warning");
    }
  });
  document.querySelector("#generate-consent-url")?.addEventListener("click", () => {
    generateConsentUrl();
  });
  document.querySelector("#copy-consent-url")?.addEventListener("click", copyConsentUrl);
  document.querySelector("#copy-line-message")?.addEventListener("click", copyLineMessage);
  document.querySelector("#copy-consent-passcode")?.addEventListener("click", copyConsentPasscode);
  document.querySelector("#open-email")?.addEventListener("click", openEmail);
  document.querySelector("#email-url")?.addEventListener("input", buildEmailBody);
  document.querySelector("#contract-search").addEventListener("input", renderList);
  document.querySelector("#identity-photo-input")?.addEventListener("change", handleIdentityPhotoSelect);
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
  document.querySelector("#identity-photo-list")?.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-remove-identity-photo]");
    if (!button) return;
    const index = Number(button.dataset.removeIdentityPhoto);
    const removed = identityFiles[index];
    identityFiles = identityFiles.filter((_, itemIndex) => itemIndex !== index);
    renderIdentityFiles();
    saveActiveContract(currentContract()?.status || "下書き");
    if (removed?.storagePath && cloudEnabled() && window.OrderAutoCloud?.deleteFile) {
      try {
        const synced = await syncActiveContractToCloud();
        if (!synced) return;
        await window.OrderAutoCloud.deleteFile(removed.storagePath);
        identityPreviewUrls.delete(removed.storagePath);
      } catch (error) {
        setSaveStatus("端末から削除しました。クラウド側の削除は再度確認してください。", "warning");
        return;
      }
    }
    setSaveStatus("本人確認書類の写真を削除しました。", "success");
  });

  document.querySelector("#contract-list").addEventListener("click", async (event) => {
    const deleteButton = event.target.closest("[data-delete-contract]");
    if (deleteButton) {
      saveActiveContract();
      await deleteContract(deleteButton.dataset.deleteContract);
      return;
    }

    const remoteButton = event.target.closest("[data-send-remote-contract]");
    if (remoteButton) {
      selectRemoteContract(remoteButton.dataset.sendRemoteContract);
      setAppPage("remote");
      return;
    }

    const editButton = event.target.closest("[data-edit-contract]");
    if (!editButton) return;
    saveActiveContract();
    activeId = editButton.dataset.editContract;
    populateForm(currentContract());
    renderList();
    setAppPage("create");
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
  populateBirthdateSelects();
  setupEvents();
  setupSignatureCanvas();

  if (contracts.length) {
    activeId = contracts[0].id;
    populateForm(currentContract());
  } else {
    activeId = "";
    populateForm({ data: defaultContractData(), signatureData: "", identityFiles: [] });
  }
  renderList();

  const initialPage = appPageFromHash();
  if (initialPage === "create") {
    clearContractForm(false);
  }
  setAppPage(initialPage, false);
  loadCloudContracts();
});
