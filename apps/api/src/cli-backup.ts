import { resolve } from "node:path";
import { WorkbenchDatabase } from "@jianzuo/database";
import { loadConfig } from "./config.js";
import { createEncryptedBackup } from "./services/backup.js";

const pin = process.env.JIANZUO_BACKUP_PIN;
delete process.env.JIANZUO_BACKUP_PIN;
if (!pin) throw new Error("缺少备份 PIN");
const { dataDir } = loadConfig();
const db = new WorkbenchDatabase(resolve(dataDir, "jianzuo.sqlite"));
try {
  const backup = await createEncryptedBackup(db, dataDir, pin, "manual");
  process.stdout.write(`加密备份已创建：${backup.path}\n`);
} finally { db.close(); }
