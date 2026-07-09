const ORDER_AUTO_SUPABASE_SESSION_KEY = "orderAutoSupabaseSession";

function supabaseConfig() {
  return window.ORDER_AUTO_SUPABASE || {};
}

function supabaseIsConfigured() {
  const config = supabaseConfig();
  return Boolean(config.url && config.anonKey && !config.url.includes("YOUR_"));
}

function supabaseUrl(path) {
  return `${supabaseConfig().url.replace(/\/$/, "")}${path}`;
}

function supabaseSession() {
  try {
    return JSON.parse(localStorage.getItem(ORDER_AUTO_SUPABASE_SESSION_KEY) || "null");
  } catch (error) {
    return null;
  }
}

function supabaseSetSession(session) {
  localStorage.setItem(ORDER_AUTO_SUPABASE_SESSION_KEY, JSON.stringify(session));
}

function supabaseClearSession() {
  localStorage.removeItem(ORDER_AUTO_SUPABASE_SESSION_KEY);
}

function supabaseIsAuthenticated() {
  const session = supabaseSession();
  if (!session?.access_token || !session?.expires_at) return false;
  if (Date.now() >= session.expires_at * 1000) {
    supabaseClearSession();
    return false;
  }
  return true;
}

function supabaseHeaders({ auth = true, json = true } = {}) {
  const headers = {
    apikey: supabaseConfig().anonKey,
  };
  if (json) headers["Content-Type"] = "application/json";
  const session = supabaseSession();
  headers.Authorization = auth && session?.access_token
    ? `Bearer ${session.access_token}`
    : `Bearer ${supabaseConfig().anonKey}`;
  return headers;
}

async function supabaseRequest(path, options = {}) {
  if (!supabaseIsConfigured()) {
    throw new Error("Supabase is not configured");
  }

  const response = await fetch(supabaseUrl(path), {
    ...options,
    headers: {
      ...supabaseHeaders(options.supabase || {}),
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Supabase HTTP ${response.status}`);
  }

  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function supabaseSignIn(email, password) {
  const payload = await supabaseRequest("/auth/v1/token?grant_type=password", {
    method: "POST",
    supabase: { auth: false },
    body: JSON.stringify({ email, password }),
  });

  const expiresAt = Math.floor(Date.now() / 1000) + Number(payload.expires_in || 3600);
  supabaseSetSession({
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
    expires_at: expiresAt,
    user: payload.user,
  });
  return payload;
}

function supabaseSignOut() {
  supabaseClearSession();
}

function dbContractToLocal(row) {
  return {
    id: row.id,
    status: row.status || "下書き",
    createdAt: row.created_at_text || row.created_at || "",
    updatedAt: row.updated_at_text || row.updated_at || "",
    completedAt: row.completed_at_text || "",
    signedAt: row.signed_at_text || "",
    signatureData: row.signature_data || "",
    identityFiles: row.identity_files || [],
    cloudSavedAt: row.updated_at || "",
    consentStatus: row.consent_status || "",
    consentResult: row.consent_result || null,
    data: row.data || {},
  };
}

function localContractToDb(contract, identityFiles = []) {
  return {
    id: contract.id,
    status: contract.status || "下書き",
    data: contract.data || {},
    signature_data: contract.signatureData || "",
    identity_files: identityFiles,
    created_at_text: contract.createdAt || "",
    updated_at_text: contract.updatedAt || "",
    completed_at_text: contract.completedAt || "",
    signed_at_text: contract.signedAt || "",
    consent_status: contract.consentStatus || "",
    consent_result: contract.consentResult || null,
    updated_at: new Date().toISOString(),
  };
}

async function listCloudContracts() {
  const rows = await supabaseRequest(
    "/rest/v1/contracts?select=*&order=updated_at.desc",
    { method: "GET" },
  );
  return (rows || []).map(dbContractToLocal);
}

async function getCloudContract(id) {
  const endpoint = supabaseConfig().publicContractEndpoint;
  if (!endpoint) {
    throw new Error("Public contract endpoint is not configured");
  }

  const response = await fetch(`${endpoint}?id=${encodeURIComponent(id)}`, {
    method: "GET",
  });
  if (!response.ok) throw new Error(await response.text());
  const row = await response.json();
  return row?.id ? dbContractToLocal(row) : null;
}

async function upsertCloudContract(contract, identityFiles = []) {
  const payload = localContractToDb(contract, identityFiles);
  const rows = await supabaseRequest("/rest/v1/contracts?on_conflict=id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(payload),
  });
  return rows?.[0] ? dbContractToLocal(rows[0]) : null;
}

function dataUrlToBlob(dataUrl) {
  const [meta, base64] = dataUrl.split(",");
  const contentType = meta.match(/data:(.*?);/)?.[1] || "application/octet-stream";
  const binary = atob(base64 || "");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: contentType });
}

async function uploadCloudFile(path, dataUrl) {
  const bucket = supabaseConfig().storageBucket || "contract-files";
  const blob = dataUrlToBlob(dataUrl);
  const response = await fetch(
    supabaseUrl(`/storage/v1/object/${bucket}/${path}`),
    {
      method: "PUT",
      headers: {
        apikey: supabaseConfig().anonKey,
        Authorization: `Bearer ${supabaseSession()?.access_token || supabaseConfig().anonKey}`,
        "Content-Type": blob.type,
        "x-upsert": "true",
      },
      body: blob,
    },
  );

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return path;
}

async function uploadIdentityFiles(contractId, files = []) {
  const uploaded = [];
  for (const file of files) {
    if (!file.dataUrl) {
      uploaded.push(file);
      continue;
    }
    const safeId = file.id || `${Date.now()}`;
    const path = `${contractId}/identity/${safeId}.jpg`;
    await uploadCloudFile(path, file.dataUrl);
    const { dataUrl, ...meta } = file;
    uploaded.push({ ...meta, storagePath: path });
  }
  return uploaded;
}

async function saveConsentResult(contractId, result) {
  const endpoint = supabaseConfig().consentSubmitEndpoint;
  if (!endpoint) {
    throw new Error("Consent submit endpoint is not configured");
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contract_id: contractId,
      result,
    }),
  });

  if (!response.ok) throw new Error(await response.text());
}

window.OrderAutoCloud = {
  isConfigured: supabaseIsConfigured,
  isAuthenticated: supabaseIsAuthenticated,
  signIn: supabaseSignIn,
  signOut: supabaseSignOut,
  session: supabaseSession,
  listContracts: listCloudContracts,
  getContract: getCloudContract,
  upsertContract: upsertCloudContract,
  uploadIdentityFiles,
  saveConsentResult,
};
