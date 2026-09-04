const SESSION_KEY = "orderAutoSupabaseSession";

const form = document.querySelector("#invite-password-form");
const description = document.querySelector("#invite-description");
const status = document.querySelector("#invite-status");
const loginLink = document.querySelector("#login-link");

initialize();
form?.addEventListener("submit", updatePassword);

function config() {
  return window.ORDER_AUTO_SUPABASE || {};
}

function authHeaders(accessToken) {
  return {
    apikey: config().anonKey,
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
}

async function initialize() {
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const query = new URLSearchParams(window.location.search);
  const authError = hash.get("error_description") || query.get("error_description");
  if (authError) {
    showUnavailable("招待リンクが無効か、有効期限が切れています。管理者へ再発行を依頼してください。");
    return;
  }

  const accessToken = hash.get("access_token");
  const refreshToken = hash.get("refresh_token");
  const expiresIn = Number(hash.get("expires_in") || 3600);
  if (!config().url || !config().anonKey || !accessToken || !refreshToken) {
    showUnavailable("招待情報を確認できませんでした。最新の招待メールをもう一度開いてください。");
    return;
  }

  const response = await fetch(`${config().url.replace(/\/$/, "")}/auth/v1/user`, {
    headers: authHeaders(accessToken),
  });
  if (!response.ok) {
    showUnavailable("招待情報を確認できませんでした。最新の招待メールをもう一度開いてください。");
    return;
  }

  const user = await response.json();
  localStorage.setItem(SESSION_KEY, JSON.stringify({
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: Math.floor(Date.now() / 1000) + expiresIn,
    user,
  }));
  history.replaceState(null, "", window.location.pathname);
  description.textContent = `${user.email || "登録メールアドレス"} のパスワードを設定します。8文字以上で入力してください。`;
  form.hidden = false;
  status.textContent = "";
}

async function updatePassword(event) {
  event.preventDefault();
  const formData = new FormData(form);
  const password = String(formData.get("password") || "");
  const passwordConfirm = String(formData.get("passwordConfirm") || "");

  if (password.length < 8) {
    status.textContent = "パスワードは8文字以上で入力してください。";
    return;
  }
  if (password !== passwordConfirm) {
    status.textContent = "確認用パスワードが一致しません。";
    return;
  }

  const session = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
  if (!session?.access_token) {
    showUnavailable("招待の有効期限が切れています。管理者へ再発行を依頼してください。");
    return;
  }

  const submitButton = form.querySelector("button[type='submit']");
  submitButton.disabled = true;
  status.textContent = "パスワードを設定しています。";

  const response = await fetch(`${config().url.replace(/\/$/, "")}/auth/v1/user`, {
    method: "PUT",
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ password }),
  });
  if (!response.ok) {
    submitButton.disabled = false;
    status.textContent = "パスワードを設定できませんでした。最新の招待メールを開き直してください。";
    return;
  }

  localStorage.removeItem(SESSION_KEY);
  form.reset();
  form.hidden = true;
  description.textContent = "パスワードを設定しました。";
  status.textContent = "買取契約のログイン画面からログインしてください。";
  loginLink.hidden = false;
}

function showUnavailable(message) {
  description.textContent = message;
  status.textContent = "";
  form.hidden = true;
  loginLink.hidden = false;
}
