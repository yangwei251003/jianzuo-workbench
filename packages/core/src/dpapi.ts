import { spawn } from "node:child_process";

const DPAPI_TIMEOUT_MS = 15_000;
const MAX_DPAPI_OUTPUT_BYTES = 64 * 1024 * 1024;

// This script is deliberately fixed. The operation is a non-secret environment
// value and the payload is read as raw bytes from stdin, so secret material never
// appears in a process argument, PowerShell source string, or diagnostic output.
const DPAPI_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$inputStream = [Console]::OpenStandardInput()
$memoryStream = [System.IO.MemoryStream]::new()
$inputStream.CopyTo($memoryStream)
$payload = $memoryStream.ToArray()
$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser

if ($env:JIANZUO_DPAPI_OPERATION -eq 'protect') {
  $result = [System.Security.Cryptography.ProtectedData]::Protect($payload, $null, $scope)
} elseif ($env:JIANZUO_DPAPI_OPERATION -eq 'unprotect') {
  $result = [System.Security.Cryptography.ProtectedData]::Unprotect($payload, $null, $scope)
} else {
  throw 'Unsupported DPAPI operation.'
}

$outputStream = [Console]::OpenStandardOutput()
$outputStream.Write($result, 0, $result.Length)
$outputStream.Flush()
`;

type DpapiOperation = "protect" | "unprotect";

function assertWindows(): void {
  if (process.platform !== "win32") {
    throw new Error("Windows DPAPI 仅可在 Windows 上使用");
  }
}

function runDpapi(operation: DpapiOperation, payload: Uint8Array): Promise<Buffer> {
  assertWindows();

  return new Promise((resolve, reject) => {
    const input = Buffer.from(payload);
    const stdoutChunks: Buffer[] = [];
    let stdoutLength = 0;
    let settled = false;

    const child = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", DPAPI_SCRIPT],
      {
        env: { ...process.env, JIANZUO_DPAPI_OPERATION: operation },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      }
    );

    const finishWithError = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      input.fill(0);
      reject(error);
    };

    const timeout = setTimeout(() => {
      child.kill();
      finishWithError(new Error(`Windows DPAPI ${operation} 操作超时`));
    }, DPAPI_TIMEOUT_MS);
    timeout.unref();

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutLength += chunk.length;
      if (stdoutLength > MAX_DPAPI_OUTPUT_BYTES) {
        child.kill();
        finishWithError(new Error(`Windows DPAPI ${operation} 返回数据过大`));
        return;
      }
      stdoutChunks.push(chunk);
    });

    // Drain stderr to avoid a blocked child process, but never retain or expose it:
    // PowerShell diagnostics must not become an accidental secret logging channel.
    child.stderr.resume();
    child.stdin.on("error", () => undefined);

    child.once("error", () => {
      finishWithError(new Error(`无法启动 Windows DPAPI ${operation} 进程`));
    });

    child.once("close", (exitCode) => {
      if (settled) return;
      clearTimeout(timeout);
      input.fill(0);

      if (exitCode !== 0) {
        finishWithError(new Error(`Windows DPAPI ${operation} 操作失败（退出码 ${exitCode ?? "未知"}）`));
        return;
      }

      settled = true;
      resolve(Buffer.concat(stdoutChunks, stdoutLength));
    });

    child.stdin.end(input);
  });
}

export async function protectWithCurrentUserDpapi(plaintext: Uint8Array): Promise<Buffer> {
  return runDpapi("protect", plaintext);
}

export async function unprotectWithCurrentUserDpapi(ciphertext: Uint8Array): Promise<Buffer> {
  return runDpapi("unprotect", ciphertext);
}
