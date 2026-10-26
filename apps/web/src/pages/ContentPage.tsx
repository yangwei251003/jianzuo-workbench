import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CheckCircle, ClockCountdown, MagicWand, Package, Robot, Sparkle, WarningCircle } from "@phosphor-icons/react";
import { useNavigate, useParams } from "react-router-dom";
import type { ContentBundle, Product } from "@jianzuo/contracts";
import { api, formatMoney, formatTime, jsonBody } from "../api";
import { Button, EmptyState, ErrorState, Field, InlineAlert, LoadingState, PageHeader, Panel, ProgressBar, SectionHeader, StatusPill } from "../components/ui";

type ProductDetail = { product: Product; content: { id: string; version: number; status: string; bundle: ContentBundle; issues: string[] } | null };
type BatchPreparationItem = {
  productId: string;
  productName: string;
  outcome: "generated" | "already_ready" | "failed";
  ready: boolean;
  summary: string;
  version?: number;
  issues: string[];
  artifactCount: number;
};
type BatchPreparation = {
  total: number;
  readyBefore: number;
  pendingBefore: number;
  readyAfter: number;
  pendingAfter: number;
  generated: number;
  failed: number;
  items: BatchPreparationItem[];
};
type ImageGenTaskStatus = "RUNNING" | "VERIFYING" | "WAITING_USER" | "SUCCEEDED" | "FAILED";
type ImageGenTask = {
  id: string;
  product_id: string;
  content_version: number;
  status: ImageGenTaskStatus;
  result_json?: string | null;
  created_at: string;
  updated_at: string;
};
type ImageGenOutcome = "completed" | "quota_exhausted" | "not_generated";
type ImageGenResult = { summary?: string; data?: { reason?: string; fallbackPath?: string; suggestion?: string } };
type CodexCopyTaskStatus = "RUNNING" | "READY_TO_VERIFY" | "VERIFIED" | "REJECTED" | "WAITING_USER" | "SUCCEEDED" | "FAILED";
type CodexCopyCandidate = Pick<ContentBundle, "titleCandidates" | "selectedTitle" | "description" | "faq">;
type CodexCopyTask = {
  taskId: string;
  productId: string;
  sourceVersion: number;
  status: CodexCopyTaskStatus;
  createdAt: string;
  updatedAt: string;
  appliedVersion?: number;
  lastError?: string;
};
type CodexCopyTaskData = { task: CodexCopyTask | null; preview?: CodexCopyCandidate; verificationIssues?: string[] };

function parseImageGenResult(task: ImageGenTask | null | undefined): ImageGenResult | null {
  if (!task?.result_json) return null;
  try { return JSON.parse(task.result_json) as ImageGenResult; }
  catch { return null; }
}

function imageGenStatus(task: ImageGenTask | null | undefined): { label: string; tone: "neutral" | "success" | "warning" | "danger" | "blue"; summary: string } {
  if (!task) return { label: "尚未发起", tone: "neutral", summary: "当前展示的是可直接使用的本地案例图模板。" };
  if (task.status === "RUNNING") return { label: "Codex 处理中", tone: "blue", summary: "任务已交给 Codex，现有模板尚未发生变化。" };
  if (task.status === "VERIFYING") return { label: "正在验真", tone: "blue", summary: "正在检查图片格式、尺寸、路径和文件变化。" };
  if (task.status === "SUCCEEDED") return { label: "已验真替换", tone: "success", summary: "新案例图已通过检查，并安全替换当前模板。" };
  if (task.status === "FAILED") return { label: "替换失败", tone: "danger", summary: "安全替换没有完成，原模板仍被保留。" };
  return { label: "需要处理", tone: "warning", summary: "没有可接收的 ImageGen 成品，当前继续使用本地模板。" };
}

function codexCopyStatus(task: CodexCopyTask | null | undefined): { label: string; tone: "neutral" | "success" | "warning" | "danger" | "blue"; summary: string } {
  if (!task) return { label: "规则版", tone: "neutral", summary: "当前使用本地规则文案；没有 Codex 或额度时仍可正常使用。" };
  if (task.status === "RUNNING") return { label: "任务已提交", tone: "blue", summary: "Codex 正在处理。提交不代表候选已经生成。" };
  if (task.status === "READY_TO_VERIFY") return { label: "待检查", tone: "warning", summary: "检测到候选文件，尚未验真，也没有修改正式内容。" };
  if (task.status === "VERIFIED") return { label: "已验真待决定", tone: "blue", summary: "候选通过规则检查。请比较差异后决定接受或保留规则版。" };
  if (task.status === "SUCCEEDED") return { label: "已接受为新版本", tone: "success", summary: `候选已由你确认并应用为 v${task.appliedVersion ?? "新"}，六图已同步重渲染。` };
  if (task.status === "REJECTED") return { label: "已保留规则版", tone: "neutral", summary: "AI 候选已拒绝，正式内容没有被改动。" };
  if (task.status === "FAILED") return { label: "应用失败", tone: "danger", summary: "候选没有写入正式内容，当前规则版继续保留。" };
  return { label: "需要处理", tone: "warning", summary: "候选未通过检查或源版本已变化，当前规则版继续保留。" };
}

function CopyDiff({ baseline, candidate }: { baseline: ContentBundle; candidate: CodexCopyCandidate }) {
  const sections = [
    {
      key: "titles",
      title: "标题候选",
      changed: JSON.stringify(baseline.titleCandidates) !== JSON.stringify(candidate.titleCandidates) || baseline.selectedTitle !== candidate.selectedTitle,
      baseline: <ul>{baseline.titleCandidates.map((title) => <li key={title} className={title === baseline.selectedTitle ? "selected" : ""}>{title}</li>)}</ul>,
      candidate: <ul>{candidate.titleCandidates.map((title) => <li key={title} className={title === candidate.selectedTitle ? "selected" : ""}>{title}</li>)}</ul>
    },
    {
      key: "description",
      title: "商品详情",
      changed: baseline.description !== candidate.description,
      baseline: <div className="copy-diff-text">{baseline.description.split("\n\n").map((text, index) => <p key={`${index}-${text}`}>{text}</p>)}</div>,
      candidate: <div className="copy-diff-text">{candidate.description.split("\n\n").map((text, index) => <p key={`${index}-${text}`}>{text}</p>)}</div>
    },
    {
      key: "faq",
      title: "常见问题",
      changed: JSON.stringify(baseline.faq) !== JSON.stringify(candidate.faq),
      baseline: <dl>{baseline.faq.map((entry) => <div key={entry.question}><dt>{entry.question}</dt><dd>{entry.answer}</dd></div>)}</dl>,
      candidate: <dl>{candidate.faq.map((entry) => <div key={entry.question}><dt>{entry.question}</dt><dd>{entry.answer}</dd></div>)}</dl>
    }
  ];
  return <section className="copy-diff" aria-labelledby="copy-diff-title">
    <div className="copy-diff-heading"><div><h3 id="copy-diff-title">规则基线与 AI 候选差异</h3><p>只比较允许改写的标题、详情和 FAQ。价格、材料、图片计划、交付、事实声明与合规规则不会交给 AI 改动。</p></div></div>
    {sections.map((section) => <article key={section.key} className="copy-diff-section">
      <header><strong>{section.title}</strong><StatusPill tone={section.changed ? "warning" : "neutral"}>{section.changed ? "有变化" : "无变化"}</StatusPill></header>
      <div className="copy-diff-columns">
        <div><b>规则基线</b>{section.baseline}</div>
        <div><b>AI 候选</b>{section.candidate}</div>
      </div>
    </article>)}
  </section>;
}

export function ContentPage() {
  const { productId } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState(productId ?? "");
  const [tab, setTab] = useState<"copy" | "images" | "materials" | "delivery">("copy");
  const [copyReviewConfirmed, setCopyReviewConfirmed] = useState(false);
  const productsQuery = useQuery({ queryKey: ["products"], queryFn: async () => (await api<Product[]>("/api/products")).data! });
  useEffect(() => { if (!selectedId && productsQuery.data?.[0]) setSelectedId(productsQuery.data[0].id); }, [productsQuery.data, selectedId]);
  useEffect(() => { if (productId) setSelectedId(productId); }, [productId]);
  const detailQuery = useQuery({ queryKey: ["product-detail", selectedId], enabled: Boolean(selectedId), queryFn: async () => (await api<ProductDetail>(`/api/products/${selectedId}`)).data! });
  const imageTaskQuery = useQuery({
    queryKey: ["case-image-task", selectedId],
    enabled: Boolean(selectedId),
    queryFn: async () => (await api<ImageGenTask | null>(`/api/products/${selectedId}/case-image/codex`)).data ?? null
  });
  const copyTaskQuery = useQuery({
    queryKey: ["codex-copy-task", selectedId],
    enabled: Boolean(selectedId),
    refetchInterval: tab === "copy" ? 3_000 : false,
    queryFn: async () => (await api<CodexCopyTaskData>(`/api/products/${selectedId}/copy/codex`)).data ?? { task: null }
  });
  const generate = useMutation({
    mutationFn: async () => api<{ id: string; version: number; bundle: ContentBundle; issues: string[] }>(`/api/products/${selectedId}/content/generate`, { method: "POST" }),
    onSuccess: async () => {
      await Promise.all([queryClient.invalidateQueries({ queryKey: ["product-detail", selectedId] }), queryClient.invalidateQueries({ queryKey: ["products"] }), queryClient.invalidateQueries({ queryKey: ["dashboard"] })]);
    }
  });
  const prepareAll = useMutation({
    mutationFn: async () => api<BatchPreparation>("/api/content/prepare-all", { method: "POST" }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["product-detail"] }),
        queryClient.invalidateQueries({ queryKey: ["products"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard"] })
      ]);
    }
  });
  const codexImage = useMutation({
    mutationFn: async (targetProductId: string) => api<{ turn: unknown; task: ImageGenTask }>(`/api/products/${targetProductId}/case-image/codex`, { method: "POST" }),
    onSuccess: async (_response, targetProductId) => {
      await queryClient.invalidateQueries({ queryKey: ["case-image-task", targetProductId] });
    }
  });
  const verifyImage = useMutation({
    mutationFn: async ({ targetProductId, outcome }: { targetProductId: string; outcome: ImageGenOutcome }) => api<Record<string, unknown>>(
      `/api/products/${targetProductId}/case-image/codex/verify`,
      { method: "POST", ...jsonBody({ generationOutcome: outcome }) }
    ),
    onSettled: async (_response, _error, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["case-image-task", variables.targetProductId] }),
        queryClient.invalidateQueries({ queryKey: ["product-detail", variables.targetProductId] })
      ]);
    }
  });
  const refreshCopyState = async (targetProductId: string, refreshContent = false) => {
    const tasks = [queryClient.invalidateQueries({ queryKey: ["codex-copy-task", targetProductId] })];
    if (refreshContent) tasks.push(
      queryClient.invalidateQueries({ queryKey: ["product-detail", targetProductId] }),
      queryClient.invalidateQueries({ queryKey: ["products"] }),
      queryClient.invalidateQueries({ queryKey: ["dashboard"] })
    );
    await Promise.all(tasks);
  };
  const codexCopy = useMutation({
    mutationFn: async (targetProductId: string) => api<{ task: CodexCopyTask }>(`/api/products/${targetProductId}/copy/codex`, { method: "POST" }),
    onSuccess: async (_response, targetProductId) => { setCopyReviewConfirmed(false); await refreshCopyState(targetProductId); }
  });
  const verifyCopy = useMutation({
    mutationFn: async (targetProductId: string) => api<CodexCopyTaskData>(`/api/products/${targetProductId}/copy/codex/verify`, { method: "POST" }),
    onSettled: async (_response, _error, targetProductId) => { setCopyReviewConfirmed(false); await refreshCopyState(targetProductId); }
  });
  const applyCopy = useMutation({
    mutationFn: async (targetProductId: string) => api<{ task: CodexCopyTask }>(`/api/products/${targetProductId}/copy/codex/apply`, { method: "POST", ...jsonBody({ confirmation: "APPLY_VERIFIED_CODEX_COPY" }) }),
    onSuccess: async (_response, targetProductId) => { setCopyReviewConfirmed(false); await refreshCopyState(targetProductId, true); }
  });
  const rejectCopy = useMutation({
    mutationFn: async (targetProductId: string) => api<{ task: CodexCopyTask }>(`/api/products/${targetProductId}/copy/codex/reject`, { method: "POST", ...jsonBody({ confirmation: "KEEP_LOCAL_COPY" }) }),
    onSuccess: async (_response, targetProductId) => { setCopyReviewConfirmed(false); await refreshCopyState(targetProductId); }
  });
  useEffect(() => {
    codexImage.reset(); verifyImage.reset(); codexCopy.reset(); verifyCopy.reset(); applyCopy.reset(); rejectCopy.reset(); setCopyReviewConfirmed(false);
  }, [selectedId]);
  const detail = detailQuery.data;
  const bundle = detail?.content?.bundle;
  const product = detail?.product;
  const products = productsQuery.data ?? [];
  const readyCount = products.filter((item) => item.readiness !== "PLANNED").length;
  const pendingCount = Math.max(0, products.length - readyCount);
  const batchResult = prepareAll.data?.data;
  const imageLabels = useMemo(() => ["品牌封面", "案例效果", "价格范围", "服务流程", "材料清单", "修改售后"], []);
  const imageTask = imageTaskQuery.data;
  const imageTaskResult = parseImageGenResult(imageTask);
  const imageTaskStatus = imageGenStatus(imageTask);
  const displayedImageTaskStatus = imageTaskQuery.isLoading
    ? { label: "正在读取", tone: "neutral" as const }
    : imageTaskQuery.error
      ? { label: "读取失败", tone: "warning" as const }
      : imageTaskStatus;
  const imageTaskActive = imageTask?.status === "RUNNING" || imageTask?.status === "VERIFYING";
  const imageVersionKey = imageTask?.status === "SUCCEEDED" ? imageTask.updated_at : detail?.content?.version ?? 0;
  const copyTask = copyTaskQuery.data?.task;
  const copyCandidate = copyTaskQuery.data?.preview;
  const copyTaskStatus = codexCopyStatus(copyTask);
  const copyTaskActive = copyTask?.status === "RUNNING";
  const copyCanVerify = Boolean(copyTask && ["READY_TO_VERIFY", "WAITING_USER", "FAILED"].includes(copyTask.status));
  const copyCanReject = Boolean(copyTask && ["READY_TO_VERIFY", "VERIFIED", "WAITING_USER"].includes(copyTask.status));

  return <div className="page-stack">
    <PageHeader eyebrow="商品内容制作" title="内容工厂" description="生成白描文案、价格档、材料清单、FAQ、交付规则和六张商品图。" actions={<><Button variant="secondary" onClick={() => navigate("/publish")}>查看发布计划</Button><Button onClick={() => generate.mutate()} loading={generate.isPending} disabled={!selectedId}><MagicWand size={18} /> {bundle ? "生成新版本" : "生成完整内容"}</Button></>} />
    <Panel className="content-batch-panel" aria-labelledby="content-batch-title">
      {productsQuery.isLoading ? <LoadingState label="正在统计商品准备情况" /> : productsQuery.error ? <ErrorState message={productsQuery.error.message} retry={() => void productsQuery.refetch()} /> : products.length === 0 ? <EmptyState title="商品库还是空的" description="商品导入后，可在这里一次准备全部内容包。" /> : <>
        <div className="content-batch-main">
          <div className="content-batch-copy">
            <span className="content-batch-icon"><MagicWand size={24} weight="duotone" /></span>
            <div><h2 id="content-batch-title">24 个商品内容包</h2><p>一次准备所有待处理商品的白描文案和六张本地模板图。已就绪商品不会重复生成，也不会创建发布任务。</p></div>
          </div>
          <div className="content-batch-counts" aria-label="商品内容准备进度">
            <div><CheckCircle size={20} weight="fill" /><span><strong data-testid="content-ready-count">{readyCount}</strong>已就绪</span></div>
            <div><ClockCountdown size={20} weight="fill" /><span><strong data-testid="content-pending-count">{pendingCount}</strong>待准备</span></div>
          </div>
          <Button size="large" onClick={() => prepareAll.mutate()} loading={prepareAll.isPending}>
            <MagicWand size={18} /> {pendingCount === 0 ? "检查并补齐全部内容" : `一键准备剩余 ${pendingCount} 个`}
          </Button>
        </div>
        <ProgressBar value={readyCount} max={products.length} label={`准备进度 ${readyCount} / ${products.length}`} />
        {prepareAll.isPending && <InlineAlert title="正在逐项准备">系统正在本地生成白描文案和六图模板，请保持工作台开启。期间不会调用 ImageGen，也不会操作闲鱼。</InlineAlert>}
        {prepareAll.error && <InlineAlert tone="danger" title="批量准备没有完成">{prepareAll.error.message}</InlineAlert>}
        {batchResult && <div className="content-batch-feedback">
          <InlineAlert tone={batchResult.failed ? "warning" : "success"} title={batchResult.failed ? "批量准备已结束，仍有未完成项目" : "批量准备已完成"}>
            本次新准备 {batchResult.generated} 个，当前就绪 {batchResult.readyAfter} 个，未完成 {batchResult.failed} 个。
          </InlineAlert>
          <details className="content-batch-results" open={batchResult.failed > 0}>
            <summary>查看 {batchResult.items.length} 个商品的逐项结果</summary>
            <div>{batchResult.items.map((item) => <article key={item.productId} className={item.ready ? "ready" : "failed"}>
              {item.ready ? <CheckCircle size={18} weight="fill" /> : <WarningCircle size={18} weight="fill" />}
              <div><strong>{item.productName}</strong><p>{item.summary}</p>{item.issues.length > 0 && <small>{item.issues.join("；")}</small>}</div>
              <span>{item.outcome === "already_ready" ? "已有版本" : item.ready ? `v${item.version} · 六图` : "未就绪"}</span>
            </article>)}</div>
          </details>
        </div>}
      </>}
    </Panel>
    {generate.error && <InlineAlert tone="danger" title="当前商品没有生成成功">{generate.error.message}</InlineAlert>}
    <div className="content-layout">
      <Panel className="product-picker-panel">
        <Field label="当前商品"><select value={selectedId} onChange={(event) => { setSelectedId(event.target.value); navigate(`/content/${event.target.value}`, { replace: true }); }}>{productsQuery.data?.map((item) => <option key={item.id} value={item.id}>{item.category} · {item.name}</option>)}</select></Field>
        {product && <div className="product-summary"><span className={`category-symbol category-${product.category}`}>{product.name[0]}</span><h2>{product.name}</h2><p>{formatMoney(product.prices[0])} / {formatMoney(product.prices[1])} / {formatMoney(product.prices[2])}</p><StatusPill tone={product.readiness === "PLANNED" ? "neutral" : "blue"}>{product.readiness === "PLANNED" ? "待策划" : "内容就绪"}</StatusPill></div>}
        <div className="content-checklist"><h3>内容包检查</h3>{["3 个标题候选", "克制说明型详情", "3 档价格与底线", "买家材料清单", "固定六图计划", "FAQ 与交付规则"].map((item) => <div key={item}><Check size={16} weight="bold" /><span>{item}</span></div>)}</div>
        <InlineAlert tone="info">案例图可用 Codex ImageGen 生成；文字、价格和流程由本地模板渲染。</InlineAlert>
      </Panel>

      <Panel className="content-editor-panel">
        {detailQuery.isLoading ? <LoadingState label="正在读取内容版本" /> : detailQuery.error ? <ErrorState message={detailQuery.error.message} retry={() => void detailQuery.refetch()} /> : !bundle ? <EmptyState title="还没有内容版本" description="点击“生成完整内容”，先用本地规则创建可编辑版本。没有 API Key 也能运行。" action={<Button onClick={() => generate.mutate()} loading={generate.isPending}><MagicWand /> 开始生成</Button>} /> : <>
          <div className="content-version-bar"><div><StatusPill tone={detail.content?.issues.length || bundle.complianceFlags.length ? "warning" : "success"}>{detail.content?.issues.length ? "需要复核" : bundle.complianceFlags.length ? "发布前待许可证复核" : "校验通过"}</StatusPill><span>版本 v{detail.content?.version}</span></div><small>{detail.content?.issues.length ? `${detail.content.issues.length} 个问题` : bundle.complianceFlags.length ? "内容已就绪，发布与打包前仍需完成许可证闸门" : "价格、事实声明和六图数量一致"}</small></div>
          <div className="content-tabs" role="tablist">{([['copy','标题与文案'],['images','六张商品图'],['materials','材料与 FAQ'],['delivery','交付与合规']] as const).map(([value, label]) => <button key={value} className={tab === value ? "active" : ""} onClick={() => setTab(value)}>{label}</button>)}</div>
          {tab === "copy" && <div className="content-pane">
            <section className="copy-codex-control" aria-labelledby="copy-codex-title" aria-busy={codexCopy.isPending || verifyCopy.isPending || applyCopy.isPending || rejectCopy.isPending}>
              <div className="copy-codex-head"><div><h2 id="copy-codex-title"><Robot size={19} weight="duotone" /> Codex 白描改写</h2><p>使用当前 Codex / ChatGPT 登录，不要求 API Key。规则版始终可用；AI 只能提交候选，不能直接改正式内容。</p></div><StatusPill tone={copyTaskStatus.tone}>{copyTaskStatus.label}</StatusPill></div>
              <ol className="copy-codex-steps" aria-label="Codex 文案人工接收流程">
                <li className={copyTask && copyTask.status !== "RUNNING" ? "done" : "current"}><span>1</span><div><strong>提交改写任务</strong><small>只生成独立候选 JSON</small></div></li>
                <li className={["VERIFIED", "REJECTED", "SUCCEEDED"].includes(copyTask?.status ?? "") ? "done" : copyTask?.status === "READY_TO_VERIFY" || copyTask?.status === "WAITING_USER" ? "current" : ""}><span>2</span><div><strong>检查候选</strong><small>验路径、价格、禁词和事实</small></div></li>
                <li className={copyTask?.status === "SUCCEEDED" ? "done" : copyTask?.status === "VERIFIED" ? "current" : ""}><span>3</span><div><strong>人工决定</strong><small>接受新版本或保留规则版</small></div></li>
              </ol>
              <div className="copy-codex-status" aria-live="polite">{copyTask?.status === "SUCCEEDED" ? <CheckCircle size={18} weight="fill" /> : copyTask?.status === "FAILED" || copyTask?.status === "WAITING_USER" ? <WarningCircle size={18} weight="fill" /> : <ClockCountdown size={18} weight="fill" />}<span><strong>{copyTaskStatus.summary}</strong>{copyTask && <small>源版本 v{copyTask.sourceVersion} · 最近更新 {formatTime(copyTask.updatedAt)}</small>}</span></div>
              {copyTask?.lastError && <InlineAlert tone="warning" title="已回退到规则版">{copyTask.lastError}</InlineAlert>}
              {copyTaskQuery.data?.verificationIssues?.length ? <InlineAlert tone="warning" title="候选未通过检查">{copyTaskQuery.data.verificationIssues.join("；")}</InlineAlert> : null}
              <div className="copy-codex-actions">
                <Button variant="secondary" data-testid="codex-copy-start" onClick={() => selectedId && codexCopy.mutate(selectedId)} loading={codexCopy.isPending} disabled={!selectedId || copyTaskActive}><Robot size={17} /> {copyTask ? "重新提交改写任务" : "让 Codex 改写"}</Button>
                <Button data-testid="codex-copy-verify" onClick={() => selectedId && verifyCopy.mutate(selectedId)} loading={verifyCopy.isPending} disabled={!selectedId || !copyCanVerify || codexCopy.isPending}><CheckCircle size={17} /> 检查候选</Button>
                {copyCanReject && <Button variant="ghost" data-testid="codex-copy-reject" onClick={() => selectedId && rejectCopy.mutate(selectedId)} loading={rejectCopy.isPending} disabled={applyCopy.isPending}>拒绝并保留规则版</Button>}
              </div>
              {codexCopy.isSuccess && codexCopy.variables === selectedId && <InlineAlert tone="info" title="任务已提交">{codexCopy.data.summary} 请等待候选后再点“检查候选”。</InlineAlert>}
              {codexCopy.error && codexCopy.variables === selectedId && <InlineAlert tone="warning" title="任务没有提交">{codexCopy.error.message} 当前规则版不受影响。</InlineAlert>}
              {verifyCopy.isSuccess && verifyCopy.variables === selectedId && <InlineAlert tone="success" title="候选已验真">{verifyCopy.data.summary} 这一步没有保存新版本。</InlineAlert>}
              {verifyCopy.error && verifyCopy.variables === selectedId && <InlineAlert tone="warning" title="候选没有通过">{verifyCopy.error.message} 当前规则版继续保留。</InlineAlert>}
              {rejectCopy.isSuccess && rejectCopy.variables === selectedId && <InlineAlert tone="success" title="已保留规则版">{rejectCopy.data.summary}</InlineAlert>}
              {copyCandidate && copyTask?.status === "VERIFIED" && bundle && <>
                <CopyDiff baseline={bundle} candidate={copyCandidate} />
                <label className="copy-accept-confirm"><input type="checkbox" checked={copyReviewConfirmed} onChange={(event) => setCopyReviewConfirmed(event.target.checked)} /><span><strong>我已逐项核对规则基线与 AI 候选</strong><small>接受后会创建新内容版本并重渲染六图；旧版本仍保留在版本记录中。</small></span></label>
                <div className="copy-final-actions"><Button data-testid="codex-copy-apply" onClick={() => selectedId && applyCopy.mutate(selectedId)} loading={applyCopy.isPending} disabled={!copyReviewConfirmed || rejectCopy.isPending}><Check size={17} weight="bold" /> 接受为新版本</Button><Button variant="secondary" onClick={() => selectedId && rejectCopy.mutate(selectedId)} disabled={applyCopy.isPending || rejectCopy.isPending}>不接受，保留规则版</Button></div>
              </>}
              {applyCopy.isSuccess && applyCopy.variables === selectedId && <InlineAlert tone="success" title="新版本已保存">{applyCopy.data.summary}</InlineAlert>}
              {applyCopy.error && applyCopy.variables === selectedId && <InlineAlert tone="danger" title="没有应用候选">{applyCopy.error.message} 当前规则版仍可使用。</InlineAlert>}
            </section>
            <SectionHeader title="当前正式标题" description="以下始终显示已保存的正式版本；AI 候选在接受前不会出现在这里。" />
            <div className="title-options">{bundle.titleCandidates.map((title) => <div key={title} className={title === bundle.selectedTitle ? "selected" : ""}><span>{title === bundle.selectedTitle ? <Check weight="bold" /> : null}</span><strong>{title}</strong>{title === bundle.selectedTitle && <small>当前使用</small>}</div>)}</div>
            <SectionHeader title="商品详情" description="短句、具体、先看材料再确认。" /><article className="copy-preview">{bundle.description.split("\n\n").map((paragraph) => <p key={paragraph}>{paragraph}</p>)}</article>
            <SectionHeader title="三档价格" /><div className="tier-grid">{bundle.priceTiers.map((tier) => <div key={tier.name}><span>{tier.name}</span><strong>{formatMoney(tier.price)}</strong><p>{tier.scope}</p><small>最低 {formatMoney(tier.floorPrice)} · {tier.revisions} 次修改</small></div>)}</div>
          </div>}
          {tab === "images" && <div className="content-pane">
            <InlineAlert tone="success" title="六张真实文件预览">文字、价格和流程由本地模板准确渲染；点击任一图片可在新页放大检查。</InlineAlert>
            <section className="imagegen-control" aria-labelledby="imagegen-control-title" aria-busy={imageTaskQuery.isLoading || codexImage.isPending || verifyImage.isPending}>
              <div className="imagegen-control-head">
                <div>
                  <h2 id="imagegen-control-title"><Robot size={19} weight="duotone" /> Codex 案例图</h2>
                  <p>使用当前 Codex / ChatGPT 登录，不要求另填 API Key。Codex 完成不等于资产已替换，必须验真成功。</p>
                </div>
                <StatusPill tone={displayedImageTaskStatus.tone} data-testid="imagegen-task-status">{displayedImageTaskStatus.label}</StatusPill>
              </div>
              <ol className="imagegen-steps" aria-label="ImageGen 接收流程">
                <li className={imageTask?.status === "SUCCEEDED" || imageTask?.status === "VERIFYING" ? "done" : !imageTask || imageTask.status === "RUNNING" ? "current" : ""}><span>1</span><div><strong>生成候选图</strong><small>写入新的候选文件</small></div></li>
                <li className={imageTask?.status === "SUCCEEDED" ? "done" : imageTask?.status === "VERIFYING" || imageTask?.status === "WAITING_USER" || imageTask?.status === "FAILED" ? "current" : ""}><span>2</span><div><strong>检查成品</strong><small>验证路径、格式、尺寸和哈希</small></div></li>
                <li className={imageTask?.status === "SUCCEEDED" ? "done" : ""}><span>3</span><div><strong>替换模板</strong><small>仅验真成功后执行</small></div></li>
              </ol>
              {imageTaskQuery.isLoading ? <div className="imagegen-status-line" aria-live="polite"><ClockCountdown size={18} /><span>正在读取最近一次任务</span></div> : imageTaskQuery.error ? <InlineAlert tone="warning" title="任务状态暂时不可用">{imageTaskQuery.error.message}</InlineAlert> : <>
                <div className="imagegen-status-line" aria-live="polite">
                  {imageTask?.status === "SUCCEEDED" ? <CheckCircle size={18} weight="fill" /> : imageTask?.status === "FAILED" || imageTask?.status === "WAITING_USER" ? <WarningCircle size={18} weight="fill" /> : <ClockCountdown size={18} weight="fill" />}
                  <span><strong>{imageTaskStatus.summary}</strong>{imageTask && <small>最近更新：{formatTime(imageTask.updated_at)}</small>}</span>
                </div>
                {imageTaskResult?.summary && <InlineAlert tone={imageTask?.status === "FAILED" ? "danger" : "warning"} title="本地模板已保留">{imageTaskResult.summary}</InlineAlert>}
                <div className="imagegen-actions">
                  <Button variant="secondary" data-testid="imagegen-start" onClick={() => selectedId && codexImage.mutate(selectedId)} loading={codexImage.isPending} disabled={!selectedId || imageTaskActive}>
                    <Robot size={17} /> {imageTask ? "重新生成候选图" : "让 Codex 生成案例图"}
                  </Button>
                  {imageTask && imageTask.status !== "SUCCEEDED" && <Button data-testid="imagegen-verify" onClick={() => selectedId && verifyImage.mutate({ targetProductId: selectedId, outcome: "completed" })} loading={verifyImage.isPending} disabled={!selectedId || codexImage.isPending}>
                    <CheckCircle size={17} /> 检查生成成品
                  </Button>}
                  <span className="muted-text">验真前，商品图始终使用现有本地模板。</span>
                </div>
                {codexImage.isSuccess && codexImage.variables === selectedId && <InlineAlert tone="info" title="候选图任务已开始">{codexImage.data.summary}</InlineAlert>}
                {codexImage.error && codexImage.variables === selectedId && <InlineAlert tone="warning" title="没有开始生成">{codexImage.error.message}</InlineAlert>}
                {verifyImage.isSuccess && verifyImage.variables?.targetProductId === selectedId && <InlineAlert tone="success" title="成品已通过验真">{verifyImage.data.summary}</InlineAlert>}
                {verifyImage.error && verifyImage.variables?.targetProductId === selectedId && <InlineAlert tone="warning" title="成品尚未接收">{verifyImage.error.message}</InlineAlert>}
                {imageTask && imageTask.status !== "SUCCEEDED" && <details className="imagegen-fallback">
                  <summary>ImageGen 没有输出时怎么办</summary>
                  <p>若 Codex 明确提示额度不足，或确认没有生成文件，可以记录结果并继续使用本地模板。该操作不会删除或覆盖现有图片。</p>
                  <div className="button-row">
                    <Button size="small" variant="ghost" onClick={() => selectedId && verifyImage.mutate({ targetProductId: selectedId, outcome: "quota_exhausted" })} disabled={verifyImage.isPending}>记录额度不足</Button>
                    <Button size="small" variant="ghost" onClick={() => selectedId && verifyImage.mutate({ targetProductId: selectedId, outcome: "not_generated" })} disabled={verifyImage.isPending}>记录未生成</Button>
                  </div>
                </details>}
              </>}
            </section>
            <div className="image-plan-grid">{bundle.imagePlan.map((brief, index) => { const src = product ? `/api/products/${product.id}/images/${index + 1}?v=${encodeURIComponent(String(index === 1 ? imageVersionKey : detail.content?.version ?? 0))}` : ""; return <article key={brief.index}><div className="image-preview">{product && <a href={src} target="_blank" rel="noreferrer" title={`放大查看${imageLabels[index]}`}><img src={src} alt={`${product.name}·${imageLabels[index]}`} /></a>}<b>{index === 1 ? imageTask?.status === "SUCCEEDED" ? "ImageGen 已验真" : "案例图模板" : "本地模板"}</b></div><h3>{brief.title}</h3><p>{brief.brief}</p></article>; })}</div>
          </div>}
          {tab === "materials" && <div className="content-pane split-pane"><div><SectionHeader title="买家材料清单" />{bundle.materials.map((item) => <div className="requirement-row" key={item.id}><span className={item.required ? "required" : "optional"}>{item.required ? "必需" : "可选"}</span><div><strong>{item.label}</strong><p>{item.description}</p></div></div>)}</div><div><SectionHeader title="常见问题" />{bundle.faq.map((item) => <details key={item.question}><summary>{item.question}</summary><p>{item.answer}</p></details>)}</div></div>}
          {tab === "delivery" && <div className="content-pane"><div className="delivery-plan"><Package size={30} /><div><h3>{bundle.deliveryPlan.mode === "remote_service" ? "人工远程服务记录" : "标准数字交付包"}</h3><p>{bundle.deliveryPlan.packageRequired ? "优先使用平台附件；大文件转百度上传，分享权限不足时等待人工粘贴链接。" : "只记录授权、时间、动作摘要和结果，不保存密码、验证码或远控码。"}</p></div></div><ul className="check-list">{bundle.deliveryPlan.checklist.map((item) => <li key={item}><Check size={17} weight="bold" />{item}</li>)}</ul><SectionHeader title="事实与合规" />{bundle.claims.map((claim) => <div className="claim-row" key={claim.text}><Sparkle size={18} /><div><strong>{claim.text}</strong><p>依据：{claim.evidence}</p></div></div>)}{bundle.complianceFlags.length ? <InlineAlert tone="warning"><WarningCircle /> {bundle.complianceFlags.join("；")}</InlineAlert> : <InlineAlert tone="success">当前内容没有命中禁词、价格或许可证阻断。</InlineAlert>}</div>}
        </>}
      </Panel>
    </div>
  </div>;
}
