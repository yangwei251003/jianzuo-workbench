import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import sharp from "sharp";
import type { ResultEnvelope } from "@jianzuo/contracts";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MIN_DIMENSION = 256;
const MAX_DIMENSION = 8_192;
const MAX_PIXEL_COUNT = 40_000_000;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const PRODUCT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type ImageGenGenerationOutcome = "completed" | "quota_exhausted" | "not_generated";

export type VerifyImageGenArtifactInput = {
  productsRoot: string;
  beforeImagePath: string;
  beforeSha256: string;
  candidateOutputPath: string;
  productSlug: string;
  versionDirectory: string;
  generationOutcome?: ImageGenGenerationOutcome;
};

export type ImageGenAssetMetadata = {
  id: string;
  kind: "product_case_image";
  source: "codex_imagegen";
  productSlug: string;
  version: number;
  versionDirectory: string;
  path: string;
  sha256: string;
  mimeType: "image/png";
  width: number;
  height: number;
  byteLength: number;
  verifiedAt: string;
  replaces: {
    path: string;
    sha256: string;
  };
};

export type ImageGenVerificationReason =
  | "QUOTA_EXHAUSTED"
  | "NOT_GENERATED"
  | "INVALID_INPUT"
  | "INVALID_PATH"
  | "INVALID_PNG"
  | "UNREASONABLE_DIMENSIONS"
  | "UNCHANGED_OUTPUT";

export type ImageGenVerificationIssue = {
  reason: ImageGenVerificationReason;
  suggestion: "USE_LOCAL_TEMPLATE";
  fallbackPath?: string;
};

export type ImageGenArtifactVerificationResult = ResultEnvelope<ImageGenAssetMetadata | ImageGenVerificationIssue>;

function envelope<T>(status: ResultEnvelope<T>["status"], summary: string, data: T, artifacts: ResultEnvelope<T>["artifacts"] = []): ResultEnvelope<T> {
  return {
    status,
    summary,
    data,
    nextActions: status === "needs_user"
      ? [{ type: "USE_LOCAL_TEMPLATE", label: "使用本地品牌模板，并保留待生成任务" }]
      : [],
    artifacts,
    correlationId: randomUUID()
  };
}

function needsUser(
  reason: ImageGenVerificationReason,
  summary: string,
  fallbackPath?: string
): ImageGenArtifactVerificationResult {
  return envelope("needs_user", summary, {
    reason,
    suggestion: "USE_LOCAL_TEMPLATE",
    ...(fallbackPath ? { fallbackPath } : {})
  });
}

function normalizedForComparison(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isStrictlyWithin(root: string, candidate: string): boolean {
  const difference = relative(normalizedForComparison(root), normalizedForComparison(candidate));
  return difference.length > 0 && difference !== ".." && !difference.startsWith(`..${sep}`) && !isAbsolute(difference);
}

function readVersionBoundary(input: VerifyImageGenArtifactInput): {
  version: number;
  versionDirectory: string;
  beforeImagePath: string;
  candidateOutputPath: string;
} | null {
  if (!PRODUCT_SLUG_PATTERN.test(input.productSlug) || !SHA256_PATTERN.test(input.beforeSha256)) return null;

  const versionDirectory = resolve(input.versionDirectory);
  const versionMatch = /^v([1-9]\d*)$/.exec(basename(versionDirectory));
  const productDirectory = dirname(versionDirectory);
  const productsRoot = dirname(productDirectory);
  const artifactsRoot = dirname(productsRoot);
  const trustedProductsRoot = resolve(input.productsRoot);

  if (
    !versionMatch
    || normalizedForComparison(productsRoot) !== normalizedForComparison(trustedProductsRoot)
    || basename(productDirectory) !== input.productSlug
    || basename(productsRoot) !== "products"
    || basename(artifactsRoot) !== "artifacts"
  ) return null;

  const beforeImagePath = resolve(input.beforeImagePath);
  const candidateOutputPath = resolve(input.candidateOutputPath);
  if (!isStrictlyWithin(versionDirectory, beforeImagePath) || !isStrictlyWithin(versionDirectory, candidateOutputPath)) return null;

  try {
    const realProductsRoot = realpathSync(productsRoot);
    const realVersionDirectory = realpathSync(versionDirectory);
    if (!isStrictlyWithin(realProductsRoot, realVersionDirectory)) return null;
    if (lstatSync(candidateOutputPath).isSymbolicLink()) return null;

    const realCandidateOutputPath = realpathSync(candidateOutputPath);
    if (!isStrictlyWithin(realVersionDirectory, realCandidateOutputPath)) return null;

    return {
      version: Number(versionMatch[1]),
      versionDirectory: realVersionDirectory,
      beforeImagePath,
      candidateOutputPath: realCandidateOutputPath
    };
  } catch {
    return null;
  }
}

/**
 * Verifies a candidate produced by an ImageGen task without invoking ImageGen or
 * mutating persistence. The version directory is the trust boundary and must
 * have the canonical artifacts/products/<slug>/vN shape.
 */
export async function verifyImageGenArtifact(input: VerifyImageGenArtifactInput): Promise<ImageGenArtifactVerificationResult> {
  const fallbackPath = input.beforeImagePath ? resolve(input.beforeImagePath) : undefined;
  if (input.generationOutcome === "quota_exhausted") {
    return needsUser("QUOTA_EXHAUSTED", "ImageGen 额度暂不可用，已建议使用本地品牌模板", fallbackPath);
  }
  if (input.generationOutcome === "not_generated") {
    return needsUser("NOT_GENERATED", "ImageGen 没有生成可验收图片，已建议使用本地品牌模板", fallbackPath);
  }

  if (!input.beforeImagePath || !input.candidateOutputPath || !input.versionDirectory) {
    return needsUser("INVALID_INPUT", "图片验真信息不完整，不能接收该产物");
  }

  const boundary = readVersionBoundary(input);
  if (!boundary) {
    const candidateExists = (() => {
      try { return statSync(resolve(input.candidateOutputPath)).isFile(); } catch { return false; }
    })();
    return needsUser(
      candidateExists ? "INVALID_PATH" : "NOT_GENERATED",
      candidateExists ? "候选图片不在允许的商品版本目录内，已停止接收" : "没有找到 ImageGen 候选图片，已建议使用本地品牌模板",
      fallbackPath
    );
  }

  let bytes: Buffer;
  try {
    const stats = statSync(boundary.candidateOutputPath);
    if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_FILE_BYTES) {
      return needsUser("INVALID_PNG", "候选图片文件无效或体积不合理，已停止接收", boundary.beforeImagePath);
    }
    bytes = readFileSync(boundary.candidateOutputPath);
  } catch {
    return needsUser("NOT_GENERATED", "没有找到 ImageGen 候选图片，已建议使用本地品牌模板", boundary.beforeImagePath);
  }

  if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return needsUser("INVALID_PNG", "候选文件不是有效 PNG，已停止接收", boundary.beforeImagePath);
  }

  let width: number;
  let height: number;
  try {
    const decoded = await sharp(bytes, { failOn: "error", limitInputPixels: MAX_PIXEL_COUNT })
      .raw()
      .toBuffer({ resolveWithObject: true });
    width = decoded.info.width;
    height = decoded.info.height;
  } catch {
    return needsUser("INVALID_PNG", "候选 PNG 无法完整解码，已停止接收", boundary.beforeImagePath);
  }

  if (
    width < MIN_DIMENSION
    || height < MIN_DIMENSION
    || width > MAX_DIMENSION
    || height > MAX_DIMENSION
    || width * height > MAX_PIXEL_COUNT
  ) {
    return needsUser("UNREASONABLE_DIMENSIONS", "候选图片尺寸不适合作为商品图，已停止接收", boundary.beforeImagePath);
  }

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256.toLowerCase() === input.beforeSha256.toLowerCase()) {
    return needsUser("UNCHANGED_OUTPUT", "ImageGen 产物与任务前图片完全相同，不能视为已生成", boundary.beforeImagePath);
  }

  const metadata: ImageGenAssetMetadata = {
    id: randomUUID(),
    kind: "product_case_image",
    source: "codex_imagegen",
    productSlug: input.productSlug,
    version: boundary.version,
    versionDirectory: boundary.versionDirectory,
    path: boundary.candidateOutputPath,
    sha256,
    mimeType: "image/png",
    width,
    height,
    byteLength: bytes.length,
    verifiedAt: new Date().toISOString(),
    replaces: {
      path: boundary.beforeImagePath,
      sha256: input.beforeSha256.toLowerCase()
    }
  };

  return envelope("ok", "ImageGen 商品图已通过独立验真", metadata, [
    { kind: "product_case_image", path: boundary.candidateOutputPath }
  ]);
}
