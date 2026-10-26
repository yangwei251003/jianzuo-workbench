import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";

export const BAIDU_OAUTH_AUTHORIZE_URL = "https://openapi.baidu.com/oauth/2.0/authorize";
export const BAIDU_OAUTH_TOKEN_URL = "https://openapi.baidu.com/oauth/2.0/token";
export const BAIDU_PAN_FILE_API_URL = "https://pan.baidu.com/rest/2.0/xpan/file";
export const BAIDU_PAN_UPLOAD_API_URL = "https://d.pcs.baidu.com/rest/2.0/pcs/superfile2";
export const BAIDU_UPLOAD_PART_BYTES = 4 * 1024 * 1024;

const OAUTH_SESSION_TTL_MS = 10 * 60 * 1_000;
const MAX_BLOCKS = 10_000;
const SENSITIVE_KEY = /(access[_-]?token|refresh[_-]?token|client[_-]?secret|session[_-]?secret|code[_-]?verifier|authorization)/i;

export type BaiduPanOAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: readonly string[];
};

export type BaiduPanOAuthSession = {
  state: string;
  codeVerifier: string;
  redirectUri: string;
  createdAt: string;
  expiresAt: string;
};

export type BaiduPanAuthorization = {
  authorizationUrl: string;
  session: BaiduPanOAuthSession;
};

export type ValidatedBaiduOAuthCallback = {
  code: string;
  codeVerifier: string;
  redirectUri: string;
};

/**
 * This value is intentionally plaintext only at the OAuth boundary. Callers must
 * encrypt the complete object before persistence and must never send it to logs.
 */
export type BaiduPanPlaintextToken = {
  kind: "BAIDU_PAN_OAUTH_TOKEN_PLAINTEXT";
  mustEncryptBeforePersisting: true;
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  scopes: string[];
  obtainedAt: string;
  expiresAt: string;
};

export type BaiduPanTransportRequest = {
  operation: "oauth_token" | "precreate" | "upload_part" | "create_file";
  method: "POST";
  url: string;
  query?: Record<string, string | number>;
  form?: Record<string, string | number>;
  multipart?: {
    fieldName: "file";
    fileName: string;
    contentType: "application/octet-stream";
    content: Uint8Array;
  };
  /** Keys that a transport/logger must redact before recording this request. */
  sensitiveKeys: readonly string[];
};

export type BaiduPanTransportResponse<T = Record<string, unknown>> = {
  status: number;
  data: T;
};

export interface BaiduPanTransport {
  request(request: BaiduPanTransportRequest): Promise<BaiduPanTransportResponse<Record<string, unknown>>>;
}

export type BaiduPanFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type OfficialBaiduPanFetchTransportOptions = {
  fetch?: BaiduPanFetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
};

const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_FETCH_TIMEOUT_MS = 120_000;
const MAX_CONFIGURED_RESPONSE_BYTES = 4 * 1024 * 1024;

/**
 * Production network boundary for the documented Baidu OAuth and multipart-upload
 * endpoints. It deliberately rejects redirects and every URL outside the exact
 * operation-to-endpoint allowlist. Tests inject fetch; constructing this class
 * alone never performs network I/O.
 */
export class OfficialBaiduPanFetchTransport implements BaiduPanTransport {
  private readonly fetchImplementation: BaiduPanFetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(options: OfficialBaiduPanFetchTransportOptions = {}) {
    this.fetchImplementation = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = validateBoundedInteger(
      options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
      1,
      MAX_FETCH_TIMEOUT_MS,
      "PAN_TRANSPORT_TIMEOUT_INVALID"
    );
    this.maxResponseBytes = validateBoundedInteger(
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      1,
      MAX_CONFIGURED_RESPONSE_BYTES,
      "PAN_TRANSPORT_RESPONSE_LIMIT_INVALID"
    );
  }

  async request(request: BaiduPanTransportRequest): Promise<BaiduPanTransportResponse<Record<string, unknown>>> {
    const url = buildOfficialBaiduRequestUrl(request);
    const body = buildBaiduRequestBody(request);
    const headers = new Headers({ Accept: "application/json" });
    if (body.contentType) headers.set("Content-Type", body.contentType);

    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImplementation(url, {
        method: "POST",
        headers,
        body: body.value,
        signal: abortController.signal,
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer"
      });
      const data = await readBoundedJsonObject(response, this.maxResponseBytes);
      return { status: response.status, data };
    } catch (error) {
      if (abortController.signal.aborted || isAbortError(error)) {
        throw new BaiduPanSafeError("PAN_TRANSPORT_TIMEOUT", "百度网盘请求超时，请稍后重试");
      }
      if (error instanceof BaiduPanSafeError) throw error;
      throw new BaiduPanSafeError("PAN_TRANSPORT_FAILED", "百度网盘网络请求失败，请检查网络后重试", {
        errorType: safeErrorType(error)
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

export type BaiduPanUploadSource = {
  localPath: string;
  size: number;
  /** Ordered MD5 values for all 4 MiB parts, as required by the precreate/create API. */
  blockList: readonly string[];
  readPart(index: number): Promise<Uint8Array>;
};

export type BaiduPanUploadResult = {
  fsId: string;
  remotePath: string;
  serverFileName: string;
  size: number;
  md5?: string;
  uploadedParts: number[];
};

export type BaiduPanShareResult =
  | { status: "ok"; url: string }
  | { status: "permission_denied"; reason: string }
  | { status: "failed"; reason: string; retryable: boolean };

/**
 * Personal accounts do not have a guaranteed official automatic-share API.
 * A separately reviewed provider can implement this boundary when available.
 */
export interface BaiduPanShareAdapter {
  createShareLink(input: { accessToken: string; fsId: string; remotePath: string }): Promise<BaiduPanShareResult>;
}

export interface BaiduPanMultipartAdapter {
  precreate(input: {
    accessToken: string;
    remotePath: string;
    size: number;
    blockList: readonly string[];
  }): Promise<{ uploadId: string; requiredPartIndexes: number[] }>;
  uploadPart(input: {
    accessToken: string;
    remotePath: string;
    uploadId: string;
    partIndex: number;
    content: Uint8Array;
  }): Promise<{ md5?: string }>;
  createFile(input: {
    accessToken: string;
    remotePath: string;
    uploadId: string;
    size: number;
    blockList: readonly string[];
  }): Promise<Omit<BaiduPanUploadResult, "uploadedParts">>;
}

export type BaiduPanDeliveryResult =
  | {
      status: "READY_TO_SEND";
      upload: BaiduPanUploadResult;
      shareUrl: string;
    }
  | {
      status: "WAITING_USER_PASTE_LINK";
      upload: BaiduPanUploadResult;
      reason: "PERSONAL_ACCOUNT_SHARE_API_UNAVAILABLE" | "SHARE_PERMISSION_DENIED";
      nextAction: { type: "PASTE_BAIDU_SHARE_LINK"; label: string };
    };

export class BaiduPanSafeError extends Error {
  readonly code: string;
  readonly safeDetails?: unknown;

  constructor(code: string, message: string, safeDetails?: unknown) {
    super(message);
    this.name = "BaiduPanSafeError";
    this.code = code;
    this.safeDetails = safeDetails === undefined ? undefined : redactBaiduPanValue(safeDetails);
  }
}

export function createBaiduPanAuthorization(
  config: BaiduPanOAuthConfig,
  options: { now?: Date; random?: (size: number) => Buffer } = {}
): BaiduPanAuthorization {
  validateOAuthConfig(config);
  const now = options.now ?? new Date();
  const random = options.random ?? ((size: number) => randomBytes(size));
  const state = random(32).toString("base64url");
  const codeVerifier = random(64).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier, "ascii").digest("base64url");
  const expiresAt = new Date(now.getTime() + OAUTH_SESSION_TTL_MS);
  const url = new URL(BAIDU_OAUTH_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", config.scopes.join(","));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");

  return {
    authorizationUrl: url.toString(),
    session: {
      state,
      codeVerifier,
      redirectUri: config.redirectUri,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString()
    }
  };
}

export function validateBaiduPanOAuthCallback(
  callbackUrl: string,
  session: BaiduPanOAuthSession,
  now = new Date()
): ValidatedBaiduOAuthCallback {
  let callback: URL;
  let expected: URL;
  try {
    callback = new URL(callbackUrl);
    expected = new URL(session.redirectUri);
  } catch {
    throw new BaiduPanSafeError("OAUTH_CALLBACK_INVALID", "百度授权回调地址无效");
  }
  if (callback.origin !== expected.origin || callback.pathname !== expected.pathname) {
    throw new BaiduPanSafeError("OAUTH_REDIRECT_MISMATCH", "百度授权回调地址与发起授权时不一致");
  }
  if (now.getTime() > Date.parse(session.expiresAt)) {
    throw new BaiduPanSafeError("OAUTH_SESSION_EXPIRED", "百度授权会话已过期，请重新授权");
  }
  const callbackState = callback.searchParams.get("state") ?? "";
  if (!safeTextEqual(callbackState, session.state)) {
    throw new BaiduPanSafeError("OAUTH_STATE_MISMATCH", "百度授权 state 校验失败，已拒绝本次回调");
  }
  const oauthError = callback.searchParams.get("error");
  if (oauthError) {
    throw new BaiduPanSafeError("OAUTH_PROVIDER_REJECTED", "百度授权未完成", { error: oauthError });
  }
  const code = callback.searchParams.get("code");
  if (!code) throw new BaiduPanSafeError("OAUTH_CODE_MISSING", "百度授权回调缺少授权码");
  if (!/^[A-Za-z0-9._~-]{20,128}$/.test(session.codeVerifier)) {
    throw new BaiduPanSafeError("OAUTH_PKCE_INVALID", "PKCE 校验参数无效");
  }
  return { code, codeVerifier: session.codeVerifier, redirectUri: session.redirectUri };
}

export async function exchangeBaiduPanAuthorizationCode(
  config: BaiduPanOAuthConfig,
  callback: ValidatedBaiduOAuthCallback,
  transport: BaiduPanTransport,
  now = new Date()
): Promise<BaiduPanPlaintextToken> {
  validateOAuthConfig(config);
  if (callback.redirectUri !== config.redirectUri) {
    throw new BaiduPanSafeError("OAUTH_REDIRECT_MISMATCH", "百度授权回调地址与配置不一致");
  }
  const response = await transport.request({
    operation: "oauth_token",
    method: "POST",
    url: BAIDU_OAUTH_TOKEN_URL,
    form: {
      grant_type: "authorization_code",
      code: callback.code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: callback.redirectUri,
      code_verifier: callback.codeVerifier
    },
    sensitiveKeys: ["code", "client_secret", "code_verifier", "access_token", "refresh_token"]
  });
  if (response.status < 200 || response.status >= 300) {
    throw new BaiduPanSafeError("OAUTH_TOKEN_HTTP_FAILED", "百度令牌交换失败", response.data);
  }
  const accessToken = readNonEmptyString(response.data.access_token);
  const expiresIn = readPositiveInteger(response.data.expires_in);
  if (!accessToken || !expiresIn) {
    throw new BaiduPanSafeError("OAUTH_TOKEN_RESPONSE_INVALID", "百度令牌响应格式无效", response.data);
  }
  const refreshToken = readNonEmptyString(response.data.refresh_token);
  const tokenType = readNonEmptyString(response.data.token_type) ?? "Bearer";
  const rawScope = readNonEmptyString(response.data.scope) ?? config.scopes.join(",");
  return {
    kind: "BAIDU_PAN_OAUTH_TOKEN_PLAINTEXT",
    mustEncryptBeforePersisting: true,
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    tokenType,
    scopes: rawScope.split(/[\s,]+/).filter(Boolean),
    obtainedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + expiresIn * 1_000).toISOString()
  };
}

export function publicBaiduPanOAuthConfig(config: BaiduPanOAuthConfig): Omit<BaiduPanOAuthConfig, "clientSecret"> & { clientSecret: "[REDACTED]" } {
  return { clientId: config.clientId, clientSecret: "[REDACTED]", redirectUri: config.redirectUri, scopes: [...config.scopes] };
}

export function redactBaiduPanValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => redactBaiduPanValue(entry)) as T;
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      output[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactBaiduPanValue(entry);
    }
    return output as T;
  }
  if (typeof value === "string") {
    try {
      const url = new URL(value);
      for (const key of [...url.searchParams.keys()]) {
        if (SENSITIVE_KEY.test(key)) url.searchParams.set(key, "[REDACTED]");
      }
      return url.toString() as T;
    } catch {
      return value.replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [REDACTED]") as T;
    }
  }
  return value;
}

export class OfficialBaiduPanMultipartAdapter implements BaiduPanMultipartAdapter {
  constructor(private readonly transport: BaiduPanTransport) {}

  async precreate(input: {
    accessToken: string;
    remotePath: string;
    size: number;
    blockList: readonly string[];
  }): Promise<{ uploadId: string; requiredPartIndexes: number[] }> {
    const response = await this.transport.request({
      operation: "precreate",
      method: "POST",
      url: BAIDU_PAN_FILE_API_URL,
      query: { method: "precreate", access_token: input.accessToken },
      form: {
        path: input.remotePath,
        size: input.size,
        isdir: 0,
        autoinit: 1,
        rtype: 1,
        block_list: JSON.stringify(input.blockList)
      },
      sensitiveKeys: ["access_token"]
    });
    assertBaiduApiSuccess(response, "PAN_PRECREATE_FAILED", "百度网盘预创建上传任务失败");
    const uploadId = readNonEmptyString(response.data.uploadid);
    if (!uploadId) throw new BaiduPanSafeError("PAN_PRECREATE_INVALID", "百度网盘预创建响应缺少 uploadid", response.data);
    const rawIndexes = Array.isArray(response.data.block_list) ? response.data.block_list : input.blockList.map((_, index) => index);
    const requiredPartIndexes = rawIndexes.map((entry) => Number(entry));
    if (requiredPartIndexes.some((entry) => !Number.isInteger(entry))) {
      throw new BaiduPanSafeError("PAN_PRECREATE_INVALID", "百度网盘预创建响应包含无效分片索引", response.data);
    }
    return { uploadId, requiredPartIndexes };
  }

  async uploadPart(input: {
    accessToken: string;
    remotePath: string;
    uploadId: string;
    partIndex: number;
    content: Uint8Array;
  }): Promise<{ md5?: string }> {
    const response = await this.transport.request({
      operation: "upload_part",
      method: "POST",
      url: BAIDU_PAN_UPLOAD_API_URL,
      query: {
        method: "upload",
        type: "tmpfile",
        access_token: input.accessToken,
        path: input.remotePath,
        uploadid: input.uploadId,
        partseq: input.partIndex
      },
      multipart: {
        fieldName: "file",
        fileName: `part-${input.partIndex}.bin`,
        contentType: "application/octet-stream",
        content: input.content
      },
      sensitiveKeys: ["access_token"]
    });
    assertBaiduApiSuccess(response, "PAN_UPLOAD_PART_FAILED", `百度网盘第 ${input.partIndex + 1} 个分片上传失败`);
    if (!Object.prototype.hasOwnProperty.call(response.data, "md5")) return {};
    const md5 = readNonEmptyString(response.data.md5);
    if (!md5) throw new BaiduPanSafeError("PAN_UPLOAD_PART_INVALID", "百度网盘分片上传响应包含无效 MD5", response.data);
    return { md5 };
  }

  async createFile(input: {
    accessToken: string;
    remotePath: string;
    uploadId: string;
    size: number;
    blockList: readonly string[];
  }): Promise<Omit<BaiduPanUploadResult, "uploadedParts">> {
    const response = await this.transport.request({
      operation: "create_file",
      method: "POST",
      url: BAIDU_PAN_FILE_API_URL,
      query: { method: "create", access_token: input.accessToken },
      form: {
        path: input.remotePath,
        size: input.size,
        isdir: 0,
        rtype: 1,
        uploadid: input.uploadId,
        block_list: JSON.stringify(input.blockList)
      },
      sensitiveKeys: ["access_token"]
    });
    assertBaiduApiSuccess(response, "PAN_CREATE_FILE_FAILED", "百度网盘合并分片失败");
    const fsId = readStringOrNumber(response.data.fs_id);
    const remotePath = readNonEmptyString(response.data.path) ?? input.remotePath;
    const serverFileName = readNonEmptyString(response.data.server_filename) ?? remotePath.split("/").at(-1) ?? "delivery.zip";
    const size = readPositiveInteger(response.data.size) ?? input.size;
    if (!fsId) throw new BaiduPanSafeError("PAN_CREATE_FILE_INVALID", "百度网盘文件创建响应缺少 fs_id", response.data);
    const md5 = readNonEmptyString(response.data.md5);
    return { fsId, remotePath, serverFileName, size, ...(md5 ? { md5 } : {}) };
  }
}

export class BaiduPanDeliveryService {
  constructor(
    private readonly uploadAdapter: BaiduPanMultipartAdapter,
    private readonly shareAdapter?: BaiduPanShareAdapter
  ) {}

  async uploadAndPrepareDelivery(input: {
    accessToken: string;
    allowedLocalRoot: string;
    remotePath: string;
    source: BaiduPanUploadSource;
    automaticShare: boolean;
  }): Promise<BaiduPanDeliveryResult> {
    validateUploadInput(input);
    const precreated = await this.uploadAdapter.precreate({
      accessToken: input.accessToken,
      remotePath: input.remotePath,
      size: input.source.size,
      blockList: input.source.blockList
    });
    const indexes = [...new Set(precreated.requiredPartIndexes)];
    if (indexes.some((index) => index < 0 || index >= input.source.blockList.length)) {
      throw new BaiduPanSafeError("PAN_PART_INDEX_INVALID", "百度网盘返回了超出范围的分片索引");
    }
    for (const index of indexes) {
      const content = await input.source.readPart(index);
      if (!(content instanceof Uint8Array) || content.byteLength === 0 || content.byteLength > BAIDU_UPLOAD_PART_BYTES) {
        throw new BaiduPanSafeError("PAN_PART_CONTENT_INVALID", `第 ${index + 1} 个上传分片大小无效`);
      }
      const expectedMd5 = input.source.blockList[index]!;
      const actualMd5 = createHash("md5").update(content).digest("hex");
      if (!safeMd5Equal(actualMd5, expectedMd5)) {
        throw new BaiduPanSafeError("PAN_LOCAL_FILE_CHANGED", "交付文件在上传期间发生变化，已停止上传");
      }
      const uploaded = await this.uploadAdapter.uploadPart({
        accessToken: input.accessToken,
        remotePath: input.remotePath,
        uploadId: precreated.uploadId,
        partIndex: index,
        content
      });
      if (uploaded.md5 !== undefined && !safeMd5Equal(uploaded.md5, expectedMd5)) {
        throw new BaiduPanSafeError("PAN_UPLOAD_PART_MD5_MISMATCH", `百度网盘第 ${index + 1} 个分片校验失败，已停止合并`);
      }
    }
    const created = await this.uploadAdapter.createFile({
      accessToken: input.accessToken,
      remotePath: input.remotePath,
      uploadId: precreated.uploadId,
      size: input.source.size,
      blockList: input.source.blockList
    });
    const upload: BaiduPanUploadResult = { ...created, uploadedParts: indexes };

    if (!input.automaticShare || !this.shareAdapter) return waitingForManualLink(upload, "PERSONAL_ACCOUNT_SHARE_API_UNAVAILABLE");
    const share = await this.shareAdapter.createShareLink({
      accessToken: input.accessToken,
      fsId: upload.fsId,
      remotePath: upload.remotePath
    });
    if (share.status === "ok") {
      assertHttpsShareUrl(share.url);
      return { status: "READY_TO_SEND", upload, shareUrl: share.url };
    }
    if (share.status === "permission_denied") return waitingForManualLink(upload, "SHARE_PERMISSION_DENIED");
    throw new BaiduPanSafeError("PAN_SHARE_FAILED", "百度网盘分享链接创建失败，请稍后重试或人工粘贴链接", {
      reason: share.reason,
      retryable: share.retryable
    });
  }
}

function waitingForManualLink(
  upload: BaiduPanUploadResult,
  reason: "PERSONAL_ACCOUNT_SHARE_API_UNAVAILABLE" | "SHARE_PERMISSION_DENIED"
): BaiduPanDeliveryResult {
  return {
    status: "WAITING_USER_PASTE_LINK",
    upload,
    reason,
    nextAction: { type: "PASTE_BAIDU_SHARE_LINK", label: "粘贴百度网盘分享链接" }
  };
}

function validateOAuthConfig(config: BaiduPanOAuthConfig): void {
  if (!config.clientId.trim() || !config.clientSecret.trim()) throw new BaiduPanSafeError("OAUTH_CONFIG_INVALID", "百度 OAuth 配置不完整");
  if (!config.scopes.length || config.scopes.some((scope) => !/^[A-Za-z0-9._-]+$/.test(scope))) {
    throw new BaiduPanSafeError("OAUTH_SCOPE_INVALID", "百度 OAuth scope 配置无效");
  }
  let redirect: URL;
  try {
    redirect = new URL(config.redirectUri);
  } catch {
    throw new BaiduPanSafeError("OAUTH_REDIRECT_INVALID", "百度 OAuth 回调地址无效");
  }
  const loopback = redirect.protocol === "http:" && redirect.hostname === "127.0.0.1";
  if (redirect.protocol !== "https:" && !loopback) {
    throw new BaiduPanSafeError("OAUTH_REDIRECT_UNSAFE", "百度 OAuth 回调仅允许 HTTPS 或 127.0.0.1");
  }
}

function validateUploadInput(input: {
  accessToken: string;
  allowedLocalRoot: string;
  remotePath: string;
  source: BaiduPanUploadSource;
}): void {
  if (!input.accessToken.trim()) throw new BaiduPanSafeError("PAN_ACCESS_TOKEN_MISSING", "缺少百度网盘访问令牌");
  if (!isAbsolute(input.allowedLocalRoot) || !isAbsolute(input.source.localPath)) {
    throw new BaiduPanSafeError("PAN_LOCAL_PATH_INVALID", "交付文件与允许目录必须使用绝对路径");
  }
  const allowedRoot = resolve(input.allowedLocalRoot);
  const localPath = resolve(input.source.localPath);
  const relativePath = relative(allowedRoot, localPath);
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath) || localPath.includes("\0")) {
    throw new BaiduPanSafeError("PAN_LOCAL_PATH_FORBIDDEN", "交付文件路径不在订单允许目录内");
  }
  validateRemotePath(input.remotePath);
  if (!Number.isSafeInteger(input.source.size) || input.source.size <= 0) {
    throw new BaiduPanSafeError("PAN_FILE_SIZE_INVALID", "交付文件大小无效");
  }
  if (!input.source.blockList.length || input.source.blockList.length > MAX_BLOCKS) {
    throw new BaiduPanSafeError("PAN_BLOCK_LIST_INVALID", "交付文件分片数量无效");
  }
  if (input.source.blockList.some((md5) => !/^[a-f0-9]{32}$/i.test(md5))) {
    throw new BaiduPanSafeError("PAN_BLOCK_LIST_INVALID", "交付文件分片 MD5 格式无效");
  }
}

function validateRemotePath(remotePath: string): void {
  if (!remotePath.startsWith("/") || remotePath.length > 1_000 || /[\\\0\r\n?#]/.test(remotePath)) {
    throw new BaiduPanSafeError("PAN_REMOTE_PATH_INVALID", "百度网盘目标路径无效");
  }
  const segments = remotePath.split("/").slice(1);
  if (!segments.length || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new BaiduPanSafeError("PAN_REMOTE_PATH_INVALID", "百度网盘目标路径包含不安全片段");
  }
}

function assertHttpsShareUrl(value: string): void {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || (hostname !== "baidu.com" && !hostname.endsWith(".baidu.com"))) throw new Error("unsafe");
  } catch {
    throw new BaiduPanSafeError("PAN_SHARE_URL_INVALID", "百度网盘返回了无效的分享链接");
  }
}

function assertBaiduApiSuccess(
  response: BaiduPanTransportResponse<Record<string, unknown>>,
  code: string,
  message: string
): void {
  const errno = Number(response.data.errno ?? 0);
  if (response.status < 200 || response.status >= 300 || (Number.isFinite(errno) && errno !== 0)) {
    throw new BaiduPanSafeError(code, message, { status: response.status, data: response.data });
  }
}

function safeTextEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function safeMd5Equal(left: string, right: string): boolean {
  if (!/^[a-f0-9]{32}$/i.test(left) || !/^[a-f0-9]{32}$/i.test(right)) return false;
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function readStringOrNumber(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return undefined;
}

function buildOfficialBaiduRequestUrl(request: BaiduPanTransportRequest): URL {
  const expectedUrl = new URL({
    oauth_token: BAIDU_OAUTH_TOKEN_URL,
    precreate: BAIDU_PAN_FILE_API_URL,
    upload_part: BAIDU_PAN_UPLOAD_API_URL,
    create_file: BAIDU_PAN_FILE_API_URL
  }[request.operation]);
  let requestedUrl: URL;
  try {
    requestedUrl = new URL(request.url);
  } catch {
    throw new BaiduPanSafeError("PAN_TRANSPORT_URL_INVALID", "百度网盘请求地址无效");
  }
  if (
    requestedUrl.protocol !== "https:"
    || requestedUrl.username
    || requestedUrl.password
    || requestedUrl.hash
    || requestedUrl.search
    || requestedUrl.origin !== expectedUrl.origin
    || requestedUrl.pathname !== expectedUrl.pathname
  ) {
    throw new BaiduPanSafeError("PAN_TRANSPORT_URL_FORBIDDEN", "已阻止非官方百度接口请求");
  }
  if (request.method !== "POST") {
    throw new BaiduPanSafeError("PAN_TRANSPORT_METHOD_FORBIDDEN", "百度网盘请求方法不受支持");
  }
  for (const [key, value] of Object.entries(request.query ?? {})) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(key)) {
      throw new BaiduPanSafeError("PAN_TRANSPORT_QUERY_INVALID", "百度网盘请求参数名称无效");
    }
    requestedUrl.searchParams.append(key, encodeScalar(value, "PAN_TRANSPORT_QUERY_INVALID"));
  }
  return requestedUrl;
}

function buildBaiduRequestBody(request: BaiduPanTransportRequest): { value: BodyInit; contentType?: string } {
  if (request.form && request.multipart) {
    throw new BaiduPanSafeError("PAN_TRANSPORT_BODY_INVALID", "百度网盘请求不能同时包含表单和文件");
  }
  if (request.operation === "upload_part" && !request.multipart) {
    throw new BaiduPanSafeError("PAN_TRANSPORT_BODY_INVALID", "百度网盘分片上传缺少文件内容");
  }
  if (request.operation !== "upload_part" && !request.form) {
    throw new BaiduPanSafeError("PAN_TRANSPORT_BODY_INVALID", "百度网盘请求缺少表单内容");
  }
  if (request.form) {
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(request.form)) {
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(key)) {
        throw new BaiduPanSafeError("PAN_TRANSPORT_FORM_INVALID", "百度网盘表单参数名称无效");
      }
      form.append(key, encodeScalar(value, "PAN_TRANSPORT_FORM_INVALID"));
    }
    return { value: form, contentType: "application/x-www-form-urlencoded;charset=UTF-8" };
  }
  const multipart = request.multipart!;
  if (
    multipart.fieldName !== "file"
    || multipart.contentType !== "application/octet-stream"
    || !/^[A-Za-z0-9._-]{1,128}$/.test(multipart.fileName)
    || !(multipart.content instanceof Uint8Array)
    || multipart.content.byteLength === 0
    || multipart.content.byteLength > BAIDU_UPLOAD_PART_BYTES
  ) {
    throw new BaiduPanSafeError("PAN_TRANSPORT_MULTIPART_INVALID", "百度网盘上传文件表单无效");
  }
  const form = new FormData();
  form.append(
    multipart.fieldName,
    new Blob([Buffer.from(multipart.content)], { type: multipart.contentType }),
    multipart.fileName
  );
  return { value: form };
}

function encodeScalar(value: string | number, code: string): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new BaiduPanSafeError(code, "百度网盘请求参数无效");
    return String(value);
  }
  if (typeof value !== "string" || value.includes("\0") || /[\r\n]/.test(value)) {
    throw new BaiduPanSafeError(code, "百度网盘请求参数无效");
  }
  return value;
}

async function readBoundedJsonObject(response: Response, maxResponseBytes: number): Promise<Record<string, unknown>> {
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const advertisedBytes = Number(contentLength);
    if (!Number.isSafeInteger(advertisedBytes) || advertisedBytes < 0 || advertisedBytes > maxResponseBytes) {
      throw new BaiduPanSafeError("PAN_TRANSPORT_RESPONSE_TOO_LARGE", "百度网盘响应超过安全大小限制", {
        status: response.status,
        maxResponseBytes
      });
    }
  }

  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        receivedBytes += value.byteLength;
        if (receivedBytes > maxResponseBytes) {
          await reader.cancel();
          throw new BaiduPanSafeError("PAN_TRANSPORT_RESPONSE_TOO_LARGE", "百度网盘响应超过安全大小限制", {
            status: response.status,
            maxResponseBytes
          });
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }

  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), receivedBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new BaiduPanSafeError("PAN_TRANSPORT_RESPONSE_INVALID", "百度网盘返回了无法识别的响应", {
      status: response.status,
      receivedBytes
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BaiduPanSafeError("PAN_TRANSPORT_RESPONSE_INVALID", "百度网盘返回的数据格式无效", {
      status: response.status,
      receivedBytes
    });
  }
  return parsed as Record<string, unknown>;
}

function validateBoundedInteger(value: number, minimum: number, maximum: number, code: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new BaiduPanSafeError(code, "百度网盘网络参数超出安全范围");
  }
  return value;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
    || Boolean(error && typeof error === "object" && "name" in error && error.name === "AbortError");
}

function safeErrorType(error: unknown): string {
  if (!error || typeof error !== "object" || !("name" in error) || typeof error.name !== "string") return "NetworkError";
  return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(error.name) ? error.name : "NetworkError";
}
