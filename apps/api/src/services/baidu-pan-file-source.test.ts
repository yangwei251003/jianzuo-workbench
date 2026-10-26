import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BAIDU_UPLOAD_PART_BYTES } from "./baidu-pan.js";
import { createBaiduPanFileSource } from "./baidu-pan-file-source.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("Baidu Pan file source", () => {
  it("creates ordered 4 MiB blocks and reads exact parts", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "jianzuo-baidu-source-"));
    roots.push(root);
    const path = resolve(root, "delivery.zip");
    const bytes = Buffer.alloc(BAIDU_UPLOAD_PART_BYTES + 17, 0x61);
    writeFileSync(path, bytes);

    const source = createBaiduPanFileSource(path);

    expect(source.size).toBe(bytes.length);
    expect(source.blockList).toEqual([
      createHash("md5").update(bytes.subarray(0, BAIDU_UPLOAD_PART_BYTES)).digest("hex"),
      createHash("md5").update(bytes.subarray(BAIDU_UPLOAD_PART_BYTES)).digest("hex")
    ]);
    const firstPart = Buffer.from(await source.readPart(0));
    const secondPart = Buffer.from(await source.readPart(1));
    expect(firstPart.length).toBe(BAIDU_UPLOAD_PART_BYTES);
    expect(secondPart.length).toBe(17);
    expect(createHash("sha256").update(firstPart).digest("hex")).toBe(
      createHash("sha256").update(bytes.subarray(0, BAIDU_UPLOAD_PART_BYTES)).digest("hex")
    );
    expect(secondPart).toEqual(bytes.subarray(BAIDU_UPLOAD_PART_BYTES));
  });

  it("stops when the file changes after the source snapshot", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "jianzuo-baidu-source-"));
    roots.push(root);
    const path = resolve(root, "delivery.zip");
    writeFileSync(path, Buffer.from("first"));
    const source = createBaiduPanFileSource(path);
    writeFileSync(path, Buffer.from("changed-size"));

    await expect(source.readPart(0)).rejects.toMatchObject({ code: "PAN_LOCAL_FILE_CHANGED" });
  });

  it("stops when the file is replaced with different content of the same size", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "jianzuo-baidu-source-"));
    roots.push(root);
    const path = resolve(root, "delivery.zip");
    writeFileSync(path, Buffer.from("first"));
    const source = createBaiduPanFileSource(path);
    writeFileSync(path, Buffer.from("other"));

    await expect(source.readPart(0)).rejects.toMatchObject({ code: "PAN_LOCAL_FILE_CHANGED" });
  });
});
