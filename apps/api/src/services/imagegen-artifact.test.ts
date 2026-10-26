import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { verifyImageGenArtifact, type VerifyImageGenArtifactInput } from "./imagegen-artifact.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(): Promise<{
  root: string;
  versionDirectory: string;
  beforeImagePath: string;
  beforeSha256: string;
  candidateOutputPath: string;
  input: VerifyImageGenArtifactInput;
}> {
  const root = mkdtempSync(resolve(tmpdir(), "jianzuo-imagegen-artifact-"));
  roots.push(root);
  const versionDirectory = resolve(root, "artifacts", "products", "image-text-edit", "v3");
  mkdirSync(versionDirectory, { recursive: true });
  const beforeImagePath = resolve(versionDirectory, "02_案例效果.png");
  const candidateOutputPath = resolve(versionDirectory, "02_案例效果.imagegen.png");
  await sharp({ create: { width: 512, height: 512, channels: 4, background: "#102a43" } }).png().toFile(beforeImagePath);
  const beforeSha256 = createHash("sha256").update(readFileSync(beforeImagePath)).digest("hex");
  return {
    root,
    versionDirectory,
    beforeImagePath,
    beforeSha256,
    candidateOutputPath,
    input: { productsRoot: resolve(root, "artifacts", "products"), beforeImagePath, beforeSha256, candidateOutputPath, productSlug: "image-text-edit", versionDirectory }
  };
}

describe("ImageGen artifact verification", () => {
  it("rejects a candidate path that escapes the product version directory", async () => {
    const data = await fixture();
    const outsidePath = resolve(data.root, "outside.png");
    await sharp({ create: { width: 512, height: 512, channels: 4, background: "#f4b740" } }).png().toFile(outsidePath);

    const result = await verifyImageGenArtifact({ ...data.input, candidateOutputPath: outsidePath });

    expect(result.status).toBe("needs_user");
    expect(result.data).toMatchObject({ reason: "INVALID_PATH", suggestion: "USE_LOCAL_TEMPLATE" });
    expect(result.nextActions).toContainEqual(expect.objectContaining({ type: "USE_LOCAL_TEMPLATE" }));
  });

  it("rejects a lookalike artifacts tree outside the configured products root", async () => {
    const data = await fixture();
    await sharp({ create: { width: 512, height: 512, channels: 4, background: "#f4b740" } }).png().toFile(data.candidateOutputPath);

    const result = await verifyImageGenArtifact({ ...data.input, productsRoot: resolve(data.root, "different-products-root") });

    expect(result.status).toBe("needs_user");
    expect(result.data).toMatchObject({ reason: "INVALID_PATH" });
  });

  it("rejects a file with a PNG signature that cannot be decoded", async () => {
    const data = await fixture();
    writeFileSync(data.candidateOutputPath, Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("not-a-decodable-png")
    ]));

    const result = await verifyImageGenArtifact(data.input);

    expect(result.status).toBe("needs_user");
    expect(result.data).toMatchObject({ reason: "INVALID_PNG", suggestion: "USE_LOCAL_TEMPLATE" });
  });

  it("rejects a candidate whose hash is unchanged", async () => {
    const data = await fixture();
    copyFileSync(data.beforeImagePath, data.candidateOutputPath);

    const result = await verifyImageGenArtifact(data.input);

    expect(result.status).toBe("needs_user");
    expect(result.data).toMatchObject({ reason: "UNCHANGED_OUTPUT", fallbackPath: data.beforeImagePath });
  });

  it("returns versioned Asset metadata for a genuinely replaced PNG", async () => {
    const data = await fixture();
    await sharp({ create: { width: 1536, height: 1024, channels: 4, background: "#eaf4ee" } }).png().toFile(data.candidateOutputPath);

    const result = await verifyImageGenArtifact(data.input);

    expect(result.status).toBe("ok");
    expect(result.data).toMatchObject({
      kind: "product_case_image",
      source: "codex_imagegen",
      productSlug: "image-text-edit",
      version: 3,
      path: data.candidateOutputPath,
      mimeType: "image/png",
      width: 1536,
      height: 1024,
      replaces: { path: data.beforeImagePath, sha256: data.beforeSha256 }
    });
    expect(result.data).toHaveProperty("sha256");
    expect((result.data as { sha256: string }).sha256).not.toBe(data.beforeSha256);
    expect(result.artifacts).toEqual([{ kind: "product_case_image", path: data.candidateOutputPath }]);
  });

  it("returns a structured fallback when ImageGen quota is exhausted", async () => {
    const data = await fixture();
    const result = await verifyImageGenArtifact({ ...data.input, generationOutcome: "quota_exhausted" });

    expect(result.status).toBe("needs_user");
    expect(result.data).toMatchObject({ reason: "QUOTA_EXHAUSTED", suggestion: "USE_LOCAL_TEMPLATE" });
  });

  it("returns a structured fallback when no output file was generated", async () => {
    const data = await fixture();
    const result = await verifyImageGenArtifact(data.input);

    expect(result.status).toBe("needs_user");
    expect(result.data).toMatchObject({ reason: "NOT_GENERATED", suggestion: "USE_LOCAL_TEMPLATE" });
  });
});
