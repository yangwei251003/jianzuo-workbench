import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildDeliveryPackage } from "./delivery.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createRoot(): string {
  const root = mkdtempSync(resolve(tmpdir(), "jianzuo-delivery-"));
  roots.push(root);
  return root;
}

describe("delivery license gate", () => {
  it("blocks a real downloadable tool when its license review is missing", async () => {
    const root = createRoot();
    await expect(buildDeliveryPackage(root, {
      id: "ORDER-001", product_name: "本地 PDF 工具箱", product_category: "工具", tier: "基础", revision_limit: 1
    })).rejects.toThrow("许可证审查未通过：缺少许可证");
  });

  it("writes the reviewed license statement into a real tool package", async () => {
    const root = createRoot();
    const work = resolve(root, "artifacts", "orders", "ORDER-002", "work");
    mkdirSync(work, { recursive: true });
    writeFileSync(resolve(work, "tool.txt"), "safe test artifact\n", "utf8");
    const packaged = await buildDeliveryPackage(root, {
      id: "ORDER-002", product_name: "本地 PDF 工具箱", product_category: "工具", tier: "基础", revision_limit: 1,
      license_review: "ORIGINAL-DEPENDENCIES-REVIEWED"
    });
    const statement = readFileSync(resolve(packaged.packageDir, "05_LICENSE与原作者声明", "LICENSE说明.txt"), "utf8");
    expect(statement).toContain("ORIGINAL-DEPENDENCIES-REVIEWED");
    expect(statement).toContain("第三方许可证");
  });
});
