import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  BAIDU_OAUTH_TOKEN_URL,
  BAIDU_PAN_FILE_API_URL,
  BAIDU_PAN_UPLOAD_API_URL,
  BaiduPanDeliveryService,
  OfficialBaiduPanFetchTransport,
  OfficialBaiduPanMultipartAdapter,
  createBaiduPanAuthorization,
  exchangeBaiduPanAuthorizationCode,
  publicBaiduPanOAuthConfig,
  redactBaiduPanValue,
  validateBaiduPanOAuthCallback,
  type BaiduPanMultipartAdapter,
  type BaiduPanOAuthConfig,
  type BaiduPanShareResult,
  type BaiduPanShareAdapter,
  type BaiduPanTransport,
  type BaiduPanTransportRequest
} from "./baidu-pan.js";

const oauthConfig: BaiduPanOAuthConfig = {
  clientId: "client-id-for-tests",
  clientSecret: "never-log-this-client-secret",
  redirectUri: "http://127.0.0.1:8787/api/baidu-pan/oauth/callback",
  scopes: ["basic", "netdisk"]
};

function md5(content: Uint8Array): string {
  return createHash("md5").update(content).digest("hex");
}

describe("Baidu Pan OAuth", () => {
  it("rejects a callback whose state does not match before any token request", () => {
    const authorization = createBaiduPanAuthorization(oauthConfig, { now: new Date("2026-08-31T00:00:00.000Z") });
    const callback = `${oauthConfig.redirectUri}?code=temporary-code&state=attacker-state`;
    expect(() => validateBaiduPanOAuthCallback(callback, authorization.session, new Date("2026-08-31T00:01:00.000Z")))
      .toThrowError(expect.objectContaining({ code: "OAUTH_STATE_MISMATCH" }));
  });

  it("returns an encryption-required token contract and redacts token responses and client_secret", async () => {
    let captured: BaiduPanTransportRequest | undefined;
    const transport: BaiduPanTransport = {
      request: vi.fn(async (request) => {
        captured = request;
        return {
          status: 200,
          data: {
            access_token: "sensitive-access-token",
            refresh_token: "sensitive-refresh-token",
            expires_in: 2_592_000,
            scope: "basic,netdisk",
            token_type: "Bearer",
            session_secret: "provider-session-secret"
          }
        };
      })
    };
    const authorization = createBaiduPanAuthorization(oauthConfig, { now: new Date("2026-08-31T00:00:00.000Z") });
    const callback = validateBaiduPanOAuthCallback(
      `${oauthConfig.redirectUri}?code=temporary-code&state=${authorization.session.state}`,
      authorization.session,
      new Date("2026-08-31T00:01:00.000Z")
    );
    const token = await exchangeBaiduPanAuthorizationCode(oauthConfig, callback, transport, new Date("2026-08-31T00:01:00.000Z"));

    expect(token).toMatchObject({
      kind: "BAIDU_PAN_OAUTH_TOKEN_PLAINTEXT",
      mustEncryptBeforePersisting: true,
      accessToken: "sensitive-access-token",
      refreshToken: "sensitive-refresh-token"
    });
    expect(captured?.url).toBe(BAIDU_OAUTH_TOKEN_URL);
    expect(captured?.sensitiveKeys).toContain("client_secret");
    const safeRequest = JSON.stringify(redactBaiduPanValue(captured));
    const safeConfig = JSON.stringify(publicBaiduPanOAuthConfig(oauthConfig));
    expect(safeRequest).not.toContain("never-log-this-client-secret");
    expect(safeRequest).not.toContain(authorization.session.codeVerifier);
    expect(safeConfig).not.toContain("never-log-this-client-secret");
    expect(redactBaiduPanValue({
      access_token: "sensitive-access-token",
      refresh_token: "sensitive-refresh-token",
      nested: { session_secret: "provider-session-secret" }
    })).toEqual({
      access_token: "[REDACTED]",
      refresh_token: "[REDACTED]",
      nested: { session_secret: "[REDACTED]" }
    });
  });
});

describe("Baidu Pan multipart delivery", () => {
  it("adapts precreate, part uploads and create to the official multipart boundary", async () => {
    const first = Buffer.from("first part");
    const second = Buffer.from("second part");
    const requests: BaiduPanTransportRequest[] = [];
    const transport: BaiduPanTransport = {
      request: vi.fn(async (request) => {
        requests.push(request);
        if (request.operation === "precreate") return { status: 200, data: { errno: 0, uploadid: "upload-1", block_list: [0, 1] } };
        if (request.operation === "upload_part") return { status: 200, data: { errno: 0, md5: request.query?.partseq === 0 ? md5(first) : md5(second) } };
        return {
          status: 200,
          data: { errno: 0, fs_id: 42, path: "/简作交付/订单-1.zip", server_filename: "订单-1.zip", size: first.length + second.length, md5: md5(Buffer.concat([first, second])) }
        };
      })
    };
    const shareAdapter: BaiduPanShareAdapter = {
      createShareLink: vi.fn(async (): Promise<BaiduPanShareResult> => ({ status: "ok", url: "https://pan.baidu.com/s/example" }))
    };
    const service = new BaiduPanDeliveryService(new OfficialBaiduPanMultipartAdapter(transport), shareAdapter);
    const root = resolve("output", "orders", "order-1");
    const result = await service.uploadAndPrepareDelivery({
      accessToken: "access-token-only-for-mock",
      allowedLocalRoot: root,
      remotePath: "/简作交付/订单-1.zip",
      source: {
        localPath: resolve(root, "订单-1.zip"),
        size: first.length + second.length,
        blockList: [md5(first), md5(second)],
        readPart: async (index) => [first, second][index]!
      },
      automaticShare: true
    });

    expect(result).toMatchObject({ status: "READY_TO_SEND", shareUrl: "https://pan.baidu.com/s/example", upload: { fsId: "42", uploadedParts: [0, 1] } });
    expect(requests.map((request) => request.operation)).toEqual(["precreate", "upload_part", "upload_part", "create_file"]);
    expect(requests[0]).toMatchObject({ url: BAIDU_PAN_FILE_API_URL, query: { method: "precreate" } });
    expect(requests[1]).toMatchObject({ url: BAIDU_PAN_UPLOAD_API_URL, multipart: { fieldName: "file" } });
    expect(requests[3]).toMatchObject({ url: BAIDU_PAN_FILE_API_URL, query: { method: "create" } });
    expect(requests.every((request) => !request.url.includes("access-token-only-for-mock"))).toBe(true);
  });

  it("falls back to WAITING_USER_PASTE_LINK when a personal account cannot create a share", async () => {
    const uploadAdapter = successfulUploadAdapter();
    const shareAdapter: BaiduPanShareAdapter = {
      createShareLink: vi.fn(async (): Promise<BaiduPanShareResult> => ({ status: "permission_denied", reason: "personal account has no share API permission" }))
    };
    const service = new BaiduPanDeliveryService(uploadAdapter, shareAdapter);
    const root = resolve("output", "orders", "order-2");
    const content = Buffer.from("delivery");
    const result = await service.uploadAndPrepareDelivery({
      accessToken: "mock-token",
      allowedLocalRoot: root,
      remotePath: "/简作交付/订单-2.zip",
      source: {
        localPath: resolve(root, "订单-2.zip"),
        size: content.length,
        blockList: [md5(content)],
        readPart: async () => content
      },
      automaticShare: true
    });

    expect(result).toEqual(expect.objectContaining({
      status: "WAITING_USER_PASTE_LINK",
      reason: "SHARE_PERMISSION_DENIED",
      nextAction: { type: "PASTE_BAIDU_SHARE_LINK", label: "粘贴百度网盘分享链接" }
    }));
  });

  it("stops before upload and merge when a part no longer matches the initial block list", async () => {
    const expected = Buffer.from("first");
    const replaced = Buffer.from("other");
    const uploadAdapter = successfulUploadAdapter();
    const service = new BaiduPanDeliveryService(uploadAdapter);
    const root = resolve("output", "orders", "order-changed");

    await expect(service.uploadAndPrepareDelivery({
      accessToken: "mock-token",
      allowedLocalRoot: root,
      remotePath: "/简作交付/order-changed.zip",
      source: {
        localPath: resolve(root, "order-changed.zip"),
        size: expected.length,
        blockList: [md5(expected)],
        readPart: async () => replaced
      },
      automaticShare: false
    })).rejects.toMatchObject({ code: "PAN_LOCAL_FILE_CHANGED" });

    expect(uploadAdapter.uploadPart).not.toHaveBeenCalled();
    expect(uploadAdapter.createFile).not.toHaveBeenCalled();
  });

  it("stops before merge when Baidu returns a mismatched part MD5", async () => {
    const content = Buffer.from("delivery");
    const uploadAdapter = successfulUploadAdapter();
    uploadAdapter.uploadPart.mockResolvedValue({ md5: md5(Buffer.from("different")) });
    const service = new BaiduPanDeliveryService(uploadAdapter);
    const root = resolve("output", "orders", "order-bad-receipt");

    await expect(service.uploadAndPrepareDelivery({
      accessToken: "mock-token",
      allowedLocalRoot: root,
      remotePath: "/简作交付/order-bad-receipt.zip",
      source: {
        localPath: resolve(root, "order-bad-receipt.zip"),
        size: content.length,
        blockList: [md5(content)],
        readPart: async () => content
      },
      automaticShare: false
    })).rejects.toMatchObject({ code: "PAN_UPLOAD_PART_MD5_MISMATCH" });

    expect(uploadAdapter.createFile).not.toHaveBeenCalled();
  });

  it("rejects a lookalike host returned as a share link", async () => {
    const uploadAdapter = successfulUploadAdapter();
    const shareAdapter: BaiduPanShareAdapter = {
      createShareLink: vi.fn(async (): Promise<BaiduPanShareResult> => ({ status: "ok", url: "https://evilbaidu.com/s/example" }))
    };
    const service = new BaiduPanDeliveryService(uploadAdapter, shareAdapter);

    await expect(service.uploadAndPrepareDelivery({
      accessToken: "secret",
      allowedLocalRoot: "C:\\orders",
      remotePath: "/简作交付/example.zip",
      source: {
        localPath: "C:\\orders\\example.zip",
        size: 1,
        blockList: [md5(new Uint8Array([1]))],
        readPart: async () => new Uint8Array([1])
      },
      automaticShare: true
    })).rejects.toMatchObject({ code: "PAN_SHARE_URL_INVALID" });
  });

  it("rejects traversal and out-of-root paths before invoking an upload adapter", async () => {
    const uploadAdapter = successfulUploadAdapter();
    const service = new BaiduPanDeliveryService(uploadAdapter);
    const root = resolve("output", "orders", "safe-order");
    const content = Buffer.from("delivery");
    const baseInput = {
      accessToken: "mock-token",
      allowedLocalRoot: root,
      source: {
        localPath: resolve(root, "delivery.zip"),
        size: content.length,
        blockList: [md5(content)],
        readPart: async () => content
      },
      automaticShare: false
    };

    await expect(service.uploadAndPrepareDelivery({ ...baseInput, remotePath: "/简作交付/../secrets.zip" }))
      .rejects.toMatchObject({ code: "PAN_REMOTE_PATH_INVALID" });
    await expect(service.uploadAndPrepareDelivery({
      ...baseInput,
      remotePath: "/简作交付/delivery.zip",
      source: { ...baseInput.source, localPath: resolve(root, "..", "outside.zip") }
    })).rejects.toMatchObject({ code: "PAN_LOCAL_PATH_FORBIDDEN" });
    expect(uploadAdapter.precreate).not.toHaveBeenCalled();
  });
});

describe("OfficialBaiduPanFetchTransport", () => {
  it("encodes OAuth forms without putting secrets in the URL", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({ access_token: "token", expires_in: 3600 }));
    const transport = new OfficialBaiduPanFetchTransport({ fetch: fetchMock });

    await transport.request({
      operation: "oauth_token",
      method: "POST",
      url: BAIDU_OAUTH_TOKEN_URL,
      form: {
        grant_type: "authorization_code",
        code: "temporary-code",
        client_id: "client id",
        client_secret: "secret&value",
        redirect_uri: oauthConfig.redirectUri,
        code_verifier: "verifier"
      },
      sensitiveKeys: ["code", "client_secret", "code_verifier"]
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [input, init] = fetchMock.mock.calls[0]!;
    expect(String(input)).toBe(BAIDU_OAUTH_TOKEN_URL);
    expect(String(input)).not.toContain("secret&value");
    expect(init?.redirect).toBe("error");
    expect(init?.credentials).toBe("omit");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/x-www-form-urlencoded;charset=UTF-8");
    const form = init?.body as URLSearchParams;
    expect(form.get("client_id")).toBe("client id");
    expect(form.get("client_secret")).toBe("secret&value");
  });

  it("encodes official query parameters and multipart content", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({ errno: 0, md5: "a".repeat(32) }));
    const transport = new OfficialBaiduPanFetchTransport({ fetch: fetchMock });
    const content = Buffer.from("safe upload part");

    await transport.request({
      operation: "upload_part",
      method: "POST",
      url: BAIDU_PAN_UPLOAD_API_URL,
      query: {
        method: "upload",
        type: "tmpfile",
        access_token: "token with symbols/+",
        path: "/简作交付/订单 1.zip",
        uploadid: "upload-id",
        partseq: 0
      },
      multipart: {
        fieldName: "file",
        fileName: "part-0.bin",
        contentType: "application/octet-stream",
        content
      },
      sensitiveKeys: ["access_token"]
    });

    const [input, init] = fetchMock.mock.calls[0]!;
    const url = new URL(String(input));
    expect(url.origin + url.pathname).toBe(BAIDU_PAN_UPLOAD_API_URL);
    expect(url.searchParams.get("access_token")).toBe("token with symbols/+");
    expect(url.searchParams.get("path")).toBe("/简作交付/订单 1.zip");
    expect(new Headers(init?.headers).has("content-type")).toBe(false);
    const multipart = init?.body as FormData;
    const file = multipart.get("file");
    expect(file).toBeInstanceOf(Blob);
    expect(await (file as Blob).text()).toBe(content.toString());
  });

  it("rejects non-official hosts, altered paths and redirects before fetch", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}));
    const transport = new OfficialBaiduPanFetchTransport({ fetch: fetchMock });
    const baseRequest: BaiduPanTransportRequest = {
      operation: "oauth_token",
      method: "POST",
      url: BAIDU_OAUTH_TOKEN_URL,
      form: { grant_type: "authorization_code" },
      sensitiveKeys: []
    };

    await expect(transport.request({ ...baseRequest, url: "https://openapi.baidu.com.evil.example/oauth/2.0/token" }))
      .rejects.toMatchObject({ code: "PAN_TRANSPORT_URL_FORBIDDEN" });
    await expect(transport.request({ ...baseRequest, url: "https://openapi.baidu.com/oauth/2.0/token/extra" }))
      .rejects.toMatchObject({ code: "PAN_TRANSPORT_URL_FORBIDDEN" });
    await expect(transport.request({ ...baseRequest, url: `${BAIDU_OAUTH_TOKEN_URL}?redirect=https://evil.example` }))
      .rejects.toMatchObject({ code: "PAN_TRANSPORT_URL_FORBIDDEN" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops reading oversized responses and rejects malformed JSON", async () => {
    const oversizedFetch = vi.fn(async () => new Response(JSON.stringify({ value: "x".repeat(100) }), {
      status: 200,
      headers: { "content-type": "application/json", "content-length": "112" }
    }));
    const oversizedTransport = new OfficialBaiduPanFetchTransport({ fetch: oversizedFetch, maxResponseBytes: 32 });
    const request: BaiduPanTransportRequest = {
      operation: "precreate",
      method: "POST",
      url: BAIDU_PAN_FILE_API_URL,
      query: { method: "precreate", access_token: "secret-token" },
      form: { path: "/简作交付/a.zip" },
      sensitiveKeys: ["access_token"]
    };

    await expect(oversizedTransport.request(request)).rejects.toMatchObject({ code: "PAN_TRANSPORT_RESPONSE_TOO_LARGE" });

    const malformedTransport = new OfficialBaiduPanFetchTransport({
      fetch: vi.fn(async () => new Response("not-json access_token=must-not-leak", { status: 502 }))
    });
    let failure: unknown;
    try {
      await malformedTransport.request(request);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "PAN_TRANSPORT_RESPONSE_INVALID" });
    expect(JSON.stringify(failure)).not.toContain("must-not-leak");
    expect((failure as Error).message).not.toContain("must-not-leak");
  });

  it("aborts timed-out requests and never exposes a fetch error containing a token", async () => {
    const hangingFetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    const timeoutTransport = new OfficialBaiduPanFetchTransport({ fetch: hangingFetch, timeoutMs: 5 });
    const request: BaiduPanTransportRequest = {
      operation: "create_file",
      method: "POST",
      url: BAIDU_PAN_FILE_API_URL,
      query: { method: "create", access_token: "timeout-secret-token" },
      form: { path: "/简作交付/a.zip" },
      sensitiveKeys: ["access_token"]
    };
    await expect(timeoutTransport.request(request)).rejects.toMatchObject({ code: "PAN_TRANSPORT_TIMEOUT" });

    const leakingFetch = vi.fn(async () => {
      throw new Error("request failed at https://pan.baidu.com/?access_token=network-secret-token");
    });
    const safeTransport = new OfficialBaiduPanFetchTransport({ fetch: leakingFetch });
    let failure: unknown;
    try {
      await safeTransport.request(request);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "PAN_TRANSPORT_FAILED", safeDetails: { errorType: "Error" } });
    expect(JSON.stringify(failure)).not.toContain("network-secret-token");
    expect((failure as Error).message).not.toContain("network-secret-token");
  });
});

function successfulUploadAdapter(): BaiduPanMultipartAdapter & {
  precreate: ReturnType<typeof vi.fn>;
  uploadPart: ReturnType<typeof vi.fn>;
  createFile: ReturnType<typeof vi.fn>;
} {
  return {
    precreate: vi.fn(async () => ({ uploadId: "upload-id", requiredPartIndexes: [0] })),
    uploadPart: vi.fn(async (input: { content: Uint8Array }) => ({ md5: md5(input.content) })),
    createFile: vi.fn(async (input) => ({
      fsId: "100",
      remotePath: input.remotePath,
      serverFileName: input.remotePath.split("/").at(-1) ?? "delivery.zip",
      size: input.size
    }))
  };
}

function jsonResponse(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}
