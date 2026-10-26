chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "inspect") { inspect().then(sendResponse); return true; }
  if (message.type === "command") { execute(message.command).then(sendResponse).catch((error) => inspect().then((info) => sendResponse({ ...info, status: "failed", summary: error.message }))); return true; }
});

function installWorkbenchPairingBridge() {
  const workbenchOrigin = globalThis.__JIANZUO_EXTENSION_TEST__?.workbenchOrigin || "http://127.0.0.1:8787";
  if (location.origin !== workbenchOrigin) return;
  window.addEventListener("message", async (event) => {
    const message = event.data;
    if (event.source !== window || event.origin !== workbenchOrigin || message?.source !== "jianzuo-workbench" || message?.type !== "pair-extension") return;
    const requestId = typeof message.requestId === "string" && /^[a-zA-Z0-9-]{8,80}$/.test(message.requestId) ? message.requestId : "";
    if (!requestId) return;
    if (!/^\d{6}$/.test(String(message.code || ""))) {
      window.postMessage({ source: "jianzuo-extension", type: "pair-result", requestId, ok: false, error: "配对码格式无效" }, workbenchOrigin);
      return;
    }
    try {
      const response = await chrome.runtime.sendMessage({ type: "pair", code: message.code });
      window.postMessage({
        source: "jianzuo-extension",
        type: "pair-result",
        requestId,
        ok: response?.ok === true,
        error: response?.ok === true ? undefined : String(response?.error || "扩展配对失败").slice(0, 240)
      }, workbenchOrigin);
    } catch (error) {
      window.postMessage({ source: "jianzuo-extension", type: "pair-result", requestId, ok: false, error: String(error?.message || "扩展不可用").slice(0, 240) }, workbenchOrigin);
    }
  });
  window.postMessage({ source: "jianzuo-extension", type: "bridge-ready" }, workbenchOrigin);
}

const ADAPTER_VERSION = "goofish-web-2026-08-31-v3";
const MAX_INBOUND_TEXT_LENGTH = 20_000;
let sellerOrdersFocused = false;

async function inspect() {
  const pageType = classifyPage();
  const accountIdentity = readVisibleAccountIdentity();
  const accountLabel = accountIdentity?.label || "";
  const accountFingerprint = accountIdentity ? await fingerprintVisibleAccount(accountIdentity) : "";
  const visibleTarget = await collectVisibleTarget(pageType);
  const visibleContext = await collectVisibleContext(pageType);
  return {
    pageType,
    domFingerprint: await fingerprint(),
    verificationRequired: detectVerification(),
    pageUrl: `${location.origin}${location.pathname}`,
    adapterVersion: ADAPTER_VERSION,
    accountLabel: accountLabel || undefined,
    accountFingerprint: accountFingerprint || undefined,
    accountIdentitySource: accountIdentity?.source,
    accountBindingEligible: Boolean(accountIdentity && ["account-home", "account-profile"].includes(pageType)),
    visibleTarget,
    visibleContext,
    visibleSnapshot: collectVisibleSnapshot(pageType)
  };
}

async function fingerprintVisibleAccount(accountIdentity) {
  const { label: accountLabel, link } = accountIdentity;
  const avatar = link?.querySelector("img") || [...document.querySelectorAll("img")].find((item) => (item.getAttribute("alt") || "").trim() === accountLabel);
  const safeVisibleUrl = (value) => {
    try { const parsed = new URL(value || "", location.href); return `${parsed.origin}${parsed.pathname}`; } catch { return ""; }
  };
  const publicIdentity = [accountLabel, safeVisibleUrl(link?.getAttribute("href")), safeVisibleUrl(avatar?.getAttribute("src"))].join("|");
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(publicIdentity));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readVisibleAccountLabel() {
  return readVisibleAccountIdentity()?.label || "";
}

function readVisibleAccountIdentity() {
  const explicit = [...document.querySelectorAll("[data-jianzuo-account], [data-jianzuo-account-label]")].filter(visible);
  const headerRegions = [...document.querySelectorAll([
    "header",
    '[role="banner"]',
    '[class*="site-header--"]',
    '[class*="navbar--"]',
    '[class*="header-content--"]'
  ].join(","))].filter(visible);
  const explicitLinks = explicit.flatMap((region) => region.matches('a[href*="/personal"]') ? [region] : [...region.querySelectorAll('a[href*="/personal"]')]);
  const headerLinks = headerRegions.flatMap((region) => [...region.querySelectorAll('a[href*="/personal"]')]);
  const candidates = [...new Set([...explicitLinks, ...headerLinks])]
    .filter((link) => link instanceof HTMLAnchorElement && visible(link))
    .map((link) => ({ link, label: visibleAccountLabelFromLink(link), source: explicitLinks.includes(link) ? "explicit-account-marker" : "page-header" }))
    .filter((candidate) => candidate.label);
  const identities = new Map(candidates.map((candidate) => [`${candidate.label}|${safeVisibleIdentityUrl(candidate.link.getAttribute("href"))}`, candidate]));
  return identities.size === 1 ? [...identities.values()][0] : undefined;
}

function visibleAccountLabelFromLink(link) {
  const values = [link?.textContent, link?.getAttribute("aria-label"), link?.getAttribute("title"), link?.querySelector("img")?.getAttribute("alt")];
  for (const value of values) {
    const normalized = String(value || "").trim().replace(/\s+/g, " ").slice(0, 40);
    if (normalized && !/^(个人中心|我的|头像)$/.test(normalized)) return normalized;
  }
  return "";
}

function safeVisibleIdentityUrl(value) {
  try { const parsed = new URL(value || "", location.href); return `${parsed.origin}${parsed.pathname}`; } catch { return ""; }
}

async function openLoginQrIfRequested() {
  const url = new URL(location.href);
  if (url.searchParams.get("jianzuo_login") !== "1") return;
  url.searchParams.delete("jianzuo_login");
  history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
  // 闲鱼首页的登录入口会在首屏数据之后出现。有限重试只负责打开
  // 可见登录框，不填写账号、不读取二维码，也不绕过任何平台验证。
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await wait(attempt === 0 ? 2500 : 1000);
    if (document.querySelector('a[href*="/personal"]') || detectVerification() || hasVisibleLoginDialog()) return;
    const candidates = [...document.querySelectorAll("button,a,[role=button],div")]
      .filter((item) => visible(item) && (item.textContent || "").trim() === "登录")
      .sort((left, right) => {
        const leftInteractive = /^(BUTTON|A)$/.test(left.tagName) || left.getAttribute("role") === "button";
        const rightInteractive = /^(BUTTON|A)$/.test(right.tagName) || right.getAttribute("role") === "button";
        return Number(rightInteractive) - Number(leftInteractive) || left.childElementCount - right.childElementCount;
      });
    candidates[0]?.click();
  }
}

async function openSellerOrdersIfRequested() {
  const url = new URL(location.href);
  if (url.searchParams.get("jianzuo_sold") !== "1") return;
  url.searchParams.delete("jianzuo_sold");
  history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);

  // “我卖出的”是个人页中的可见页签，不是稳定的公开直达 URL。
  // 这里只做只读导航；不查找也不点击发货、确认或发送类按钮。
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await wait(attempt === 0 ? 1800 : 700);
    const labels = [...document.querySelectorAll("span,button,a,li,[role=button]")]
      .filter((item) => visible(item) && (item.textContent || "").trim() === "我卖出的");
    const controls = [...new Set(labels.map((item) => item.closest("button,a,li,[role=button]") || item))]
      .filter(visible);
    if (controls.length !== 1) continue;
    controls[0].click();
    sellerOrdersFocused = true;
    return;
  }
}

function hasVisibleLoginDialog() {
  return [...document.querySelectorAll('[role="dialog"]')].some((item) => visible(item));
}

function collectVisibleSnapshot(pageType) {
  const text = visibleText().replace(/,/g, "");
  const firstNumber = (pattern) => { const matched = text.match(pattern); return matched ? Number(matched[1]) : undefined; };
  const metrics = {};
  if (pageType === "account-home") {
    const messageText = document.querySelector('a[href*="/im"]')?.textContent || "";
    const unread = messageText.match(/(\d+)\s*消息/); if (unread) metrics.unreadMessages = Number(unread[1]);
  }
  if (pageType === "messages") {
    const unread = firstNumber(/消息\s*(\d+)/); if (unread !== undefined) metrics.unreadMessages = unread;
  }
  if (pageType === "item-detail") {
    const interested = firstNumber(/(\d+)\s*人想要/); if (interested !== undefined) metrics.interested = interested;
    const viewed = firstNumber(/浏览\s*(\d+)/); if (viewed !== undefined) metrics.views = viewed;
    const collected = firstNumber(/收藏\s*(\d+)/); if (collected !== undefined) metrics.favorites = collected;
  }
  if (pageType === "account-profile") {
    const selling = firstNumber(/在卖\s*(\d+)/); if (selling !== undefined) metrics.selling = selling;
    const sold = firstNumber(/已卖出\s*(\d+)/); if (sold !== undefined) metrics.sold = sold;
    const reviews = firstNumber(/评价\s*(\d+)/); if (reviews !== undefined) metrics.reviews = reviews;
  }
  if (pageType === "orders") {
    const pending = firstNumber(/待处理\s*(\d+)/); if (pending !== undefined) metrics.pendingOrders = pending;
  }
  return Object.keys(metrics).length ? { metrics, capturedAt: new Date().toISOString() } : undefined;
}

async function collectVisibleTarget(pageType) {
  if (pageType !== "messages" && pageType !== "orders" && pageType !== "delivery") return undefined;
  const conversationId = uniquePublicValue(
    ["data-jianzuo-conversation-id", "data-conversation-id", "data-chat-id"],
    ["conversationId", "conversation_id", "chatId", "chat_id"]
  );
  const buyerPublicId = uniquePublicValue(
    ["data-jianzuo-buyer-public-id", "data-buyer-public-id", "data-buyer-id"],
    ["buyerPublicId", "buyer_public_id", "buyerId", "buyer_id"]
  );
  const productId = uniquePublicValue(
    ["data-jianzuo-product-id", "data-product-id", "data-item-id"],
    ["productId", "product_id", "itemId", "item_id"]
  );
  if (conversationId && buyerPublicId && productId && pageType === "messages") {
    return { targetType: "message", conversationId, buyerPublicId, productId };
  }

  if (pageType === "messages") return collectGoofishVisibleMessageTarget();
  if (!conversationId || !buyerPublicId || !productId) return undefined;

  const orderId = uniquePublicValue(
    ["data-jianzuo-order-id", "data-order-id"],
    ["orderId", "order_id"]
  );
  const rawAmount = uniqueVisibleAttribute(["data-jianzuo-order-amount", "data-order-amount"]);
  const amount = normalizeVisibleAmount(rawAmount);
  const currency = uniqueVisibleAttribute(["data-jianzuo-order-currency", "data-order-currency"]);
  if (!orderId || !amount || currency !== "CNY") return undefined;
  return { targetType: "order", conversationId, buyerPublicId, productId, orderId, amount, currency: "CNY" };
}

async function collectGoofishVisibleMessageTarget() {
  // The public web UI does not put a conversation id in the address bar. It
  // does expose exactly one buyer profile link and one item link inside the
  // selected chat. Derive a stable pseudonymous conversation key from those
  // visible public identifiers; do not inspect React internals or private APIs.
  const chat = uniqueVisible('[class*="chat-main--"]');
  if (!chat || !uniqueVisible('[class*="conversation-item-active--"]')) return undefined;
  const buyerLink = uniqueVisibleWithin(chat, 'a[href*="/personal"][href*="userId="]');
  const productLink = uniqueVisibleWithin(chat, 'a[href*="/item"][href*="id="]');
  if (!buyerLink || !productLink) return undefined;
  const buyerPublicId = publicUrlQueryValue(buyerLink, "/personal", "userId");
  const productId = publicUrlQueryValue(productLink, "/item", "id");
  if (!buyerPublicId || !productId) return undefined;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${buyerPublicId}|${productId}`));
  const conversationId = `visible-${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  return { targetType: "message", conversationId, buyerPublicId, productId };
}

async function collectVisibleContext(pageType) {
  if (pageType !== "messages") return undefined;
  const candidates = [...document.querySelectorAll("[data-jianzuo-last-inbound]")].filter(visible);
  if (candidates.length === 1) {
    return buildInboundContext(candidates[0].textContent);
  }
  const chat = uniqueVisible('[class*="chat-main--"]');
  if (!chat || !uniqueVisible('[class*="conversation-item-active--"]')) return undefined;
  const buyerLink = uniqueVisibleWithin(chat, 'a[href*="/personal"][href*="userId="]');
  const productLink = uniqueVisibleWithin(chat, 'a[href*="/item"][href*="id="]');
  const inbound = [...chat.querySelectorAll('[class*="message-text-left--"]')].filter(visible).at(-1);
  const inboundContext = await buildInboundContext(inbound?.textContent);
  const buyerAlias = normalizeVisibleText(buyerLink?.textContent, 80);
  const productTitle = normalizeVisibleText(productLink?.textContent, 160);
  const context = { ...inboundContext, buyerAlias, productTitle };
  return Object.values(context).some(Boolean) ? context : undefined;
}

async function buildInboundContext(value) {
  const normalized = normalizeInboundText(value);
  if (!normalized) return undefined;
  return {
    lastInboundText: normalized.slice(0, MAX_INBOUND_TEXT_LENGTH),
    lastInboundHash: await sha256Hex(normalized),
    lastInboundTruncated: normalized.length > MAX_INBOUND_TEXT_LENGTH ? "true" : "false",
    lastMessagePreview: normalized.slice(0, 280)
  };
}

function readInboundContextNow() {
  const declared = [...document.querySelectorAll("[data-jianzuo-last-inbound]")].filter(visible);
  let value;
  if (declared.length === 1) value = declared[0].textContent;
  else {
    const chat = uniqueVisible('[class*="chat-main--"]');
    if (!chat || !uniqueVisible('[class*="conversation-item-active--"]')) return undefined;
    value = [...chat.querySelectorAll('[class*="message-text-left--"]')].filter(visible).at(-1)?.textContent;
  }
  const normalized = normalizeInboundText(value);
  if (!normalized) return undefined;
  return {
    lastInboundText: normalized.slice(0, MAX_INBOUND_TEXT_LENGTH),
    lastInboundTruncated: normalized.length > MAX_INBOUND_TEXT_LENGTH ? "true" : "false"
  };
}

function normalizeInboundText(value) {
  if (typeof value !== "string") return "";
  return value.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function uniqueVisibleWithin(root, selector) {
  const candidates = [...root.querySelectorAll(selector)].filter(visible);
  return candidates.length === 1 ? candidates[0] : undefined;
}

function publicUrlQueryValue(element, expectedPath, key) {
  try {
    const url = new URL(element.getAttribute("href") || "", location.href);
    if (url.origin !== location.origin || url.pathname !== expectedPath || url.searchParams.getAll(key).length !== 1) return undefined;
    return normalizePublicId(url.searchParams.get(key));
  } catch { return undefined; }
}

function uniquePublicValue(attributeNames, queryKeys) {
  const values = [];
  const attributeValue = uniqueVisibleAttribute(attributeNames);
  if (attributeValue) values.push(attributeValue);
  let url;
  try { url = new URL(location.href); } catch { url = null; }
  for (const key of queryKeys) {
    for (const value of url?.searchParams.getAll(key) || []) {
      const normalized = normalizePublicId(value);
      if (normalized) values.push(normalized);
    }
  }
  const unique = [...new Set(values)];
  return unique.length === 1 ? unique[0] : undefined;
}

function uniqueVisibleAttribute(attributeNames) {
  const values = [];
  for (const attributeName of attributeNames) {
    for (const element of document.querySelectorAll(`[${attributeName}]`)) {
      if (!visible(element)) continue;
      const normalized = normalizePublicId(element.getAttribute(attributeName));
      if (normalized) values.push(normalized);
    }
  }
  const unique = [...new Set(values)];
  return unique.length === 1 ? unique[0] : undefined;
}

function normalizePublicId(value) {
  if (typeof value !== "string") return undefined;
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || normalized.length > 256 || /[\u0000-\u001f\u007f]/.test(normalized)) return undefined;
  return normalized;
}

function normalizeVisibleAmount(value) {
  if (typeof value !== "string") return undefined;
  const matched = value.normalize("NFKC").trim().replace(/,/g, "")
    .match(/^(?:¥|￥)?\s*(\d{1,12})(?:\.(\d{1,2}))?\s*(?:元|CNY)?$/i);
  if (!matched) return undefined;
  try {
    const yuan = BigInt(matched[1]);
    const cents = BigInt((matched[2] || "").padEnd(2, "0"));
    if (yuan * 100n + cents <= 0n) return undefined;
    return `${yuan}.${cents.toString().padStart(2, "0")}`;
  } catch { return undefined; }
}

function normalizeVisibleText(value, maxLength) {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.slice(0, maxLength);
}

function classifyPage() {
  const declared = document.querySelector("[data-jianzuo-page]")?.getAttribute("data-jianzuo-page");
  if (declared) return declared;
  const path = location.pathname.toLowerCase();
  const text = visibleText().slice(0, 10000);
  const signedIn = Boolean(readVisibleAccountIdentity());
  if (!signedIn && (hasVisibleLoginDialog() || /扫码登录|登录闲鱼|短信登录|密码登录/.test(text))) return "login";
  if (sellerOrdersFocused && path === "/personal") return "orders";
  if (path.startsWith("/publish") && document.querySelector('input[type="file"][accept*="image"]') && document.querySelector('[contenteditable="true"],textarea')) return "listing-create";
  if (path.startsWith("/im")) return "messages";
  if (/^\/(bought|sold|order)/.test(path)) return "orders";
  if (signedIn && path === "/") return "account-home";
  if (signedIn && path.startsWith("/personal")) return "account-profile";
  if (path.startsWith("/item")) return "item-detail";
  if (/发布闲置|发布商品|发闲置/.test(text) && (findByPlaceholder("标题") || document.querySelector('[contenteditable="true"]'))) return "listing-create";
  if (/消息|聊天/.test(text) && (findByPlaceholder("消息") || findByPlaceholder("回复"))) return "messages";
  if (/发货|交付|附件/.test(text)) return "delivery";
  if (/我卖出的|订单/.test(text)) return "orders";
  return "unknown";
}

function detectVerification() {
  if (document.querySelector("[data-verification-required]")) return true;
  return /滑块验证|安全验证|人脸验证|请输入验证码|请完成验证/.test(visibleText().slice(0, 12000));
}

async function execute(command) {
  const before = await inspect();
  if (before.verificationRequired) return { ...before, status: "needs_user", summary: "检测到平台验证，已停止所有动作" };
  if (command.observedAt) {
    const observedAt = Date.parse(command.observedAt);
    if (!Number.isFinite(observedAt) || Date.now() - observedAt > 45_000 || observedAt > Date.now() + 5_000) {
      return { ...before, status: "needs_user", summary: "动作绑定的页面心跳已过期，已停止动作" };
    }
  }
  if (command.expectedPageType && command.expectedPageType !== before.pageType) return { ...before, status: "needs_user", summary: "当前页面类型与审批目标不一致，已停止动作" };
  if (command.expectedAccountLabel && command.expectedAccountLabel !== before.accountLabel) return { ...before, status: "needs_user", summary: "当前可见账号与审批绑定账号不一致，已停止动作" };
  if (command.expectedAccountFingerprint && command.expectedAccountFingerprint !== before.accountFingerprint) return { ...before, status: "needs_user", summary: "当前账号公开资料指纹与审批记录不一致，已停止动作" };
  if (command.adapterVersion && command.adapterVersion !== before.adapterVersion) return { ...before, status: "needs_user", summary: "页面适配器版本与审批时不一致，已停止动作" };
  if (command.expectedPageUrl && command.expectedPageUrl !== before.pageUrl) return { ...before, status: "needs_user", summary: "当前页面地址与审批目标不一致，已停止动作" };
  if (command.preconditionFingerprint && !command.preconditionFingerprint.startsWith("pending-") && command.preconditionFingerprint !== before.domFingerprint) {
    return { ...before, status: "needs_user", summary: "页面结构与审批时不一致，已停止动作" };
  }
  if (command.actionType === "INSPECT_PAGE" || command.actionType === "READ_VISIBLE") return { ...before, status: "ok", summary: `已识别 ${before.pageType} 页面` };
  if (command.actionType === "FILL_LISTING") return fillListing(command.payload, before, command.commandId);
  if (command.actionType === "SUBMIT_LISTING") return submitListing(command.payload, before, command.commandId);
  if (command.actionType === "SEND_REPLY") return sendReply(command.payload, before, command.commandId);
  if (command.actionType === "ATTACH_DELIVERY") return sendDelivery(command.payload, before, command.commandId);
  return { ...before, status: "failed", summary: "连接助手不支持该动作" };
}

async function fillListing(payload, before, commandId) {
  if (before.pageType !== "listing-create") return { ...before, status: "needs_user", summary: "当前不是商品发布页" };
  const initialGuard = await requestWriteGuard(commandId); if (!initialGuard.ok) return { ...(await inspect()), status: "needs_user", summary: initialGuard.error || "写动作许可已失效" };
  const title = optionalUniqueElement('[data-jianzuo-field="title"]', () => findByPlaceholder("标题"));
  const description = uniqueElement('[data-jianzuo-field="description"]', () => findByPlaceholder("描述") || uniqueVisible('[contenteditable="true"]'), "详情输入框");
  const price = uniqueElement('[data-jianzuo-field="price"]', () => findLabeledInput(/^价格/) || findByPlaceholder("价格") || uniqueVisible('input[placeholder="0.00"]'), "价格输入框");
  const selectedTitle = payload.content?.selectedTitle || "";
  const body = payload.content?.description || "";
  const expectedDescription = title ? body : [selectedTitle, body].filter(Boolean).join("\n\n");
  if (title) setValue(title, selectedTitle);
  setValue(description, expectedDescription);
  setValue(price, String(payload.content?.priceTiers?.[0]?.price ?? ""));
  let imageInput = null;
  if (payload.imageFiles?.length) {
    const guard = await requestWriteGuard(commandId); if (!guard.ok) return { ...(await inspect()), status: "needs_user", summary: guard.error || "写动作许可已失效" };
    imageInput = document.querySelector('[data-jianzuo-field="images"],input[type="file"][accept*="image"]');
    if (!imageInput) return { ...before, status: "needs_user", summary: "没有找到唯一的图片上传入口" };
    const transfer = new DataTransfer();
    for (const item of payload.imageFiles) transfer.items.add(dataUrlToFile(item.dataUrl, item.name, item.type));
    imageInput.files = transfer.files;
    imageInput.dispatchEvent(new Event("change", { bubbles: true }));
  }
  const finalGuard = await requestWriteGuard(commandId); if (!finalGuard.ok) return { ...(await inspect()), status: "needs_user", summary: finalGuard.error || "写动作许可已失效" };
  await wait(250);
  const titleMatches = !title || normalizedFieldValue(title) === normalizedFieldValue(selectedTitle);
  const descriptionMatches = normalizedFieldValue(description) === normalizedFieldValue(expectedDescription);
  const expectedPrice = Number(payload.content?.priceTiers?.[0]?.price ?? NaN);
  const priceMatches = Number.isFinite(expectedPrice) && Number(readFieldValue(price)) === expectedPrice;
  const expectedImages = Number(payload.imageFiles?.length ?? 0);
  const visibleUploadedImages = document.querySelectorAll('[data-jianzuo-uploaded-image],.ant-upload-list-item,[class*="upload"] img').length;
  const imagesMatch = expectedImages === 0 || Number(imageInput?.files?.length ?? 0) === expectedImages || visibleUploadedImages >= expectedImages;
  if (!titleMatches || !descriptionMatches || !priceMatches || !imagesMatch) {
    return { ...(await inspect()), status: "needs_user", summary: "草稿写后校验未通过，已停止在人工检查前" };
  }
  const after = await inspect();
  return { ...after, status: "ok", summary: "草稿已填充，尚未点击发布" };
}

async function submitListing(_payload, before, commandId) {
  if (before.pageType !== "listing-create") return { ...before, status: "needs_user", summary: "当前不是商品发布页" };
  const initialButton = findActionButton('[data-jianzuo-action="publish"]', /确认发布|立即发布|发布/);
  if (!initialButton) return { ...(await inspect()), status: "needs_user", summary: "发布按钮不唯一或不存在" };
  const evidenceBefore = capturePublicationEvidence();
  const guard = await requestWriteGuard(commandId); if (!guard.ok) return { ...(await inspect()), status: "needs_user", summary: guard.error || "写动作许可已失效" };
  const finalPageCheck = validateSynchronousPageIdentity(before, ["listing-create"]);
  if (!finalPageCheck.ok) return { ...(await inspect()), status: "needs_user", summary: finalPageCheck.reason };
  const button = findActionButton('[data-jianzuo-action="publish"]', /确认发布|立即发布|发布/);
  if (!button || !button.isConnected) return { ...(await inspect()), status: "needs_user", summary: "最终确认时发布按钮已变化，已停止动作" };
  try {
    button.click();
    await wait(1000);
    const actionEvidence = verifyPublicationEvidence(evidenceBefore);
    const after = await inspect();
    return actionEvidence
      ? { ...after, status: "ok", summary: "商品发布成功", actionEvidence }
      : { ...after, status: "result_unknown", summary: "已点击发布，但缺少本次发布的动作级成功证据" };
  } catch (error) {
    return { ...before, status: "result_unknown", summary: `已尝试点击发布，但结果检查失败：${error.message}` };
  }
}

async function sendReply(payload, before, commandId) {
  if (before.pageType !== "messages") return { ...before, status: "needs_user", summary: "当前不是消息页面" };
  const expectedTarget = expectedVisibleTarget(payload);
  const initialTargetCheck = validateExpectedTarget(expectedTarget, before.visibleTarget, "message");
  if (!initialTargetCheck.ok) return { ...before, status: "needs_user", summary: initialTargetCheck.reason };
  const initialInboundCheck = validateInitialInbound(payload, before.visibleContext);
  if (!initialInboundCheck.ok) return { ...before, status: "needs_user", summary: initialInboundCheck.reason };
  const initialGuard = await requestWriteGuard(commandId); if (!initialGuard.ok) return { ...(await inspect()), status: "needs_user", summary: initialGuard.error || "写动作许可已失效" };
  const input = uniqueElement('[data-jianzuo-field="reply"]', () => findByPlaceholder("消息") || findByPlaceholder("回复"), "回复输入框");
  setValue(input, payload.body || "");
  const initialButton = findActionButton('[data-jianzuo-action="send-reply"]', /发送/)
    || uniqueVisible('[class*="sendbox--"] button');
  if (!initialButton) return { ...before, status: "needs_user", summary: "没有找到唯一的发送按钮" };
  const evidenceBefore = captureReplyEvidence(payload.body || "");
  const guard = await requestWriteGuard(commandId); if (!guard.ok) return { ...(await inspect()), status: "needs_user", summary: guard.error || "写动作许可已失效" };
  const finalPageCheck = validateSynchronousPageIdentity(before, ["messages"]);
  if (!finalPageCheck.ok) return { ...(await inspect()), status: "needs_user", summary: finalPageCheck.reason };
  const finalTargetCheck = validateExpectedTarget(expectedTarget, collectVisibleTargetIdentityNow("messages"), "message");
  if (!finalTargetCheck.ok) return { ...(await inspect()), status: "needs_user", summary: finalTargetCheck.reason };
  const finalInbound = readInboundContextNow();
  if (!finalInbound || finalInbound.lastInboundTruncated === "true" || finalInbound.lastInboundText !== initialInboundCheck.lastInboundText) {
    return { ...(await inspect()), status: "needs_user", summary: "买家在最终发送前更新了消息，旧回复已停止" };
  }
  const finalInput = uniqueElement('[data-jianzuo-field="reply"]', () => findByPlaceholder("消息") || findByPlaceholder("回复"), "回复输入框");
  const button = findActionButton('[data-jianzuo-action="send-reply"]', /发送/) || uniqueVisible('[class*="sendbox--"] button');
  if (!button || !button.isConnected || normalizedFieldValue(finalInput) !== normalizedFieldValue(payload.body || "")) {
    return { ...(await inspect()), status: "needs_user", summary: "最终发送前输入框或发送按钮已变化，已停止动作" };
  }
  try {
    button.click();
    await wait(700);
    const actionEvidence = verifyReplyEvidence(evidenceBefore, payload.body || "");
    const after = await inspect();
    return actionEvidence
      ? { ...after, status: "ok", summary: "回复已发送", actionEvidence }
      : { ...after, status: "result_unknown", summary: "已点击发送，但缺少本次回复的动作级成功证据" };
  } catch (error) {
    return { ...before, status: "result_unknown", summary: `已尝试点击发送，但结果检查失败：${error.message}` };
  }
}

async function sendDelivery(payload, before, commandId) {
  if (!["orders", "delivery"].includes(before.pageType)) return { ...before, status: "needs_user", summary: "当前不是订单或交付页面" };
  const expectedTarget = expectedVisibleTarget(payload);
  const initialTargetCheck = validateExpectedTarget(expectedTarget, before.visibleTarget, "order");
  if (!initialTargetCheck.ok) return { ...before, status: "needs_user", summary: initialTargetCheck.reason };
  const initialGuard = await requestWriteGuard(commandId); if (!initialGuard.ok) return { ...(await inspect()), status: "needs_user", summary: initialGuard.error || "写动作许可已失效" };
  const input = document.querySelector('[data-jianzuo-field="delivery-file"],input[type="file"]');
  const file = payload.attachmentFiles?.[0];
  if (!file && !payload.shareUrl) return { ...before, status: "needs_user", summary: "交付附件或分享链接尚未准备好" };
  if (file) {
    if (!input) return { ...before, status: "needs_user", summary: "没有找到唯一的交付附件入口" };
    const transfer = new DataTransfer(); transfer.items.add(dataUrlToFile(file.dataUrl, file.name, file.type)); input.files = transfer.files; input.dispatchEvent(new Event("change", { bubbles: true }));
  }
  const messageInput = document.querySelector('[data-jianzuo-field="delivery-message"],textarea[placeholder*="说明"]');
  const expectedDeliveryMessage = [payload.deliveryMessage, payload.shareUrl].filter(Boolean).join("\n");
  if (messageInput) setValue(messageInput, expectedDeliveryMessage);
  const initialButton = findActionButton('[data-jianzuo-action="send-delivery"]', /确认发送|发货|交付/); if (!initialButton) return { ...before, status: "needs_user", summary: "没有找到唯一的交付按钮" };
  const evidenceBefore = captureDeliveryEvidence(expectedTarget);
  const guard = await requestWriteGuard(commandId); if (!guard.ok) return { ...(await inspect()), status: "needs_user", summary: guard.error || "写动作许可已失效" };
  const finalPageCheck = validateSynchronousPageIdentity(before, ["orders", "delivery"]);
  if (!finalPageCheck.ok) return { ...(await inspect()), status: "needs_user", summary: finalPageCheck.reason };
  const finalTargetCheck = validateExpectedTarget(expectedTarget, collectVisibleTargetIdentityNow(before.pageType), "order");
  if (!finalTargetCheck.ok) return { ...(await inspect()), status: "needs_user", summary: finalTargetCheck.reason };
  const finalFileInput = document.querySelector('[data-jianzuo-field="delivery-file"],input[type="file"]');
  const finalMessageInput = document.querySelector('[data-jianzuo-field="delivery-message"],textarea[placeholder*="说明"]');
  const button = findActionButton('[data-jianzuo-action="send-delivery"]', /确认发送|发货|交付/);
  const fileStillReady = !file || Number(finalFileInput?.files?.length || 0) === 1;
  const messageStillReady = !finalMessageInput || normalizedFieldValue(finalMessageInput) === normalizedFieldValue(expectedDeliveryMessage);
  if (!button || !button.isConnected || !fileStillReady || !messageStillReady) {
    return { ...(await inspect()), status: "needs_user", summary: "最终交付前附件、说明或交付按钮已变化，已停止动作" };
  }
  try {
    button.click(); await wait(900);
    const actionEvidence = verifyDeliveryEvidence(evidenceBefore, expectedTarget);
    const after = await inspect();
    return actionEvidence
      ? { ...after, status: "ok", summary: "交付已发送", actionEvidence }
      : { ...after, status: "result_unknown", summary: "已点击交付，但缺少本次交付的动作级成功证据" };
  } catch (error) {
    return { ...before, status: "result_unknown", summary: `已尝试点击交付，但结果检查失败：${error.message}` };
  }
}

function expectedVisibleTarget(payload) {
  if (payload?.expectedVisibleTarget && typeof payload.expectedVisibleTarget === "object") return payload.expectedVisibleTarget;
  if (payload?.platformTargetBinding?.target && typeof payload.platformTargetBinding.target === "object") return payload.platformTargetBinding.target;
  return undefined;
}

function validateExpectedTarget(expected, observed, targetType) {
  if (!expected || expected.targetType !== targetType) return { ok: false, reason: "命令缺少已批准的具体会话或订单目标" };
  if (!observed || observed.targetType !== targetType) return { ok: false, reason: "当前页面没有唯一可见的具体会话或订单目标" };
  const keys = targetType === "message"
    ? ["buyerPublicId", "productId"]
    : ["conversationId", "buyerPublicId", "productId", "orderId", "amount", "currency"];
  if (observed.conversationId) keys.push("conversationId");
  const mismatch = [...new Set(keys)].find((key) => String(expected[key] || "") !== String(observed[key] || ""));
  return mismatch
    ? { ok: false, reason: `当前可见目标的 ${mismatch} 与已批准目标不一致，已停止动作` }
    : { ok: true };
}

function validateInitialInbound(payload, context) {
  if (!context?.lastInboundText || !context.lastInboundHash) return { ok: false, reason: "当前会话缺少可核对的最新买家消息" };
  if (context.lastInboundTruncated === "true") return { ok: false, reason: "最新买家消息超过安全处理上限，必须转人工" };
  const expectedHash = String(payload?.latestInboundHash || payload?.latestInboundMessageHash || "").toLowerCase();
  const expectedText = normalizeInboundText(payload?.buyerMessage);
  if (!/^[a-f0-9]{64}$/.test(expectedHash) || !expectedText) return { ok: false, reason: "命令缺少最新买家消息正文或完整摘要" };
  if (expectedHash !== context.lastInboundHash || expectedText !== context.lastInboundText) {
    return { ok: false, reason: "当前最新买家消息与回复草稿绑定不一致，已停止发送" };
  }
  return { ok: true, lastInboundText: context.lastInboundText };
}

function collectVisibleTargetIdentityNow(pageType) {
  const conversationId = uniquePublicValue(["data-jianzuo-conversation-id", "data-conversation-id", "data-chat-id"], ["conversationId", "conversation_id", "chatId", "chat_id"]);
  const buyerPublicId = uniquePublicValue(["data-jianzuo-buyer-public-id", "data-buyer-public-id", "data-buyer-id"], ["buyerPublicId", "buyer_public_id", "buyerId", "buyer_id"]);
  const productId = uniquePublicValue(["data-jianzuo-product-id", "data-product-id", "data-item-id"], ["productId", "product_id", "itemId", "item_id"]);
  if (pageType === "messages") {
    if (conversationId && buyerPublicId && productId) return { targetType: "message", conversationId, buyerPublicId, productId };
    const chat = uniqueVisible('[class*="chat-main--"]');
    if (!chat || !uniqueVisible('[class*="conversation-item-active--"]')) return undefined;
    const buyerLink = uniqueVisibleWithin(chat, 'a[href*="/personal"][href*="userId="]');
    const productLink = uniqueVisibleWithin(chat, 'a[href*="/item"][href*="id="]');
    const visibleBuyer = buyerLink ? publicUrlQueryValue(buyerLink, "/personal", "userId") : undefined;
    const visibleProduct = productLink ? publicUrlQueryValue(productLink, "/item", "id") : undefined;
    return visibleBuyer && visibleProduct ? { targetType: "message", buyerPublicId: visibleBuyer, productId: visibleProduct } : undefined;
  }
  if (!["orders", "delivery"].includes(pageType) || !conversationId || !buyerPublicId || !productId) return undefined;
  const orderId = uniquePublicValue(["data-jianzuo-order-id", "data-order-id"], ["orderId", "order_id"]);
  const amount = normalizeVisibleAmount(uniqueVisibleAttribute(["data-jianzuo-order-amount", "data-order-amount"]));
  const currency = uniqueVisibleAttribute(["data-jianzuo-order-currency", "data-order-currency"]);
  return orderId && amount && currency === "CNY" ? { targetType: "order", conversationId, buyerPublicId, productId, orderId, amount, currency } : undefined;
}

function validateSynchronousPageIdentity(before, expectedPageTypes) {
  if (detectVerification()) return { ok: false, reason: "检测到平台验证，已停止所有动作" };
  const pageType = classifyPage();
  if (!expectedPageTypes.includes(pageType)) return { ok: false, reason: "最终点击前页面类型已变化，已停止动作" };
  if (`${location.origin}${location.pathname}` !== before.pageUrl) return { ok: false, reason: "最终点击前页面地址已变化，已停止动作" };
  if (readVisibleAccountLabel() !== before.accountLabel) return { ok: false, reason: "最终点击前当前账号已变化，已停止动作" };
  return { ok: true };
}

function visibleActionMarkerCount(kind) {
  return [...document.querySelectorAll(`[data-jianzuo-result="${kind}"]`)].filter(visible).length;
}

function capturePublicationEvidence() {
  return { markerCount: visibleActionMarkerCount("published"), href: location.href };
}

function verifyPublicationEvidence(before) {
  if (visibleActionMarkerCount("published") > before.markerCount) return { kind: "new-publication-result-marker" };
  try {
    const url = new URL(location.href);
    if (location.href !== before.href && url.pathname === "/item" && url.searchParams.getAll("id").length === 1 && normalizePublicId(url.searchParams.get("id"))) {
      return { kind: "new-item-navigation", externalItemId: normalizePublicId(url.searchParams.get("id")) };
    }
  } catch { /* invalid navigation is not success evidence */ }
  return undefined;
}

function matchingOutboundMessageCount(body) {
  const expected = normalizeInboundText(body);
  if (!expected) return 0;
  const selectors = ["[data-jianzuo-outbound]", '[data-jianzuo-message-direction="outbound"]', '[class*="message-text-right--"]'];
  return [...new Set(selectors.flatMap((selector) => [...document.querySelectorAll(selector)]))]
    .filter(visible)
    .filter((element) => normalizeInboundText(element.textContent) === expected).length;
}

function captureReplyEvidence(body) {
  return { markerCount: visibleActionMarkerCount("reply-sent"), matchingOutboundCount: matchingOutboundMessageCount(body) };
}

function verifyReplyEvidence(before, body) {
  if (visibleActionMarkerCount("reply-sent") > before.markerCount) return { kind: "new-reply-result-marker" };
  if (matchingOutboundMessageCount(body) > before.matchingOutboundCount) return { kind: "new-matching-outbound-message" };
  return undefined;
}

function captureDeliveryEvidence(expectedTarget) {
  return { markerCount: visibleActionMarkerCount("delivery-sent"), orderId: String(expectedTarget?.orderId || "") };
}

function verifyDeliveryEvidence(before, expectedTarget) {
  if (String(expectedTarget?.orderId || "") !== before.orderId) return undefined;
  if (visibleActionMarkerCount("delivery-sent") > before.markerCount) return { kind: "new-delivery-result-marker", orderId: before.orderId };
  const orderRoot = [...document.querySelectorAll(`[data-jianzuo-order-id="${cssEscape(before.orderId)}"], [data-order-id="${cssEscape(before.orderId)}"]`)].filter(visible);
  const scopedState = orderRoot.length === 1
    ? [...orderRoot[0].querySelectorAll('[data-jianzuo-delivery-status="sent"]')].filter(visible)
    : [];
  return scopedState.length === 1 ? { kind: "order-scoped-delivery-status", orderId: before.orderId } : undefined;
}

function cssEscape(value) {
  return globalThis.CSS?.escape ? globalThis.CSS.escape(value) : value.replace(/[^A-Za-z0-9_-]/g, "\\$&");
}

function uniqueElement(selector, fallback, label) { const direct = [...document.querySelectorAll(selector)].filter(visible); if (direct.length === 1) return direct[0]; const element = fallback(); if (element) return element; throw new Error(`${label}不存在或不唯一`); }
function optionalUniqueElement(selector, fallback) { const direct = [...document.querySelectorAll(selector)].filter(visible); if (direct.length === 1) return direct[0]; return fallback(); }
function uniqueVisible(selector) { const items = [...document.querySelectorAll(selector)].filter(visible); return items.length === 1 ? items[0] : null; }
function findByPlaceholder(text) { const items = [...document.querySelectorAll("input,textarea")].filter((item) => visible(item) && (item.placeholder || "").includes(text)); return items.length === 1 ? items[0] : null; }
function findLabeledInput(pattern) { const items = [...document.querySelectorAll("input")].filter(visible).filter((input) => { let node = input.parentElement; for (let depth=0; node && depth<6; depth+=1,node=node.parentElement) { const labelText=(node.innerText||"").trim().replace(/\s+/g," "); if (pattern.test(labelText) && labelText.length < 40) return true; } return false; }); return items.length === 1 ? items[0] : null; }
function findButton(pattern) { const items = [...document.querySelectorAll("button,[role=button]")].filter((item) => visible(item) && pattern.test((item.textContent || "").trim())); return items.length === 1 ? items[0] : null; }
function findActionButton(selector, pattern) { const calibrated = [...document.querySelectorAll(selector)].filter(visible); return calibrated.length === 1 ? calibrated[0] : findButton(pattern); }
function visible(element) { const style = getComputedStyle(element); const rect = element.getBoundingClientRect(); return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0; }
function visibleText() { return document.body?.innerText || ""; }
function setValue(element, value) {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }
  if (element.getAttribute("contenteditable") === "true") {
    element.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection?.removeAllRanges(); selection?.addRange(range);
    const inserted = document.execCommand?.("insertText", false, value);
    if (!inserted) {
      element.textContent = value;
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    }
    element.dispatchEvent(new Event("change", { bubbles: true }));
    selection?.removeAllRanges();
    return;
  }
  throw new Error("不支持的表单字段类型");
}
function readFieldValue(element) { return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : element instanceof HTMLElement ? element.innerText : element.textContent || ""; }
function normalizedFieldValue(elementOrValue) { const value = typeof elementOrValue === "string" ? elementOrValue : readFieldValue(elementOrValue); return value.replace(/\s+/g, " ").trim(); }
function dataUrlToFile(dataUrl, name, type) { const bytes = atob(dataUrl.split(",")[1]); const array = new Uint8Array(bytes.length); for (let i=0;i<bytes.length;i+=1) array[i]=bytes.charCodeAt(i); return new File([array], name, { type }); }
function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function requestWriteGuard(commandId) { try { return await chrome.runtime.sendMessage({ type: "write_guard", commandId }); } catch (error) { return { ok: false, error: error.message || "无法确认写动作许可" }; } }
async function fingerprint() { const clone = document.body?.cloneNode(true); clone?.querySelectorAll("script,style,[data-private]").forEach((item) => item.remove()); const normalized = (clone?.textContent || "").replace(/\s+/g," ").trim().slice(0,20000) + [...document.querySelectorAll("input,textarea,button")].map((item) => `${item.tagName}:${item.getAttribute("placeholder") || ""}:${(item.textContent || "").trim()}`).join("|"); const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized)); return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2,"0")).join(""); }

void openLoginQrIfRequested();
void openSellerOrdersIfRequested();
installWorkbenchPairingBridge();
