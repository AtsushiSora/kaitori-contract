import {
  allowedOrigin,
  corsHeaders,
  jsonResponse,
  serviceHeaders,
  sha256Hex,
  supabaseUrl,
} from "../_shared/http.ts";

const DOWNLOAD_LINK_DAYS = 30;

function clean(value: unknown, max = 200): string {
  return String(value ?? "").trim().slice(0, max);
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

async function authenticatedUser(request: Request): Promise<boolean> {
  const authorization = request.headers.get("authorization") || "";
  if (!authorization.startsWith("Bearer ")) return false;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!serviceRoleKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY is missing");
  const response = await fetch(supabaseUrl("/auth/v1/user"), {
    headers: {
      apikey: serviceRoleKey,
      Authorization: authorization,
    },
  });
  return response.ok;
}

async function sendCustomerEmail(
  email: string,
  contractNumber: string,
  customerName: string,
  carName: string,
  amount: string,
  confirmedAt: string,
  downloadUrl: string,
) {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("NOTIFICATION_FROM_EMAIL");
  if (!apiKey || !from) throw new Error("Email notification is not configured");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: [email],
      subject: `【確認完了】車両売買契約 契約番号 ${contractNumber}`,
      text: [
        `${customerName} 様`,
        "",
        "オーダーオートです。",
        "車両売買契約の内容と本人確認書類を確認し、契約手続きが完了しました。",
        "",
        `契約番号：${contractNumber}`,
        `車名：${carName || "未入力"}`,
        `金額：${amount || "未入力"}`,
        `確認完了日時：${confirmedAt}`,
        "",
        "お客様控え契約書PDF（30日間有効）：",
        downloadUrl,
        "",
        "期限内にPDFを保存してください。",
        "",
        "オーダーオート",
        "広島県広島市佐伯区皆賀1-10-20",
        "TEL 070-8996-6421",
      ].join("\n"),
    }),
  });
  if (!response.ok) throw new Error(`Confirmation email failed: ${response.status}`);
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
    if (!(await authenticatedUser(request))) {
      return jsonResponse({ error: "Administrator authentication is required" }, 401, origin);
    }
    const body = await request.json();
    const contractId = clean(body.contractId, 100);
    if (!contractId) return jsonResponse({ error: "Invalid request" }, 400, origin);

    const query = new URLSearchParams({
      id: `eq.${contractId}`,
      select: "id,contract_number,status,consent_status,data,customer_pdf_path",
      limit: "1",
    });
    const contractResponse = await fetch(supabaseUrl(`/rest/v1/contracts?${query}`), {
      headers: serviceHeaders(),
    });
    if (!contractResponse.ok) throw new Error(await contractResponse.text());
    const contract = (await contractResponse.json())?.[0];
    if (!contract) return jsonResponse({ error: "Contract not found" }, 404, origin);
    if (contract.consent_status !== "確認待ち" || contract.status !== "確認待ち") {
      return jsonResponse({ error: "Contract is not awaiting confirmation" }, 409, origin);
    }
    if (!contract.customer_pdf_path) {
      return jsonResponse({ error: "Customer contract PDF is missing" }, 422, origin);
    }

    const data = contract.data || {};
    const email = clean(data.sellerEmail, 200);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return jsonResponse({ error: "Customer email address is missing" }, 422, origin);
    }
    const customerName = clean(data.sellerName || data.customerName, 100) || "お客様";
    const contractNumber = clean(contract.contract_number || data.contractNumber, 30);
    const confirmedAt = new Date().toISOString();
    const downloadToken = randomDownloadToken();
    const downloadAccessHash = await sha256Hex(downloadToken);
    const downloadAccessExpiresAt = new Date(
      Date.now() + DOWNLOAD_LINK_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    const downloadUrl = customerDownloadUrl(origin, downloadToken);

    const updateQuery = new URLSearchParams({
      id: `eq.${contractId}`,
      status: "eq.確認待ち",
      consent_status: "eq.確認待ち",
      select: "id",
    });
    const updateResponse = await fetch(supabaseUrl(`/rest/v1/contracts?${updateQuery}`), {
      method: "PATCH",
      headers: serviceHeaders("return=representation"),
      body: JSON.stringify({
        status: "完了",
        consent_status: "完了",
        reviewed_at: confirmedAt,
        completed_at_text: confirmedAt,
        customer_confirmation_sent_at: null,
        confirmation_email_status: "sending",
        download_access_hash: downloadAccessHash,
        download_access_expires_at: downloadAccessExpiresAt,
        updated_at: confirmedAt,
      }),
    });
    if (!updateResponse.ok) throw new Error(await updateResponse.text());
    if (!(await updateResponse.json())?.length) {
      return jsonResponse({ error: "Contract is not awaiting confirmation" }, 409, origin);
    }

    try {
      await sendCustomerEmail(
        email,
        contractNumber,
        customerName,
        clean(data.carName, 200),
        clean(data.purchaseAmount, 100),
        confirmedAt,
        downloadUrl,
      );
    } catch (error) {
      await fetch(supabaseUrl(`/rest/v1/contracts?id=eq.${encodeURIComponent(contractId)}`), {
        method: "PATCH",
        headers: serviceHeaders("return=minimal"),
        body: JSON.stringify({
          status: "確認待ち",
          consent_status: "確認待ち",
          reviewed_at: null,
          completed_at_text: null,
          confirmation_email_status: "failed",
          download_access_hash: null,
          download_access_expires_at: null,
          updated_at: new Date().toISOString(),
        }),
      });
      throw error;
    }

    await fetch(supabaseUrl(`/rest/v1/contracts?id=eq.${encodeURIComponent(contractId)}`), {
      method: "PATCH",
      headers: serviceHeaders("return=minimal"),
      body: JSON.stringify({
        customer_confirmation_sent_at: confirmedAt,
        confirmation_email_status: "sent",
        updated_at: confirmedAt,
      }),
    });

    await Promise.allSettled([
      fetch(supabaseUrl("/rest/v1/consent_events"), {
        method: "POST",
        headers: serviceHeaders("return=minimal"),
        body: JSON.stringify({
          contract_id: contractId,
          event_type: "administrator_confirmed_contract",
          payload: { confirmedAt, confirmationEmail: email, downloadAccessExpiresAt },
        }),
      }),
      fetch(supabaseUrl("/rest/v1/admin_notifications"), {
        method: "POST",
        headers: serviceHeaders("return=minimal"),
        body: JSON.stringify({
          contract_id: contractId,
          notification_type: "customer_confirmation_sent",
          title: "確認完了メールを送信しました",
          message: `契約番号 ${contractNumber} / ${customerName}`,
          payload: { contractNumber, customerName, confirmedAt, emailStatus: "sent" },
        }),
      }),
    ]);

    return jsonResponse({ ok: true, confirmedAt, emailStatus: "sent" }, 200, origin);
  } catch (error) {
    console.error("confirm-contract", error);
    return jsonResponse({ error: "Contract could not be confirmed or emailed" }, 500, origin);
  }
});
