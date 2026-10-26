export type InboxAction = Record<string, unknown> & {
  action_id?: unknown;
  action_type?: unknown;
  connector?: unknown;
  payload_json?: unknown;
  status?: unknown;
  target_id?: unknown;
};

export function pendingReplyApprovals(actions: InboxAction[] | undefined, conversationId: string): InboxAction[] {
  if (!conversationId) return [];
  return (actions ?? []).filter((action) =>
    action.action_type === "SEND_REPLY"
    && action.connector === "MANAGED_BROWSER"
    && action.status === "WAITING_APPROVAL"
    && action.target_id === conversationId
    && typeof action.action_id === "string"
    && action.action_id.length > 0
  );
}

export function pendingReplyBody(action: InboxAction): string {
  if (typeof action.payload_json !== "string") return "回复内容无法预览，请返回输入框重新准备。";
  try {
    const payload = JSON.parse(action.payload_json) as { body?: unknown };
    return typeof payload.body === "string" && payload.body.trim()
      ? payload.body.trim()
      : "回复内容无法预览，请返回输入框重新准备。";
  } catch {
    return "回复内容无法预览，请返回输入框重新准备。";
  }
}
