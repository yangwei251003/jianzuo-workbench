import { describe, expect, it } from "vitest";
import { protectWithCurrentUserDpapi, unprotectWithCurrentUserDpapi } from "./dpapi.js";

describe("Windows CurrentUser DPAPI", () => {
  it.runIf(process.platform === "win32")("protects and restores bytes without retaining plaintext", async () => {
    const plaintext = Buffer.from("简作-DPAPI-round-trip-secret-7f3d8f15", "utf8");
    const ciphertext = await protectWithCurrentUserDpapi(plaintext);

    expect(ciphertext.length).toBeGreaterThan(0);
    expect(ciphertext.equals(plaintext)).toBe(false);
    expect(ciphertext.includes(plaintext)).toBe(false);
    expect(ciphertext.toString("utf8")).not.toContain(plaintext.toString("utf8"));

    const restored = await unprotectWithCurrentUserDpapi(ciphertext);
    expect(restored.equals(plaintext)).toBe(true);

    plaintext.fill(0);
    restored.fill(0);
  }, 15_000);

  it("fails clearly outside Windows", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { configurable: true, value: "linux" });

    try {
      await expect(protectWithCurrentUserDpapi(Buffer.from("secret"))).rejects.toThrow(
        "Windows DPAPI 仅可在 Windows 上使用"
      );
    } finally {
      Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
    }
  });
});
