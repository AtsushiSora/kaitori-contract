function downloadToken() {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const token = String(params.get("d") || "").trim();
  return /^[A-Za-z0-9_-]{32}$/.test(token) ? token : "";
}

function setDownloadStatus(message, tone = "neutral") {
  const status = document.querySelector("#download-status");
  status.textContent = message;
  status.dataset.tone = tone;
}

document.addEventListener("DOMContentLoaded", async () => {
  const token = downloadToken();
  const openButton = document.querySelector("#open-contract-pdf");
  if (!token || !window.OrderAutoCloud?.isConfigured()) {
    setDownloadStatus("ダウンロードURLが正しくありません。", "warning");
    return;
  }

  try {
    const pdf = await window.OrderAutoCloud.downloadCompletedContract(token);
    const pdfUrl = URL.createObjectURL(pdf);
    openButton.href = pdfUrl;
    openButton.hidden = false;
    setDownloadStatus("契約書PDFを準備しました。", "success");
    window.addEventListener("pagehide", () => URL.revokeObjectURL(pdfUrl), { once: true });
  } catch (error) {
    console.error(error);
    setDownloadStatus("URLの有効期限が切れているか、契約書を取得できませんでした。", "warning");
  }
});
