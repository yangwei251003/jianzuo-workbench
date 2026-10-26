import { useQuery } from "@tanstack/react-query";
import { ArrowRight, CheckCircle, Clock, Package, Robot, Storefront, WarningCircle } from "@phosphor-icons/react";
import { Link } from "react-router-dom";
import type { DashboardSnapshot } from "@jianzuo/contracts";
import { api, formatMoney, formatTime } from "../api";
import { EmptyState, ErrorState, LoadingState, Metric, PageHeader, Panel, ProgressBar, SectionHeader, StatusPill } from "../components/ui";

export function DashboardPage() {
  const query = useQuery({ queryKey: ["dashboard-page"], queryFn: async () => (await api<DashboardSnapshot>("/api/dashboard")).data!, refetchInterval: 10_000 });
  if (query.isLoading) return <LoadingState label="正在汇总经营数据" />;
  if (query.error || !query.data) return <ErrorState message={query.error instanceof Error ? query.error.message : "无法读取经营数据"} retry={() => void query.refetch()} />;
  const data = query.data;
  const prepared = data.productCounts.CONTENT_READY + data.productCounts.READY_TO_PUBLISH + data.productCounts.PUBLISHED;

  return <div className="page-stack">
    <PageHeader eyebrow="今日运营工作" title="经营总览" description="先处理风险和材料，再安排内容与发布。模拟数据与真实数据始终分开。" actions={<Link className="button button-primary button-normal" to="/content">继续准备商品 <ArrowRight /></Link>} />
    <section className="metrics-strip" aria-label="关键经营数据">
      <Metric label="商品准备" value={`${prepared} / 24`} hint="已生成内容" />
      <Metric label="待审批动作" value={data.pendingApprovals} hint="发布与高风险写操作" tone={data.pendingApprovals ? "price" : "default"} />
      <Metric label="进行中订单" value={data.activeOrders} hint="不含已交付和退款审核" />
      <Metric label="今天收入" value={formatMoney(data.todayRevenue)} hint="仅记录真实或模拟已交付订单" tone="price" />
      <Metric label="运行任务" value={data.pendingJobs} hint="队列、等待与重试" />
    </section>

    <div className="dashboard-grid">
      <Panel className="span-8">
        <SectionHeader title="商品准备度" description="24 个商品按 14 天分批发布，先上图片、办公和远程排障。" actions={<Link className="text-link" to="/products">查看商品库 <ArrowRight /></Link>} />
        <div className="readiness-overview">
          <div className="readiness-chart"><div className="ring" style={{ "--progress": `${prepared / 24 * 100}%` } as React.CSSProperties}><strong>{Math.round(prepared / 24 * 100)}%</strong><span>已准备</span></div></div>
          <div className="readiness-list">
            <ProgressBar value={data.productCounts.CONTENT_READY} max={24} label={`内容就绪 ${data.productCounts.CONTENT_READY}`} />
            <ProgressBar value={data.productCounts.READY_TO_PUBLISH} max={24} label={`可发布 ${data.productCounts.READY_TO_PUBLISH}`} />
            <ProgressBar value={data.productCounts.PUBLISHED} max={24} label={`已发布 ${data.productCounts.PUBLISHED}`} />
            <ProgressBar value={data.productCounts.PLANNED} max={24} label={`待策划 ${data.productCounts.PLANNED}`} />
          </div>
        </div>
        <div className="workflow-line">
          {[{ icon: Storefront, label: "商品", value: 24 }, { icon: Robot, label: "内容", value: prepared }, { icon: Clock, label: "排期", value: data.productCounts.READY_TO_PUBLISH }, { icon: Package, label: "交付", value: data.activeOrders }].map(({ icon: Icon, label, value }, index) => <div key={label} className="workflow-node"><span><Icon size={20} /></span><strong>{value}</strong><small>{label}</small>{index < 3 && <i />}</div>)}
        </div>
      </Panel>

      <Panel className="span-4 attention-panel">
        <SectionHeader title="需要你处理" description="高风险状态不会自动越过。" />
        {!data.attention.length ? <EmptyState title="没有强制接管事项" description="系统会继续处理正常流程。" /> : <div className="attention-list">{data.attention.slice(0, 5).map((item) => <article key={`${item.kind}-${item.id}`}><span className={item.kind === "RESULT_UNKNOWN" || item.kind === "REFUND_REVIEW" ? "attention-icon danger" : "attention-icon warning"}>{item.kind === "RESULT_UNKNOWN" || item.kind === "REFUND_REVIEW" ? <WarningCircle weight="fill" /> : <Clock weight="fill" />}</span><div><div><strong>{item.title}</strong><time>{formatTime(item.createdAt)}</time></div><p>{item.reason}</p></div></article>)}</div>}
      </Panel>

      <Panel className="span-7">
        <SectionHeader title="今日工作顺序" description="按阻塞程度排序，避免同时开太多任务。" />
        <ol className="work-order">
          <li className="done"><span><CheckCircle weight="fill" /></span><div><strong>本地基础设施</strong><p>数据库、Worker、模拟连接器与紧急停止已就绪。</p></div><StatusPill tone="success">已就绪</StatusPill></li>
          <li><span>1</span><div><strong>补齐首批商品内容</strong><p>优先完成图片微调、抠图、PPT 和远程排障。</p></div><Link className="text-link" to="/content">去处理</Link></li>
          <li><span>2</span><div><strong>模拟发布与客服</strong><p>批准一条发布动作，再走一遍咨询和议价。</p></div><Link className="text-link" to="/publish">去训练</Link></li>
          <li><span>3</span><div><strong>检查交付包</strong><p>确认 README、许可证声明和校验和齐全。</p></div><Link className="text-link" to="/orders">去检查</Link></li>
        </ol>
      </Panel>
      <Panel className="span-5 safeguard-panel">
        <SectionHeader title="自动化边界" description="正常流程可自动，高风险情形强制停机。" />
        <div className="safeguard-grid"><div><strong>可以自动</strong><p>内容草稿、FAQ 回复、材料追问、正常打包、模拟交付。</p></div><div><strong>必须人工</strong><p>退款、投诉、验证、违规、范围不清、外部结果未知。</p></div></div>
      </Panel>
    </div>
  </div>;
}
