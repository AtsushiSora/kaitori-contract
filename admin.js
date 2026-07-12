function adminNextUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get("next") || "contract.html";
}

function setAdminMessage(message, tone = "neutral") {
  const element = document.querySelector("#admin-message");
  element.textContent = message;
  element.dataset.tone = tone;
}

function setMode() {
  const isCloud = window.OrderAutoCloud?.isConfigured();
  const isSetup = !window.OrderAutoAdminAuth.hasCredential();

  if (isCloud) {
    document.querySelector("#admin-title").textContent = "管理者ログイン";
    document.querySelector("#admin-copy").textContent =
      "Supabaseの管理者メールアドレスとパスワードでログインしてください。";
    document.querySelector("#admin-email-wrap").hidden = false;
    document.querySelector("#admin-email").required = true;
    document.querySelector("#admin-confirm-wrap").hidden = true;
    document.querySelector("#admin-passcode").autocomplete = "current-password";
    document.querySelector("#admin-submit").textContent = "ログイン";

    if (window.OrderAutoAdminAuth.isAuthenticated()) {
      setAdminMessage("Supabaseにログイン済みです。契約作成へ進めます。", "success");
    } else {
      setAdminMessage("Supabase接続が有効です。本番ログインで保護されます。", "success");
    }
    return;
  }

  document.querySelector("#admin-title").textContent = isSetup
    ? "初回管理者設定"
    : "管理人ログイン";
  document.querySelector("#admin-copy").textContent = isSetup
    ? "最初に管理者パスコードを設定してください。8文字以上を推奨します。"
    : "契約一覧・契約書作成に進むには、管理者パスコードを入力してください。";
  document.querySelector("#admin-confirm-wrap").hidden = !isSetup;
  document.querySelector("#admin-passcode").autocomplete = isSetup
    ? "new-password"
    : "current-password";
  document.querySelector("#admin-submit").textContent = isSetup
    ? "設定して管理画面へ"
    : "ログイン";

  if (window.OrderAutoAdminAuth.isAuthenticated()) {
    setAdminMessage("ログイン済みです。契約作成へ進めます。", "success");
  }
}

async function handleAdminSubmit(event) {
  event.preventDefault();
  const passcode = document.querySelector("#admin-passcode").value;
  const confirm = document.querySelector("#admin-passcode-confirm").value;
  const isCloud = window.OrderAutoCloud?.isConfigured();
  const isSetup = !window.OrderAutoAdminAuth.hasCredential();

  if (isCloud && !document.querySelector("#admin-email").value.trim()) {
    setAdminMessage("メールアドレスを入力してください。", "warning");
    return;
  }

  if (passcode.length < 8) {
    setAdminMessage("パスコードは8文字以上にしてください。", "warning");
    return;
  }

  try {
    if (isCloud) {
      await window.OrderAutoAdminAuth.login(passcode);
      setAdminMessage("Supabaseにログインしました。", "success");
      window.location.href = adminNextUrl();
      return;
    }

    if (isSetup) {
      if (passcode !== confirm) {
        setAdminMessage("確認用パスコードが一致しません。", "warning");
        return;
      }
      await window.OrderAutoAdminAuth.setup(passcode);
      setAdminMessage("管理者パスコードを設定しました。", "success");
      window.location.href = adminNextUrl();
      return;
    }

    const ok = await window.OrderAutoAdminAuth.login(passcode);
    if (!ok) {
      setAdminMessage("パスコードが違います。", "warning");
      return;
    }

    setAdminMessage("ログインしました。", "success");
    window.location.href = adminNextUrl();
  } catch (error) {
    setAdminMessage("処理に失敗しました。ブラウザがWeb Cryptoに対応しているか確認してください。", "warning");
  }
}

function handleTestLogin() {
  const ok = window.confirm(
    "テスト用ログインで契約作成画面へ進みます。本番公開前にはこのボタンを削除してください。",
  );
  if (!ok) return;
  window.OrderAutoAdminAuth.testLogin();
  setAdminMessage("テスト用ログインで入りました。2時間だけ有効です。", "success");
  window.location.href = adminNextUrl();
}

document.addEventListener("DOMContentLoaded", () => {
  setMode();
  document.querySelector("#admin-form").addEventListener("submit", handleAdminSubmit);
  document.querySelector("#test-login")?.addEventListener("click", handleTestLogin);
});
