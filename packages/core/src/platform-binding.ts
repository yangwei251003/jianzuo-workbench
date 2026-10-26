import { createHash } from "node:crypto";
import type {
  MessageTargetBinding,
  OrderTargetBinding,
  PlatformBindingFailure,
  PlatformBindingFailureCode,
  PlatformBindingValidationOptions,
  PlatformBindingValidationResult,
  VisibleMessageTarget,
  VisibleOrderTarget
} from "@jianzuo/contracts";

export const PLATFORM_BINDING_MAX_AGE_MS = 45_000;
export const PLATFORM_BINDING_FUTURE_TOLERANCE_MS = 5_000;

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const MESSAGE_TARGET_KEYS = [
  "targetType", "conversationId", "buyerPublicId", "productId", "pageUrl", "tabId",
  "accountFingerprint", "domFingerprint", "adapterVersion", "observedAt"
] as const;
const ORDER_TARGET_KEYS = [
  "targetType", "conversationId", "buyerPublicId", "productId", "orderId", "amount", "currency",
  "pageUrl", "tabId", "accountFingerprint", "domFingerprint", "adapterVersion", "observedAt"
] as const;
const BINDING_KEYS = ["bindingType", "target", "preconditionFingerprint"] as const;
const RISK_KEY_FRAGMENTS = [
  "cookie", "token", "authorization", "password", "credential", "sessionsecret", "csrf",
  "verificationcode", "remotecode"
] as const;

type PlatformTarget = VisibleMessageTarget | VisibleOrderTarget;

class PlatformBindingInputError extends Error {
  constructor(
    readonly code: PlatformBindingFailureCode,
    readonly field: string | undefined,
    message: string
  ) {
    super(message);
    this.name = "PlatformBindingInputError";
  }
}

function fail(code: PlatformBindingFailureCode, field: string | undefined, message: string): never {
  throw new PlatformBindingInputError(code, field, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedRiskKey(key: string): string {
  return key.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function assertNoRiskFields(value: unknown, path = "target"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoRiskFields(entry, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    const normalized = normalizedRiskKey(key);
    if (RISK_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment))) {
      fail("RISK_FIELD", `${path}.${key}`, "目标绑定中不得包含 Cookie、Token、凭据或验证码字段");
    }
    assertNoRiskFields(entry, `${path}.${key}`);
  }
}

function assertExactKeys(value: unknown, expectedKeys: readonly string[], path: string): Record<string, unknown> {
  if (!isRecord(value)) fail("INVALID_SHAPE", path, `${path} 必须是对象`);
  const expected = new Set(expectedKeys);
  for (const key of expectedKeys) {
    if (!Object.hasOwn(value, key)) fail("MISSING_FIELD", `${path}.${key}`, `缺少必填字段 ${key}`);
  }
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) fail("EXTRA_FIELD", `${path}.${key}`, `不允许额外字段 ${key}`);
  }
  return value;
}

function normalizeText(value: unknown, field: string, maxLength = 256, collapseWhitespace = false): string {
  if (typeof value !== "string") fail("INVALID_FIELD", field, `${field} 必须是字符串`);
  let normalized = value.normalize("NFKC").trim();
  if (collapseWhitespace) normalized = normalized.replace(/\s+/g, " ");
  if (!normalized) fail("INVALID_FIELD", field, `${field} 不能为空`);
  if (normalized.length > maxLength) fail("INVALID_FIELD", field, `${field} 超过长度限制`);
  if (/[\u0000-\u001f\u007f]/.test(normalized)) fail("INVALID_FIELD", field, `${field} 包含控制字符`);
  return normalized;
}

function normalizeFingerprint(value: unknown, field: string): string {
  const normalized = normalizeText(value, field, 64).toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) fail("INVALID_FIELD", field, `${field} 必须是 64 位 SHA-256 十六进制值`);
  return normalized;
}

function isRiskQueryKey(key: string): boolean {
  const normalized = normalizedRiskKey(key);
  return RISK_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

/** 规范化可见页面地址：仅接受 goofish.com HTTPS 页面，并移除普通查询参数与片段。 */
export function normalizePlatformPageUrl(value: unknown): string {
  const raw = normalizeText(value, "target.pageUrl", 2_048);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail("INVALID_URL", "target.pageUrl", "页面 URL 无效");
  }
  if (url.protocol !== "https:") fail("INVALID_URL", "target.pageUrl", "页面 URL 必须使用 HTTPS");
  if (url.username || url.password) fail("RISK_FIELD", "target.pageUrl", "页面 URL 不得包含凭据");
  const hostname = url.hostname.toLowerCase();
  if (hostname !== "goofish.com" && !hostname.endsWith(".goofish.com")) {
    fail("INVALID_URL", "target.pageUrl", "页面 URL 必须属于 goofish.com");
  }
  for (const key of url.searchParams.keys()) {
    if (isRiskQueryKey(key)) fail("RISK_FIELD", `target.pageUrl?${key}`, "页面 URL 不得包含 Cookie、Token 或凭据参数");
  }
  if (/(?:^|[#&?])(cookie|[^=&]*(?:token|authorization|password|credential|csrf)[^=&]*)=/i.test(url.hash)) {
    fail("RISK_FIELD", "target.pageUrl#", "页面 URL 片段不得包含 Cookie、Token 或凭据参数");
  }
  url.search = "";
  url.hash = "";
  url.hostname = hostname;
  url.pathname = url.pathname.replace(/\/{2,}/g, "/");
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

function normalizeObservedAt(value: unknown): string {
  const raw = normalizeText(value, "target.observedAt", 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/i.test(raw)) {
    fail("INVALID_FIELD", "target.observedAt", "观测时间必须是带时区的 ISO 日期时间");
  }
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) fail("INVALID_FIELD", "target.observedAt", "观测时间必须是有效的 ISO 日期时间");
  return new Date(timestamp).toISOString();
}

function normalizeTabId(value: unknown): string {
  const tabId = normalizeText(value, "target.tabId", 20);
  if (!/^\d+$/.test(tabId)) fail("INVALID_FIELD", "target.tabId", "标签页 ID 必须是数字字符串");
  const normalized = BigInt(tabId);
  if (normalized <= 0n) fail("INVALID_FIELD", "target.tabId", "标签页 ID 必须大于零");
  return String(normalized);
}

export function normalizePlatformAmount(value: unknown): string {
  const raw = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  if (typeof raw !== "string") fail("INVALID_FIELD", "target.amount", "订单金额必须是数字或字符串");
  const match = raw.normalize("NFKC").trim().replace(/,/g, "")
    .match(/^(?:¥|￥)?\s*(\d{1,12})(?:\.(\d{1,2}))?\s*(?:元|CNY)?$/i);
  if (!match) fail("INVALID_FIELD", "target.amount", "订单金额格式无效");
  const yuan = BigInt(match[1]!);
  const cents = BigInt((match[2] ?? "").padEnd(2, "0"));
  const totalCents = yuan * 100n + cents;
  if (totalCents <= 0n || totalCents > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail("INVALID_FIELD", "target.amount", "订单金额必须大于零且在安全范围内");
  }
  return `${yuan}.${cents.toString().padStart(2, "0")}`;
}

export function platformAmountToCents(value: unknown): number {
  const [yuan, cents] = normalizePlatformAmount(value).split(".");
  return Number(BigInt(yuan!) * 100n + BigInt(cents!));
}

function normalizeCommonTarget(record: Record<string, unknown>) {
  return {
    conversationId: normalizeText(record.conversationId, "target.conversationId"),
    buyerPublicId: normalizeText(record.buyerPublicId, "target.buyerPublicId", 256, true),
    productId: normalizeText(record.productId, "target.productId"),
    pageUrl: normalizePlatformPageUrl(record.pageUrl),
    tabId: normalizeTabId(record.tabId),
    accountFingerprint: normalizeFingerprint(record.accountFingerprint, "target.accountFingerprint"),
    domFingerprint: normalizeFingerprint(record.domFingerprint, "target.domFingerprint"),
    adapterVersion: normalizeText(record.adapterVersion, "target.adapterVersion", 64),
    observedAt: normalizeObservedAt(record.observedAt)
  };
}

export function normalizeMessageTarget(value: unknown): VisibleMessageTarget {
  assertNoRiskFields(value);
  const record = assertExactKeys(value, MESSAGE_TARGET_KEYS, "target");
  if (record.targetType !== "message") fail("INVALID_FIELD", "target.targetType", "消息目标类型必须是 message");
  return { targetType: "message", ...normalizeCommonTarget(record) };
}

export function normalizeOrderTarget(value: unknown): VisibleOrderTarget {
  assertNoRiskFields(value);
  const record = assertExactKeys(value, ORDER_TARGET_KEYS, "target");
  if (record.targetType !== "order") fail("INVALID_FIELD", "target.targetType", "订单目标类型必须是 order");
  if (record.currency !== "CNY") fail("INVALID_FIELD", "target.currency", "订单币种必须是 CNY");
  return {
    targetType: "order",
    ...normalizeCommonTarget(record),
    orderId: normalizeText(record.orderId, "target.orderId"),
    amount: normalizePlatformAmount(record.amount),
    currency: "CNY"
  };
}

function fingerprintPayload(target: PlatformTarget): Record<string, string> {
  const common = {
    targetType: target.targetType,
    conversationId: target.conversationId,
    buyerPublicId: target.buyerPublicId,
    productId: target.productId,
    pageUrl: target.pageUrl,
    tabId: target.tabId,
    accountFingerprint: target.accountFingerprint,
    adapterVersion: target.adapterVersion
  };
  return target.targetType === "message"
    ? common
    : { ...common, orderId: target.orderId, amount: target.amount, currency: target.currency };
}

/**
 * 计算动作前置指纹。observedAt 只用于新鲜度校验，不参与哈希，因而允许同一页面的后续心跳续期。
 */
export function createPlatformPreconditionFingerprint(value: unknown): string {
  if (!isRecord(value)) fail("INVALID_SHAPE", "target", "target 必须是对象");
  const target = value.targetType === "message" ? normalizeMessageTarget(value) : value.targetType === "order" ? normalizeOrderTarget(value) :
    fail("INVALID_FIELD", "target.targetType", "目标类型必须是 message 或 order");
  return createHash("sha256").update(JSON.stringify(fingerprintPayload(target)), "utf8").digest("hex");
}

export function createMessageTargetBinding(value: unknown): MessageTargetBinding {
  const target = normalizeMessageTarget(value);
  return { bindingType: "message", target, preconditionFingerprint: createPlatformPreconditionFingerprint(target) };
}

export function createOrderTargetBinding(value: unknown): OrderTargetBinding {
  const target = normalizeOrderTarget(value);
  return { bindingType: "order", target, preconditionFingerprint: createPlatformPreconditionFingerprint(target) };
}

function normalizeNow(value: PlatformBindingValidationOptions["now"]): number {
  const timestamp = value === undefined ? Date.now() : value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error("验证时钟无效");
  return timestamp;
}

function validateFreshness(target: PlatformTarget, options: PlatformBindingValidationOptions): PlatformBindingFailure[] {
  const now = normalizeNow(options.now);
  const maxAgeMs = options.maxAgeMs ?? PLATFORM_BINDING_MAX_AGE_MS;
  const futureToleranceMs = options.futureToleranceMs ?? PLATFORM_BINDING_FUTURE_TOLERANCE_MS;
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0 || !Number.isFinite(futureToleranceMs) || futureToleranceMs < 0) {
    throw new Error("绑定时效参数无效");
  }
  const observedAt = Date.parse(target.observedAt);
  if (observedAt > now + futureToleranceMs) {
    return [{ code: "FUTURE_OBSERVATION", field: "target.observedAt", message: "目标观测时间超出允许的未来偏差" }];
  }
  if (now - observedAt > maxAgeMs) {
    return [{ code: "STALE_OBSERVATION", field: "target.observedAt", message: "目标页面心跳已过期，必须重新观测" }];
  }
  return [];
}

function mismatchFailures(expected: PlatformTarget, observed: PlatformTarget): PlatformBindingFailure[] {
  // observedAt is refreshed by heartbeats. domFingerprint is deliberately
  // checked by the separate page-binding gate immediately before a write; the
  // write itself changes the DOM, so receipt identity validation must not treat
  // that expected post-write change as a different buyer/order target.
  const ignored = new Set(["observedAt", "domFingerprint"]);
  const failures: PlatformBindingFailure[] = [];
  for (const key of Object.keys(expected) as Array<keyof PlatformTarget>) {
    if (ignored.has(String(key))) continue;
    if (expected[key] !== observed[key]) {
      failures.push({ code: "TARGET_MISMATCH", field: `target.${String(key)}`, message: `外部目标字段 ${String(key)} 与已确认绑定不一致` });
    }
  }
  return failures;
}

function toFailure(error: unknown): PlatformBindingFailure {
  if (error instanceof PlatformBindingInputError) return { code: error.code, field: error.field, message: error.message };
  return { code: "INVALID_SHAPE", message: error instanceof Error ? error.message : "目标绑定无效" };
}

function validateBinding<Target extends PlatformTarget>(
  bindingValue: unknown,
  observedValue: unknown,
  bindingType: "message" | "order",
  normalizeTarget: (value: unknown) => Target,
  options: PlatformBindingValidationOptions
): PlatformBindingValidationResult<Target> {
  try {
    assertNoRiskFields(bindingValue, "binding");
    const binding = assertExactKeys(bindingValue, BINDING_KEYS, "binding");
    if (binding.bindingType !== bindingType) fail("INVALID_FIELD", "binding.bindingType", `绑定类型必须是 ${bindingType}`);
    const expected = normalizeTarget(binding.target);
    const suppliedFingerprint = normalizeFingerprint(binding.preconditionFingerprint, "binding.preconditionFingerprint");
    const expectedFingerprint = createPlatformPreconditionFingerprint(expected);
    if (suppliedFingerprint !== expectedFingerprint) {
      return { valid: false, errors: [{ code: "FINGERPRINT_MISMATCH", field: "binding.preconditionFingerprint", message: "绑定前置指纹与已确认目标不一致" }] };
    }

    const observed = normalizeTarget(observedValue);
    const errors = [
      ...validateFreshness(observed, options),
      ...mismatchFailures(expected, observed)
    ];
    const observedFingerprint = createPlatformPreconditionFingerprint(observed);
    if (observedFingerprint !== suppliedFingerprint && !errors.some((entry) => entry.code === "TARGET_MISMATCH")) {
      errors.push({ code: "FINGERPRINT_MISMATCH", field: "target", message: "当前页面前置指纹与已确认绑定不一致" });
    }
    return errors.length > 0
      ? { valid: false, errors }
      : { valid: true, target: observed, preconditionFingerprint: observedFingerprint };
  } catch (error) {
    return { valid: false, errors: [toFailure(error)] };
  }
}

export function validateMessageTargetBinding(
  binding: unknown,
  observed: unknown,
  options: PlatformBindingValidationOptions = {}
): PlatformBindingValidationResult<VisibleMessageTarget> {
  return validateBinding(binding, observed, "message", normalizeMessageTarget, options);
}

export function validateOrderTargetBinding(
  binding: unknown,
  observed: unknown,
  options: PlatformBindingValidationOptions = {}
): PlatformBindingValidationResult<VisibleOrderTarget> {
  return validateBinding(binding, observed, "order", normalizeOrderTarget, options);
}
