import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CloudArrowUp, FileArchive, FolderOpen, Handshake, LinkSimple, Package, PaperPlaneTilt, ShieldCheck, Wrench } from "@phosphor-icons/react";
import { api, formatMoney, formatTime, jsonBody } from "../api";
import { Button, EmptyState, ErrorState, Field, InlineAlert, LoadingState, PageHeader, Panel, SectionHeader, StatusPill } from "../components/ui";

type OrdersData = { orders: Array<Record<string, unknown>>; deliveries: Array<Record<string, unknown>>; remoteRecords: Array<Record<string, unknown>>; actions: Array<Record<string, unknown>> };
type VisibleTargetData = { target: Record<string, unknown>; context: Record<string, string>; receivedAt: string };
type BaiduStatus = { configured: boolean; authorized: boolean; redirectUri: string; tokenExpiresAt?: string };

export function OrdersPage() {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState("");
  const [noticeAccepted, setNoticeAccepted] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [shareUrl, setShareUrl] = useState("");
  const [licenseReview, setLicenseReview] = useState("");
  const [deliveryConnector, setDeliveryConnector] = useState<"MOCK" | "MANAGED_BROWSER">("MOCK");
  const [captureConversationId, setCaptureConversationId] = useState("");
  const [captureTier, setCaptureTier] = useState<"基础" | "标准" | "进阶">("基础");
  const [captureOrderType, setCaptureOrderType] = useState<"fixed_digital" | "semi_custom" | "remote_service">("fixed_digital");
  const [captureConfirmed, setCaptureConfirmed] = useState(false);
  const [realDeliveryConfirmed, setRealDeliveryConfirmed] = useState(false);
  const [baiduUploadConfirmed, setBaiduUploadConfirmed] = useState(false);
  const [remoteRecord, setRemoteRecord] = useState({ consentSummary: "已与买家确认本次仅处理已描述的软件故障", startedAt: "", endedAt: "", actionSummary: "", resultSummary: "" });
  const query = useQuery({ queryKey: ["orders"], queryFn: async () => (await api<OrdersData>("/api/orders")).data!, refetchInterval: 5_000 });
  const calibration = useQuery({ queryKey: ["calibration"], queryFn: async () => (await api<{ stage: string }>("/api/calibration")).data!, refetchInterval: 8_000 });
  const conversations = useQuery({ queryKey: ["conversations-for-order-capture"], queryFn: async () => (await api<Array<Record<string, unknown>>>("/api/conversations")).data!, refetchInterval: 5_000 });
  const visibleTarget = useQuery({ queryKey: ["platform-target-current"], queryFn: async () => (await api<VisibleTargetData>("/api/platform-targets/current")).data!, refetchInterval: 3_000, retry: false });
  const baiduStatus = useQuery({ queryKey: ["baidu-status"], queryFn: async () => (await api<BaiduStatus>("/api/baidu/status")).data!, refetchInterval: 30_000 });
  useEffect(() => { if (!selected && query.data?.orders[0]) setSelected(String(query.data.orders[0].id)); }, [query.data, selected]);
  const realConversations = conversations.data?.filter((item) => item.data_source === "real") ?? [];
  useEffect(() => { if (!captureConversationId && realConversations[0]) setCaptureConversationId(String(realConversations[0].id)); }, [captureConversationId, realConversations]);
  const order = query.data?.orders.find((item) => item.id === selected);
  const delivery = query.data?.deliveries.find((item) => item.order_id === selected);
  const deliveryAction = query.data?.actions.find((item) => item.target_id === delivery?.id && item.action_type === "SEND_DELIVERY");
  const latestRemoteRecord = query.data?.remoteRecords.find((item) => item.order_id === selected);
  const needsLicenseReview = !String(order?.id ?? "").startsWith("DEMO-") && ["工具", "前端"].includes(String(order?.product_category ?? ""));
  const realDeliveryUnlocked = ["SINGLE_PUBLISH_VERIFIED", "MESSAGE_TEST_VERIFIED", "ORDER_TEST_VERIFIED", "PRODUCTION_ENABLED"].includes(calibration.data?.stage ?? "");
  const currentVisibleOrder = visibleTarget.data?.target?.targetType === "order" ? visibleTarget.data : undefined;
  const captureOrder = useMutation({ mutationFn: async () => api("/api/orders/capture-current", { method: "POST", ...jsonBody({ conversationId: captureConversationId, tier: captureTier, orderType: captureOrderType, confirmation: "CAPTURE_VISIBLE_ORDER" }) }), onSuccess: async (response) => { setFeedback(response.summary); setCaptureConfirmed(false); await query.refetch(); }, onError: showError(setFeedback) });
  const consent = useMutation({ mutationFn: async (status: "granted" | "withdrawn") => api(`/api/orders/${selected}/consent`, { method: "POST", ...jsonBody({ status }) }), onSuccess: async (response) => { setFeedback(response.summary); await queryClient.invalidateQueries({ queryKey: ["orders"] }); } });
  const pack = useMutation({ mutationFn: async () => api<{ zipPath: string }>(`/api/orders/${selected}/package`, { method: "POST", ...jsonBody({ license: needsLicenseReview ? licenseReview : undefined }) }), onSuccess: async (response) => { setFeedback(response.summary); await queryClient.invalidateQueries({ queryKey: ["orders"] }); }, onError: showError(setFeedback) });
  const advance = useMutation({ mutationFn: async (status: string) => api(`/api/orders/${selected}/status`, { method: "PATCH", ...jsonBody({ status }) }), onSuccess: async () => queryClient.invalidateQueries({ queryKey: ["orders"] }) });
  const saveLink = useMutation({ mutationFn: async () => api(`/api/orders/${selected}/share-link`, { method: "POST", ...jsonBody({ url: shareUrl }) }), onSuccess: async (response) => { setFeedback(response.summary); setShareUrl(""); await queryClient.invalidateQueries({ queryKey: ["orders"] }); }, onError: showError(setFeedback) });
  const uploadBaidu = useMutation({ mutationFn: async () => api(`/api/orders/${selected}/baidu-upload`, { method: "POST", ...jsonBody({ confirmation: "UPLOAD_TO_BAIDU" }) }), onSuccess: async (response) => { setFeedback(response.summary); setBaiduUploadConfirmed(false); await queryClient.invalidateQueries({ queryKey: ["orders"] }); }, onError: showError(setFeedback) });
  const deliver = useMutation({ mutationFn: async () => api(`/api/orders/${selected}/deliver`, { method: "POST", ...jsonBody({ connector: deliveryConnector, confirmation: deliveryConnector === "MANAGED_BROWSER" ? "SEND_CONTROLLED_TEST_DELIVERY" : undefined }) }), onSuccess: async (response) => { setFeedback(response.summary); setRealDeliveryConfirmed(false); await queryClient.invalidateQueries({ queryKey: ["orders"] }); }, onError: showError(setFeedback) });
  const approve = useMutation({ mutationFn: async () => api(`/api/actions/${String(deliveryAction?.action_id)}/approve`, { method: "POST" }), onSuccess: async (response) => { setFeedback(response.summary); await queryClient.invalidateQueries({ queryKey: ["orders"] }); }, onError: showError(setFeedback) });
  const saveRemote = useMutation({ mutationFn: async () => api(`/api/orders/${selected}/remote-record`, { method: "POST", ...jsonBody(remoteRecord) }), onSuccess: async (response) => { setFeedback(response.summary); setRemoteRecord((value) => ({ ...value, actionSummary: "", resultSummary: "" })); await queryClient.invalidateQueries({ queryKey: ["orders"] }); }, onError: showError(setFeedback) });

  return <div className="page-stack">
    <PageHeader eyebrow="订单制作与数字交付" title="订单、制作与交付" description="固定数字商品可自动打包；半定制当前由人工制作；远程服务由人工执行并只记录摘要。" />
    <Panel className="platform-capture-panel">
      <div className="platform-capture-copy"><LinkSimple size={25} /><div><strong>采集当前真实订单</strong><p>只用于你准备好的受控测试买家。先在专用浏览器打开具体订单，再把可见订单与已绑定会话、套餐和服务类型对应起来。</p></div></div>
      {currentVisibleOrder ? <InlineAlert tone="info">已识别当前订单页面，金额为 ¥{String(currentVisibleOrder.target.amount)}。工作台会再次核对买家、商品和金额。</InlineAlert> : <InlineAlert tone="warning">当前没有可确认的订单目标，或尚未完成单件发布校准。</InlineAlert>}
      <div className="platform-capture-controls order-capture-controls">
        <label><span>关联真实会话</span><select value={captureConversationId} onChange={(event) => { setCaptureConversationId(event.target.value); setCaptureConfirmed(false); }}><option value="">选择已采集会话</option>{realConversations.map((conversation) => <option key={String(conversation.id)} value={String(conversation.id)}>{String(conversation.buyer_alias)} · {String(conversation.product_name)}</option>)}</select></label>
        <label><span>套餐</span><select value={captureTier} onChange={(event) => setCaptureTier(event.target.value as typeof captureTier)}><option>基础</option><option>标准</option><option>进阶</option></select></label>
        <label><span>服务类型</span><select value={captureOrderType} onChange={(event) => setCaptureOrderType(event.target.value as typeof captureOrderType)}><option value="fixed_digital">固定数字商品</option><option value="semi_custom">半定制商品</option><option value="remote_service">人工远程服务</option></select></label>
        <label className="check-control compact"><input type="checkbox" checked={captureConfirmed} onChange={(event) => setCaptureConfirmed(event.target.checked)} /><span>我确认当前可见订单属于所选测试会话与套餐</span></label>
        <Button size="small" variant="secondary" disabled={!currentVisibleOrder || !captureConversationId || !captureConfirmed} loading={captureOrder.isPending} onClick={() => captureOrder.mutate()}>确认采集</Button>
      </div>
    </Panel>
    <div className="orders-layout">
      <Panel className="orders-table-panel flush-panel">
        <SectionHeader title="订单队列" description="演示数据不会被当作真实平台收入。" />
        {query.isLoading ? <LoadingState /> : query.error ? <ErrorState message={query.error.message} /> : !query.data?.orders.length ? <EmptyState title="还没有订单" description="模拟买家付款后会进入这里。" /> : <div className="table-scroll"><table className="data-table"><thead><tr><th>订单</th><th>商品 / 买家</th><th>套餐</th><th>价格</th><th>状态</th><th>更新时间</th></tr></thead><tbody>{query.data.orders.map((item) => <tr key={String(item.id)} className={selected === item.id ? "selected-row" : ""} onClick={() => { setSelected(String(item.id)); setFeedback(""); setLicenseReview(""); }}><td><strong>{String(item.id)}</strong></td><td><strong>{String(item.product_name)}</strong><small className="table-subline">{String(item.buyer_alias)}</small></td><td>{String(item.tier)}</td><td className="price-text">{formatMoney(Number(item.quoted_price))}</td><td><StatusPill tone={orderTone(String(item.status))}>{orderLabel(String(item.status))}</StatusPill></td><td>{formatTime(String(item.updated_at))}</td></tr>)}</tbody></table></div>}
      </Panel>

      <Panel className="order-detail-panel">
        {!order ? <EmptyState title="选择一个订单" description="查看材料、同意、制作和交付状态。" /> : <>
          <div className="order-detail-head"><div><p className="eyebrow">{String(order.id)}</p><h2>{String(order.product_name)}</h2><p>{String(order.buyer_alias)} · {String(order.tier)}档 · {formatMoney(Number(order.quoted_price))}</p></div><StatusPill tone={orderTone(String(order.status))}>{orderLabel(String(order.status))}</StatusPill></div>
          {feedback && <InlineAlert tone={feedback.includes("失败") || feedback.includes("需要") ? "warning" : "success"}>{feedback}</InlineAlert>}
          <SectionHeader title="材料完整度" />
          <div className="intake-box"><FolderOpen size={25} /><div><strong>{String(order.status) === "NEEDS_INTAKE" ? "等待买家补齐材料" : "材料已进入制作流程"}</strong><p>{intakeText(order.intake_json)}</p></div></div>
          <SectionHeader title="客户数据处理同意" />
          <div className="consent-box"><ShieldCheck size={26} /><div><strong>发送可识别文件给 Codex 前必须单独同意</strong><p>文件可能由 OpenAI 服务处理。买家应知道处理目的、文件范围、保留时间以及可能发生的数据跨境，并可随时撤回。</p><label className="check-control compact"><input type="checkbox" checked={noticeAccepted} onChange={(event) => setNoticeAccepted(event.target.checked)} /><span>我已向买家展示告知，并取得单独明确同意</span></label><div><Button size="small" disabled={!noticeAccepted} loading={consent.isPending} onClick={() => consent.mutate("granted")}><Handshake /> 记录同意</Button><Button size="small" variant="ghost" onClick={() => consent.mutate("withdrawn")}>记录撤回</Button></div></div></div>
          <SectionHeader title={Boolean(order.remote_service) ? "远程服务" : "制作与交付"} />
          {Boolean(order.remote_service) ? <div className="remote-service-box"><Wrench size={28} /><div className="remote-record-form"><strong>人工执行，不自动远控</strong><p>只保存授权范围、时间、动作摘要和结果。不录屏，不保存密码、验证码或远控码。</p>{latestRemoteRecord && <InlineAlert tone="success">最近记录：{String(latestRemoteRecord.result_summary)}</InlineAlert>}<Field label="本次授权范围"><input value={remoteRecord.consentSummary} onChange={(event) => setRemoteRecord({ ...remoteRecord, consentSummary: event.target.value })} /></Field><div className="two-fields"><Field label="开始时间"><input type="datetime-local" value={remoteRecord.startedAt} onChange={(event) => setRemoteRecord({ ...remoteRecord, startedAt: event.target.value })} /></Field><Field label="结束时间"><input type="datetime-local" value={remoteRecord.endedAt} onChange={(event) => setRemoteRecord({ ...remoteRecord, endedAt: event.target.value })} /></Field></div><Field label="动作摘要"><textarea rows={3} value={remoteRecord.actionSummary} onChange={(event) => setRemoteRecord({ ...remoteRecord, actionSummary: event.target.value })} placeholder="例如：检查日志，重装官方版本，验证启动" /></Field><Field label="处理结果"><textarea rows={3} value={remoteRecord.resultSummary} onChange={(event) => setRemoteRecord({ ...remoteRecord, resultSummary: event.target.value })} placeholder="说明是否解决及后续建议" /></Field><Button size="small" variant="secondary" onClick={() => saveRemote.mutate()} loading={saveRemote.isPending}><Wrench /> 保存人工结果</Button></div></div> : <div className="package-box"><FileArchive size={28} /><div><strong>{delivery ? `交付状态：${String(delivery.status)}` : "尚未生成交付包"}</strong><p>{delivery?.package_path ? String(delivery.package_path) : delivery?.share_url ? String(delivery.share_url) : "将生成固定目录、README、FAQ、许可证声明、版本记录和 SHA256SUMS。"}</p>{needsLicenseReview && <Field label="许可证与原创确认" hint="真实工具或前端交付包缺少核验结果时不会打包。"><select value={licenseReview} onChange={(event) => setLicenseReview(event.target.value)}><option value="">选择已经核对的结果</option><option value="ORIGINAL-DEPENDENCIES-REVIEWED">原创自有，第三方依赖与素材声明已核对</option><option value="MIT">MIT，已保留许可证与原作者声明</option><option value="Apache-2.0">Apache-2.0，已保留许可证与 NOTICE</option><option value="BSD-3-Clause">BSD，已保留许可证与原作者声明</option></select></Field>}<label className="compact-connector"><span>交付到</span><select aria-label="交付发送连接器" value={deliveryConnector} onChange={(event) => { setDeliveryConnector(event.target.value as typeof deliveryConnector); setRealDeliveryConfirmed(false); }}><option value="MOCK">模拟闲鱼</option><option value="MANAGED_BROWSER" disabled={!realDeliveryUnlocked}>真实浏览器扩展{realDeliveryUnlocked ? "" : "（先完成单件发布校准）"}</option></select></label>{!realDeliveryUnlocked && <InlineAlert tone="info">真实交付保持锁定。必须先完成单件测试发布，之后才可用受控测试订单校准附件与目标绑定；不能用第一位真实买家试验。</InlineAlert>}{deliveryConnector === "MANAGED_BROWSER" && <label className="check-control compact controlled-write-confirm"><input type="checkbox" checked={realDeliveryConfirmed} onChange={(event) => setRealDeliveryConfirmed(event.target.checked)} /><span><strong>我确认当前页面是已绑定的受控测试订单</strong><small>准备动作不会立刻发送；批准时和发送回执都会重新核对订单与金额。</small></span></label>}<div className="button-row"><Button size="small" disabled={needsLicenseReview && !licenseReview} onClick={() => pack.mutate()} loading={pack.isPending}><Package /> 生成并校验 ZIP</Button>{delivery && !deliveryAction && <Button size="small" variant="secondary" disabled={deliveryConnector === "MANAGED_BROWSER" && !realDeliveryConfirmed} onClick={() => deliver.mutate()} loading={deliver.isPending}><PaperPlaneTilt /> {deliveryConnector === "MANAGED_BROWSER" ? "准备受控测试交付" : "准备发送"}</Button>}{String(deliveryAction?.status) === "WAITING_APPROVAL" && <Button size="small" onClick={() => approve.mutate()} loading={approve.isPending}><Check /> 批准并发送</Button>}{deliveryAction && <StatusPill tone={actionTone(String(deliveryAction.status))}>{actionLabel(String(deliveryAction.status))}</StatusPill>}</div><div className="delivery-link-row"><input type="url" value={shareUrl} onChange={(event) => setShareUrl(event.target.value)} placeholder="大文件时粘贴 HTTPS 分享链接" /><Button size="small" variant="ghost" disabled={!shareUrl.trim()} onClick={() => saveLink.mutate()} loading={saveLink.isPending}><LinkSimple /> 保存链接</Button></div></div></div>}
          {!Boolean(order.remote_service) && delivery?.package_path && <div className="baidu-upload-control">
            <div><CloudArrowUp size={21} /><span><strong>大文件上传百度网盘</strong><small>{baiduStatus.data?.authorized ? "上传后仍需你在百度网盘创建分享链接并粘贴回来。" : "需要先在设置页保存百度应用并完成授权。"}</small></span></div>
            <label className="check-control compact"><input type="checkbox" checked={baiduUploadConfirmed} onChange={(event) => setBaiduUploadConfirmed(event.target.checked)} /><span>我确认把当前交付 ZIP 上传到已授权的百度网盘</span></label>
            <Button size="small" variant="secondary" disabled={!baiduStatus.data?.authorized || !baiduUploadConfirmed} loading={uploadBaidu.isPending} onClick={() => uploadBaidu.mutate()}><CloudArrowUp /> 上传后等待链接</Button>
          </div>}
          <SectionHeader title="订单推进" />
          <div className="state-actions">{nextStates(String(order.status)).map((item) => <Button key={item.value} size="small" variant={item.value === "REFUND_REVIEW" ? "danger" : "secondary"} onClick={() => advance.mutate(item.value)} loading={advance.isPending}><Check /> {item.label}</Button>)}</div>
        </>}
      </Panel>
    </div>
  </div>;
}

function intakeText(raw: unknown): string {
  try { const value = typeof raw === "string" ? JSON.parse(raw) : raw as { missing?: string[] }; return value?.missing?.length ? `还缺：${value.missing.join("、")}` : "材料记录已建立。"; } catch { return "材料记录待检查。"; }
}
function orderTone(status: string): "neutral" | "success" | "warning" | "danger" | "blue" { return status === "DELIVERED" ? "success" : status === "REFUND_REVIEW" ? "danger" : ["IN_PROGRESS", "DELIVERING", "READY_TO_DELIVER"].includes(status) ? "blue" : "warning"; }
function orderLabel(status: string): string { return ({ NEW: "新订单", NEEDS_INTAKE: "待补材料", READY: "可开工", IN_PROGRESS: "制作中", AWAITING_REVIEW: "待审阅", READY_TO_DELIVER: "可交付", DELIVERING: "交付中", DELIVERED: "已交付", REFUND_REVIEW: "退款审核" } as Record<string, string>)[status] ?? status; }
function nextStates(status: string): Array<{ value: string; label: string }> {
  const map: Record<string, Array<{ value: string; label: string }>> = {
    NEW: [{ value: "NEEDS_INTAKE", label: "开始收集材料" }, { value: "REFUND_REVIEW", label: "转退款人工审核" }],
    NEEDS_INTAKE: [{ value: "READY", label: "材料已齐" }, { value: "REFUND_REVIEW", label: "转退款人工审核" }],
    READY: [{ value: "IN_PROGRESS", label: "开始制作" }], IN_PROGRESS: [{ value: "AWAITING_REVIEW", label: "提交审阅" }],
    AWAITING_REVIEW: [{ value: "IN_PROGRESS", label: "继续修改" }, { value: "READY_TO_DELIVER", label: "确认可交付" }],
    READY_TO_DELIVER: [], DELIVERING: []
  };
  const states = map[status] ?? [];
  return status !== "REFUND_REVIEW" ? [...states, { value: "REFUND_REVIEW", label: "转退款人工审核" }].filter((item, index, all) => all.findIndex((candidate) => candidate.value === item.value) === index) : states;
}

function showError(setFeedback: (value: string) => void) {
  return (error: Error) => setFeedback(error instanceof Error ? error.message : "操作失败");
}
function actionTone(status: string): "neutral" | "success" | "warning" | "danger" | "blue" { return status === "SUCCEEDED" ? "success" : ["FAILED", "RESULT_UNKNOWN"].includes(status) ? "danger" : status === "EXECUTING" ? "blue" : "warning"; }
function actionLabel(status: string): string { return ({ WAITING_APPROVAL: "待审批", QUEUED: "排队中", EXECUTING: "发送中", SUCCEEDED: "已发送", FAILED: "发送失败", RESULT_UNKNOWN: "结果未知，禁止重发" } as Record<string, string>)[status] ?? status; }
