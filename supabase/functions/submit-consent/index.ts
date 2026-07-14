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
      select: "id,data,consent_status,remote_access_hash,remote_access_expires_at,remote_used_at",
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
    const checked = Array.isArray(result.checkedConsents)
      ? result.checkedConsents.map(String)
      : [];
    const required = expectedConsents(contract.data || {});
    const allChecked = required.every((item) => checked.includes(item));
    if (!customerName || customerName.length > 100 || !allChecked ||
      !validSignature(result.customerSignature)) {
      return jsonResponse({ error: "Name, confirmations, and signature are required" }, 422, origin);
    }

    const completedAt = new Date().toISOString();
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
        completed_at_text: completedAt,
        remote_used_at: completedAt,
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

    return jsonResponse({ ok: true, completedAt }, 200, origin);
  } catch (error) {
    console.error("submit-consent", error);
    return jsonResponse({ error: "Consent could not be saved" }, 500, origin);
  }
});
