import { describe, expect, it, vi } from "vitest";
import { postHttpsWebhook } from "./webhook.js";

describe("webhook transport", () => {
  it("allows HTTPS and sends only the structured event", async () => {
    let captured: { url: string; body: string } | null = null;
    const fetchMock = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = { url: String(input), body: String(init?.body ?? "") };
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    await postHttpsWebhook("https://example.test/jianzuo", {
      event: "ACTION_RESULT_UNKNOWN", severity: "critical", summary: "结果未知，已停止重试", occurredAt: "2026-08-30T12:00:00.000Z"
    }, fetchMock as typeof fetch);
    expect(captured).not.toBeNull();
    expect(captured!.url).toBe("https://example.test/jianzuo");
    expect(captured!.body).toContain("ACTION_RESULT_UNKNOWN");
    expect(captured!.body).not.toContain("cookie");
  });

  it("rejects plain HTTP before making a request", async () => {
    const fetchMock = vi.fn();
    await expect(postHttpsWebhook("http://127.0.0.1/hook", {
      event: "TEST", severity: "info", summary: "test", occurredAt: new Date().toISOString()
    }, fetchMock as typeof fetch)).rejects.toThrow(/仅允许 HTTPS/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
