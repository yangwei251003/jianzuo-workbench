import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ContentBundle, Product } from "@jianzuo/contracts";
import { generateContentBundle } from "@jianzuo/core";
import { verifyCodexCopyArtifact } from "./codex-copy-artifact.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function product(): Product {
  return {
    id: "product-1",
    accountId: "local-account",
    slug: "image-text-edit",
    category: "图片",
    name: "图片文字替换微调",
    prices: [4.9, 12.9, 29.9],
    releaseDay: 1,
    readiness: "CONTENT_READY",
    remoteService: false,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
}

function validCandidate(bundle: ContentBundle): Record<string, unknown> {
  return {
    titleCandidates: ["图片文字微调｜4.9元起", "图片文字替换｜先看原图", "图片小改动｜范围确认后开工"],
    selectedTitle: "图片文字微调｜4.9元起",
    description: [
      "改图片里的文字、数字或小范围排版。先把原图和要替换的内容发来，我先看清楚再确认能不能做。",
      `三档范围：基础档 ${bundle.priceTiers[0]!.price} 元，${bundle.priceTiers[0]!.scope}；标准档 ${bundle.priceTiers[1]!.price} 元，${bundle.priceTiers[1]!.scope}；进阶档 ${bundle.priceTiers[2]!.price} 元，${bundle.priceTiers[2]!.scope}。`,
      "基础、标准、进阶分别含 1、2、3 次同范围修改。内容方向变了，需要重新看范围和价格。",
      "交付前会检查图片是否能正常打开。不接侵权、凭证造假或没有授权的修改。"
    ].join("\n\n"),
    faq: [
      { question: "要准备什么？", answer: "发原图、替换后的准确文字和想保留的尺寸。" },
      { question: "多久能好？", answer: "看完图片后确认时间，复杂排版不会没看就承诺。" },
      { question: "能修改几次？", answer: "按基础、标准、进阶档分别含 1、2、3 次同范围修改。" }
    ]
  };
}

function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), "jianzuo-codex-copy-"));
  roots.push(root);
  const candidatesRoot = resolve(root, "artifacts", "codex-copy-candidates", "image-text-edit");
  mkdirSync(candidatesRoot, { recursive: true });
  const candidatePath = resolve(candidatesRoot, "v1-candidate.json");
  const sourceBundle = generateContentBundle(product());
  return { root, candidatesRoot, candidatePath, sourceBundle };
}

describe("Codex copy artifact verification", () => {
  it("rejects a candidate path outside the controlled root", async () => {
    const data = fixture();
    const outside = resolve(data.root, "outside.json");
    writeFileSync(outside, JSON.stringify(validCandidate(data.sourceBundle)));

    const verification = await verifyCodexCopyArtifact({
      candidatesRoot: data.candidatesRoot,
      candidatePath: outside,
      sourceVersion: 1,
      sourceBundle: data.sourceBundle
    });

    expect(verification.status).toBe("needs_user");
    expect(verification.data).toMatchObject({ reason: "INVALID_PATH" });
  });

  it("rejects invalid JSON without changing the source bundle", async () => {
    const data = fixture();
    writeFileSync(data.candidatePath, "{not-json", "utf8");
    const before = structuredClone(data.sourceBundle);

    const verification = await verifyCodexCopyArtifact({
      candidatesRoot: data.candidatesRoot,
      candidatePath: data.candidatePath,
      sourceVersion: 1,
      sourceBundle: data.sourceBundle
    });

    expect(verification.data).toMatchObject({ reason: "INVALID_JSON" });
    expect(data.sourceBundle).toEqual(before);
  });

  it("rejects changed prices and banned copy", async () => {
    const changedPrice = fixture();
    const changedPriceCandidate = validCandidate(changedPrice.sourceBundle);
    changedPriceCandidate.description = `${String(changedPriceCandidate.description)}\n\n另有 1 元体验价。`;
    writeFileSync(changedPrice.candidatePath, JSON.stringify(changedPriceCandidate));
    const priceVerification = await verifyCodexCopyArtifact({
      candidatesRoot: changedPrice.candidatesRoot,
      candidatePath: changedPrice.candidatePath,
      sourceVersion: 1,
      sourceBundle: changedPrice.sourceBundle
    });
    expect(priceVerification.data).toMatchObject({ reason: "PRICE_CHANGED" });

    const bannedCopy = fixture();
    const bannedCandidate = validCandidate(bannedCopy.sourceBundle);
    bannedCandidate.titleCandidates = ["一站式解决图片改字｜4.9元起", "图片文字替换｜先看原图", "图片小改动｜范围确认后开工"];
    bannedCandidate.selectedTitle = "一站式解决图片改字｜4.9元起";
    writeFileSync(bannedCopy.candidatePath, JSON.stringify(bannedCandidate));
    const bannedVerification = await verifyCodexCopyArtifact({
      candidatesRoot: bannedCopy.candidatesRoot,
      candidatePath: bannedCopy.candidatePath,
      sourceVersion: 1,
      sourceBundle: bannedCopy.sourceBundle
    });
    expect(bannedVerification.data).toMatchObject({ reason: "BANNED_COPY" });
  });

  it("combines only approved copy fields and preserves operational facts", async () => {
    const data = fixture();
    const candidate = validCandidate(data.sourceBundle);
    writeFileSync(data.candidatePath, JSON.stringify(candidate));

    const verification = await verifyCodexCopyArtifact({
      candidatesRoot: data.candidatesRoot,
      candidatePath: data.candidatePath,
      sourceVersion: 7,
      sourceBundle: data.sourceBundle
    });

    expect(verification.status).toBe("ok");
    expect(verification.data).toMatchObject({ candidate, sourceVersion: 7 });
    const accepted = verification.data as { bundle: ContentBundle };
    expect(accepted.bundle.titleCandidates).toEqual(candidate.titleCandidates);
    expect(accepted.bundle.priceTiers).toEqual(data.sourceBundle.priceTiers);
    expect(accepted.bundle.materials).toEqual(data.sourceBundle.materials);
    expect(accepted.bundle.imagePlan).toEqual(data.sourceBundle.imagePlan);
    expect(accepted.bundle.deliveryPlan).toEqual(data.sourceBundle.deliveryPlan);
    expect(accepted.bundle.claims).toEqual(data.sourceBundle.claims);
    expect(accepted.bundle.complianceFlags).toEqual(data.sourceBundle.complianceFlags);
  });
});
