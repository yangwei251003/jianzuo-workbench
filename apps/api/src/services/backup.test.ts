import { existsSync, readFileSync, rmSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { hashPin } from "@jianzuo/core";
import { WorkbenchDatabase } from "@jianzuo/database";
import { createEncryptedBackup, restoreEncryptedBackup } from "./backup.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));

describe("encrypted backup", () => {
  it("round-trips SQLite and indexed artifacts while rejecting a wrong PIN", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jianzuo-backup-"));
    dirs.push(dir);
    const pin = "246810";
    const db = new WorkbenchDatabase(join(dir, "source.sqlite"));
    db.seed();
    db.setSetting("pin_hash", await hashPin(pin));
    const artifactPath = join(dir, "artifacts", "products", "example.txt");
    mkdirSync(join(dir, "artifacts", "products"), { recursive: true });
    writeFileSync(artifactPath, "verified artifact", "utf8");
    db.saveAsset({ kind: "test", path: artifactPath, source: "test" });

    const backup = await createEncryptedBackup(db, dir, pin, "manual");
    expect(backup.artifacts).toBe(1);
    expect(readFileSync(backup.path).subarray(0, 18).toString("utf8")).toContain("JIANZUO-BACKUP");
    await expect(restoreEncryptedBackup(backup.path, join(dir, "wrong.sqlite"), dir, "111111")).rejects.toThrow(/PIN 不正确|已损坏/);

    rmSync(artifactPath, { force: true });
    const restoredPath = join(dir, "restored.sqlite");
    const restored = await restoreEncryptedBackup(backup.path, restoredPath, dir, pin);
    expect(restored.integrity).toBe("ok");
    expect(restored.artifactsRestored).toBe(1);
    expect(existsSync(artifactPath)).toBe(true);
    expect(readFileSync(artifactPath, "utf8")).toBe("verified artifact");
    const check = new DatabaseSync(restoredPath, { readOnly: true });
    expect(Number((check.prepare("SELECT COUNT(*) AS count FROM products").get() as { count: number }).count)).toBe(24);
    check.close();
    db.close();
  }, 15_000);

  it("rolls the database and artifacts back when restore fails during commit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jianzuo-backup-rollback-"));
    dirs.push(dir);
    const pin = "246810";
    const sourcePath = join(dir, "source.sqlite");
    const targetPath = join(dir, "target.sqlite");
    const artifactPath = join(dir, "artifacts", "products", "example.txt");
    const secondArtifactPath = join(dir, "artifacts", "products", "second.txt");
    const sourceDb = new WorkbenchDatabase(sourcePath);
    sourceDb.seed();
    sourceDb.setSetting("pin_hash", await hashPin(pin));
    mkdirSync(join(dir, "artifacts", "products"), { recursive: true });
    writeFileSync(artifactPath, "backup artifact", "utf8");
    writeFileSync(secondArtifactPath, "second backup artifact", "utf8");
    sourceDb.saveAsset({ kind: "test", path: artifactPath, source: "test" });
    sourceDb.saveAsset({ kind: "test", path: secondArtifactPath, source: "test" });
    const backup = await createEncryptedBackup(sourceDb, dir, pin, "manual");
    sourceDb.close();

    const originalTarget = new DatabaseSync(targetPath);
    originalTarget.exec("CREATE TABLE marker(value TEXT NOT NULL); INSERT INTO marker VALUES ('original database')");
    originalTarget.close();
    writeFileSync(artifactPath, "original artifact", "utf8");
    writeFileSync(secondArtifactPath, "second original artifact", "utf8");

    await expect(restoreEncryptedBackup(backup.path, targetPath, dir, pin, {
      beforeApplyArtifact: (_relativePath, index) => {
        if (index === 1) throw new Error("simulated artifact failure");
      }
    })).rejects.toThrow("simulated artifact failure");

    const rolledBack = new DatabaseSync(targetPath, { readOnly: true });
    expect((rolledBack.prepare("SELECT value FROM marker").get() as { value: string }).value).toBe("original database");
    rolledBack.close();
    expect(readFileSync(artifactPath, "utf8")).toBe("original artifact");
    expect(readFileSync(secondArtifactPath, "utf8")).toBe("second original artifact");
    expect(existsSync(`${targetPath}-wal`)).toBe(false);
    expect(existsSync(`${targetPath}-shm`)).toBe(false);
  }, 15_000);
});
