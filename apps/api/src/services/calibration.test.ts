import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkbenchDatabase } from "@jianzuo/database";
import { advanceCalibration, validateManagedBrowserBinding } from "./calibration.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "jianzuo-calibration-"));
  roots.push(root);
  const db = new WorkbenchDatabase(join(root, "test.sqlite"));
  db.seed();
  const observedAt = new Date().toISOString();
  const domFingerprint = "a".repeat(64);
  db.setBrowserRuntime("online", { connector: "MANAGED_BROWSER", pageType: "listing-create", domFingerprint });
  const binding = {
    pageType: "listing-create", pageUrl: "https://www.goofish.com/publish", tabId: "27",
    adapterVersion: "adapter-v1", accountLabel: "测试账号", accountFingerprint: "b".repeat(64), domFingerprint, observedAt
  };
  db.setSetting("browser_page_meta", JSON.stringify(binding));
  advanceCalibration(db, "ACCOUNT_CONFIRMED", binding);
  return { db, binding, observedAt };
}

describe("managed browser account binding", () => {
  it("accepts only the fresh page, account, adapter and DOM snapshot that was approved", () => {
    const { db, binding, observedAt } = fixture();
    expect(validateManagedBrowserBinding(db, {
      requiredStage: "ACCOUNT_CONFIRMED", expectedPageTypes: ["listing-create"], expectedBinding: binding,
      nowMs: Date.parse(observedAt) + 10_000
    }).ok).toBe(true);
    db.close();
  });

  it("fails closed after 45 seconds or when the visible account changes", () => {
    const { db, binding, observedAt } = fixture();
    const stale = validateManagedBrowserBinding(db, {
      expectedBinding: binding, nowMs: Date.parse(observedAt) + 45_001
    });
    expect(stale).toMatchObject({ ok: false });
    expect(stale.ok ? "" : stale.reason).toContain("45 秒");

    db.setSetting("browser_page_meta", JSON.stringify({ ...binding, accountLabel: "另一个账号", observedAt: new Date().toISOString() }));
    db.setBrowserRuntime("online", { connector: "MANAGED_BROWSER", pageType: "listing-create", domFingerprint: binding.domFingerprint });
    const mismatch = validateManagedBrowserBinding(db, { expectedPageTypes: ["listing-create"] });
    expect(mismatch).toMatchObject({ ok: false });
    expect(mismatch.ok ? "" : mismatch.reason).toContain("账号");
    db.close();
  });
});
