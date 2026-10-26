import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const outputDir = resolve(process.cwd(), "output");
mkdirSync(outputDir, { recursive: true });
const dataDir = mkdtempSync(resolve(outputDir, "e2e-data-"));
process.env.JIANZUO_DATA_DIR = dataDir;
process.env.JIANZUO_PORT = "8790";

const [{ buildApp }, { loadConfig }, { WorkbenchDatabase }, { WorkerProcessor }] = await Promise.all([
  import("../apps/api/src/app.js"),
  import("../apps/api/src/config.js"),
  import("../packages/database/src/index.js"),
  import("../apps/worker/src/processor.js")
]);

const app = await buildApp({ config: loadConfig(), logger: false });
const workerDb = new WorkbenchDatabase(resolve(dataDir, "jianzuo.sqlite"));
workerDb.seed();
const processor = new WorkerProcessor(workerDb);
processor.recover();
let stopping = false;

async function workerLoop() {
  while (!stopping) {
    const worked = await processor.tick();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, worked ? 40 : 250));
  }
}

const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  await app.close();
  workerDb.close();
  rmSync(dataDir, { recursive: true, force: true });
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

await app.listen({ host: "127.0.0.1", port: 8790 });
void workerLoop();
