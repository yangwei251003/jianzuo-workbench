export type PublishConnector = "MOCK" | "MANAGED_BROWSER" | string;

const STATUS_LABELS: Record<string, string> = {
  DRAFT: "草稿",
  REVIEW_READY: "草稿待检查",
  APPROVED: "已批准",
  QUEUED: "队列中",
  EXECUTING: "执行中",
  PUBLISHED: "已发布",
  WAITING_APPROVAL: "待审批",
  SUCCEEDED: "成功",
  RESULT_UNKNOWN: "结果未知",
  FAILED: "失败"
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

export function publishActionLabel(type: string, status: string, connector: PublishConnector): string {
  const prefix = type === "FILL_LISTING"
    ? "填草稿"
    : type === "PUBLISH_LISTING"
      ? connector === "MOCK" ? "模拟提交" : "真实提交"
      : "动作";
  return `${prefix} · ${statusLabel(status)}`;
}

export function publishApprovalLabel(type: string, connector: PublishConnector): string {
  if (type === "FILL_LISTING") return "批准填草稿";
  return connector === "MOCK" ? "批准模拟发布" : "批准真实发布";
}

export function codexAccountTitle(account: Record<string, unknown> | null): string {
  if (!account) return "尚未读取账号";
  const nested = account.account as Record<string, unknown> | undefined;
  const planType = typeof nested?.planType === "string" ? nested.planType.trim() : "";
  return planType ? `ChatGPT ${planType}` : "ChatGPT 账号已连接";
}

