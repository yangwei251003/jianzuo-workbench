import { createHash, timingSafeEqual } from "node:crypto";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  BAIDU_UPLOAD_PART_BYTES,
  BaiduPanSafeError,
  type BaiduPanUploadSource
} from "./baidu-pan.js";

/**
 * Creates a restart-safe upload source without retaining an open file handle.
 * Every part is read from the immutable size snapshot and upload validation
 * re-checks the path boundary before any network request is made.
 */
export function createBaiduPanFileSource(localPathValue: string): BaiduPanUploadSource {
  if (!isAbsolute(localPathValue) || localPathValue.includes("\0")) {
    throw new BaiduPanSafeError("PAN_LOCAL_PATH_INVALID", "百度上传文件必须使用有效的绝对路径");
  }
  const localPath = resolve(localPathValue);
  let size: number;
  try {
    const stats = statSync(localPath);
    if (!stats.isFile() || !Number.isSafeInteger(stats.size) || stats.size <= 0) throw new Error("not-file");
    size = stats.size;
  } catch {
    throw new BaiduPanSafeError("PAN_LOCAL_FILE_INVALID", "百度上传文件不存在或不是普通文件");
  }

  const blockList: string[] = [];
  const handle = openSync(localPath, "r");
  try {
    for (let offset = 0; offset < size; offset += BAIDU_UPLOAD_PART_BYTES) {
      const length = Math.min(BAIDU_UPLOAD_PART_BYTES, size - offset);
      const bytes = readExact(handle, length, offset);
      blockList.push(createHash("md5").update(bytes).digest("hex"));
    }
  } finally {
    closeSync(handle);
  }

  return {
    localPath,
    size,
    blockList,
    async readPart(index: number): Promise<Uint8Array> {
      if (!Number.isInteger(index) || index < 0 || index >= blockList.length) {
        throw new BaiduPanSafeError("PAN_PART_INDEX_INVALID", "百度上传分片索引超出范围");
      }
      const offset = index * BAIDU_UPLOAD_PART_BYTES;
      const length = Math.min(BAIDU_UPLOAD_PART_BYTES, size - offset);
      const partHandle = openSync(localPath, "r");
      try {
        const current = statSync(localPath);
        if (!current.isFile() || current.size !== size) {
          throw new BaiduPanSafeError("PAN_LOCAL_FILE_CHANGED", "交付文件在上传期间发生变化，已停止上传");
        }
        const bytes = readExact(partHandle, length, offset);
        if (!partMd5Matches(bytes, blockList[index]!)) {
          throw new BaiduPanSafeError("PAN_LOCAL_FILE_CHANGED", "交付文件在上传期间发生变化，已停止上传");
        }
        return bytes;
      } finally {
        closeSync(partHandle);
      }
    }
  };
}

function partMd5Matches(bytes: Uint8Array, expectedHex: string): boolean {
  const actual = createHash("md5").update(bytes).digest();
  const expected = Buffer.from(expectedHex, "hex");
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}

function readExact(handle: number, length: number, position: number): Buffer {
  const bytes = Buffer.allocUnsafe(length);
  let total = 0;
  while (total < length) {
    const count = readSync(handle, bytes, total, length - total, position + total);
    if (count <= 0) throw new BaiduPanSafeError("PAN_LOCAL_FILE_TRUNCATED", "交付文件读取不完整，已停止上传");
    total += count;
  }
  return bytes;
}
