import type { ActionRequest, FAQEntry, PriceTier, Product, ReplyDecision } from "@jianzuo/contracts";

export const PRICE_FLOOR_RATIO = 0.9;
export const URGENT_MULTIPLIERS = { next_day: 1.3, same_day: 1.5, four_hours: 1.8 } as const;

export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function floorPrice(listPrice: number): number {
  return roundMoney(listPrice * PRICE_FLOOR_RATIO);
}

export function negotiatePrice(listPrice: number, discountPercent: number): number {
  const clamped = Math.max(0, Math.min(10, discountPercent));
  return Math.max(floorPrice(listPrice), roundMoney(listPrice * (1 - clamped / 100)));
}

export function urgentPrice(listPrice: number, urgency: keyof typeof URGENT_MULTIPLIERS, enabled: boolean): number {
  return enabled ? roundMoney(listPrice * URGENT_MULTIPLIERS[urgency]) : listPrice;
}

const HARD_HANDOFFS: Array<{ pattern: RegExp; reason: string; intent: string }> = [
  { pattern: /退款|退钱|仅退款|退货|取消订单|撤销订单/, reason: "退款或取消订单必须由人工执行", intent: "refund" },
  { pattern: /投诉|举报|起诉|律师|报警|消费者协会|12315/, reason: "投诉或法律威胁必须人工接管", intent: "complaint" },
  { pattern: /验证码|短信码|动态码|滑块|人脸|扫脸|实名验证|登录验证|安全验证/, reason: "账号或身份验证需要人工处理", intent: "verification" },
  { pattern: /破解|盗版|免激活|非法代理|翻墙|伪造|假证|代写凭证|外挂|刷单|套现|绕过验证|规避风控/, reason: "需求可能违规，已暂停处理", intent: "prohibited" },
  { pattern: /范围不清|需求不清|价格不清|预算不清|没想好|你看着办|随便做/, reason: "范围或价格不清，需要人工确认后再报价", intent: "unclear_scope" },
  { pattern: /去水印/, reason: "需先核验图片权利与授权范围", intent: "rights_check" }
];

function matchHardHandoff(value: string): (typeof HARD_HANDOFFS)[number] | undefined {
  return HARD_HANDOFFS.find((entry) => entry.pattern.test(value));
}

export function hardHandoffReason(value: string): string | null {
  return matchHardHandoff(value)?.reason ?? null;
}

export type ReplyContext = {
  productName: string;
  tiers: PriceTier[];
  message: string;
  faq?: FAQEntry[];
  knownFields?: string[];
  manualAvailable?: boolean;
};

export function decideReply(context: ReplyContext): ReplyDecision {
  const normalized = context.message.trim();
  const handoff = matchHardHandoff(normalized);
  if (handoff) {
    return {
      intent: handoff.intent,
      confidence: 0.99,
      reply: "这件事需要人工确认。我已经记下，会在人工接管时间内继续处理。",
      evidence: [handoff.reason],
      missingFields: [],
      escalate: true,
      escalationReason: handoff.reason
    };
  }

  if (/便宜|优惠|少点|最低|砍价/.test(normalized)) {
    const base = context.tiers[0];
    const offer = negotiatePrice(base?.price ?? 0, 10);
    return {
      intent: "bargain",
      confidence: 0.93,
      reply: `可以按材料量确认。基础档标价 ${base?.price ?? 0} 元，范围不变时最低可以到 ${offer} 元；如果工作量超出基础档，需要重新看材料。`,
      evidence: ["优惠不超过 10%", "最低成交价为标价的 90%"],
      missingFields: ["材料或样例", "期望完成时间"],
      escalate: false
    };
  }

  if (/多久|什么时候|急|今天|四小时|明天/.test(normalized)) {
    return {
      intent: "deadline",
      confidence: 0.9,
      reply: "先把材料和期望完成时间发来。我看完工作量后确认是否能接；加急只有人工开启时才报价，不会先承诺。",
      evidence: ["复杂订单按材料完整度估价", "加急需人工开启"],
      missingFields: ["完整材料", "期望完成时间"],
      escalate: false
    };
  }

  const faqMatch = findUnambiguousFaq(normalized, context.faq ?? []);
  if (faqMatch) {
    const faqRisk = matchHardHandoff(`${faqMatch.entry.question}\n${faqMatch.entry.answer}`);
    if (faqRisk) {
      return {
        intent: faqRisk.intent,
        confidence: 0.99,
        reply: "这件事需要人工确认。我已经记下，会在人工接管时间内继续处理。",
        evidence: [faqRisk.reason],
        missingFields: [],
        escalate: true,
        escalationReason: faqRisk.reason
      };
    }
    return {
      intent: "faq",
      confidence: faqMatch.exact ? 0.97 : 0.9,
      reply: faqMatch.entry.answer,
      evidence: [`命中当前商品已校验 FAQ：${faqMatch.entry.question}`],
      missingFields: [],
      escalate: false
    };
  }

  return {
    intent: "intake",
    confidence: 0.82,
    reply: `可以先看 ${context.productName} 的材料。请发一份原文件或样例、希望改成什么样、使用场景和期望完成时间，我看完再确认档位。`,
    evidence: ["先核对材料，再确认范围和价格"],
    missingFields: ["原文件或样例", "具体目标", "使用场景", "期望完成时间"],
    escalate: false
  };
}

function findUnambiguousFaq(message: string, faq: FAQEntry[]): { entry: FAQEntry; exact: boolean } | null {
  const query = normalizeFaqQuestion(message);
  if (query.length < 4) return null;
  const candidates = faq.filter((entry) => normalizeFaqQuestion(entry.question) === query);
  const answers = new Set(candidates.map((entry) => entry.answer.trim()));
  return candidates.length > 0 && answers.size === 1 ? { entry: candidates[0]!, exact: true } : null;
}

export function normalizeFaqQuestion(value: string): string {
  return value.normalize("NFKC").toLowerCase().trim().replace(/\s+/gu, "").replace(/[?？]+$/gu, "");
}

export type PolicyDecision = { allowed: boolean; requiresApproval: boolean; reason: string; risk: ActionRequest["risk"] };

function policyInputText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  return ["buyerText", "buyerMessage", "requestText", "policyText", "escalationReason"]
    .map((key) => record[key])
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}

export function evaluateAction(actionType: string, payload: unknown, automationPaused: boolean): PolicyDecision {
  // Only scan explicitly identified, untrusted request text. Generated descriptions and
  // compliance notices legitimately contain refusal words such as “侵权去水印”; scanning
  // the whole action payload would turn those safeguards into false-positive blockers.
  const untrustedText = policyInputText(payload).toLowerCase();
  if (automationPaused) return { allowed: false, requiresApproval: true, reason: "全局紧急停止已开启", risk: "high" };
  if (/refund/i.test(actionType)) return { allowed: false, requiresApproval: true, reason: "退款永远由人工执行", risk: "high" };
  if (/投诉|举报|起诉|律师|验证码|短信码|动态码|滑块|人脸|破解|盗版|伪造|外挂|刷单|套现|绕过验证|规避风控|范围不清|需求不清|价格不清|预算不清|没想好|你看着办|随便做/.test(untrustedText)) {
    return { allowed: false, requiresApproval: true, reason: "命中强制人工接管规则", risk: "high" };
  }
  if (actionType === "FILL_LISTING") {
    return { allowed: true, requiresApproval: true, reason: "真实页面草稿填充需要当次审批，且不会提交", risk: "medium" };
  }
  if (["PUBLISH_LISTING", "SEND_DELIVERY"].includes(actionType)) {
    return { allowed: true, requiresApproval: true, reason: "训练期外部写操作需要审批", risk: "high" };
  }
  if (actionType === "SEND_REPLY") return { allowed: true, requiresApproval: false, reason: "回复已通过规则检查", risk: "medium" };
  return { allowed: true, requiresApproval: false, reason: "低风险本地动作", risk: "low" };
}

export function licenseCanPublish(license: string | null | undefined): { allowed: boolean; reason: string } {
  const value = (license ?? "").trim().toUpperCase();
  if (!value) return { allowed: false, reason: "缺少许可证" };
  if (value === "ORIGINAL-DEPENDENCIES-REVIEWED") {
    return { allowed: true, reason: "已确认自有原创内容，并已核对第三方依赖与素材声明" };
  }
  if (value.includes("AGPL") || /NON[-_\s]?COMMERCIAL/.test(value) || /(^|[-_\s])NC([-. _]|$)/.test(value)) {
    return { allowed: false, reason: "许可证不允许当前商业发布路径" };
  }
  if (["MIT", "APACHE-2.0", "BSD-2-CLAUSE", "BSD-3-CLAUSE"].includes(value)) {
    return { allowed: true, reason: "可在保留声明并核验依赖后发布" };
  }
  if (value.includes("GPL")) return { allowed: false, reason: "需先完成 GPL 源码与分发义务评审" };
  return { allowed: false, reason: "未知许可证，默认阻止发布" };
}

export function productNeedsLicenseReview(product: Pick<Product, "category">): boolean {
  return product.category === "工具" || product.category === "前端";
}
