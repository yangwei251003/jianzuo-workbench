import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ActionRequest } from "@jianzuo/contracts";
import { WorkbenchDatabase } from "@jianzuo/database";
import { WorkerProcessor } from "./processor.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "jianzuo-worker-"));
  dirs.push(dir);
  const db = new WorkbenchDatabase(join(dir, "test.sqlite"));
  db.seed();
  return { db, processor: new WorkerProcessor(db) };
}

describe("worker", () => {
  it("processes idempotent maintenance jobs", async () => {
    const { db, processor } = fixture();
    db.enqueueJob("HEALTH_PROBE", {}, "health");
    expect(await processor.tick()).toBe(true);
    expect(db.listJobs()[0]?.status).toBe("SUCCEEDED");
    db.close();
  });

  it("keeps unknown external results terminal", async () => {
    const { db, processor } = fixture();
    const product = db.listProducts()[0]!;
    const publicationId = db.createPublication(product.id, null, "MOCK", new Date().toISOString());
    const action: ActionRequest = {
      actionId: "unknown-action", actionType: "PUBLISH_LISTING", targetId: publicationId, risk: "high",
      idempotencyKey: "unknown-action", preconditionFingerprint: "mock", payload: { publicationId, product, simulateUnknown: true }, status: "QUEUED"
    };
    db.enqueueAction(action, "MOCK");
    await processor.tick();
    expect(db.listActions()[0]?.status).toBe("RESULT_UNKNOWN");
    db.close();
  });

  it("does not claim jobs or actions while emergency stop is active", async () => {
    const { db, processor } = fixture();
    db.enqueueJob("HEALTH_PROBE", {}, "paused-health");
    db.setSetting("automation_paused", "true");
    expect(await processor.tick()).toBe(false);
    expect(db.listJobs()[0]?.status).toBe("QUEUED");
    db.close();
  });

  it("reschedules recoverable job failures with backoff", async () => {
    const { db, processor } = fixture();
    db.enqueueJob("UNKNOWN_JOB", {}, "retry-me");
    expect(await processor.tick()).toBe(true);
    expect(db.listJobs()[0]?.status).toBe("RETRY_SCHEDULED");
    expect(new Date(String(db.listJobs()[0]?.available_at)).getTime()).toBeGreaterThan(Date.now());
    db.close();
  });

  it("periodically quarantines an expired real browser action before claiming more work", async () => {
    const { db, processor } = fixture();
    const product = db.listProducts()[0]!;
    const publicationId = db.createPublication(product.id, null, "MANAGED_BROWSER", new Date().toISOString());
    db.enqueueAction({
      actionId: "managed-watchdog", actionType: "PUBLISH_LISTING", targetId: publicationId, risk: "high",
      idempotencyKey: "managed-watchdog", preconditionFingerprint: "dom", payload: { publicationId }, status: "QUEUED"
    }, "MANAGED_BROWSER");
    expect(db.claimBrowserAction("disconnected-hub", -1)).not.toBeNull();

    const recovery = processor.recover();
    expect(recovery.managedActionsQuarantined).toBe(1);
    expect(db.getAction("managed-watchdog")?.status).toBe("RESULT_UNKNOWN");
    expect(db.getSetting("automation_paused")).toBe("true");
    expect(await processor.tick()).toBe(false);
    db.close();
  });

  it("recovers an expired mock lease and applies the simulated effect exactly once", async () => {
    const { db, processor } = fixture();
    const conversationId = String(db.listConversations()[0]!.id);
    const before = db.listMessages(conversationId).length;
    db.enqueueAction({
      actionId: "mock-recovery", actionType: "SEND_REPLY", targetId: conversationId, risk: "low",
      idempotencyKey: "mock-recovery", preconditionFingerprint: "mock", payload: { conversationId, body: "恢复后的回复" }, status: "QUEUED"
    }, "MOCK");
    expect(db.claimMockAction("crashed-mock-worker", -1)).not.toBeNull();
    expect(processor.recover().mockActionsRequeued).toBe(1);
    expect(await processor.tick()).toBe(true);
    expect(db.getAction("mock-recovery")?.status).toBe("SUCCEEDED");
    expect(db.listMessages(conversationId)).toHaveLength(before + 1);
    expect(processor.recover().mockActionsRequeued).toBe(0);
    expect(await processor.tick()).toBe(false);
    expect(db.listMessages(conversationId)).toHaveLength(before + 1);
    db.close();
  });
});
