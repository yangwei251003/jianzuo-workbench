import type { ActionStatus } from "@jianzuo/contracts";

export type ConnectorExecution = {
  status: Extract<ActionStatus, "SUCCEEDED" | "FAILED" | "RESULT_UNKNOWN">;
  output: Record<string, unknown>;
};

export interface LocalActionConnector {
  readonly id: "MOCK" | "OFFICIAL_ISV";
  readonly available: boolean;
  execute(actionType: string, payload: Record<string, unknown>): Promise<ConnectorExecution>;
}

/**
 * 可重复的隔离连接器。它只产生模拟外部编号，不访问闲鱼网络。
 */
export class MockConnector implements LocalActionConnector {
  readonly id = "MOCK" as const;
  readonly available = true;

  async execute(actionType: string, payload: Record<string, unknown>): Promise<ConnectorExecution> {
    const completedAt = new Date().toISOString();
    const base = { connector: this.id, completedAt };
    if (actionType === "PUBLISH_LISTING") {
      return payload.simulateUnknown
        ? { status: "RESULT_UNKNOWN", output: { ...base, reason: "模拟：提交后页面断开，无法确认是否发布" } }
        : { status: "SUCCEEDED", output: { ...base, externalId: `MOCK-${Date.now()}`, screenshot: "mock://listing-published" } };
    }
    if (actionType === "SEND_REPLY") {
      return { status: "SUCCEEDED", output: { ...base, conversationId: String(payload.conversationId) } };
    }
    if (actionType === "SEND_DELIVERY") {
      return payload.simulateUnknown
        ? { status: "RESULT_UNKNOWN", output: { ...base, reason: "模拟：提交交付后页面断开，无法确认买家是否收到" } }
        : { status: "SUCCEEDED", output: { ...base, deliveryId: String(payload.deliveryId), orderId: String(payload.orderId) } };
    }
    throw new Error(`MockConnector 不支持动作：${actionType}`);
  }
}

/**
 * 官方 ISV 连接器保留明确的禁用边界。只有未来存在经核验的官方能力时，
 * 才能以新的实现和迁移启用；当前不会回退到私有签名或 Cookie 协议。
 */
export class OfficialIsvConnector implements LocalActionConnector {
  readonly id = "OFFICIAL_ISV" as const;
  readonly available = false;

  async execute(_actionType: string, _payload: Record<string, unknown>): Promise<ConnectorExecution> {
    throw new Error("OfficialIsvConnector 尚未启用；禁止回退到闲鱼私有协议");
  }
}

export function createLocalConnector(id: string): LocalActionConnector {
  if (id === "MOCK") return new MockConnector();
  if (id === "OFFICIAL_ISV") return new OfficialIsvConnector();
  throw new Error(`不允许的本地连接器：${id}`);
}
