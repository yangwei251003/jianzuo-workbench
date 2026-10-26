import { describe, expect, it } from "vitest";
import { decryptSecret, deriveEncryptionKey, encryptSecret, hashPin, redact, verifyPin } from "./security.js";

describe("local secrets", () => {
  it("hashes the PIN and encrypts settings with authenticated encryption", async () => {
    const pin = "246810";
    const stored = await hashPin(pin);
    expect(await verifyPin(pin, stored)).toBe(true);
    expect(await verifyPin("111111", stored)).toBe(false);
    const salt = Buffer.alloc(16, 7).toString("base64");
    const key = await deriveEncryptionKey(pin, salt);
    const encrypted = encryptSecret("https://example.test/hook", key);
    expect(encrypted).not.toContain("example.test");
    expect(decryptSecret(encrypted, key)).toBe("https://example.test/hook");
  });

  it("redacts credentials, verification codes and remote codes from nested logs", () => {
    const output = redact({ cookie: "secret", nested: { access_token: "token-value", note: "Bearer abc.def 123456 https://example.test/cb?token=raw-value&ok=1" }, remoteCode: "765432" });
    expect(output).toEqual({ cookie: "[REDACTED]", nested: { access_token: "[REDACTED]", note: "Bearer [REDACTED] [CODE] https://example.test/cb?token=[REDACTED]&ok=1" }, remoteCode: "[REDACTED]" });
  });
});
