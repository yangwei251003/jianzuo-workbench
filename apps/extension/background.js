const API = "http://127.0.0.1:8787";
const WS = "ws://127.0.0.1:8787/ws/extension";
let socket = null;
let reconnectTimer = null;
let retryMs = 1000;
let writesPaused = false;
let authenticationRejected = false;

async function ensureHeartbeatAlarm() {
  const existing = await chrome.alarms.get("jianzuo-heartbeat");
  if (!existing || existing.periodInMinutes !== 0.5) {
    await chrome.alarms.create("jianzuo-heartbeat", { periodInMinutes: 0.5 });
  }
}

chrome.runtime.onInstalled.addListener(() => void ensureHeartbeatAlarm());
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "jianzuo-heartbeat") return;
  if (socket?.readyState === WebSocket.OPEN) void sendHeartbeat();
  else void connect();
});
chrome.runtime.onStartup.addListener(() => { void ensureHeartbeatAlarm(); void connect(); });

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "pair") {
    pair(message.code).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "status") {
    chrome.storage.local.get(["extensionToken", "pairedAt", "pairingError"]).then(({ extensionToken, pairedAt, pairingError }) => sendResponse({
      ok: true,
      paired: Boolean(extensionToken),
      pairedAt,
      pairingError,
      connected: socket?.readyState === WebSocket.OPEN
    }));
    return true;
  }
  if (message.type === "reconnect") { void connect(true); sendResponse({ ok: true }); }
  if (message.type === "write_guard") {
    checkWriteGuard(message.commandId).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
});

async function pair(code) {
  const response = await fetch(`${API}/api/extension/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
  const envelope = await response.json();
  if (!response.ok || !envelope.data?.token) throw new Error(envelope.summary || "配对失败");
  authenticationRejected = false;
  await chrome.storage.local.set({ extensionToken: envelope.data.token, pairedAt: new Date().toISOString(), pairingError: "" });
  await connect(true);
  return { ok: true };
}

async function connect(force = false) {
  const { extensionToken } = await chrome.storage.local.get(["extensionToken"]);
  if (!extensionToken) return;
  if (authenticationRejected && !force) return;
  if (!force && socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState)) return;
  if (socket) socket.close();
  clearTimeout(reconnectTimer);
  socket = new WebSocket(WS);
  socket.addEventListener("open", async () => {
    retryMs = 1000;
    socket.send(JSON.stringify({ type: "authenticate", token: extensionToken }));
  });
  socket.addEventListener("message", async (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === "paired") {
      await sendHeartbeat();
      socket.send(JSON.stringify({ type: "request_work" }));
    }
    if (message.type === "paused") writesPaused = true;
    if (message.type === "resumed") { writesPaused = false; socket.send(JSON.stringify({ type: "request_work" })); }
    if (message.type === "command") await executeCommand(message.command);
  });
  socket.addEventListener("close", async (event) => {
    if (event.code === 1008 && /unauthorized/i.test(event.reason || "")) {
      authenticationRejected = true;
      clearTimeout(reconnectTimer);
      await chrome.storage.local.remove(["extensionToken", "pairedAt"]);
      await chrome.storage.local.set({ pairingError: "配对已过期，请在工作台重新生成一次性配对码" });
      return;
    }
    scheduleReconnect();
  });
  socket.addEventListener("error", () => socket?.close());
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => void connect(true), retryMs);
  retryMs = Math.min(retryMs * 2, 30000);
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("没有可用的活动页面");
  return tab;
}

function isGoofishTab(tab) {
  try { return Boolean(tab?.id) && new URL(tab.url || "").hostname === "www.goofish.com"; } catch { return false; }
}

async function inspectTab(tab) {
  if (!isGoofishTab(tab)) return null;
  try { return await chrome.tabs.sendMessage(tab.id, { type: "inspect" }); } catch { return null; }
}

function canUseSupportingAccountEvidence(inspection) {
  return Boolean(inspection && ["listing-create", "messages", "orders", "delivery", "item-detail"].includes(inspection.pageType));
}

async function findSupportingAccountInspection(targetTab) {
  const tabs = await chrome.tabs.query({ windowId: targetTab.windowId, url: ["https://www.goofish.com/*"] });
  for (const tab of tabs) {
    if (tab.id === targetTab.id) continue;
    const inspection = await inspectTab(tab);
    if (inspection?.accountLabel && inspection?.accountFingerprint && inspection.pageType !== "login") return inspection;
  }
  return null;
}

function mergeSupportingAccountEvidence(inspection, supporting) {
  return {
    ...inspection,
    accountLabel: supporting.accountLabel,
    accountFingerprint: supporting.accountFingerprint,
    accountIdentitySource: `supporting-account-tab:${supporting.accountIdentitySource || "visible-account"}`,
    accountBindingEligible: false
  };
}

async function managedHeartbeatTab() {
  const active = await activeTab().catch(() => null);
  const activeInspection = active ? await inspectTab(active) : null;
  if (activeInspection?.accountLabel && activeInspection.pageType !== "login") {
    await chrome.storage.local.set({ managedTabId: active.id });
    return { tab: active, inspection: activeInspection };
  }
  if (active && canUseSupportingAccountEvidence(activeInspection)) {
    const supporting = await findSupportingAccountInspection(active);
    if (supporting) {
      await chrome.storage.local.set({ managedTabId: active.id });
      return { tab: active, inspection: mergeSupportingAccountEvidence(activeInspection, supporting) };
    }
  }

  const { managedTabId } = await chrome.storage.local.get(["managedTabId"]);
  if (Number.isInteger(managedTabId)) {
    const stored = await chrome.tabs.get(managedTabId).catch(() => null);
    const inspection = stored ? await inspectTab(stored) : null;
    if (inspection?.accountLabel && inspection.pageType !== "login") return { tab: stored, inspection };
  }

  const tabs = await chrome.tabs.query({ url: ["https://www.goofish.com/*"] });
  for (const tab of tabs) {
    const inspection = await inspectTab(tab);
    if (!inspection?.accountLabel || inspection.pageType === "login") continue;
    await chrome.storage.local.set({ managedTabId: tab.id });
    return { tab, inspection };
  }
  if (active && activeInspection) return { tab: active, inspection: activeInspection };
  throw new Error("没有可识别的闲鱼页面");
}

async function sendHeartbeat() {
  try {
    const { tab, inspection } = await managedHeartbeatTab();
    const completed = completeInspectionForTransport(inspection, tab);
    socket?.send(JSON.stringify({
      type: "heartbeat",
      pageType: completed.pageType,
      domFingerprint: completed.domFingerprint,
      pageUrl: completed.pageUrl,
      tabId: completed.tabId,
      adapterVersion: completed.adapterVersion,
      accountLabel: completed.accountLabel,
      accountFingerprint: completed.accountFingerprint,
      accountIdentitySource: completed.accountIdentitySource,
      accountBindingEligible: completed.accountBindingEligible,
      visibleTarget: completed.visibleTarget,
      visibleContext: completed.visibleContext,
      visibleSnapshot: completed.visibleSnapshot
    }));
  } catch {
    socket?.send(JSON.stringify({ type: "heartbeat", pageType: "unavailable", domFingerprint: "" }));
  }
}

async function executeCommand(command) {
  let receipt;
  let dispatchedToPage = false;
  try {
    if (writesPaused) throw new Error("全局紧急停止已开启");
    const tab = command.expectedTabId
      ? await chrome.tabs.get(Number(command.expectedTabId))
      : (await managedHeartbeatTab()).tab;
    if (!isGoofishTab(tab)) throw new Error("审批目标不是闲鱼页面");
    await chrome.tabs.update(tab.id, { active: true });
    if (Number.isInteger(tab.windowId)) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    if (command.observedAt) {
      const observedAt = Date.parse(command.observedAt);
      if (!Number.isFinite(observedAt) || Date.now() - observedAt > 45000 || observedAt > Date.now() + 5000) throw new Error("动作绑定的页面心跳已过期");
    }
    if (command.expectedTabId && command.expectedTabId !== String(tab.id)) throw new Error("当前标签页与审批目标不一致");
    if (command.expectedPageUrl && command.expectedPageUrl !== safePageUrl(tab.url)) throw new Error("当前页面地址与审批目标不一致");
    const inspection = await chrome.tabs.sendMessage(tab.id, { type: "inspect" });
    if (command.expectedPageType && command.expectedPageType !== inspection.pageType) throw new Error("当前页面类型与审批目标不一致");
    if (command.expectedAccountLabel && command.expectedAccountLabel !== inspection.accountLabel) throw new Error("当前可见账号与审批绑定账号不一致");
    if (command.expectedAccountFingerprint && command.expectedAccountFingerprint !== inspection.accountFingerprint) throw new Error("当前账号公开资料指纹与审批记录不一致");
    if (command.adapterVersion && command.adapterVersion !== inspection.adapterVersion) throw new Error("页面适配器版本与审批时不一致");
    if (command.preconditionFingerprint && !command.preconditionFingerprint.startsWith("pending-") && command.preconditionFingerprint !== inspection.domFingerprint) throw new Error("页面结构与审批时不一致");
    const enriched = await enrichImages(command);
    const responsePromise = chrome.tabs.sendMessage(tab.id, { type: "command", command: enriched });
    dispatchedToPage = true;
    const response = await responsePromise;
    let screenshotDataUrl;
    try {
      const current = await activeTab();
      if (current.id === tab.id) screenshotDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    } catch { /* tab may have expired; never capture a different page */ }
    receipt = createTransportReceipt(response, command.commandId, tab, screenshotDataUrl);
  } catch (error) {
    receipt = {
      commandId: command.commandId,
      status: dispatchedToPage ? "result_unknown" : "failed",
      pageType: "unavailable",
      domFingerprint: "",
      summary: dispatchedToPage
        ? `命令已交给页面，但通信中断，无法确认结果：${error.message}`
        : error.message,
      timestamp: new Date().toISOString()
    };
  }
  socket?.send(JSON.stringify({ type: "receipt", receipt }));
  socket?.send(JSON.stringify({ type: "request_work" }));
}

function safePageUrl(value) {
  try { const url = new URL(value); return `${url.origin}${url.pathname}`; } catch { return ""; }
}

function completeInspectionForTransport(inspection, tab, observedAt = new Date().toISOString()) {
  const completed = {
    ...inspection,
    pageUrl: inspection?.pageUrl || safePageUrl(tab?.url),
    tabId: Number.isInteger(tab?.id) ? String(tab.id) : undefined
  };
  const partial = inspection?.visibleTarget;
  const commonReady = completed.pageUrl && completed.tabId && inspection?.accountFingerprint
    && inspection?.domFingerprint && inspection?.adapterVersion;
  if (!partial || !commonReady) return { ...completed, visibleTarget: undefined };
  const common = {
    conversationId: partial.conversationId,
    buyerPublicId: partial.buyerPublicId,
    productId: partial.productId,
    pageUrl: completed.pageUrl,
    tabId: completed.tabId,
    accountFingerprint: inspection.accountFingerprint,
    domFingerprint: inspection.domFingerprint,
    adapterVersion: inspection.adapterVersion,
    observedAt
  };
  if (!hasExactNonEmptyStrings(common)) return { ...completed, visibleTarget: undefined };
  if (partial.targetType === "message") {
    return { ...completed, visibleTarget: { targetType: "message", ...common } };
  }
  if (partial.targetType === "order" && hasExactNonEmptyStrings({ orderId: partial.orderId, amount: partial.amount }) && partial.currency === "CNY") {
    return {
      ...completed,
      visibleTarget: {
        targetType: "order",
        ...common,
        orderId: partial.orderId,
        amount: partial.amount,
        currency: "CNY"
      }
    };
  }
  return { ...completed, visibleTarget: undefined };
}

function hasExactNonEmptyStrings(record) {
  return Object.values(record).every((value) => typeof value === "string" && value.length > 0 && value.length <= 2048);
}

function createTransportReceipt(response, commandId, tab, screenshotDataUrl) {
  const timestamp = new Date().toISOString();
  const completed = completeInspectionForTransport(response, tab, timestamp);
  return { ...completed, commandId, screenshotDataUrl, timestamp };
}

async function checkWriteGuard(commandId) {
  if (writesPaused) return { ok: false, error: "全局紧急停止已开启" };
  const { extensionToken } = await chrome.storage.local.get(["extensionToken"]);
  const response = await fetch(`${API}/api/extension/action-guard/${encodeURIComponent(commandId)}`, { headers: { "x-extension-token": extensionToken } });
  const envelope = await response.json();
  if (response.status === 401 || response.status === 403) {
    authenticationRejected = true;
    await chrome.storage.local.remove(["extensionToken", "pairedAt"]);
    await chrome.storage.local.set({ pairingError: "配对已过期，请重新配对后再执行动作" });
  }
  return response.ok && envelope.data?.allowed ? { ok: true } : { ok: false, error: envelope.summary || "写动作许可已失效" };
}

async function enrichImages(command) {
  const urls = command.payload?.artifactUrls;
  const { extensionToken } = await chrome.storage.local.get(["extensionToken"]);
  const payload = { ...command.payload };
  if (Array.isArray(urls) && urls.length) {
    const imageFiles = [];
    for (let index = 0; index < urls.length; index += 1) {
      const response = await fetch(`${API}${urls[index]}`, { headers: { "x-extension-token": extensionToken } });
      if (!response.ok) throw new Error(`第 ${index + 1} 张商品图读取失败`);
      const blob = await response.blob();
      imageFiles.push({ name: `jianzuo-${index + 1}.png`, type: blob.type || "image/png", dataUrl: await blobToDataUrl(blob) });
    }
    payload.imageFiles = imageFiles;
  }
  if (typeof payload.deliveryArtifactUrl === "string") {
    const response = await fetch(`${API}${payload.deliveryArtifactUrl}`, { headers: { "x-extension-token": extensionToken } });
    if (!response.ok) throw new Error("交付附件读取失败");
    const blob = await response.blob();
    const disposition = response.headers.get("content-disposition") || "";
    const matched = disposition.match(/filename="([^"]+)"/);
    const name = matched ? decodeURIComponent(matched[1]) : "jianzuo-delivery.zip";
    payload.attachmentFiles = [{ name, type: blob.type || "application/zip", dataUrl: await blobToDataUrl(blob) }];
  }
  return { ...command, payload };
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return `data:${blob.type || "application/octet-stream"};base64,${btoa(binary)}`;
}

if (globalThis.__JIANZUO_EXTENSION_TEST__) {
  globalThis.__jianzuoBackgroundTest = { completeInspectionForTransport, createTransportReceipt, ensureHeartbeatAlarm, managedHeartbeatTab };
} else {
  void ensureHeartbeatAlarm();
  void connect();
}
