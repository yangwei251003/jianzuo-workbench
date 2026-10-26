import { describe, expect, it } from "vitest";
import type { Product } from "@jianzuo/contracts";
import { generateContentBundle, PRODUCT_CONTENT_PROFILES, validateContentBundle } from "./content.js";
import { PRODUCT_SEEDS } from "./products.js";

const product: Product = {
  id: "p1", accountId: "local-account", slug: "image-text-edit", category: "图片", name: "图片文字替换微调",
  prices: [4.9, 12.9, 29.9], releaseDay: 1, readiness: "PLANNED", remoteService: false,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
};

describe("content bundle", () => {
  it("creates six images and factual white-description copy", () => {
    const bundle = generateContentBundle(product);
    expect(bundle.imagePlan).toHaveLength(6);
    expect(bundle.description).toContain("先把材料发来");
    expect(validateContentBundle(bundle)).toEqual([]);
  });

  it("rejects a changed floor or a description price that no longer matches the tiers", () => {
    const wrongFloor = generateContentBundle(product);
    wrongFloor.priceTiers[0]!.floorPrice = wrongFloor.priceTiers[0]!.price;
    expect(validateContentBundle(wrongFloor)).toContain("价格底线不一致");

    const wrongCopy = generateContentBundle(product);
    wrongCopy.description = wrongCopy.description.replace("基础档 4.9 元", "基础档 0.1 元");
    expect(validateContentBundle(wrongCopy)).toContain("详情文案与价格档不一致");
  });

  it("validates FAQ structure before it can be used for deterministic replies", () => {
    const emptyAnswer = generateContentBundle(product);
    emptyAnswer.faq[0]!.answer = "";
    expect(validateContentBundle(emptyAnswer)).toContain("FAQ 问题或答案为空");

    const duplicate = generateContentBundle(product);
    duplicate.faq[1]!.question = ` ${duplicate.faq[0]!.question} `;
    expect(validateContentBundle(duplicate)).toContain("FAQ 问题重复");

    const riskyAnswer = generateContentBundle(product);
    riskyAnswer.faq[0] = { question: "怎么登录？", answer: "把短信验证码发给我。" };
    expect(validateContentBundle(riskyAnswer).some((issue) => issue.startsWith("FAQ 包含必须人工接管内容"))).toBe(true);
  });

  it("has an explicit, complete profile for every one of the 24 launch products", () => {
    const expectedSlugs = PRODUCT_SEEDS.map((seed) => seed.slug).sort();
    expect(expectedSlugs).toHaveLength(24);
    expect(Object.keys(PRODUCT_CONTENT_PROFILES).sort()).toEqual(expectedSlugs);

    for (const seed of PRODUCT_SEEDS) {
      const profile = PRODUCT_CONTENT_PROFILES[seed.slug];
      expect(profile, seed.slug).toBeDefined();
      expect(profile!.summary.length, seed.slug).toBeGreaterThan(18);
      expect(profile!.servicePoints.length, seed.slug).toBeGreaterThanOrEqual(2);
      expect(profile!.tierScopes, seed.slug).toHaveLength(3);
      expect(new Set(profile!.tierScopes).size, seed.slug).toBe(3);
      expect(profile!.materials.length, seed.slug).toBeGreaterThanOrEqual(4);
      expect(profile!.materials.some((item) => item.required), seed.slug).toBe(true);
      expect(new Set(profile!.materials.map((item) => item.id)).size, seed.slug).toBe(profile!.materials.length);
      expect(profile!.caseBrief.length, seed.slug).toBeGreaterThan(24);
      expect(profile!.deliveryChecks.length, seed.slug).toBeGreaterThanOrEqual(3);
    }
  });

  it.each(PRODUCT_SEEDS)("generates specific, valid content for $slug", (seed) => {
    const now = new Date().toISOString();
    const launchProduct: Product = {
      id: `product-${seed.slug}`,
      accountId: "local-account",
      slug: seed.slug,
      category: seed.category,
      name: seed.name,
      prices: seed.prices,
      releaseDay: seed.releaseDay,
      readiness: "PLANNED",
      remoteService: seed.remoteService ?? false,
      createdAt: now,
      updatedAt: now
    };
    const profile = PRODUCT_CONTENT_PROFILES[seed.slug]!;
    const bundle = generateContentBundle(launchProduct);

    expect(validateContentBundle(bundle)).toEqual([]);
    expect(bundle.description).toContain(profile.summary);
    for (const point of profile.servicePoints) expect(bundle.description).toContain(point);
    expect(bundle.priceTiers.map((tier) => tier.price)).toEqual(seed.prices);
    expect(bundle.priceTiers.map((tier) => tier.floorPrice)).toEqual(seed.prices.map((price) => Math.round(price * 90) / 100));
    expect(bundle.priceTiers.map((tier) => tier.revisions)).toEqual([1, 2, 3]);
    expect(bundle.priceTiers.map((tier) => tier.scope)).toEqual(profile.tierScopes);
    expect(bundle.materials).toEqual(profile.materials);
    expect(bundle.materials).not.toBe(profile.materials);
    expect(bundle.imagePlan[1].brief).toBe(profile.caseBrief);
    for (const check of profile.deliveryChecks) expect(bundle.deliveryPlan.checklist).toContain(check);

    if (seed.remoteService) {
      expect(bundle.deliveryPlan.mode).toBe("remote_service");
      expect(bundle.deliveryPlan.packageRequired).toBe(false);
      expect(bundle.description).toContain("操作由人工完成");
      expect(bundle.description).toContain("不保存密码、验证码或远控码");
    } else {
      expect(bundle.deliveryPlan.mode).toBe("platform_attachment");
      expect(bundle.deliveryPlan.packageRequired).toBe(true);
    }
    if (["工具", "前端"].includes(seed.category)) expect(bundle.complianceFlags.join("\n")).toContain("许可证");
    else expect(bundle.complianceFlags).toEqual([]);
  });

  it("keeps hard compliance boundaries in the affected product copy", () => {
    expect(PRODUCT_CONTENT_PROFILES["authorized-cleanup"]!.boundaries?.join("\n")).toContain("第三方平台水印");
    expect(PRODUCT_CONTENT_PROFILES["local-pdf-toolkit"]!.boundaries?.join("\n")).toContain("不破解 PDF 密码");
    expect(PRODUCT_CONTENT_PROFILES["resume-layout"]!.boundaries?.join("\n")).toContain("不编造学历");

    for (const slug of ["codex-cli-setup", "openclaw-setup", "docker-compose-setup", "remote-troubleshooting"]) {
      const profile = PRODUCT_CONTENT_PROFILES[slug]!;
      expect(profile.materials.some((item) => item.id === "consent" && item.required), slug).toBe(true);
      expect(profile.deliveryChecks.join("\n"), slug).toContain("人工确认");
    }
  });
});
