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
  "contract_number",
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
  "remote_link_hash",
  "remote_access_expires_at",
  "remote_used_at",
  "remote_failed_attempts",
  "remote_locked_until",
].join(",");

const PUBLIC_DATA_FIELDS = [
  "customerName",
  "sellerName",
  "sellerType",
  "sellerLastName",
  "sellerFirstName",
  "sellerLastKana",
  "sellerFirstKana",
  "sellerPostalCode",
  "sellerAddress",
  "sellerHomePhone",
  "sellerMobile",
  "sellerBirthdate",
  "corporateName",
  "corporateNumber",
  "corporatePostalCode",
  "corporateAddress",
  "corporatePhone",
  "representativeTitle",
  "representativeLastName",
  "representativeFirstName",
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
  if (!token || id.length > 100 || token.length > 200) {
    return jsonResponse({ error: "Invalid request" }, 400, origin);
  }

  try {
    const [linkToken] = token.split(".", 1);
    if (!/^[A-Za-z0-9_-]{32}$/.test(linkToken)) {
      return jsonResponse({ error: "Invalid request" }, 400, origin);
    }
    const [tokenHash, linkHash] = await Promise.all([
      sha256Hex(token),
      sha256Hex(linkToken),
    ]);
    const query = new URLSearchParams({
      select: CONTRACT_SELECT,
      limit: "1",
    });
    if (id) query.set("id", `eq.${id}`);
    else query.set("remote_link_hash", `eq.${linkHash}`);
    const response = await fetch(supabaseUrl(`/rest/v1/contracts?${query}`), {
      headers: serviceHeaders(),
    });
    if (!response.ok) {
      throw new Error(`Database request failed with ${response.status}`);
    }
    let contract = (await response.json())?.[0];
    // Keep correctly authenticated URLs issued before remote_link_hash existed usable.
    if (!contract && !id) {
      const legacyQuery = new URLSearchParams({
        select: CONTRACT_SELECT,
        remote_access_hash: `eq.${tokenHash}`,
        limit: "1",
      });
      const legacyResponse = await fetch(supabaseUrl(`/rest/v1/contracts?${legacyQuery}`), {
        headers: serviceHeaders(),
      });
      if (!legacyResponse.ok) {
        throw new Error(`Database request failed with ${legacyResponse.status}`);
      }
      contract = (await legacyResponse.json())?.[0];
    }
    if (!contract) return jsonResponse({ error: "Contract not found" }, 404, origin);

    const expiresAt = Date.parse(contract.remote_access_expires_at || "");
    const lockedUntil = Date.parse(contract.remote_locked_until || "");
    if (Number.isFinite(lockedUntil) && Date.now() < lockedUntil) {
      return jsonResponse({ error: "Too many attempts. Try again later" }, 429, origin);
    }
    const validToken = constantTimeEqual(tokenHash, contract.remote_access_hash || "");
    if (!validToken) {
      const failedAttempts = Number(contract.remote_failed_attempts || 0) + 1;
      const nextLockedUntil = failedAttempts >= 5
        ? new Date(Date.now() + 15 * 60 * 1000).toISOString()
        : null;
      await fetch(supabaseUrl(`/rest/v1/contracts?id=eq.${encodeURIComponent(contract.id)}`), {
        method: "PATCH",
        headers: serviceHeaders("return=minimal"),
        body: JSON.stringify({
          remote_failed_attempts: failedAttempts >= 5 ? 0 : failedAttempts,
          remote_locked_until: nextLockedUntil,
          updated_at: new Date().toISOString(),
        }),
      });
      return jsonResponse({ error: "Link is invalid or expired" }, 403, origin);
    }
    if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) {
      return jsonResponse({ error: "Link is invalid or expired" }, 403, origin);
    }
    if (contract.remote_used_at || ["確認待ち", "完了"].includes(contract.consent_status)) {
      return jsonResponse({ error: "Consent is already completed" }, 409, origin);
    }

    const openedAt = new Date().toISOString();
    const statusResponse = await fetch(
      supabaseUrl(`/rest/v1/contracts?id=eq.${encodeURIComponent(contract.id)}&status=neq.%E5%AE%8C%E4%BA%86`),
      {
        method: "PATCH",
        headers: serviceHeaders("return=minimal"),
        body: JSON.stringify({
          status: "署名待ち",
          consent_status: "署名待ち",
          remote_failed_attempts: 0,
          remote_locked_until: null,
          updated_at: openedAt,
        }),
      },
    );
    if (!statusResponse.ok) {
      console.error("contract status update failed", await statusResponse.text());
    }

    const {
      remote_access_hash: _hash,
      remote_link_hash: _linkHash,
      remote_access_expires_at: _expires,
      remote_used_at: _used,
      remote_failed_attempts: _failed,
      remote_locked_until: _locked,
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
