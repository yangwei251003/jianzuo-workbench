import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const CONTENT_SCRIPT = resolve(process.cwd(), "apps/extension/content.js");
const CONTENT_SCRIPT_SOURCE = readFileSync(CONTENT_SCRIPT, "utf8");
const BACKGROUND_SCRIPT_SOURCE = readFileSync(resolve(process.cwd(), "apps/extension/background.js"), "utf8");

type AdapterResult = {
  pageType: string;
  domFingerprint: string;
  verificationRequired: boolean;
  status?: "ok" | "needs_user" | "failed" | "result_unknown";
  summary?: string;
  accountLabel?: string;
  accountFingerprint?: string;
  accountIdentitySource?: "explicit-account-marker" | "page-header";
  accountBindingEligible?: boolean;
  actionEvidence?: Record<string, string>;
  visibleTarget?: Record<string, string>;
  visibleContext?: {
    lastInboundText?: string;
    lastInboundHash?: string;
    lastInboundTruncated?: "true" | "false";
    lastMessagePreview?: string;
    buyerAlias?: string;
    productTitle?: string;
  };
};

type WriteGuardResponse = { ok: true } | { ok: false; error: string };

async function openMockWithAdapter(
  page: Page,
  writeGuardResponse: WriteGuardResponse = { ok: true },
  initialPath = "/mock/"
) {
  const guardResponse = JSON.stringify(writeGuardResponse);
  await page.addInitScript({
    content: `
      (() => {
        const browser = globalThis;
        const chromeApi = browser.chrome || {};
        const configuredGuardResponse = ${guardResponse};
        browser.__JIANZUO_EXTENSION_TEST__ = { workbenchOrigin: "http://127.0.0.1:8790" };
        browser.__jianzuoWriteGuardCalls = [];
        Object.defineProperty(chromeApi, "runtime", {
          configurable: true,
          value: {
            sendMessage(message) {
              browser.__jianzuoWriteGuardCalls.push(message);
              if (message && message.type === "pair") return Promise.resolve({ ok: true });
              if (message && message.type === "write_guard") {
                const hook = browser.__jianzuoOnWriteGuard;
                return Promise.resolve(typeof hook === "function" ? hook(message, browser.__jianzuoWriteGuardCalls.length) : configuredGuardResponse);
              }
              return Promise.resolve({ ok: false, error: "测试桩不支持该消息" });
            },
            onMessage: {
              addListener(listener) { browser.__jianzuoOnMessage = listener; }
            }
          }
        });
        if (!browser.chrome) {
          Object.defineProperty(browser, "chrome", { configurable: true, value: chromeApi });
        }
      })();
      ${CONTENT_SCRIPT_SOURCE}
    `
  });

  await page.goto(initialPath);
  await page.waitForFunction(() => typeof (globalThis as { __jianzuoOnMessage?: unknown }).__jianzuoOnMessage === "function");
}

async function sendAdapterMessage<T>(page: Page, message: unknown): Promise<T> {
  return page.evaluate((payload) => new Promise<T>((resolveMessage, rejectMessage) => {
    const browser = globalThis as typeof globalThis & {
      __jianzuoOnMessage?: (
        message: unknown,
        sender: unknown,
        sendResponse: (response: T) => void
      ) => boolean | void;
    };
    const listener = browser.__jianzuoOnMessage;
    if (!listener) {
      rejectMessage(new Error("扩展内容脚本没有注册消息监听器"));
      return;
    }

    const timer = setTimeout(() => rejectMessage(new Error("扩展内容脚本没有在限定时间内回执")), 5_000);
    const handledAsynchronously = listener(payload, {}, (response) => {
      clearTimeout(timer);
      resolveMessage(response);
    });
    if (handledAsynchronously !== true) {
      clearTimeout(timer);
      rejectMessage(new Error("扩展内容脚本未声明异步回执"));
    }
  }), message);
}

async function inspect(page: Page) {
  return sendAdapterMessage<AdapterResult>(page, { type: "inspect" });
}

function expectedInboundContext(text: string) {
  const normalized = text.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  return {
    lastInboundText: normalized.slice(0, 20_000),
    lastInboundHash: createHash("sha256").update(normalized).digest("hex"),
    lastInboundTruncated: normalized.length > 20_000 ? "true" as const : "false" as const,
    lastMessagePreview: normalized.slice(0, 280)
  };
}

async function enterListingPage(page: Page) {
  await page.getByRole("button", { name: "模拟扫码成功" }).click();
  await expect(page.locator('[data-jianzuo-page="listing-create"]')).toBeVisible();
}

test("识别模拟站登录、发布、消息、订单和交付页面", async ({ page }) => {
  await openMockWithAdapter(page);

  const login = await inspect(page);
  expect(login).toMatchObject({ pageType: "login", verificationRequired: false });
  expect(login.domFingerprint).toMatch(/^[a-f0-9]{64}$/);

  await enterListingPage(page);
  const pages = [
    ["发布商品", "listing-create"],
    ["消息", "messages"],
    ["订单", "orders"],
    ["交付", "delivery"]
  ] as const;

  for (const [buttonName, expectedPageType] of pages) {
    await page.getByRole("button", { name: buttonName, exact: true }).click();
    await expect(page.locator(`[data-jianzuo-page="${expectedPageType}"]`)).toBeVisible();
    await expect.poll(async () => (await inspect(page)).pageType).toBe(expectedPageType);
  }
});

test("本地工作台配对桥只转发合法一次性配对码", async ({ page }) => {
  await openMockWithAdapter(page);
  const result = await page.evaluate(() => new Promise<Record<string, unknown>>((resolveResult) => {
    const requestId = "pairing-request-123";
    const listener = (event: MessageEvent) => {
      const message = event.data as Record<string, unknown>;
      if (message.source !== "jianzuo-extension" || message.type !== "pair-result" || message.requestId !== requestId) return;
      window.removeEventListener("message", listener);
      resolveResult(message);
    };
    window.addEventListener("message", listener);
    window.postMessage({ source: "jianzuo-workbench", type: "pair-extension", requestId, code: "123456" }, location.origin);
  }));
  expect(result).toMatchObject({ ok: true, requestId: "pairing-request-123" });
  const calls = await page.evaluate(() => (globalThis as { __jianzuoWriteGuardCalls?: unknown[] }).__jianzuoWriteGuardCalls ?? []);
  expect(calls).toContainEqual({ type: "pair", code: "123456" });

  const invalid = await page.evaluate(() => new Promise<Record<string, unknown>>((resolveResult) => {
    const requestId = "pairing-request-456";
    const listener = (event: MessageEvent) => {
      const message = event.data as Record<string, unknown>;
      if (message.source !== "jianzuo-extension" || message.type !== "pair-result" || message.requestId !== requestId) return;
      window.removeEventListener("message", listener);
      resolveResult(message);
    };
    window.addEventListener("message", listener);
    window.postMessage({ source: "jianzuo-workbench", type: "pair-extension", requestId, code: "12ab" }, location.origin);
  }));
  expect(invalid).toMatchObject({ ok: false, error: "配对码格式无效" });
  const callsAfterInvalid = await page.evaluate(() => (globalThis as { __jianzuoWriteGuardCalls?: unknown[] }).__jianzuoWriteGuardCalls ?? []);
  expect(callsAfterInvalid).toHaveLength(calls.length);
});

test("只从可见标记识别消息和订单目标，缺字段时失败关闭", async ({ page }) => {
  await openMockWithAdapter(page);
  await enterListingPage(page);

  await page.getByRole("button", { name: "消息", exact: true }).click();
  const message = await inspect(page);
  expect(message.visibleTarget).toEqual({
    targetType: "message",
    conversationId: "MOCK-CONV-001",
    buyerPublicId: "MOCK-BUYER-001",
    productId: "MOCK-PRODUCT-001"
  });
  expect(message.visibleContext).toEqual(expectedInboundContext("这张图里的字能换一下吗？今晚要。"));

  await page.locator("[data-jianzuo-conversation-id]").evaluate((element) => {
    const conflicting = document.createElement("span");
    conflicting.setAttribute("data-conversation-id", "ANOTHER-CONVERSATION");
    conflicting.textContent = "另一条可见会话";
    element.append(conflicting);
  });
  expect((await inspect(page)).visibleTarget).toBeUndefined();
  await page.locator('[data-conversation-id="ANOTHER-CONVERSATION"]').evaluate((element) => element.remove());

  await page.locator("[data-jianzuo-product-id]").evaluate((element) => element.removeAttribute("data-jianzuo-product-id"));
  expect((await inspect(page)).visibleTarget).toBeUndefined();

  await page.getByRole("button", { name: "订单", exact: true }).click();
  const order = await inspect(page);
  expect(order.visibleTarget).toEqual({
    targetType: "order",
    conversationId: "MOCK-CONV-001",
    buyerPublicId: "MOCK-BUYER-001",
    productId: "MOCK-PRODUCT-001",
    orderId: "MOCK-001",
    amount: "12.90",
    currency: "CNY"
  });

  await page.locator("[data-jianzuo-order-currency]").evaluate((element) => element.setAttribute("data-jianzuo-order-currency", "USD"));
  expect((await inspect(page)).visibleTarget).toBeUndefined();
});

test("真实消息页只用当前可见买家和商品公开链接生成稳定目标", async ({ page }) => {
  await openMockWithAdapter(page);
  await page.evaluate(() => {
    history.pushState({}, "", "/im");
    document.body.innerHTML = `
      <header><a href="/personal">当前卖家</a></header>
      <aside><div class="conversation-item--fixture conversation-item-active--fixture">已选会话</div></aside>
      <main class="chat-main--fixture">
        <div class="message-topbar--fixture"><a href="/personal?userId=PUBLIC-BUYER-88">测试买家</a></div>
        <a href="/item?id=PUBLIC-ITEM-24&categoryId=1">图片文字替换微调</a>
        <div class="message-row--fixture"><p class="message-text-left--fixture">请把标题里的旧字替换掉</p></div>
      </main>`;
  });

  const first = await inspect(page);
  expect(first).toMatchObject({ accountLabel: "当前卖家", accountIdentitySource: "page-header", accountBindingEligible: false });
  expect(first.visibleTarget).toMatchObject({
    targetType: "message",
    buyerPublicId: "PUBLIC-BUYER-88",
    productId: "PUBLIC-ITEM-24"
  });
  expect(first.visibleTarget?.conversationId).toMatch(/^visible-[a-f0-9]{64}$/);
  expect(first.visibleContext).toEqual({
    ...expectedInboundContext("请把标题里的旧字替换掉"),
    buyerAlias: "测试买家",
    productTitle: "图片文字替换微调"
  });
  expect((await inspect(page)).visibleTarget?.conversationId).toBe(first.visibleTarget?.conversationId);

  await page.locator("main").evaluate((element) => {
    const duplicate = document.createElement("a");
    duplicate.href = "/item?id=PUBLIC-ITEM-OTHER";
    duplicate.textContent = "另一个商品";
    element.append(duplicate);
  });
  expect((await inspect(page)).visibleTarget).toBeUndefined();
});

test("入站消息发送完整摘要并对超过二万字的正文标记截断", async ({ page }) => {
  await openMockWithAdapter(page);
  const longMessage = `材料说明${"甲".repeat(20_000)}`;
  await page.evaluate((message) => {
    history.pushState({}, "", "/im");
    document.body.innerHTML = `
      <header><a href="/personal">当前卖家</a></header>
      <aside><div class="conversation-item-active--fixture">已选会话</div></aside>
      <main class="chat-main--fixture">
        <a href="/personal?userId=BUYER-LONG">测试买家</a>
        <a href="/item?id=ITEM-LONG">测试商品</a>
        <p class="message-text-left--fixture"></p>
      </main>`;
    document.querySelector(".message-text-left--fixture")!.textContent = message;
  }, longMessage);

  const snapshot = await inspect(page);
  const context = snapshot.visibleContext!;
  expect(context).toEqual({
    ...expectedInboundContext(longMessage),
    buyerAlias: "测试买家",
    productTitle: "测试商品"
  });
  expect(context.lastInboundText).toHaveLength(20_000);
  expect(context.lastInboundTruncated).toBe("true");
  const blocked = await sendAdapterMessage<AdapterResult>(page, {
    type: "command",
    command: {
      commandId: "adapter-truncated-inbound-001",
      actionType: "SEND_REPLY",
      preconditionFingerprint: snapshot.domFingerprint,
      expectedPageType: "messages",
      payload: {
        body: "这条长消息必须人工处理。",
        buyerMessage: context.lastInboundText,
        latestInboundHash: context.lastInboundHash,
        expectedVisibleTarget: snapshot.visibleTarget
      }
    }
  });
  expect(blocked).toMatchObject({ status: "needs_user", summary: "最新买家消息超过安全处理上限，必须转人工" });
  expect(await page.evaluate(() => (globalThis as typeof globalThis & { __jianzuoWriteGuardCalls?: unknown[] }).__jianzuoWriteGuardCalls)).toEqual([]);
});

test("真实消息页的无文字发送按钮仍只在写闸门通过后发送", async ({ page }) => {
  await openMockWithAdapter(page, { ok: true });
  await page.evaluate(() => {
    history.pushState({}, "", "/im");
    document.body.innerHTML = `
      <header><a href="/personal">当前卖家</a></header>
      <aside><div class="conversation-item--fixture conversation-item-active--fixture">已选会话</div></aside>
      <main class="chat-main--fixture">
        <div class="message-topbar--fixture"><a href="/personal?userId=PUBLIC-BUYER-88">测试买家</a></div>
        <a href="/item?id=PUBLIC-ITEM-24">图片文字替换微调</a>
        <div class="message-row--fixture"><p class="message-text-left--fixture">请先告诉我需要哪些材料</p></div>
        <div class="sendbox--fixture"><textarea placeholder="请输入消息，按Enter键发送或点击发送按钮发送"></textarea><button type="button" aria-label=""></button></div>
      </main>`;
    (globalThis as typeof globalThis & { __realReplyClicks?: number }).__realReplyClicks = 0;
    const textarea = document.querySelector("textarea")!;
    document.querySelector("button")!.addEventListener("click", () => {
      (globalThis as typeof globalThis & { __realReplyClicks?: number }).__realReplyClicks = 1;
      const outgoing = document.createElement("p");
      outgoing.className = "message-text-right--fixture";
      outgoing.textContent = textarea.value;
      document.querySelector("main")!.append(outgoing);
      textarea.value = "";
    });
  });
  const snapshot = await inspect(page);
  const expectedReply = "请发原文件、替换文字和期望完成时间，我先确认范围。";
  const response = await sendAdapterMessage<AdapterResult>(page, {
    type: "command",
    command: {
      commandId: "adapter-real-reply-001",
      actionType: "SEND_REPLY",
      preconditionFingerprint: snapshot.domFingerprint,
      observedAt: new Date().toISOString(),
      expectedPageType: "messages",
      payload: {
        body: expectedReply,
        buyerMessage: snapshot.visibleContext!.lastInboundText,
        latestInboundMessageHash: snapshot.visibleContext!.lastInboundHash,
        expectedVisibleTarget: snapshot.visibleTarget
      }
    }
  });
  expect(response).toMatchObject({ status: "ok", summary: "回复已发送", actionEvidence: { kind: "new-matching-outbound-message" } });
  expect(await page.evaluate(() => (globalThis as typeof globalThis & { __realReplyClicks?: number }).__realReplyClicks)).toBe(1);
  expect(await page.evaluate(() => (globalThis as typeof globalThis & { __jianzuoWriteGuardCalls?: unknown[] }).__jianzuoWriteGuardCalls)).toEqual([
    { type: "write_guard", commandId: "adapter-real-reply-001" },
    { type: "write_guard", commandId: "adapter-real-reply-001" }
  ]);
});

test("最终写闸门期间切换会话目标时不点击发送", async ({ page }) => {
  await openMockWithAdapter(page, { ok: true });
  await page.evaluate(() => {
    history.pushState({}, "", "/im");
    document.body.innerHTML = `
      <header><a href="/personal">当前卖家</a></header>
      <aside><div class="conversation-item-active--fixture">已选会话</div></aside>
      <main class="chat-main--fixture">
        <a href="/personal?userId=BUYER-A">买家甲</a>
        <a id="current-product" href="/item?id=ITEM-A">商品甲</a>
        <p class="message-text-left--fixture">请确认材料</p>
        <div class="sendbox--fixture"><textarea placeholder="输入消息"></textarea><button type="button"></button></div>
      </main>`;
    (globalThis as typeof globalThis & { __blockedReplyClicks?: number; __jianzuoOnWriteGuard?: (_message: unknown, count: number) => { ok: true } }).__blockedReplyClicks = 0;
    document.querySelector("button")!.addEventListener("click", () => { (globalThis as typeof globalThis & { __blockedReplyClicks?: number }).__blockedReplyClicks = 1; });
    (globalThis as typeof globalThis & { __jianzuoOnWriteGuard?: (_message: unknown, count: number) => { ok: true } }).__jianzuoOnWriteGuard = (_message, count) => {
      if (count === 2) document.querySelector("#current-product")!.setAttribute("href", "/item?id=ITEM-B");
      return { ok: true };
    };
  });
  const snapshot = await inspect(page);
  const response = await sendAdapterMessage<AdapterResult>(page, {
    type: "command",
    command: {
      commandId: "adapter-target-drift-001",
      actionType: "SEND_REPLY",
      preconditionFingerprint: snapshot.domFingerprint,
      expectedPageType: "messages",
      payload: {
        body: "请发送原文件。",
        buyerMessage: snapshot.visibleContext!.lastInboundText,
        latestInboundMessageHash: snapshot.visibleContext!.lastInboundHash,
        expectedVisibleTarget: snapshot.visibleTarget
      }
    }
  });
  expect(response.status).toBe("needs_user");
  expect(response.summary).toContain("productId");
  expect(await page.evaluate(() => (globalThis as typeof globalThis & { __blockedReplyClicks?: number }).__blockedReplyClicks)).toBe(0);
});

test("最终写闸门期间买家追加消息时旧回复不发送", async ({ page }) => {
  await openMockWithAdapter(page, { ok: true });
  await page.evaluate(() => {
    history.pushState({}, "", "/im");
    document.body.innerHTML = `
      <header><a href="/personal">当前卖家</a></header>
      <aside><div class="conversation-item-active--fixture">已选会话</div></aside>
      <main class="chat-main--fixture">
        <a href="/personal?userId=BUYER-A">买家甲</a>
        <a href="/item?id=ITEM-A">商品甲</a>
        <p class="message-text-left--fixture">请确认材料</p>
        <div class="sendbox--fixture"><textarea placeholder="输入消息"></textarea><button type="button"></button></div>
      </main>`;
    (globalThis as typeof globalThis & { __blockedReplyClicks?: number; __jianzuoOnWriteGuard?: (_message: unknown, count: number) => { ok: true } }).__blockedReplyClicks = 0;
    document.querySelector("button")!.addEventListener("click", () => { (globalThis as typeof globalThis & { __blockedReplyClicks?: number }).__blockedReplyClicks = 1; });
    (globalThis as typeof globalThis & { __jianzuoOnWriteGuard?: (_message: unknown, count: number) => { ok: true } }).__jianzuoOnWriteGuard = (_message, count) => {
      if (count === 2) document.querySelector(".message-text-left--fixture")!.textContent = "请确认材料，我还要申请退款";
      return { ok: true };
    };
  });
  const snapshot = await inspect(page);
  const response = await sendAdapterMessage<AdapterResult>(page, {
    type: "command",
    command: {
      commandId: "adapter-inbound-drift-001",
      actionType: "SEND_REPLY",
      preconditionFingerprint: snapshot.domFingerprint,
      expectedPageType: "messages",
      payload: {
        body: "请发送原文件。",
        buyerMessage: snapshot.visibleContext!.lastInboundText,
        latestInboundMessageHash: snapshot.visibleContext!.lastInboundHash,
        expectedVisibleTarget: snapshot.visibleTarget
      }
    }
  });
  expect(response).toMatchObject({ status: "needs_user", summary: "买家在最终发送前更新了消息，旧回复已停止" });
  expect(await page.evaluate(() => (globalThis as typeof globalThis & { __blockedReplyClicks?: number }).__blockedReplyClicks)).toBe(0);
});

test("输入框清空但没有新增出站消息时返回结果未知", async ({ page }) => {
  await openMockWithAdapter(page, { ok: true });
  await page.evaluate(() => {
    history.pushState({}, "", "/im");
    document.body.innerHTML = `
      <header><a href="/personal">当前卖家</a></header>
      <aside><div class="conversation-item-active--fixture">已选会话</div></aside>
      <main class="chat-main--fixture">
        <a href="/personal?userId=BUYER-A">买家甲</a>
        <a href="/item?id=ITEM-A">商品甲</a>
        <p class="message-text-left--fixture">请确认材料</p>
        <div class="sendbox--fixture"><textarea placeholder="输入消息"></textarea><button type="button"></button></div>
      </main>`;
    const textarea = document.querySelector("textarea")!;
    document.querySelector("button")!.addEventListener("click", () => { textarea.value = ""; });
  });
  const snapshot = await inspect(page);
  const response = await sendAdapterMessage<AdapterResult>(page, {
    type: "command",
    command: {
      commandId: "adapter-weak-evidence-001",
      actionType: "SEND_REPLY",
      preconditionFingerprint: snapshot.domFingerprint,
      expectedPageType: "messages",
      payload: {
        body: "请发送原文件。",
        buyerMessage: snapshot.visibleContext!.lastInboundText,
        latestInboundMessageHash: snapshot.visibleContext!.lastInboundHash,
        expectedVisibleTarget: snapshot.visibleTarget
      }
    }
  });
  expect(response).toMatchObject({ status: "result_unknown", summary: "已点击发送，但缺少本次回复的动作级成功证据" });
});

test("后台为心跳和命令回执补齐页面绑定字段", async ({ page }) => {
  await openMockWithAdapter(page);
  await enterListingPage(page);
  await page.getByRole("button", { name: "消息", exact: true }).click();
  const inspection = await inspect(page);
  expect(inspection.accountFingerprint).toMatch(/^[a-f0-9]{64}$/);

  const receipt = await page.evaluate(({ source, visibleInspection }) => {
    const browser = globalThis as typeof globalThis & {
      __JIANZUO_EXTENSION_TEST__?: boolean;
      __jianzuoBackgroundTest?: {
        createTransportReceipt: (response: unknown, commandId: string, tab: { id: number; url: string }) => AdapterResult & { commandId: string; tabId: string; timestamp: string };
      };
      chrome?: unknown;
    };
    browser.__JIANZUO_EXTENSION_TEST__ = true;
    browser.chrome = {
      runtime: { onInstalled: { addListener() {} }, onStartup: { addListener() {} }, onMessage: { addListener() {} } },
      alarms: { create() {}, onAlarm: { addListener() {} } }
    };
    new Function(source)();
    return browser.__jianzuoBackgroundTest!.createTransportReceipt(
      { ...visibleInspection, pageUrl: "https://www.goofish.com/im" },
      "command-visible-target-001",
      { id: 321, url: "https://www.goofish.com/im" }
    );
  }, { source: BACKGROUND_SCRIPT_SOURCE, visibleInspection: inspection });

  expect(receipt).toMatchObject({ commandId: "command-visible-target-001", tabId: "321" });
  expect(receipt.visibleTarget).toMatchObject({
    targetType: "message",
    conversationId: "MOCK-CONV-001",
    buyerPublicId: "MOCK-BUYER-001",
    productId: "MOCK-PRODUCT-001",
    pageUrl: "https://www.goofish.com/im",
    tabId: "321",
    accountFingerprint: inspection.accountFingerprint,
    domFingerprint: inspection.domFingerprint,
    adapterVersion: "goofish-web-2026-08-31-v3"
  });
  expect(Date.parse(receipt.visibleTarget!.observedAt)).not.toBeNaN();
  expect(receipt.visibleContext).toEqual(expectedInboundContext("这张图里的字能换一下吗？今晚要。"));
});

test("后台脚本缺少周期心跳时会在加载后恢复三十秒闹钟", async ({ page }) => {
  await openMockWithAdapter(page);
  const created = await page.evaluate(async (source) => {
    const browser = globalThis as typeof globalThis & {
      __JIANZUO_EXTENSION_TEST__?: boolean;
      __jianzuoBackgroundTest?: { ensureHeartbeatAlarm: () => Promise<void> };
      chrome?: unknown;
    };
    const calls: Array<{ name: string; options: Record<string, unknown> }> = [];
    browser.__JIANZUO_EXTENSION_TEST__ = true;
    browser.chrome = {
      runtime: { onInstalled: { addListener() {} }, onStartup: { addListener() {} }, onMessage: { addListener() {} } },
      alarms: {
        get: async () => undefined,
        create: async (name: string, options: Record<string, unknown>) => { calls.push({ name, options }); },
        onAlarm: { addListener() {} }
      }
    };
    new Function(source)();
    await browser.__jianzuoBackgroundTest!.ensureHeartbeatAlarm();
    return calls;
  }, BACKGROUND_SCRIPT_SOURCE);

  expect(created).toEqual([{ name: "jianzuo-heartbeat", options: { periodInMinutes: 0.5 } }]);
});

test("发布页不显示昵称时使用同一专用 Profile 的可见账号证据", async ({ page }) => {
  await openMockWithAdapter(page);
  const selected = await page.evaluate(async (source) => {
    const browser = globalThis as typeof globalThis & {
      __JIANZUO_EXTENSION_TEST__?: boolean;
      __jianzuoBackgroundTest?: { managedHeartbeatTab: () => Promise<{ tab: { id: number }; inspection: Record<string, unknown> }> };
      chrome?: unknown;
    };
    const stored: Record<string, unknown> = {};
    const inspections: Record<number, Record<string, unknown>> = {
      11: { pageType: "listing-create", pageUrl: "https://www.goofish.com/publish", domFingerprint: "b".repeat(64) },
      12: {
        pageType: "account-home",
        pageUrl: "https://www.goofish.com/",
        accountLabel: "大淘气哈",
        accountFingerprint: "a".repeat(64),
        accountIdentitySource: "page-header",
        accountBindingEligible: true,
        domFingerprint: "c".repeat(64)
      }
    };
    const tabs = [
      { id: 11, url: "https://www.goofish.com/publish", active: true, windowId: 7 },
      { id: 12, url: "https://www.goofish.com/", active: false, windowId: 7 }
    ];
    browser.__JIANZUO_EXTENSION_TEST__ = true;
    browser.chrome = {
      runtime: {
        onInstalled: { addListener() {} }, onStartup: { addListener() {} }, onMessage: { addListener() {} },
        getManifest: () => ({ version: "0.1.0" })
      },
      alarms: { create() {}, onAlarm: { addListener() {} } },
      storage: { local: {
        get: async (keys: string[]) => Object.fromEntries(keys.filter((key) => key in stored).map((key) => [key, stored[key]])),
        set: async (value: Record<string, unknown>) => Object.assign(stored, value)
      } },
      tabs: {
        query: async (query: { active?: boolean }) => query.active ? [tabs[0]] : tabs,
        get: async (id: number) => tabs.find((tab) => tab.id === id),
        sendMessage: async (id: number) => inspections[id]
      }
    };
    new Function(source)();
    return browser.__jianzuoBackgroundTest!.managedHeartbeatTab();
  }, BACKGROUND_SCRIPT_SOURCE);

  expect(selected.tab.id).toBe(11);
  expect(selected.inspection).toMatchObject({
    pageType: "listing-create",
    pageUrl: "https://www.goofish.com/publish",
    accountLabel: "大淘气哈",
    accountFingerprint: "a".repeat(64),
    accountBindingEligible: false
  });
});

test("登录弹窗位于独立容器时仍识别为扫码登录页", async ({ page }) => {
  await openMockWithAdapter(page);
  await page.evaluate(() => {
    history.pushState({}, "", "/");
    document.body.innerHTML = '<main>闲鱼首页</main><section role="dialog" style="display:block;width:480px;height:360px"></section>';
  });

  await expect.poll(async () => (await inspect(page)).pageType).toBe("login");
});

test("个人主页即使导航含订单文字仍优先识别为账号资料页", async ({ page }) => {
  await openMockWithAdapter(page);
  await page.evaluate(() => {
    history.pushState({}, "", "/personal");
    document.body.innerHTML = '<header><a href="/personal" aria-label="测试账号"><img alt="测试账号" src="/avatar.png"></a></header><nav>我的闲鱼 我的交易 订单</nav><main>个人资料</main>';
  });

  await expect.poll(async () => (await inspect(page)).pageType).toBe("account-profile");
  expect(await inspect(page)).toMatchObject({ accountLabel: "测试账号", accountIdentitySource: "page-header", accountBindingEligible: true });
});

test("买家资料链接不冒充当前登录账号", async ({ page }) => {
  await openMockWithAdapter(page);
  await page.evaluate(() => {
    history.pushState({}, "", "/im");
    document.body.innerHTML = `
      <aside><div class="conversation-item-active--fixture">已选会话</div></aside>
      <main class="chat-main--fixture">
        <a href="/personal?userId=BUYER-ONLY">买家账号</a>
        <a href="/item?id=ITEM-1">测试商品</a>
        <p class="message-text-left--fixture">测试消息</p>
      </main>`;
  });

  const snapshot = await inspect(page);
  expect(snapshot.pageType).toBe("messages");
  expect(snapshot.accountLabel).toBeUndefined();
  expect(snapshot.accountFingerprint).toBeUndefined();
  expect(snapshot.accountBindingEligible).toBe(false);
});

test("聚焦订单只切换卖家侧我卖出的页签", async ({ page }) => {
  await openMockWithAdapter(page, { ok: true }, "/mock/?jianzuo_sold=1");
  await page.evaluate(() => {
    history.pushState({}, "", "/personal");
    document.body.innerHTML = `
      <header><a href="/personal" aria-label="测试账号"><img alt="测试账号" src="/avatar.png"></a></header>
      <nav><ul><li><span>我买到的</span></li><li id="sold-tab"><span>我卖出的</span></li></ul></nav>
      <main id="seller-orders">卖家订单区域</main>`;
    (globalThis as typeof globalThis & { __sellerOrderClicks?: number }).__sellerOrderClicks = 0;
    document.querySelector("#sold-tab")!.addEventListener("click", () => {
      (globalThis as typeof globalThis & { __sellerOrderClicks?: number }).__sellerOrderClicks = 1;
    });
  });

  await expect.poll(() => page.evaluate(() => (
    globalThis as typeof globalThis & { __sellerOrderClicks?: number }
  ).__sellerOrderClicks)).toBe(1);
  expect(new URL(page.url()).searchParams.has("jianzuo_sold")).toBe(false);
  await expect.poll(async () => (await inspect(page)).pageType).toBe("orders");
});

test("草稿填充与最终提交使用两个独立审批动作", async ({ page }) => {
  await openMockWithAdapter(page, { ok: true });
  await enterListingPage(page);
  const approvedSnapshot = await inspect(page);

  const result = await sendAdapterMessage<AdapterResult>(page, {
    type: "command",
    command: {
      commandId: "adapter-command-publish-001",
      actionId: "adapter-test-publish",
      actionType: "FILL_LISTING",
      targetId: "mock-product-001",
      risk: "medium",
      idempotencyKey: "adapter-test-publish-001",
      preconditionFingerprint: approvedSnapshot.domFingerprint,
      status: "APPROVED",
      payload: {
        content: {
          selectedTitle: "图片文字替换微调｜先看原图再报价",
          description: "发原图和要替换的文字。我先确认字体、位置和交付时间，范围清楚后再开始。",
          priceTiers: [{ name: "基础", price: 4.9 }]
        }
      }
    }
  });

  expect(result).toMatchObject({
    pageType: "listing-create",
    status: "ok",
    summary: "草稿已填充，尚未点击发布",
    verificationRequired: false
  });
  await expect(page.locator('[data-jianzuo-field="title"]')).toHaveValue("图片文字替换微调｜先看原图再报价");
  await expect(page.locator('[data-jianzuo-field="description"]')).toHaveValue(
    "发原图和要替换的文字。我先确认字体、位置和交付时间，范围清楚后再开始。"
  );
  await expect(page.locator('[data-jianzuo-field="price"]')).toHaveValue("4.9");
  await expect(page.locator('[data-jianzuo-result="published"]')).toHaveCount(0);

  const filledSnapshot = await inspect(page);
  const submitted = await sendAdapterMessage<AdapterResult>(page, {
    type: "command",
    command: {
      commandId: "adapter-command-submit-001",
      actionType: "SUBMIT_LISTING",
      preconditionFingerprint: filledSnapshot.domFingerprint,
      payload: {}
    }
  });
  expect(submitted).toMatchObject({ status: "ok", summary: "商品发布成功" });
  await expect(page.locator('[data-jianzuo-result="published"]')).toContainText("发布成功");
  expect(await page.evaluate(() => (
    globalThis as { __jianzuoWriteGuardCalls?: unknown[] }
  ).__jianzuoWriteGuardCalls)).toEqual([
    { type: "write_guard", commandId: "adapter-command-publish-001" },
    { type: "write_guard", commandId: "adapter-command-publish-001" },
    { type: "write_guard", commandId: "adapter-command-submit-001" }
  ]);
});

test("发布按钮被点击但没有本次发布证据时返回结果未知", async ({ page }) => {
  await openMockWithAdapter(page, { ok: true });
  await page.evaluate(() => {
    history.pushState({}, "", "/publish");
    document.body.innerHTML = `
      <header><a href="/personal">当前卖家</a></header>
      <main>
        <input type="file" accept="image/png" />
        <textarea placeholder="描述商品详情"></textarea>
        <button type="button">发布</button>
      </main>`;
    (globalThis as typeof globalThis & { __publishWithoutEvidenceClicks?: number }).__publishWithoutEvidenceClicks = 0;
    document.querySelector("button")!.addEventListener("click", () => { (globalThis as typeof globalThis & { __publishWithoutEvidenceClicks?: number }).__publishWithoutEvidenceClicks = 1; });
  });
  const snapshot = await inspect(page);
  const response = await sendAdapterMessage<AdapterResult>(page, {
    type: "command",
    command: {
      commandId: "adapter-publish-no-evidence-001",
      actionType: "SUBMIT_LISTING",
      preconditionFingerprint: snapshot.domFingerprint,
      expectedPageType: "listing-create",
      payload: {}
    }
  });
  expect(response).toMatchObject({ status: "result_unknown", summary: "已点击发布，但缺少本次发布的动作级成功证据" });
  expect(await page.evaluate(() => (globalThis as typeof globalThis & { __publishWithoutEvidenceClicks?: number }).__publishWithoutEvidenceClicks)).toBe(1);
});

test("交付只在当前订单出现新的动作级证据后确认成功", async ({ page }) => {
  await openMockWithAdapter(page, { ok: true });
  await enterListingPage(page);
  await page.getByRole("button", { name: "交付", exact: true }).click();
  const snapshot = await inspect(page);
  const response = await sendAdapterMessage<AdapterResult>(page, {
    type: "command",
    command: {
      commandId: "adapter-delivery-evidence-001",
      actionType: "ATTACH_DELIVERY",
      preconditionFingerprint: snapshot.domFingerprint,
      expectedPageType: "delivery",
      payload: {
        shareUrl: "https://pan.baidu.com/s/test-link",
        deliveryMessage: "请下载并核对 README。",
        expectedVisibleTarget: snapshot.visibleTarget
      }
    }
  });
  expect(response).toMatchObject({
    status: "ok",
    summary: "交付已发送",
    actionEvidence: { kind: "new-delivery-result-marker", orderId: "MOCK-001" }
  });
});

test("交付按钮被点击但订单没有新增交付证据时返回结果未知", async ({ page }) => {
  await openMockWithAdapter(page, { ok: true });
  await page.evaluate(() => {
    history.pushState({}, "", "/order-detail");
    document.body.innerHTML = `
      <header><a href="/personal">当前卖家</a></header>
      <section data-jianzuo-page="delivery" data-jianzuo-order-id="ORDER-1" data-jianzuo-conversation-id="CONV-1" data-jianzuo-buyer-public-id="BUYER-1" data-jianzuo-product-id="ITEM-1" data-jianzuo-order-amount="12.90" data-jianzuo-order-currency="CNY">
        <textarea data-jianzuo-field="delivery-message" placeholder="补充说明"></textarea>
        <button data-jianzuo-action="send-delivery" type="button">确认发送</button>
      </section>`;
  });
  const snapshot = await inspect(page);
  const response = await sendAdapterMessage<AdapterResult>(page, {
    type: "command",
    command: {
      commandId: "adapter-delivery-no-evidence-001",
      actionType: "ATTACH_DELIVERY",
      preconditionFingerprint: snapshot.domFingerprint,
      expectedPageType: "delivery",
      payload: {
        shareUrl: "https://pan.baidu.com/s/test-link",
        deliveryMessage: "请下载并核对 README。",
        expectedVisibleTarget: snapshot.visibleTarget
      }
    }
  });
  expect(response).toMatchObject({ status: "result_unknown", summary: "已点击交付，但缺少本次交付的动作级成功证据" });
});

test("识别当前真实发布页形态并只填写富文本草稿", async ({ page }) => {
  await openMockWithAdapter(page, { ok: true });
  await page.evaluate(() => {
    history.pushState({}, "", "/publish");
    document.body.innerHTML = `
      <header><a href="/personal">已登录账号</a></header>
      <main>
        <label>宝贝图片 *</label><input name="file" type="file" accept="image/png, image/jpg, image/jpeg, image/webp" />
        <label>宝贝描述 *</label><div contenteditable="true"></div>
        <div class="ant-form-item"><label>价格 *</label><input type="text" placeholder="0.00" /></div>
        <div class="ant-form-item"><label>原价</label><input type="text" placeholder="0.00" /></div>
        <div class="ant-form-item"><label>邮费 *</label><input type="text" placeholder="0.00" /></div>
        <button type="button">发布</button>
      </main>`;
    (globalThis as typeof globalThis & { __realPublishClicks?: number }).__realPublishClicks = 0;
    document.querySelector("button")?.addEventListener("click", () => {
      (globalThis as typeof globalThis & { __realPublishClicks?: number }).__realPublishClicks = 1;
    });
  });
  const snapshot = await inspect(page);
  expect(snapshot.pageType).toBe("listing-create");

  const result = await sendAdapterMessage<AdapterResult>(page, {
    type: "command",
    command: {
      commandId: "adapter-real-shape-fill-001",
      actionType: "FILL_LISTING",
      preconditionFingerprint: snapshot.domFingerprint,
      payload: { content: { selectedTitle: "图片文字替换微调", description: "发原图和替换文字，先确认范围。", priceTiers: [{ price: 4.9 }] } }
    }
  });

  expect(result).toMatchObject({ status: "ok", summary: "草稿已填充，尚未点击发布" });
  await expect(page.locator('[contenteditable="true"]')).toContainText("图片文字替换微调");
  await expect(page.locator('[contenteditable="true"]')).toContainText("发原图和替换文字，先确认范围。");
  await expect(page.locator('.ant-form-item').first().locator("input")).toHaveValue("4.9");
  expect(await page.evaluate(() => (globalThis as typeof globalThis & { __realPublishClicks?: number }).__realPublishClicks)).toBe(0);
});

test("账号不一致或页面心跳过期时在写入前停止", async ({ page }) => {
  await openMockWithAdapter(page, { ok: true });
  await enterListingPage(page);
  const snapshot = await inspect(page);
  const baseCommand = {
    commandId: "adapter-account-binding-001",
    actionType: "FILL_LISTING",
    preconditionFingerprint: snapshot.domFingerprint,
    expectedPageType: "listing-create",
    payload: { content: { selectedTitle: "不得写入", description: "绑定失效", priceTiers: [{ price: 4.9 }] } }
  };

  const mismatch = await sendAdapterMessage<AdapterResult>(page, {
    type: "command", command: { ...baseCommand, expectedAccountLabel: "已确认的另一个账号", observedAt: new Date().toISOString() }
  });
  expect(mismatch).toMatchObject({ status: "needs_user", summary: "当前可见账号与审批绑定账号不一致，已停止动作" });
  await expect(page.locator('[data-jianzuo-field="title"]')).toHaveValue("");
  await expect(page.locator('[data-jianzuo-field="description"]')).toHaveValue("");

  const stale = await sendAdapterMessage<AdapterResult>(page, {
    type: "command", command: { ...baseCommand, commandId: "adapter-stale-binding-001", observedAt: new Date(Date.now() - 46_000).toISOString() }
  });
  expect(stale).toMatchObject({ status: "needs_user", summary: "动作绑定的页面心跳已过期，已停止动作" });
  await expect(page.locator('[data-jianzuo-field="price"]')).toHaveValue("");
});

test("出现平台验证时在任何表单写入或发布点击前关闭失败", async ({ page }) => {
  await openMockWithAdapter(page, { ok: false, error: "写动作许可已撤回" });
  await enterListingPage(page);
  const approvedSnapshot = await inspect(page);

  await page.getByRole("checkbox", { name: "模拟验证" }).check();
  await expect(page.locator("[data-verification-required]")).toBeVisible();
  await page.evaluate(() => {
    const browser = globalThis as typeof globalThis & { __jianzuoWriteAttempts?: number };
    browser.__jianzuoWriteAttempts = 0;
    const recordWrite = () => { browser.__jianzuoWriteAttempts = (browser.__jianzuoWriteAttempts ?? 0) + 1; };
    for (const element of document.querySelectorAll(
      '[data-jianzuo-field="title"],[data-jianzuo-field="description"],[data-jianzuo-field="price"],[data-jianzuo-action="publish"]'
    )) {
      element.addEventListener("input", recordWrite, true);
      element.addEventListener("change", recordWrite, true);
      element.addEventListener("click", recordWrite, true);
    }
  });

  const result = await sendAdapterMessage<AdapterResult>(page, {
    type: "command",
    command: {
      commandId: "adapter-command-verification-001",
      actionId: "adapter-test-blocked-publish",
      actionType: "FILL_LISTING",
      targetId: "mock-product-002",
      risk: "medium",
      idempotencyKey: "adapter-test-blocked-publish-001",
      preconditionFingerprint: approvedSnapshot.domFingerprint,
      status: "APPROVED",
      payload: {
        content: {
          selectedTitle: "这段内容不得写入页面",
          description: "验证期间不得修改表单。",
          priceTiers: [{ name: "基础", price: 4.9 }]
        }
      }
    }
  });

  expect(result).toMatchObject({
    pageType: "listing-create",
    status: "needs_user",
    verificationRequired: true,
    summary: "检测到平台验证，已停止所有动作"
  });
  expect(await page.evaluate(() => (globalThis as { __jianzuoWriteAttempts?: number }).__jianzuoWriteAttempts)).toBe(0);
  await expect(page.locator('[data-jianzuo-field="title"]')).toHaveValue("");
  await expect(page.locator('[data-jianzuo-field="description"]')).toHaveValue("");
  await expect(page.locator('[data-jianzuo-field="price"]')).toHaveValue("");
  await expect(page.locator('[data-jianzuo-result="published"]')).toHaveCount(0);
  expect(await page.evaluate(() => (
    globalThis as { __jianzuoWriteGuardCalls?: unknown[] }
  ).__jianzuoWriteGuardCalls)).toEqual([]);
});

test("后台写闸门拒绝时不点击发布", async ({ page }) => {
  await openMockWithAdapter(page, { ok: false, error: "写动作许可已撤回" });
  await enterListingPage(page);
  const approvedSnapshot = await inspect(page);
  await page.evaluate(() => {
    const browser = globalThis as typeof globalThis & { __jianzuoPublishClicks?: number };
    browser.__jianzuoPublishClicks = 0;
    document.querySelector('[data-jianzuo-action="publish"]')?.addEventListener("click", () => {
      browser.__jianzuoPublishClicks = (browser.__jianzuoPublishClicks ?? 0) + 1;
    }, true);
  });

  const result = await sendAdapterMessage<AdapterResult>(page, {
    type: "command",
    command: {
      commandId: "adapter-command-revoked-001",
      actionId: "adapter-test-revoked-publish",
      actionType: "FILL_LISTING",
      targetId: "mock-product-003",
      risk: "medium",
      idempotencyKey: "adapter-test-revoked-publish-001",
      preconditionFingerprint: approvedSnapshot.domFingerprint,
      status: "APPROVED",
      payload: {
        content: {
          selectedTitle: "许可失效后不得确认发布",
          description: "写闸门拒绝后保留待人工处理。",
          priceTiers: [{ name: "基础", price: 4.9 }]
        }
      }
    }
  });

  expect(result).toMatchObject({
    pageType: "listing-create",
    status: "needs_user",
    summary: "写动作许可已撤回"
  });
  expect(await page.evaluate(() => (
    globalThis as { __jianzuoPublishClicks?: number }
  ).__jianzuoPublishClicks)).toBe(0);
  await expect(page.locator('[data-jianzuo-result="published"]')).toHaveCount(0);
  expect(await page.evaluate(() => (
    globalThis as { __jianzuoWriteGuardCalls?: unknown[] }
  ).__jianzuoWriteGuardCalls)).toEqual([{ type: "write_guard", commandId: "adapter-command-revoked-001" }]);
});
