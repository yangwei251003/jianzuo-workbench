import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMessageTargetBinding, createOrderTargetBinding, platformAmountToCents } from "@jianzuo/core";
import { WorkbenchDatabase } from "@jianzuo/database";
import { advanceCalibration, readCalibration } from "./calibration.js";
import { ExtensionHub, verifyReceiptActionEvidence } from "./extension-hub.js";

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: string[] = [];
  closeCode?: number;
  closeReason?: string;
  send(value: string): void { this.sent.push(value); }
  close(code?: number, reason?: string): void {
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = 3;
    this.emit("close");
  }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "jianzuo-extension-target-"));
  roots.push(root);
  const db = new WorkbenchDatabase(join(root, "test.sqlite"));
  db.seed();
  const hub = new ExtensionHub(db, root);
  const pairing = hub.createPairing();
  const paired = hub.pair(pairing.code)!;
  const socket = new FakeSocket();
  expect(hub.attach(socket as never, paired.token)).toBe(true);
  const accountFingerprint = "a".repeat(64);
  advanceCalibration(db, "SINGLE_PUBLISH_VERIFIED", { accountLabel: "测试账号", accountFingerprint });
  return { root, db, hub, socket, accountFingerprint };
}

function heartbeat(socket: FakeSocket, body: Record<string, unknown>): void {
  socket.emit("message", JSON.stringify({ type: "heartbeat", ...body }));
}

describe("managed browser visible target safety gate", () => {
  it("preserves account calibration across a transient unidentified restart heartbeat", () => {
    const { db, socket, accountFingerprint } = fixture();
    db.setAccountStatus("ONLINE", "MANAGED_BROWSER");

    heartbeat(socket, {
      pageType: "unavailable",
      pageUrl: "",
      tabId: "",
      adapterVersion: "",
      accountLabel: "",
      accountFingerprint: "",
      domFingerprint: ""
    });

    expect(readCalibration(db).stage).toBe("SINGLE_PUBLISH_VERIFIED");
    expect(db.getSetting("automation_paused")).toBe("false");
    expect(db.getAccountStatus()).toBe("DEGRADED");

    heartbeat(socket, {
      pageType: "account-home",
      pageUrl: "https://www.goofish.com/",
      tabId: "restart-tab",
      adapterVersion: "adapter-v1",
      accountLabel: "测试账号",
      accountFingerprint,
      accountIdentitySource: "page-header",
      accountBindingEligible: true,
      domFingerprint: "b".repeat(64)
    });

    expect(readCalibration(db).stage).toBe("SINGLE_PUBLISH_VERIFIED");
    expect(db.getAccountStatus()).toBe("ONLINE");
    db.close();
  });

  it("still locks calibration when a different visible account is positively identified", () => {
    const { db, socket } = fixture();

    heartbeat(socket, {
      pageType: "account-home",
      pageUrl: "https://www.goofish.com/",
      tabId: "other-account-tab",
      adapterVersion: "adapter-v1",
      accountLabel: "另一个账号",
      accountFingerprint: "c".repeat(64),
      accountIdentitySource: "page-header",
      accountBindingEligible: true,
      domFingerprint: "d".repeat(64)
    });

    expect(readCalibration(db).stage).toBe("LOCKED");
    expect(db.getSetting("automation_paused")).toBe("true");
    expect(db.getAccountStatus()).toBe("DEGRADED");
    db.close();
  });

  it("renews an active pairing on heartbeat and closes a connection that stopped heartbeating", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T00:00:00.000Z"));
    const { db, socket, accountFingerprint } = fixture();
    const initialExpiry = Date.parse(db.getExtensionPairingStatus().tokenExpiresAt!);
    const body = {
      pageType: "account-profile",
      pageUrl: "https://www.goofish.com/personal",
      tabId: "9",
      adapterVersion: "adapter-v1",
      accountLabel: "测试账号",
      accountFingerprint,
      accountIdentitySource: "page-header",
      accountBindingEligible: true,
      domFingerprint: "b".repeat(64)
    };

    vi.advanceTimersByTime(30_000);
    heartbeat(socket, body);
    expect(socket.readyState).toBe(1);
    expect(Date.parse(db.getExtensionPairingStatus().tokenExpiresAt!)).toBeGreaterThan(initialExpiry);

    vi.advanceTimersByTime(3 * 60_000);
    heartbeat(socket, body);
    expect(socket.readyState).toBe(3);
    expect(socket.closeCode).toBe(1008);
    expect(socket.closeReason).toBe("authorization expired");
    expect(db.getBrowserRuntime().status).toBe("offline");
    db.close();
  });

  it("stores only a normalized current message target and invalidates it when the visible target changes", () => {
    const { db, hub, socket, accountFingerprint } = fixture();
    const domFingerprint = "b".repeat(64);
    heartbeat(socket, {
      pageType: "messages",
      pageUrl: "https://www.goofish.com/im",
      tabId: "17",
      adapterVersion: "adapter-v1",
      accountLabel: "测试账号",
      accountFingerprint,
      domFingerprint,
      visibleTarget: { targetType: "message", conversationId: "conversation-1", buyerPublicId: "buyer-1", productId: "item-1" },
      visibleContext: { buyerAlias: "买家 1***1", lastInboundText: "请问今天能做吗？", token: "must-not-save", arbitrary: "ignored" }
    });
    const current = hub.getCurrentVisibleTarget();
    expect(current?.target).toMatchObject({ targetType: "message", conversationId: "conversation-1", tabId: "17", domFingerprint });
    const normalizedInbound = "请问今天能做吗?";
    expect(current?.context).toEqual({
      buyerAlias: "买家 1***1",
      lastMessagePreview: normalizedInbound,
      lastInboundText: normalizedInbound,
      lastInboundHash: createHash("sha256").update(normalizedInbound).digest("hex")
    });

    const binding = createMessageTargetBinding(current!.target);
    db.upsertPlatformTargetBinding({
      bindingType: "conversation",
      internalId: "local-conversation-1",
      accountId: "local-account",
      externalConversationId: current!.target.conversationId,
      buyerPublicId: current!.target.buyerPublicId,
      productExternalId: current!.target.productId,
      pageUrl: current!.target.pageUrl,
      tabId: current!.target.tabId,
      accountFingerprint: current!.target.accountFingerprint,
      domFingerprint: current!.target.domFingerprint,
      adapterVersion: current!.target.adapterVersion,
      observedAt: current!.target.observedAt,
      bindingFingerprint: binding.preconditionFingerprint,
      status: "CONFIRMED"
    });
    expect(hub.validateBoundTarget("conversation", "local-conversation-1").ok).toBe(true);

    heartbeat(socket, {
      pageType: "messages", pageUrl: "https://www.goofish.com/im", tabId: "17", adapterVersion: "adapter-v1",
      accountLabel: "测试账号", accountFingerprint, domFingerprint,
      visibleTarget: { targetType: "message", conversationId: "conversation-2", buyerPublicId: "buyer-1", productId: "item-1" }
    });
    const mismatch = hub.validateBoundTarget("conversation", "local-conversation-1");
    expect(mismatch.ok).toBe(false);
    expect(mismatch.ok ? "" : mismatch.reason).toContain("conversationId");

    heartbeat(socket, {
      pageType: "messages", pageUrl: "https://www.goofish.com/im", tabId: "17", adapterVersion: "adapter-v1",
      accountLabel: "测试账号", accountFingerprint, domFingerprint,
      visibleTarget: { targetType: "message", conversationId: "conversation-2", buyerPublicId: "buyer-1", productId: "item-1", accessToken: "reject" }
    });
    expect(hub.getCurrentVisibleTarget()).toBeNull();
    socket.close();
    db.close();
  });

  it("requires an exact confirmed order binding including amount before a delivery action can be authorized", () => {
    const { db, hub, socket, accountFingerprint } = fixture();
    const domFingerprint = "c".repeat(64);
    heartbeat(socket, {
      pageType: "delivery",
      pageUrl: "https://www.goofish.com/bought",
      tabId: "23",
      adapterVersion: "adapter-v1",
      accountLabel: "测试账号",
      accountFingerprint,
      domFingerprint,
      visibleTarget: {
        targetType: "order", conversationId: "conversation-1", buyerPublicId: "buyer-1", productId: "item-1",
        orderId: "order-1", amount: "29.90", currency: "CNY"
      }
    });
    const current = hub.getCurrentVisibleTarget()!;
    const binding = createOrderTargetBinding(current.target);
    db.upsertPlatformTargetBinding({
      bindingType: "order",
      internalId: "local-order-1",
      accountId: "local-account",
      externalConversationId: current.target.conversationId,
      externalOrderId: current.target.targetType === "order" ? current.target.orderId : undefined,
      buyerPublicId: current.target.buyerPublicId,
      productExternalId: current.target.productId,
      amountCents: current.target.targetType === "order" ? platformAmountToCents(current.target.amount) : undefined,
      pageUrl: current.target.pageUrl,
      tabId: current.target.tabId,
      accountFingerprint: current.target.accountFingerprint,
      domFingerprint: current.target.domFingerprint,
      adapterVersion: current.target.adapterVersion,
      observedAt: current.target.observedAt,
      bindingFingerprint: binding.preconditionFingerprint,
      status: "CONFIRMED"
    });
    expect(hub.validateBoundTarget("order", "local-order-1").ok).toBe(true);

    heartbeat(socket, {
      pageType: "delivery", pageUrl: "https://www.goofish.com/bought", tabId: "23", adapterVersion: "adapter-v1",
      accountLabel: "测试账号", accountFingerprint, domFingerprint,
      visibleTarget: {
        targetType: "order", conversationId: "conversation-1", buyerPublicId: "buyer-1", productId: "item-1",
        orderId: "order-1", amount: "39.90", currency: "CNY"
      }
    });
    const mismatch = hub.validateBoundTarget("order", "local-order-1");
    expect(mismatch.ok).toBe(false);
    expect(mismatch.ok ? "" : mismatch.reason).toContain("amount");
    socket.close();
    db.close();
  });

  it("advances message calibration only after an exact successful target receipt", () => {
    const { db, hub, socket, accountFingerprint } = fixture();
    const domFingerprint = "d".repeat(64);
    const pageBinding = {
      pageType: "messages",
      pageUrl: "https://www.goofish.com/im",
      tabId: "41",
      adapterVersion: "adapter-v1",
      accountLabel: "测试账号",
      accountFingerprint,
      domFingerprint,
      observedAt: new Date().toISOString()
    };
    heartbeat(socket, {
      ...pageBinding,
      visibleTarget: { targetType: "message", conversationId: "conversation-receipt", buyerPublicId: "buyer-receipt", productId: "item-receipt" },
      visibleContext: { lastInboundText: "请问什么时候能完成？" }
    });
    const current = hub.getCurrentVisibleTarget()!;
    const binding = createMessageTargetBinding(current.target);
    const product = db.listProducts()[0]!;
    const captured = db.captureRealConversation({
      productId: product.id,
      buyerAlias: "买家 R***1",
      initialInboundMessage: current.context.lastInboundText,
      binding: {
        accountId: "local-account",
        externalConversationId: current.target.conversationId,
        buyerPublicId: current.target.buyerPublicId,
        productExternalId: current.target.productId,
        pageUrl: current.target.pageUrl,
        tabId: current.target.tabId,
        accountFingerprint: current.target.accountFingerprint,
        domFingerprint: current.target.domFingerprint,
        adapterVersion: current.target.adapterVersion,
        observedAt: current.target.observedAt,
        bindingFingerprint: binding.preconditionFingerprint,
        status: "CONFIRMED"
      }
    });
    const latestInbound = db.getLatestInboundMessage(captured.id)!;
    const actionId = "controlled-reply-receipt";
    db.enqueueAction({
      actionId,
      actionType: "SEND_REPLY",
      targetId: captured.id,
      risk: "medium",
      idempotencyKey: actionId,
      preconditionFingerprint: binding.preconditionFingerprint,
      payload: {
        conversationId: captured.id,
        body: "收到，我先核对材料后给你明确时间。",
        latestInboundMessageId: String(latestInbound.id),
        latestInboundMessageHash: createHash("sha256").update(String(latestInbound.body)).digest("hex"),
        pageBinding: { ...pageBinding, observedAt: current.target.observedAt },
        platformTargetBinding: { internalId: captured.id, ...binding },
        controlledTest: true
      },
      status: "WAITING_APPROVAL"
    }, "MANAGED_BROWSER");
    const prepared = db.getAction(actionId)!;
    expect(hub.validateActionTarget(prepared).ok).toBe(true);
    const changedAt = new Date().toISOString();
    heartbeat(socket, {
      ...pageBinding,
      observedAt: changedAt,
      visibleTarget: { targetType: "message", conversationId: "conversation-receipt", buyerPublicId: "buyer-receipt", productId: "item-receipt" },
      visibleContext: { lastInboundText: "我刚补充了一条新要求。" }
    });
    const changed = hub.validateActionTarget(prepared);
    expect(changed.ok).toBe(false);
    expect(changed.ok ? "" : changed.reason).toContain("更新了消息");
    heartbeat(socket, {
      ...pageBinding,
      observedAt: new Date().toISOString(),
      visibleTarget: { targetType: "message", conversationId: "conversation-receipt", buyerPublicId: "buyer-receipt", productId: "item-receipt" },
      visibleContext: { lastInboundText: "请问什么时候能完成?" }
    });
    expect(db.approveAction(actionId)).toBe(true);
    hub.requestWork();
    const commandFrame = socket.sent.map((value) => JSON.parse(value)).findLast((value) => value.type === "command");
    expect(commandFrame.command.preconditionFingerprint).toBe(domFingerprint);
    expect(db.getAction(actionId)?.status).toBe("EXECUTING");

    socket.emit("message", JSON.stringify({
      type: "receipt",
      receipt: {
        commandId: actionId,
        status: "ok",
        pageType: "messages",
        domFingerprint,
        summary: "回复已发送",
        pageUrl: pageBinding.pageUrl,
        tabId: pageBinding.tabId,
        adapterVersion: pageBinding.adapterVersion,
        accountLabel: pageBinding.accountLabel,
        accountFingerprint,
        visibleTarget: { ...current.target, observedAt: new Date().toISOString() },
        actionEvidence: { kind: "new-matching-outbound-message" },
        timestamp: new Date().toISOString()
      }
    }));
    expect(db.getAction(actionId)?.status).toBe("SUCCEEDED");
    expect(db.getPlatformTargetBinding("conversation", captured.id)?.status).toBe("TEST_VERIFIED");
    expect(readCalibration(db).stage).toBe("MESSAGE_TEST_VERIFIED");
    socket.close();
    db.close();
  });
});

describe("managed browser action success evidence", () => {
  it("rejects missing or mismatched evidence even when the extension reports success", () => {
    expect(verifyReceiptActionEvidence("SEND_REPLY", {}, undefined)).toBeUndefined();
    expect(verifyReceiptActionEvidence("SEND_REPLY", {}, { kind: "clicked-send-button" })).toBeUndefined();
    expect(verifyReceiptActionEvidence("PUBLISH_LISTING", {}, { kind: "new-item-navigation", externalItemId: "" })).toBeUndefined();
    expect(verifyReceiptActionEvidence("PUBLISH_LISTING", {}, {
      kind: "new-item-navigation",
      externalItemId: "item-verified-1"
    })).toEqual({ kind: "new-item-navigation", externalItemId: "item-verified-1" });

    const deliveryPayload = {
      platformTargetBinding: {
        bindingType: "order",
        target: { orderId: "approved-order-1" }
      }
    };
    expect(verifyReceiptActionEvidence("SEND_DELIVERY", deliveryPayload, {
      kind: "order-scoped-delivery-status",
      orderId: "another-order"
    })).toBeUndefined();
    expect(verifyReceiptActionEvidence("SEND_DELIVERY", deliveryPayload, {
      kind: "order-scoped-delivery-status",
      orderId: "approved-order-1"
    })).toEqual({ kind: "order-scoped-delivery-status", orderId: "approved-order-1" });
  });
});
