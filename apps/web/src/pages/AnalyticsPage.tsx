import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowCounterClockwise, ArrowRight, ChartBar, FileText, FloppyDisk, Info, TrendUp } from "@phosphor-icons/react";
import { api, formatTime, jsonBody } from "../api";
import { Button, EmptyState, ErrorState, LoadingState, Metric, PageHeader, Panel, ProgressBar, SectionHeader, StatusPill } from "../components/ui";

type Funnel = { products?: number; contentReady?: number; published: number; consultations: number; orders: number; delivered: number };
type VisibleSnapshot = {
  id: string;
  source: string;
  page_type: string;
  page_url: string;
  adapter_version?: string | null;
  captured_at: string;
  metrics: Record<string, number>;
};
type DailyReport = { id: string; report_date: string; source: string; summary: string; suggestions: string[] };
type ReportDraft = {
  date: string;
  content: string;
  defaultContent?: string | null;
  updatedAt?: string | null;
  updated_at?: string | null;
};
type Analytics = {
  productionFunnel: Funnel;
  demoFunnel: Funnel;
  visibleSnapshots: VisibleSnapshot[];
  reports: DailyReport[];
  releasePlan: Array<{ day: number; products: string[] }>;
  note: string;
};

const metricLabels: Record<string, string> = {
  unreadMessages: "未读消息",
  interested: "想要",
  views: "浏览",
  favorites: "收藏",
  selling: "在售",
  sold: "已售",
  reviews: "评价",
  pendingOrders: "待处理订单"
};

function beijingDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function reportAsDraft(report: DailyReport | undefined): string {
  if (!report) return "";
  const suggestions = report.suggestions.map((item, index) => `${index + 1}. ${item.trim()}`).join("\n");
  return [report.summary.trim(), suggestions].filter(Boolean).join("\n\n");
}

export function AnalyticsPage() {
  const queryClient = useQueryClient();
  const today = useMemo(beijingDate, []);
  const [draftContent, setDraftContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const draftInitialized = useRef(false);
  const query = useQuery({ queryKey: ["analytics"], queryFn: async () => (await api<Analytics>("/api/analytics")).data! });
  const draftQuery = useQuery({
    queryKey: ["analytics-report-draft", today],
    queryFn: async () => (await api<ReportDraft>("/api/analytics/report-draft")).data!
  });
  const report = useMutation({
    mutationFn: async () => api("/api/analytics/daily-report", { method: "POST" }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["analytics"] }),
        queryClient.invalidateQueries({ queryKey: ["analytics-report-draft", today] })
      ]);
    }
  });
  const reports = query.data?.reports ?? [];
  const generatedDefault = useMemo(() => {
    const currentReport = reports.find((item) => item.report_date === today) ?? reports[0];
    return reportAsDraft(currentReport);
  }, [reports, today]);
  const defaultContent = draftQuery.data?.defaultContent?.trim() || generatedDefault;
  const saveDraft = useMutation({
    mutationFn: async (draft: { date: string; content: string }) => (
      await api<ReportDraft>("/api/analytics/report-draft", { method: "PUT", ...jsonBody(draft) })
    ).data,
    onSuccess: (saved, submitted) => {
      setSavedContent(saved?.content ?? submitted.content);
      setLastSavedAt(saved?.updatedAt ?? saved?.updated_at ?? new Date().toISOString());
      queryClient.setQueryData(["analytics-report-draft", today], saved ?? {
        date: submitted.date,
        content: submitted.content,
        updatedAt: new Date().toISOString()
      });
    }
  });

  useEffect(() => {
    if (draftInitialized.current || draftQuery.isLoading) return;
    const initialContent = draftQuery.data?.content ?? defaultContent;
    setDraftContent(initialContent);
    setSavedContent(initialContent);
    setLastSavedAt(draftQuery.data?.updatedAt ?? draftQuery.data?.updated_at ?? null);
    draftInitialized.current = true;
  }, [defaultContent, draftQuery.data, draftQuery.isLoading]);

  const hasUnsavedChanges = draftContent !== savedContent;

  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeLeaving);
    return () => window.removeEventListener("beforeunload", warnBeforeLeaving);
  }, [hasUnsavedChanges]);

  if (query.isLoading) return <LoadingState label="正在计算本地经营数据" />;
  if (query.error || !query.data) return <ErrorState message={query.error instanceof Error ? query.error.message : "无法读取分析"} />;
  const { productionFunnel: funnel, demoFunnel, releasePlan, visibleSnapshots } = query.data;
  const productCount = funnel.products ?? 0;
  const contentReady = funnel.contentReady ?? 0;
  const funnelItems = [
    ["商品库", productCount], ["内容就绪", contentReady], ["真实发布", funnel.published],
    ["真实咨询", funnel.consultations], ["真实订单", funnel.orders], ["真实交付", funnel.delivered]
  ] as const;
  return <div className="page-stack">
    <PageHeader
      eyebrow="有证据的经营分析"
      title="经营分析"
      description="真实记录、扩展可见页面快照和演示数据分区展示；没有证据的曝光、咨询或成交不会被补算。"
      actions={<Button onClick={() => report.mutate()} loading={report.isPending}><FileText />生成今日日报</Button>}
    />
    <section className="metrics-strip analytics-metrics"><Metric label="商品总数" value={productCount} /><Metric label="内容就绪" value={contentReady} /><Metric label="真实发布" value={funnel.published} /><Metric label="真实咨询" value={funnel.consultations} /><Metric label="真实订单" value={funnel.orders} /></section>
    <div className="analytics-grid">
      <Panel className="span-7"><SectionHeader title="真实经营漏斗" description="这里只统计非演示、非模拟记录。" /><div className="funnel-chart">{funnelItems.map(([label, value], index) => <div key={label} style={{ width: `${100 - index * 9}%` }}><span>{label}</span><strong>{value}</strong>{index < funnelItems.length - 1 && <ArrowRight />}</div>)}</div></Panel>
      <Panel className="span-5"><SectionHeader title="准备度" /><div className="analytics-readiness"><span><ChartBar size={34} /></span><strong>{Math.round(contentReady / Math.max(1, productCount) * 100)}%</strong><p>24 个首发商品中的内容准备比例</p><ProgressBar value={contentReady} max={productCount} /></div><div className="data-note"><Info /><p>{query.data.note}</p></div></Panel>

      <Panel className="span-5"><SectionHeader title="演示与模拟数据" description="用于验收流程，不进入真实经营指标。" /><div className="source-comparison"><div><span>模拟发布</span><strong>{demoFunnel.published}</strong></div><div><span>演示咨询</span><strong>{demoFunnel.consultations}</strong></div><div><span>演示订单</span><strong>{demoFunnel.orders}</strong></div><div><span>演示交付</span><strong>{demoFunnel.delivered}</strong></div></div></Panel>
      <Panel className="span-7"><SectionHeader title="闲鱼可见数据快照" description="扩展只读取当前页面正常显示的数字，不访问 Cookie。" />{visibleSnapshots.length ? <div className="snapshot-list">{visibleSnapshots.slice(0, 6).map((snapshot) => <article key={snapshot.id}><div><StatusPill tone="success">真实可见</StatusPill><strong>{snapshot.page_type}</strong><small>{formatTime(snapshot.captured_at)}</small></div><p>{Object.entries(snapshot.metrics).map(([key, value]) => `${metricLabels[key] ?? key} ${value}`).join(" · ") || "页面未显示可采集数字"}</p></article>)}</div> : <EmptyState title="还没有真实快照" description="在账号中心打开商品、消息或订单页面，配对后的扩展会记录可见数字。" />}</Panel>

      <Panel className="span-12 report-editor-panel">
        <SectionHeader title="本地经营日报" description="日报建议只依据真实记录与可见快照；你可以修改措辞和行动安排后保存为本地草稿。" />
        <div className="report-editor">
          <div className="report-editor-heading">
            <label htmlFor="daily-report-draft">{today} 日报草稿</label>
            <span className={`draft-state ${hasUnsavedChanges ? "unsaved" : "saved"}`} role="status" aria-live="polite">
              {hasUnsavedChanges ? "有未保存修改" : "草稿已保存"}
            </span>
          </div>
          <p id="daily-report-draft-help">可补充当天判断和后续安排。恢复默认建议只会替换编辑区内容，需要再次点击保存。</p>
          <textarea
            id="daily-report-draft"
            rows={9}
            value={draftContent}
            onChange={(event) => {
              setDraftContent(event.target.value);
              if (!saveDraft.isPending) saveDraft.reset();
            }}
            aria-describedby="daily-report-draft-help daily-report-save-status"
            disabled={draftQuery.isLoading}
            placeholder={draftQuery.isLoading ? "正在恢复本地草稿…" : "生成今日日报后，可在这里整理最终版本。"}
          />
          <div className="report-editor-footer">
            <div id="daily-report-save-status" className="report-save-status" aria-live="polite">
              {draftQuery.isLoading ? <span>正在读取草稿</span> : draftQuery.error ? <span className="report-save-error" role="alert">草稿读取失败，可继续编辑并尝试保存。</span> : saveDraft.error ? <span className="report-save-error" role="alert">{saveDraft.error instanceof Error ? saveDraft.error.message : "草稿保存失败，请稍后重试。"}</span> : lastSavedAt ? <span>最后保存：{formatTime(lastSavedAt)}</span> : <span>尚未保存过草稿</span>}
            </div>
            <div className="report-editor-actions">
              <Button
                variant="secondary"
                onClick={() => {
                  setDraftContent(defaultContent);
                  if (!saveDraft.isPending) saveDraft.reset();
                }}
                disabled={draftQuery.isLoading || !defaultContent || draftContent === defaultContent}
                aria-label="恢复当天日报的默认建议"
              >
                <ArrowCounterClockwise />恢复默认建议
              </Button>
              <Button
                onClick={() => saveDraft.mutate({ date: today, content: draftContent })}
                loading={saveDraft.isPending}
                disabled={draftQuery.isLoading || !hasUnsavedChanges}
                aria-label="保存日报草稿"
              >
                <FloppyDisk />保存草稿
              </Button>
            </div>
          </div>
        </div>
        <div className="report-history">
          <h3>历史日报</h3>
          {reports.length ? <div className="report-list">{reports.slice(0, 5).map((item) => <article key={item.id}><div><strong>{item.report_date}</strong><StatusPill tone="blue" dot={false}>真实经营</StatusPill></div><p>{item.summary}</p><ul>{item.suggestions.map((suggestion) => <li key={suggestion}>{suggestion}</li>)}</ul></article>)}</div> : <EmptyState title="尚未生成日报" description="点击右上角生成今日日报；同一天再次生成会更新原日报。" />}
        </div>
      </Panel>
      <Panel className="span-12"><SectionHeader title="14 天发布节奏" description="每天最多安排少量商品，先观察咨询质量和交付压力。" /><div className="release-calendar">{releasePlan.map((day) => <article key={day.day}><span>第 {day.day} 天</span><strong>{day.products.length}</strong><div>{day.products.map((product) => <small key={product}>{product}</small>)}</div></article>)}</div></Panel>
      <Panel className="span-12 recommendation-strip"><TrendUp size={25} /><div><strong>当前建议</strong><p>先完成一件商品的草稿填充和单件受控发布，再以真实咨询校准标题与 FAQ。没有真实数据前，不输出“提高曝光”类结论。</p></div></Panel>
    </div>
  </div>;
}
