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
  data.completionMethod = form.elements.completionMethod?.value || "paper";
  data.consents = new FormData(form).getAll("consents");
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
  if (!list) return;
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

function timeText(value) {
  const cleaned = String(value || "").trim();
  const match = cleaned.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return cleaned;
  return String(Number(match[1]));
}

function deadlineLine(dateValue, timeValue) {
  const parts = dateParts(dateValue);
  const time = timeText(timeValue);
  if (parts.year && time) {
    return `${escapeHtml(parts.year)} 年 ${escapeHtml(parts.month)} 月 ${escapeHtml(parts.day)} 日 ${escapeHtml(time)}`;
  }
  if (parts.year) {
    return `${escapeHtml(parts.year)} 年 ${escapeHtml(parts.month)} 月 ${escapeHtml(parts.day)} 日`;
  }
  return time ? escapeHtml(time) : "";
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

function yenBox(data) {
  const amount = amountNumber(data);
  return amount ? `${Number(amount).toLocaleString("ja-JP")}` : "";
}

function paymentYenBox(data) {
  const amount = paymentAmountNumber(data);
  return amount ? `${Number(amount).toLocaleString("ja-JP")}` : "";
}

function amountDigitCells(data) {
  const amount = amountNumber(data);
  const digits = amount ? amount.slice(-7).padStart(7, " ") : "       ";
  return Array.from(digits)
    .map((digit) => `<td class="${digit.trim() ? "filled" : ""}">${escapeHtml(digit.trim())}</td>`)
    .join("");
}

function choiceMark(value, expected) {
  return String(value || "") === expected ? "●" : "○";
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

function documentCheck(documents, name) {
  return documents.includes(name) ? "☑" : "□";
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
        <div class="print-page">${contractTemplateSvg(contract, "shop")}</div>
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

function renderDocument(contract) {
  const data = contract?.data || getFormData();
  const documents = data.documents || [];
  const contractDate = dateParts(new Date().toISOString().slice(0, 10));
  const sellerBirth = dateParts(data.sellerBirthdate);
  const amount = yenBox(data);
  const paymentAmount = paymentYenBox(data);
  const loanTransferDate = dateParts(data.loanTransferDate);
  const loanCompany = hasLoan(data) ? data.loanCompany : "";
  const loanBalanceAmount = hasLoan(data) ? loanBalanceAmountNumber(data) : "";
  const bankName = hasBankTransfer(data) ? data.bankName : "";
  const branchName = hasBankTransfer(data) ? data.branchName : "";
  const accountType = hasBankTransfer(data) ? data.accountType : "";
  const accountNumber = hasBankTransfer(data) ? data.accountNumber : "";
  const accountHolderKana = hasBankTransfer(data) ? data.accountHolderKana : "";
  const accountHolder = hasBankTransfer(data) ? data.accountHolder : "";
  const signatureBlock = signatureData
    ? `<img class="signature-image" src="${signatureData}" alt="売主電子署名" />`
    : "";
  const sellerHomePhone = data.sellerHomePhone || data.sellerPhone || "";
  const sellerMobile = data.sellerMobile || "";

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
        <h3>1.契約車両の表示及び状況</h3>
        <table class="vehicle-form-table vehicle-info-table">
          <colgroup>
            <col class="vehicle-label-col">
            <col>
            <col class="vehicle-label-col">
            <col>
          </colgroup>
          <tr>
            <th>車　名</th>
            <td>${formValue(data.carName)}</td>
            <th>車台番号</th>
            <td>${formValue(data.chassisNumber)}</td>
          </tr>
          <tr>
            <th>グレード</th>
            <td>${formValue(data.carGrade)}</td>
            <th>登録番号</th>
            <td>${formValue(data.plateNumber)}</td>
          </tr>
          <tr>
            <th>年　式</th>
            <td>${formValue(data.carYear)}</td>
            <th>色</th>
            <td>${formValue(data.carColor)}</td>
          </tr>
          <tr class="vehicle-condition-row">
            <th>走行距離</th>
            <td class="mileage-cell">
              <span>${formValue(data.mileage)}</span>
              <b>km</b>
            </td>
            <td colspan="2" class="condition-matrix">
              <table>
                <tr>
                  <th>エンジンの不具合</th>
                  <th>オートマミッションの不具合</th>
                  <th>パワーステアリングの不具合</th>
                </tr>
                <tr>
                  <td>${choiceMark(yesNoValue(data.engineDefect || data.defect), "無")}無　${choiceMark(yesNoValue(data.engineDefect || data.defect), "有")}有</td>
                  <td>${choiceMark(yesNoValue(data.transmissionDefect), "無")}無　${choiceMark(yesNoValue(data.transmissionDefect), "有")}有</td>
                  <td>${choiceMark(yesNoValue(data.powerSteeringDefect), "無")}無　${choiceMark(yesNoValue(data.powerSteeringDefect), "有")}有</td>
                </tr>
                <tr>
                  <th>サスペンションの不具合</th>
                  <th>走行上の不都合</th>
                  <th>駐車違反放置違反金未納</th>
                </tr>
                <tr>
                  <td>${choiceMark(yesNoValue(data.suspensionDefect), "無")}無　${choiceMark(yesNoValue(data.suspensionDefect), "有")}有</td>
                  <td>${choiceMark(yesNoValue(legacyDrivingDefectValue(data)), "無")}無　${choiceMark(yesNoValue(legacyDrivingDefectValue(data)), "有")}有</td>
                  <td>${choiceMark(yesNoValue(data.parkingViolationUnpaid), "無")}無　${choiceMark(yesNoValue(data.parkingViolationUnpaid), "有")}有</td>
                </tr>
                <tr>
                  <th>修復歴</th>
                  <th>メーター戻し・交換・走行距離不明</th>
                  <th>災害歴</th>
                </tr>
                <tr>
                  <td>${choiceMark(yesNoValue(data.repairHistory), "無")}無　${choiceMark(yesNoValue(data.repairHistory), "有")}有</td>
                  <td>${choiceMark(yesNoValue(data.meterIssue), "無")}無　${choiceMark(yesNoValue(data.meterIssue), "有")}有</td>
                  <td>${choiceMark(yesNoValue(data.disasterHistory), "無")}無　${choiceMark(yesNoValue(data.disasterHistory), "有")}有</td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </section>

      <section class="vehicle-form-section">
        <h3>2.売買契約金額 <small>（消費税等込み）</small></h3>
        <div class="amount-area photo-amount-area">
          <table class="vehicle-form-table amount-table">
            <tr class="amount-labels">
              <th></th><th>百万</th><th>十万</th><th>万</th><th>千</th><th>百</th><th>十</th><th>一</th><th>円</th>
            </tr>
            <tr class="amount-digits">
              <td></td>${amountDigitCells(data)}<td>円</td>
            </tr>
          </table>
          <p>
            なお、左記価格は自賠責保険未経過保険料相当額、未経過自動車税（種別割）、重量税、リサイクル預託金額を含むものとします。<br>
            また、自動車税（種別割）は今期分までを完納していることを前提とします。
          </p>
        </div>

        <table class="vehicle-form-table tax-table">
          <tr>
            <th>自動車税（種別割）</th>
            <td>
              （ ${choiceMark(data.automobileTaxStatus || "完納", "完納")}完納 ・
              ${choiceMark(data.automobileTaxStatus, "未納")}未納 ・
              ${choiceMark(data.automobileTaxStatus, "課税保留")}課税保留 ・
              ${choiceMark(data.automobileTaxStatus, "減免")}減免 ）
            </td>
            <th>未納金額</th>
            <td class="amount-mini-cells">十万　　万　　千　　百　　十</td>
            <td class="yen-field">${escapeHtml(Number(automobileTaxUnpaidAmountNumber(data)).toLocaleString("ja-JP"))} 円</td>
          </tr>
        </table>

        <table class="vehicle-form-table money-table">
          <tr>
            <th>残債先</th>
            <td>${formValue(loanCompany)}</td>
            <th>振込希望日</th>
            <td>${loanTransferDate.year || "　"} 年 ${loanTransferDate.month || "　"} 月 ${loanTransferDate.day || "　"} 日</td>
            <th>残債金額</th>
            <td class="yen-field">${loanBalanceAmount ? escapeHtml(Number(loanBalanceAmount).toLocaleString("ja-JP")) : ""} 円</td>
          </tr>
          <tr>
            <th>支払<br>代金</th>
            <td colspan="4" class="amount-mini-cells">百万　十万　万　千　百　十　一</td>
            <td class="yen-field">${escapeHtml(paymentAmount)} 円</td>
          </tr>
        </table>
      </section>

      <section class="vehicle-form-section">
        <h3>3.車両引渡期限、移転登録書類等 引渡期限及び支払期限</h3>
        <table class="vehicle-form-table deadline-table">
          <tr>
            <th>車両引渡<br>期限</th>
            <td>${deadlineLine(data.pickupDate, data.pickupTime) || ""}</td>
            <th>書類引渡<br>期限</th>
            <td>${deadlineLine(data.documentDeliveryDate, data.documentDeliveryTime) || ""}</td>
            <th>支払期限</th>
            <td>${deadlineLine(data.paymentDate, data.paymentTime) || ""}</td>
          </tr>
        </table>
      </section>

      <section class="vehicle-form-section">
        <h3>4.特記事項</h3>
        <div class="special-note">${formValue(data.vehicleNote)}</div>
      </section>

      <section class="vehicle-form-section">
        <h3>5.お振込口座 <small>口座名義は原則として申込者（売主）またはご所有者のものに限ります。</small></h3>
        <table class="vehicle-form-table bank-table simple-bank-table">
          <tr>
            <th>銀行名</th>
            <th>支店名</th>
            <th>口座種別</th>
            <th>口座番号</th>
            <th>口座名義</th>
          </tr>
          <tr>
            <td>${formValue(bankName)}</td>
            <td>${formValue(branchName)}</td>
            <td>${formValue(accountType)}</td>
            <td>${formValue(accountNumber)}</td>
            <td>${formValue(accountHolderKana || accountHolder)}</td>
          </tr>
        </table>
      </section>

      <section class="vehicle-form-section">
        <h3>6.車両名義人 <small>申込者（売主）は、車両の名義人がご自身と異なる場合、正当な権限があることを保証します。</small></h3>
        <table class="vehicle-form-table owner-table">
          <tr>
            <th>所有者</th>
            <td>${formValue(data.ownerType || "売主")}（名義人 ${formValue(data.ownerName, "")}）</td>
            <th>売主との関係</th>
            <td>${formValue(data.ownerRelationship, "")}</td>
          </tr>
          <tr>
            <th>使用者</th>
            <td>${formValue(data.userType || "売主")}（名義人 ${formValue(data.userName, "")}）</td>
            <th>売主との関係</th>
            <td>${formValue(data.userRelationship, "")}</td>
          </tr>
        </table>
      </section>

      <p class="application-statement">
        売主と買主とは、上記内容及び裏面の契約条項を承認し、上記車両について売買契約を締結します。<br>
        本売買契約をもって、上記車両の売買契約が成立します。詳細は裏面の契約条項をご確認ください。<br>
        売主は、自賠責保険未経過保険料相当額、未経過自動車税（種別割）、重量税、リサイクル預託金のそれぞれの取扱いについて説明を受け、ご承諾された後、ご署名ください。
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
          <table class="seller-table">
            <colgroup>
              <col class="seller-label-col">
              <col>
              <col class="seller-stamp-col">
            </colgroup>
            <tr class="seller-name-row">
              <th>フリガナ</th>
              <td>${formValue(data.sellerKana)}</td>
              <td class="stamp-cell" rowspan="2">印</td>
            </tr>
            <tr class="seller-name-row">
              <th>お名前</th>
              <td>${formValue(data.sellerName)}</td>
            </tr>
            <tr class="seller-contract-row">
              <th class="seller-contract-label" rowspan="5">ご契約者</th>
              <td colspan="2" class="seller-address-block">
                <div>〒　${formValue(data.sellerPostalCode, "　　　－")}</div>
                <div>ご住所　${formValue(data.sellerAddress)}</div>
              </td>
            </tr>
            <tr>
              <td colspan="2" class="seller-phone-number-row">
                <span>自宅電話</span><strong>${formValue(sellerHomePhone)}</strong>
                <span>携帯電話</span><strong>${formValue(sellerMobile)}</strong>
              </td>
            </tr>
            <tr class="seller-subrow">
              <td colspan="2"><span>生年月日</span><strong>${sellerBirth.year || "　"} 年 ${sellerBirth.month || "　"} 月 ${sellerBirth.day || "　"} 日</strong></td>
            </tr>
            <tr class="seller-subrow">
              <td colspan="2"><span>ご勤務先名</span><strong>${formValue(data.workplace)}</strong></td>
            </tr>
            <tr class="seller-subrow">
              <td colspan="2"><span>電話</span><strong>（　　　　）　　　　－</strong></td>
            </tr>
          </table>
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
  const nextPage = ["top", "create", "list"].includes(page) ? page : "top";
  activeAppPage = nextPage;

  document.querySelectorAll("[data-app-view]").forEach((view) => {
    view.hidden = view.dataset.appView !== activeAppPage;
  });

  document.querySelectorAll("[data-app-page]").forEach((button) => {
    button.classList.toggle("active", button.dataset.appPage === activeAppPage);
  });

  if (updateHash) {
    const nextHash = activeAppPage === "top" ? "#top" : activeAppPage === "create" ? "#create" : "#list";
    if (window.location.hash !== nextHash) {
      history.replaceState(null, "", nextHash);
    }
  }
}

function appPageFromHash() {
  const hash = window.location.hash.replace("#", "");
  if (hash === "create" || hash === "contract-app") return "create";
  if (hash === "list" || hash === "contracts") return "list";
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
            <button class="mini-button" type="button" data-edit-contract="${contract.id}">編集</button>
            <button class="mini-button danger" type="button" data-delete-contract="${contract.id}">削除</button>
          </div>
        </article>
      `;
    })
    .join("");
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
  const emailUrl = document.querySelector("#email-url");
  const passcodeField = document.querySelector("#consent-passcode");
  if (!emailUrl || !passcodeField) return;
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
  emailUrl.value = url.toString();
  passcodeField.value = passcode;
  buildEmailBody();
  setSaveStatus(
    "暗号化した確認URLと開封パスコードを生成しました。パスコードは別送してください。",
    "success",
  );
}

async function copyConsentUrl() {
  const field = document.querySelector("#email-url");
  if (!field) return;
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
  if (!field) return;
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
  const emailUrl = document.querySelector("#email-url");
  if (!emailUrl) return;
  if (!emailUrl.value.trim()) {
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
  const emailUrl = document.querySelector("#email-url");
  const emailBody = document.querySelector("#email-body");
  if (!emailUrl || !emailBody) return;
  if (!emailUrl.value.trim()) {
    await generateConsentUrl();
  }
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

  document.querySelectorAll("[data-app-page]").forEach((button) => {
    button.addEventListener("click", () => {
      const page = button.dataset.appPage;
      if (page === "create" && !contracts.length) {
        createBlankContract();
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
  document.querySelectorAll("[data-preview-copy]").forEach((button) => {
    button.addEventListener("click", () => setPreviewCopy(button.dataset.previewCopy));
  });
  document.querySelector("#complete-contract").addEventListener("click", () => {
    const contract = currentContract();
    if (contract) contract.completedAt = formatDateTime();
    saveActiveContract("完了");
    submitCloudRecord();
  });
  document.querySelector("#print-contract").addEventListener("click", () => {
    saveActiveContract(currentContract()?.status || "下書き");
    printTemplateContract(currentContract());
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
  document.querySelector("#identity-photo-list")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove-identity-photo]");
    if (!button) return;
    const index = Number(button.dataset.removeIdentityPhoto);
    identityFiles = identityFiles.filter((_, itemIndex) => itemIndex !== index);
    renderIdentityFiles();
    saveActiveContract(currentContract()?.status || "下書き");
    setSaveStatus("本人確認書類の写真を削除しました。", "success");
  });

  document.querySelector("#contract-list").addEventListener("click", async (event) => {
    const deleteButton = event.target.closest("[data-delete-contract]");
    if (deleteButton) {
      saveActiveContract();
      await deleteContract(deleteButton.dataset.deleteContract);
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
  setupEvents();
  setupSignatureCanvas();

  if (!contracts.length) {
    createBlankContract();
  } else {
    activeId = contracts[0].id;
    populateForm(currentContract());
    renderList();
  }

  setAppPage(appPageFromHash(), false);
  loadCloudContracts();
});
