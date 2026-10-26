import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionRequest } from "@jianzuo/contracts";
import { generateContentBundle, validateContentBundle } from "@jianzuo/core";
import { WorkbenchDatabase } from "./database.js";

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

function createDb(): WorkbenchDatabase {
  const dir = mkdtempSync(join(tmpdir(), "jianzuo-db-"));
  dirs.push(dir);
  const db = new WorkbenchDatabase(join(dir, "test.sqlite"));
  db.seed();
  return db;
}

describe("database", () => {
  it("migrates and imports exactly 24 products", () => {
    const db = createDb();
    expect(db.listProducts()).toHaveLength(24);
    expect(db.listProducts().every((product) => product.readiness === "PLANNED")).toBe(true);
    const demoOrders = db.listOrders();
    expect(demoOrders).toHaveLength(3);
    expect(demoOrders.some((order) => order.order_type === "fixed_digital" && order.data_source === "demo")).toBe(true);
    db.close();
  });

  it("deduplicates visible snapshots and upserts a daily report", () => {
    const db = createDb();
    expect(db.saveMetricSnapshot({ source: "real_visible", pageType: "item-detail", pageUrl: "https://www.goofish.com/item/123456", metrics: { views: 8 } })).toBeTypeOf("string");
    expect(db.saveMetricSnapshot({ source: "real_visible", pageType: "item-detail", pageUrl: "https://www.goofish.com/item/123456", metrics: { views: 8 } })).toBeNull();
    expect(db.listMetricSnapshots()).toHaveLength(1);
    const first = db.saveDailyReport({ reportDate: "2026-08-30", source: "production", summary: "第一版", metrics: { views: 8 }, suggestions: ["继续观察"] });
    const second = db.saveDailyReport({ reportDate: "2026-08-30", source: "production", summary: "更新版", metrics: { views: 9 }, suggestions: ["核对变化"] });
    expect(second).toBe(first);
    expect(db.listDailyReports()).toMatchObject([{ summary: "更新版", metrics: { views: 9 }, suggestions: ["核对变化"] }]);
    const draft = db.saveDailyReportDraft({ reportDate: "2026-08-30", source: "production", content: "人工改写的日报", isCustom: true });
    expect(draft).toMatchObject({ content: "人工改写的日报", is_custom: 1 });
    expect(db.getDailyReportDraft("2026-08-30", "production")).toMatchObject({ content: "人工改写的日报" });
    db.close();
  });

  it("persists and revokes exact platform target bindings", () => {
    const db = createDb();
    const conversationId = String(db.listConversations()[0]!.id);
    const binding = db.upsertPlatformTargetBinding({
      bindingType: "conversation", internalId: conversationId, accountId: "local-account", externalConversationId: "chat-123",
      buyerPublicId: "buyer-public-7", productExternalId: "item-456", pageUrl: "https://www.goofish.com/im",
      tabId: "88", accountFingerprint: "a".repeat(64), domFingerprint: "b".repeat(64), adapterVersion: "test-v1",
      observedAt: new Date().toISOString(), bindingFingerprint: "c".repeat(64), status: "CONFIRMED", evidence: { cookie: "must-redact" }
    });
    expect(binding).toMatchObject({ binding_type: "conversation", external_conversation_id: "chat-123", status: "CONFIRMED" });
    expect(String(binding.evidence_json)).not.toContain("must-redact");
    expect(db.revokePlatformTargetBinding("conversation", conversationId)).toBe(true);
    expect(db.getPlatformTargetBinding("conversation", conversationId)?.status).toBe("REVOKED");
    db.close();
  });

  it("journals ImageGen tasks before accepting a verified artifact", () => {
    const db = createDb();
    const product = db.listProducts()[0]!;
    const task = db.createImageGenTask({
      productId: product.id, contentVersion: 1, codexThreadId: "thread-1", codexTurnId: "turn-1",
      beforePath: "C:/safe/template.png", beforeSha256: "a".repeat(64), candidatePath: "C:/safe/candidate.png"
    });
    expect(task).toMatchObject({ status: "RUNNING", product_id: product.id, codex_turn_id: "turn-1" });
    expect(db.markImageGenTaskVerifying(String(task.id))).toBe(true);
    expect(db.finishImageGenTask(String(task.id), "SUCCEEDED", { sha256: "b".repeat(64) })).toBe(true);
    expect(db.latestImageGenTask(product.id)).toMatchObject({ status: "SUCCEEDED" });
    expect(db.finishImageGenTask(String(task.id), "FAILED", {})).toBe(false);
    db.close();
  });

  it("versions content bundles", () => {
    const db = createDb();
    const product = db.listProducts()[0]!;
    const bundle = generateContentBundle(product);
    expect(db.saveContentBundle(product.id, bundle, validateContentBundle(bundle)).version).toBe(1);
    expect(db.saveContentBundle(product.id, bundle, []).version).toBe(2);
    db.close();
  });

  it("deduplicates jobs by idempotency key", () => {
    const db = createDb();
    expect(db.enqueueJob("TEST", {}, "same-key").inserted).toBe(true);
    expect(db.enqueueJob("TEST", {}, "same-key").inserted).toBe(false);
    db.close();
  });

  it("keeps a future action scheduled after human approval", () => {
    const db = createDb();
    const future = new Date(Date.now() + 60_000).toISOString();
    const action: ActionRequest = {
      actionId: "future-action", actionType: "PUBLISH_LISTING", targetId: "target", risk: "high",
      idempotencyKey: "future-action", preconditionFingerprint: "mock", payload: {}, status: "WAITING_APPROVAL"
    };
    db.enqueueAction(action, "MOCK", future);
    expect(db.approveAction(action.actionId)).toBe(true);
    expect(db.claimMockAction("test-worker")).toBeNull();
    db.close();
  });

  it("preserves emergency stop and user settings across seed and restart", () => {
    const db = createDb();
    const path = db.path;
    db.setSetting("automation_paused", "true");
    db.setSetting("urgent_orders_enabled", "true");
    db.close();
    const reopened = new WorkbenchDatabase(path);
    reopened.seed();
    expect(reopened.getSetting("automation_paused")).toBe("true");
    expect(reopened.getSetting("urgent_orders_enabled")).toBe("true");
    reopened.close();
  });

  it("drops stale browser identity and online state when the API starts again", () => {
    const db = createDb();
    db.setAccountStatus("ONLINE", "MANAGED_BROWSER");
    db.setBrowserRuntime("online", { connector: "MANAGED_BROWSER", pageType: "messages", domFingerprint: "a".repeat(64) });
    db.setSetting("browser_page_meta", JSON.stringify({ pageType: "messages", accountLabel: "旧页面" }));

    db.markBrowserRuntimeOfflineOnStartup();

    expect(db.getAccountStatus()).toBe("OFFLINE");
    expect(db.getBrowserRuntime()).toMatchObject({ status: "offline", page_type: null, dom_fingerprint: null, last_heartbeat_at: null });
    expect(db.getSetting("browser_page_meta")).toBeNull();
    db.close();
  });

  it("rotates and revokes extension tokens when a new pairing succeeds", () => {
    const db = createDb();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const firstCodeHash = createHash("sha256").update("123456").digest("hex");
    const firstTokenHash = createHash("sha256").update("token-one").digest("hex");
    db.createPairing(firstCodeHash, expiresAt);
    expect(db.consumePairing(firstCodeHash, firstTokenHash)).toBe(true);
    expect(db.validateExtensionToken("token-one")).toBe(true);

    const secondCodeHash = createHash("sha256").update("654321").digest("hex");
    const secondTokenHash = createHash("sha256").update("token-two").digest("hex");
    db.createPairing(secondCodeHash, expiresAt);
    expect(db.consumePairing(secondCodeHash, secondTokenHash)).toBe(true);
    expect(db.validateExtensionToken("token-one")).toBe(false);
    expect(db.validateExtensionToken("token-two")).toBe(true);
    db.close();
  });

  it("keeps an active extension token short-lived while rolling its expiry on authenticated heartbeats", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T00:00:00.000Z"));
    const db = createDb();
    const codeHash = createHash("sha256").update("123456").digest("hex");
    const token = "rolling-token";
    const tokenHash = createHash("sha256").update(token).digest("hex");
    db.createPairing(codeHash, new Date(Date.now() + 60_000).toISOString());
    expect(db.consumePairing(codeHash, tokenHash)).toBe(true);
    const initialExpiry = Date.parse(db.getExtensionPairingStatus().tokenExpiresAt!);

    vi.advanceTimersByTime(7 * 60 * 60 * 1_000);
    expect(db.validateExtensionToken(token)).toBe(true);
    const reconnectExpiry = Date.parse(db.getExtensionPairingStatus().tokenExpiresAt!);
    expect(reconnectExpiry).toBeGreaterThan(initialExpiry);

    vi.advanceTimersByTime(30_000);
    expect(db.touchExtensionTokenHash(tokenHash)).toBe(true);
    expect(Date.parse(db.getExtensionPairingStatus().tokenExpiresAt!)).toBeGreaterThan(reconnectExpiry);

    vi.advanceTimersByTime(3 * 60_000);
    expect(db.touchExtensionTokenHash(tokenHash)).toBe(false);
    expect(db.touchExtensionTokenHash("not-a-hash")).toBe(false);
    db.close();
  });

  it("claims managed browser actions once and ignores duplicate terminal receipts", () => {
    const db = createDb();
    const product = db.listProducts()[0]!;
    const publicationId = db.createPublication(product.id, null, "MANAGED_BROWSER", new Date().toISOString());
    const action: ActionRequest = {
      actionId: "browser-once", actionType: "PUBLISH_LISTING", targetId: publicationId, risk: "high",
      idempotencyKey: "browser-once", preconditionFingerprint: "dom-1", payload: { publicationId }, status: "QUEUED"
    };
    db.enqueueAction(action, "MANAGED_BROWSER");
    expect(db.claimBrowserAction("hub-1")?.status).toBe("EXECUTING");
    expect(db.claimBrowserAction("hub-2")).toBeNull();
    expect(db.listPublications().find((item) => item.id === publicationId)?.status).toBe("EXECUTING");
    expect(db.finishBrowserAction(action.actionId, "SUCCEEDED", { externalId: "test" }).completed).toBe(true);
    expect(db.finishBrowserAction(action.actionId, "FAILED", { late: true }).completed).toBe(false);
    expect(db.getAction(action.actionId)?.status).toBe("SUCCEEDED");
    expect(db.listPublications().find((item) => item.id === publicationId)?.status).toBe("PUBLISHED");
    db.close();
  });

  it("quarantines interrupted managed browser actions and related publication state", () => {
    const db = createDb();
    const product = db.listProducts()[0]!;
    const publicationId = db.createPublication(product.id, null, "MANAGED_BROWSER", new Date().toISOString());
    db.enqueueAction({
      actionId: "browser-interrupted", actionType: "PUBLISH_LISTING", targetId: publicationId, risk: "high",
      idempotencyKey: "browser-interrupted", preconditionFingerprint: "dom-1", payload: { publicationId }, status: "QUEUED"
    }, "MANAGED_BROWSER");
    expect(db.claimBrowserAction("hub-1")).not.toBeNull();
    expect(db.quarantineExecutingActions("MANAGED_BROWSER")).toBe(1);
    expect(db.getAction("browser-interrupted")?.status).toBe("RESULT_UNKNOWN");
    expect(db.listPublications().find((item) => item.id === publicationId)?.status).toBe("RESULT_UNKNOWN");
    expect(db.claimBrowserAction("hub-2")).toBeNull();
    db.close();
  });

  it("seals every pending real action on account reset and never replays an executing action", () => {
    const db = createDb();
    const product = db.listProducts()[0]!;
    const pendingPublication = db.createPublication(product.id, null, "MANAGED_BROWSER", new Date().toISOString());
    const executingPublication = db.createPublication(product.id, null, "MANAGED_BROWSER", new Date().toISOString());
    for (const [id, target] of [["account-reset-pending", pendingPublication], ["account-reset-executing", executingPublication]] as const) {
      db.enqueueAction({
        actionId: id, actionType: "PUBLISH_LISTING", targetId: target, risk: "high",
        idempotencyKey: id, preconditionFingerprint: "dom", payload: { publicationId: target }, status: "QUEUED"
      }, "MANAGED_BROWSER");
    }
    expect(db.claimBrowserAction("hub", 60, "account-reset-executing")?.status).toBe("EXECUTING");
    expect(db.sealManagedBrowserActions("账号绑定已重置")).toEqual({ cancelled: 1, resultUnknown: 1 });
    expect(db.getAction("account-reset-pending")?.status).toBe("CANCELLED");
    expect(db.getAction("account-reset-executing")?.status).toBe("RESULT_UNKNOWN");
    expect(db.claimBrowserAction("hub-again")).toBeNull();
    expect(db.getSetting("automation_paused")).toBe("true");
    db.close();
  });

  it("quarantines only expired managed browser actions, pauses automation, and never replays them", () => {
    const db = createDb();
    const product = db.listProducts()[0]!;
    const publicationId = db.createPublication(product.id, null, "MANAGED_BROWSER", new Date().toISOString());
    db.enqueueAction({
      actionId: "browser-expired", actionType: "PUBLISH_LISTING", targetId: publicationId, risk: "high",
      idempotencyKey: "browser-expired", preconditionFingerprint: "dom-expired", payload: { publicationId }, status: "QUEUED"
    }, "MANAGED_BROWSER");
    expect(db.claimBrowserAction("hub-crashed", -1)?.status).toBe("EXECUTING");

    expect(db.quarantineStaleManagedBrowserActions()).toBe(1);
    expect(db.getAction("browser-expired")).toMatchObject({ status: "RESULT_UNKNOWN", locked_by: null, lease_until: null });
    expect(db.listPublications().find((item) => item.id === publicationId)?.status).toBe("RESULT_UNKNOWN");
    expect(db.getSetting("automation_paused")).toBe("true");
    expect(db.getBrowserRuntime().status).toBe("paused");
    expect(String(db.getAction("browser-expired")?.result_json)).toContain('"replayAllowed":false');
    expect(db.finishBrowserAction("browser-expired", "SUCCEEDED", { lateReceipt: true }).completed).toBe(false);

    db.setSetting("automation_paused", "false");
    expect(db.claimBrowserAction("hub-after-manual-resume")).toBeNull();
    expect(db.approveAction("browser-expired")).toBe(false);
    expect(db.quarantineStaleManagedBrowserActions()).toBe(0);
    db.close();
  });

  it("does not quarantine a managed browser action while its lease is still live", () => {
    const db = createDb();
    const product = db.listProducts()[0]!;
    const publicationId = db.createPublication(product.id, null, "MANAGED_BROWSER", new Date().toISOString());
    db.enqueueAction({
      actionId: "browser-live", actionType: "PUBLISH_LISTING", targetId: publicationId, risk: "high",
      idempotencyKey: "browser-live", preconditionFingerprint: "dom-live", payload: { publicationId }, status: "QUEUED"
    }, "MANAGED_BROWSER");
    expect(db.claimBrowserAction("hub-live", 60)?.status).toBe("EXECUTING");
    expect(db.quarantineStaleManagedBrowserActions()).toBe(0);
    expect(db.getAction("browser-live")?.status).toBe("EXECUTING");
    expect(db.getSetting("automation_paused")).toBe("false");
    db.close();
  });

  it("safely requeues an expired mock action and caps repeated lease recovery", () => {
    const db = createDb();
    const conversationId = String(db.listConversations()[0]!.id);
    db.enqueueAction({
      actionId: "mock-expired", actionType: "SEND_REPLY", targetId: conversationId, risk: "low",
      idempotencyKey: "mock-expired", preconditionFingerprint: "mock", payload: { conversationId, body: "测试回复" }, status: "QUEUED"
    }, "MOCK");

    expect(db.claimMockAction("mock-worker-1", -1)?.attempt).toBe(1);
    expect(db.recoverExpiredMockActions()).toEqual({ requeued: 1, failed: 0 });
    expect(db.claimMockAction("mock-worker-2", -1)?.attempt).toBe(2);
    expect(db.recoverExpiredMockActions()).toEqual({ requeued: 1, failed: 0 });
    expect(db.claimMockAction("mock-worker-3", -1)?.attempt).toBe(3);
    expect(db.recoverExpiredMockActions()).toEqual({ requeued: 0, failed: 1 });
    expect(db.getAction("mock-expired")?.status).toBe("FAILED");
    expect(db.claimMockAction("mock-worker-4")).toBeNull();
    db.close();
  });

  it("commits mock effects and terminal action state atomically and ignores duplicate completion", () => {
    const db = createDb();
    const conversationId = String(db.listConversations()[0]!.id);
    const before = db.listMessages(conversationId).length;
    db.enqueueAction({
      actionId: "mock-atomic", actionType: "SEND_REPLY", targetId: conversationId, risk: "low",
      idempotencyKey: "mock-atomic", preconditionFingerprint: "mock", payload: { conversationId, body: "只应写入一次" }, status: "QUEUED"
    }, "MOCK");
    expect(db.claimMockAction("mock-worker")).not.toBeNull();
    expect(db.finishMockAction("mock-atomic", "SUCCEEDED", { receipt: "ok" }).completed).toBe(true);
    expect(db.finishMockAction("mock-atomic", "SUCCEEDED", { receipt: "duplicate" }).completed).toBe(false);
    expect(db.listMessages(conversationId)).toHaveLength(before + 1);
    expect(db.listMessages(conversationId).at(-1)?.decision_json).toContain("mock-atomic");
    db.close();
  });

  it("reclaims safe local jobs after an expired lease and dead-letters exhausted jobs", () => {
    const db = createDb();
    db.enqueueJob("HEALTH_PROBE", {}, "lease-job");
    expect(db.claimJob("worker-1", -1)?.attempt).toBe(1);
    expect(db.recoverExpiredJobs()).toEqual({ recoverable: 1, deadLettered: 0 });
    expect(db.claimJob("worker-2", -1)?.attempt).toBe(2);
    expect(db.claimJob("worker-3", -1)?.attempt).toBe(3);
    expect(db.recoverExpiredJobs()).toEqual({ recoverable: 0, deadLettered: 1 });
    expect(db.listJobs()[0]).toMatchObject({ status: "DEAD_LETTER", locked_by: null, lease_until: null });
    expect(db.claimJob("worker-4")).toBeNull();
    db.close();
  });

  it("creates real conversations and orders atomically with their selected-product bindings", () => {
    const db = createDb();
    const [product, anotherProduct] = db.listProducts();
    const baseBinding = {
      accountId: "local-account",
      externalConversationId: "conversation-1001",
      buyerPublicId: "buyer-2002",
      productExternalId: "item-3003",
      pageUrl: "https://www.goofish.com/im",
      tabId: "7",
      accountFingerprint: "a".repeat(64),
      domFingerprint: "b".repeat(64),
      adapterVersion: "adapter-v1",
      observedAt: new Date().toISOString(),
      bindingFingerprint: "c".repeat(64),
      status: "CONFIRMED" as const
    };
    const conversation = db.captureRealConversation({
      productId: product!.id,
      buyerAlias: "买家 2***2",
      initialInboundMessage: "请问今天能处理吗？",
      binding: baseBinding
    });
    expect(conversation.created).toBe(true);
    expect(db.getConversation(conversation.id)).toMatchObject({ product_id: product!.id, data_source: "real" });
    expect(db.listMessages(conversation.id)).toHaveLength(1);
    expect(db.getPlatformTargetBinding("conversation", conversation.id)).toMatchObject({ status: "CONFIRMED", external_conversation_id: "conversation-1001" });

    const refreshedConversation = db.captureRealConversation({
      productId: product!.id,
      buyerAlias: "买家 2***2",
      initialInboundMessage: "我再补充一下，希望今天完成。",
      binding: { ...baseBinding, observedAt: new Date().toISOString() }
    });
    expect(refreshedConversation.created).toBe(false);
    expect(db.listMessages(conversation.id)).toHaveLength(2);
    db.captureRealConversation({
      productId: product!.id,
      buyerAlias: "买家 2***2",
      initialInboundMessage: "我再补充一下，希望今天完成。",
      binding: { ...baseBinding, observedAt: new Date().toISOString() }
    });
    expect(db.listMessages(conversation.id)).toHaveLength(2);

    expect(() => db.captureRealConversation({
      productId: anotherProduct!.id,
      buyerAlias: "买家 2***2",
      binding: baseBinding
    })).toThrow("另一条本地记录或商品");

    const order = db.captureRealOrder({
      productId: product!.id,
      conversationId: conversation.id,
      buyerAlias: "买家 2***2",
      orderType: "semi_custom",
      tier: "标准",
      paidPrice: 12.9,
      revisionLimit: 2,
      binding: {
        ...baseBinding,
        externalOrderId: "order-4004",
        amountCents: 1290,
        pageUrl: "https://www.goofish.com/bought",
        bindingFingerprint: "d".repeat(64)
      }
    });
    expect(order.created).toBe(true);
    expect(db.getOrder(order.id)).toMatchObject({ product_id: product!.id, conversation_id: conversation.id, data_source: "real", paid_price: 12.9 });
    expect(db.getPlatformTargetBinding("order", order.id)).toMatchObject({ status: "CONFIRMED", external_order_id: "order-4004" });
    expect(db.setPlatformTargetBindingStatus("order", order.id, "TEST_VERIFIED")).toBe(true);
    expect(db.getPlatformTargetBinding("order", order.id)?.status).toBe("TEST_VERIFIED");
    db.close();
  });

  it("redacts expired terminal action data and removes orphan bindings without touching active work", () => {
    const db = createDb();
    const product = db.listProducts()[0]!;
    const oldTimestamp = "2020-01-01T00:00:00.000Z";
    const makeBinding = (suffix: string) => ({
      accountId: "local-account",
      externalConversationId: `conversation-${suffix}`,
      buyerPublicId: `buyer-${suffix}`,
      productExternalId: `item-${suffix}`,
      pageUrl: "https://www.goofish.com/im",
      tabId: suffix,
      accountFingerprint: "a".repeat(64),
      domFingerprint: "b".repeat(64),
      adapterVersion: "adapter-v1",
      observedAt: oldTimestamp,
      bindingFingerprint: createHash("sha256").update(`binding-${suffix}`).digest("hex"),
      status: "CONFIRMED" as const
    });

    const expiredConversation = db.captureRealConversation({
      productId: product.id,
      buyerAlias: "到期买家",
      initialInboundMessage: "这是到期后必须删除的买家消息",
      binding: makeBinding("expired")
    });
    const expiredOrder = db.captureRealOrder({
      productId: product.id,
      conversationId: expiredConversation.id,
      buyerAlias: "到期买家",
      orderType: "fixed_digital",
      tier: "基础",
      paidPrice: 4.9,
      revisionLimit: 1,
      binding: { ...makeBinding("expired"), externalOrderId: "order-expired", amountCents: 490 }
    });
    db.updateOrderStatus(expiredOrder.id, "DELIVERED");
    const terminalStatuses = ["SUCCEEDED", "FAILED", "RESULT_UNKNOWN", "CANCELLED"] as const;
    for (const status of terminalStatuses) {
      db.enqueueAction({
        actionId: `expired-terminal-${status}`,
        actionType: "SEND_REPLY",
        targetId: expiredConversation.id,
        risk: "low",
        idempotencyKey: `expired-terminal-idempotency-${status}`,
        preconditionFingerprint: "terminal-fingerprint",
        payload: {
          conversationId: expiredConversation.id,
          buyerMessage: "到期买家原文",
          body: "到期客服回复",
          shareUrl: "https://pan.baidu.com/s/private-link",
          externalConversationId: "conversation-expired",
          buyerPublicId: "buyer-expired"
        },
        status
      }, "MANAGED_BROWSER");
    }

    const activeConversation = db.captureRealConversation({
      productId: product.id,
      buyerAlias: "处理中买家",
      initialInboundMessage: "处理中消息必须保留",
      binding: makeBinding("active")
    });
    const activeOrder = db.captureRealOrder({
      productId: product.id,
      conversationId: activeConversation.id,
      buyerAlias: "处理中买家",
      orderType: "fixed_digital",
      tier: "基础",
      paidPrice: 4.9,
      revisionLimit: 1,
      binding: { ...makeBinding("active"), externalOrderId: "order-active", amountCents: 490 }
    });
    db.updateOrderStatus(activeOrder.id, "DELIVERED");
    const activeDeliveryId = db.saveDeliveryLink(activeOrder.id, "https://pan.baidu.com/s/active-private-link");
    db.enqueueAction({
      actionId: "active-delivery-action",
      actionType: "SEND_DELIVERY",
      targetId: activeDeliveryId,
      risk: "high",
      idempotencyKey: "active-delivery-idempotency",
      preconditionFingerprint: "active-fingerprint",
      payload: {
        orderId: activeOrder.id,
        deliveryId: activeDeliveryId,
        shareUrl: "https://pan.baidu.com/s/active-private-link",
        deliveryMessage: "处理中交付消息",
        platformTargetBinding: { internal_id: activeOrder.id, external_order_id: "order-active" }
      },
      status: "WAITING_APPROVAL"
    }, "MANAGED_BROWSER");

    const raw = new DatabaseSync(db.path);
    raw.prepare("UPDATE conversations SET last_message_at=?,created_at=? WHERE id IN (?,?)")
      .run(oldTimestamp, oldTimestamp, expiredConversation.id, activeConversation.id);
    raw.prepare("UPDATE messages SET created_at=? WHERE conversation_id IN (?,?)")
      .run(oldTimestamp, expiredConversation.id, activeConversation.id);
    raw.prepare("UPDATE orders SET updated_at=?,created_at=? WHERE id IN (?,?)")
      .run(oldTimestamp, oldTimestamp, expiredOrder.id, activeOrder.id);
    raw.prepare("UPDATE action_outbox SET updated_at=?,created_at=?,result_json=? WHERE action_id LIKE 'expired-terminal-%'")
      .run(oldTimestamp, oldTimestamp, JSON.stringify({ shareUrl: "https://pan.baidu.com/s/private-result", externalId: "buyer-expired" }));
    raw.prepare("UPDATE action_outbox SET updated_at=?,created_at=? WHERE action_id=?")
      .run(oldTimestamp, oldTimestamp, "active-delivery-action");
    raw.close();

    const cleanup = db.cleanupExpired();

    expect(cleanup).toMatchObject({ orders: 1, conversations: 1, outboxRedacted: 4, targetBindingsDeleted: 2 });
    for (const status of terminalStatuses) {
      expect(db.getAction(`expired-terminal-${status}`)).toMatchObject({
        status,
        idempotency_key: `expired-terminal-idempotency-${status}`,
        payload_json: JSON.stringify({ retentionRedacted: true }),
        result_json: JSON.stringify({ retentionRedacted: true })
      });
    }
    expect(db.claimBrowserAction("retention-must-not-replay")).toBeNull();
    expect(db.getOrder(expiredOrder.id)).toBeNull();
    expect(db.getConversation(expiredConversation.id)).toBeNull();
    expect(db.getPlatformTargetBinding("conversation", expiredConversation.id)).toBeNull();
    expect(db.getPlatformTargetBinding("order", expiredOrder.id)).toBeNull();

    expect(db.getAction("active-delivery-action")).toMatchObject({ status: "WAITING_APPROVAL" });
    expect(String(db.getAction("active-delivery-action")?.payload_json)).toContain("active-private-link");
    expect(db.getOrder(activeOrder.id)).not.toBeNull();
    expect(db.getConversation(activeConversation.id)).not.toBeNull();
    expect(db.listMessages(activeConversation.id)).toHaveLength(1);
    expect(db.getDelivery(activeDeliveryId)).not.toBeNull();
    expect(db.getPlatformTargetBinding("conversation", activeConversation.id)).not.toBeNull();
    expect(db.getPlatformTargetBinding("order", activeOrder.id)).not.toBeNull();
    expect(db.cleanupExpired()).toMatchObject({ outboxRedacted: 0, targetBindingsDeleted: 0 });
    db.close();
  });
});
