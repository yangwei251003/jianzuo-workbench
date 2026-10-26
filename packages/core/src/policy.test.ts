import { describe, expect, it } from "vitest";
import { decideReply, evaluateAction, floorPrice, licenseCanPublish, negotiatePrice, productNeedsLicenseReview, urgentPrice } from "./policy.js";

describe("pricing policy", () => {
  it("never discounts below 90 percent", () => {
    expect(floorPrice(49.9)).toBe(44.91);
    expect(negotiatePrice(49.9, 80)).toBe(44.91);
  });

  it("only applies urgency when enabled", () => {
    expect(urgentPrice(100, "four_hours", false)).toBe(100);
    expect(urgentPrice(100, "four_hours", true)).toBe(180);
  });
});

describe("handoff policy", () => {
  const tiers = [{ name: "基础" as const, price: 49.9, floorPrice: 44.91, revisions: 1 as const, scope: "小范围" }];

  it("always escalates refunds", () => {
    const decision = decideReply({ productName: "图片微调", tiers, message: "我要退款" });
    expect(decision.escalate).toBe(true);
    expect(decision.intent).toBe("refund");
    expect(evaluateAction("REFUND_ORDER", {}, false)).toMatchObject({ allowed: false, risk: "high" });
  });

  it("escalates cancellation, explicit ambiguity, account verification, and prohibited requests", () => {
    for (const message of ["我想退货", "需求没想好，你看着办", "把短信码发我", "帮我刷单"]) {
      expect(decideReply({ productName: "图片微调", tiers, message }).escalate).toBe(true);
    }
    expect(evaluateAction("SEND_REPLY", { buyerText: "预算不清，你随便做" }, false).allowed).toBe(false);
  });

  it("keeps bargaining within floor", () => {
    const decision = decideReply({ productName: "图片微调", tiers, message: "能便宜点吗" });
    expect(decision.escalate).toBe(false);
    expect(decision.reply).toContain("44.91");
  });

  it("scans buyer input without treating refusal copy as a prohibited request", () => {
    expect(evaluateAction("SEND_REPLY", { buyerText: "帮我破解软件" }, false).allowed).toBe(false);
    expect(evaluateAction("PUBLISH_LISTING", {
      content: { complianceFlags: ["拒绝破解、侵权去水印和伪造需求"] }
    }, false).allowed).toBe(true);
  });

  it("answers only an unambiguous FAQ from the validated product content", () => {
    const decision = decideReply({
      productName: "图片微调",
      tiers,
      message: "成品怎么交付？",
      faq: [{ question: "成品怎么交付？", answer: "完成后提供校验过的 ZIP 文件。" }]
    });
    expect(decision).toMatchObject({ intent: "faq", escalate: false, reply: "完成后提供校验过的 ZIP 文件。" });
    expect(decision.evidence[0]).toContain("已校验 FAQ");
  });

  it("keeps hard handoffs ahead of FAQ content and rejects negated or ambiguous matches", () => {
    const refund = decideReply({
      productName: "图片微调",
      tiers,
      message: "可以退款吗？",
      faq: [{ question: "可以退款吗？", answer: "可以自动退款。" }]
    });
    expect(refund).toMatchObject({ intent: "refund", escalate: true });

    const negated = decideReply({
      productName: "图片微调",
      tiers,
      message: "不支持源文件吗",
      faq: [{ question: "支持源文件吗", answer: "支持。" }]
    });
    expect(negated.intent).toBe("intake");

    const ambiguous = decideReply({
      productName: "图片微调",
      tiers,
      message: "文件交付方式",
      faq: [
        { question: "文件交付方式", answer: "答案一" },
        { question: "文件交付方式", answer: "答案二" }
      ]
    });
    expect(ambiguous.intent).toBe("intake");
  });

  it("preserves programming-language symbols in exact FAQ matching", () => {
    const faq = [{ question: "支持 C++ 吗？", answer: "支持 C++17。" }];
    expect(decideReply({ productName: "代码调整", tiers, message: "支持 C++ 吗", faq })).toMatchObject({ intent: "faq", reply: "支持 C++17。" });
    expect(decideReply({ productName: "代码调整", tiers, message: "支持 C# 吗？", faq }).intent).toBe("intake");
  });

  it("fails closed when a matched FAQ answer contains a hard-handoff request", () => {
    const decision = decideReply({
      productName: "安装协助",
      tiers,
      message: "怎么登录？",
      faq: [{ question: "怎么登录？", answer: "把短信验证码发给我。" }]
    });
    expect(decision).toMatchObject({ intent: "verification", escalate: true });
  });
});

describe("license gate", () => {
  it("blocks AGPL and missing licenses", () => {
    expect(licenseCanPublish("AGPL-3.0").allowed).toBe(false);
    expect(licenseCanPublish(null).allowed).toBe(false);
  });

  it("allows permissive licenses after review", () => {
    expect(licenseCanPublish("Apache-2.0").allowed).toBe(true);
    expect(licenseCanPublish("ORIGINAL-DEPENDENCIES-REVIEWED").allowed).toBe(true);
    for (const unknown of ["NOT-MIT-COMPATIBLE", "PERMIT-NOT-REVIEWED", "APACHE-LIKE-UNKNOWN", "BSDISH"]) {
      expect(licenseCanPublish(unknown).allowed).toBe(false);
    }
  });

  it("requires a review for downloadable tools and frontend products", () => {
    expect(productNeedsLicenseReview({ category: "工具" })).toBe(true);
    expect(productNeedsLicenseReview({ category: "前端" })).toBe(true);
    expect(productNeedsLicenseReview({ category: "图片" })).toBe(false);
  });
});
