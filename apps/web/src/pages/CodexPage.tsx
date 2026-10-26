import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowClockwise, Check, Code, PaperPlaneRight, Robot, ShieldCheck, SignIn, X } from "@phosphor-icons/react";
import { api, formatTime, jsonBody } from "../api";
import { Button, EmptyState, ErrorState, InlineAlert, LoadingState, PageHeader, Panel, SectionHeader, StatusPill } from "../components/ui";
import { codexAccountTitle } from "../safety";

type CodexStatus = {
  state: "unavailable" | "signed_out" | "ready" | "busy" | "error";
  lastError: string | null;
  running: boolean;
  pendingApprovals: number;
  account: Record<string, unknown> | null;
  threads: Array<Record<string, unknown>>;
  approvals: Array<Record<string, unknown>>;
};

export function CodexPage() {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState("请检查当前商品准备情况，给出今天最应该先完成的三件事。不要直接操作闲鱼，只输出建议和结构化动作提案。");
  const [feedback, setFeedback] = useState("");
  const status = useQuery({ queryKey: ["codex-status"], queryFn: async () => (await api<CodexStatus>("/api/codex/status")).data!, refetchInterval: 8_000, retry: false });
  const events = useQuery({ queryKey: ["codex-events"], queryFn: async () => (await api<Array<Record<string, unknown>>>("/api/codex/events")).data!, refetchInterval: 3_000 });
  const shopThread = useMemo(() => status.data?.threads.find((item) => item.scope_type === "shop" && item.scope_id === "main"), [status.data]);
  const login = useMutation({ mutationFn: async () => api("/api/codex/login", { method: "POST" }), onSuccess: (response) => setFeedback(response.summary), onError: (error) => setFeedback(error instanceof Error ? error.message : "登录启动失败") });
  const createThread = useMutation({ mutationFn: async () => api("/api/codex/threads", { method: "POST", ...jsonBody({ scopeType: "shop", scopeId: "main", title: "店铺运营主会话" }) }), onSuccess: async (response) => { setFeedback(response.summary); await queryClient.invalidateQueries({ queryKey: ["codex-status"] }); } });
  const send = useMutation({ mutationFn: async () => api("/api/codex/turns", { method: "POST", ...jsonBody({ scopeType: "shop", scopeId: "main", message }) }), onSuccess: (response) => setFeedback(response.summary), onError: (error) => setFeedback(error instanceof Error ? error.message : "任务启动失败") });
  const approval = useMutation({ mutationFn: async ({ id, decision }: { id: string; decision: "accept" | "decline" }) => api(`/api/codex/approvals/${id}`, { method: "POST", ...jsonBody({ decision }) }), onSuccess: async () => queryClient.invalidateQueries({ queryKey: ["codex-status"] }) });

  return <div className="page-stack">
    <PageHeader eyebrow="本机 Codex 协作" title="Codex 任务中心" description="使用本机 Codex 登录和额度，不要求 API Key。Codex 负责生成与制作，闲鱼动作仍由策略引擎和扩展执行。" actions={<Button variant="secondary" onClick={() => void status.refetch()}><ArrowClockwise /> 刷新状态</Button>} />
    {status.isLoading ? <LoadingState label="正在连接本机 Codex" /> : status.error || !status.data ? <ErrorState message={status.error instanceof Error ? status.error.message : "Codex 不可用"} retry={() => void status.refetch()} /> : <div className="codex-layout">
      <Panel className="codex-status-panel">
        <SectionHeader title="本机连接" />
        <div className="codex-identity"><span><Robot size={38} weight="duotone" /></span><div><StatusPill tone={status.data.state === "ready" ? "success" : status.data.state === "error" ? "danger" : "warning"}>{codexStateLabel(status.data.state)}</StatusPill><h2>{codexAccountTitle(status.data.account)}</h2><p>{status.data.running ? "Codex App Server 正在本机运行" : "尚未启动 App Server"}</p></div></div>
        {status.data.lastError && <InlineAlert tone="danger">{status.data.lastError}</InlineAlert>}
        {status.data.state === "signed_out" && <Button onClick={() => login.mutate()} loading={login.isPending}><SignIn /> 使用 ChatGPT 登录</Button>}
        <dl className="runtime-list"><div><dt>主会话</dt><dd>{shopThread ? "已持久化" : "未创建"}</dd></div><div><dt>待审批</dt><dd>{status.data.pendingApprovals}</dd></div><div><dt>目录权限</dt><dd>当前项目</dd></div><div><dt>API Key</dt><dd>不需要</dd></div></dl>
        <InlineAlert tone="info">额外目录会显示 Codex 原生权限请求，默认只授权当前回合，任务结束自动收回。</InlineAlert>
      </Panel>

      <Panel className="codex-chat-panel">
        <div className="codex-chat-head"><div><p className="eyebrow">店铺主任务</p><h2>店铺运营主会话</h2></div><StatusPill tone={shopThread ? "success" : "neutral"}>{shopThread ? "已连接" : "待创建"}</StatusPill></div>
        {!shopThread ? <EmptyState title="创建持久运营会话" description="商品策划使用独立线程；订单 Codex 在单订单工作区隔离验收前保持禁用。" action={<Button onClick={() => createThread.mutate()} loading={createThread.isPending}><Code /> 创建主会话</Button>} /> : <>
          <div className="codex-event-stream">{!events.data?.length ? <div className="event-empty"><Robot /><span>发送第一个任务后，流式进度会显示在这里。</span></div> : events.data.slice(-16).map((event, index) => <article key={`${String(event.at)}-${index}`}><span>{eventIcon(String(event.method))}</span><div><strong>{eventLabel(String(event.method))}</strong><p>{eventSummary(event.params)}</p><time>{formatTime(String(event.at))}</time></div></article>)}</div>
          <div className="codex-composer"><textarea rows={5} value={message} onChange={(event) => setMessage(event.target.value)} /><div><span>默认工作区：当前项目</span><Button onClick={() => send.mutate()} loading={send.isPending} disabled={!message.trim()}><PaperPlaneRight /> 交给 Codex</Button></div></div>
        </>}
        {feedback && <InlineAlert tone={feedback.includes("失败") ? "danger" : "success"}>{feedback}</InlineAlert>}
      </Panel>

      <Panel className="codex-approvals-panel">
        <SectionHeader title="权限审批" description="命令、文件和额外目录请求不会静默通过。" />
        {!status.data.approvals.length ? <div className="approval-empty"><ShieldCheck size={26} /><span>当前没有待审批请求</span></div> : status.data.approvals.map((item) => <article key={String(item.id)}><div><StatusPill tone="warning">需要你的决定</StatusPill><time>{formatTime(String(item.receivedAt))}</time></div><h3>{approvalLabel(String(item.method))}</h3><p>{eventSummary(item.params)}</p><div><Button size="small" onClick={() => approval.mutate({ id: String(item.id), decision: "accept" })}><Check /> 仅本次允许</Button><Button size="small" variant="danger" onClick={() => approval.mutate({ id: String(item.id), decision: "decline" })}><X /> 拒绝</Button></div></article>)}
      </Panel>
    </div>}
  </div>;
}

function codexStateLabel(state: CodexStatus["state"]): string { return ({ unavailable: "未启动", signed_out: "待登录", ready: "已就绪", busy: "执行中", error: "连接异常" } as const)[state]; }
function eventLabel(method: string): string { if (method.includes("turn/started")) return "任务开始"; if (method.includes("turn/completed")) return "任务完成"; if (method.includes("item/")) return "任务进度"; if (method.includes("approval")) return "等待审批"; if (method.includes("stderr")) return "运行信息"; return method; }
function eventIcon(method: string) { return method.includes("completed") ? <Check /> : method.includes("approval") ? <ShieldCheck /> : <Robot />; }
function eventSummary(params: unknown): string { const value = JSON.stringify(params ?? {}); return value.length > 180 ? `${value.slice(0, 180)}…` : value; }
function approvalLabel(method: string): string { return method.includes("command") ? "执行本机命令" : method.includes("file") || method.includes("patch") ? "修改本机文件" : "请求额外权限"; }
