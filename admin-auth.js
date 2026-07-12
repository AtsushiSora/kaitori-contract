const ADMIN_CREDENTIAL_KEY = "orderAutoAdminCredential";
const ADMIN_SESSION_KEY = "orderAutoAdminSession";
const ADMIN_ITERATIONS = 210000;
const ADMIN_SESSION_HOURS = 12;
const ADMIN_TEST_SESSION_HOURS = 2;

function adminBytesToBase64(bytes) {
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return btoa(binary);
}

function adminBase64ToBytes(value) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

async function adminHashPasscode(passcode, salt, iterations = ADMIN_ITERATIONS) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passcode),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations,
      hash: "SHA-256",
    },
    material,
    256,
  );
  return new Uint8Array(bits);
}

function adminConstantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a[index] ^ b[index];
  }
  return diff === 0;
}

function adminCredential() {
  try {
    return JSON.parse(localStorage.getItem(ADMIN_CREDENTIAL_KEY) || "null");
  } catch (error) {
    return null;
  }
}

function adminHasCredential() {
  if (window.OrderAutoCloud?.isConfigured()) return true;
  return Boolean(adminCredential()?.hash) || adminIsTestSession();
}

async function adminSetup(passcode) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await adminHashPasscode(passcode, salt);
  localStorage.setItem(
    ADMIN_CREDENTIAL_KEY,
    JSON.stringify({
      version: 1,
      iterations: ADMIN_ITERATIONS,
      salt: adminBytesToBase64(salt),
      hash: adminBytesToBase64(hash),
      createdAt: new Date().toISOString(),
    }),
  );
  adminCreateSession();
}

async function adminLogin(passcode) {
  if (window.OrderAutoCloud?.isConfigured()) {
    const email = document.querySelector("#admin-email")?.value.trim();
    await window.OrderAutoCloud.signIn(email, passcode);
    return true;
  }

  const credential = adminCredential();
  if (!credential?.hash || !credential?.salt) return false;

  const salt = adminBase64ToBytes(credential.salt);
  const expected = adminBase64ToBytes(credential.hash);
  const actual = await adminHashPasscode(passcode, salt, credential.iterations);
  const ok = adminConstantTimeEqual(actual, expected);

  if (ok) {
    adminCreateSession();
  }

  return ok;
}

function adminCreateSession() {
  adminStoreSession(ADMIN_SESSION_HOURS, false);
}

function adminCreateTestSession() {
  adminStoreSession(ADMIN_TEST_SESSION_HOURS, true);
}

function adminStoreSession(hours, testMode) {
  const expiresAt = Date.now() + hours * 60 * 60 * 1000;
  sessionStorage.setItem(
    ADMIN_SESSION_KEY,
    JSON.stringify({
      expiresAt,
      createdAt: Date.now(),
      testMode,
    }),
  );
}

function adminIsAuthenticated() {
  if (adminIsTestSession()) return true;

  if (window.OrderAutoCloud?.isConfigured()) {
    return window.OrderAutoCloud.isAuthenticated();
  }

  try {
    const session = JSON.parse(sessionStorage.getItem(ADMIN_SESSION_KEY) || "null");
    if (!session?.expiresAt || Date.now() > session.expiresAt) {
      sessionStorage.removeItem(ADMIN_SESSION_KEY);
      return false;
    }
    return true;
  } catch (error) {
    return false;
  }
}

function adminIsTestSession() {
  try {
    const session = JSON.parse(sessionStorage.getItem(ADMIN_SESSION_KEY) || "null");
    if (!session?.testMode || !session?.expiresAt || Date.now() > session.expiresAt) {
      return false;
    }
    return true;
  } catch (error) {
    return false;
  }
}

function adminTestLogin() {
  adminCreateTestSession();
}

function adminLogout() {
  if (window.OrderAutoCloud?.isConfigured()) {
    window.OrderAutoCloud.signOut();
  }
  sessionStorage.removeItem(ADMIN_SESSION_KEY);
  window.location.href = "admin.html";
}

function adminRequireAuth() {
  if (!adminHasCredential() || !adminIsAuthenticated()) {
    const next = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    window.location.replace(`admin.html?next=${encodeURIComponent(next)}`);
  }
}

window.OrderAutoAdminAuth = {
  hasCredential: adminHasCredential,
  isAuthenticated: adminIsAuthenticated,
  login: adminLogin,
  logout: adminLogout,
  requireAuth: adminRequireAuth,
  setup: adminSetup,
  testLogin: adminTestLogin,
};
