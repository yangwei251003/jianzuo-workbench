import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { WorkbenchDatabase } from "@jianzuo/database";
import { loadConfig } from "./config.js";
import { createEncryptedBackup, restoreEncryptedBackup } from "./services/backup.js";

const pin = process.env.JIANZUO_RESTORE_PIN;
delete process.env.JIANZUO_RESTORE_PIN;
const source = process.argv[2] ? resolve(process.argv[2]) : "";
if (!pin) throw new Error("缺少恢复 PIN");
if (!source || !existsSync(source)) throw new Error("备份文件不存在");
const { dataDir } = loadConfig();
const target = resolve(dataDir, "jianzuo.sqlite");
const db = new WorkbenchDatabase(target);
try { await createEncryptedBackup(db, dataDir, pin, "manual"); }
finally { db.close(); }
const restored = await restoreEncryptedBackup(source, target, dataDir, pin);
process.stdout.write(`恢复完成：${restored.target}（完整性：${restored.integrity}）\n`);
