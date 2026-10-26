import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AppConfig } from "../config.js";

const BROWSERS = [
  { family: "edge" as const, label: "Microsoft Edge", path: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" },
  { family: "chrome" as const, label: "Google Chrome", path: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" }
];
type BrowserFamily = typeof BROWSERS[number]["family"];

export class BrowserLauncher {
  private child: ChildProcess | null = null;
  private readonly pidFile: string;
  private readonly familyFile: string;
  constructor(private readonly config: AppConfig) {
    this.pidFile = resolve(config.dataDir, "runtime", "browser.pid");
    this.familyFile = resolve(config.browserProfileDir, ".jianzuo-browser-family");
  }

  availableBrowsers(): Array<{ family: BrowserFamily; label: string; path: string }> { return BROWSERS.filter((item) => existsSync(item.path)); }
  availableBrowser(preferred?: BrowserFamily): string | null {
    return (this.availableBrowsers().find((item) => item.family === preferred) ?? this.availableBrowsers()[0])?.path ?? null;
  }

  start(mode: "mock" | "real", preferred?: BrowserFamily): { pid: number; browser: string; family: BrowserFamily; url: string; profileDir: string } {
    const selected = this.availableBrowsers().find((item) => item.family === preferred) ?? this.availableBrowsers()[0];
    const browser = selected?.path;
    if (!browser) throw new Error("没有找到 Chrome 或 Edge");
    mkdirSync(this.config.browserProfileDir, { recursive: true });
    this.ensureProfileFamily(selected.family);
    mkdirSync(resolve(this.config.dataDir, "runtime"), { recursive: true });
    const url = mode === "mock"
      ? (existsSync(this.config.mockDist) ? `http://127.0.0.1:${this.config.port}/mock/` : "http://127.0.0.1:5174")
      : "https://www.goofish.com/?jianzuo_login=1";
    const args = [
      `--user-data-dir=${this.config.browserProfileDir}`,
      `--disable-extensions-except=${this.config.extensionDir}`,
      `--load-extension=${this.config.extensionDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      url
    ];
    this.child = spawn(browser, args, { detached: true, stdio: "ignore", windowsHide: false });
    this.child.unref();
    if (!this.child.pid) throw new Error("浏览器启动失败");
    const pid = this.resolveProfileRootPid(this.child.pid);
    writeFileSync(this.pidFile, String(pid), { encoding: "utf8" });
    return { pid, browser, family: selected.family, url, profileDir: this.config.browserProfileDir };
  }

  open(url: string, preferred?: BrowserFamily): { pid: number; browser: string; family: BrowserFamily; url: string; profileDir: string } {
    const selected = this.availableBrowsers().find((item) => item.family === preferred) ?? this.availableBrowsers()[0];
    if (!selected) throw new Error("没有找到 Chrome 或 Edge");
    mkdirSync(this.config.browserProfileDir, { recursive: true });
    this.ensureProfileFamily(selected.family);
    const child = spawn(selected.path, [
      `--user-data-dir=${this.config.browserProfileDir}`,
      `--disable-extensions-except=${this.config.extensionDir}`,
      `--load-extension=${this.config.extensionDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      url
    ], { detached: true, stdio: "ignore", windowsHide: false });
    child.unref();
    if (!child.pid) throw new Error("无法打开专用浏览器页面");
    const pid = this.resolveProfileRootPid(child.pid);
    writeFileSync(this.pidFile, String(pid), { encoding: "utf8" });
    return { pid, browser: selected.path, family: selected.family, url, profileDir: this.config.browserProfileDir };
  }

  stop(): boolean {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$target = [Environment]::GetEnvironmentVariable('JIANZUO_PROFILE_TARGET')",
      "$resolved = [System.IO.Path]::GetFullPath($target)",
      "if ($resolved -ne $target) { throw '浏览器资料目录未规范化' }",
      "$prefix = '--user-data-dir=' + $resolved",
      "$matches = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('msedge.exe','chrome.exe') -and $_.CommandLine -and $_.CommandLine.Contains($prefix) })",
      "if ($matches.Count -eq 0) { exit 3 }",
      "$matches | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
      "Start-Sleep -Milliseconds 300",
      "$remaining = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('msedge.exe','chrome.exe') -and $_.CommandLine -and $_.CommandLine.Contains($prefix) })",
      "if ($remaining.Count -gt 0) { exit 4 }"
    ].join("; ");
    const stopped = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], {
      encoding: "utf8", windowsHide: true, env: { ...process.env, JIANZUO_PROFILE_TARGET: this.config.browserProfileDir }
    });
    this.child = null;
    if (existsSync(this.pidFile)) rmSync(this.pidFile, { force: true });
    return stopped.status === 0;
  }

  private resolveProfileRootPid(fallbackPid: number): number {
    const script = [
      "$target = [Environment]::GetEnvironmentVariable('JIANZUO_PROFILE_TARGET')",
      "$prefix = '--user-data-dir=' + [System.IO.Path]::GetFullPath($target)",
      "Start-Sleep -Milliseconds 600",
      "$roots = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('msedge.exe','chrome.exe') -and $_.CommandLine -and $_.CommandLine.Contains($prefix) -and $_.CommandLine -notmatch '--type=' } | Sort-Object CreationDate -Descending)",
      "$roots | ForEach-Object { Write-Output $_.ProcessId }"
    ].join("; ");
    const discovered = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], {
      encoding: "utf8", windowsHide: true, env: { ...process.env, JIANZUO_PROFILE_TARGET: this.config.browserProfileDir }
    });
    return selectBrowserRootPid(discovered.status === 0 ? discovered.stdout : "", fallbackPid);
  }

  private ensureProfileFamily(family: BrowserFamily): void {
    if (existsSync(this.familyFile)) {
      const existing = readFileSync(this.familyFile, "utf8").trim();
      if (existing && existing !== family) throw new Error(`该独立资料目录已绑定 ${existing === "edge" ? "Microsoft Edge" : "Google Chrome"}，请继续使用同一浏览器`);
      return;
    }
    // This project was initially calibrated with Edge. Treat an existing
    // markerless Chromium profile as Edge so switching binaries cannot corrupt it.
    if (existsSync(resolve(this.config.browserProfileDir, "Local State")) && family !== "edge") {
      throw new Error("现有独立资料目录来自 Microsoft Edge，请选择 Edge 后继续");
    }
    writeFileSync(this.familyFile, family, { encoding: "utf8", flag: "wx" });
  }
}

export function selectBrowserRootPid(output: string, fallbackPid: number): number {
  const discovered = output.split(/\r?\n/).map((value) => Number(value.trim())).filter((value) => Number.isInteger(value) && value > 0);
  if (discovered.includes(fallbackPid)) return fallbackPid;
  return discovered[0] ?? fallbackPid;
}
