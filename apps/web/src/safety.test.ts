import { describe, expect, it } from "vitest";
import { codexAccountTitle, publishActionLabel, publishApprovalLabel } from "./safety.js";

describe("safety-facing labels", () => {
  it("never describes a mock publication as a real submission", () => {
    expect(publishActionLabel("PUBLISH_LISTING", "WAITING_APPROVAL", "MOCK")).toBe("模拟提交 · 待审批");
    expect(publishApprovalLabel("PUBLISH_LISTING", "MOCK")).toBe("批准模拟发布");
    expect(publishActionLabel("PUBLISH_LISTING", "SUCCEEDED", "MANAGED_BROWSER")).toBe("真实提交 · 成功");
    expect(publishApprovalLabel("PUBLISH_LISTING", "MANAGED_BROWSER")).toBe("批准真实发布");
  });

  it("does not put the signed-in email address into the interface", () => {
    const title = codexAccountTitle({ account: { email: "private@example.com" } });
    expect(title).toBe("ChatGPT 账号已连接");
    expect(title).not.toContain("private@example.com");
  });

  it("keeps a non-personal plan label when it is available", () => {
    expect(codexAccountTitle({ account: { email: "private@example.com", planType: "Plus" } })).toBe("ChatGPT Plus");
  });
});

