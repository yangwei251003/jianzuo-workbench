export type ResultStatus = "ok" | "needs_user" | "failed";

export type ResultEnvelope<T> = {
  status: ResultStatus;
  summary: string;
  data?: T;
  nextActions: Array<{ type: string; label: string }>;
  artifacts: Array<{ kind: string; path?: string; url?: string }>;
  correlationId: string;
};

export type PriceTierName = "基础" | "标准" | "进阶";

export type PriceTier = {
  name: PriceTierName;
  price: number;
  floorPrice: number;
  revisions: 1 | 2 | 3;
  scope: string;
};

export type MaterialRequirement = {
  id: string;
  label: string;
  required: boolean;
  description: string;
  acceptedTypes?: string[];
};

export type ImageBrief = {
  index: 1 | 2 | 3 | 4 | 5 | 6;
  role: "cover" | "case" | "pricing" | "process" | "materials" | "after_sales";
  title: string;
  brief: string;
  source: "local_template" | "codex_imagegen" | "local_fallback";
};

export type FAQEntry = { question: string; answer: string };
export type DeliveryPlan = {
  mode: "platform_attachment" | "baidu_upload" | "manual_link" | "remote_service";
  packageRequired: boolean;
  checklist: string[];
};

export type ContentBundle = {
  titleCandidates: string[];
  selectedTitle: string;
  description: string;
  priceTiers: PriceTier[];
  materials: MaterialRequirement[];
  imagePlan: [ImageBrief, ImageBrief, ImageBrief, ImageBrief, ImageBrief, ImageBrief];
  faq: FAQEntry[];
  deliveryPlan: DeliveryPlan;
  claims: Array<{ text: string; evidence: string }>;
  complianceFlags: string[];
};

export type ReplyDecision = {
  intent: string;
  confidence: number;
  reply: string;
  evidence: string[];
  missingFields: string[];
  escalate: boolean;
  escalationReason?: string;
};

export type ActionStatus =
  | "PROPOSED"
  | "WAITING_APPROVAL"
  | "APPROVED"
  | "QUEUED"
  | "EXECUTING"
  | "SUCCEEDED"
  | "FAILED"
  | "RESULT_UNKNOWN"
  | "CANCELLED";

export type ActionRequest = {
  actionId: string;
  actionType: string;
  targetId: string;
  risk: "low" | "medium" | "high";
  idempotencyKey: string;
  preconditionFingerprint: string;
  payload: unknown;
  status: ActionStatus;
};

export type AccountStatus =
  | "OFFLINE" | "STARTING" | "WAITING_LOGIN" | "WAITING_CONFIRMATION" | "ONLINE"
  | "VERIFICATION_REQUIRED" | "DEGRADED" | "SESSION_EXPIRED" | "BACKOFF" | "PAUSED" | "ERROR";
export type PublicationStatus =
  | "DRAFT" | "GENERATED" | "REVIEW_READY" | "APPROVED" | "QUEUED" | "EXECUTING" | "PUBLISHED" | "RESULT_UNKNOWN";
export type OrderStatus =
  | "NEW" | "NEEDS_INTAKE" | "READY" | "IN_PROGRESS" | "AWAITING_REVIEW" | "READY_TO_DELIVER"
  | "DELIVERING" | "DELIVERED" | "REFUND_REVIEW";
export type DeliveryStatus =
  | "PREPARING" | "VALIDATING" | "PACKAGED" | "READY" | "SENDING" | "SENT" | "SENT_UNCONFIRMED";
export type JobStatus =
  | "QUEUED" | "RUNNING" | "WAITING_APPROVAL" | "WAITING_USER" | "RETRY_SCHEDULED" | "SUCCEEDED"
  | "FAILED" | "DEAD_LETTER" | "RESULT_UNKNOWN";

export type ProductCategory = "图片" | "工具" | "安装" | "办公" | "前端";
export type Product = {
  id: string;
  accountId: string;
  slug: string;
  category: ProductCategory;
  name: string;
  prices: [number, number, number];
  releaseDay: number;
  readiness: "PLANNED" | "CONTENT_READY" | "READY_TO_PUBLISH" | "PUBLISHED";
  remoteService: boolean;
  createdAt: string;
  updatedAt: string;
};

export type DashboardSnapshot = {
  automationPaused: boolean;
  calibrationStage?: RealCalibrationStage;
  accountStatus: AccountStatus;
  codexStatus: "unavailable" | "signed_out" | "ready" | "busy" | "error";
  browserStatus: "offline" | "pairing" | "online" | "verification_required";
  productCounts: Record<Product["readiness"], number>;
  pendingApprovals: number;
  resultUnknownActions: number;
  pendingJobs: number;
  activeOrders: number;
  todayRevenue: number;
  attention: Array<{ id: string; kind: string; title: string; reason: string; createdAt: string }>;
};

export type BrowserCommand = {
  commandId: string;
  actionType: "INSPECT_PAGE" | "FILL_LISTING" | "SUBMIT_LISTING" | "SEND_REPLY" | "ATTACH_DELIVERY" | "READ_VISIBLE";
  payload: unknown;
  preconditionFingerprint?: string;
  expectedPageUrl?: string;
  expectedTabId?: string;
  expectedPageType?: string;
  expectedAccountLabel?: string;
  expectedAccountFingerprint?: string;
  adapterVersion?: string;
  observedAt?: string;
};

export type BrowserReceipt = {
  commandId: string;
  status: "ok" | "needs_user" | "failed" | "result_unknown";
  pageType: string;
  domFingerprint: string;
  summary: string;
  screenshotDataUrl?: string;
  pageUrl?: string;
  tabId?: string;
  adapterVersion?: string;
  accountLabel?: string;
  accountFingerprint?: string;
  visibleTarget?: VisibleMessageTarget | VisibleOrderTarget;
  visibleSnapshot?: { metrics: Record<string, number>; capturedAt: string };
  actionEvidence?: {
    kind: "new-publication-result-marker" | "new-item-navigation" | "new-reply-result-marker" | "new-matching-outbound-message" | "new-delivery-result-marker" | "order-scoped-delivery-status";
    externalItemId?: string;
    orderId?: string;
  };
  timestamp: string;
};

export type RealCalibrationStage =
  | "LOCKED"
  | "ACCOUNT_CONFIRMED"
  | "DRAFT_FILLED"
  | "SINGLE_PUBLISH_VERIFIED"
  | "MESSAGE_TEST_VERIFIED"
  | "ORDER_TEST_VERIFIED"
  | "PRODUCTION_ENABLED";

export type RealCalibrationState = {
  stage: RealCalibrationStage;
  accountLabel?: string;
  accountFingerprint?: string;
  updatedAt: string;
  evidence: Array<{ step: RealCalibrationStage; at: string; details: Record<string, unknown> }>;
};

/**
 * 浏览器页面中正常可见、可用于唯一锁定一条会话的外部目标。
 * 所有字段均为必填；运行时解析与校验由 @jianzuo/core 负责。
 */
export type VisibleMessageTarget = {
  targetType: "message";
  conversationId: string;
  buyerPublicId: string;
  productId: string;
  pageUrl: string;
  tabId: string;
  accountFingerprint: string;
  domFingerprint: string;
  adapterVersion: string;
  observedAt: string;
};

/**
 * 浏览器页面中正常可见、可用于唯一锁定一笔订单的外部目标。
 * amount 是规范化后的人民币十进制金额，例如 "29.90"，避免浮点数比较。
 */
export type VisibleOrderTarget = {
  targetType: "order";
  conversationId: string;
  buyerPublicId: string;
  productId: string;
  orderId: string;
  amount: string;
  currency: "CNY";
  pageUrl: string;
  tabId: string;
  accountFingerprint: string;
  domFingerprint: string;
  adapterVersion: string;
  observedAt: string;
};

export type MessageTargetBinding = {
  bindingType: "message";
  target: VisibleMessageTarget;
  preconditionFingerprint: string;
};

export type OrderTargetBinding = {
  bindingType: "order";
  target: VisibleOrderTarget;
  preconditionFingerprint: string;
};

export type PlatformBindingFailureCode =
  | "INVALID_SHAPE"
  | "MISSING_FIELD"
  | "EXTRA_FIELD"
  | "RISK_FIELD"
  | "INVALID_FIELD"
  | "INVALID_URL"
  | "STALE_OBSERVATION"
  | "FUTURE_OBSERVATION"
  | "FINGERPRINT_MISMATCH"
  | "TARGET_MISMATCH";

export type PlatformBindingFailure = {
  code: PlatformBindingFailureCode;
  field?: string;
  message: string;
};

export type PlatformBindingValidationResult<Target extends VisibleMessageTarget | VisibleOrderTarget> =
  | {
      valid: true;
      target: Target;
      preconditionFingerprint: string;
    }
  | {
      valid: false;
      errors: PlatformBindingFailure[];
    };

export type PlatformBindingValidationOptions = {
  now?: Date | string | number;
  maxAgeMs?: number;
  futureToleranceMs?: number;
};
