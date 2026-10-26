import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  Bell,
  CloudArrowUp,
  FloppyDisk,
  Key,
  LinkSimple,
  PauseCircle,
  ShieldCheck,
  Trash,
} from "@phosphor-icons/react";
import { api, jsonBody } from "../api";
import { EmergencyResumeDialog, type EmergencyResumePayload } from "../components/EmergencyResumeDialog";
import { Button, Field, InlineAlert, LoadingState, PageHeader, Panel, SectionHeader, StatusPill } from "../components/ui";

type Settings = {
  automationPaused: boolean;
  resultUnknownActions: number;
  urgentOrdersEnabled: boolean;
  manualHours: { start: string; end: string };
  retentionDays: Record<string, number>;
  webhookConfigured: boolean;
};

type BaiduStatus = {
  configured: boolean;
  authorized: boolean;
  redirectUri: string;
  tokenExpiresAt?: string;
};

export function SettingsPage() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["settings"], queryFn: async () => (await api<Settings>("/api/settings")).data! });
  const baiduQuery = useQuery({ queryKey: ["baidu-status"], queryFn: async () => (await api<BaiduStatus>("/api/baidu/status")).data! });
  const [urgent, setUrgent] = useState(false);
  const [webhook, setWebhook] = useState("");
  const [backupPin, setBackupPin] = useState("");
  const [feedback, setFeedback] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [authorizationUrl, setAuthorizationUrl] = useState("");
  const [clearBaiduConfirmation, setClearBaiduConfirmation] = useState("");
  const [resumeOpen, setResumeOpen] = useState(false);

  useEffect(() => {
    if (query.data) setUrgent(query.data.urgentOrdersEnabled);
  }, [query.data]);

  const save = useMutation({
    mutationFn: async () => api("/api/settings", { method: "PATCH", ...jsonBody({ urgentOrdersEnabled: urgent, webhookUrl: webhook || undefined }) }),
    onSuccess: async (response) => {
      setFeedback(response.summary);
      setWebhook("");
      await queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
  });
  const backup = useMutation({
    mutationFn: async () => api<{ path: string }>("/api/backups", { method: "POST", ...jsonBody({ pin: backupPin, kind: "manual" }) }),
    onSuccess: (response) => {
      setFeedback(`${response.summary}：${response.data?.path}`);
      setBackupPin("");
    },
    onError: (error) => setFeedback(error instanceof Error ? error.message : "备份失败"),
  });
  const testWebhook = useMutation({
    mutationFn: async () => api("/api/settings/webhook/test", { method: "POST" }),
    onSuccess: (response) => setFeedback(response.summary),
    onError: (error) => setFeedback(error instanceof Error ? error.message : "Webhook 测试失败"),
  });
  const pause = useMutation({
    mutationFn: async (command: { stopped: true } | { stopped: false; payload: EmergencyResumePayload }) => api(command.stopped ? "/api/emergency-stop" : "/api/emergency-resume", {
      method: "POST",
      ...(command.stopped ? {} : jsonBody(command.payload))
    }),
    onSuccess: async (response) => {
      setFeedback(response.summary);
      setResumeOpen(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["settings"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard-page"] }),
      ]);
    },
    onError: async (error) => {
      setFeedback(error instanceof Error ? error.message : "紧急控制操作失败");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["settings"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard-page"] }),
      ]);
    },
  });
  const saveBaidu = useMutation({
    mutationFn: async () => api("/api/baidu/config", {
      method: "PATCH",
      ...jsonBody({ clientId: clientId.trim(), clientSecret }),
    }),
    onSuccess: async (response) => {
      setFeedback(response.summary);
      setAuthorizationUrl("");
      await queryClient.invalidateQueries({ queryKey: ["baidu-status"] });
    },
    onError: (error) => setFeedback(error instanceof Error ? error.message : "百度网盘配置保存失败"),
    onSettled: () => setClientSecret(""),
  });
  const authorizeBaidu = useMutation({
    mutationFn: async () => api<{ authorizationUrl: string }>("/api/baidu/authorize", { method: "POST" }),
    onSuccess: (response) => {
      setAuthorizationUrl(response.data?.authorizationUrl ?? "");
      setFeedback(response.summary);
    },
    onError: (error) => setFeedback(error instanceof Error ? error.message : "没有生成百度授权链接"),
  });
  const clearBaidu = useMutation({
    mutationFn: async () => api("/api/baidu/config", {
      method: "DELETE",
      ...jsonBody({ confirmation: clearBaiduConfirmation }),
    }),
    onSuccess: async (response) => {
      setFeedback(response.summary);
      setClientId("");
      setClientSecret("");
      setAuthorizationUrl("");
      setClearBaiduConfirmation("");
      await queryClient.invalidateQueries({ queryKey: ["baidu-status"] });
    },
    onError: (error) => setFeedback(error instanceof Error ? error.message : "百度网盘配置清除失败"),
  });

  if (query.isLoading) return <LoadingState />;
  const data = query.data;
  const baiduStatus = baiduQuery.data;

  return <div className="page-stack">
    <PageHeader eyebrow="经营设置与安全边界" title="设置与安全" description="经营规则、安全保留期和本地运维设置。敏感配置加密后写入 SQLite。" />
    {feedback && <InlineAlert tone={feedback.includes("失败") || feedback.includes("不正确") ? "danger" : "success"}>{feedback}</InlineAlert>}
    <div className="settings-grid">
      <Panel>
        <SectionHeader title="经营规则" description="底价和修改次数为固定规则，不在此处开放修改。" />
        <div className="setting-row"><div><strong>可接急单</strong><p>开启后才允许次日 +30%、当日 +50%、4 小时 +80%。</p></div><button className={`switch ${urgent ? "on" : ""}`} role="switch" aria-checked={urgent} onClick={() => setUrgent(!urgent)}><span /></button></div>
        <dl className="settings-dl"><div><dt>人工接管时间</dt><dd>{data?.manualHours.start}–{data?.manualHours.end}</dd></div><div><dt>最大优惠</dt><dd>10%</dd></div><div><dt>修改次数</dt><dd>1 / 2 / 3 次</dd></div><div><dt>退款</dt><dd><StatusPill tone="danger">永远人工</StatusPill></dd></div></dl>
        <Button onClick={() => save.mutate()} loading={save.isPending}><FloppyDisk /> 保存经营设置</Button>
      </Panel>
      <Panel>
        <SectionHeader title="通知与 Webhook" description="Windows 通知和声音默认开启；Webhook 只允许 HTTPS。" />
        <div className="notification-status"><Bell size={28} /><div><strong>Windows 本地通知</strong><p>失败、未知结果和需要人工处理时提醒。</p></div><StatusPill tone="success">已启用</StatusPill></div>
        <Field label="通用 Webhook" hint={data?.webhookConfigured ? "已保存加密地址；留空不会覆盖。" : "可选。PIN 加密用于界面测试，Windows 用户密钥加密副本供 Worker 告警。"}><input type="url" value={webhook} onChange={(event) => setWebhook(event.target.value)} placeholder="https://..." /></Field>
        <div className="button-row"><Button variant="secondary" onClick={() => save.mutate()} loading={save.isPending}>保存通知设置</Button><Button variant="ghost" disabled={!data?.webhookConfigured} onClick={() => testWebhook.mutate()} loading={testWebhook.isPending}>发送测试</Button></div>
      </Panel>
      <Panel className="baidu-panel">
        <SectionHeader
          title="百度网盘（可选）"
          description="只在交付包超过平台附件限制时使用。未配置也不影响商品、客服和本地打包。"
          actions={baiduQuery.isLoading
            ? <StatusPill>读取中</StatusPill>
            : <StatusPill tone={baiduStatus?.authorized ? "success" : baiduStatus?.configured ? "warning" : "neutral"}>{baiduStatus?.authorized ? "已授权" : baiduStatus?.configured ? "待授权" : "未配置"}</StatusPill>}
        />
        {baiduQuery.isError && <InlineAlert tone="danger">没有读取到百度网盘状态。页面其余功能仍可使用。</InlineAlert>}
        <div className="baidu-status" aria-live="polite">
          <CloudArrowUp size={30} aria-hidden="true" />
          <div><strong>{baiduStatus?.authorized ? "可尝试自动上传" : "当前使用人工分享链接降级"}</strong><p>个人账号的自动分享权限不作承诺。无法自动分享时，订单会等待你粘贴 HTTPS 分享链接后再继续。</p></div>
        </div>
        <InlineAlert tone="info">不需要 OpenAI API Key，也不强制配置百度网盘。Codex 登录、本地模板、商品准备和小文件交付仍可运行。</InlineAlert>
        <div className="baidu-fields">
          <Field label="百度应用 App Key" hint="在百度开放平台创建应用后填写。页面不会从后端回读。"><input value={clientId} onChange={(event) => setClientId(event.target.value)} autoComplete="off" spellCheck={false} placeholder="填写 App Key" /></Field>
          <Field label="百度应用 Secret Key" hint="仅在保存请求中提交，随后立即从输入框清空；页面不会显示已保存内容。"><input type="password" value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} autoComplete="new-password" placeholder="填写 Secret Key" /></Field>
        </div>
        {baiduStatus?.redirectUri && <div className="baidu-redirect"><span>授权回调地址</span><code>{baiduStatus.redirectUri}</code><small>请将此地址原样登记到百度开放平台。</small></div>}
        <div className="baidu-actions">
          <Button onClick={() => saveBaidu.mutate()} loading={saveBaidu.isPending} disabled={!clientId.trim() || !clientSecret}><FloppyDisk /> 保存加密配置</Button>
          <Button variant="secondary" onClick={() => authorizeBaidu.mutate()} loading={authorizeBaidu.isPending} disabled={!baiduStatus?.configured}><LinkSimple /> 生成授权链接</Button>
        </div>
        {authorizationUrl && <div className="baidu-authorization-ready" role="status"><div><strong>授权链接已准备好</strong><p>请主动点击右侧按钮，在新窗口登录百度并确认授权。</p></div><a className="button button-primary button-normal" href={authorizationUrl} target="_blank" rel="noreferrer">打开百度授权页面</a></div>}
        <div className="baidu-clear-zone">
          <div><strong>清除百度配置</strong><p>会移除加密的应用配置和授权状态，不影响已经保存的人工分享链接。</p></div>
          <Field label="二次确认" hint="输入 CLEAR_BAIDU_CONFIG 后才能清除。"><input value={clearBaiduConfirmation} onChange={(event) => setClearBaiduConfirmation(event.target.value)} autoComplete="off" placeholder="CLEAR_BAIDU_CONFIG" /></Field>
          <Button variant="danger" onClick={() => clearBaidu.mutate()} loading={clearBaidu.isPending} disabled={clearBaiduConfirmation !== "CLEAR_BAIDU_CONFIG"}><Trash /> 清除配置</Button>
        </div>
      </Panel>
      <Panel>
        <SectionHeader title="加密备份" description="保留 7 个日备和 4 个周备，不包含浏览器 Profile 或 Codex 凭据。" />
        <div className="backup-illustration"><Archive size={35} /><div><strong>手动创建加密快照</strong><p>使用本地 PIN 派生独立备份密钥，输出 .jzb 文件。</p></div></div>
        <Field label="当前本地 PIN"><div className="input-with-icon"><Key size={18} /><input type="password" inputMode="numeric" value={backupPin} onChange={(event) => setBackupPin(event.target.value)} placeholder="输入 PIN 以加密" /></div></Field>
        <Button onClick={() => backup.mutate()} loading={backup.isPending} disabled={!backupPin}><Archive /> 立即备份</Button>
      </Panel>
      <Panel>
        <SectionHeader title="数据保留" />
        <dl className="retention-list"><div><dt>原客户文件</dt><dd>{data?.retentionDays.sources} 天</dd></div><div><dt>交付物</dt><dd>{data?.retentionDays.deliverables} 天</dd></div><div><dt>聊天和订单</dt><dd>{data?.retentionDays.chats} 天</dd></div><div><dt>审计记录</dt><dd>{data?.retentionDays.audit} 天</dd></div></dl>
        <InlineAlert tone="info">到期清理由独立 Worker 执行。客户撤回同意后，停止后续外部处理。</InlineAlert>
      </Panel>
      <Panel className="danger-zone">
        <SectionHeader title="全局紧急停止" description="暂停 Worker、Outbox 和扩展写动作，数据和只读查看仍保留。" />
        <div className="danger-action"><span><PauseCircle size={34} weight="fill" /></span><div><strong>{data?.automationPaused ? "自动化当前已暂停" : "自动化当前可运行"}</strong><p>恢复需重新验证 PIN；RESULT_UNKNOWN 动作仍不会自动重放。</p></div><Button variant={data?.automationPaused ? "secondary" : "danger"} onClick={() => data?.automationPaused ? setResumeOpen(true) : pause.mutate({ stopped: true })} loading={pause.isPending}>{data?.automationPaused ? <ShieldCheck /> : <PauseCircle />} {data?.automationPaused ? "验证 PIN 并恢复" : "立即停止写操作"}</Button></div>
      </Panel>
    </div>
    <EmergencyResumeDialog
      open={resumeOpen}
      resultUnknownActions={data?.resultUnknownActions ?? 0}
      loading={pause.isPending}
      error={pause.error instanceof Error ? pause.error.message : undefined}
      onCancel={() => { setResumeOpen(false); pause.reset(); }}
      onConfirm={(payload) => pause.mutate({ stopped: false, payload })}
    />
  </div>;
}
