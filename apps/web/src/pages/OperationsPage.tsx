import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ClockClockwise, Database, FileText, ListChecks, ShieldWarning } from "@phosphor-icons/react";
import { api, formatTime } from "../api";
import { EmptyState, ErrorState, LoadingState, PageHeader, Panel, StatusPill } from "../components/ui";

type JobsData = { jobs: Array<Record<string, unknown>>; actions: Array<Record<string, unknown>> };

export function OperationsPage() {
  const [tab, setTab] = useState<"actions" | "jobs" | "audit">("actions");
  const jobs = useQuery({ queryKey: ["jobs"], queryFn: async () => (await api<JobsData>("/api/jobs")).data!, refetchInterval: 5_000 });
  const audit = useQuery({ queryKey: ["audit"], queryFn: async () => (await api<Array<Record<string, unknown>>>("/api/audit")).data!, refetchInterval: 8_000 });
  return <div className="page-stack">
    <PageHeader eyebrow="本地运行与维护" title="系统运维" description="查看持久任务、外部动作、未知结果和脱敏审计记录。重启不会丢队列。" />
    <section className="ops-summary"><div><Database /><span><strong>SQLite WAL</strong><small>本地持久化</small></span></div><div><ClockClockwise /><span><strong>租约恢复</strong><small>任务可重试</small></span></div><div><ShieldWarning /><span><strong>结果未知</strong><small>动作不重放</small></span></div><div><FileText /><span><strong>审计 1 年</strong><small>隐私字段脱敏</small></span></div></section>
    <Panel className="flush-panel ops-panel">
      <div className="ops-tabs">{([['actions','Action Outbox'],['jobs','Worker 任务'],['audit','审计记录']] as const).map(([value, label]) => <button key={value} className={tab === value ? "active" : ""} onClick={() => setTab(value)}>{label}</button>)}</div>
      {jobs.isLoading || audit.isLoading ? <LoadingState /> : jobs.error || audit.error ? <ErrorState message={(jobs.error ?? audit.error)?.message ?? "读取失败"} /> : tab === "actions" ? <RecordTable rows={jobs.data?.actions ?? []} columns={["action_type", "connector", "risk", "status", "attempt", "updated_at"]} /> : tab === "jobs" ? <RecordTable rows={jobs.data?.jobs ?? []} columns={["type", "status", "attempt", "max_attempts", "locked_by", "updated_at"]} /> : <RecordTable rows={audit.data ?? []} columns={["event_type", "actor", "summary", "target_type", "created_at"]} />}
    </Panel>
  </div>;
}

function RecordTable({ rows, columns }: { rows: Array<Record<string, unknown>>; columns: string[] }) {
  if (!rows.length) return <EmptyState title="暂无记录" description="任务开始运行后会显示在这里。" />;
  return <div className="table-scroll"><table className="data-table"><thead><tr>{columns.map((column) => <th key={column}>{columnLabel(column)}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={String(row.id ?? row.action_id ?? index)} className={row.status === "RESULT_UNKNOWN" ? "danger-row" : ""}>{columns.map((column) => <td key={column}>{column === "status" ? <StatusPill tone={statusTone(String(row[column]))}>{String(row[column])}</StatusPill> : column.endsWith("_at") ? formatTime(String(row[column] ?? "")) : String(row[column] ?? "—")}</td>)}</tr>)}</tbody></table></div>;
}
function columnLabel(value: string): string { return ({ action_type: "动作", connector: "连接器", risk: "风险", status: "状态", attempt: "尝试", updated_at: "更新时间", type: "任务", max_attempts: "最多尝试", locked_by: "执行者", event_type: "事件", actor: "来源", summary: "摘要", target_type: "对象", created_at: "时间" } as Record<string, string>)[value] ?? value; }
function statusTone(status: string): "neutral" | "success" | "warning" | "danger" | "blue" { return ["SUCCEEDED", "PUBLISHED"].includes(status) ? "success" : ["FAILED", "DEAD_LETTER", "RESULT_UNKNOWN"].includes(status) ? "danger" : ["RUNNING", "EXECUTING"].includes(status) ? "blue" : "warning"; }
