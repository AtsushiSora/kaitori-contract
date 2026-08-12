async function adminLogin(passcode) {
  const email = document.querySelector("#admin-email")?.value.trim();
  await window.OrderAutoCloud.signIn(email, passcode);
  return true;
}

function adminIsAuthenticated() {
  return Boolean(window.OrderAutoCloud?.isAuthenticated());
}

function adminLogout() {
  window.OrderAutoCloud?.signOut();
  window.location.href = "admin.html";
}

function adminRequireAuth() {
  if (!adminIsAuthenticated()) {
    const next = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    window.location.replace(`admin.html?next=${encodeURIComponent(next)}`);
  }
}

window.OrderAutoAdminAuth = {
  isAuthenticated: adminIsAuthenticated,
  login: adminLogin,
  logout: adminLogout,
  requireAuth: adminRequireAuth,
};
