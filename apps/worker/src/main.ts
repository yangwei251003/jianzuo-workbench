import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkbenchDatabase } from "@jianzuo/database";
import { WorkerProcessor } from "./processor.js";

const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));
const dataDir = resolve(process.env.JIANZUO_DATA_DIR ?? resolve(workspaceRoot, "data"));
const db = new WorkbenchDatabase(resolve(dataDir, "jianzuo.sqlite"));
db.seed();
const processor = new WorkerProcessor(db);
processor.recover();

db.enqueueJob("HEALTH_PROBE", {}, `worker-health:${process.pid}`, 10);

let stopping = false;
let scheduledDay = "";
function scheduleDailyMaintenance(): void {
  const day = new Date().toISOString().slice(0, 10);
  if (day === scheduledDay) return;
  scheduledDay = day;
  db.enqueueJob("RETENTION_CLEANUP", {}, `retention:${day}`, 20);
}
async function loop(): Promise<void> {
  while (!stopping) {
    scheduleDailyMaintenance();
    const worked = await processor.tick();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, worked ? 50 : 750));
  }
}

const shutdown = () => {
  stopping = true;
  setTimeout(() => { db.close(); process.exit(0); }, 100).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

process.stdout.write(`简作 Worker 已启动：${processor.workerId}\n`);
await loop();
