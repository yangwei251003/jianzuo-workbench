import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarBlank, Check, Clock, PaperPlaneTilt, ShieldWarning, WarningCircle } from "@phosphor-icons/react";
import type { Product } from "@jianzuo/contracts";
import { api, formatTime, jsonBody } from "../api";
import { Button, EmptyState, ErrorState, Field, InlineAlert, LoadingState, PageHeader, Panel, SectionHeader, StatusPill } from "../components/ui";
import { publishActionLabel, publishApprovalLabel, statusLabel } from "../safety";

type PublishData = { publications: Array<Record<string, unknown>>; actions: Array<Record<string, unknown>> };

export function PublishPage() {
  const queryClient = useQueryClient();
  const [productId, setProductId] = useState("");
  const [connector, setConnector] = useState<"MOCK" | "MANAGED_BROWSER">("MOCK");
  const [licenseReview, setLicenseReview] = useState("");
  const [simulateUnknown, setSimulateUnknown] = useState(false);
  const [runMockNow, setRunMockNow] = useState(false);
  const [feedback, setFeedback] = useState("");
  const products = useQuery({ queryKey: ["products"], queryFn: async () => (await api<Product[]>("/api/products")).data! });
  const publish = useQuery({ queryKey: ["publications"], queryFn: async () => (await api<PublishData>("/api/publications")).data!, refetchInterval: 5_000 });
  const readyProducts = useMemo(() => (products.data ?? []).filter((item) => !["PLANNED", "PUBLISHED"].includes(item.readiness)), [products.data]);
  const selectedProduct = useMemo(() => readyProducts.find((item) => item.id === (productId || readyProducts[0]?.id)), [productId, readyProducts]);
  const needsLicenseReview = selectedProduct?.category === "工具" || selectedProduct?.category === "前端";
  const create = useMutation({
    mutationFn: async () => api("/api/publications", { method: "POST", ...jsonBody({
      productId: productId || readyProducts[0]?.id,
      connector,
      simulateUnknown,
      scheduledAt: connector === "MOCK" && runMockNow ? new Date().toISOString() : undefined,
      license: needsLicenseReview ? licenseReview : undefined
    }) }),
    onSuccess: async (response) => { setFeedback(response.summary); await queryClient.invalidateQueries({ queryKey: ["publications"] }); },
    onError: (error) => setFeedback(error instanceof Error ? error.message : "创建失败")
  });
  const approve = useMutation({
    mutationFn: async (id: string) => api(`/api/actions/${id}/approve`, { method: "POST" }),
    onSuccess: async () => { setFeedback("动作已批准，等待排期和 Worker 执行"); await queryClient.invalidateQueries({ queryKey: ["publications"] }); },
    onError: (error) => setFeedback(error instanceof Error ? error.message : "审批失败")
  });
  const submit = useMutation({
    mutationFn: async (id: string) => api(`/api/publications/${id}/submit`, { method: "POST", ...jsonBody({ confirmation: "SUBMIT_REAL_LISTING" }) }),
    onSuccess: async (response) => { setFeedback(response.summary); await queryClient.invalidateQueries({ queryKey: ["publications"] }); },
    onError: (error) => setFeedback(error instanceof Error ? error.message : "创建真实发布审批失败")
  });
  const prepareRealSubmit = (id: string) => {
    if (!window.confirm("请先在专用浏览器中检查图片、描述和价格。确定只创建最终发布审批吗？此步仍不会立即点击发布。")) return;
    submit.mutate(id);
  };

  return <div className="page-stack">
    <PageHeader eyebrow="发布排期与人工审批" title="发布中心" description="内容先预检，再按 14 天排期进入 Outbox。训练期的发布动作必须由你批准。" />
    <div className="publish-layout">
      <Panel className="publish-create-panel">
        <SectionHeader title="准备一条发布" description="真实账号校准前，默认发送到模拟闲鱼。" />
        <div className="form-stack">
          <Field label="选择内容就绪商品"><select value={productId} onChange={(event) => { setProductId(event.target.value); setLicenseReview(""); }}><option value="">选择商品</option>{readyProducts.map((item) => <option key={item.id} value={item.id}>第 {item.releaseDay} 天 · {item.name}</option>)}</select></Field>
          {needsLicenseReview && <Field label="许可证与原创确认" hint="工具和前端商品在模拟或真实发布前都必须核验。AGPL、非商业、GPL 待评审、未知或缺失许可证会被阻止。"><select value={licenseReview} onChange={(event) => setLicenseReview(event.target.value)}><option value="">选择已经核对的结果</option><option value="ORIGINAL-DEPENDENCIES-REVIEWED">原创自有，第三方依赖与素材声明已核对</option><option value="MIT">MIT，已保留许可证与原作者声明</option><option value="Apache-2.0">Apache-2.0，已保留许可证与 NOTICE</option><option value="BSD-3-Clause">BSD，已保留许可证与原作者声明</option></select></Field>}
          <Field label="连接器"><div className="connector-options"><button className={connector === "MOCK" ? "selected" : ""} onClick={() => setConnector("MOCK")}><strong>模拟闲鱼</strong><span>阶段 A 默认，可重复训练</span></button><button className={connector === "MANAGED_BROWSER" ? "selected" : ""} onClick={() => setConnector("MANAGED_BROWSER")}><strong>浏览器扩展</strong><span>扫码校准后使用</span></button></div></Field>
          {connector === "MOCK" && <>
            <label className="check-control"><input type="checkbox" checked={runMockNow} onChange={(event) => setRunMockNow(event.target.checked)} /><span><strong>批准后立即执行本次模拟</strong><small>仅跳过模拟排期，真实发布仍按 14 天计划执行。</small></span></label>
            <label className="check-control"><input type="checkbox" checked={simulateUnknown} onChange={(event) => setSimulateUnknown(event.target.checked)} /><span><strong>模拟“结果未知”异常</strong><small>用于验证提交后断线时不会自动重发。</small></span></label>
          </>}
          {connector === "MANAGED_BROWSER" && <InlineAlert tone="warning" title="第一步只填草稿">批准后只会填写图片、描述和价格，绝不会点击发布。你检查真实页面后，系统才允许创建第二个“确认提交”审批。</InlineAlert>}
          {feedback && <InlineAlert tone={feedback.includes("失败") || feedback.includes("请先") ? "danger" : "success"}>{feedback}</InlineAlert>}
          <Button size="large" disabled={(!productId && !readyProducts[0]) || (needsLicenseReview && !licenseReview)} loading={create.isPending} onClick={() => create.mutate()}><PaperPlaneTilt size={19} /> {connector === "MANAGED_BROWSER" ? "准备只填草稿" : "预检并进入审批"}</Button>
        </div>
      </Panel>

      <Panel className="publish-list-panel flush-panel">
        <SectionHeader title="发布排期与动作" description="批准后到达排期时间才执行；未知结果保持封存。" />
        {publish.isLoading ? <LoadingState /> : publish.error ? <ErrorState message={publish.error.message} retry={() => void publish.refetch()} /> : !publish.data?.publications.length ? <EmptyState title="还没有发布计划" description="先在左侧选择一个内容就绪商品。" /> : <div className="table-scroll"><table className="data-table"><thead><tr><th>商品</th><th>连接器</th><th>计划时间</th><th>发布状态</th><th>动作状态</th><th><span className="sr-only">操作</span></th></tr></thead><tbody>{publish.data.publications.map((publication) => {
          const action = publish.data!.actions.find((item) => item.target_id === publication.id);
          const actionStatus = String(action?.status ?? "—");
          const actionType = String(action?.action_type ?? "");
          const publicationConnector = String(publication.connector);
          const actionConnector = String(action?.connector ?? publicationConnector);
          const connectorMismatch = Boolean(action) && actionConnector !== publicationConnector;
          const canPrepareSubmit = !connectorMismatch && publicationConnector === "MANAGED_BROWSER" && String(publication.status) === "REVIEW_READY" && actionType === "FILL_LISTING" && actionStatus === "SUCCEEDED";
          return <tr key={String(publication.id)} className={actionStatus === "RESULT_UNKNOWN" || connectorMismatch ? "danger-row" : ""}><td><strong>{String(publication.product_name)}</strong><small className="table-subline">{String(publication.product_slug)}</small></td><td>{publicationConnector === "MOCK" ? "模拟闲鱼" : "浏览器扩展"}</td><td><CalendarBlank /> {formatTime(String(publication.scheduled_at ?? publication.created_at))}</td><td><StatusPill tone={statusTone(String(publication.status))}>{statusLabel(String(publication.status))}</StatusPill></td><td><StatusPill tone={connectorMismatch ? "danger" : statusTone(actionStatus)}>{connectorMismatch ? "连接器不一致" : publishActionLabel(actionType, actionStatus, actionConnector)}</StatusPill></td><td>{connectorMismatch ? <span className="danger-text"><WarningCircle /> 停止审批</span> : actionStatus === "WAITING_APPROVAL" ? <Button size="small" onClick={() => approve.mutate(String(action?.action_id))} loading={approve.isPending}><Check /> {publishApprovalLabel(actionType, actionConnector)}</Button> : canPrepareSubmit ? <Button size="small" variant="secondary" onClick={() => prepareRealSubmit(String(publication.id))} loading={submit.isPending}><ShieldWarning /> 检查后准备发布</Button> : actionStatus === "RESULT_UNKNOWN" ? <span className="danger-text"><WarningCircle /> 禁止重放</span> : <span className="muted-text">—</span>}</td></tr>;
        })}</tbody></table></div>}
      </Panel>
    </div>
    <Panel className="policy-strip"><ShieldWarning size={24} /><div><strong>真实发布校准顺序</strong><p>扫码登录 → 只读识别 → 草稿填充 → 单件发布 → 受控测试咨询和订单。不会拿第一位真实买家做试验。</p></div><Clock size={22} /></Panel>
  </div>;
}

function statusTone(status: string): "neutral" | "success" | "warning" | "danger" | "blue" {
  if (["PUBLISHED", "SUCCEEDED"].includes(status)) return "success";
  if (["RESULT_UNKNOWN", "FAILED"].includes(status)) return "danger";
  if (["WAITING_APPROVAL", "APPROVED", "QUEUED", "EXECUTING"].includes(status)) return "warning";
  if (status === "REVIEW_READY") return "blue";
  return "neutral";
}
