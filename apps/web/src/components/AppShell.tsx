import { Suspense, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { NavLink, Outlet } from "react-router-dom";
import {
  Tray, Browser, ChartLineUp, ChatCircleDots, CirclesThreePlus, ClipboardText, Cpu, House,
  List, Package, PauseCircle, Robot, ShieldWarning, SlidersHorizontal, Storefront, X
} from "@phosphor-icons/react";
import type { DashboardSnapshot } from "@jianzuo/contracts";
import { api, formatTime, jsonBody } from "../api";
import { useAuth } from "../auth";
import { EmergencyResumeDialog, type EmergencyResumePayload } from "./EmergencyResumeDialog";
import { Button, LoadingState, StatusPill } from "./ui";

const NAV = [
  { to: "/", label: "经营总览", icon: House, end: true },
  { to: "/products", label: "商品库", icon: Storefront },
  { to: "/content", label: "内容工厂", icon: CirclesThreePlus },
  { to: "/publish", label: "发布中心", icon: ClipboardText },
  { to: "/inbox", label: "消息客服", icon: ChatCircleDots },
  { to: "/orders", label: "订单与交付", icon: Package },
  { to: "/browser", label: "账号中心", icon: Browser },
  { to: "/codex", label: "Codex 任务", icon: Robot },
  { to: "/analytics", label: "经营分析", icon: ChartLineUp },
  { to: "/operations", label: "系统运维", icon: Cpu },
  { to: "/settings", label: "设置与安全", icon: SlidersHorizontal }
] as const;

export function AppShell() {
  const [todoOpen, setTodoOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [resumeOpen, setResumeOpen] = useState(false);
  const [emergencyError, setEmergencyError] = useState("");
  const auth = useAuth();
  const queryClient = useQueryClient();
  const dashboard = useQuery({
    queryKey: ["dashboard"],
    queryFn: async () => (await api<DashboardSnapshot>("/api/dashboard")).data!,
    refetchInterval: 8_000
  });
  const emergency = useMutation({
    mutationFn: async (command: { pause: true } | { pause: false; payload: EmergencyResumePayload }) => api(command.pause ? "/api/emergency-stop" : "/api/emergency-resume", {
      method: "POST",
      ...(command.pause ? {} : jsonBody(command.payload))
    }),
    onSuccess: async () => {
      setResumeOpen(false);
      setEmergencyError("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard-page"] }),
        queryClient.invalidateQueries({ queryKey: ["settings"] })
      ]);
    },
    onError: async (error) => {
      setEmergencyError(error instanceof Error ? error.message : "紧急控制操作失败");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard-page"] }),
        queryClient.invalidateQueries({ queryKey: ["settings"] })
      ]);
    }
  });
  const data = dashboard.data;
  const calibrationStage = data?.calibrationStage ?? "LOCKED";
  const calibrated = calibrationStage !== "LOCKED";
  const triggerEmergency = () => {
    setEmergencyError("");
    if (data?.automationPaused) setResumeOpen(true);
    else emergency.mutate({ pause: true });
  };

  return <div className="app-frame">
    <aside className={`sidebar ${navOpen ? "sidebar-open" : ""}`}>
      <div className="sidebar-brand"><div className="brand-mark"><span>简</span></div><div><strong>简作</strong><span>AI 运营工作台</span></div><button className="icon-button mobile-only" onClick={() => setNavOpen(false)} aria-label="关闭导航"><X /></button></div>
      <div className="phase-badge"><span>{calibrated ? "阶段 B" : "阶段 A"}</span><strong>{calibrationLabel(calibrationStage, data?.browserStatus)}</strong></div>
      <nav aria-label="主导航">
        {NAV.map((item) => { const Icon = item.icon; return <NavLink key={item.to} to={item.to} end={"end" in item ? item.end : false} onClick={() => setNavOpen(false)} className={({ isActive }) => isActive ? "active" : ""}><Icon size={20} /><span>{item.label}</span></NavLink>; })}
      </nav>
      <div className="sidebar-foot">
        <button className={`emergency-button ${data?.automationPaused ? "paused" : ""}`} onClick={triggerEmergency} disabled={emergency.isPending}>
          {data?.automationPaused ? <PauseCircle size={20} weight="fill" /> : <ShieldWarning size={20} />}<span><strong>{data?.automationPaused ? "自动化已暂停" : "紧急停止"}</strong><small>{data?.automationPaused ? "验证 PIN 后人工恢复" : "立即停止所有写操作"}</small></span>
        </button>
        {emergencyError && !resumeOpen && <span className="emergency-inline-error" role="alert">{emergencyError}</span>}
        <button className="lock-button" onClick={() => void auth.lock()}>锁定工作台</button>
      </div>
    </aside>
    {navOpen && <button className="sidebar-backdrop" onClick={() => setNavOpen(false)} aria-label="关闭导航" />}

    <div className="workspace">
      <header className="topbar">
        <button className="icon-button nav-toggle" onClick={() => setNavOpen(true)} aria-label="打开导航"><List size={22} /></button>
        <div className="top-status" aria-label="系统状态">
          <StatusPill tone={data?.accountStatus === "ONLINE" ? "success" : "neutral"}>闲鱼 {accountLabel(data?.accountStatus)}</StatusPill>
          <StatusPill tone={data?.browserStatus === "online" ? "success" : data?.browserStatus === "verification_required" ? "danger" : "neutral"}>连接器 {browserLabel(data?.browserStatus)}</StatusPill>
          <StatusPill tone={data?.codexStatus === "ready" ? "success" : data?.codexStatus === "error" ? "danger" : "neutral"}>Codex {codexLabel(data?.codexStatus)}</StatusPill>
          {data?.automationPaused && <StatusPill tone="danger">写操作暂停</StatusPill>}
        </div>
        <div className="top-actions"><span className="local-badge">127.0.0.1</span><button className="todo-button" onClick={() => setTodoOpen(true)}><Tray size={19} /><span>待办</span>{Boolean(data?.attention.length) && <b>{data?.attention.length}</b>}</button></div>
      </header>
      <main className="main-content"><Suspense fallback={<LoadingState label="正在打开页面" />}><Outlet /></Suspense></main>
    </div>

    <aside className={`todo-drawer ${todoOpen ? "open" : ""}`} aria-hidden={!todoOpen}>
      <div className="drawer-header"><div><p className="eyebrow">必须人工处理</p><h2>人工待办</h2></div><button className="icon-button" onClick={() => setTodoOpen(false)} aria-label="关闭待办"><X /></button></div>
      <p className="drawer-note">退款、投诉、验证、违规、范围不清和未知结果会停在这里。</p>
      <div className="todo-list">
        {!data?.attention.length && <div className="drawer-empty"><Tray size={28} /><strong>当前没有强制接管事项</strong><span>需要人工处理的风险会自动进入这里。</span></div>}
        {data?.attention.map((item) => <article key={`${item.kind}-${item.id}`} className={`todo-item ${item.kind === "RESULT_UNKNOWN" || item.kind === "REFUND_REVIEW" ? "critical" : ""}`}><div><StatusPill tone={item.kind === "RESULT_UNKNOWN" || item.kind === "REFUND_REVIEW" ? "danger" : "warning"}>{item.kind}</StatusPill><time>{formatTime(item.createdAt)}</time></div><h3>{item.title}</h3><p>{item.reason}</p></article>)}
      </div>
    </aside>
    {todoOpen && <button className="drawer-backdrop" onClick={() => setTodoOpen(false)} aria-label="关闭待办" />}
    <EmergencyResumeDialog
      open={resumeOpen}
      resultUnknownActions={data?.resultUnknownActions ?? 0}
      loading={emergency.isPending}
      error={emergencyError}
      onCancel={() => { setResumeOpen(false); setEmergencyError(""); }}
      onConfirm={(payload) => emergency.mutate({ pause: false, payload })}
    />
  </div>;
}

function accountLabel(status?: string): string {
  return ({ ONLINE: "在线", STARTING: "启动中", WAITING_LOGIN: "待扫码", WAITING_CONFIRMATION: "待确认账号", VERIFICATION_REQUIRED: "需验证", DEGRADED: "连接降级", SESSION_EXPIRED: "登录已失效", BACKOFF: "退避等待", PAUSED: "已暂停", ERROR: "异常", OFFLINE: "离线" } as Record<string, string>)[status ?? "OFFLINE"] ?? "离线";
}
function browserLabel(status?: string): string { return status === "online" ? "在线" : status === "pairing" ? "待配对" : status === "verification_required" ? "需人工" : "离线"; }
function codexLabel(status?: string): string { return status === "ready" ? "已登录" : status === "busy" ? "执行中" : status === "signed_out" ? "待登录" : status === "error" ? "异常" : "未启动"; }
function calibrationLabel(stage: string, browserStatus?: string): string {
  const label = ({
    LOCKED: "模拟训练中",
    ACCOUNT_CONFIRMED: "账号已确认",
    DRAFT_FILLED: "草稿填充已验证",
    SINGLE_PUBLISH_VERIFIED: "单件发布已验证",
    MESSAGE_TEST_VERIFIED: "测试回复已验证",
    ORDER_TEST_VERIFIED: "测试订单已验证",
    PRODUCTION_ENABLED: "生产阶段已启用"
  } as Record<string, string>)[stage] ?? "校准状态待核验";
  return stage !== "LOCKED" && browserStatus !== "online" ? `${label} · 当前离线` : label;
}
