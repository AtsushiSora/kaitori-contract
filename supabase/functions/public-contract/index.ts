import {
  allowedOrigin,
  constantTimeEqual,
  corsHeaders,
  jsonResponse,
  serviceHeaders,
  sha256Hex,
  supabaseUrl,
} from "../_shared/http.ts";

const CONTRACT_SELECT = [
  "id",
  "status",
  "data",
  "created_at_text",
  "updated_at_text",
  "completed_at_text",
  "signed_at_text",
  "consent_status",
  "created_at",
  "updated_at",
  "remote_access_hash",
  "remote_access_expires_at",
  "remote_used_at",
].join(",");

const PUBLIC_DATA_FIELDS = [
  "sellerName",
  "sellerPhone",
  "sellerEmail",
  "carName",
  "plateNumber",
  "chassisNumber",
  "mileage",
  "purchaseAmount",
  "contractType",
  "pickupDate",
  "pickupPlace",
] as const;

function publicContractData(data: Record<string, unknown> | null): Record<string, unknown> {
  const source = data || {};
  return Object.fromEntries(
    PUBLIC_DATA_FIELDS.map((field) => [field, source[field] ?? ""]),
  );
}

Deno.serve(async (request) => {
  const origin = allowedOrigin(request);
  if (!origin) return new Response("Origin not allowed", { status: 403 });
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (request.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, 405, origin);
  }

  const url = new URL(request.url);
  const id = (url.searchParams.get("id") || "").trim();
  const token = (url.searchParams.get("token") || "").trim();
  if (!id || !token || id.length > 100 || token.length > 200) {
    return jsonResponse({ error: "Invalid request" }, 400, origin);
  }

  try {
    const query = new URLSearchParams({
      id: `eq.${id}`,
      select: CONTRACT_SELECT,
      limit: "1",
    });
    const response = await fetch(supabaseUrl(`/rest/v1/contracts?${query}`), {
      headers: serviceHeaders(),
    });
    if (!response.ok) throw new Error(await response.text());
    const contract = (await response.json())?.[0];
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

    const {
      remote_access_hash: _hash,
      remote_access_expires_at: _expires,
      remote_used_at: _used,
      ...publicContract
    } = contract;
    return jsonResponse(
      { ...publicContract, data: publicContractData(publicContract.data) },
      200,
      origin,
    );
  } catch (error) {
    console.error("public-contract", error);
    return jsonResponse({ error: "Contract could not be loaded" }, 500, origin);
  }
});
