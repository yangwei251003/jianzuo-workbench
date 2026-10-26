import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt as scryptCallback } from "node:crypto";
import {
  appendFileSync, closeSync, copyFileSync, createReadStream, createWriteStream, existsSync, fstatSync, mkdirSync,
  mkdtempSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, writeSync
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import type { WorkbenchDatabase } from "@jianzuo/database";
import { verifyPin } from "@jianzuo/core";

const scrypt = promisify(scryptCallback);
const HEADER_V1 = Buffer.from("JIANZUO-BACKUP-V1\n", "utf8");
const HEADER_V2 = Buffer.from("JIANZUO-BACKUP-V2\n", "utf8");
const BUNDLE_MAGIC = Buffer.from("JZB2DATA\n", "utf8");
const COPY_BUFFER_SIZE = 1024 * 1024;

type BackupArtifact = { assetId: string; relativePath: string; size: number; sha256: string };
type BackupManifest = {
  version: 2;
  createdAt: string;
  database: { relativePath: "jianzuo.sqlite"; size: number; sha256: string };
  artifacts: BackupArtifact[];
};

export type RestoreOptions = {
  /** Test-only fault injection. Production callers should leave this unset. */
  beforeApplyArtifact?: (relativePath: string, index: number) => void;
};

export async function createEncryptedBackup(
  db: WorkbenchDatabase,
  dataDir: string,
  pin: string,
  kind: "daily" | "weekly" | "manual"
): Promise<{ path: string; size: number; sha256: string; artifacts: number }> {
  const pinHash = db.getSetting("pin_hash");
  if (!pinHash || !(await verifyPin(pin, pinHash))) throw new Error("PIN 不正确");
  const backupDir = resolve(dataDir, "backups");
  const runtimeDir = resolve(dataDir, "runtime");
  mkdirSync(backupDir, { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(":", "-").replace(".", "-");
  const snapshot = resolve(runtimeDir, `snapshot-${stamp}.sqlite`);
  const bundlePath = resolve(runtimeDir, `bundle-${stamp}.bin`);
  const target = resolve(backupDir, `${kind}-${stamp}.jzb`);

  try {
    const sqlPath = snapshot.replaceAll("'", "''");
    const source = new DatabaseSync(db.path);
    try { source.exec(`VACUUM INTO '${sqlPath}'`); } finally { source.close(); }

    const databaseFile = hashFile(snapshot);
    const artifacts = collectControlledArtifacts(db, dataDir);
    const manifest: BackupManifest = {
      version: 2,
      createdAt: new Date().toISOString(),
      database: { relativePath: "jianzuo.sqlite", ...databaseFile },
      artifacts
    };
    writePlainBundle(bundlePath, snapshot, manifest, dataDir);
    await encryptBundle(bundlePath, target, pin);

    const output = hashFile(target);
    db.recordBackup(kind, target, output.sha256);
    rotateBackups(backupDir, "daily", 7);
    rotateBackups(backupDir, "weekly", 4);
    return { path: target, size: output.size, sha256: output.sha256, artifacts: artifacts.length };
  } catch (error) {
    rmSync(target, { force: true });
    throw error;
  } finally {
    rmSync(snapshot, { force: true });
    rmSync(bundlePath, { force: true });
  }
}

export async function ensureAutomaticBackups(db: WorkbenchDatabase, dataDir: string, pin: string): Promise<Array<{ kind: "daily" | "weekly"; path: string }>> {
  const backupDir = resolve(dataDir, "backups");
  mkdirSync(backupDir, { recursive: true });
  const files = readdirSync(backupDir).filter((name) => name.endsWith(".jzb"));
  const today = new Date().toISOString().slice(0, 10);
  const created: Array<{ kind: "daily" | "weekly"; path: string }> = [];
  if (!files.some((name) => name.startsWith(`daily-${today}`))) {
    const backup = await createEncryptedBackup(db, dataDir, pin, "daily");
    created.push({ kind: "daily", path: backup.path });
  }
  const latestWeekly = files.filter((name) => name.startsWith("weekly-")).map((name) => statSync(resolve(backupDir, name)).mtimeMs).sort((a, b) => b - a)[0] ?? 0;
  if (Date.now() - latestWeekly >= 7 * 24 * 60 * 60 * 1_000) {
    const backup = await createEncryptedBackup(db, dataDir, pin, "weekly");
    created.push({ kind: "weekly", path: backup.path });
  }
  return created;
}

export async function restoreEncryptedBackup(
  sourcePath: string,
  targetDatabasePath: string,
  dataDir: string,
  pin: string,
  options: RestoreOptions = {}
): Promise<{ target: string; integrity: string; artifactsRestored: number }> {
  const header = readAt(sourcePath, 0, HEADER_V2.length);
  if (header.equals(HEADER_V2)) return restoreV2(sourcePath, targetDatabasePath, dataDir, pin, options);
  if (header.equals(HEADER_V1)) {
    const legacy = await restoreV1(sourcePath, targetDatabasePath, dataDir, pin);
    return { ...legacy, artifactsRestored: 0 };
  }
  throw new Error("不是有效的简作备份文件");
}

function collectControlledArtifacts(db: WorkbenchDatabase, dataDir: string): BackupArtifact[] {
  const seen = new Set<string>();
  const collected: BackupArtifact[] = [];
  for (const row of db.listAssets()) {
    const absolutePath = resolve(String(row.path));
    const relativePath = relative(resolve(dataDir), absolutePath);
    if (isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${sep}`)) continue;
    const portablePath = relativePath.split(sep).join("/");
    if (!portablePath.startsWith("artifacts/") || seen.has(portablePath)) continue;
    if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) throw new Error(`已登记产物缺失，备份已停止：${portablePath}`);
    seen.add(portablePath);
    collected.push({ assetId: String(row.id), relativePath: portablePath, ...hashFile(absolutePath) });
  }
  return collected;
}

function writePlainBundle(path: string, snapshot: string, manifest: BackupManifest, dataDir: string): void {
  const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(manifestBytes.length);
  const output = openSync(path, "wx");
  try {
    writeSync(output, BUNDLE_MAGIC);
    writeSync(output, length);
    writeSync(output, manifestBytes);
    appendFileToDescriptor(output, snapshot);
    for (const artifact of manifest.artifacts) appendFileToDescriptor(output, resolve(dataDir, ...artifact.relativePath.split("/")));
  } finally { closeSync(output); }
}

async function encryptBundle(bundlePath: string, target: string, pin: string): Promise<void> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = (await scrypt(pin, salt, 32)) as Buffer;
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(HEADER_V2);
    writeFileSync(target, Buffer.concat([HEADER_V2, salt, iv]), { flag: "wx" });
    await pipeline(createReadStream(bundlePath), cipher, createWriteStream(target, { flags: "a" }));
    appendFileSync(target, cipher.getAuthTag());
  } finally { key.fill(0); }
}

async function restoreV2(
  sourcePath: string,
  targetDatabasePath: string,
  dataDir: string,
  pin: string,
  options: RestoreOptions
): Promise<{ target: string; integrity: string; artifactsRestored: number }> {
  const runtimeDir = resolve(dataDir, "runtime");
  mkdirSync(runtimeDir, { recursive: true });
  const plainPath = resolve(runtimeDir, `restore-bundle-${Date.now()}-${randomBytes(4).toString("hex")}.bin`);
  const databaseTemp = resolve(runtimeDir, `restore-db-${Date.now()}-${randomBytes(4).toString("hex")}.sqlite`);
  const stagingRoot = mkdtempSync(resolve(runtimeDir, "restore-assets-"));
  const fileSize = statSync(sourcePath).size;
  const ciphertextStart = HEADER_V2.length + 16 + 12;
  if (fileSize <= ciphertextStart + 16) throw new Error("备份文件已截断");
  const salt = readAt(sourcePath, HEADER_V2.length, 16);
  const iv = readAt(sourcePath, HEADER_V2.length + 16, 12);
  const tag = readAt(sourcePath, fileSize - 16, 16);
  const key = (await scrypt(pin, salt, 32)) as Buffer;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(HEADER_V2);
    decipher.setAuthTag(tag);
    try {
      await pipeline(
        createReadStream(sourcePath, { start: ciphertextStart, end: fileSize - 17 }),
        decipher,
        createWriteStream(plainPath, { flags: "wx" })
      );
    } catch {
      throw new Error("PIN 不正确或备份文件已损坏");
    }

    const bundle = openSync(plainPath, "r");
    let manifest: BackupManifest;
    try {
      let offset = 0;
      const magic = readFromDescriptor(bundle, offset, BUNDLE_MAGIC.length); offset += BUNDLE_MAGIC.length;
      if (!magic.equals(BUNDLE_MAGIC)) throw new Error("备份数据容器无效");
      const manifestLength = readFromDescriptor(bundle, offset, 4).readUInt32BE(); offset += 4;
      if (manifestLength <= 0 || manifestLength > 16 * 1024 * 1024) throw new Error("备份清单大小异常");
      manifest = JSON.parse(readFromDescriptor(bundle, offset, manifestLength).toString("utf8")) as BackupManifest; offset += manifestLength;
      validateManifest(manifest);

      const extractedDb = extractSegment(bundle, offset, manifest.database.size, databaseTemp); offset = extractedDb.offset;
      if (extractedDb.sha256 !== manifest.database.sha256) throw new Error("备份数据库哈希不一致");
      assertSqliteIntegrity(databaseTemp);

      for (const artifact of manifest.artifacts) {
        const stagePath = safeRestorePath(stagingRoot, artifact.relativePath);
        const extracted = extractSegment(bundle, offset, artifact.size, stagePath); offset = extracted.offset;
        if (extracted.sha256 !== artifact.sha256) throw new Error(`产物哈希不一致：${artifact.relativePath}`);
      }
      if (offset !== fstatSync(bundle).size) throw new Error("备份数据长度与清单不一致");
    } finally { closeSync(bundle); }

    const restoredDb = new DatabaseSync(databaseTemp);
    try {
      const update = restoredDb.prepare("UPDATE assets SET path=? WHERE id=?");
      for (const artifact of manifest.artifacts) update.run(safeRestorePath(resolve(dataDir), artifact.relativePath), artifact.assetId);
    } finally { restoredDb.close(); }
    assertSqliteIntegrity(databaseTemp);

    const integrity = applyRestoreAtomically(databaseTemp, targetDatabasePath, dataDir, manifest.artifacts, stagingRoot, options);
    return { target: targetDatabasePath, integrity, artifactsRestored: manifest.artifacts.length };
  } finally {
    key.fill(0);
    rmSync(plainPath, { force: true });
    rmSync(databaseTemp, { force: true });
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

async function restoreV1(sourcePath: string, targetDatabasePath: string, dataDir: string, pin: string): Promise<{ target: string; integrity: string }> {
  const payload = readFileSync(sourcePath);
  if (payload.length < HEADER_V1.length + 44 || !payload.subarray(0, HEADER_V1.length).equals(HEADER_V1)) throw new Error("不是有效的简作备份文件");
  let offset = HEADER_V1.length;
  const salt = payload.subarray(offset, offset += 16);
  const iv = payload.subarray(offset, offset += 12);
  const tag = payload.subarray(offset, offset += 16);
  const ciphertext = payload.subarray(offset);
  const key = (await scrypt(pin, salt, 32)) as Buffer;
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  let plaintext: Buffer;
  try { plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]); }
  catch { throw new Error("PIN 不正确或备份文件已损坏"); }
  finally { key.fill(0); }

  const runtimeDir = resolve(dataDir, "runtime");
  mkdirSync(runtimeDir, { recursive: true });
  const tempPath = resolve(runtimeDir, `restore-${Date.now()}.sqlite`);
  try {
    writeFileSync(tempPath, plaintext, { flag: "wx" });
    assertSqliteIntegrity(tempPath);
    const integrity = applyRestoreAtomically(tempPath, targetDatabasePath, dataDir, [], undefined, {});
    return { target: targetDatabasePath, integrity };
  } finally { rmSync(tempPath, { force: true }); }
}

type RestoreRollbackFile = { target: string; rollbackPath?: string; modified?: boolean };

function applyRestoreAtomically(
  candidateDatabasePath: string,
  targetDatabasePath: string,
  dataDir: string,
  artifacts: BackupArtifact[],
  stagingRoot: string | undefined,
  options: RestoreOptions
): string {
  const runtimeDir = resolve(dataDir, "runtime");
  mkdirSync(runtimeDir, { recursive: true });
  const rollbackRoot = mkdtempSync(resolve(runtimeDir, "restore-rollback-"));
  const token = randomBytes(6).toString("hex");
  const databaseCandidate = resolve(dirname(targetDatabasePath), `.${basename(targetDatabasePath)}.restore-${token}.tmp`);
  const databaseFiles: RestoreRollbackFile[] = [
    { target: targetDatabasePath },
    { target: `${targetDatabasePath}-wal` },
    { target: `${targetDatabasePath}-shm` }
  ];
  const artifactFiles: RestoreRollbackFile[] = [];
  let preserveRollback = false;

  try {
    mkdirSync(dirname(targetDatabasePath), { recursive: true });
    copyFileSync(candidateDatabasePath, databaseCandidate);
    for (const [index, file] of databaseFiles.entries()) {
      if (!existsSync(file.target)) continue;
      const rollbackPath = resolve(rollbackRoot, `database-${index}`);
      renameSync(file.target, rollbackPath);
      file.rollbackPath = rollbackPath;
      file.modified = true;
    }
    renameSync(databaseCandidate, targetDatabasePath);
    databaseFiles[0]!.modified = true;

    for (const [index, artifact] of artifacts.entries()) {
      options.beforeApplyArtifact?.(artifact.relativePath, index);
      if (!stagingRoot) throw new Error("恢复产物暂存目录缺失");
      const source = safeRestorePath(stagingRoot, artifact.relativePath);
      const target = safeRestorePath(resolve(dataDir), artifact.relativePath);
      const targetTemp = resolve(dirname(target), `.${basename(target)}.restore-${token}.tmp`);
      const rollback: RestoreRollbackFile = { target };
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, targetTemp);
      if (existsSync(target)) {
        const rollbackPath = safeRestorePath(resolve(rollbackRoot, "artifacts"), artifact.relativePath);
        mkdirSync(dirname(rollbackPath), { recursive: true });
        renameSync(target, rollbackPath);
        rollback.rollbackPath = rollbackPath;
      }
      rollback.modified = true;
      artifactFiles.push(rollback);
      try { renameSync(targetTemp, target); }
      finally { rmSync(targetTemp, { force: true }); }
    }

    const integrity = assertSqliteIntegrity(targetDatabasePath);
    rmSync(rollbackRoot, { recursive: true, force: true });
    return integrity;
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const file of artifactFiles.reverse()) rollbackFile(file, rollbackErrors);
    for (const file of databaseFiles.reverse()) rollbackFile(file, rollbackErrors);
    if (rollbackErrors.length > 0) {
      preserveRollback = true;
      const cause = error instanceof Error ? error.message : String(error);
      throw new Error(`恢复失败，且自动回滚未完全成功：${cause}；${rollbackErrors.join("；")}；原文件保留在 ${rollbackRoot}`);
    }
    throw error;
  } finally {
    rmSync(databaseCandidate, { force: true });
    if (!preserveRollback) rmSync(rollbackRoot, { recursive: true, force: true });
  }
}

function rollbackFile(file: RestoreRollbackFile, errors: string[]): void {
  if (!file.modified) return;
  try {
    rmSync(file.target, { force: true });
    if (file.rollbackPath && existsSync(file.rollbackPath)) {
      mkdirSync(dirname(file.target), { recursive: true });
      renameSync(file.rollbackPath, file.target);
    }
  } catch (error) {
    errors.push(`${file.target}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateManifest(value: BackupManifest): void {
  if (!value || value.version !== 2 || !value.database || !Array.isArray(value.artifacts)) throw new Error("备份清单无效");
  validateSize(value.database.size);
  if (!/^[a-f0-9]{64}$/.test(value.database.sha256)) throw new Error("备份数据库哈希无效");
  if (value.artifacts.length > 100_000) throw new Error("备份产物数量异常");
  const paths = new Set<string>();
  const assetIds = new Set<string>();
  for (const artifact of value.artifacts) {
    if (!artifact.assetId || !artifact.relativePath?.startsWith("artifacts/") || !/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new Error("备份产物清单无效");
    if (paths.has(artifact.relativePath) || assetIds.has(artifact.assetId)) throw new Error("备份产物清单包含重复项");
    paths.add(artifact.relativePath);
    assetIds.add(artifact.assetId);
    validateSize(artifact.size);
  }
}

function validateSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("备份文件大小无效");
}

function safeRestorePath(root: string, portablePath: string): string {
  if (!portablePath || portablePath.includes("\\") || portablePath.startsWith("/") || portablePath.split("/").some((part) => part === ".." || part === "")) {
    throw new Error("备份中包含不安全路径");
  }
  const target = resolve(root, ...portablePath.split("/"));
  const relativeTarget = relative(resolve(root), target);
  if (isAbsolute(relativeTarget) || relativeTarget === ".." || relativeTarget.startsWith(`..${sep}`)) throw new Error("备份路径越界");
  return target;
}

function assertSqliteIntegrity(path: string): string {
  const candidate = new DatabaseSync(path, { readOnly: true });
  let integrity = "";
  try { integrity = String((candidate.prepare("PRAGMA integrity_check").get() as { integrity_check?: string }).integrity_check ?? ""); }
  finally { candidate.close(); }
  if (integrity.toLowerCase() !== "ok") throw new Error(`备份数据库完整性检查失败：${integrity || "unknown"}`);
  return integrity;
}

function appendFileToDescriptor(output: number, sourcePath: string): void {
  const source = openSync(sourcePath, "r");
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_SIZE);
  try {
    let offset = 0;
    while (true) {
      const bytes = readSync(source, buffer, 0, buffer.length, offset);
      if (!bytes) break;
      writeSync(output, buffer, 0, bytes);
      offset += bytes;
    }
  } finally { closeSync(source); }
}

function extractSegment(source: number, offset: number, size: number, targetPath: string): { offset: number; sha256: string } {
  mkdirSync(dirname(targetPath), { recursive: true });
  const output = openSync(targetPath, "wx");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_SIZE);
  let remaining = size;
  try {
    while (remaining > 0) {
      const wanted = Math.min(buffer.length, remaining);
      const bytes = readSync(source, buffer, 0, wanted, offset);
      if (!bytes) throw new Error("备份数据已截断");
      writeSync(output, buffer, 0, bytes);
      hash.update(buffer.subarray(0, bytes));
      offset += bytes;
      remaining -= bytes;
    }
  } finally { closeSync(output); }
  return { offset, sha256: hash.digest("hex") };
}

function hashFile(path: string): { size: number; sha256: string } {
  const input = openSync(path, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_SIZE);
  let size = 0;
  try {
    while (true) {
      const bytes = readSync(input, buffer, 0, buffer.length, size);
      if (!bytes) break;
      hash.update(buffer.subarray(0, bytes));
      size += bytes;
    }
  } finally { closeSync(input); }
  return { size, sha256: hash.digest("hex") };
}

function readAt(path: string, offset: number, length: number): Buffer {
  const descriptor = openSync(path, "r");
  try { return readFromDescriptor(descriptor, offset, length); }
  finally { closeSync(descriptor); }
}

function readFromDescriptor(descriptor: number, offset: number, length: number): Buffer {
  const output = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const bytes = readSync(descriptor, output, read, length - read, offset + read);
    if (!bytes) throw new Error("备份文件已截断");
    read += bytes;
  }
  return output;
}

function rotateBackups(directory: string, prefix: string, keep: number): void {
  if (!existsSync(directory)) return;
  const files = readdirSync(directory).filter((name) => name.startsWith(`${prefix}-`) && name.endsWith(".jzb")).sort().reverse();
  files.slice(keep).forEach((name) => rmSync(resolve(directory, basename(name)), { force: true }));
}
