import { hostname } from "node:os";
import { existsSync, rmSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { ActionStatus, JobStatus } from "@jianzuo/contracts";
import type { WorkbenchDatabase } from "@jianzuo/database";
import { postDpapiProtectedWebhook } from "@jianzuo/core";
import { MockConnector } from "./connectors.js";

type SqlRow = Record<string, unknown>;

export type RecoverySummary = {
  managedActionsQuarantined: number;
  mockActionsRequeued: number;
  mockActionsFailed: number;
  recoverableJobs: number;
  jobsDeadLettered: number;
};

export class WorkerProcessor {
  readonly workerId = `${hostname()}:${process.pid}`;
  private nextRecoveryAt = 0;
  constructor(
    private readonly db: WorkbenchDatabase,
    private readonly recoveryIntervalMs = 5_000,
    private readonly mockConnector = new MockConnector()
  ) {}

  recover(): RecoverySummary {
    const managedActionsQuarantined = this.db.quarantineStaleManagedBrowserActions();
    const mock = this.db.recoverExpiredMockActions();
    const jobs = this.db.recoverExpiredJobs();
    this.nextRecoveryAt = Date.now() + Math.max(250, this.recoveryIntervalMs);
    if (managedActionsQuarantined) {
      this.db.audit("local-worker", "STALE_MANAGED_ACTIONS_QUARANTINED", `已封存 ${managedActionsQuarantined} 个真实浏览器结果未知动作并暂停自动化`, {
        managedActionsQuarantined, replayAllowed: false
      });
    }
    if (mock.requeued || mock.failed) {
      this.db.audit("local-worker", "STALE_MOCK_ACTIONS_RECOVERED", "已恢复过期的模拟动作租约", mock);
    }
    if (jobs.recoverable || jobs.deadLettered) {
      this.db.audit("local-worker", "STALE_JOBS_RECOVERED", "已检查过期的本地任务租约", jobs);
    }
    return {
      managedActionsQuarantined,
      mockActionsRequeued: mock.requeued,
      mockActionsFailed: mock.failed,
      recoverableJobs: jobs.recoverable,
      jobsDeadLettered: jobs.deadLettered
    };
  }

  async tick(): Promise<boolean> {
    if (Date.now() >= this.nextRecoveryAt) this.recover();
    if (this.db.getSetting("automation_paused") === "true") return false;
    const job = this.db.claimJob(this.workerId);
    if (job) {
      await this.processJob(job);
      return true;
    }
    const action = this.db.claimMockAction(this.workerId);
    if (action) {
      await this.processAction(action);
      return true;
    }
    return false;
  }

  private async processJob(row: SqlRow): Promise<void> {
    const id = String(row.id);
    let status: JobStatus = "SUCCEEDED";
    let output: unknown = {};
    try {
      const payload = JSON.parse(String(row.payload_json || "{}")) as Record<string, unknown>;
      switch (String(row.type)) {
        case "RETENTION_CLEANUP":
          output = this.cleanupRetention();
          break;
        case "HEALTH_PROBE":
          output = { alive: true, workerId: this.workerId, payload };
          break;
        default:
          throw new Error(`未知任务类型：${String(row.type)}`);
      }
    } catch (error) {
      const attempts = Number(row.attempt ?? 1);
      const maxAttempts = Number(row.max_attempts ?? 3);
      const message = error instanceof Error ? error.message : String(error);
      status = attempts >= maxAttempts ? "DEAD_LETTER" : "RETRY_SCHEDULED";
      if (status === "RETRY_SCHEDULED") this.db.rescheduleJob(id, message, Math.min(300, 2 ** attempts * 5));
      else this.db.finishJob(id, status, undefined, message);
      this.db.audit("local-worker", "JOB_FAILED", `任务 ${id} 执行失败`, { type: row.type, status }, "job", id);
      return;
    }
    this.db.finishJob(id, status, output);
  }

  private cleanupRetention(): Record<string, number> {
    const artifactsRoot = resolve(dirname(this.db.path), "artifacts");
    let removedFiles = 0;
    for (const asset of this.db.listExpiredAssets()) {
      const target = resolve(String(asset.path));
      const pathFromRoot = relative(artifactsRoot, target);
      if (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot)) {
        if (existsSync(target)) {
          rmSync(target, { force: true });
          removedFiles += 1;
        }
        this.db.deleteAsset(String(asset.id));
      } else {
        this.db.audit("local-worker", "RETENTION_PATH_REJECTED", "到期文件路径不在受控产物目录，未删除", { assetId: asset.id }, "asset", String(asset.id));
      }
    }
    const databaseCleanup = this.db.cleanupExpired();
    return { ...databaseCleanup, assets: removedFiles };
  }

  private async processAction(row: SqlRow): Promise<void> {
    const actionId = String(row.action_id);
    const actionType = String(row.action_type);
    const payload = JSON.parse(String(row.payload_json || "{}")) as Record<string, unknown>;
    let status: ActionStatus = "SUCCEEDED";
    let output: Record<string, unknown> = { connector: "MOCK", completedAt: new Date().toISOString() };
    try {
      const execution = await this.mockConnector.execute(actionType, payload);
      status = execution.status;
      output = execution.output;
    } catch (error) {
      status = "FAILED";
      output = { ...output, error: error instanceof Error ? error.message : String(error) };
    }
    const completion = this.db.finishMockAction(actionId, status, output);
    if (!completion.completed) {
      this.db.audit("mock-connector", "LATE_MOCK_COMPLETION_IGNORED", "模拟动作已处于终态，忽略重复完成", { actionId, status }, "action", actionId);
      return;
    }
    this.db.audit("mock-connector", `ACTION_${status}`, `${actionType}：${status}`, output, "action", actionId);
    if (status === "RESULT_UNKNOWN" || status === "FAILED") {
      await notifyWindows("简作工作台需要处理", `${actionType}：${status === "RESULT_UNKNOWN" ? "结果未知，已停止重试" : "执行失败"}`);
      await notifyWebhook(this.db, actionType, status);
    }
  }
}

async function notifyWebhook(db: WorkbenchDatabase, actionType: string, status: "RESULT_UNKNOWN" | "FAILED"): Promise<void> {
  const ciphertext = db.getSetting("webhook_worker_url");
  if (!ciphertext) return;
  try {
    await postDpapiProtectedWebhook(ciphertext, {
      event: status === "RESULT_UNKNOWN" ? "ACTION_RESULT_UNKNOWN" : "ACTION_FAILED",
      severity: "critical",
      summary: `${actionType}：${status === "RESULT_UNKNOWN" ? "结果未知，已停止重试" : "执行失败，需要人工检查"}`,
      occurredAt: new Date().toISOString()
    });
    db.audit("local-worker", "WEBHOOK_SENT", "高风险动作 Webhook 已发送", { actionType, status });
  } catch (error) {
    db.audit("local-worker", "WEBHOOK_FAILED", "高风险动作 Webhook 发送失败", { actionType, status, error: error instanceof Error ? error.message : String(error) });
  }
}

async function notifyWindows(title: string, message: string): Promise<void> {
  try {
    const module = await import("node-notifier");
    module.default.notify({ title, message, sound: true, wait: false });
  } catch {
    process.stdout.write(`\u0007${title}：${message}\n`);
  }
}
