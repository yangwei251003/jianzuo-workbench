import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

type JsonRpcId = number | string;
type ServerProcess = ChildProcessWithoutNullStreams;
type SpawnProcess = (
  command: string,
  args: string[],
  options: { stdio: ["pipe", "pipe", "pipe"]; windowsHide: boolean }
) => ServerProcess;
type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
  process: ServerProcess;
  method: string;
};
type ApprovalRequest = { rpcId: JsonRpcId; method: string; params: unknown; receivedAt: string };
type ApprovalEntry = ApprovalRequest & { process: ServerProcess; timer: NodeJS.Timeout };
type CodexState = "unavailable" | "signed_out" | "ready" | "busy" | "error";

export type CodexAppServerOptions = {
  spawnProcess?: SpawnProcess;
  terminateProcess?: (process: ServerProcess) => Promise<void>;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  approvalTimeoutMs?: number;
  stopTimeoutMs?: number;
};

const DEFAULT_STARTUP_TIMEOUT_MS = 8_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_APPROVAL_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;

export class CodexAppServer extends EventEmitter {
  private process: ServerProcess | null = null;
  private startupPromise: Promise<void> | null = null;
  private initialized = false;
  private requestId = 0;
  private readonly pending = new Map<JsonRpcId, Pending>();
  private readonly approvals = new Map<string, ApprovalEntry>();
  private readonly events: Array<{ method: string; params: unknown; at: string }> = [];
  private readonly intentionallyStopping = new WeakSet<ServerProcess>();
  private state: CodexState = "unavailable";
  private lastError: string | null = null;
  private readonly spawnProcess: SpawnProcess;
  private readonly terminateProcess: (process: ServerProcess) => Promise<void>;
  private readonly startupTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly approvalTimeoutMs: number;
  private readonly stopTimeoutMs: number;

  constructor(options: CodexAppServerOptions = {}) {
    super();
    this.spawnProcess = options.spawnProcess ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
    this.startupTimeoutMs = positiveTimeout(options.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS);
    this.requestTimeoutMs = positiveTimeout(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    this.approvalTimeoutMs = positiveTimeout(options.approvalTimeoutMs, DEFAULT_APPROVAL_TIMEOUT_MS);
    this.stopTimeoutMs = positiveTimeout(options.stopTimeoutMs, DEFAULT_STOP_TIMEOUT_MS);
    this.terminateProcess = options.terminateProcess ?? ((child) => this.terminateDefault(child));
  }

  status(): { state: CodexState; lastError: string | null; running: boolean; pendingApprovals: number } {
    return { state: this.state, lastError: this.lastError, running: Boolean(this.process), pendingApprovals: this.approvals.size };
  }

  recentEvents(limit = 100): Array<{ method: string; params: unknown; at: string }> {
    return this.events.slice(-Math.max(1, Math.min(200, limit)));
  }

  pendingApprovals(): Array<{ id: string } & ApprovalRequest> {
    return [...this.approvals.entries()].map(([id, item]) => ({
      id,
      rpcId: item.rpcId,
      method: item.method,
      params: item.params,
      receivedAt: item.receivedAt
    }));
  }

  async ensureStarted(): Promise<void> {
    if (this.process && this.initialized) return;
    if (this.startupPromise) return this.startupPromise;
    const startup = this.start();
    this.startupPromise = startup;
    try {
      await startup;
    } finally {
      if (this.startupPromise === startup) this.startupPromise = null;
    }
  }

  async readAccount(): Promise<unknown> {
    await this.ensureStarted();
    const account = await this.request("account/read", { refreshToken: false });
    this.state = hasSignedInAccount(account) ? "ready" : "signed_out";
    return account;
  }

  async startChatGptLogin(): Promise<unknown> {
    await this.ensureStarted();
    return this.request("account/login/start", { type: "chatgpt", useHostedLoginSuccessPage: true, codexStreamlinedLogin: true });
  }

  async startThread(cwd: string, title: string, ephemeral = false): Promise<{ threadId: string; raw: unknown }> {
    await this.ensureStarted();
    const raw = await this.request("thread/start", {
      cwd,
      runtimeWorkspaceRoots: [cwd],
      permissions: ":workspace",
      ephemeral,
      developerInstructions: [
        `当前会话用于${title}。`,
        "不得直接点击闲鱼或调用闲鱼私有协议。",
        "如需外部动作，只输出结构化动作提案，由工作台策略引擎决定。",
        "客户可识别文件没有单独同意时不得发送到外部模型。",
        "文案要短句、具体、真实，不使用夸张承诺和 AI 套话。"
      ].join("\n")
    }) as Record<string, unknown>;
    const thread = (raw.thread ?? raw) as Record<string, unknown>;
    const threadId = String(thread.id ?? raw.threadId ?? "").trim();
    if (!threadId) throw new Error("Codex 未返回线程 ID");
    return { threadId, raw };
  }

  async resumeThread(threadId: string): Promise<unknown> {
    const normalizedId = threadId.trim();
    if (!normalizedId) throw new Error("Codex 线程 ID 不能为空");
    await this.ensureStarted();
    try {
      return await this.request("thread/resume", { threadId: normalizedId });
    } catch (error) {
      if (error instanceof Error && /no rollout found for thread id/i.test(error.message)) {
        throw new Error("Codex 会话尚未完成首个任务，未形成可恢复记录；请重新创建会话并提交首个任务");
      }
      throw error;
    }
  }

  async startTurn(threadId: string, text: string, workspaceRoots: string[]): Promise<unknown> {
    const normalizedId = threadId.trim();
    if (!normalizedId) throw new Error("Codex 线程 ID 不能为空");
    await this.ensureStarted();
    this.state = "busy";
    try {
      return await this.request("turn/start", {
        threadId: normalizedId,
        input: [{ type: "text", text }],
        runtimeWorkspaceRoots: workspaceRoots,
        permissions: ":workspace"
      });
    } catch (error) {
      this.state = "error";
      this.lastError = errorMessage(error);
      throw error;
    }
  }

  resolveApproval(id: string, decision: "accept" | "decline" | "cancel"): boolean {
    const approval = this.approvals.get(id);
    if (!approval || !this.process || approval.process !== this.process) return false;
    clearTimeout(approval.timer);
    this.approvals.delete(id);
    if (!this.writeTo(approval.process, { id: approval.rpcId, result: { decision } })) {
      this.pushEvent("approval/expired", { id, reason: "Codex App Server 连接不可写" });
      return false;
    }
    this.pushEvent("approval/resolved", { id, decision, method: approval.method });
    return true;
  }

  async stop(): Promise<void> {
    const child = this.process;
    if (!child) {
      this.state = "unavailable";
      return;
    }
    const startup = this.startupPromise;
    this.intentionallyStopping.add(child);
    this.initialized = false;
    await this.terminateProcess(child).catch(() => undefined);
    this.cleanupProcess(child, new Error("Codex App Server 已停止"));
    if (this.process === child) this.process = null;
    if (startup) await startup.catch(() => undefined);
    if (this.startupPromise === startup) this.startupPromise = null;
    this.state = "unavailable";
    this.lastError = null;
  }

  private async start(): Promise<void> {
    let child: ServerProcess;
    try {
      child = this.spawnProcess("codex", ["app-server", "--stdio"], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      });
    } catch (error) {
      this.state = "error";
      this.lastError = `无法启动 Codex App Server：${errorMessage(error)}`;
      throw error;
    }

    this.process = child;
    this.initialized = false;
    this.bindProcess(child);

    try {
      await this.waitForSpawn(child);
      if (this.process !== child || this.intentionallyStopping.has(child)) throw new Error("Codex App Server 启动已取消");
      await this.request("initialize", {
        clientInfo: { name: "jianzuo-xianyu-workbench", title: "简作闲鱼 AI 运营工作台", version: "0.1.0" },
        capabilities: { experimentalApi: true }
      });
      this.notify("initialized", {});
      const account = await this.request("account/read", {});
      if (this.process !== child || this.intentionallyStopping.has(child)) throw new Error("Codex App Server 启动已取消");
      this.initialized = true;
      this.state = hasSignedInAccount(account) ? "ready" : "signed_out";
      this.lastError = null;
    } catch (error) {
      const intentional = this.intentionallyStopping.has(child);
      if (!intentional) {
        this.state = "error";
        this.lastError = errorMessage(error);
        this.pushEvent("server/start_failed", { message: this.lastError });
      }
      this.intentionallyStopping.add(child);
      await this.terminateProcess(child).catch(() => undefined);
      this.cleanupProcess(child, new Error(intentional ? "Codex App Server 启动已取消" : "Codex App Server 启动失败"));
      if (this.process === child) this.process = null;
      if (intentional) {
        this.state = "unavailable";
      } else {
        // The process can emit `exit` while termination is in progress. Restore the
        // startup error after that event so the UI does not misreport a failed boot
        // as an ordinary stopped state.
        this.state = "error";
        this.lastError = errorMessage(error);
      }
      throw error;
    }
  }

  private bindProcess(child: ServerProcess): void {
    child.once("exit", (code, signal) => this.handleExit(child, code, signal));
    child.on("error", (error) => {
      if (this.process !== child || this.intentionallyStopping.has(child)) return;
      this.state = "error";
      this.lastError = `Codex App Server 进程错误：${error.message}`;
      this.pushEvent("server/process_error", { message: this.lastError });
    });
    child.stderr.on("data", (chunk) => {
      const line = redactDiagnostic(String(chunk).trim());
      if (line) this.pushEvent("server/stderr", { message: line.slice(0, 2_000) });
    });
    const onStreamError = (stream: "stdin" | "stdout" | "stderr", error: Error) => {
      const message = redactDiagnostic(error.message).slice(0, 1_000);
      this.pushEvent("server/stream_error", { stream, message });
      this.cleanupProcess(child, new Error(`Codex App Server ${stream} 通道错误：${message}`));
      if (this.process === child && !this.intentionallyStopping.has(child)) {
        this.state = "error";
        this.lastError = `Codex App Server ${stream} 通道错误`;
      }
    };
    child.stdin.on("error", (error) => onStreamError("stdin", error));
    child.stdout.on("error", (error) => onStreamError("stdout", error));
    child.stderr.on("error", (error) => onStreamError("stderr", error));
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.onLine(child, line));
  }

  private waitForSpawn(child: ServerProcess): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off("spawn", onSpawn);
        child.off("error", onError);
        child.off("exit", onExit);
        if (error) reject(error); else resolve();
      };
      const onSpawn = () => finish();
      const onError = (error: Error) => finish(error);
      const onExit = (code: number | null) => finish(new Error(`Codex App Server 启动前退出（${code ?? "unknown"}）`));
      const timer = setTimeout(() => finish(new Error("Codex App Server 启动超时")), this.startupTimeoutMs);
      child.once("spawn", onSpawn);
      child.once("error", onError);
      child.once("exit", onExit);
    });
  }

  private request(method: string, params: unknown, timeoutMs = this.requestTimeoutMs): Promise<unknown> {
    const child = this.process;
    if (!child) return Promise.reject(new Error("Codex App Server 未启动"));
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending || pending.process !== child) return;
        this.pending.delete(id);
        this.pushEvent("server/request_timeout", { method });
        reject(new Error(`${method} 请求超时`));
      }, positiveTimeout(timeoutMs, this.requestTimeoutMs));
      this.pending.set(id, { resolve, reject, timer, process: child, method });
      if (!this.writeTo(child, { id, method, params })) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`${method} 请求发送失败`));
      }
    });
  }

  private notify(method: string, params: unknown): void {
    const child = this.process;
    if (child && !this.writeTo(child, { method, params })) this.pushEvent("server/notification_failed", { method });
  }

  private writeTo(child: ServerProcess, message: unknown): boolean {
    if (child.stdin.destroyed || !child.stdin.writable) return false;
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  private onLine(child: ServerProcess, line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.pushEvent("server/protocol_error", { reason: "收到非 JSON 消息", length: line.length });
      return;
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      this.pushEvent("server/protocol_error", { reason: "收到无效 JSON-RPC 消息" });
      return;
    }
    if (message.id !== undefined && ("result" in message || "error" in message)) {
      const id = message.id as JsonRpcId;
      const pending = this.pending.get(id);
      if (!pending || pending.process !== child) {
        this.pushEvent("server/orphan_response", { id: String(id) });
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(id);
      if (message.error) pending.reject(jsonRpcError(pending.method, message.error));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && typeof message.method === "string") {
      if (!/requestApproval$/i.test(message.method)) {
        this.writeTo(child, { id: message.id, error: { code: -32601, message: `Unsupported server request: ${message.method}` } });
        this.pushEvent("server/request_rejected", { method: message.method });
        return;
      }
      this.registerApproval(child, message.id as JsonRpcId, message.method, message.params);
      return;
    }
    if (typeof message.method === "string") {
      this.pushEvent(message.method, message.params);
      if (message.method === "turn/completed") {
        this.state = "ready";
        this.lastError = null;
      }
      if (message.method === "account/login/completed") {
        const failure = isFailedLoginEvent(message.params);
        this.state = failure ? "signed_out" : "ready";
        this.lastError = failure ? "ChatGPT 登录未完成" : null;
      }
      return;
    }
    this.pushEvent("server/protocol_error", { reason: "JSON-RPC 消息缺少 method 或响应结果" });
  }

  private registerApproval(child: ServerProcess, rpcId: JsonRpcId, method: string, params: unknown): void {
    const id = randomUUID();
    const timer = setTimeout(() => {
      const approval = this.approvals.get(id);
      if (!approval || approval.process !== child) return;
      this.approvals.delete(id);
      this.writeTo(child, { id: rpcId, result: { decision: "decline" } });
      this.pushEvent("approval/expired", { id, method, reason: "审批等待超时，已安全拒绝" });
    }, this.approvalTimeoutMs);
    timer.unref?.();
    this.approvals.set(id, { rpcId, method, params, receivedAt: new Date().toISOString(), process: child, timer });
    this.pushEvent("approval/requested", { id, method, params });
  }

  private handleExit(child: ServerProcess, code: number | null, signal: NodeJS.Signals | null): void {
    const intentional = this.intentionallyStopping.has(child);
    this.cleanupProcess(child, new Error(intentional ? "Codex App Server 已停止" : "Codex App Server 已退出"));
    if (this.process !== child) return;
    this.process = null;
    this.initialized = false;
    if (intentional || code === 0) {
      this.state = "unavailable";
      if (intentional) this.lastError = null;
      return;
    }
    this.state = "error";
    this.lastError = `Codex App Server 已退出（${code ?? signal ?? "unknown"}）`;
    this.pushEvent("server/exited", { code, signal, message: this.lastError });
  }

  private cleanupProcess(child: ServerProcess, error: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.process !== child) continue;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    }
    for (const [id, approval] of this.approvals) {
      if (approval.process !== child) continue;
      clearTimeout(approval.timer);
      this.approvals.delete(id);
      this.pushEvent("approval/expired", { id, method: approval.method, reason: error.message });
    }
  }

  private async terminateDefault(child: ServerProcess): Promise<void> {
    if (child.exitCode !== null) return;
    if (process.platform === "win32" && child.pid) {
      await new Promise<void>((resolveStop) => {
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        const timer = setTimeout(resolveStop, this.stopTimeoutMs);
        const finish = () => { clearTimeout(timer); resolveStop(); };
        killer.once("error", finish);
        killer.once("close", finish);
      });
      return;
    }
    child.kill();
    await new Promise<void>((resolveStop) => {
      if (child.exitCode !== null) return resolveStop();
      const timer = setTimeout(resolveStop, this.stopTimeoutMs);
      child.once("exit", () => { clearTimeout(timer); resolveStop(); });
    });
  }

  private pushEvent(method: string, params: unknown): void {
    const event = { method, params, at: new Date().toISOString() };
    this.events.push(event);
    if (this.events.length > 500) this.events.splice(0, this.events.length - 500);
    this.emit("event", event);
  }
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function jsonRpcError(method: string, value: unknown): Error {
  if (!value || typeof value !== "object") return new Error(`${method} 请求失败`);
  const error = value as { code?: unknown; message?: unknown };
  const code = typeof error.code === "number" || typeof error.code === "string" ? `（${String(error.code)}）` : "";
  const message = typeof error.message === "string" && error.message.trim() ? error.message.trim().slice(0, 1_000) : "未知协议错误";
  return new Error(`${method} 请求失败${code}：${message}`);
}

function redactDiagnostic(value: string): string {
  return value.replace(/\b(authorization|api[_-]?key|token|cookie|password|secret)\b\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
}

function isFailedLoginEvent(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const params = value as { success?: unknown; error?: unknown };
  return params.success === false || Boolean(params.error);
}

function hasSignedInAccount(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const account = (value as { account?: unknown }).account;
  return Boolean(account && typeof account === "object" && !Array.isArray(account) && Object.keys(account).length > 0);
}
