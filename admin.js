function adminNextUrl() {
  const params = new URLSearchParams(window.location.search);
  const requested = params.get("next");
  if (!requested) return "contract.html";

  const destination = new URL(requested, window.location.href);
  if (destination.origin !== window.location.origin) return "contract.html";
  return `${destination.pathname}${destination.search}${destination.hash}`;
}

function setAdminMessage(message, tone = "neutral") {
  const element = document.querySelector("#admin-message");
  element.textContent = message;
  element.dataset.tone = tone;
}

function setMode() {
  const emailWrap = document.querySelector("#admin-email-wrap");
  emailWrap.hidden = false;
  document.querySelector("#admin-email").required = true;

  if (window.OrderAutoAdminAuth.isAuthenticated()) {
    setAdminMessage("Supabaseにログイン済みです。契約作成へ進めます。", "success");
  } else if (!window.OrderAutoCloud?.isConfigured()) {
    setAdminMessage("Supabaseの接続設定を確認してください。", "warning");
  }
}

async function handleAdminSubmit(event) {
  event.preventDefault();
  const passcode = document.querySelector("#admin-passcode").value;

  if (!window.OrderAutoCloud?.isConfigured()) {
    setAdminMessage("Supabaseの接続設定を確認してください。", "warning");
    return;
  }

  if (!document.querySelector("#admin-email").value.trim()) {
    setAdminMessage("メールアドレスを入力してください。", "warning");
    return;
  }

  if (passcode.length < 8) {
    setAdminMessage("パスワードは8文字以上にしてください。", "warning");
    return;
  }

  try {
    await window.OrderAutoAdminAuth.login(passcode);
    setAdminMessage("Supabaseにログインしました。", "success");
    window.location.href = adminNextUrl();
  } catch (error) {
    setAdminMessage("ログインできませんでした。メールアドレスとパスワードを確認してください。", "warning");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  setMode();
  document.querySelector("#admin-form").addEventListener("submit", handleAdminSubmit);
});
