import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkbenchDatabase } from "@jianzuo/database";
import { advanceCalibration } from "./services/calibration.js";
import type { BaiduPanTransport, BaiduPanTransportRequest, BaiduPanTransportResponse } from "./services/baidu-pan.js";
import { buildApp } from "./app.js";

const resources: Array<{ dir: string; close: () => Promise<void> }> = [];
afterEach(async () => {
  while (resources.length) {
    const resource = resources.pop()!;
    await resource.close();
    rmSync(resource.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

async function fixture() {
  return (await fixtureWithDatabase()).app;
}

async function fixtureWithDatabase(options: { baiduTransport?: BaiduPanTransport } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "jianzuo-api-"));
  const db = new WorkbenchDatabase(join(dir, "test.sqlite"));
  const app = await buildApp({
    database: db,
    logger: false,
    config: {
      host: "127.0.0.1", port: 8787, rootDir: resolve(process.cwd()), dataDir: dir,
      webDist: join(dir, "web"), mockDist: join(dir, "mock"), extensionDir: join(dir, "extension"), browserProfileDir: join(dir, "profile")
    },
    baiduTransport: options.baiduTransport
  });
  resources.push({ dir, close: () => app.close() });
  return { app, db, dir };
}

async function staticWebFixture() {
  const dir = mkdtempSync(join(tmpdir(), "jianzuo-static-"));
  const webDist = join(dir, "web");
  mkdirSync(webDist, { recursive: true });
  writeFileSync(join(webDist, "index.html"), "<!doctype html><div id=\"root\"></div>", "utf8");
  const app = await buildApp({
    logger: false,
    config: {
      host: "127.0.0.1", port: 8787, rootDir: resolve(process.cwd()), dataDir: dir,
      webDist, mockDist: join(dir, "mock"), extensionDir: join(dir, "extension"), browserProfileDir: join(dir, "profile")
    }
  });
  resources.push({ dir, close: () => app.close() });
  return { app, webDist };
}

class FakeBaiduTransport implements BaiduPanTransport {
  readonly requests: BaiduPanTransportRequest[] = [];

  async request(request: BaiduPanTransportRequest): Promise<BaiduPanTransportResponse<Record<string, unknown>>> {
    this.requests.push(request);
    if (request.operation === "oauth_token") {
      return {
        status: 200,
        data: {
          access_token: "fixture-access-token",
          refresh_token: "fixture-refresh-token",
          token_type: "Bearer",
          scope: "basic netdisk",
          expires_in: 3_600
        }
      };
    }
    if (request.operation === "precreate") {
      return { status: 200, data: { errno: 0, uploadid: "fixture-upload-id", block_list: [0] } };
    }
    if (request.operation === "upload_part") {
      return {
        status: 200,
        data: {
          errno: 0,
          md5: createHash("md5").update(Buffer.from(request.multipart?.content ?? [])).digest("hex")
        }
      };
    }
    return {
      status: 200,
      data: {
        errno: 0,
        fs_id: "fixture-fs-id",
        path: String(request.form?.path ?? "/apps/jianzuo/delivery.zip"),
        server_filename: "delivery.zip",
        size: Number(request.form?.size ?? 22)
      }
    };
  }
}

async function setupSession(app: Awaited<ReturnType<typeof buildApp>>) {
  const setup = await app.inject({
    method: "POST",
    url: "/api/auth/setup",
    headers: { host: "127.0.0.1" },
    payload: { pin: "246810" }
  });
  const cookie = String(setup.headers["set-cookie"]).split(";")[0] ?? "";
  return {
    cookie,
    csrf: String(setup.json().data.csrf),
    headers: {
      host: "127.0.0.1",
      cookie,
      "x-jianzuo-csrf": String(setup.json().data.csrf)
    }
  };
}

async function configureAndAuthorizeBaidu(
  app: Awaited<ReturnType<typeof buildApp>>,
  headers: Record<string, string>
) {
  const configured = await app.inject({
    method: "PATCH",
    url: "/api/baidu/config",
    headers,
    payload: { clientId: "fixture-app-key", clientSecret: "fixture-secret-key" }
  });
  expect(configured.statusCode).toBe(200);
  const authorization = await app.inject({ method: "POST", url: "/api/baidu/authorize", headers });
  expect(authorization.statusCode).toBe(200);
  const authorizationUrl = new URL(String(authorization.json().data.authorizationUrl));
  const state = authorizationUrl.searchParams.get("state");
  expect(state).toBeTruthy();
  const callback = await app.inject({
    method: "GET",
    url: `/api/baidu/oauth/callback?state=${encodeURIComponent(String(state))}&code=fixture-authorization-code`,
    headers: { host: "127.0.0.1" }
  });
  expect(callback.statusCode).toBe(200);
  return { configured, authorization, callback, authorizationUrl };
}

describe("local API", () => {
  it("fails closed for order-scoped Codex until per-order workspace isolation is verified", async () => {
    const { app, db } = await fixtureWithDatabase();
    const session = await setupSession(app);
    const orderId = String(db.listOrders()[0]?.id ?? "DEMO-ORDER-001");
    db.saveConsent(orderId, null, "granted");

    const thread = await app.inject({ method: "POST", url: "/api/codex/threads", headers: session.headers, payload: {
      scopeType: "order", scopeId: orderId, title: "隔离订单测试"
    } });
    expect(thread.statusCode).toBe(409);
    expect(thread.json().summary).toContain("工作区隔离");
    expect(db.getCodexThread("order", orderId)).toBeNull();

    const turn = await app.inject({ method: "POST", url: "/api/codex/turns", headers: session.headers, payload: {
      scopeType: "order", scopeId: orderId, message: "不得发送的订单内容"
    } });
    expect(turn.statusCode).toBe(409);
    expect(turn.json().summary).toContain("未向 Codex 发送任何订单内容");
  });

  it("keeps result-unknown browser actions sealed across emergency stop and resume", async () => {
    const { app, db } = await fixtureWithDatabase();
    const session = await setupSession(app);
    db.enqueueAction({
      actionId: "unknown-browser-action",
      actionType: "PUBLISH_LISTING",
      targetId: "fixture-publication",
      risk: "high",
      idempotencyKey: "unknown-browser-action",
      preconditionFingerprint: "a".repeat(64),
      payload: { controlledTest: true },
      status: "RESULT_UNKNOWN"
    }, "MANAGED_BROWSER");

    const stopped = await app.inject({ method: "POST", url: "/api/emergency-stop", headers: session.headers });
    expect(stopped.statusCode).toBe(200);
    expect(db.getSetting("automation_paused")).toBe("true");
    expect(db.getAction("unknown-browser-action")?.status).toBe("RESULT_UNKNOWN");

    const missingConfirmation = await app.inject({ method: "POST", url: "/api/emergency-resume", headers: session.headers });
    expect(missingConfirmation.statusCode).toBe(400);
    expect(db.getSetting("automation_paused")).toBe("true");

    const wrongPin = await app.inject({ method: "POST", url: "/api/emergency-resume", headers: session.headers, payload: {
      pin: "111111", confirmation: "RESUME_AUTOMATION", acknowledgeResultUnknown: true
    } });
    expect(wrongPin.statusCode).toBe(403);
    expect(db.getSetting("automation_paused")).toBe("true");

    const missingAcknowledgement = await app.inject({ method: "POST", url: "/api/emergency-resume", headers: session.headers, payload: {
      pin: "246810", confirmation: "RESUME_AUTOMATION", acknowledgeResultUnknown: false
    } });
    expect(missingAcknowledgement.statusCode).toBe(409);
    expect(db.getSetting("automation_paused")).toBe("true");

    const resumed = await app.inject({ method: "POST", url: "/api/emergency-resume", headers: session.headers, payload: {
      pin: "246810", confirmation: "RESUME_AUTOMATION", acknowledgeResultUnknown: true
    } });
    expect(resumed.statusCode).toBe(200);
    expect(db.getSetting("automation_paused")).toBe("false");
    expect(db.getAction("unknown-browser-action")?.status).toBe("RESULT_UNKNOWN");
  });

  it("serves newly built hashed assets without restarting the API", async () => {
    const { app, webDist } = await staticWebFixture();
    const assetsDir = join(webDist, "assets");
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(join(assetsDir, "index-newhash.js"), "globalThis.__JIANZUO_LOADED__ = true;", "utf8");

    const response = await app.inject({
      method: "GET",
      url: "/assets/index-newhash.js",
      headers: { host: "127.0.0.1" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/javascript");
    expect(response.body).toContain("__JIANZUO_LOADED__");
  });

  it("reports a local-only healthy service", async () => {
    const app = await fixture();
    const response = await app.inject({ method: "GET", url: "/api/health", headers: { host: "127.0.0.1" } });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.host).toBe("127.0.0.1");
  });

  it("requires unlock for business data", async () => {
    const app = await fixture();
    const response = await app.inject({ method: "GET", url: "/api/products", headers: { host: "127.0.0.1" } });
    expect(response.statusCode).toBe(401);
  });

  it("rejects a non-local Host header even under injection", async () => {
    const app = await fixture();
    const response = await app.inject({ method: "GET", url: "/api/health", headers: { host: "workbench.example" } });
    expect(response.statusCode).toBe(403);
  });

  it("rate limits repeated wrong PIN attempts", async () => {
    const app = await fixture();
    const setup = await app.inject({ method: "POST", url: "/api/auth/setup", headers: { host: "127.0.0.1" }, payload: { pin: "246810" } });
    expect(setup.statusCode).toBe(200);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const wrong = await app.inject({ method: "POST", url: "/api/auth/unlock", headers: { host: "127.0.0.1" }, payload: { pin: "111111" } });
      expect(wrong.statusCode).toBe(401);
    }
    const locked = await app.inject({ method: "POST", url: "/api/auth/unlock", headers: { host: "127.0.0.1" }, payload: { pin: "111111" } });
    expect(locked.statusCode).toBe(429);
    expect(locked.json().summary).toContain("60 秒");
  });

  it("allows first account confirmation only on the account home or profile page", async () => {
    const { app, db } = await fixtureWithDatabase();
    const session = await setupSession(app);
    const observedAt = new Date().toISOString();
    const common = {
      pageUrl: "https://www.goofish.com/im",
      tabId: "19",
      adapterVersion: "adapter-v1",
      accountLabel: "测试账号",
      accountFingerprint: "a".repeat(64),
      domFingerprint: "b".repeat(64),
      observedAt
    };
    db.setBrowserRuntime("online", { connector: "MANAGED_BROWSER", pageType: "messages", domFingerprint: common.domFingerprint });
    db.setSetting("browser_page_meta", JSON.stringify({ ...common, pageType: "messages" }));
    const rejected = await app.inject({
      method: "POST", url: "/api/calibration/confirm-account", headers: session.headers,
      payload: { confirmation: "CONFIRM_VISIBLE_ACCOUNT" }
    });
    expect(rejected.statusCode).toBe(409);

    db.setBrowserRuntime("online", { connector: "MANAGED_BROWSER", pageType: "account-profile", domFingerprint: common.domFingerprint });
    db.setSetting("browser_page_meta", JSON.stringify({
      ...common,
      pageType: "account-profile",
      pageUrl: "https://www.goofish.com/personal",
      accountIdentitySource: "page-header",
      accountBindingEligible: true,
      observedAt: new Date().toISOString()
    }));
    const accepted = await app.inject({
      method: "POST", url: "/api/calibration/confirm-account", headers: session.headers,
      payload: { confirmation: "CONFIRM_VISIBLE_ACCOUNT" }
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().data.stage).toBe("ACCOUNT_CONFIRMED");
  });

  it("refuses automatic capture when the visible buyer message is too long to verify completely", async () => {
    const { app, db } = await fixtureWithDatabase();
    const session = await setupSession(app);
    const observedAt = new Date().toISOString();
    const accountFingerprint = "a".repeat(64);
    const domFingerprint = "b".repeat(64);
    const pageBinding = {
      pageType: "messages", pageUrl: "https://www.goofish.com/im", tabId: "20", adapterVersion: "adapter-v1",
      accountLabel: "测试账号", accountFingerprint, domFingerprint, observedAt
    };
    db.setBrowserRuntime("online", { connector: "MANAGED_BROWSER", pageType: "messages", domFingerprint });
    db.setSetting("browser_page_meta", JSON.stringify(pageBinding));
    db.setSetting("browser_visible_target", JSON.stringify({
      target: {
        targetType: "message", conversationId: "external-long-message", buyerPublicId: "buyer-long", productId: "item-long",
        pageUrl: pageBinding.pageUrl, tabId: pageBinding.tabId, accountFingerprint, domFingerprint,
        adapterVersion: pageBinding.adapterVersion, observedAt
      },
      context: { lastInboundText: "普通需求".repeat(5_001) },
      receivedAt: observedAt
    }));
    advanceCalibration(db, "ACCOUNT_CONFIRMED", { accountLabel: "测试账号", accountFingerprint });
    const products = await app.inject({ method: "GET", url: "/api/products", headers: session.headers });
    const captured = await app.inject({
      method: "POST", url: "/api/conversations/capture-current", headers: session.headers,
      payload: { productId: products.json().data[0].id, confirmation: "CAPTURE_VISIBLE_CONVERSATION" }
    });
    expect(captured.statusCode).toBe(409);
    expect(captured.json().summary).toContain("消息过长");

    const dangerousSuffixMessage = `${"普通需求说明".repeat(70)}，最后补充：我要退款并投诉。`;
    db.setSetting("browser_visible_target", JSON.stringify({
      target: {
        targetType: "message", conversationId: "external-suffix-risk", buyerPublicId: "buyer-risk", productId: "item-long",
        pageUrl: pageBinding.pageUrl, tabId: pageBinding.tabId, accountFingerprint, domFingerprint,
        adapterVersion: pageBinding.adapterVersion, observedAt: new Date().toISOString()
      },
      context: { lastInboundText: dangerousSuffixMessage },
      receivedAt: new Date().toISOString()
    }));
    const riskCaptured = await app.inject({
      method: "POST", url: "/api/conversations/capture-current", headers: session.headers,
      payload: { productId: products.json().data[0].id, confirmation: "CAPTURE_VISIBLE_CONVERSATION" }
    });
    expect(riskCaptured.statusCode).toBe(200);
    const decision = await app.inject({
      method: "POST", url: `/api/conversations/${String(riskCaptured.json().data.id)}/decide`, headers: session.headers,
      payload: {}
    });
    expect(decision.json().status).toBe("needs_user");
    expect(decision.json().data.escalate).toBe(true);
  });

  it("rejects an assistant reply when its buyer-message binding is missing or stale", async () => {
    const app = await fixture();
    const setup = await app.inject({ method: "POST", url: "/api/auth/setup", headers: { host: "127.0.0.1" }, payload: { pin: "246810" } });
    const cookie = String(setup.headers["set-cookie"]).split(";")[0];
    const csrf = String(setup.json().data.csrf);
    const authHeaders = { host: "127.0.0.1", cookie, "x-jianzuo-csrf": csrf };
    const conversations = await app.inject({ method: "GET", url: "/api/conversations", headers: authHeaders });
    const conversationId = String(conversations.json().data[0].id);
    const decided = await app.inject({ method: "POST", url: `/api/conversations/${conversationId}/decide`, headers: authHeaders, payload: {} });
    const decision = decided.json().data;

    const stale = await app.inject({
      method: "POST", url: `/api/conversations/${conversationId}/send`, headers: authHeaders,
      payload: { reply: decision.reply, connector: "MOCK", mode: "assistant", latestInboundMessageId: "stale", latestInboundMessageHash: "stale", decisionVersion: "rules-v1" }
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().summary).toContain("重新生成回复建议");

    const bound = await app.inject({
      method: "POST", url: `/api/conversations/${conversationId}/send`, headers: authHeaders,
      payload: { reply: decision.reply, connector: "MOCK", mode: "assistant", ...decision.draftBinding }
    });
    expect(bound.statusCode).toBe(200);
    expect(bound.json().summary).toContain("发送队列");
  });

  it("keeps a real controlled reply in approval and rejects approval after the visible conversation changes", async () => {
    const { app, db } = await fixtureWithDatabase();
    const setup = await app.inject({ method: "POST", url: "/api/auth/setup", headers: { host: "127.0.0.1" }, payload: { pin: "246810" } });
    const authHeaders = {
      host: "127.0.0.1",
      cookie: String(setup.headers["set-cookie"]).split(";")[0],
      "x-jianzuo-csrf": String(setup.json().data.csrf)
    };
    const accountFingerprint = "a".repeat(64);
    const domFingerprint = "b".repeat(64);
    const observedAt = new Date().toISOString();
    const pageBinding = {
      pageType: "messages",
      pageUrl: "https://www.goofish.com/im",
      tabId: "31",
      adapterVersion: "adapter-v1",
      accountLabel: "测试账号",
      accountFingerprint,
      domFingerprint,
      observedAt
    };
    const target = {
      targetType: "message" as const,
      conversationId: "external-conversation-1",
      buyerPublicId: "buyer-1",
      productId: "external-product-1",
      pageUrl: pageBinding.pageUrl,
      tabId: pageBinding.tabId,
      accountFingerprint,
      domFingerprint,
      adapterVersion: pageBinding.adapterVersion,
      observedAt
    };
    db.setBrowserRuntime("online", { connector: "MANAGED_BROWSER", pageType: "messages", domFingerprint });
    db.setSetting("browser_page_meta", JSON.stringify(pageBinding));
    db.setSetting("browser_visible_target", JSON.stringify({
      target,
      context: { buyerAlias: "买家 1***1", lastMessagePreview: "这张图里的字能换一下吗？" },
      receivedAt: observedAt
    }));
    advanceCalibration(db, "SINGLE_PUBLISH_VERIFIED", { accountLabel: "测试账号", accountFingerprint });

    const products = await app.inject({ method: "GET", url: "/api/products", headers: authHeaders });
    const captured = await app.inject({
      method: "POST", url: "/api/conversations/capture-current", headers: authHeaders,
      payload: { productId: products.json().data[0].id, confirmation: "CAPTURE_VISIBLE_CONVERSATION" }
    });
    expect(captured.statusCode).toBe(200);
    const conversationId = String(captured.json().data.id);
    const decided = await app.inject({ method: "POST", url: `/api/conversations/${conversationId}/decide`, headers: authHeaders, payload: {} });
    const decision = decided.json().data;
    const prepared = await app.inject({
      method: "POST", url: `/api/conversations/${conversationId}/send`, headers: authHeaders,
      payload: {
        reply: decision.reply,
        connector: "MANAGED_BROWSER",
        mode: "assistant",
        confirmation: "SEND_CONTROLLED_TEST_REPLY",
        ...decision.draftBinding
      }
    });
    expect(prepared.statusCode).toBe(200);
    expect(prepared.json()).toMatchObject({ status: "needs_user" });
    expect(prepared.json().data.status).toBe("WAITING_APPROVAL");
    const actionId = String(prepared.json().data.actionId);

    db.setSetting("browser_visible_target", JSON.stringify({
      target: { ...target, conversationId: "external-conversation-2", observedAt: new Date().toISOString() },
      context: {},
      receivedAt: new Date().toISOString()
    }));
    const rejected = await app.inject({ method: "POST", url: `/api/actions/${actionId}/approve`, headers: authHeaders, payload: {} });
    expect(rejected.statusCode).toBe(409);
    expect(db.getAction(actionId)?.status).toBe("WAITING_APPROVAL");

    const refreshedAt = new Date().toISOString();
    db.setSetting("browser_page_meta", JSON.stringify({ ...pageBinding, observedAt: refreshedAt }));
    db.setBrowserRuntime("online", { connector: "MANAGED_BROWSER", pageType: "messages", domFingerprint });
    db.setSetting("browser_visible_target", JSON.stringify({
      target: { ...target, observedAt: refreshedAt },
      context: { lastMessagePreview: "这张图里的字能换一下吗?" },
      receivedAt: refreshedAt
    }));
    const approved = await app.inject({ method: "POST", url: `/api/actions/${actionId}/approve`, headers: authHeaders, payload: {} });
    expect(approved.statusCode).toBe(200);
    expect(db.getAction(actionId)?.status).toBe("QUEUED");
    expect(JSON.parse(String(db.getSetting("real_calibration_state"))).stage).toBe("SINGLE_PUBLISH_VERIFIED");
  });

  it("persists an editable daily report draft and can restore evidence-based defaults", async () => {
    const app = await fixture();
    const setup = await app.inject({ method: "POST", url: "/api/auth/setup", headers: { host: "127.0.0.1" }, payload: { pin: "246810" } });
    const authHeaders = {
      host: "127.0.0.1",
      cookie: String(setup.headers["set-cookie"]).split(";")[0],
      "x-jianzuo-csrf": String(setup.json().data.csrf)
    };
    const generated = await app.inject({ method: "POST", url: "/api/analytics/daily-report", headers: authHeaders });
    expect(generated.statusCode).toBe(200);
    const reportDate = String(generated.json().data.reportDate);
    const initial = await app.inject({ method: "GET", url: `/api/analytics/report-draft?date=${reportDate}`, headers: authHeaders });
    expect(initial.json().data).toMatchObject({ date: reportDate, isCustom: false });

    const saved = await app.inject({
      method: "PUT", url: "/api/analytics/report-draft", headers: authHeaders,
      payload: { date: reportDate, content: "今天只记录真实数据。\n\n明天先继续观察咨询质量。" }
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().data).toMatchObject({ isCustom: true });

    const rejected = await app.inject({
      method: "PUT", url: "/api/analytics/report-draft", headers: authHeaders,
      payload: { date: reportDate, content: "token=should-not-be-saved" }
    });
    expect(rejected.statusCode).toBe(400);

    const restored = await app.inject({
      method: "PUT", url: "/api/analytics/report-draft", headers: authHeaders,
      payload: { date: reportDate, restoreDefault: true }
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().data).toMatchObject({ isCustom: false });
    expect(String(restored.json().data.content)).toContain("真实发布");
  });

  it("encrypts Baidu configuration, keeps status authenticated, and never returns the secret", async () => {
    const { app, db } = await fixtureWithDatabase();
    const unauthenticated = await app.inject({ method: "GET", url: "/api/baidu/status", headers: { host: "127.0.0.1" } });
    expect(unauthenticated.statusCode).toBe(401);

    const session = await setupSession(app);
    const initial = await app.inject({ method: "GET", url: "/api/baidu/status", headers: session.headers });
    expect(initial.json().data).toEqual({
      configured: false,
      authorized: false,
      redirectUri: "http://127.0.0.1:8787/api/baidu/oauth/callback"
    });

    const secret = "fixture-secret-key";
    const clientId = "fixture-app-key";
    const saved = await app.inject({
      method: "PATCH",
      url: "/api/baidu/config",
      headers: session.headers,
      payload: { clientId, clientSecret: secret }
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain(secret);
    expect(saved.body).not.toContain(clientId);
    const encrypted = String(db.getSetting("baidu_oauth_config"));
    expect(encrypted).not.toContain(secret);
    expect(encrypted).not.toContain(clientId);

    const status = await app.inject({ method: "GET", url: "/api/baidu/status", headers: session.headers });
    expect(status.json().data).toMatchObject({ configured: true, authorized: false });
  });

  it("completes the one-time Baidu OAuth callback without a workbench cookie and rejects reuse", async () => {
    const transport = new FakeBaiduTransport();
    const { app, db } = await fixtureWithDatabase({ baiduTransport: transport });
    const session = await setupSession(app);
    const configured = await app.inject({
      method: "PATCH",
      url: "/api/baidu/config",
      headers: session.headers,
      payload: { clientId: "fixture-app-key", clientSecret: "fixture-secret-key" }
    });
    expect(configured.statusCode).toBe(200);
    const authorization = await app.inject({ method: "POST", url: "/api/baidu/authorize", headers: session.headers });
    const authorizationUrl = new URL(String(authorization.json().data.authorizationUrl));
    expect(authorizationUrl.origin).toBe("https://openapi.baidu.com");
    expect(authorizationUrl.searchParams.get("client_secret")).toBeNull();
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    const state = String(authorizationUrl.searchParams.get("state"));

    const wrongState = await app.inject({
      method: "GET",
      url: "/api/baidu/oauth/callback?state=wrong-state&code=fixture-authorization-code",
      headers: { host: "127.0.0.1" }
    });
    expect(wrongState.statusCode).toBe(400);
    expect(wrongState.body).not.toContain("fixture-authorization-code");
    expect(transport.requests).toHaveLength(0);

    const completed = await app.inject({
      method: "GET",
      url: `/api/baidu/oauth/callback?state=${encodeURIComponent(state)}&code=fixture-authorization-code`,
      headers: { host: "127.0.0.1" }
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.headers["content-type"]).toContain("text/html");
    expect(completed.body).toContain("授权已保存");
    expect(completed.body).not.toContain("fixture-authorization-code");
    expect(completed.body).not.toContain("fixture-access-token");
    expect(transport.requests.map((request) => request.operation)).toEqual(["oauth_token"]);
    expect(String(db.getSetting("baidu_oauth_token"))).not.toContain("fixture-access-token");

    const status = await app.inject({ method: "GET", url: "/api/baidu/status", headers: session.headers });
    expect(status.json().data).toMatchObject({ configured: true, authorized: true });
    const reused = await app.inject({
      method: "GET",
      url: `/api/baidu/oauth/callback?state=${encodeURIComponent(state)}&code=fixture-authorization-code`,
      headers: { host: "127.0.0.1" }
    });
    expect(reused.statusCode).toBe(400);
    expect(transport.requests).toHaveLength(1);
  });

  it("requires an explicit confirmation and uploads only an in-root existing ZIP without sharing or sending", async () => {
    const transport = new FakeBaiduTransport();
    const { app, db, dir } = await fixtureWithDatabase({ baiduTransport: transport });
    const session = await setupSession(app);
    await configureAndAuthorizeBaidu(app, session.headers);
    const orderId = String(db.listOrders()[0]?.id);
    mkdirSync(join(dir, "artifacts", "orders"), { recursive: true });
    const outsideZip = join(dir, "outside.zip");
    writeFileSync(outsideZip, Buffer.concat([Buffer.from("504b0506", "hex"), Buffer.alloc(18)]));
    db.upsertDelivery(orderId, "READY", "platform_attachment", outsideZip);

    const outsideRoot = await app.inject({
      method: "POST",
      url: `/api/orders/${orderId}/baidu-upload`,
      headers: session.headers,
      payload: { confirmation: "UPLOAD_TO_BAIDU" }
    });
    expect(outsideRoot.statusCode).toBe(409);
    expect(outsideRoot.json().summary).toContain("不在订单允许目录");
    expect(transport.requests.map((request) => request.operation)).toEqual(["oauth_token"]);

    const deliveryDir = join(dir, "artifacts", "orders", orderId);
    mkdirSync(deliveryDir, { recursive: true });
    const zipPath = join(deliveryDir, "交付包.zip");
    writeFileSync(zipPath, Buffer.concat([Buffer.from("504b0506", "hex"), Buffer.alloc(18)]));
    db.upsertDelivery(orderId, "READY", "platform_attachment", zipPath);

    const unconfirmed = await app.inject({
      method: "POST",
      url: `/api/orders/${orderId}/baidu-upload`,
      headers: session.headers,
      payload: {}
    });
    expect(unconfirmed.statusCode).toBe(409);
    expect(transport.requests.map((request) => request.operation)).toEqual(["oauth_token"]);

    const uploaded = await app.inject({
      method: "POST",
      url: `/api/orders/${orderId}/baidu-upload`,
      headers: session.headers,
      payload: { confirmation: "UPLOAD_TO_BAIDU" }
    });
    expect(uploaded.statusCode).toBe(200);
    expect(uploaded.json()).toMatchObject({
      status: "needs_user",
      data: { status: "WAITING_USER_PASTE_LINK" },
      nextActions: [{ type: "PASTE_BAIDU_SHARE_LINK" }]
    });
    expect(uploaded.body).not.toContain("fixture-access-token");
    expect(uploaded.body).not.toContain("fixture-fs-id");
    expect(transport.requests.map((request) => request.operation)).toEqual([
      "oauth_token", "precreate", "upload_part", "create_file"
    ]);
    expect(db.getDeliveryForOrder(orderId)).toMatchObject({ mode: "baidu_manual_link", share_url: null });
    expect(db.listActions().filter((action) => action.action_type === "SEND_DELIVERY")).toHaveLength(0);
  });

  it("clears Baidu credentials only with the exact confirmation and preserves manual order links", async () => {
    const transport = new FakeBaiduTransport();
    const { app, db } = await fixtureWithDatabase({ baiduTransport: transport });
    const session = await setupSession(app);
    await configureAndAuthorizeBaidu(app, session.headers);
    const orderId = String(db.listOrders()[0]?.id);
    db.saveDeliveryLink(orderId, "https://pan.baidu.com/s/fixture-share");

    const rejected = await app.inject({
      method: "DELETE",
      url: "/api/baidu/config",
      headers: session.headers,
      payload: { confirmation: "clear" }
    });
    expect(rejected.statusCode).toBe(409);
    expect(db.getSetting("baidu_oauth_config")).toBeTruthy();

    const cleared = await app.inject({
      method: "DELETE",
      url: "/api/baidu/config",
      headers: session.headers,
      payload: { confirmation: "CLEAR_BAIDU_CONFIG" }
    });
    expect(cleared.statusCode).toBe(200);
    expect(db.getSetting("baidu_oauth_config")).toBe("");
    expect(db.getSetting("baidu_oauth_token")).toBe("");
    expect(db.getDeliveryForOrder(orderId)?.share_url).toBe("https://pan.baidu.com/s/fixture-share");
  });
});
