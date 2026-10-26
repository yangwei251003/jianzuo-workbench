import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, Menu, nativeImage, shell, Tray } from "electron";

const APP_URL = "http://127.0.0.1:8787";
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const startScript = resolve(projectRoot, "scripts", "start.ps1");
const stopScript = resolve(projectRoot, "scripts", "stop.ps1");
const restoreScript = resolve(projectRoot, "scripts", "restore.ps1");
const startupScript = resolve(projectRoot, "scripts", "manage-startup.ps1");
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let startupStatus: StartupStatus = "Checking";
let startupActionRunning = false;
let restoreWizardRunning = false;

type StartupStatus = "Checking" | "Enabled" | "Disabled" | "Invalid" | "Error";

interface StartupResult {
  Action: "Enable" | "Disable" | "Status";
  Status: Exclude<StartupStatus, "Checking">;
  Enabled: boolean;
  Message: string;
}

if (!app.requestSingleInstanceLock()) app.quit();
else app.on("second-instance", () => void showWorkbench());

app.on("before-quit", () => { quitting = true; });
app.on("window-all-closed", () => { /* keep the tray process alive */ });
app.whenReady().then(async () => {
  createTray();
  await startCoreServices();
  await showWorkbench();
});

function createTray(): void {
  const icon = nativeImage.createFromDataURL(
    `data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="7" fill="#102640"/><rect x="5" y="5" width="22" height="22" rx="5" fill="#ffe500"/><text x="16" y="22" text-anchor="middle" font-size="17" font-family="Microsoft YaHei, sans-serif" font-weight="700" fill="#102640">简</text></svg>')}`
  ).resize({ width: 20, height: 20 });
  tray = new Tray(icon);
  tray.setToolTip("简作 · 闲鱼 AI 运营工作台");
  updateTrayMenu();
  void refreshStartupStatus();
  tray.on("double-click", () => void showWorkbench());
}

function updateTrayMenu(): void {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开工作台", click: () => void showWorkbench() },
    { label: "打开账号中心", click: () => void showWorkbench("/browser") },
    { label: "打开设置与紧急停止", click: () => void showWorkbench("/settings") },
    { type: "separator" },
    { label: "启动核心服务", click: () => void startCoreServices() },
    { label: "停止核心服务", click: () => void runPowerShell(stopScript) },
    {
      label: restoreWizardRunning ? "恢复加密备份（向导已打开）" : "恢复加密备份（安全向导）",
      enabled: !restoreWizardRunning,
      click: () => launchRestoreWizard()
    },
    { type: "separator" },
    { label: startupStatusLabel(), enabled: false },
    {
      label: "启用开机自启",
      enabled: !startupActionRunning && startupStatus !== "Enabled" && startupStatus !== "Invalid" && startupStatus !== "Checking",
      click: () => void changeStartup("Enable")
    },
    {
      label: "关闭开机自启",
      enabled: !startupActionRunning && startupStatus !== "Disabled" && startupStatus !== "Checking",
      click: () => void changeStartup("Disable")
    },
    { type: "separator" },
    { label: "退出托盘（保留核心服务）", click: () => { quitting = true; app.quit(); } },
    { label: "退出并停止全部", click: async () => { await runPowerShell(stopScript); quitting = true; app.quit(); } }
  ]));
}

function startupStatusLabel(): string {
  if (startupActionRunning) return "开机自启：正在更新";
  switch (startupStatus) {
    case "Checking": return "开机自启：正在检查";
    case "Enabled": return "开机自启：已启用";
    case "Disabled": return "开机自启：已关闭";
    case "Invalid": return "开机自启：需要处理";
    case "Error": return "开机自启：状态检查失败";
  }
}

async function refreshStartupStatus(): Promise<void> {
  try {
    const result = await runStartupScript("Status");
    startupStatus = result.Status;
  } catch {
    startupStatus = "Error";
  }
  updateTrayMenu();
}

async function changeStartup(action: "Enable" | "Disable"): Promise<void> {
  if (startupActionRunning) return;
  startupActionRunning = true;
  updateTrayMenu();

  let message: string;
  let type: "info" | "error" = "info";
  try {
    const result = await runStartupScript(action);
    startupStatus = result.Status;
    message = result.Message;
  } catch (error) {
    startupStatus = "Error";
    type = "error";
    message = error instanceof Error ? error.message : "开机自启操作失败。";
  } finally {
    startupActionRunning = false;
    updateTrayMenu();
  }

  await dialog.showMessageBox({
    type,
    title: "开机自启",
    message,
    detail: "该设置只管理当前 Windows 用户的启动快捷方式，不会复制 PIN、账号资料或浏览器数据。",
    buttons: ["确定"]
  });

  await refreshStartupStatus();
}

async function showWorkbench(path = "/"): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = new BrowserWindow({
      width: 1360,
      height: 860,
      minWidth: 1040,
      minHeight: 680,
      show: false,
      backgroundColor: "#f4f7fb",
      title: "简作 · 闲鱼 AI 运营工作台",
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
    });
    mainWindow.on("close", (event) => {
      if (quitting) return;
      event.preventDefault();
      mainWindow?.hide();
    });
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith(`${APP_URL}/`)) return { action: "allow" };
      if (/^https:\/\//i.test(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    mainWindow.once("ready-to-show", () => mainWindow?.show());
  }
  const ready = await waitForHealth();
  if (ready) await mainWindow.loadURL(`${APP_URL}${path}`);
  else await mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(unavailablePage())}`);
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

async function startCoreServices(): Promise<void> {
  if (await isHealthy()) return;
  await runPowerShell(startScript, ["-NoOpen"]);
  await waitForHealth();
}

function launchRestoreWizard(): void {
  if (restoreWizardRunning) return;
  restoreWizardRunning = true;
  updateTrayMenu();

  const child = spawn(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-NoExit", "-File", restoreScript],
    {
      cwd: projectRoot,
      detached: true,
      windowsHide: false,
      stdio: "ignore"
    }
  );

  child.once("error", (error) => {
    restoreWizardRunning = false;
    updateTrayMenu();
    void dialog.showMessageBox({
      type: "error",
      title: "恢复加密备份",
      message: "无法打开安全恢复向导。",
      detail: error.message,
      buttons: ["确定"]
    });
  });
  child.once("exit", () => {
    restoreWizardRunning = false;
    updateTrayMenu();
  });
  child.unref();
}

function runPowerShell(script: string, args: string[] = []): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args], {
      cwd: projectRoot,
      windowsHide: true,
      stdio: "ignore"
    });
    child.once("error", rejectPromise);
    child.once("exit", (code) => code === 0 ? resolvePromise() : rejectPromise(new Error(`脚本执行失败：${code ?? "unknown"}`)));
  });
}

async function runStartupScript(action: "Enable" | "Disable" | "Status"): Promise<StartupResult> {
  const output = await runPowerShellWithOutput(startupScript, ["-Action", action, "-Json"]);
  const result = parseStartupResult(output);
  if (!result) throw new Error("开机自启脚本返回了无法识别的结果。");
  return result;
}

function runPowerShellWithOutput(script: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, ...args], {
      cwd: projectRoot,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      if (code === 0) {
        resolvePromise(stdout);
        return;
      }
      const result = parseStartupResult(stdout);
      rejectPromise(new Error(result?.Message || stderr.trim() || `开机自启脚本执行失败：${code ?? "unknown"}`));
    });
  });
}

function parseStartupResult(output: string): StartupResult | null {
  const line = output.trim().split(/\r?\n/).at(-1);
  if (!line) return null;
  try {
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== "object") return null;
    const result = value as Partial<StartupResult>;
    const validAction = result.Action === "Enable" || result.Action === "Disable" || result.Action === "Status";
    const validStatus = result.Status === "Enabled" || result.Status === "Disabled" || result.Status === "Invalid" || result.Status === "Error";
    if (!validAction || !validStatus || typeof result.Enabled !== "boolean" || typeof result.Message !== "string") return null;
    return result as StartupResult;
  } catch {
    return null;
  }
}

async function isHealthy(): Promise<boolean> {
  try {
    const response = await fetch(`${APP_URL}/api/health`, { signal: AbortSignal.timeout(1_500) });
    return response.ok;
  } catch { return false; }
}

async function waitForHealth(): Promise<boolean> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await isHealthy()) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  return false;
}

function unavailablePage(): string {
  return `<!doctype html><meta charset="utf-8"><title>简作工作台</title><style>body{margin:0;background:#f4f7fb;color:#102640;font-family:"Microsoft YaHei",sans-serif;display:grid;place-items:center;height:100vh}.box{width:min(520px,80vw);padding:36px;background:white;border:1px solid #dce4ed;border-radius:14px;box-shadow:0 18px 60px #1026401a}h1{font-size:24px}p{color:#607286;line-height:1.8}button{border:0;border-radius:8px;padding:11px 18px;background:#ffe500;color:#102640;font-weight:700;cursor:pointer}</style><main class="box"><h1>核心服务暂未就绪</h1><p>托盘仍在运行。请从托盘菜单选择“启动核心服务”，然后重新打开工作台。</p><button onclick="location.href='${APP_URL}'">重试打开</button></main>`;
}
