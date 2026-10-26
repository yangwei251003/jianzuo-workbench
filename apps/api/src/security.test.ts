import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";

afterEach(() => vi.unstubAllEnvs());

describe("local security boundary", () => {
  it("rejects any non-loopback bind address", () => {
    vi.stubEnv("JIANZUO_HOST", "0.0.0.0");
    expect(() => loadConfig()).toThrow(/只能监听 127\.0\.0\.1/);
  });

  it("keeps the MV3 extension free of cookie permission", () => {
    const manifestPath = resolve(import.meta.dirname, "..", "..", "extension", "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { manifest_version: number; permissions: string[] };
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions).not.toContain("cookies");
  });
});
