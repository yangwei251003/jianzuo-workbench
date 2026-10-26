import { redact } from "./security.js";
import { unprotectWithCurrentUserDpapi } from "./dpapi.js";

export type WebhookEvent = {
  event: string;
  severity: "info" | "warning" | "critical";
  summary: string;
  occurredAt: string;
  correlationId?: string;
};

export async function postHttpsWebhook(url: string, event: WebhookEvent, fetchImpl: typeof fetch = fetch): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("Webhook 仅允许 HTTPS 地址");
  const response = await fetchImpl(parsed, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "Jianzuo-Local-Workbench/0.1" },
    body: JSON.stringify(redact(event)),
    redirect: "error",
    signal: AbortSignal.timeout(5_000)
  });
  if (!response.ok) throw new Error(`Webhook 返回 HTTP ${response.status}`);
}

export async function postDpapiProtectedWebhook(ciphertextBase64: string, event: WebhookEvent, fetchImpl: typeof fetch = fetch): Promise<void> {
  const ciphertext = Buffer.from(ciphertextBase64, "base64");
  const plaintext = await unprotectWithCurrentUserDpapi(ciphertext);
  try {
    await postHttpsWebhook(plaintext.toString("utf8"), event, fetchImpl);
  } finally {
    plaintext.fill(0);
    ciphertext.fill(0);
  }
}
