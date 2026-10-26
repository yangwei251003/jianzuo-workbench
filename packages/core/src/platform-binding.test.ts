import { describe, expect, it } from "vitest";
import {
  createMessageTargetBinding,
  createOrderTargetBinding,
  normalizeMessageTarget,
  normalizePlatformAmount,
  platformAmountToCents,
  validateMessageTargetBinding,
  validateOrderTargetBinding
} from "./platform-binding.js";

const NOW = "2026-08-31T12:00:00.000Z";

function messageTarget(overrides: Record<string, unknown> = {}) {
  return {
    targetType: "message",
    conversationId: "conversation-1001",
    buyerPublicId: "买家甲#8831",
    productId: "product-24",
    pageUrl: "https://www.goofish.com/im?spm=listing#chat",
    tabId: "0088",
    accountFingerprint: "A".repeat(64),
    domFingerprint: "B".repeat(64),
    adapterVersion: "goofish-dom-v4",
    observedAt: NOW,
    ...overrides
  };
}

function orderTarget(overrides: Record<string, unknown> = {}) {
  return {
    targetType: "order",
    conversationId: "conversation-1001",
    buyerPublicId: "买家甲#8831",
    productId: "product-24",
    orderId: "order-9001",
    amount: "￥29.9 元",
    currency: "CNY",
    pageUrl: "https://www.goofish.com/order/detail?spm=orders#detail",
    tabId: "88",
    accountFingerprint: "a".repeat(64),
    domFingerprint: "b".repeat(64),
    adapterVersion: "goofish-dom-v4",
    observedAt: NOW,
    ...overrides
  };
}

describe("visible platform target normalization", () => {
  it("removes benign URL query parameters and fragments before hashing", () => {
    const normalized = normalizeMessageTarget(messageTarget());
    expect(normalized.pageUrl).toBe("https://www.goofish.com/im");
    expect(normalized.tabId).toBe("88");
    expect(normalized.accountFingerprint).toBe("a".repeat(64));
    const first = createMessageTargetBinding(messageTarget());
    const second = createMessageTargetBinding(messageTarget({ pageUrl: "https://WWW.GOOFISH.COM/im?from=other" }));
    expect(first.preconditionFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(second.preconditionFingerprint).toBe(first.preconditionFingerprint);
  });

  it("normalizes order amounts without floating point comparison", () => {
    expect(normalizePlatformAmount(29.9)).toBe("29.90");
    expect(normalizePlatformAmount("¥1,299.00 CNY")).toBe("1299.00");
    expect(platformAmountToCents("29.90元")).toBe(2990);
  });

  it.each([
    [{ ...messageTarget(), cookie: "forbidden" }, "RISK_FIELD"],
    [{ ...messageTarget(), access_token: "forbidden" }, "RISK_FIELD"],
    [messageTarget({ pageUrl: "https://www.goofish.com/im?token=forbidden" }), "RISK_FIELD"],
    [messageTarget({ pageUrl: "https://www.goofish.com/im#access_token=forbidden" }), "RISK_FIELD"],
    [messageTarget({ pageUrl: "https://evil.example/im" }), "INVALID_URL"]
  ])("rejects risky or non-platform input", (target, code) => {
    const result = validateMessageTargetBinding(createMessageTargetBinding(messageTarget()), target, { now: NOW });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors[0]?.code).toBe(code);
  });
});

describe("message target binding", () => {
  it("accepts only the same fresh visible conversation target", () => {
    const binding = createMessageTargetBinding(messageTarget());
    const result = validateMessageTargetBinding(binding, messageTarget({ observedAt: "2026-08-31T12:00:20.000Z" }), {
      now: "2026-08-31T12:00:30.000Z"
    });
    expect(result).toMatchObject({ valid: true, preconditionFingerprint: binding.preconditionFingerprint });
  });

  it("allows the DOM fingerprint to change after a write while retaining exact target identity", () => {
    const binding = createMessageTargetBinding(messageTarget());
    const result = validateMessageTargetBinding(binding, messageTarget({
      domFingerprint: "d".repeat(64),
      observedAt: "2026-08-31T12:00:20.000Z"
    }), { now: "2026-08-31T12:00:30.000Z" });
    expect(result).toMatchObject({ valid: true, preconditionFingerprint: binding.preconditionFingerprint });
  });

  it("fails closed when an observed message belongs to another conversation", () => {
    const binding = createMessageTargetBinding(messageTarget());
    const result = validateMessageTargetBinding(binding, messageTarget({ conversationId: "conversation-OTHER" }), { now: NOW });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors).toContainEqual(expect.objectContaining({ code: "TARGET_MISMATCH", field: "target.conversationId" }));
  });

  it("fails closed on missing fields and a tampered precondition fingerprint", () => {
    const binding = createMessageTargetBinding(messageTarget());
    const { buyerPublicId: _removed, ...missingBuyer } = messageTarget();
    const missing = validateMessageTargetBinding(binding, missingBuyer, { now: NOW });
    expect(missing.valid).toBe(false);
    if (!missing.valid) expect(missing.errors[0]).toMatchObject({ code: "MISSING_FIELD", field: "target.buyerPublicId" });

    const tampered = validateMessageTargetBinding({ ...binding, preconditionFingerprint: "f".repeat(64) }, messageTarget(), { now: NOW });
    expect(tampered.valid).toBe(false);
    if (!tampered.valid) expect(tampered.errors[0]?.code).toBe("FINGERPRINT_MISMATCH");
  });

  it("rejects a stale page heartbeat", () => {
    const binding = createMessageTargetBinding(messageTarget());
    const result = validateMessageTargetBinding(binding, messageTarget(), { now: "2026-08-31T12:00:45.001Z" });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors).toContainEqual(expect.objectContaining({ code: "STALE_OBSERVATION" }));
  });
});

describe("order target binding", () => {
  it("accepts an exact fresh order target", () => {
    const binding = createOrderTargetBinding(orderTarget());
    const result = validateOrderTargetBinding(binding, orderTarget({ amount: "29.90", observedAt: "2026-08-31T12:00:10.000Z" }), {
      now: "2026-08-31T12:00:20.000Z"
    });
    expect(result).toMatchObject({ valid: true, target: { amount: "29.90", orderId: "order-9001" } });
  });

  it("rejects an amount mismatch even when all order identifiers match", () => {
    const binding = createOrderTargetBinding(orderTarget());
    const result = validateOrderTargetBinding(binding, orderTarget({ amount: "29.89" }), { now: NOW });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors).toContainEqual(expect.objectContaining({ code: "TARGET_MISMATCH", field: "target.amount" }));
  });

  it("fails closed when an order identifier is missing", () => {
    const binding = createOrderTargetBinding(orderTarget());
    const { orderId: _removed, ...missingOrderId } = orderTarget();
    const result = validateOrderTargetBinding(binding, missingOrderId, { now: NOW });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors[0]).toMatchObject({ code: "MISSING_FIELD", field: "target.orderId" });
  });

  it.each([
    ["orderId", "order-OTHER"],
    ["productId", "product-OTHER"],
    ["buyerPublicId", "买家乙#5520"],
    ["accountFingerprint", "c".repeat(64)],
    ["adapterVersion", "goofish-dom-v5"],
    ["tabId", "99"]
  ])("rejects drift in %s", (field, value) => {
    const binding = createOrderTargetBinding(orderTarget());
    const result = validateOrderTargetBinding(binding, orderTarget({ [field]: value }), { now: NOW });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors).toContainEqual(expect.objectContaining({ code: "TARGET_MISMATCH", field: `target.${field}` }));
  });
});
