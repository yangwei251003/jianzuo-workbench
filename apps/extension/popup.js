const status = document.getElementById("status");
const feedback = document.getElementById("feedback");
const form = document.getElementById("pair-form");
const reconnect = document.getElementById("reconnect");

function refresh() {
  chrome.runtime.sendMessage({ type: "status" }, (response) => {
    feedback.textContent = response?.pairingError || "";
    if (response?.paired) {
      status.className = response.connected ? "status online" : "status warning";
      status.textContent = response.connected ? "已连接本地工作台" : "已配对，正在重连";
      form.hidden = true; reconnect.hidden = false;
    } else { status.className = response?.pairingError ? "status warning" : "status"; status.textContent = response?.pairingError ? "配对已失效" : "尚未配对"; form.hidden = false; reconnect.hidden = true; }
  });
}
form.addEventListener("submit", (event) => {
  event.preventDefault(); feedback.textContent = "正在配对";
  chrome.runtime.sendMessage({ type: "pair", code: document.getElementById("code").value }, (response) => { feedback.textContent = response?.ok ? "配对成功" : response?.error || "配对失败"; refresh(); });
});
reconnect.addEventListener("click", () => chrome.runtime.sendMessage({ type: "reconnect" }, () => { feedback.textContent = "已请求重新连接"; setTimeout(refresh, 600); }));
refresh();
