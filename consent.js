const ORDER_AUTO_EMAIL = "sora29128616@gmail.com";
const ORDER_AUTO = {
  name: "オーダーオート",
  representative: "空 篤志",
  address: "広島県広島市佐伯区皆賀1-10-20",
  phone: "080-2912-8616",
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
  document.querySelector("#consent-check-section").hidden = false;
  document.querySelector("#customer-sign-section").hidden = false;
  document.querySelector("#consent-unlock").hidden = true;
  document.querySelector("#consent-error").hidden = true;
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

  setFieldError(customerName, document.querySelector("#customer-name-error"), nameMissing);
  setFieldError(customerConsents, document.querySelector("#customer-consents-error"), consentsMissing);
  setFieldError(signatureCanvas, document.querySelector("#customer-signature-error"), signatureMissing);
  document.querySelectorAll('[name="customerConsent"]').forEach((checkbox) => {
    const hasError = !checkbox.checked;
    checkbox.closest("label")?.classList.toggle("field-error", hasError);
    checkbox.setAttribute("aria-invalid", hasError ? "true" : "false");
  });

  if (!nameMissing && !consentsMissing && !signatureMissing) {
    return true;
  }

  const firstError = nameMissing
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

async function completeConsent() {
  if (!loadedContract?.data) return;

  if (!validateConsentForm()) {
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
      return;
    }
  }

  const body = [
    "契約内容を確認し、電子同意しました。",
    "",
    `契約番号：${contractNumber}`,
    `同意日時：${completedAt}`,
    `氏名：${name}`,
    `契約内容：${contractTypeLabel(data)}`,
    `車両：${text(data.carName)} ${text(data.plateNumber)}`,
    `金額：${amount}`,
    "",
    "確認した重要事項：",
    ...result.checkedConsents.map((item) => `・${item}`),
    "",
    "このメールは、お客様が契約確認ページで同意操作を行った記録として送信しています。",
  ].join("\n");

  const subject = `契約同意完了 ${contractNumber}`;
  window.location.href = `mailto:${ORDER_AUTO_EMAIL}?subject=${encodeMailtoValue(subject)}&body=${encodeMailtoValue(body)}`;
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
  document.querySelector("#customer-name").addEventListener("input", () => {
    setFieldError(
      document.querySelector("#customer-name"),
      document.querySelector("#customer-name-error"),
      !document.querySelector("#customer-name").value.trim(),
    );
  });
  document.querySelector("#customer-consents").addEventListener("change", () => {
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
});
