import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import type { ContentBundle, FAQEntry, ResultEnvelope } from "@jianzuo/contracts";
import { result, validateContentBundle } from "@jianzuo/core";

const MAX_CANDIDATE_BYTES = 64 * 1024;
const ALLOWED_ROOT_KEYS = new Set(["titleCandidates", "selectedTitle", "description", "faq"]);
const ALLOWED_FAQ_KEYS = new Set(["question", "answer"]);
const BANNED_COPY = [
  /一站式解决/iu,
  /赋能/iu,
  /行业领先/iu,
  /百分百满意/iu,
  /纯手工/iu,
  /全网最低/iu,
  /绝对保证/iu,
  /成功案例/iu,
  /真实客户案例/iu,
  /客户好评/iu,
  /官方认证/iu,
  /专业认证/iu,
  /资深(?:设计师|工程师|专家|顾问)/iu,
  /(?:服务|帮助|累计服务)\s*(?:过)?\s*\d+\s*(?:位|名|家)\s*(?:客户|买家|企业)?/iu
];
const EMOJI = /\p{Extended_Pictographic}/u;

export type CodexCopyCandidate = {
  titleCandidates: string[];
  selectedTitle: string;
  description: string;
  faq: FAQEntry[];
};

export type CodexCopyTaskStatus =
  | "RUNNING"
  | "READY_TO_VERIFY"
  | "VERIFIED"
  | "REJECTED"
  | "WAITING_USER"
  | "SUCCEEDED"
  | "FAILED";

export type CodexCopyTask = {
  taskId: string;
  productId: string;
  sourceVersion: number;
  candidatePath: string;
  codexThreadId: string;
  codexTurnId?: string;
  status: CodexCopyTaskStatus;
  createdAt: string;
  updatedAt: string;
  candidateSha256?: string;
  appliedVersion?: number;
  rejectedAt?: string;
  lastError?: string;
};

export type CodexCopyVerificationSuccess = {
  candidate: CodexCopyCandidate;
  bundle: ContentBundle;
  sourceVersion: number;
  candidatePath: string;
  sha256: string;
};

export type CodexCopyVerificationFailure = {
  reason:
    | "NOT_GENERATED"
    | "INVALID_PATH"
    | "INVALID_FILE"
    | "INVALID_JSON"
    | "INVALID_SHAPE"
    | "PRICE_CHANGED"
    | "BANNED_COPY"
    | "UNSUPPORTED_CLAIM"
    | "CONTENT_VALIDATION_FAILED";
  issues: string[];
};

export type CodexCopyVerificationResult = ResultEnvelope<CodexCopyVerificationSuccess | CodexCopyVerificationFailure>;

export type VerifyCodexCopyArtifactInput = {
  candidatesRoot: string;
  candidatePath: string;
  sourceVersion: number;
  sourceBundle: ContentBundle;
};

function fail(reason: CodexCopyVerificationFailure["reason"], summary: string, issues: string[]): CodexCopyVerificationResult {
  const envelope = result("needs_user", summary, { reason, issues } satisfies CodexCopyVerificationFailure);
  envelope.nextActions = [{ type: "KEEP_LOCAL_COPY", label: "继续使用当前本地规则文案" }];
  return envelope;
}

function codePointLength(value: string): number {
  return [...value].length;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeString(value: unknown, label: string, minimum: number, maximum: number, issues: string[]): string | null {
  if (typeof value !== "string") {
    issues.push(`${label}必须是字符串`);
    return null;
  }
  const normalized = value.replace(/\r\n/g, "\n").trim();
  const length = codePointLength(normalized);
  if (length < minimum || length > maximum) issues.push(`${label}长度必须在 ${minimum}–${maximum} 个字符之间`);
  return normalized;
}

function parseCandidate(value: unknown): { candidate?: CodexCopyCandidate; issues: string[] } {
  const issues: string[] = [];
  if (!isPlainRecord(value)) return { issues: ["候选 JSON 顶层必须是对象"] };
  const keys = Object.keys(value);
  const unexpected = keys.filter((key) => !ALLOWED_ROOT_KEYS.has(key));
  const missing = [...ALLOWED_ROOT_KEYS].filter((key) => !(key in value));
  if (unexpected.length) issues.push(`候选包含不允许修改的字段：${unexpected.join("、")}`);
  if (missing.length) issues.push(`候选缺少字段：${missing.join("、")}`);

  const rawTitles = value.titleCandidates;
  const titleCandidates: string[] = [];
  if (!Array.isArray(rawTitles) || rawTitles.length !== 3) {
    issues.push("标题候选必须正好 3 个");
  } else {
    rawTitles.forEach((title, index) => {
      const normalized = normalizeString(title, `标题候选 ${index + 1}`, 4, 60, issues);
      if (normalized !== null) titleCandidates.push(normalized);
    });
    if (new Set(titleCandidates).size !== titleCandidates.length) issues.push("标题候选不能重复");
  }

  const selectedTitle = normalizeString(value.selectedTitle, "选中标题", 4, 60, issues);
  const description = normalizeString(value.description, "商品详情", 80, 4_000, issues);
  if (selectedTitle && !titleCandidates.includes(selectedTitle)) issues.push("选中标题必须来自标题候选");

  const rawFaq = value.faq;
  const faq: FAQEntry[] = [];
  if (!Array.isArray(rawFaq) || rawFaq.length < 2 || rawFaq.length > 8) {
    issues.push("FAQ 必须包含 2–8 项");
  } else {
    rawFaq.forEach((entry, index) => {
      if (!isPlainRecord(entry)) {
        issues.push(`FAQ ${index + 1} 必须是对象`);
        return;
      }
      const unexpectedFaqKeys = Object.keys(entry).filter((key) => !ALLOWED_FAQ_KEYS.has(key));
      if (unexpectedFaqKeys.length) issues.push(`FAQ ${index + 1} 包含不允许的字段：${unexpectedFaqKeys.join("、")}`);
      const question = normalizeString(entry.question, `FAQ ${index + 1} 问题`, 2, 80, issues);
      const answer = normalizeString(entry.answer, `FAQ ${index + 1} 回答`, 2, 300, issues);
      if (question && answer) faq.push({ question, answer });
    });
    if (new Set(faq.map((entry) => entry.question)).size !== faq.length) issues.push("FAQ 问题不能重复");
  }

  if (issues.length || !selectedTitle || !description) return { issues };
  return { candidate: { titleCandidates, selectedTitle, description, faq }, issues };
}

function normalizedClaim(value: string): string {
  return value.replace(/\s+/g, "").toLocaleLowerCase("zh-CN");
}

function candidateText(candidate: CodexCopyCandidate): string {
  return [...candidate.titleCandidates, candidate.selectedTitle, candidate.description, ...candidate.faq.flatMap((entry) => [entry.question, entry.answer])].join("\n");
}

function verifyCandidatePolicy(candidate: CodexCopyCandidate, sourceBundle: ContentBundle): CodexCopyVerificationFailure | null {
  const text = candidateText(candidate);
  if (EMOJI.test(text)) return { reason: "BANNED_COPY", issues: ["文案不能使用 emoji"] };
  const banned = BANNED_COPY.filter((pattern) => pattern.test(text)).map((pattern) => pattern.source);
  if (banned.length) return { reason: "BANNED_COPY", issues: banned.map((pattern) => `文案包含禁用或无依据表达：${pattern}`) };

  const allowedPrices = new Set(sourceBundle.priceTiers.map((tier) => Number(tier.price).toString()));
  const mentionedPrices = [...text.matchAll(/(?<![\d.])(\d+(?:\.\d+)?)\s*元/gu)].map((match) => Number(match[1]).toString());
  const changedPrices = [...new Set(mentionedPrices.filter((price) => !allowedPrices.has(price)))];
  if (changedPrices.length) return { reason: "PRICE_CHANGED", issues: [`候选出现商品价格档以外的金额：${changedPrices.join("、")} 元`] };

  const startingPriceClaim = sourceBundle.claims.find((claim) => /元起/.test(claim.text));
  if (startingPriceClaim && !normalizedClaim(text).includes(normalizedClaim(startingPriceClaim.text))) {
    return { reason: "UNSUPPORTED_CLAIM", issues: [`候选必须保留有证据的起价声明：${startingPriceClaim.text}`] };
  }
  return null;
}

/**
 * Reads and validates a Codex-produced copy candidate. This function never
 * writes the candidate into the official content bundle.
 */
export async function verifyCodexCopyArtifact(input: VerifyCodexCopyArtifactInput): Promise<CodexCopyVerificationResult> {
  const lexicalRoot = resolve(input.candidatesRoot);
  const lexicalCandidate = resolve(input.candidatePath);
  if (lexicalCandidate === lexicalRoot || !lexicalCandidate.startsWith(`${lexicalRoot}${sep}`)) {
    return fail("INVALID_PATH", "候选文案不在允许目录内，已停止接收", ["候选路径越过受控根目录"]);
  }
  if (!existsSync(lexicalCandidate)) {
    return fail("NOT_GENERATED", "尚未找到 Codex 候选文案，当前规则版保持不变", ["候选 JSON 文件不存在"]);
  }

  let realRoot: string;
  let realCandidate: string;
  try {
    realRoot = realpathSync(lexicalRoot);
    realCandidate = realpathSync(lexicalCandidate);
  } catch {
    return fail("INVALID_PATH", "候选文案路径无法验真，已停止接收", ["候选目录或文件无法解析为真实路径"]);
  }
  if (realCandidate === realRoot || !realCandidate.startsWith(`${realRoot}${sep}`)) {
    return fail("INVALID_PATH", "候选文案真实路径越过允许目录，已停止接收", ["候选文件可能通过链接指向目录外"]);
  }
  if (extname(realCandidate).toLowerCase() !== ".json") {
    return fail("INVALID_FILE", "候选文案文件格式不正确，已停止接收", ["候选文件必须使用 .json 扩展名"]);
  }

  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(realCandidate);
  } catch {
    return fail("INVALID_FILE", "候选文案文件无法读取，已停止接收", ["无法读取候选文件状态"]);
  }
  if (!stats.isFile() || stats.size < 2 || stats.size > MAX_CANDIDATE_BYTES) {
    return fail("INVALID_FILE", "候选文案文件大小或类型不正确，已停止接收", [`JSON 文件必须在 2–${MAX_CANDIDATE_BYTES} 字节之间`]);
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(realCandidate);
  } catch {
    return fail("INVALID_FILE", "候选文案文件无法读取，已停止接收", ["读取候选 JSON 失败"]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, "")) as unknown;
  } catch {
    return fail("INVALID_JSON", "候选文案不是有效 JSON，当前规则版保持不变", ["无法解析候选 JSON"]);
  }

  const parsedCandidate = parseCandidate(parsed);
  if (!parsedCandidate.candidate) {
    return fail("INVALID_SHAPE", "候选文案结构没有通过检查，当前规则版保持不变", parsedCandidate.issues);
  }
  const policyFailure = verifyCandidatePolicy(parsedCandidate.candidate, input.sourceBundle);
  if (policyFailure) return fail(policyFailure.reason, "候选文案没有通过价格、禁词或事实检查，当前规则版保持不变", policyFailure.issues);

  const bundle: ContentBundle = {
    ...input.sourceBundle,
    titleCandidates: parsedCandidate.candidate.titleCandidates,
    selectedTitle: parsedCandidate.candidate.selectedTitle,
    description: parsedCandidate.candidate.description,
    faq: parsedCandidate.candidate.faq
  };
  const validationIssues = validateContentBundle(bundle);
  if (validationIssues.length) {
    return fail("CONTENT_VALIDATION_FAILED", "候选文案与现有商品规则不一致，当前规则版保持不变", validationIssues);
  }

  const data: CodexCopyVerificationSuccess = {
    candidate: parsedCandidate.candidate,
    bundle,
    sourceVersion: input.sourceVersion,
    candidatePath: realCandidate,
    sha256: createHash("sha256").update(bytes).digest("hex")
  };
  const envelope = result("ok", "Codex 候选文案已通过独立验真，尚未应用", data);
  envelope.artifacts = [{ kind: "codex_copy_candidate", path: realCandidate }];
  envelope.nextActions = [{ type: "REVIEW_AND_APPLY", label: "人工核对后应用为新版本" }];
  return envelope;
}
