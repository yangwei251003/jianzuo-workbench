import type { AccountStatus, DeliveryStatus, JobStatus, OrderStatus, PublicationStatus } from "@jianzuo/contracts";

const PUBLICATION: Record<PublicationStatus, PublicationStatus[]> = {
  DRAFT: ["GENERATED"], GENERATED: ["REVIEW_READY"], REVIEW_READY: ["APPROVED", "DRAFT"],
  APPROVED: ["QUEUED"], QUEUED: ["EXECUTING"], EXECUTING: ["PUBLISHED", "RESULT_UNKNOWN"],
  PUBLISHED: [], RESULT_UNKNOWN: []
};
const ORDER: Record<OrderStatus, OrderStatus[]> = {
  NEW: ["NEEDS_INTAKE", "REFUND_REVIEW"], NEEDS_INTAKE: ["READY", "REFUND_REVIEW"],
  READY: ["IN_PROGRESS", "REFUND_REVIEW"], IN_PROGRESS: ["AWAITING_REVIEW", "REFUND_REVIEW"],
  AWAITING_REVIEW: ["IN_PROGRESS", "READY_TO_DELIVER", "REFUND_REVIEW"], READY_TO_DELIVER: ["DELIVERING", "REFUND_REVIEW"],
  DELIVERING: ["DELIVERED", "REFUND_REVIEW"], DELIVERED: ["REFUND_REVIEW"], REFUND_REVIEW: []
};
const DELIVERY: Record<DeliveryStatus, DeliveryStatus[]> = {
  PREPARING: ["VALIDATING"], VALIDATING: ["PACKAGED"], PACKAGED: ["READY"], READY: ["SENDING"],
  SENDING: ["SENT", "SENT_UNCONFIRMED"], SENT: [], SENT_UNCONFIRMED: []
};
const ACCOUNT: Record<AccountStatus, AccountStatus[]> = {
  OFFLINE: ["STARTING"], STARTING: ["WAITING_LOGIN", "ERROR"], WAITING_LOGIN: ["WAITING_CONFIRMATION", "VERIFICATION_REQUIRED", "OFFLINE"],
  WAITING_CONFIRMATION: ["ONLINE", "VERIFICATION_REQUIRED", "ERROR"], ONLINE: ["DEGRADED", "SESSION_EXPIRED", "PAUSED", "OFFLINE"],
  VERIFICATION_REQUIRED: ["WAITING_CONFIRMATION", "PAUSED", "OFFLINE"], DEGRADED: ["BACKOFF", "ONLINE", "PAUSED"],
  SESSION_EXPIRED: ["WAITING_LOGIN", "OFFLINE"], BACKOFF: ["STARTING", "PAUSED"], PAUSED: ["STARTING", "OFFLINE"], ERROR: ["STARTING", "OFFLINE"]
};

export function canTransition<T extends string>(map: Record<T, T[]>, from: T, to: T): boolean {
  return map[from]?.includes(to) ?? false;
}

export const stateMachine = {
  publication: (from: PublicationStatus, to: PublicationStatus) => canTransition(PUBLICATION, from, to),
  order: (from: OrderStatus, to: OrderStatus) => canTransition(ORDER, from, to),
  delivery: (from: DeliveryStatus, to: DeliveryStatus) => canTransition(DELIVERY, from, to),
  account: (from: AccountStatus, to: AccountStatus) => canTransition(ACCOUNT, from, to),
  jobTerminal: (status: JobStatus) => ["SUCCEEDED", "FAILED", "DEAD_LETTER", "RESULT_UNKNOWN"].includes(status)
};

