import {
  allowedOrigin,
  constantTimeEqual,
  corsHeaders,
  jsonResponse,
  serviceHeaders,
  sha256Hex,
  supabaseUrl,
} from "../_shared/http.ts";

const COMMON_CONSENTS = [
  "契約内容を確認しました",
  "車両情報に間違いありません",
];
const PAID_CONSENTS = [
  "買取金額に同意します",
  "還付金等は買取金額に含まれることに同意します",
];
const ZERO_CONSENTS = [
  "買取金額が0円であることに同意します",
  "引取後に買取代金を請求しません",
  "重量税・自賠責・リサイクル券・自動車税の還付または返戻金を請求しません",
];
const DOWNLOAD_LINK_DAYS = 30;

function expectedConsents(data: Record<string, unknown>): string[] {
  const rawAmount = String(data.purchaseAmount ?? "").trim();
  const amount = Number(rawAmount);
  const isZero = data.contractType === "free" ||
    (rawAmount !== "" && Number.isFinite(amount) && amount <= 0);
  return [...COMMON_CONSENTS, ...(isZero ? ZERO_CONSENTS : PAID_CONSENTS)];
}

function validSignature(value: unknown): value is string {
  return typeof value === "string" &&
    value.startsWith("data:image/png;base64,") &&
    value.length >= 200 &&
    value.length <= 1_500_000;
}

function validCustomerPdf(value: unknown): value is string {
  return typeof value === "string" &&
    value.startsWith("data:application/pdf;base64,JVBERi0") &&
    value.length >= 5000 && value.length <= 11_000_000;
}

type IdentityDocument = {
  side: "front" | "back";
  name: string;
  type: "image/jpeg" | "image/png";
  dataUrl: string;
};

function clean(value: unknown, max = 200): string {
  return String(value ?? "").trim().slice(0, max);
}

function validIdentityDocument(value: unknown): value is IdentityDocument {
  if (!value || typeof value !== "object") return false;
  const document = value as Record<string, unknown>;
  const type = clean(document.type, 30);
  const dataUrl = clean(document.dataUrl, 3_000_000);
  return (document.side === "front" || document.side === "back") &&
    (type === "image/jpeg" || type === "image/png") &&
    dataUrl.startsWith(`data:${type};base64,`) &&
    dataUrl.length >= 200 && dataUrl.length <= 3_000_000;
}

function validateSeller(raw: unknown): Record<string, string> | null {
  const source = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const sellerType = source.sellerType === "corporate" ? "corporate" : "individual";
  const seller = {
    sellerType,
    sellerLastName: clean(source.sellerLastName, 50),
    sellerFirstName: clean(source.sellerFirstName, 50),
    sellerLastKana: clean(source.sellerLastKana, 50),
    sellerFirstKana: clean(source.sellerFirstKana, 50),
    sellerPostalCode: clean(source.sellerPostalCode, 12),
    sellerAddress: clean(source.sellerAddress, 200),
    sellerHomePhone: clean(source.sellerHomePhone, 30),
    sellerMobile: clean(source.sellerMobile, 30),
    sellerEmail: clean(source.sellerEmail, 200),
    sellerBirthdate: clean(source.sellerBirthdate, 10),
    corporateName: clean(source.corporateName, 120),
    corporateNumber: clean(source.corporateNumber, 20),
    corporatePostalCode: clean(source.corporatePostalCode, 12),
    corporateAddress: clean(source.corporateAddress, 200),
    corporatePhone: clean(source.corporatePhone, 30),
    representativeTitle: clean(source.representativeTitle, 50),
    representativeLastName: clean(source.representativeLastName, 50),
    representativeFirstName: clean(source.representativeFirstName, 50),
    identityType: "運転免許証",
    identityNumber: clean(source.identityNumber, 30),
    licenseBackStatus: source.licenseBackStatus === "has_entries" ? "has_entries" : "none",
  };
  const phone = seller.sellerMobile || seller.sellerHomePhone;
  if (sellerType === "individual") {
    if (!seller.sellerLastName || !seller.sellerFirstName || !seller.sellerPostalCode ||
      !seller.sellerAddress || !phone || !seller.sellerBirthdate || !seller.identityNumber) return null;
  } else if (!seller.corporateName || !seller.corporatePostalCode || !seller.corporateAddress ||
    !seller.corporatePhone || !seller.representativeLastName ||
    !seller.representativeFirstName || !seller.identityNumber) return null;
  return seller;
}

function dataUrlBytes(document: IdentityDocument): Uint8Array {
  const base64 = document.dataUrl.split(",", 2)[1] || "";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function pdfDataUrlBytes(value: string): Uint8Array {
  const binary = atob(value.split(",", 2)[1] || "");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function randomDownloadToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function customerDownloadUrl(origin: string, token: string): string {
  const configured = String(Deno.env.get("PUBLIC_SITE_URL") || "").trim().replace(/\/$/, "");
  const siteUrl = configured || `${origin}/kaitori-contract`;
  return `${siteUrl}/download.html#d=${token}`;
}

async function uploadIdentityDocument(contractId: string, document: IdentityDocument) {
  const extension = document.type === "image/png" ? "png" : "jpg";
  const path = `${contractId}/identity/customer-license-${document.side}-${crypto.randomUUID()}.${extension}`;
  const headers = new Headers(serviceHeaders());
  headers.set("Content-Type", document.type);
  headers.set("x-upsert", "false");
  const response = await fetch(
    supabaseUrl(`/storage/v1/object/contract-files/${path.split("/").map(encodeURIComponent).join("/")}`),
    { method: "POST", headers, body: dataUrlBytes(document) },
  );
  if (!response.ok) throw new Error(`Identity upload failed: ${response.status}`);
  return {
    id: crypto.randomUUID(),
    category: "identity",
    documentType: document.side === "front" ? "運転免許証（表面）" : "運転免許証（裏面）",
    side: document.side,
    name: clean(document.name, 120),
    type: document.type,
    storagePath: path,
    addedAt: new Date().toISOString(),
    uploadedBy: "customer",
  };
}

async function uploadCustomerPdf(contractId: string, dataUrl: string): Promise<string> {
  const path = `${contractId}/contract/customer-copy.pdf`;
  const headers = new Headers(serviceHeaders());
  headers.set("Content-Type", "application/pdf");
  headers.set("x-upsert", "true");
  const response = await fetch(
    supabaseUrl(`/storage/v1/object/contract-files/${path.split("/").map(encodeURIComponent).join("/")}`),
    { method: "POST", headers, body: pdfDataUrlBytes(dataUrl) },
  );
  if (!response.ok) throw new Error(`Customer PDF upload failed: ${response.status}`);
  return path;
}

async function sendAdminEmail(
  contractNumber: string,
  customerName: string,
  completedAt: string,
  downloadUrl: string,
) {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  const to = Deno.env.get("ADMIN_NOTIFICATION_EMAIL");
  const from = Deno.env.get("NOTIFICATION_FROM_EMAIL");
  if (!apiKey || !to || !from) return "not_configured";
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: [to],
        subject: `【契約完了】契約番号 ${contractNumber}`,
        text: [
          "車両売買契約の電子署名が完了しました。",
          `契約番号：${contractNumber}`,
          `署名者：${customerName}`,
          `完了日時：${completedAt}`,
          "",
          "契約書PDF（30日間有効）：",
          downloadUrl,
          "管理画面で契約内容と本人確認書類をご確認ください。",
          "安全のため、このメールには本人確認書類を添付していません。",
        ].join("\n"),
      }),
    });
    return response.ok ? "sent" : `failed:${response.status}`;
  } catch (error) {
    console.error("admin email failed", error);
    return "failed:network";
  }
}

function comparableName(value: unknown): string {
  return String(value ?? "").replace(/[\s　]/g, "");
}

Deno.serve(async (request) => {
  const origin = allowedOrigin(request);
  if (!origin) return new Response("Origin not allowed", { status: 403 });
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405, origin);
  }

  try {
    const body = await request.json();
    const contractId = String(body.contract_id || "").trim();
    const token = String(body.token || "").trim();
    const result = body.result || {};
    if (!contractId || !token || contractId.length > 100 || token.length > 200) {
      return jsonResponse({ error: "Invalid request" }, 400, origin);
    }

    const query = new URLSearchParams({
      id: `eq.${contractId}`,
      select: "id,contract_number,data,identity_files,consent_status,remote_access_hash,remote_access_expires_at,remote_used_at",
      limit: "1",
    });
    const contractResponse = await fetch(supabaseUrl(`/rest/v1/contracts?${query}`), {
      headers: serviceHeaders(),
    });
    if (!contractResponse.ok) throw new Error(await contractResponse.text());
    const contract = (await contractResponse.json())?.[0];
    if (!contract) return jsonResponse({ error: "Contract not found" }, 404, origin);

    const tokenHash = await sha256Hex(token);
    const expiresAt = Date.parse(contract.remote_access_expires_at || "");
    const validToken = constantTimeEqual(tokenHash, contract.remote_access_hash || "");
    if (!validToken || !Number.isFinite(expiresAt) || Date.now() > expiresAt) {
      return jsonResponse({ error: "Link is invalid or expired" }, 403, origin);
    }
    if (contract.remote_used_at || contract.consent_status === "完了") {
      return jsonResponse({ error: "Consent is already completed" }, 409, origin);
    }

    const customerName = String(result.customerName || "").trim();
    const seller = validateSeller(result.seller);
    const identityDocuments = Array.isArray(result.identityDocuments)
      ? result.identityDocuments.filter(validIdentityDocument)
      : [];
    const frontDocument = identityDocuments.find((item) => item.side === "front");
    const backDocument = identityDocuments.find((item) => item.side === "back");
    const checked = Array.isArray(result.checkedConsents)
      ? result.checkedConsents.map(String)
      : [];
    const customerPdfDataUrl = result.customerPdfDataUrl;
    const required = expectedConsents(contract.data || {});
    const allChecked = required.every((item) => checked.includes(item));
    const expectedSigner = seller?.sellerType === "corporate"
      ? `${seller.representativeLastName} ${seller.representativeFirstName}`.trim()
      : `${seller?.sellerLastName || ""} ${seller?.sellerFirstName || ""}`.trim();
    if (!customerName || customerName.length > 100 || !seller || !frontDocument ||
      (seller.licenseBackStatus === "has_entries" && !backDocument) || !allChecked ||
      comparableName(customerName) !== comparableName(expectedSigner) ||
      !validSignature(result.customerSignature) || !validCustomerPdf(customerPdfDataUrl)) {
      return jsonResponse({ error: "Seller details, identity documents, confirmations, and signature are required" }, 422, origin);
    }

    const completedAt = new Date().toISOString();
    const downloadToken = randomDownloadToken();
    const downloadAccessHash = await sha256Hex(downloadToken);
    const downloadAccessExpiresAt = new Date(
      Date.now() + DOWNLOAD_LINK_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    const downloadUrl = customerDownloadUrl(origin, downloadToken);
    const sellerName = seller.sellerType === "corporate"
      ? seller.corporateName
      : `${seller.sellerLastName} ${seller.sellerFirstName}`.trim();
    const representativeName = `${seller.representativeLastName} ${seller.representativeFirstName}`.trim();
    const storedDocuments = await Promise.all(
      [frontDocument, seller.licenseBackStatus === "has_entries" ? backDocument : null]
        .filter((item): item is IdentityDocument => Boolean(item))
        .map((item) => uploadIdentityDocument(contractId, item)),
    );
    const existingIdentityFiles = Array.isArray(contract.identity_files) ? contract.identity_files : [];
    const customerPdfPath = await uploadCustomerPdf(contractId, customerPdfDataUrl);
    const mergedData = {
      ...(contract.data || {}),
      ...seller,
      sellerName,
      sellerPhone: seller.sellerType === "corporate"
        ? seller.corporatePhone
        : seller.sellerMobile || seller.sellerHomePhone,
      representativeName,
      identityConfirmed: true,
      sellerEnteredAt: completedAt,
    };
    const savedResult = {
      contractId,
      contractNumber: String(result.contractNumber || "").slice(0, 30),
      completedAt,
      customerName,
      checkedConsents: required,
      contractType: String(result.contractType || "unified").slice(0, 30),
      contractLabel: String(result.contractLabel || "").slice(0, 100),
      carName: String(result.carName || "").slice(0, 200),
      plateNumber: String(result.plateNumber || "").slice(0, 100),
      amount: String(result.amount || "").slice(0, 100),
      customerSignature: result.customerSignature,
      sellerType: seller.sellerType,
      representativeName,
      identityDocumentsStored: storedDocuments.map((item) => item.documentType),
      userAgent: (request.headers.get("user-agent") || "").slice(0, 500),
    };

    const updateQuery = new URLSearchParams({
      id: `eq.${contractId}`,
      consent_status: "neq.完了",
      remote_used_at: "is.null",
      select: "id",
    });
    const updateResponse = await fetch(supabaseUrl(`/rest/v1/contracts?${updateQuery}`), {
      method: "PATCH",
      headers: serviceHeaders("return=representation"),
      body: JSON.stringify({
        status: "完了",
        consent_status: "完了",
        consent_result: savedResult,
        data: mergedData,
        identity_files: [...existingIdentityFiles, ...storedDocuments],
        completed_at_text: completedAt,
        remote_used_at: completedAt,
        locked_at: completedAt,
        customer_pdf_path: customerPdfPath,
        download_access_hash: downloadAccessHash,
        download_access_expires_at: downloadAccessExpiresAt,
        updated_at: completedAt,
      }),
    });
    if (!updateResponse.ok) throw new Error(await updateResponse.text());
    const updated = await updateResponse.json();
    if (!updated?.length) {
      return jsonResponse({ error: "Consent is already completed" }, 409, origin);
    }

    const eventResponse = await fetch(supabaseUrl("/rest/v1/consent_events"), {
      method: "POST",
      headers: serviceHeaders("return=minimal"),
      body: JSON.stringify({
        contract_id: contractId,
        event_type: "customer_consent_completed",
        payload: {
          completedAt,
          customerName,
          checkedConsents: required,
          signatureStored: true,
          userAgent: savedResult.userAgent,
        },
      }),
    });
    if (!eventResponse.ok) {
      console.error("consent event insert failed", await eventResponse.text());
    }

    const contractNumber = clean(contract.contract_number || result.contractNumber, 30);
    const emailStatus = await sendAdminEmail(contractNumber, customerName, completedAt, downloadUrl);
    const notificationResponse = await fetch(supabaseUrl("/rest/v1/admin_notifications"), {
      method: "POST",
      headers: serviceHeaders("return=minimal"),
      body: JSON.stringify({
        contract_id: contractId,
        notification_type: "contract_completed",
        title: "電子契約が完了しました",
        message: `契約番号 ${contractNumber} / ${customerName}`,
        payload: { contractNumber, customerName, completedAt, emailStatus, downloadUrl, downloadAccessExpiresAt },
      }),
    });
    if (!notificationResponse.ok) {
      console.error("admin notification insert failed", await notificationResponse.text());
    }

    return jsonResponse({
      ok: true,
      completedAt,
      emailStatus,
      downloadUrl,
      downloadAccessExpiresAt,
    }, 200, origin);
  } catch (error) {
    console.error("submit-consent", error);
    return jsonResponse({ error: "Consent could not be saved" }, 500, origin);
  }
});
