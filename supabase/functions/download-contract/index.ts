const DEFAULT_ORIGINS = [
  "https://atsushisora.github.io",
  "http://127.0.0.1:8765",
  "http://localhost:8765",
];

function allowedOrigin(request: Request): string | null {
  const origin = request.headers.get("origin");
  if (!origin) return DEFAULT_ORIGINS[0];
  const configured = (Deno.env.get("ALLOWED_ORIGINS") || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const origins = configured.length ? configured : DEFAULT_ORIGINS;
  return origins.includes(origin) ? origin : null;
}

function corsHeaders(origin: string): HeadersInit {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Cache-Control": "no-store",
    Vary: "Origin",
  };
}

function jsonResponse(body: unknown, status: number, origin: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function serviceHeaders(): HeadersInit {
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!serviceRoleKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY is missing");
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  };
}

function supabaseUrl(path: string): string {
  const baseUrl = Deno.env.get("SUPABASE_URL");
  if (!baseUrl) throw new Error("SUPABASE_URL is missing");
  return `${baseUrl.replace(/\/$/, "")}${path}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function safeFilename(value: unknown): string {
  const contractNumber = String(value ?? "").replace(/[^0-9A-Za-z_-]/g, "").slice(0, 30);
  return `vehicle-contract-${contractNumber || "customer-copy"}.pdf`;
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
    const token = String(body.token || "").trim();
    if (!/^[A-Za-z0-9_-]{32}$/.test(token)) {
      return jsonResponse({ error: "Invalid request" }, 400, origin);
    }

    const tokenHash = await sha256Hex(token);
    const query = new URLSearchParams({
      download_access_hash: `eq.${tokenHash}`,
      select: "id,contract_number,consent_status,customer_pdf_path,download_access_hash,download_access_expires_at",
      limit: "1",
    });
    const contractResponse = await fetch(supabaseUrl(`/rest/v1/contracts?${query}`), {
      headers: serviceHeaders(),
    });
    if (!contractResponse.ok) throw new Error(await contractResponse.text());
    const contract = (await contractResponse.json())?.[0];
    if (!contract || !constantTimeEqual(tokenHash, contract.download_access_hash || "")) {
      return jsonResponse({ error: "Download link is invalid or expired" }, 404, origin);
    }

    const expiresAt = Date.parse(contract.download_access_expires_at || "");
    if (contract.consent_status !== "完了" || !contract.customer_pdf_path ||
      !Number.isFinite(expiresAt) || Date.now() > expiresAt) {
      return jsonResponse({ error: "Download link is invalid or expired" }, 403, origin);
    }

    const path = String(contract.customer_pdf_path)
      .split("/")
      .map(encodeURIComponent)
      .join("/");
    const headers = new Headers(serviceHeaders());
    headers.delete("Content-Type");
    const storageResponse = await fetch(
      supabaseUrl(`/storage/v1/object/contract-files/${path}`),
      { headers },
    );
    if (!storageResponse.ok) throw new Error(`PDF download failed: ${storageResponse.status}`);

    return new Response(storageResponse.body, {
      status: 200,
      headers: {
        ...corsHeaders(origin),
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${safeFilename(contract.contract_number)}"`,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    console.error("download-contract", error);
    return jsonResponse({ error: "Contract PDF could not be downloaded" }, 500, origin);
  }
});
