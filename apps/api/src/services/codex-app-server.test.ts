import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAppServer } from "./codex-app-server.js";

type RpcMessage = { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: unknown };
const NO_RESPONSE = Symbol("NO_RESPONSE");
const activeServers: CodexAppServer[] = [];

class FakeProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid: number;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  asChild(): ChildProcessWithoutNullStreams {
    return this as unknown as ChildProcessWithoutNullStreams;
  }

  announceSpawn(): void {
    this.emit("spawn");
  }

  send(message: RpcMessage): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  sendRaw(line: string): void {
    this.stdout.write(`${line}\n`);
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    this.emit("exit", code, signal);
  }

  kill(): boolean {
    this.killed = true;
    queueMicrotask(() => this.exit(0));
    return true;
  }
}

type HandlerResult = { result?: unknown; error?: unknown } | typeof NO_RESPONSE;

function createHarness(
  pid: number,
  handler: (message: RpcMessage) => HandlerResult = defaultHandler,
  autoSpawn = true
) {
  const child = new FakeProcess(pid);
  const messages: RpcMessage[] = [];
  let buffer = "";
  child.stdin.setEncoding("utf8");
  child.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const newline = buffer.indexOf("\n");
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line) as RpcMessage;
      messages.push(message);
      if (message.id === undefined || !message.method) continue;
      const response = handler(message);
      if (response === NO_RESPONSE) continue;
      queueMicrotask(() => child.send({ id: message.id, ...response }));
    }
  });
  if (autoSpawn) queueMicrotask(() => child.announceSpawn());
  return {
    child,
    messages,
    requests(method: string): RpcMessage[] {
      return messages.filter((message) => message.method === method);
    },
    respond(message: RpcMessage, result: unknown): void {
      if (message.id === undefined) throw new Error("request has no id");
      child.send({ id: message.id, result });
    }
  };
}

function defaultHandler(message: RpcMessage): HandlerResult {
  switch (message.method) {
    case "initialize": return { result: { serverInfo: { name: "fake-codex" } } };
    case "account/read": return { result: { account: { type: "chatgpt" } } };
    case "account/login/start": return { result: { loginId: "login-1" } };
    case "thread/start": return { result: { thread: { id: "thread-1" } } };
    case "thread/resume": return { result: { thread: { id: (message.params as { threadId: string }).threadId } } };
    case "turn/start": return { result: { turn: { id: "turn-1" } } };
    default: return { result: {} };
  }
}

function track(server: CodexAppServer): CodexAppServer {
  activeServers.push(server);
  return server;
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

afterEach(async () => {
  await Promise.all(activeServers.splice(0).map((server) => server.stop()));
  vi.restoreAllMocks();
});

describe("CodexAppServer", () => {
  it("uses the signed-in Codex account without requiring an API key and preserves thread/ImageGen contracts", async () => {
    const harness = createHarness(101);
    const spawnProcess = vi.fn((_command: string, _args: string[], _options: unknown) => harness.child.asChild());
    const terminateProcess = vi.fn(async () => harness.child.exit(0));
    const server = track(new CodexAppServer({ spawnProcess, terminateProcess, requestTimeoutMs: 200 }));

    await server.ensureStarted();

    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(spawnProcess).toHaveBeenCalledWith("codex", ["app-server", "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    expect(spawnProcess.mock.calls[0]?.[2]).not.toHaveProperty("env");
    expect(server.status()).toMatchObject({ state: "ready", running: true, lastError: null });

    await expect(server.startChatGptLogin()).resolves.toEqual({ loginId: "login-1" });
    const started = await server.startThread("C:\\workbench", "商品策划");
    await expect(server.resumeThread(started.threadId)).resolves.toMatchObject({ thread: { id: "thread-1" } });
    await expect(server.startTurn(started.threadId, "请使用 $imagegen 生成内部案例图，但不要操作闲鱼", ["C:\\workbench"]))
      .resolves.toMatchObject({ turn: { id: "turn-1" } });

    const threadRequest = harness.requests("thread/start")[0];
    expect(threadRequest?.params).toMatchObject({
      cwd: "C:\\workbench",
      runtimeWorkspaceRoots: ["C:\\workbench"],
      permissions: ":workspace",
      ephemeral: false
    });
    expect(String((threadRequest?.params as { developerInstructions: string }).developerInstructions)).toContain("不得直接点击闲鱼");
    const turnRequest = harness.requests("turn/start")[0];
    expect(turnRequest?.params).toMatchObject({
      threadId: "thread-1",
      input: [{ type: "text", text: "请使用 $imagegen 生成内部案例图，但不要操作闲鱼" }],
      runtimeWorkspaceRoots: ["C:\\workbench"],
      permissions: ":workspace"
    });

    harness.child.send({ method: "turn/completed", params: { threadId: "thread-1", turnId: "turn-1" } });
    await settle();
    expect(server.status().state).toBe("ready");
  });

  it("serializes concurrent startup so callers cannot pass initialization early", async () => {
    let initializeRequest: RpcMessage | undefined;
    const harness = createHarness(102, (message) => {
      if (message.method === "initialize") {
        initializeRequest = message;
        return NO_RESPONSE;
      }
      return defaultHandler(message);
    });
    const spawnProcess = vi.fn(() => harness.child.asChild());
    const server = track(new CodexAppServer({
      spawnProcess,
      terminateProcess: async () => harness.child.exit(0),
      requestTimeoutMs: 200
    }));

    const first = server.ensureStarted();
    const second = server.ensureStarted();
    await settle();

    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(initializeRequest).toBeDefined();
    expect(server.status()).toMatchObject({ running: true, state: "unavailable" });
    harness.respond(initializeRequest!, { serverInfo: { name: "fake-codex" } });
    await Promise.all([first, second]);
    expect(server.status().state).toBe("ready");
  });

  it("handles approvals safely, rejects unknown server requests, and expires unattended approval requests", async () => {
    const harness = createHarness(103);
    const server = track(new CodexAppServer({
      spawnProcess: () => harness.child.asChild(),
      terminateProcess: async () => harness.child.exit(0),
      approvalTimeoutMs: 20,
      requestTimeoutMs: 200
    }));
    await server.ensureStarted();

    harness.child.send({
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", command: "read-only-check" }
    });
    await settle();
    const pending = server.pendingApprovals()[0];
    expect(pending).toMatchObject({ rpcId: "approval-1", method: "item/commandExecution/requestApproval" });
    expect(server.resolveApproval(pending!.id, "accept")).toBe(true);
    expect(harness.messages).toContainEqual({ id: "approval-1", result: { decision: "accept" } });
    expect(server.resolveApproval(pending!.id, "accept")).toBe(false);

    harness.child.send({ id: "unsupported-1", method: "workspace/readSecret", params: {} });
    await settle();
    expect(harness.messages).toContainEqual({
      id: "unsupported-1",
      error: { code: -32601, message: "Unsupported server request: workspace/readSecret" }
    });

    harness.child.send({ id: "approval-2", method: "item/fileChange/requestApproval", params: { path: "C:\\outside" } });
    await new Promise((resolve) => setTimeout(resolve, 35));
    expect(server.pendingApprovals()).toHaveLength(0);
    expect(harness.messages).toContainEqual({ id: "approval-2", result: { decision: "decline" } });
    expect(server.recentEvents()).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: "approval/expired" }),
      expect.objectContaining({ method: "server/request_rejected" })
    ]));
  });

  it("surfaces protocol and request timeouts without leaking RPC error data, then ignores late replies", async () => {
    let resumeRequest: RpcMessage | undefined;
    const harness = createHarness(104, (message) => {
      if (message.method === "thread/resume") {
        resumeRequest = message;
        return NO_RESPONSE;
      }
      return defaultHandler(message);
    });
    const server = track(new CodexAppServer({
      spawnProcess: () => harness.child.asChild(),
      terminateProcess: async () => harness.child.exit(0),
      requestTimeoutMs: 20
    }));
    await server.ensureStarted();

    harness.child.sendRaw("not-json token=must-not-be-copied");
    harness.child.stderr.write("authorization=secret-value ordinary diagnostic\n");
    await expect(server.resumeThread("thread-timeout")).rejects.toThrow("thread/resume 请求超时");
    expect(resumeRequest).toBeDefined();
    harness.child.send({ id: resumeRequest!.id, result: { thread: { id: "too-late" } } });
    await settle();

    const events = server.recentEvents();
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: "server/protocol_error" }),
      expect.objectContaining({ method: "server/request_timeout" }),
      expect.objectContaining({ method: "server/orphan_response" }),
      expect.objectContaining({ method: "server/stderr", params: { message: "authorization=[REDACTED] ordinary diagnostic" } })
    ]));
    expect(JSON.stringify(events)).not.toContain("secret-value");
  });

  it("turns Codex's missing-rollout response into an actionable empty-thread recovery error", async () => {
    const harness = createHarness(111, (message) => message.method === "thread/resume"
      ? { error: { code: -32600, message: "no rollout found for thread id internal-id", data: { token: "private" } } }
      : defaultHandler(message));
    const server = track(new CodexAppServer({
      spawnProcess: () => harness.child.asChild(),
      terminateProcess: async () => harness.child.exit(0)
    }));
    await server.ensureStarted();

    await expect(server.resumeThread("empty-thread")).rejects.toThrow(
      "Codex 会话尚未完成首个任务，未形成可恢复记录；请重新创建会话并提交首个任务"
    );
  });

  it("recovers after startup timeout and prevents a stale process exit from corrupting the replacement", async () => {
    const first = createHarness(105, defaultHandler, false);
    const second = createHarness(106, defaultHandler, false);
    const processes = [first, second];
    const spawnProcess = vi.fn(() => {
      const next = processes.shift();
      if (!next) throw new Error("unexpected spawn");
      if (next === second) queueMicrotask(() => next.child.announceSpawn());
      return next.child.asChild();
    });
    const terminateProcess = vi.fn(async () => undefined);
    const server = track(new CodexAppServer({
      spawnProcess,
      terminateProcess,
      startupTimeoutMs: 15,
      requestTimeoutMs: 100
    }));

    await expect(server.ensureStarted()).rejects.toThrow("Codex App Server 启动超时");
    expect(server.status()).toMatchObject({ state: "error", running: false });
    await server.ensureStarted();
    expect(server.status()).toMatchObject({ state: "ready", running: true });

    first.child.exit(1);
    await settle();
    expect(server.status()).toMatchObject({ state: "ready", running: true, lastError: null });
    expect(spawnProcess).toHaveBeenCalledTimes(2);
  });

  it("keeps a startup failure visible even when process termination emits an exit event", async () => {
    const harness = createHarness(109, defaultHandler, false);
    const server = track(new CodexAppServer({
      spawnProcess: () => harness.child.asChild(),
      terminateProcess: async () => harness.child.exit(1),
      startupTimeoutMs: 15
    }));

    await expect(server.ensureStarted()).rejects.toThrow("Codex App Server 启动超时");
    expect(server.status()).toMatchObject({
      state: "error",
      running: false,
      lastError: "Codex App Server 启动超时"
    });
  });

  it("rejects pending work on a broken stdio channel and redacts its diagnostic", async () => {
    const harness = createHarness(110, (message) => message.method === "thread/resume" ? NO_RESPONSE : defaultHandler(message));
    const server = track(new CodexAppServer({
      spawnProcess: () => harness.child.asChild(),
      terminateProcess: async () => harness.child.exit(0),
      requestTimeoutMs: 500
    }));
    await server.ensureStarted();

    const resume = server.resumeThread("thread-stream-error");
    await settle();
    harness.child.stdin.emit("error", new Error("token=private-value pipe closed"));
    await expect(resume).rejects.toThrow("stdin 通道错误");
    expect(server.status()).toMatchObject({ state: "error", running: true });
    expect(JSON.stringify(server.recentEvents())).not.toContain("private-value");
    expect(server.recentEvents()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: "server/stream_error",
        params: { stream: "stdin", message: "token=[REDACTED] pipe closed" }
      })
    ]));
  });

  it("rejects an in-flight request on process exit and keeps intentional stop non-error", async () => {
    const harness = createHarness(107, (message) => message.method === "thread/resume" ? NO_RESPONSE : defaultHandler(message));
    const server = track(new CodexAppServer({
      spawnProcess: () => harness.child.asChild(),
      terminateProcess: async () => harness.child.exit(0),
      requestTimeoutMs: 500
    }));
    await server.ensureStarted();

    const resume = server.resumeThread("thread-in-flight");
    await settle();
    harness.child.exit(2);
    await expect(resume).rejects.toThrow("Codex App Server 已退出");
    expect(server.status()).toMatchObject({ state: "error", running: false });

    const cleanHarness = createHarness(108);
    const cleanServer = track(new CodexAppServer({
      spawnProcess: () => cleanHarness.child.asChild(),
      terminateProcess: async () => cleanHarness.child.exit(1)
    }));
    await cleanServer.ensureStarted();
    await cleanServer.stop();
    expect(cleanServer.status()).toEqual({ state: "unavailable", lastError: null, running: false, pendingApprovals: 0 });
  });
});
