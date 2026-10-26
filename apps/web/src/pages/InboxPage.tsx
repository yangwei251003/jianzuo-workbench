import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowCounterClockwise, ChatCircleDots, Check, LinkSimple, PaperPlaneRight, Robot, User, WarningCircle } from "@phosphor-icons/react";
import type { ReplyDecision } from "@jianzuo/contracts";
import { api, formatTime, jsonBody } from "../api";
import { Button, EmptyState, ErrorState, InlineAlert, LoadingState, PageHeader, Panel, StatusPill } from "../components/ui";
import { pendingReplyApprovals, pendingReplyBody, type InboxAction } from "../inbox-approvals";

type BoundReplyDecision = ReplyDecision & { draftBinding?: { latestInboundMessageId: string; latestInboundMessageHash: string; decisionVersion: string } };
type VisibleTargetData = { target: Record<string, unknown>; context: Record<string, string>; receivedAt: string };
type ActionListData = { actions: InboxAction[] };

export function InboxPage() {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState("");
  const [suggestion, setSuggestion] = useState<BoundReplyDecision | null>(null);
  const [reply, setReply] = useState("");
  const [connector, setConnector] = useState<"MOCK" | "MANAGED_BROWSER">("MOCK");
  const [captureProductId, setCaptureProductId] = useState("");
  const [captureConfirmed, setCaptureConfirmed] = useState(false);
  const [realSendConfirmed, setRealSendConfirmed] = useState(false);
  const [feedback, setFeedback] = useState("");
  const conversations = useQuery({ queryKey: ["conversations"], queryFn: async () => (await api<Array<Record<string, unknown>>>("/api/conversations")).data!, refetchInterval: 5_000 });
  const products = useQuery({ queryKey: ["products-for-conversation-capture"], queryFn: async () => (await api<Array<Record<string, unknown>>>("/api/products")).data! });
  const calibration = useQuery({ queryKey: ["calibration"], queryFn: async () => (await api<{ stage: string }>("/api/calibration")).data!, refetchInterval: 8_000 });
  const visibleTarget = useQuery({ queryKey: ["platform-target-current"], queryFn: async () => (await api<VisibleTargetData>("/api/platform-targets/current")).data!, refetchInterval: 3_000, retry: false });
  const actions = useQuery({ queryKey: ["inbox-actions"], queryFn: async () => (await api<ActionListData>("/api/jobs")).data?.actions ?? [], refetchInterval: 5_000 });
  useEffect(() => { if (!selected && conversations.data?.[0]) setSelected(String(conversations.data[0].id)); }, [conversations.data, selected]);
  useEffect(() => { if (!captureProductId && products.data?.[0]) setCaptureProductId(String(products.data[0].id)); }, [captureProductId, products.data]);
  const messages = useQuery({ queryKey: ["messages", selected], enabled: Boolean(selected), queryFn: async () => (await api<Array<Record<string, unknown>>>(`/api/conversations/${selected}/messages`)).data!, refetchInterval: 5_000 });
  const current = conversations.data?.find((item) => item.id === selected);
  const waitingReplyApprovals = pendingReplyApprovals(actions.data, selected);
  const realReplyUnlocked = ["SINGLE_PUBLISH_VERIFIED", "MESSAGE_TEST_VERIFIED", "ORDER_TEST_VERIFIED", "PRODUCTION_ENABLED"].includes(calibration.data?.stage ?? "");
  const currentVisibleMessage = visibleTarget.data?.target?.targetType === "message" ? visibleTarget.data : undefined;
  const capture = useMutation({
    mutationFn: async () => api("/api/conversations/capture-current", { method: "POST", ...jsonBody({ productId: captureProductId, confirmation: "CAPTURE_VISIBLE_CONVERSATION" }) }),
    onSuccess: async (response) => { setFeedback(response.summary); setCaptureConfirmed(false); await conversations.refetch(); },
    onError: (error) => setFeedback(error instanceof Error ? error.message : "会话采集失败")
  });
  const decide = useMutation({
    mutationFn: async () => api<BoundReplyDecision>(`/api/conversations/${selected}/decide`, { method: "POST", ...jsonBody({}) }),
    onSuccess: async (response) => { setSuggestion(response.data ?? null); setReply(response.data?.reply ?? ""); await queryClient.invalidateQueries({ queryKey: ["conversations"] }); }
  });
  const send = useMutation({
    mutationFn: async () => api(`/api/conversations/${selected}/send`, { method: "POST", ...jsonBody({
      reply,
      connector,
      mode: suggestion ? "assistant" : "manual",
      confirmation: connector === "MANAGED_BROWSER" ? "SEND_CONTROLLED_TEST_REPLY" : undefined,
      ...suggestion?.draftBinding
    }) }),
    onSuccess: async (response) => { setFeedback(response.summary); setReply(""); setSuggestion(null); setRealSendConfirmed(false); await Promise.all([queryClient.invalidateQueries({ queryKey: ["messages", selected] }), queryClient.invalidateQueries({ queryKey: ["conversations"] }), queryClient.invalidateQueries({ queryKey: ["inbox-actions"] })]); }
  });
  const approve = useMutation({
    mutationFn: async (actionId: string) => api(`/api/actions/${actionId}/approve`, { method: "POST" }),
    onSuccess: async (response) => {
      setFeedback(response.summary);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["inbox-actions"] }),
        queryClient.invalidateQueries({ queryKey: ["messages", selected] }),
        queryClient.invalidateQueries({ queryKey: ["conversations"] })
      ]);
    },
    onError: (error) => setFeedback(error instanceof Error ? error.message : "回复审批失败")
  });
  const resume = useMutation({ mutationFn: async () => api(`/api/conversations/${selected}/resume-ai`, { method: "POST" }), onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["conversations"] }) });

  return <div className="page-stack inbox-page">
    <PageHeader eyebrow="客户消息与人工接管" title="消息与客服工作台" description="基于确定性规则生成回复建议；议价不越过底价，材料不齐先追问，遇到风险或信息不清时转人工处理。" />
    <Panel className="platform-capture-panel">
      <div className="platform-capture-copy"><LinkSimple size={25} /><div><strong>采集当前真实会话</strong><p>先在专用浏览器打开一位受控测试买家的聊天，再把这个可见会话绑定到工作台商品。只读取当前页面，不会发送消息。</p></div></div>
      {currentVisibleMessage
        ? <InlineAlert tone="info">已识别当前聊天页面{currentVisibleMessage.context.productTitle ? `：《${currentVisibleMessage.context.productTitle}》` : ""}。请人工核对后再绑定。</InlineAlert>
        : <InlineAlert tone="warning">当前没有可确认的真实聊天目标。请先点“聚焦聊天”并打开具体会话。</InlineAlert>}
      <div className="platform-capture-controls">
        <label><span>绑定到商品</span><select value={captureProductId} onChange={(event) => { setCaptureProductId(event.target.value); setCaptureConfirmed(false); }} disabled={products.isLoading}>{products.data?.map((product) => <option key={String(product.id)} value={String(product.id)}>{String(product.name)}</option>)}</select></label>
        <label className="check-control compact"><input type="checkbox" checked={captureConfirmed} onChange={(event) => setCaptureConfirmed(event.target.checked)} /><span>我确认专用浏览器当前显示的会话与所选商品一致</span></label>
        <Button size="small" variant="secondary" disabled={!currentVisibleMessage || !captureProductId || !captureConfirmed} loading={capture.isPending} onClick={() => capture.mutate()}>确认采集</Button>
      </div>
      {feedback && <InlineAlert tone={feedback.includes("失败") || feedback.includes("需要") ? "warning" : "success"}>{feedback}</InlineAlert>}
    </Panel>
    <div className="inbox-layout">
      <Panel className="conversation-list flush-panel">
        <div className="list-heading"><h2>最近会话</h2><StatusPill tone="blue">{conversations.data?.length ?? 0} 个</StatusPill></div>
        {conversations.isLoading ? <LoadingState /> : conversations.error ? <ErrorState message={conversations.error.message} /> : conversations.data?.map((item) => <button key={String(item.id)} className={selected === item.id ? "active" : ""} onClick={() => { setSelected(String(item.id)); setSuggestion(null); setReply(""); }}><span className="buyer-avatar">{String(item.buyer_alias).slice(0, 1)}</span><div><div><strong>{String(item.buyer_alias)}</strong><time>{formatTime(String(item.last_message_at))}</time></div><p>{String(item.product_name)}</p><small>{String(item.last_body)}</small></div>{Boolean(item.ai_paused) && <WarningCircle className="handoff-mark" weight="fill" />}</button>) }
      </Panel>

      <Panel className="chat-panel flush-panel">
        {!current ? <EmptyState title="选择一个会话" description="查看历史并生成有依据的回复。" /> : <>
          <div className="chat-header"><div><h2>{String(current.buyer_alias)}</h2><p>{String(current.product_name)}</p></div>{Boolean(current.ai_paused) ? <StatusPill tone="danger">AI 已暂停</StatusPill> : <StatusPill tone="success">规则回复可用</StatusPill>}</div>
          {Boolean(current.ai_paused) && <InlineAlert tone="danger" title="已转人工">{String(current.handoff_reason)}<Button size="small" variant="secondary" onClick={() => resume.mutate()}><ArrowCounterClockwise /> 人工确认后恢复</Button></InlineAlert>}
          <div className="message-stream">{messages.isLoading ? <LoadingState /> : messages.data?.map((message) => <article key={String(message.id)} className={`message ${message.direction}`}><span>{message.direction === "inbound" ? <User /> : <Robot />}</span><div><p>{String(message.body)}</p><time>{formatTime(String(message.created_at))}</time></div></article>)}</div>
          <div className="reply-composer">
            {waitingReplyApprovals.map((action) => {
              const actionId = String(action.action_id);
              return <div className="decision-evidence" key={actionId}>
                <div><strong>待批准的真实回复</strong><StatusPill tone="warning">逐次人工审批</StatusPill></div>
                <p>{pendingReplyBody(action)}</p>
                <small>请再次核对买家、商品和回复内容。批准后扩展仍会复核当前会话；目标不一致会停止发送。</small>
                <Button size="small" onClick={() => approve.mutate(actionId)} loading={approve.isPending && approve.variables === actionId} disabled={approve.isPending}><Check /> 检查后批准本次回复</Button>
              </div>;
            })}
            {suggestion && <div className="decision-evidence"><div><strong>判断：{suggestion.intent}</strong><StatusPill tone={suggestion.escalate ? "danger" : "blue"}>{Math.round(suggestion.confidence * 100)}% 置信</StatusPill></div><p>{suggestion.evidence.join("；")}</p>{suggestion.missingFields.length > 0 && <small>待补：{suggestion.missingFields.join("、")}</small>}</div>}
            <textarea rows={4} value={reply} onChange={(event) => { setReply(event.target.value); if (suggestion && event.target.value !== suggestion.reply) setSuggestion(null); }} placeholder={Boolean(current.ai_paused) ? "输入人工回复；发送后仍保持 AI 暂停" : "先生成建议，或直接输入人工回复"} />
            <div><label className="compact-connector"><span>发送到</span><select aria-label="回复发送连接器" value={connector} onChange={(event) => { setConnector(event.target.value as typeof connector); setRealSendConfirmed(false); }}><option value="MOCK">模拟闲鱼</option><option value="MANAGED_BROWSER" disabled={!realReplyUnlocked}>真实浏览器扩展{realReplyUnlocked ? "" : "（先完成单件发布校准）"}</option></select></label><span className="composer-note">建议稿会绑定生成时的最新买家消息；人工回复不会恢复 AI</span><Button variant="secondary" onClick={() => decide.mutate()} loading={decide.isPending} disabled={Boolean(current.ai_paused)}><Robot /> 生成回复建议</Button><Button onClick={() => send.mutate()} loading={send.isPending} disabled={!reply.trim() || (connector === "MANAGED_BROWSER" && !realSendConfirmed)}><PaperPlaneRight /> {connector === "MANAGED_BROWSER" ? "准备受控测试回复" : Boolean(current.ai_paused) ? "发送人工回复" : "发送"}</Button></div>
            {connector === "MANAGED_BROWSER" && <label className="check-control compact controlled-write-confirm"><input type="checkbox" checked={realSendConfirmed} onChange={(event) => setRealSendConfirmed(event.target.checked)} /><span><strong>我确认当前专用浏览器仍停留在已绑定测试会话</strong><small>点击后只创建待审批动作；真正发送前还会再次核对目标并要求你批准。</small></span></label>}
            {(decide.error || send.error || actions.error) && <InlineAlert tone="danger">{(decide.error ?? send.error ?? actions.error)?.message}</InlineAlert>}
          </div>
        </>}
      </Panel>
      <Panel className="service-rules"><ChatCircleDots size={24} /><h2>回复边界</h2><dl><div><dt>最多优惠</dt><dd>10%</dd></div><div><dt>人工时间</dt><dd>09:00–22:00</dd></div><div><dt>范围变化</dt><dd>重新报价</dd></div></dl><h3>立即停机</h3><ul><li>退款</li><li>投诉或法律威胁</li><li>账号验证</li><li>违规需求</li><li>范围或价格不清</li><li>外部结果未知</li></ul></Panel>
    </div>
  </div>;
}
