import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WORKSPACE_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export type AppConfig = {
  host: "127.0.0.1";
  port: number;
  rootDir: string;
  dataDir: string;
  webDist: string;
  mockDist: string;
  extensionDir: string;
  browserProfileDir: string;
};

export function loadConfig(): AppConfig {
  const rootDir = resolve(process.env.JIANZUO_ROOT_DIR ?? WORKSPACE_ROOT);
  if ((process.env.JIANZUO_HOST ?? "127.0.0.1") !== "127.0.0.1") {
    throw new Error("安全限制：简作工作台只能监听 127.0.0.1");
  }
  const port = Number(process.env.JIANZUO_PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("JIANZUO_PORT 无效");
  const dataDir = resolve(process.env.JIANZUO_DATA_DIR ?? resolve(rootDir, "data"));
  return {
    host: "127.0.0.1",
    port,
    rootDir,
    dataDir,
    webDist: resolve(rootDir, "apps", "web", "dist"),
    mockDist: resolve(rootDir, "apps", "mock-xianyu", "dist"),
    extensionDir: resolve(rootDir, "apps", "extension"),
    browserProfileDir: resolve(dataDir, "browser-profile")
  };
}
