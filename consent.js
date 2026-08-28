const ORDER_AUTO_EMAIL = "sora29128616@gmail.com";
const ORDER_AUTO = {
  name: "オーダーオート",
  representative: "空 篤志",
  address: "広島県広島市佐伯区皆賀1-10-20",
  phone: "070-8996-6421",
};

const COMMON_CONSENT_TEXTS = [
  "契約内容を確認しました",
  "車両情報に間違いありません",
];

const PAID_CONSENT_TEXTS = [
  "買取金額に同意します",
  "還付金等は買取金額に含まれることに同意します",
];

const ZERO_AMOUNT_CONSENT_TEXTS = [
  "買取金額が0円であることに同意します",
  "引取後に買取代金を請求しません",
  "重量税・自賠責・リサイクル券・自動車税の還付または返戻金を請求しません",
];

let loadedContract = null;
let isDrawing = false;
let hasCustomerSignature = false;
let completedConsentResult = null;
let completionEmail = null;
let preparedIdentityDocuments = [];
const DEFAULT_CRYPTO_ITERATIONS = 200000;

function base64UrlToBytes(value) {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

function decodeEnvelope() {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const encoded = params.get("payload");
  if (!encoded) return null;

  const bytes = base64UrlToBytes(encoded);
  return JSON.parse(new TextDecoder().decode(bytes));
}

function decodeShortAccessToken() {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const token = String(params.get("r") || "").trim();
  return /^[A-Za-z0-9_-]{32}$/.test(token) ? token : "";
}

function normalizePasscode(value) {
  return String(value || "").trim().replaceAll("-", "");
}

async function deriveDecryptionKey(passcode, salt, iterations) {
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
      iterations: iterations || DEFAULT_CRYPTO_ITERATIONS,
      hash: "SHA-256",
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
}

async function decryptEnvelope(envelope, passcode) {
  const salt = base64UrlToBytes(envelope.salt);
  const iv = base64UrlToBytes(envelope.iv);
  const ciphertext = base64UrlToBytes(envelope.ciphertext);
  const key = await deriveDecryptionKey(passcode, salt, envelope.iterations);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return JSON.parse(new TextDecoder().decode(plaintext));
}

async function decryptEnvelopeWithPasscodeVariants(envelope, passcode) {
  const cleaned = String(passcode || "").trim();
  const digitsOnly = cleaned.replaceAll("-", "");
  const variants = [cleaned];

  if (digitsOnly && digitsOnly !== cleaned) {
    variants.push(digitsOnly);
  }

  if (/^\d{8}$/.test(digitsOnly)) {
    variants.push(`${digitsOnly.slice(0, 4)}-${digitsOnly.slice(4)}`);
  }

  const uniqueVariants = [...new Set(variants)];
  let lastError;

  for (const candidate of uniqueVariants) {
    try {
      return await decryptEnvelope(envelope, candidate);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("Invalid passcode");
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

function yen(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "0円";
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
    ...COMMON_CONSENT_TEXTS,
    ...(isZeroAmountContract(data) ? ZERO_AMOUNT_CONSENT_TEXTS : PAID_CONSENT_TEXTS),
  ];
}

function text(value, fallback = "未入力") {
  const cleaned = String(value ?? "").trim();
  return cleaned || fallback;
}

function encodeMailtoValue(value) {
  return encodeURIComponent(String(value ?? "")).replace(/%0A/g, "%0D%0A");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function summaryRow(label, value) {
  return `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(text(value))}</dd></div>`;
}

function contractTypeLabel(data) {
  return isZeroAmountContract(data) ? "売買契約（買取金額0円）" : "売買契約";
}

function displayContractNumber(contract) {
  const number = Number(contract?.contractNumber);
  return Number.isInteger(number) && number > 0 ? String(number) : text(contract?.id);
}

function remoteField(id) {
  return document.querySelector(`#${id}`);
}

function setRemoteSellerType(type) {
  const normalized = type === "corporate" ? "corporate" : "individual";
  remoteField("remote-seller-type").value = normalized;
  document.querySelectorAll("[data-seller-kind]").forEach((group) => {
    group.hidden = group.dataset.sellerKind !== normalized;
  });
  syncCustomerNameFromSeller();
}

function sellerInputValue(id) {
  return String(remoteField(id)?.value || "").trim();
}

function collectRemoteSeller() {
  const sellerType = sellerInputValue("remote-seller-type") === "corporate" ? "corporate" : "individual";
  return {
    sellerType,
    sellerLastName: sellerInputValue("remote-seller-last-name"),
    sellerFirstName: sellerInputValue("remote-seller-first-name"),
    sellerLastKana: sellerInputValue("remote-seller-last-kana"),
    sellerFirstKana: sellerInputValue("remote-seller-first-kana"),
    sellerPostalCode: sellerInputValue("remote-seller-postal"),
    sellerAddress: sellerInputValue("remote-seller-address"),
    sellerHomePhone: sellerInputValue("remote-seller-home-phone"),
    sellerMobile: sellerInputValue("remote-seller-mobile"),
    sellerEmail: sellerInputValue("remote-seller-email"),
    sellerBirthdate: sellerInputValue("remote-seller-birthdate"),
    corporateName: sellerInputValue("remote-corporate-name"),
    corporateNumber: sellerInputValue("remote-corporate-number"),
    corporatePostalCode: sellerInputValue("remote-corporate-postal"),
    corporateAddress: sellerInputValue("remote-corporate-address"),
    corporatePhone: sellerInputValue("remote-corporate-phone"),
    representativeTitle: sellerInputValue("remote-representative-title"),
    representativeLastName: sellerInputValue("remote-representative-last-name"),
    representativeFirstName: sellerInputValue("remote-representative-first-name"),
    identityType: "運転免許証",
    identityNumber: sellerInputValue("remote-identity-number"),
    licenseBackStatus: sellerInputValue("remote-license-back-status") === "has_entries" ? "has_entries" : "none",
  };
}

function sellerSignatureName(seller = collectRemoteSeller()) {
  return seller.sellerType === "corporate"
    ? `${seller.representativeLastName} ${seller.representativeFirstName}`.trim()
    : `${seller.sellerLastName} ${seller.sellerFirstName}`.trim();
}

function syncCustomerNameFromSeller() {
  const name = sellerSignatureName();
  remoteField("customer-name").value = name;
}

function populateRemoteSeller(data) {
  const mappings = {
    "remote-seller-last-name": data.sellerLastName,
    "remote-seller-first-name": data.sellerFirstName,
    "remote-seller-last-kana": data.sellerLastKana,
    "remote-seller-first-kana": data.sellerFirstKana,
    "remote-seller-postal": data.sellerPostalCode,
    "remote-seller-address": data.sellerAddress,
    "remote-seller-home-phone": data.sellerHomePhone,
    "remote-seller-mobile": data.sellerMobile || data.sellerPhone,
    "remote-seller-email": data.sellerEmail,
    "remote-seller-birthdate": data.sellerBirthdate,
    "remote-corporate-name": data.corporateName,
    "remote-corporate-number": data.corporateNumber,
    "remote-corporate-postal": data.corporatePostalCode,
    "remote-corporate-address": data.corporateAddress,
    "remote-corporate-phone": data.corporatePhone,
    "remote-representative-title": data.representativeTitle,
    "remote-representative-last-name": data.representativeLastName,
    "remote-representative-first-name": data.representativeFirstName,
    "remote-identity-number": data.identityNumber,
    "remote-license-back-status": data.licenseBackStatus || "none",
  };
  Object.entries(mappings).forEach(([id, value]) => {
    const field = remoteField(id);
    if (field) field.value = String(value || "");
  });
  setRemoteSellerType(data.sellerType);
  remoteField("remote-license-back-field").hidden =
    sellerInputValue("remote-license-back-status") !== "has_entries";
}

function markRemoteField(id, missing) {
  const field = remoteField(id);
  if (!field) return;
  field.classList.toggle("field-error", missing);
  field.setAttribute("aria-invalid", missing ? "true" : "false");
}

function validateRemoteSellerForm() {
  const seller = collectRemoteSeller();
  const individualRequired = [
    "remote-seller-last-name", "remote-seller-first-name", "remote-seller-postal",
    "remote-seller-address", "remote-seller-birthdate",
  ];
  const corporateRequired = [
    "remote-corporate-name", "remote-corporate-postal", "remote-corporate-address",
    "remote-corporate-phone", "remote-representative-last-name", "remote-representative-first-name",
  ];
  const required = seller.sellerType === "corporate" ? corporateRequired : individualRequired;
  const missing = [];
  [...individualRequired, ...corporateRequired].forEach((id) => markRemoteField(id, false));
  required.forEach((id) => {
    const isMissing = !sellerInputValue(id);
    markRemoteField(id, isMissing);
    if (isMissing) missing.push(id);
  });
  if (seller.sellerType === "individual") {
    const phoneMissing = !seller.sellerMobile && !seller.sellerHomePhone;
    markRemoteField("remote-seller-mobile", phoneMissing);
    markRemoteField("remote-seller-home-phone", phoneMissing);
    if (phoneMissing) missing.push("remote-seller-mobile");
  }
  const identityMissing = !seller.identityNumber;
  markRemoteField("remote-identity-number", identityMissing);
  if (identityMissing) missing.push("remote-identity-number");
  const frontMissing = !remoteField("remote-license-front").files?.[0];
  markRemoteField("remote-license-front", frontMissing);
  if (frontMissing) missing.push("remote-license-front");
  const backMissing = seller.licenseBackStatus === "has_entries" && !remoteField("remote-license-back").files?.[0];
  markRemoteField("remote-license-back", backMissing);
  if (backMissing) missing.push("remote-license-back");
  remoteField("remote-seller-error").hidden = missing.length === 0;
  if (missing.length) remoteField(missing[0])?.scrollIntoView({ behavior: "smooth", block: "center" });
  return missing.length === 0;
}

function fileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result || "")));
    reader.addEventListener("error", reject);
    reader.readAsDataURL(file);
  });
}

function imageFromDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image));
    image.addEventListener("error", reject);
    image.src = dataUrl;
  });
}

async function prepareRemoteIdentityDocument(file, side) {
  if (!file || !["image/jpeg", "image/png"].includes(file.type) || file.size > 8 * 1024 * 1024) {
    throw new Error("本人確認画像は8MB以下のJPEGまたはPNGを選択してください。");
  }
  const source = await fileAsDataUrl(file);
  const image = await imageFromDataUrl(source);
  const scale = Math.min(1, 1400 / Math.max(image.width, image.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
  return { side, name: file.name, type: "image/jpeg", dataUrl: canvas.toDataURL("image/jpeg", 0.8) };
}

const CONSENT_STEPS = ["summary", "important", "sign", "complete"];

function setConsentProgress(step) {
  const currentIndex = Math.max(0, CONSENT_STEPS.indexOf(step));
  document.querySelectorAll("[data-consent-step]").forEach((item, index) => {
    item.classList.toggle("current", index === currentIndex);
    item.classList.toggle("completed", index < currentIndex);
    if (index === currentIndex) {
      item.setAttribute("aria-current", "step");
    } else {
      item.removeAttribute("aria-current");
    }
  });
}

function renderContract() {
  if (!loadedContract?.data) {
    document.querySelector("#consent-error").hidden = false;
    return;
  }

  const data = loadedContract.data;
  const amount = amountLabel(data);
  const contractNumber = displayContractNumber(loadedContract);
  const signatureCanvas = document.querySelector("#customer-signature");
  signatureCanvas.getContext("2d").clearRect(0, 0, signatureCanvas.width, signatureCanvas.height);
  hasCustomerSignature = false;
  document.querySelector("#customer-name").value = data.sellerName || "";
  populateRemoteSeller(data);
  document.querySelector("#summary-list").innerHTML = [
    summaryRow("契約番号", contractNumber),
    summaryRow("契約内容", contractTypeLabel(data)),
    summaryRow("売主氏名", data.sellerName),
    summaryRow("電話番号", data.sellerPhone),
    summaryRow("メール", data.sellerEmail),
    summaryRow("車名", data.carName),
    summaryRow("登録番号", data.plateNumber),
    summaryRow("車台番号", data.chassisNumber),
    summaryRow("走行距離", data.mileage),
    summaryRow("買取金額", amount),
    summaryRow("引取予定日", data.pickupDate),
    summaryRow("引取場所", data.pickupPlace),
    summaryRow("事業者", `${ORDER_AUTO.name} / 代表 ${ORDER_AUTO.representative}`),
    summaryRow("所在地", ORDER_AUTO.address),
  ].join("");

  const items = consentItems(data);
  document.querySelector("#customer-consents").innerHTML = items
    .map((item) => {
      return `<label><input type="checkbox" name="customerConsent" value="${escapeHtml(item)}" />${escapeHtml(item)}</label>`;
    })
    .join("");
  clearConsentValidation();

  document.querySelector("#consent-summary").hidden = false;
  document.querySelector("#seller-input-section").hidden = false;
  document.querySelector("#consent-check-section").hidden = false;
  document.querySelector("#customer-sign-section").hidden = false;
  document.querySelector("#consent-progress").hidden = false;
  document.querySelector("#consent-unlock").hidden = true;
  document.querySelector("#consent-error").hidden = true;
  setConsentProgress("summary");
}

async function hydrateCloudContractIfNeeded(contract) {
  if (!contract?.cloudMode) return contract;
  if (!window.OrderAutoCloud?.isConfigured()) {
    throw new Error("Supabase is not configured");
  }

  const cloudContract = await window.OrderAutoCloud.getContract(
    contract.id,
    contract.accessToken || "",
  );
  if (!cloudContract?.data) {
    throw new Error("Contract was not found");
  }

  return {
    ...contract,
    ...cloudContract,
    expiresAt: contract.expiresAt,
    company: contract.company || cloudContract.company,
  };
}

async function unlockConsent() {
  const passcode = document.querySelector("#consent-passcode-input").value.trim();
  if (!passcode) {
    document.querySelector("#consent-error").textContent = "開封パスコードを入力してください。";
    document.querySelector("#consent-error").hidden = false;
    return;
  }

  try {
    const shortAccessToken = decodeShortAccessToken();
    if (shortAccessToken) {
      if (!window.OrderAutoCloud?.isConfigured()) {
        throw new Error("Supabase is not configured");
      }
      const normalizedPasscode = normalizePasscode(passcode);
      if (!/^\d{8}$/.test(normalizedPasscode)) {
        throw new Error("Invalid passcode");
      }
      const accessCredential = `${shortAccessToken}.${normalizedPasscode}`;
      const cloudContract = await window.OrderAutoCloud.getContract("", accessCredential);
      if (!cloudContract?.data) {
        throw new Error("Contract was not found");
      }
      loadedContract = {
        ...cloudContract,
        cloudMode: true,
        accessToken: accessCredential,
      };
    } else {
      const envelope = decodeEnvelope();
      if (!envelope?.ciphertext || !envelope?.salt || !envelope?.iv) {
        throw new Error("Missing encrypted payload");
      }

      loadedContract = await decryptEnvelopeWithPasscodeVariants(envelope, passcode);
      loadedContract = await hydrateCloudContractIfNeeded(loadedContract);
    }

    if (loadedContract.expiresAt && Date.now() > loadedContract.expiresAt) {
      throw new Error("Expired contract URL");
    }

    renderContract();
  } catch (error) {
    loadedContract = null;
    document.querySelector("#consent-error").textContent =
      "契約データを開けませんでした。URL、パスコード、有効期限を確認してください。";
    document.querySelector("#consent-error").hidden = false;
  }
}

function checkedConsents() {
  return Array.from(document.querySelectorAll('[name="customerConsent"]:checked')).map(
    (item) => item.value,
  );
}

function setFieldError(element, errorElement, hasError) {
  if (element) {
    element.classList.toggle("field-error", hasError);
    element.setAttribute("aria-invalid", hasError ? "true" : "false");
  }
  if (errorElement) {
    errorElement.hidden = !hasError;
  }
}

function clearConsentValidation() {
  const customerName = document.querySelector("#customer-name");
  const customerConsents = document.querySelector("#customer-consents");
  const signatureCanvas = document.querySelector("#customer-signature");
  setFieldError(customerName, document.querySelector("#customer-name-error"), false);
  setFieldError(customerConsents, document.querySelector("#customer-consents-error"), false);
  setFieldError(signatureCanvas, document.querySelector("#customer-signature-error"), false);
  document.querySelectorAll('[name="customerConsent"]').forEach((checkbox) => {
    checkbox.closest("label")?.classList.remove("field-error");
    checkbox.removeAttribute("aria-invalid");
  });
  remoteField("remote-seller-error").hidden = true;
  document.querySelectorAll("#remote-seller-form input, #remote-seller-form select").forEach((field) => {
    field.classList.remove("field-error");
    field.removeAttribute("aria-invalid");
  });
}

function validateConsentForm() {
  const customerName = document.querySelector("#customer-name");
  const customerConsents = document.querySelector("#customer-consents");
  const signatureCanvas = document.querySelector("#customer-signature");
  const nameMissing = !customerName.value.trim();
  const uncheckedItems = Array.from(document.querySelectorAll('[name="customerConsent"]')).filter(
    (item) => !item.checked,
  );
  const consentsMissing = uncheckedItems.length > 0;
  const signatureMissing = !hasCustomerSignature;
  const sellerMissing = !validateRemoteSellerForm();

  setFieldError(customerName, document.querySelector("#customer-name-error"), nameMissing);
  setFieldError(customerConsents, document.querySelector("#customer-consents-error"), consentsMissing);
  setFieldError(signatureCanvas, document.querySelector("#customer-signature-error"), signatureMissing);
  document.querySelectorAll('[name="customerConsent"]').forEach((checkbox) => {
    const hasError = !checkbox.checked;
    checkbox.closest("label")?.classList.toggle("field-error", hasError);
    checkbox.setAttribute("aria-invalid", hasError ? "true" : "false");
  });

  if (!sellerMissing && !nameMissing && !consentsMissing && !signatureMissing) {
    return true;
  }

  const firstError = sellerMissing
    ? document.querySelector("#seller-input-section")
    : nameMissing
    ? customerName
    : consentsMissing
      ? customerConsents
      : signatureCanvas;
  firstError?.scrollIntoView({ behavior: "smooth", block: "center" });
  return false;
}

function allConsentsChecked() {
  const all = document.querySelectorAll('[name="customerConsent"]');
  return all.length > 0 && Array.from(all).every((item) => item.checked);
}

function setupSignature() {
  const canvas = document.querySelector("#customer-signature");
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
    setConsentProgress("sign");
  }

  function move(event) {
    if (!isDrawing) return;
    event.preventDefault();
    const next = point(event);
    context.lineTo(next.x, next.y);
    context.stroke();
    hasCustomerSignature = true;
    setFieldError(canvas, document.querySelector("#customer-signature-error"), false);
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

  document.querySelector("#clear-customer-signature").addEventListener("click", () => {
    context.clearRect(0, 0, canvas.width, canvas.height);
    hasCustomerSignature = false;
    setFieldError(canvas, document.querySelector("#customer-signature-error"), false);
  });
}

function buildCompletionEmail(result, data) {
  const body = [
    "車両売買契約の内容を確認し、電子署名と同意操作を完了しました。",
    "",
    `契約番号：${result.contractNumber}`,
    `署名者：${result.customerName}`,
    `車名：${text(data.carName)}`,
    `登録番号：${text(data.plateNumber)}`,
    `金額：${result.amount}`,
    `完了日時：${result.completedAt}`,
    "",
    "確認・同意した事項：",
    ...result.checkedConsents.map((item) => `・${item}`),
    "",
    "このメールは、お客様が契約確認ページで電子署名と同意操作を行った記録として送信されます。",
    "",
    ORDER_AUTO.name,
    `代表 ${ORDER_AUTO.representative}`,
    ORDER_AUTO.address,
    `TEL ${ORDER_AUTO.phone}`,
  ].join("\n");

  return {
    subject: "【契約完了】車両売買契約の電子署名が完了しました",
    body,
  };
}

function openCompletionEmail() {
  if (!completionEmail) return;
  const link = document.createElement("a");
  link.href = `mailto:${ORDER_AUTO_EMAIL}?subject=${encodeMailtoValue(completionEmail.subject)}&body=${encodeMailtoValue(completionEmail.body)}`;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
}

function showCompletionScreen(result, data) {
  completedConsentResult = result;
  completionEmail = buildCompletionEmail(result, data);
  document.querySelector("#consent-summary").hidden = true;
  document.querySelector("#seller-input-section").hidden = true;
  document.querySelector("#consent-check-section").hidden = true;
  document.querySelector("#customer-sign-section").hidden = true;
  document.querySelector("#consent-guide").hidden = true;
  document.querySelector("#completion-summary-list").innerHTML = [
    summaryRow("契約番号", result.contractNumber),
    summaryRow("署名者", result.customerName),
    summaryRow("車名", data.carName),
    summaryRow("登録番号", data.plateNumber),
    summaryRow("金額", result.amount),
    summaryRow("完了日時", result.completedAt),
  ].join("");
  document.querySelector("#consent-complete-section").hidden = false;
  setConsentProgress("complete");
  document.querySelector("#consent-complete-section").scrollIntoView({ behavior: "smooth", block: "start" });
}

function printCustomerCopy() {
  if (!completedConsentResult || !loadedContract?.data) return;
  const data = loadedContract.data;
  const result = completedConsentResult;
  const signature = escapeHtml(result.customerSignature);
  const checkedItems = result.checkedConsents.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  const printWindow = window.open("", "_blank");
  if (!printWindow) {
    alert("お客様控えを開けませんでした。ブラウザのポップアップ設定を確認してください。");
    return;
  }

  printWindow.document.write(`<!doctype html>
    <html lang="ja"><head><meta charset="UTF-8"><title>車両売買契約 お客様控え</title>
    <style>
      @page { size: A4 portrait; margin: 14mm; }
      * { box-sizing: border-box; }
      body { margin: 0; color: #111; font-family: -apple-system, BlinkMacSystemFont, "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif; font-size: 12px; line-height: 1.55; }
      h1 { margin: 0 0 4px; text-align: center; font-size: 22px; }
      .copy { text-align: right; font-weight: 700; }
      table { width: 100%; margin-top: 14px; border-collapse: collapse; }
      th, td { border: 1px solid #333; padding: 7px 9px; text-align: left; vertical-align: top; }
      th { width: 28%; background: #f5f5f5; }
      h2 { margin: 18px 0 6px; font-size: 15px; }
      li { margin: 3px 0; }
      .signature { height: 86px; object-fit: contain; object-position: left center; }
      .company { margin-top: 22px; padding-top: 10px; border-top: 1px solid #555; }
      @media print { button { display: none; } }
    </style></head><body>
      <div class="copy">お客様控え</div>
      <h1>車両売買契約 電子契約完了記録</h1>
      <table>
        <tr><th>契約番号</th><td>${escapeHtml(result.contractNumber)}</td></tr>
        <tr><th>契約内容</th><td>${escapeHtml(contractTypeLabel(data))}</td></tr>
        <tr><th>車名</th><td>${escapeHtml(text(data.carName))}</td></tr>
        <tr><th>登録番号</th><td>${escapeHtml(text(data.plateNumber))}</td></tr>
        <tr><th>車台番号</th><td>${escapeHtml(text(data.chassisNumber))}</td></tr>
        <tr><th>買取金額</th><td>${escapeHtml(result.amount)}</td></tr>
        <tr><th>署名者</th><td>${escapeHtml(result.customerName)}</td></tr>
        <tr><th>完了日時</th><td>${escapeHtml(result.completedAt)}</td></tr>
        <tr><th>電子署名</th><td><img class="signature" src="${signature}" alt="電子署名"></td></tr>
      </table>
      <h2>確認・同意した事項</h2>
      <ul>${checkedItems}</ul>
      <p class="company"><strong>${ORDER_AUTO.name}</strong><br>代表 ${ORDER_AUTO.representative}<br>${ORDER_AUTO.address}<br>TEL ${ORDER_AUTO.phone}</p>
      <script>window.addEventListener("load", () => setTimeout(() => window.print(), 200));<\/script>
    </body></html>`);
  printWindow.document.close();
}

async function completeConsent() {
  if (!loadedContract?.data) return;

  if (!validateConsentForm()) {
    return;
  }

  const completeButton = document.querySelector("#complete-consent");
  completeButton.disabled = true;
  completeButton.textContent = "契約を完了しています";

  const seller = collectRemoteSeller();
  try {
    const front = await prepareRemoteIdentityDocument(
      remoteField("remote-license-front").files[0],
      "front",
    );
    preparedIdentityDocuments = [front];
    if (seller.licenseBackStatus === "has_entries") {
      preparedIdentityDocuments.push(await prepareRemoteIdentityDocument(
        remoteField("remote-license-back").files[0],
        "back",
      ));
    }
  } catch (error) {
    alert(error.message || "本人確認画像を読み込めませんでした。");
    completeButton.disabled = false;
    completeButton.textContent = "同意して完了メールを作成";
    return;
  }

  const name = document.querySelector("#customer-name").value.trim();

  const data = loadedContract.data;
  const completedAt = formatDateTime();
  const amount = amountLabel(data) || "未入力";
  const contractNumber = displayContractNumber(loadedContract);
  const result = {
    contractId: loadedContract.id,
    contractNumber,
    completedAt,
    customerName: name,
    checkedConsents: checkedConsents(),
    contractType: data.contractType || "unified",
    contractLabel: contractTypeLabel(data),
    carName: data.carName,
    plateNumber: data.plateNumber,
    amount,
    customerSignature: document.querySelector("#customer-signature").toDataURL("image/png"),
    seller,
    identityDocuments: preparedIdentityDocuments,
  };

  if (loadedContract.cloudMode && window.OrderAutoCloud?.isConfigured()) {
    try {
      await window.OrderAutoCloud.saveConsentResult(
        loadedContract.id,
        result,
        loadedContract.accessToken || "",
      );
    } catch (error) {
      alert("同意結果をクラウド保存できませんでした。通信状況を確認してください。");
      completeButton.disabled = false;
      completeButton.textContent = "同意して完了メールを作成";
      return;
    }
  }
  showCompletionScreen(result, data);
  openCompletionEmail();
  window.setTimeout(() => setConsentProgress("complete"), 0);
}

document.addEventListener("DOMContentLoaded", () => {
  setupSignature();
  document.querySelector("#unlock-consent").addEventListener("click", unlockConsent);
  document.querySelector("#consent-passcode-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      unlockConsent();
    }
  });
  document.querySelector("#complete-consent").addEventListener("click", completeConsent);
  document.querySelector("#reopen-completion-email").addEventListener("click", openCompletionEmail);
  document.querySelector("#save-customer-copy").addEventListener("click", printCustomerCopy);
  document.querySelector("#customer-name").addEventListener("input", () => {
    setFieldError(
      document.querySelector("#customer-name"),
      document.querySelector("#customer-name-error"),
      !document.querySelector("#customer-name").value.trim(),
    );
  });
  document.querySelector("#remote-seller-type").addEventListener("change", (event) => {
    setRemoteSellerType(event.target.value);
  });
  document.querySelector("#remote-license-back-status").addEventListener("change", (event) => {
    const needsBack = event.target.value === "has_entries";
    remoteField("remote-license-back-field").hidden = !needsBack;
    if (!needsBack) {
      remoteField("remote-license-back").value = "";
      markRemoteField("remote-license-back", false);
    }
  });
  document.querySelector("#remote-seller-form").addEventListener("input", (event) => {
    event.target.classList.remove("field-error");
    event.target.removeAttribute("aria-invalid");
    remoteField("remote-seller-error").hidden = true;
    if ([
      "remote-seller-last-name", "remote-seller-first-name",
      "remote-representative-last-name", "remote-representative-first-name",
    ].includes(event.target.id)) syncCustomerNameFromSeller();
  });
  document.querySelector("#customer-consents").addEventListener("change", () => {
    setConsentProgress("important");
    const missing = !allConsentsChecked();
    setFieldError(
      document.querySelector("#customer-consents"),
      document.querySelector("#customer-consents-error"),
      missing,
    );
    document.querySelectorAll('[name="customerConsent"]').forEach((checkbox) => {
      const hasError = !checkbox.checked;
      checkbox.closest("label")?.classList.toggle("field-error", hasError);
      checkbox.setAttribute("aria-invalid", hasError ? "true" : "false");
    });
  });
  document.querySelector("#consent-summary").addEventListener("click", () => setConsentProgress("summary"));
  document.querySelector("#customer-sign-section").addEventListener("focusin", () => {
    if (!completedConsentResult) setConsentProgress("sign");
  });
});
