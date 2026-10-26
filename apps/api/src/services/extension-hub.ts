import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RawData, WebSocket } from "ws";
import type { BrowserCommand, BrowserReceipt, RealCalibrationStage, VisibleMessageTarget, VisibleOrderTarget } from "@jianzuo/contracts";
import type { WorkbenchDatabase } from "@jianzuo/database";
import {
  createMessageTargetBinding,
  createOrderTargetBinding,
  normalizeMessageTarget,
  normalizeOrderTarget,
  postDpapiProtectedWebhook,
  validateMessageTargetBinding,
  validateOrderTargetBinding
} from "@jianzuo/core";
import {
  advanceCalibration,
  calibrationAtLeast,
  readCalibration,
  resetCalibration,
  validateManagedBrowserBinding,
  type BrowserPageBinding
} from "./calibration.js";

type ClientMessage =
  | { type: "hello"; pageType?: string; domFingerprint?: string; pageUrl?: string; tabId?: string; adapterVersion?: string; accountLabel?: string; accountFingerprint?: string; accountIdentitySource?: string; accountBindingEligible?: boolean; visibleTarget?: unknown; visibleContext?: unknown; visibleSnapshot?: { metrics: Record<string, number>; capturedAt: string } }
  | { type: "heartbeat"; pageType?: string; domFingerprint?: string; pageUrl?: string; tabId?: string; adapterVersion?: string; accountLabel?: string; accountFingerprint?: string; accountIdentitySource?: string; accountBindingEligible?: boolean; visibleTarget?: unknown; visibleContext?: unknown; visibleSnapshot?: { metrics: Record<string, number>; capturedAt: string } }
  | { type: "request_work" }
  | { type: "receipt"; receipt: BrowserReceipt };

export type CurrentPlatformObservation = {
  target: VisibleMessageTarget | VisibleOrderTarget;
  context: Record<string, string>;
  receivedAt: string;
};

export type PlatformTargetCheck =
  | {
      ok: true;
      target: VisibleMessageTarget | VisibleOrderTarget;
      context: Record<string, string>;
      preconditionFingerprint: string;
      pageBinding: BrowserPageBinding;
      platformBinding?: Record<string, unknown>;
    }
  | { ok: false; reason: string };

export class ManagedBrowserConnector {
  private socket: WebSocket | null = null;
  private activeTokenHash: string | null = null;
  private readonly instanceId = `extension-hub:${randomUUID()}`;
  private pairingAttempts: number[] = [];
  constructor(private readonly db: WorkbenchDatabase, private readonly dataDir: string) {}

  getCurrentVisibleTarget(): CurrentPlatformObservation | null {
    const raw = this.db.getSetting("browser_visible_target");
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const candidate = parsed.target as Record<string, unknown> | undefined;
      const target = candidate?.targetType === "message"
        ? normalizeMessageTarget(candidate)
        : candidate?.targetType === "order"
          ? normalizeOrderTarget(candidate)
          : null;
      if (!target) return null;
      return {
        target,
        context: sanitizeVisibleContext(parsed.context),
        receivedAt: typeof parsed.receivedAt === "string" ? parsed.receivedAt : ""
      };
    } catch {
      return null;
    }
  }

  validateCurrentTarget(
    targetType: "message" | "order",
    requiredStage: RealCalibrationStage = "ACCOUNT_CONFIRMED"
  ): PlatformTargetCheck {
    const pageCheck = validateManagedBrowserBinding(this.db, {
      requiredStage,
      expectedPageTypes: targetType === "message" ? ["messages"] : ["orders", "delivery"]
    });
    if (!pageCheck.ok) return { ok: false, reason: pageCheck.reason };
    const observation = this.getCurrentVisibleTarget();
    if (!observation || observation.target.targetType !== targetType) {
      return { ok: false, reason: targetType === "message" ? "当前页面没有可确认的闲鱼会话目标" : "当前页面没有可确认的闲鱼订单目标" };
    }
    const target = observation.target;
    const pageBinding = pageCheck.binding;
    const metadataMatches = target.pageUrl === pageBinding.pageUrl
      && target.tabId === pageBinding.tabId
      && target.accountFingerprint === pageBinding.accountFingerprint
      && target.domFingerprint === pageBinding.domFingerprint
      && target.adapterVersion === pageBinding.adapterVersion;
    if (!metadataMatches) return { ok: false, reason: "当前可见目标与最新页面心跳不一致，已停止绑定" };
    const binding = targetType === "message" ? createMessageTargetBinding(target) : createOrderTargetBinding(target);
    const validation = targetType === "message"
      ? validateMessageTargetBinding(binding, target)
      : validateOrderTargetBinding(binding, target);
    if (!validation.valid) return { ok: false, reason: validation.errors[0]?.message ?? "当前可见目标已失效" };
    return {
      ok: true,
      target,
      context: observation.context,
      preconditionFingerprint: validation.preconditionFingerprint,
      pageBinding
    };
  }

  validateBoundTarget(
    bindingType: "conversation" | "order",
    internalId: string,
    requiredStage: RealCalibrationStage = "SINGLE_PUBLISH_VERIFIED"
  ): PlatformTargetCheck {
    const current = this.validateCurrentTarget(bindingType === "conversation" ? "message" : "order", requiredStage);
    if (!current.ok) return current;
    const row = this.db.getPlatformTargetBinding(bindingType, internalId);
    if (!row || !["CONFIRMED", "TEST_VERIFIED"].includes(String(row.status))) {
      return { ok: false, reason: bindingType === "conversation" ? "该会话尚未完成显式目标绑定" : "该订单尚未完成显式目标绑定" };
    }
    const target = platformTargetFromRow(bindingType, row);
    if (!target) return { ok: false, reason: "已保存的目标绑定不完整，已停止动作" };
    const platformBinding = bindingType === "conversation"
      ? { bindingType: "message", target, preconditionFingerprint: String(row.binding_fingerprint ?? "") }
      : { bindingType: "order", target, preconditionFingerprint: String(row.binding_fingerprint ?? "") };
    const validation = bindingType === "conversation"
      ? validateMessageTargetBinding(platformBinding, current.target)
      : validateOrderTargetBinding(platformBinding, current.target);
    if (!validation.valid) return { ok: false, reason: validation.errors[0]?.message ?? "当前目标与已确认绑定不一致" };
    return {
      ...current,
      preconditionFingerprint: validation.preconditionFingerprint,
      platformBinding: { internalId, ...platformBinding }
    };
  }

  validateActionTarget(action: Record<string, unknown>): PlatformTargetCheck {
    const actionType = String(action.action_type ?? "");
    if (!["SEND_REPLY", "SEND_DELIVERY"].includes(actionType)) {
      return { ok: false, reason: "该动作不使用会话或订单目标绑定" };
    }
    const payload = parseRecord(action.payload_json);
    const bindingType = actionType === "SEND_REPLY" ? "conversation" : "order";
    const internalId = bindingType === "conversation" ? String(payload.conversationId ?? "") : String(payload.orderId ?? "");
    if (!internalId) return { ok: false, reason: "动作缺少本地目标编号" };
    const checked = this.validateBoundTarget(bindingType, internalId, "SINGLE_PUBLISH_VERIFIED");
    if (!checked.ok) return checked;
    const approvedBinding = parseRecord(payload.platformTargetBinding);
    if (String(approvedBinding.internalId ?? "") !== internalId
      || String(approvedBinding.preconditionFingerprint ?? "") !== checked.preconditionFingerprint) {
      return { ok: false, reason: "动作中的目标绑定与当前已确认绑定不一致" };
    }
    const validation = bindingType === "conversation"
      ? validateMessageTargetBinding({
          bindingType: approvedBinding.bindingType,
          target: approvedBinding.target,
          preconditionFingerprint: approvedBinding.preconditionFingerprint
        }, checked.target)
      : validateOrderTargetBinding({
          bindingType: approvedBinding.bindingType,
          target: approvedBinding.target,
          preconditionFingerprint: approvedBinding.preconditionFingerprint
        }, checked.target);
    if (!validation.valid) return { ok: false, reason: validation.errors[0]?.message ?? "动作批准后的目标已变化" };
    if (actionType === "SEND_REPLY") {
      const visibleInboundHash = checked.context.lastInboundHash;
      const expectedInboundHash = String(payload.latestInboundMessageHash ?? "");
      if (checked.context.lastInboundTruncated === "true") {
        return { ok: false, reason: "当前买家消息过长，无法完整核对，已转人工" };
      }
      if (!/^[a-f0-9]{64}$/i.test(visibleInboundHash ?? "") || !/^[a-f0-9]{64}$/i.test(expectedInboundHash)) {
        return { ok: false, reason: "当前会话缺少可核对的最新买家消息，已停止发送" };
      }
      if (visibleInboundHash !== expectedInboundHash) {
        return { ok: false, reason: "买家在回复草稿生成后更新了消息，旧回复已停止" };
      }
    }
    return checked;
  }

  createPairing(): { code: string; expiresAt: string } {
    const code = String(randomInt(100000, 1_000_000));
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    this.db.createPairing(createHash("sha256").update(code).digest("hex"), expiresAt);
    this.db.setBrowserRuntime("pairing", { connector: "MANAGED_BROWSER" });
    return { code, expiresAt };
  }

  pair(code: string): { token: string } | null {
    const cutoff = Date.now() - 60_000;
    this.pairingAttempts = this.pairingAttempts.filter((attempt) => attempt >= cutoff);
    if (this.pairingAttempts.length >= 10) return null;
    this.pairingAttempts.push(Date.now());
    if (!/^\d{6}$/.test(code)) return null;
    const token = randomBytes(32).toString("base64url");
    const success = this.db.consumePairing(
      createHash("sha256").update(code).digest("hex"),
      createHash("sha256").update(token).digest("hex")
    );
    return success ? { token } : null;
  }

  attach(socket: WebSocket, token: string): boolean {
    if (!this.db.validateExtensionToken(token)) return false;
    const tokenHash = createHash("sha256").update(token).digest("hex");
    if (this.socket && this.socket !== socket) {
      const quarantined = this.db.quarantineExecutingActions("MANAGED_BROWSER");
      if (quarantined) {
        this.db.setSetting("automation_paused", "true");
        this.db.audit("managed-browser", "ACTIONS_QUARANTINED", `扩展连接被替换，已封存 ${quarantined} 个结果未知动作`, { quarantined });
      }
      this.socket.close(1000, "replaced");
    }
    this.socket = socket;
    this.activeTokenHash = tokenHash;
    this.db.setBrowserRuntime("online", { connector: "MANAGED_BROWSER" });
    socket.on("message", (data) => this.handleMessage(socket, String(data)));
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.activeTokenHash = null;
      const quarantined = this.db.quarantineExecutingActions("MANAGED_BROWSER");
      if (quarantined) {
        this.db.setSetting("automation_paused", "true");
        this.db.audit("managed-browser", "ACTIONS_QUARANTINED", `扩展断线，已封存 ${quarantined} 个结果未知动作`, { quarantined });
        void this.notifyWebhook("MANAGED_BROWSER_CONNECTION", "RESULT_UNKNOWN");
      }
      this.db.setBrowserRuntime("offline", { connector: "MANAGED_BROWSER" });
      if (this.db.getAccountStatus() === "ONLINE") this.db.setAccountStatus("DEGRADED");
    });
    socket.send(JSON.stringify({ type: "paired", at: new Date().toISOString() }));
    if (this.db.getSetting("automation_paused") === "true") socket.send(JSON.stringify({ type: "paused", reason: "全局紧急停止已开启" }));
    return true;
  }

  pauseWrites(): void { this.socket?.send(JSON.stringify({ type: "paused", reason: "全局紧急停止已开启" })); }
  requestWork(): void { this.dispatchNext(); }
  resumeWrites(): void {
    this.socket?.send(JSON.stringify({ type: "resumed", at: new Date().toISOString() }));
    this.dispatchNext();
  }

  authenticateSocket(socket: WebSocket): void {
    const timeout = setTimeout(() => socket.close(1008, "authentication timeout"), 5_000);
    const firstMessage = (data: RawData) => {
      clearTimeout(timeout);
      let token = "";
      try {
        const message = JSON.parse(String(data)) as { type?: string; token?: string };
        if (message.type === "authenticate") token = message.token ?? "";
      } catch { /* invalid first frame */ }
      if (!token || !this.attach(socket, token)) socket.close(1008, "unauthorized");
    };
    socket.once("message", firstMessage);
  }

  private handleMessage(source: WebSocket, raw: string): void {
    if (this.socket !== source) return;
    let message: ClientMessage;
    try { message = JSON.parse(raw) as ClientMessage; } catch { return; }
    if (message.type === "hello" || message.type === "heartbeat") {
      if (!this.activeTokenHash || !this.db.touchExtensionTokenHash(this.activeTokenHash)) {
        source.close(1008, "authorization expired");
        return;
      }
      this.db.setBrowserRuntime("online", { connector: "MANAGED_BROWSER", pageType: message.pageType, domFingerprint: message.domFingerprint });
      this.db.setSetting("browser_page_meta", JSON.stringify({
        pageType: message.pageType ?? "", pageUrl: message.pageUrl ?? "", tabId: message.tabId ?? "", adapterVersion: message.adapterVersion ?? "",
        accountLabel: message.accountLabel ?? "", accountFingerprint: message.accountFingerprint ?? "",
        accountIdentitySource: message.accountIdentitySource ?? "", accountBindingEligible: message.accountBindingEligible === true,
        domFingerprint: message.domFingerprint ?? "", observedAt: new Date().toISOString()
      }));
      this.captureVisibleTarget(message);
      const calibration = readCalibration(this.db);
      // During browser startup the content script can briefly report an
      // unidentified/unavailable page before the account header is rendered.
      // Missing identity must keep writes fail-closed, but it is not positive
      // evidence that the user switched accounts. Only a complete, different
      // visible identity invalidates the confirmed calibration.
      const observedAccountIdentified = Boolean(message.accountLabel && message.accountFingerprint);
      const accountMismatch = calibrationAtLeast(this.db, "ACCOUNT_CONFIRMED") && observedAccountIdentified && (
        !calibration.accountLabel || !calibration.accountFingerprint
        || message.accountLabel !== calibration.accountLabel || message.accountFingerprint !== calibration.accountFingerprint
      );
      if (accountMismatch) {
        const reason = "当前可见账号与已确认账号不一致，真实写操作已暂停";
        const sealed = this.db.sealManagedBrowserActions(reason);
        resetCalibration(this.db);
        this.db.setSetting("automation_paused", "true");
        this.db.setAccountStatus("DEGRADED");
        this.pauseWrites();
        this.db.audit("managed-browser", "ACCOUNT_BINDING_MISMATCH", reason, {
          expectedAccountLabel: calibration.accountLabel, observedAccountLabel: message.accountLabel, ...sealed
        });
        return;
      }
      if (message.visibleSnapshot && message.pageUrl && Object.keys(message.visibleSnapshot.metrics).length) {
        const metrics = sanitizeVisibleMetrics(message.visibleSnapshot.metrics);
        if (Object.keys(metrics).length) this.db.saveMetricSnapshot({
          source: "real_visible", pageType: message.pageType ?? "unknown", pageUrl: message.pageUrl,
          accountId: "local-account", adapterVersion: message.adapterVersion, domFingerprint: message.domFingerprint,
          metrics, capturedAt: new Date().toISOString()
        });
      }
      const pageType = message.pageType ?? "unknown";
      if (pageType === "login") this.db.setAccountStatus(this.db.getAccountStatus() === "ONLINE" ? "SESSION_EXPIRED" : "WAITING_LOGIN");
      else if (["account-home", "account-profile", "listing-create", "messages", "orders", "delivery", "item-detail"].includes(pageType)) {
        this.db.setAccountStatus(calibrationAtLeast(this.db, "ACCOUNT_CONFIRMED") ? "ONLINE" : "WAITING_CONFIRMATION");
      }
      else if (pageType === "unavailable" && this.db.getAccountStatus() === "ONLINE") this.db.setAccountStatus("DEGRADED");
      return;
    }
    if (message.type === "request_work") {
      this.dispatchNext();
      return;
    }
    if (message.type === "receipt") this.receiveReceipt(message.receipt);
  }

  private dispatchNext(): void {
    if (!this.socket || this.socket.readyState !== 1) return;
    if (this.db.getSetting("automation_paused") === "true") {
      this.socket.send(JSON.stringify({ type: "paused", reason: "全局紧急停止已开启" }));
      return;
    }
    const pending = this.db.peekBrowserAction();
    if (!pending) return;
    const pendingPayload = parseRecord(pending.payload_json);
    const expectedBinding = parseRecord(pendingPayload.pageBinding) as Partial<BrowserPageBinding>;
    const actionType = String(pending.action_type ?? "");
    if (["SEND_REPLY", "SEND_DELIVERY"].includes(actionType)) {
      const targetCheck = this.validateActionTarget(pending);
      if (!targetCheck.ok) {
        const claimed = this.db.claimBrowserAction(this.instanceId, 300, String(pending.action_id));
        if (claimed) this.db.cancelClaimedBrowserActionBeforeDispatch(String(pending.action_id), targetCheck.reason);
        this.db.setSetting("automation_paused", "true");
        this.db.setBrowserRuntime("paused", { connector: "MANAGED_BROWSER", lastError: targetCheck.reason });
        this.pauseWrites();
        this.db.audit("managed-browser", "PLATFORM_TARGET_REJECTED", "浏览器动作在派发前因具体目标失效而取消", {
          actionId: pending.action_id, reason: targetCheck.reason, dispatched: false
        }, "action", String(pending.action_id));
        return;
      }
    }
    const requiredStage = actionType === "PUBLISH_LISTING" ? "DRAFT_FILLED" : "ACCOUNT_CONFIRMED";
    const expectedPageTypes = actionType === "SEND_REPLY"
      ? ["messages"]
      : actionType === "SEND_DELIVERY"
        ? ["orders", "delivery"]
        : ["listing-create"];
    const bindingCheck = validateManagedBrowserBinding(this.db, { requiredStage, expectedPageTypes, expectedBinding });
    if (!bindingCheck.ok) {
      const reason = bindingCheck.reason;
      if (/账号/.test(reason)) {
        const sealed = this.db.sealManagedBrowserActions(reason);
        resetCalibration(this.db);
        this.db.setAccountStatus("DEGRADED");
        this.db.setSetting("automation_paused", "true");
        this.pauseWrites();
        this.db.audit("managed-browser", "ACCOUNT_BINDING_MISMATCH", reason, { actionId: pending.action_id, ...sealed });
      } else {
        const claimed = this.db.claimBrowserAction(this.instanceId, 300, String(pending.action_id));
        if (claimed) this.db.cancelClaimedBrowserActionBeforeDispatch(String(pending.action_id), reason);
        this.db.setSetting("automation_paused", "true");
        this.db.setBrowserRuntime("paused", { connector: "MANAGED_BROWSER", lastError: reason });
        this.pauseWrites();
        this.db.audit("managed-browser", "ACTION_BINDING_REJECTED", "浏览器动作在派发前因绑定失效而取消", {
          actionId: pending.action_id, reason, dispatched: false
        }, "action", String(pending.action_id));
      }
      return;
    }
    const row = this.db.claimBrowserAction(this.instanceId, 300, String(pending.action_id));
    if (!row) return;
    const map: Record<string, BrowserCommand["actionType"]> = {
      FILL_LISTING: "FILL_LISTING", PUBLISH_LISTING: "SUBMIT_LISTING", SEND_REPLY: "SEND_REPLY", SEND_DELIVERY: "ATTACH_DELIVERY", INSPECT_PAGE: "INSPECT_PAGE"
    };
    const payload = JSON.parse(String(row.payload_json)) as Record<string, unknown>;
    const binding = (payload.pageBinding && typeof payload.pageBinding === "object" ? payload.pageBinding : {}) as Record<string, unknown>;
    const command: BrowserCommand = {
      commandId: String(row.action_id),
      actionType: map[String(row.action_type)] ?? "READ_VISIBLE",
      payload,
      // The durable Outbox fingerprint for message/order actions is the exact
      // platform target fingerprint. The content adapter separately expects a
      // DOM fingerprint here; target identity is revalidated by the API guard.
      preconditionFingerprint: typeof binding.domFingerprint === "string" ? binding.domFingerprint : String(row.precondition_fingerprint || ""),
      expectedPageUrl: typeof binding.pageUrl === "string" ? binding.pageUrl : undefined,
      expectedTabId: typeof binding.tabId === "string" ? binding.tabId : undefined,
      expectedPageType: typeof binding.pageType === "string" ? binding.pageType : undefined,
      expectedAccountLabel: typeof binding.accountLabel === "string" ? binding.accountLabel : undefined,
      expectedAccountFingerprint: typeof binding.accountFingerprint === "string" ? binding.accountFingerprint : undefined,
      adapterVersion: typeof binding.adapterVersion === "string" ? binding.adapterVersion : undefined,
      observedAt: bindingCheck.binding.observedAt
    };
    try {
      this.socket.send(JSON.stringify({ type: "command", command }));
    } catch (error) {
      const quarantined = this.db.quarantineExecutingActions("MANAGED_BROWSER");
      this.db.setSetting("automation_paused", "true");
      this.db.audit("managed-browser", "ACTION_DISPATCH_UNKNOWN", "扩展命令发送中断，动作结果已封存", {
        actionId: row.action_id, quarantined, error: error instanceof Error ? error.message : String(error)
      }, "action", String(row.action_id));
    }
  }

  private receiveReceipt(receipt: BrowserReceipt): void {
    let status: "SUCCEEDED" | "FAILED" | "RESULT_UNKNOWN" = receipt.status === "ok" ? "SUCCEEDED" : receipt.status === "result_unknown" ? "RESULT_UNKNOWN" : "FAILED";
    const action = this.db.getAction(receipt.commandId);
    if (!action || action.connector !== "MANAGED_BROWSER" || action.status !== "EXECUTING") {
      this.db.audit("managed-browser", "LATE_RECEIPT_IGNORED", "已忽略迟到或重复的扩展回执", {
        commandId: receipt.commandId, currentStatus: action?.status ?? "missing", receiptStatus: receipt.status
      }, "action", receipt.commandId);
      return;
    }
    const actionPayload = parseRecord(action.payload_json);
    const expectedBinding = parseRecord(actionPayload.pageBinding);
    const accountMismatch = (
      typeof expectedBinding.accountLabel === "string" && expectedBinding.accountLabel.length > 0 && receipt.accountLabel !== expectedBinding.accountLabel
    ) || (
      typeof expectedBinding.accountFingerprint === "string" && expectedBinding.accountFingerprint.length > 0
      && receipt.accountFingerprint !== expectedBinding.accountFingerprint
    );
    if (accountMismatch) {
      status = "RESULT_UNKNOWN";
      receipt = { ...receipt, status: "result_unknown", summary: "扩展回执账号与审批绑定账号不一致，外部结果未知" };
    }
    let verifiedReceiptTarget: VisibleMessageTarget | VisibleOrderTarget | undefined;
    if (status === "SUCCEEDED" && ["SEND_REPLY", "SEND_DELIVERY"].includes(String(action.action_type))) {
      const targetCheck = validateReceiptPlatformTarget(action, receipt);
      if (!targetCheck.ok) {
        status = "RESULT_UNKNOWN";
        receipt = { ...receipt, status: "result_unknown", summary: `${targetCheck.reason}；外部动作结果按未知处理` };
      } else {
        verifiedReceiptTarget = targetCheck.target;
      }
    }
    let verifiedActionEvidence: Record<string, string> | undefined;
    if (status === "SUCCEEDED" && ["PUBLISH_LISTING", "SEND_REPLY", "SEND_DELIVERY"].includes(String(action.action_type))) {
      verifiedActionEvidence = verifyReceiptActionEvidence(String(action.action_type), actionPayload, receipt.actionEvidence);
      if (!verifiedActionEvidence) {
        status = "RESULT_UNKNOWN";
        receipt = { ...receipt, status: "result_unknown", summary: "扩展未提供与本次动作匹配的成功证据；外部结果按未知处理" };
      }
    }
    let screenshotPath: string | undefined;
    if (receipt.screenshotDataUrl?.startsWith("data:image/png;base64,")) {
      const bytes = Buffer.from(receipt.screenshotDataUrl.slice("data:image/png;base64,".length), "base64");
      if (bytes.length <= 5 * 1024 * 1024) {
        try {
          const directory = resolve(this.dataDir, "artifacts", "receipts");
          mkdirSync(directory, { recursive: true });
          screenshotPath = resolve(directory, `${receipt.commandId}.png`);
          if (!existsSync(screenshotPath)) writeFileSync(screenshotPath, bytes, { flag: "wx" });
        } catch (error) {
          screenshotPath = undefined;
          this.db.audit("managed-browser", "RECEIPT_SCREENSHOT_FAILED", "扩展回执截图保存失败，动作结果仍继续落库", {
            commandId: receipt.commandId, error: error instanceof Error ? error.message : String(error)
          }, "action", receipt.commandId);
        }
      }
    }
    const resultData = {
      pageType: receipt.pageType,
      domFingerprint: receipt.domFingerprint,
      pageUrl: receipt.pageUrl,
      tabId: receipt.tabId,
      adapterVersion: receipt.adapterVersion,
      accountLabel: receipt.accountLabel,
      accountFingerprint: receipt.accountFingerprint,
      visibleTarget: verifiedReceiptTarget,
      actionEvidence: verifiedActionEvidence,
      summary: receipt.summary,
      screenshotPath,
      timestamp: receipt.timestamp
    };
    const completion = this.db.finishBrowserAction(receipt.commandId, status, resultData);
    if (!completion.completed) {
      this.db.audit("managed-browser", "LATE_RECEIPT_IGNORED", "动作状态已变化，扩展回执未覆盖既有终态", {
        commandId: receipt.commandId, receiptStatus: receipt.status
      }, "action", receipt.commandId);
      return;
    }
    if (screenshotPath) this.db.saveAsset({
      kind: "action_receipt", path: screenshotPath, source: "managed_browser",
      expiresAt: new Date(Date.now() + 180 * 24 * 60 * 60 * 1_000).toISOString()
    });
    if (status === "SUCCEEDED" && action.action_type === "FILL_LISTING") {
      advanceCalibration(this.db, "DRAFT_FILLED", { actionId: receipt.commandId, pageUrl: receipt.pageUrl ?? "", adapterVersion: receipt.adapterVersion ?? "" });
    }
    if (status === "SUCCEEDED" && action.action_type === "PUBLISH_LISTING") {
      advanceCalibration(this.db, "SINGLE_PUBLISH_VERIFIED", { actionId: receipt.commandId, pageUrl: receipt.pageUrl ?? "", adapterVersion: receipt.adapterVersion ?? "" });
    }
    if (status === "SUCCEEDED" && action.action_type === "SEND_REPLY") {
      const conversationId = String(actionPayload.conversationId ?? "");
      this.db.setPlatformTargetBindingStatus("conversation", conversationId, "TEST_VERIFIED");
      advanceCalibration(this.db, "MESSAGE_TEST_VERIFIED", {
        actionId: receipt.commandId,
        conversationId,
        externalConversationId: verifiedReceiptTarget?.conversationId ?? "",
        adapterVersion: receipt.adapterVersion ?? ""
      });
    }
    if (status === "SUCCEEDED" && action.action_type === "SEND_DELIVERY") {
      const orderId = String(actionPayload.orderId ?? "");
      this.db.setPlatformTargetBindingStatus("order", orderId, "TEST_VERIFIED");
      advanceCalibration(this.db, "ORDER_TEST_VERIFIED", {
        actionId: receipt.commandId,
        orderId,
        externalOrderId: verifiedReceiptTarget?.targetType === "order" ? verifiedReceiptTarget.orderId : "",
        adapterVersion: receipt.adapterVersion ?? ""
      });
    }
    if (accountMismatch) {
      const sealed = this.db.sealManagedBrowserActions("扩展回执账号与审批绑定账号不一致");
      resetCalibration(this.db);
      this.db.setAccountStatus("DEGRADED");
      this.db.setSetting("automation_paused", "true");
      this.pauseWrites();
      this.db.audit("managed-browser", "ACCOUNT_BINDING_MISMATCH", "扩展回执账号不一致，已封存真实动作", {
        commandId: receipt.commandId, expectedAccountLabel: expectedBinding.accountLabel,
        observedAccountLabel: receipt.accountLabel ?? "", ...sealed
      }, "action", receipt.commandId);
    }
    const verification = receipt.status === "needs_user" && /验证|验证码|滑块|人脸/.test(receipt.summary);
    const mustPause = status === "RESULT_UNKNOWN" || receipt.status === "needs_user";
    if (mustPause) {
      this.db.setSetting("automation_paused", "true");
      this.pauseWrites();
    }
    if (verification) this.db.setAccountStatus("VERIFICATION_REQUIRED");
    this.db.setBrowserRuntime(verification ? "verification_required" : "online", {
      connector: "MANAGED_BROWSER", pageType: receipt.pageType, domFingerprint: receipt.domFingerprint,
      lastError: receipt.status === "ok" ? undefined : receipt.summary
    });
    if (status === "RESULT_UNKNOWN" || status === "FAILED") void this.notifyWebhook(String(action.action_type), status);
    if (!mustPause) this.dispatchNext();
  }

  private async notifyWebhook(actionType: string, status: "RESULT_UNKNOWN" | "FAILED"): Promise<void> {
    const ciphertext = this.db.getSetting("webhook_worker_url");
    if (!ciphertext) return;
    try {
      await postDpapiProtectedWebhook(ciphertext, {
        event: status === "RESULT_UNKNOWN" ? "ACTION_RESULT_UNKNOWN" : "ACTION_FAILED",
        severity: "critical",
        summary: `${actionType}：${status === "RESULT_UNKNOWN" ? "结果未知，已停止重试" : "执行失败，需要人工检查"}`,
        occurredAt: new Date().toISOString()
      });
      this.db.audit("managed-browser", "WEBHOOK_SENT", "浏览器动作告警 Webhook 已发送", { actionType, status });
    } catch (error) {
      this.db.audit("managed-browser", "WEBHOOK_FAILED", "浏览器动作告警 Webhook 发送失败", { actionType, status, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private captureVisibleTarget(message: Extract<ClientMessage, { type: "hello" | "heartbeat" }>): void {
    const raw = message.visibleTarget;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      this.db.deleteSetting("browser_visible_target");
      return;
    }
    const record = raw as Record<string, unknown>;
    const nowIso = new Date().toISOString();
    const enriched = {
      ...record,
      pageUrl: message.pageUrl,
      tabId: message.tabId,
      accountFingerprint: message.accountFingerprint,
      domFingerprint: message.domFingerprint,
      adapterVersion: message.adapterVersion,
      observedAt: nowIso
    };
    try {
      const target = record.targetType === "message" && message.pageType === "messages"
        ? normalizeMessageTarget(enriched)
        : record.targetType === "order" && ["orders", "delivery"].includes(message.pageType ?? "")
          ? normalizeOrderTarget(enriched)
          : null;
      if (!target) throw new Error("页面类型与可见目标类型不一致");
      this.db.setSetting("browser_visible_target", JSON.stringify({
        target,
        context: sanitizeVisibleContext(message.visibleContext),
        receivedAt: nowIso
      }));
    } catch (error) {
      this.db.deleteSetting("browser_visible_target");
      this.db.audit("managed-browser", "VISIBLE_TARGET_REJECTED", "扩展上报的可见目标未通过本地校验", {
        reason: error instanceof Error ? error.message : "invalid target",
        pageType: message.pageType ?? ""
      });
    }
  }
}

/** @deprecated 使用 ManagedBrowserConnector；保留别名以兼容已有测试和扩展集成。 */
export { ManagedBrowserConnector as ExtensionHub };

function parseRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function sanitizeVisibleMetrics(input: Record<string, number>): Record<string, number> {
  const allowed = new Set(["unreadMessages", "interested", "views", "favorites", "selling", "sold", "reviews", "pendingOrders"]);
  const output: Record<string, number> = {};
  for (const [key, value] of Object.entries(input)) {
    if (allowed.has(key) && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000) output[key] = value;
  }
  return output;
}

export function verifyReceiptActionEvidence(
  actionType: string,
  actionPayload: Record<string, unknown>,
  value: unknown
): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const evidence = value as Record<string, unknown>;
  const kind = typeof evidence.kind === "string" ? evidence.kind : "";
  if (actionType === "PUBLISH_LISTING") {
    if (kind === "new-publication-result-marker") return { kind };
    const externalItemId = typeof evidence.externalItemId === "string" ? evidence.externalItemId : "";
    return kind === "new-item-navigation" && /^[A-Za-z0-9_-]{1,256}$/.test(externalItemId)
      ? { kind, externalItemId }
      : undefined;
  }
  if (actionType === "SEND_REPLY") {
    return ["new-reply-result-marker", "new-matching-outbound-message"].includes(kind) ? { kind } : undefined;
  }
  if (actionType === "SEND_DELIVERY") {
    if (!["new-delivery-result-marker", "order-scoped-delivery-status"].includes(kind)) return undefined;
    const orderId = typeof evidence.orderId === "string" ? evidence.orderId : "";
    const approvedBinding = parseRecord(actionPayload.platformTargetBinding);
    const approvedTarget = parseRecord(approvedBinding.target);
    return orderId && orderId === String(approvedTarget.orderId ?? "") ? { kind, orderId } : undefined;
  }
  return undefined;
}

function sanitizeVisibleContext(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const limits: Record<string, number> = {
    buyerAlias: 80,
    productTitle: 160,
    orderStatus: 80,
    amountLabel: 40
  };
  const output: Record<string, string> = {};
  let total = 0;
  for (const [key, limit] of Object.entries(limits)) {
    if (typeof input[key] !== "string") continue;
    const cleaned = input[key].normalize("NFKC").trim().replace(/\s+/g, " ").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, limit);
    if (!cleaned) continue;
    total += cleaned.length;
    if (total > 700) break;
    output[key] = cleaned;
  }
  const rawMessage = typeof input.lastInboundText === "string"
    ? input.lastInboundText
    : typeof input.lastMessagePreview === "string"
      ? input.lastMessagePreview
      : "";
  const normalizedMessage = rawMessage.normalize("NFKC").trim().replace(/\s+/g, " ").replace(/[\u0000-\u001f\u007f]/g, "");
  const transportTruncated = input.lastInboundTruncated === true || input.lastInboundTruncated === "true";
  const lastInboundTruncated = transportTruncated || normalizedMessage.length > 20_000;
  const lastInboundText = normalizedMessage.slice(0, 20_000);
  if (lastInboundText) {
    output.lastMessagePreview = lastInboundText.slice(0, 280);
    output.lastInboundText = lastInboundText;
    output.lastInboundHash = createHash("sha256").update(lastInboundText).digest("hex");
  }
  if (lastInboundTruncated) output.lastInboundTruncated = "true";
  return output;
}

function platformTargetFromRow(
  bindingType: "conversation" | "order",
  row: Record<string, unknown>
): VisibleMessageTarget | VisibleOrderTarget | null {
  const common = {
    conversationId: String(row.external_conversation_id ?? ""),
    buyerPublicId: String(row.buyer_public_id ?? ""),
    productId: String(row.product_external_id ?? ""),
    pageUrl: String(row.page_url ?? ""),
    tabId: String(row.tab_id ?? ""),
    accountFingerprint: String(row.account_fingerprint ?? ""),
    domFingerprint: String(row.dom_fingerprint ?? ""),
    adapterVersion: String(row.adapter_version ?? ""),
    observedAt: String(row.observed_at ?? "")
  };
  try {
    if (bindingType === "conversation") return normalizeMessageTarget({ targetType: "message", ...common });
    const amountCents = Number(row.amount_cents);
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) return null;
    return normalizeOrderTarget({
      targetType: "order",
      ...common,
      orderId: String(row.external_order_id ?? ""),
      amount: `${Math.floor(amountCents / 100)}.${String(amountCents % 100).padStart(2, "0")}`,
      currency: "CNY"
    });
  } catch {
    return null;
  }
}

function validateReceiptPlatformTarget(
  action: Record<string, unknown>,
  receipt: BrowserReceipt
): { ok: true; target: VisibleMessageTarget | VisibleOrderTarget } | { ok: false; reason: string } {
  const payload = parseRecord(action.payload_json);
  const approved = parseRecord(payload.platformTargetBinding);
  if (!receipt.visibleTarget) return { ok: false, reason: "扩展成功回执缺少具体会话或订单目标" };
  const raw = receipt.visibleTarget as unknown as Record<string, unknown>;
  const enriched = {
    ...raw,
    pageUrl: receipt.pageUrl,
    tabId: receipt.tabId,
    accountFingerprint: receipt.accountFingerprint,
    domFingerprint: receipt.domFingerprint,
    adapterVersion: receipt.adapterVersion,
    observedAt: receipt.timestamp
  };
  const isReply = action.action_type === "SEND_REPLY";
  if ((isReply && receipt.pageType !== "messages") || (!isReply && !["orders", "delivery"].includes(receipt.pageType))) {
    return { ok: false, reason: "扩展成功回执的页面类型与动作不一致" };
  }
  const validation = isReply
    ? validateMessageTargetBinding({
        bindingType: approved.bindingType,
        target: approved.target,
        preconditionFingerprint: approved.preconditionFingerprint
      }, enriched)
    : validateOrderTargetBinding({
        bindingType: approved.bindingType,
        target: approved.target,
        preconditionFingerprint: approved.preconditionFingerprint
      }, enriched);
  if (!validation.valid) return { ok: false, reason: validation.errors[0]?.message ?? "扩展成功回执目标与批准目标不一致" };
  return { ok: true, target: validation.target };
}
