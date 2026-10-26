import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Browser, Check, Copy, Desktop, Plug, QrCode, ShieldCheck, WarningCircle } from "@phosphor-icons/react";
import { api, formatTime, jsonBody } from "../api";
import { Button, Field, InlineAlert, LoadingState, PageHeader, Panel, SectionHeader, StatusPill } from "../components/ui";

type BrowserData = {
  runtime: Record<string, unknown>;
  availableBrowser: string | null;
  availableBrowsers?: Array<{ family: "edge" | "chrome"; label: string; path: string }>;
  pageBinding?: Record<string, unknown>;
  calibration?: { stage: string; accountLabel?: string; updatedAt: string };
  pairing?: { paired: boolean; tokenExpiresAt: string | null; lastUsedAt: string | null };
};

export function BrowserPage() {
  const queryClient = useQueryClient();
  const [pairing, setPairing] = useState<{ code: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [realConfirmed, setRealConfirmed] = useState(false);
  const [browserFamily, setBrowserFamily] = useState<"edge" | "chrome">("edge");
  const [itemId, setItemId] = useState("");
  const [feedback, setFeedback] = useState("");
  const status = useQuery({ queryKey: ["browser-status"], queryFn: async () => (await api<BrowserData>("/api/browser/status")).data!, refetchInterval: 4_000 });
  const pair = useMutation({ mutationFn: async () => api<{ code: string; expiresAt: string }>("/api/browser/pairing-code", { method: "POST" }), onSuccess: (response) => { setPairing(response.data!); setFeedback(""); } });
  const connectPairing = useMutation({
    mutationFn: async () => {
      if (!pairing) throw new Error("请先生成配对码");
      await pairCurrentBrowserExtension(pairing.code);
    },
    onSuccess: async () => {
      setPairing(null);
      setFeedback("扩展已连接本地工作台");
      await queryClient.invalidateQueries({ queryKey: ["browser-status"] });
    },
    onError: (error) => setFeedback(error instanceof Error ? error.message : "扩展配对失败")
  });
  const launch = useMutation({ mutationFn: async (mode: "mock" | "real") => api("/api/browser/start", { method: "POST", ...jsonBody({ mode, browser: browserFamily, confirmation: mode === "real" ? "START_REAL_CALIBRATION" : undefined }) }), onSuccess: async (response) => { setFeedback(response.summary); await queryClient.invalidateQueries({ queryKey: ["browser-status"] }); }, onError: (error) => setFeedback(error instanceof Error ? error.message : "启动失败") });
  const openFront = useMutation({ mutationFn: async (target: "home" | "messages" | "orders" | "publish" | "profile" | "item") => api("/api/browser/open", { method: "POST", ...jsonBody({ target, itemId: target === "item" ? itemId : undefined, browser: browserFamily }) }), onSuccess: (response) => setFeedback(response.summary), onError: (error) => setFeedback(error instanceof Error ? error.message : "打开失败") });
  const stop = useMutation({ mutationFn: async () => api("/api/browser/stop", { method: "POST" }), onSuccess: async (response) => { setFeedback(response.summary); await queryClient.invalidateQueries({ queryKey: ["browser-status"] }); } });
  const confirmAccount = useMutation({
    mutationFn: async () => api("/api/calibration/confirm-account", { method: "POST", ...jsonBody({ confirmation: "CONFIRM_VISIBLE_ACCOUNT" }) }),
    onSuccess: async (response) => { setFeedback(response.summary); await queryClient.invalidateQueries({ queryKey: ["browser-status"] }); },
    onError: (error) => setFeedback(error instanceof Error ? error.message : "账号确认失败")
  });
  const runtime = status.data?.runtime;
  const runtimeStatus = String(runtime?.status ?? "offline");
  const visibleAccountLabel = String(status.data?.pageBinding?.accountLabel ?? "").trim();
  const visibleAccountFingerprint = String(status.data?.pageBinding?.accountFingerprint ?? "").trim();
  const canConfirmAccount = runtimeStatus === "online" && Boolean(visibleAccountLabel) && /^[a-f0-9]{64}$/i.test(visibleAccountFingerprint) && status.data?.calibration?.stage === "LOCKED";

  return <div className="page-stack">
    <PageHeader eyebrow="账号与专用浏览器" title="账号中心" description="单账号绑定、独立 Chrome / Edge 资料目录、前台聚焦与扫码登录状态都在这里管理；扩展不接触 Cookie。" />
    {status.isLoading ? <LoadingState /> : <div className="browser-grid">
      <Panel className="browser-status-card">
        <SectionHeader title="当前连接" description="资料目录不会进入数据库、日志或备份。" />
        <div className="browser-hero"><span className={runtimeStatus === "online" ? "online" : ""}><Browser size={42} weight="duotone" /></span><div><StatusPill tone={runtimeStatus === "online" ? "success" : runtimeStatus === "verification_required" ? "danger" : runtimeStatus === "pairing" ? "warning" : "neutral"}>{runtimeLabel(runtimeStatus)}</StatusPill><h2>{status.data?.availableBrowser ? "已找到可用浏览器" : "未找到 Chrome 或 Edge"}</h2><p>{status.data?.availableBrowser ?? "请先安装 Chrome 或 Edge"}</p></div></div>
        <dl className="runtime-list"><div><dt>连接器</dt><dd>{String(runtime?.connector ?? "MOCK")}</dd></div><div><dt>当前页面</dt><dd>{String(runtime?.page_type ?? "尚未识别")}</dd></div><div><dt>最近心跳</dt><dd>{formatTime(String(runtime?.last_heartbeat_at ?? ""))}</dd></div><div><dt>DOM 指纹</dt><dd className="mono">{String(runtime?.dom_fingerprint ?? "—").slice(0, 20)}</dd></div></dl>
        <dl className="runtime-list"><div><dt>可见账号</dt><dd>{String(status.data?.pageBinding?.accountLabel || "等待识别")}</dd></div><div><dt>账号指纹</dt><dd className="mono">{visibleAccountFingerprint ? visibleAccountFingerprint.slice(0, 12) : "等待识别"}</dd></div><div><dt>校准阶段</dt><dd>{calibrationLabel(status.data?.calibration?.stage ?? "LOCKED")}</dd></div><div><dt>页面绑定</dt><dd className="mono">{String(status.data?.pageBinding?.pageUrl || "—")}</dd></div><div><dt>适配器</dt><dd className="mono">{String(status.data?.pageBinding?.adapterVersion || "—")}</dd></div></dl>
        {canConfirmAccount && <InlineAlert tone="warning" title="请核对账号">专用浏览器当前显示“{visibleAccountLabel}”。确认无误后，才会解锁“只填草稿”。</InlineAlert>}
        {runtimeStatus === "verification_required" && <InlineAlert tone="danger">检测到验证、页面变化或不确定结果。所有写动作已停止，需要你在浏览器中处理。</InlineAlert>}
        {feedback && <InlineAlert tone={/失败|无法|拒绝|停止|需要|未找到/.test(feedback) ? "danger" : "success"}>{feedback}</InlineAlert>}
        <Field label="专用浏览器"><select value={browserFamily} onChange={(event) => setBrowserFamily(event.target.value as "edge" | "chrome")}><option value="edge">Microsoft Edge</option><option value="chrome">Google Chrome</option></select></Field>
        <div className="button-row"><Button variant="secondary" onClick={() => launch.mutate("mock")} loading={launch.isPending}><Desktop /> 打开模拟闲鱼</Button>{canConfirmAccount && <Button onClick={() => confirmAccount.mutate()} loading={confirmAccount.isPending}><Check /> 确认并绑定此账号</Button>}<Button variant="ghost" onClick={() => stop.mutate()} loading={stop.isPending}>停止浏览器</Button></div>
        <div className="button-row"><Button size="small" variant="ghost" onClick={() => openFront.mutate("home")}>打开前台</Button><Button size="small" variant="ghost" onClick={() => openFront.mutate("messages")}>聚焦聊天</Button><Button size="small" variant="ghost" onClick={() => openFront.mutate("publish")}>聚焦发布页</Button><Button size="small" variant="ghost" onClick={() => openFront.mutate("orders")}>聚焦订单</Button></div>
        <div className="delivery-link-row"><input value={itemId} onChange={(event) => setItemId(event.target.value)} placeholder="闲鱼商品编号" inputMode="numeric" /><Button size="small" variant="secondary" disabled={!itemId.trim()} onClick={() => openFront.mutate("item")} loading={openFront.isPending}>聚焦商品</Button></div>
      </Panel>

      <Panel>
        <SectionHeader title="连接助手配对" description="一次性配对码 5 分钟有效。8 小时短期令牌只保存在扩展本地，在线心跳会滚动续期。" />
        {!pairing ? <div className="pairing-empty"><Plug size={38} /><h3>{status.data?.pairing?.paired ? "扩展已配对" : "扩展尚未配对"}</h3><p>{status.data?.pairing?.paired ? `令牌有效期至 ${formatTime(status.data.pairing.tokenExpiresAt)}` : "先用独立浏览器加载项目中的“简作连接助手”，再生成配对码。"}</p><Button variant={status.data?.pairing?.paired ? "secondary" : "primary"} onClick={() => pair.mutate()} loading={pair.isPending}><QrCode /> {status.data?.pairing?.paired ? "重新配对" : "生成配对码"}</Button></div> : <div className="pairing-code"><span>连接当前专用浏览器</span><strong>{pairing.code}</strong><small>有效期至 {formatTime(pairing.expiresAt)}</small><Button onClick={() => connectPairing.mutate()} loading={connectPairing.isPending}><Plug /> 一键连接扩展</Button><Button variant="secondary" onClick={async () => { await navigator.clipboard.writeText(pairing.code); setCopied(true); }}><Copy /> {copied ? "已复制" : "复制配对码"}</Button><small>若一键连接提示扩展不可用，再打开“简作连接助手”手工输入此码。</small></div>}
        <div className="extension-checks"><div><Check weight="bold" /> Manifest V3</div><div><Check weight="bold" /> 无 cookies 权限</div><div><Check weight="bold" /> 页面变化即停机</div><div><Check weight="bold" /> 截图与指纹回执</div></div>
      </Panel>

      <Panel className="real-calibration-panel">
        <SectionHeader title="开始真实账号校准" description="只有你主动开启后，工作台才会打开真实闲鱼页面。" />
        <InlineAlert tone="warning" title="不是自动放量">先扫码，再依次验证只读识别、草稿填充、单件发布和受控测试订单。不要使用第一位真实买家测试。</InlineAlert>
        <ol><li><span>1</span><div><strong>扫码登录</strong><p>登录凭据只留在独立浏览器资料目录。</p></div></li><li><span>2</span><div><strong>只读检查</strong><p>确认页面类型、商品和消息读取正确。</p></div></li><li><span>3</span><div><strong>单件受控测试</strong><p>每一步保留截图、DOM 指纹和回执。</p></div></li></ol>
        <label className="check-control"><input type="checkbox" checked={realConfirmed} onChange={(event) => setRealConfirmed(event.target.checked)} /><span><strong>我确认现在开始真实账号校准</strong><small>遇到验证码、人脸、滑块或结果未知会立即停止。</small></span></label>
        <Button variant="danger" disabled={!realConfirmed} onClick={() => launch.mutate("real")} loading={launch.isPending}><ShieldCheck /> 打开真实闲鱼扫码页</Button>
      </Panel>
      <Panel className="browser-safety-panel"><WarningCircle size={24} weight="fill" /><div><strong>明确不做</strong><p>不导出 Cookie，不调用私有签名接口，不做反检测，不绕过验证码、滑块或人脸验证。</p></div></Panel>
    </div>}
  </div>;
}

function runtimeLabel(status: string): string { return ({ online: "扩展在线", offline: "扩展离线", pairing: "等待配对", verification_required: "需要人工处理" } as Record<string, string>)[status] ?? status; }
function calibrationLabel(stage: string): string { return ({ LOCKED: "未确认账号", ACCOUNT_CONFIRMED: "账号已确认", DRAFT_FILLED: "草稿填充已验证", SINGLE_PUBLISH_VERIFIED: "单件发布已验证", MESSAGE_TEST_VERIFIED: "测试消息已验证", ORDER_TEST_VERIFIED: "测试订单已验证", PRODUCTION_ENABLED: "正常自动化已启用" } as Record<string, string>)[stage] ?? stage; }

function pairCurrentBrowserExtension(code: string): Promise<void> {
  const origin = "http://127.0.0.1:8787";
  if (window.location.origin !== origin) return Promise.reject(new Error("请从 127.0.0.1 本地工作台完成扩展配对"));
  const requestId = crypto.randomUUID();
  return new Promise((resolvePairing, rejectPairing) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener("message", onMessage);
      rejectPairing(new Error("未检测到当前浏览器中的简作连接助手，请改用扩展弹窗输入配对码"));
    }, 5_000);
    const onMessage = (event: MessageEvent) => {
      const message = event.data as { source?: string; type?: string; requestId?: string; ok?: boolean; error?: string };
      if (event.source !== window || event.origin !== origin || message?.source !== "jianzuo-extension" || message.type !== "pair-result" || message.requestId !== requestId) return;
      window.clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
      if (message.ok) resolvePairing();
      else rejectPairing(new Error(message.error || "扩展配对失败"));
    };
    window.addEventListener("message", onMessage);
    window.postMessage({ source: "jianzuo-workbench", type: "pair-extension", requestId, code }, origin);
  });
}
