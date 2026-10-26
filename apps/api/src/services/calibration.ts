import type { RealCalibrationStage, RealCalibrationState } from "@jianzuo/contracts";
import type { WorkbenchDatabase } from "@jianzuo/database";

const SETTING_KEY = "real_calibration_state";
// MV3 alarms have a 30-second minimum cadence. Keep enough jitter for a
// healthy extension without allowing an old page snapshot to authorize work.
export const MANAGED_BROWSER_HEARTBEAT_MAX_AGE_MS = 45_000;
const MAX_CLOCK_SKEW_MS = 5_000;
const ORDER: RealCalibrationStage[] = [
  "LOCKED",
  "ACCOUNT_CONFIRMED",
  "DRAFT_FILLED",
  "SINGLE_PUBLISH_VERIFIED",
  "MESSAGE_TEST_VERIFIED",
  "ORDER_TEST_VERIFIED",
  "PRODUCTION_ENABLED"
];

export type BrowserPageBinding = {
  pageType: string;
  pageUrl: string;
  tabId: string;
  adapterVersion: string;
  accountLabel: string;
  accountFingerprint: string;
  accountIdentitySource?: string;
  accountBindingEligible?: boolean;
  domFingerprint: string;
  observedAt: string;
};

export type BrowserBindingRequirement = {
  requiredStage?: RealCalibrationStage;
  expectedPageTypes?: string[];
  expectedBinding?: Partial<BrowserPageBinding>;
  nowMs?: number;
};

export type BrowserBindingCheck =
  | { ok: true; binding: BrowserPageBinding; calibration: RealCalibrationState }
  | { ok: false; reason: string; binding: BrowserPageBinding; calibration: RealCalibrationState };

export function readCalibration(db: WorkbenchDatabase): RealCalibrationState {
  const raw = db.getSetting(SETTING_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as RealCalibrationState;
      if (ORDER.includes(parsed.stage) && Array.isArray(parsed.evidence)) return parsed;
    } catch { /* invalid local setting falls closed */ }
  }
  return { stage: "LOCKED", updatedAt: new Date(0).toISOString(), evidence: [] };
}

export function calibrationAtLeast(db: WorkbenchDatabase, required: RealCalibrationStage): boolean {
  return ORDER.indexOf(readCalibration(db).stage) >= ORDER.indexOf(required);
}

export function readBrowserPageBinding(db: WorkbenchDatabase): BrowserPageBinding {
  const empty: BrowserPageBinding = {
    pageType: "", pageUrl: "", tabId: "", adapterVersion: "", accountLabel: "", accountFingerprint: "", domFingerprint: "", observedAt: ""
  };
  const raw = db.getSetting("browser_page_meta");
  if (!raw) return empty;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const pageUrl = typeof value.pageUrl === "string" ? value.pageUrl : "";
    const parsed = new URL(pageUrl);
    if (parsed.protocol !== "https:" || parsed.hostname !== "www.goofish.com" || parsed.search || parsed.hash) return empty;
    return {
      pageType: clean(value.pageType, 40),
      pageUrl: `${parsed.origin}${parsed.pathname}`,
      tabId: typeof value.tabId === "string" && /^\d+$/.test(value.tabId) ? value.tabId : "",
      adapterVersion: clean(value.adapterVersion, 80),
      accountLabel: clean(value.accountLabel, 40),
      accountFingerprint: typeof value.accountFingerprint === "string" && /^[a-f0-9]{64}$/i.test(value.accountFingerprint)
        ? value.accountFingerprint.toLowerCase()
        : "",
      accountIdentitySource: ["explicit-account-marker", "page-header"].includes(String(value.accountIdentitySource ?? ""))
        ? String(value.accountIdentitySource)
        : "",
      accountBindingEligible: value.accountBindingEligible === true,
      domFingerprint: typeof value.domFingerprint === "string" && /^[a-f0-9]{64}$/i.test(value.domFingerprint)
        ? value.domFingerprint.toLowerCase()
        : "",
      observedAt: clean(value.observedAt, 40)
    };
  } catch {
    return empty;
  }
}

export function validateFreshBrowserObservation(
  db: WorkbenchDatabase,
  requirement: Omit<BrowserBindingRequirement, "requiredStage"> = {}
): BrowserBindingCheck {
  return validateBinding(db, requirement, false);
}

export function validateManagedBrowserBinding(
  db: WorkbenchDatabase,
  requirement: BrowserBindingRequirement = {}
): BrowserBindingCheck {
  return validateBinding(db, requirement, true);
}

export function advanceCalibration(
  db: WorkbenchDatabase,
  step: RealCalibrationStage,
  details: Record<string, unknown> = {}
): RealCalibrationState {
  const current = readCalibration(db);
  const timestamp = new Date().toISOString();
  const currentIndex = ORDER.indexOf(current.stage);
  const requestedIndex = ORDER.indexOf(step);
  const stage = requestedIndex > currentIndex ? step : current.stage;
  const next: RealCalibrationState = {
    ...current,
    stage,
    accountLabel: typeof details.accountLabel === "string" ? clean(details.accountLabel, 40) : current.accountLabel,
    accountFingerprint: typeof details.accountFingerprint === "string" ? clean(details.accountFingerprint, 64) : current.accountFingerprint,
    updatedAt: timestamp,
    evidence: [...current.evidence, { step, at: timestamp, details }].slice(-50)
  };
  db.setSetting(SETTING_KEY, JSON.stringify(next));
  return next;
}

export function resetCalibration(db: WorkbenchDatabase): RealCalibrationState {
  const state: RealCalibrationState = { stage: "LOCKED", updatedAt: new Date().toISOString(), evidence: [] };
  db.setSetting(SETTING_KEY, JSON.stringify(state));
  return state;
}

function validateBinding(db: WorkbenchDatabase, requirement: BrowserBindingRequirement, requireCalibration: boolean): BrowserBindingCheck {
  const binding = readBrowserPageBinding(db);
  const calibration = readCalibration(db);
  const fail = (reason: string): BrowserBindingCheck => ({ ok: false, reason, binding, calibration });
  const nowMs = requirement.nowMs ?? Date.now();
  const runtime = db.getBrowserRuntime();
  const observedAt = Date.parse(binding.observedAt);
  const runtimeHeartbeatAt = Date.parse(String(runtime.last_heartbeat_at ?? ""));

  if (runtime.status !== "online") return fail("浏览器扩展当前不在线，真实动作已停止");
  if (!Number.isFinite(observedAt) || observedAt > nowMs + MAX_CLOCK_SKEW_MS || nowMs - observedAt > MANAGED_BROWSER_HEARTBEAT_MAX_AGE_MS) {
    return fail("页面心跳已超过 45 秒，请回到专用浏览器后重试");
  }
  if (!Number.isFinite(runtimeHeartbeatAt) || runtimeHeartbeatAt > nowMs + MAX_CLOCK_SKEW_MS || nowMs - runtimeHeartbeatAt > MANAGED_BROWSER_HEARTBEAT_MAX_AGE_MS) {
    return fail("浏览器连接心跳已超过 45 秒，真实动作已停止");
  }
  if (!binding.pageUrl || !binding.tabId || !binding.pageType || !binding.adapterVersion || !binding.domFingerprint) {
    return fail("当前页面绑定信息不完整，真实动作已停止");
  }
  if (!binding.accountLabel || !binding.accountFingerprint) return fail("当前页面没有完整的可见账号身份，真实动作已停止");
  if (String(runtime.page_type ?? "") !== binding.pageType || String(runtime.dom_fingerprint ?? "").toLowerCase() !== binding.domFingerprint) {
    return fail("浏览器运行状态与最新页面快照不一致，真实动作已停止");
  }
  if (requirement.expectedPageTypes?.length && !requirement.expectedPageTypes.includes(binding.pageType)) {
    return fail("当前页面类型与动作目标不一致，真实动作已停止");
  }

  if (requireCalibration) {
    const requiredStage = requirement.requiredStage ?? "ACCOUNT_CONFIRMED";
    if (ORDER.indexOf(calibration.stage) < ORDER.indexOf(requiredStage)) return fail("真实账号校准阶段不足，动作未获准");
    if (!calibration.accountLabel || !calibration.accountFingerprint || binding.accountLabel !== calibration.accountLabel || binding.accountFingerprint !== calibration.accountFingerprint) {
      return fail("当前可见账号与已确认账号不一致，真实写操作已暂停");
    }
  }

  const expected = requirement.expectedBinding;
  if (expected) {
    const exactFields: Array<keyof BrowserPageBinding> = [
      "pageType", "pageUrl", "tabId", "adapterVersion", "accountLabel", "accountFingerprint", "domFingerprint"
    ];
    for (const field of exactFields) {
      if (typeof expected[field] === "string" && expected[field] !== binding[field]) {
        return fail(`${bindingFieldLabel(field)}与动作批准时不一致，真实动作已停止`);
      }
    }
  }

  return { ok: true, binding, calibration };
}

function clean(value: unknown, limit: number): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, limit) : "";
}

function bindingFieldLabel(field: keyof BrowserPageBinding): string {
  return ({
    pageType: "页面类型",
    pageUrl: "页面地址",
    tabId: "浏览器标签页",
    adapterVersion: "页面适配器",
    accountLabel: "可见账号",
    accountFingerprint: "账号公开资料指纹",
    accountIdentitySource: "账号身份来源",
    accountBindingEligible: "账号首次绑定资格",
    domFingerprint: "页面结构",
    observedAt: "页面心跳"
  } satisfies Record<keyof BrowserPageBinding, string>)[field];
}
