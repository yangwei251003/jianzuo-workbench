[CmdletBinding()]
param(
  [string]$BackupPath,
  [switch]$ValidateOnly,
  [string]$ProjectRootOverride,
  [string]$ValidationTargetPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
Remove-Item Env:JIANZUO_RESTORE_PIN -ErrorAction SilentlyContinue

function Resolve-BackupSource {
  param([Parameter(Mandatory = $true)][string]$Path)

  $candidate = $Path.Trim()
  if (($candidate.StartsWith('"') -and $candidate.EndsWith('"')) -or
      ($candidate.StartsWith("'") -and $candidate.EndsWith("'"))) {
    $candidate = $candidate.Substring(1, $candidate.Length - 2)
  }
  if ([string]::IsNullOrWhiteSpace($candidate)) { throw '必须选择或输入 .jzb 备份文件。' }

  $item = Get-Item -LiteralPath $candidate -Force -ErrorAction Stop
  if ($item.PSProvider.Name -ne 'FileSystem' -or $item.PSIsContainer) {
    throw '备份源必须是本机文件，不能是目录或其他类型的路径。'
  }
  if (-not [string]::Equals($item.Extension, '.jzb', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw '只允许恢复扩展名为 .jzb 的备份文件。'
  }
  return [System.IO.Path]::GetFullPath($item.FullName)
}

function Select-BackupSource {
  Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
  $dialog = New-Object System.Windows.Forms.OpenFileDialog
  try {
    $dialog.Title = '选择简作加密备份'
    $dialog.Filter = '简作加密备份 (*.jzb)|*.jzb'
    $dialog.CheckFileExists = $true
    $dialog.CheckPathExists = $true
    $dialog.Multiselect = $false
    $dialog.RestoreDirectory = $true
    if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { return $null }
    return $dialog.FileName
  } finally {
    $dialog.Dispose()
  }
}

function Assert-RestoreTarget {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Root
  )

  $fullRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
  $fullTarget = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
  $browserProfile = [System.IO.Path]::GetFullPath((Join-Path $fullRoot 'data\browser-profile')).TrimEnd('\')
  $requiredTarget = [System.IO.Path]::GetFullPath((Join-Path $fullRoot 'data\jianzuo.sqlite'))

  if ([string]::Equals($fullTarget, $fullRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw '恢复目标不能是项目根目录。'
  }
  if ([string]::Equals($fullTarget, $browserProfile, [System.StringComparison]::OrdinalIgnoreCase) -or
      $fullTarget.StartsWith("$browserProfile\", [System.StringComparison]::OrdinalIgnoreCase)) {
    throw '恢复目标不能是 data\browser-profile 或其中的路径。'
  }
  if (Test-Path -LiteralPath $fullTarget -PathType Container) {
    throw '恢复目标不能是目录。'
  }
  if (-not [string]::Equals($fullTarget, $requiredTarget, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "恢复目标必须是固定数据库文件：$requiredTarget"
  }
  return $fullTarget
}

function Test-CoreServiceRunning {
  try {
    $health = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8787/api/health' -TimeoutSec 2
    return $health.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Test-CoreServiceWasStarted {
  param([Parameter(Mandatory = $true)][string]$Root)

  if (Test-CoreServiceRunning) { return $true }
  $pidFile = Join-Path $Root 'data\runtime\launcher.pid'
  if (-not (Test-Path -LiteralPath $pidFile -PathType Leaf)) { return $false }
  $rawPid = (Get-Content -Raw -LiteralPath $pidFile).Trim()
  if ($rawPid -notmatch '^\d+$') { return $false }
  $process = Get-Process -Id ([int]$rawPid) -ErrorAction SilentlyContinue
  if (-not $process) { return $false }
  $pidFileTime = (Get-Item -LiteralPath $pidFile).LastWriteTimeUtc
  return [Math]::Abs(($process.StartTime.ToUniversalTime() - $pidFileTime).TotalMinutes) -lt 2
}

function Wait-CoreServiceStopped {
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    if (-not (Test-CoreServiceRunning)) { return }
    Start-Sleep -Milliseconds 250
  }
  throw '核心服务未能完全停止，已拒绝开始恢复。'
}

if ($ProjectRootOverride -and -not $ValidateOnly) {
  throw '自定义项目目录只允许与 -ValidateOnly 一起用于安全自检。'
}
if ($ValidationTargetPath -and -not $ValidateOnly) {
  throw '自定义恢复目标只允许与 -ValidateOnly 一起用于安全自检。'
}

$projectRootCandidate = if ($ProjectRootOverride) { $ProjectRootOverride } else { Split-Path -Parent $PSScriptRoot }
$projectRootItem = Get-Item -LiteralPath $projectRootCandidate -Force -ErrorAction Stop
if ($projectRootItem.PSProvider.Name -ne 'FileSystem' -or -not $projectRootItem.PSIsContainer) {
  throw '项目根路径必须是本机目录。'
}
$projectRoot = [System.IO.Path]::GetFullPath($projectRootItem.FullName)
$defaultTarget = Join-Path $projectRoot 'data\jianzuo.sqlite'

if ($ValidateOnly) {
  if ([string]::IsNullOrWhiteSpace($BackupPath)) { throw '-ValidateOnly 必须提供 -BackupPath。' }
  $validatedBackup = Resolve-BackupSource -Path $BackupPath
  $targetToValidate = if ($ValidationTargetPath) { $ValidationTargetPath } else { $defaultTarget }
  $validatedTarget = Assert-RestoreTarget -Path $targetToValidate -Root $projectRoot
  Write-Host "VALIDATION_OK source=$validatedBackup target=$validatedTarget"
  return
}

try { $Host.UI.RawUI.WindowTitle = '简作 · 恢复加密备份（安全向导）' } catch { }
Write-Host ''
Write-Host '简作 · 恢复加密备份（安全向导）'
Write-Host '恢复会替换当前数据库。向导会先校验文件，确认后停止核心服务，再调用受控恢复程序。'
Write-Host 'PIN 只在本次进程内短暂使用，不会写入文件、日志或命令行。'
Write-Host ''

$requestedBackup = $BackupPath
if ([string]::IsNullOrWhiteSpace($requestedBackup)) {
  try {
    $requestedBackup = Select-BackupSource
    if ([string]::IsNullOrWhiteSpace($requestedBackup)) {
      Write-Host '未选择备份文件，恢复已取消；核心服务和数据库均未改动。'
      return
    }
  } catch {
    Write-Warning '文件选择窗口不可用，已切换为手工输入路径。'
    $requestedBackup = Read-Host '请输入 .jzb 备份文件的完整路径'
  }
}
$resolvedBackup = Resolve-BackupSource -Path $requestedBackup
$restoreTarget = Assert-RestoreTarget -Path $defaultTarget -Root $projectRoot
Set-Location -LiteralPath $projectRoot
Write-Host "已验证备份文件：$resolvedBackup"
Write-Host "固定恢复目标：$restoreTarget"

$confirmation = Read-Host '恢复会替换当前数据库。准确输入 RESTORE 继续'
if ($confirmation -cne 'RESTORE') {
  Write-Host '未输入 RESTORE，恢复已取消；核心服务和数据库均未改动。'
  return
}

$securePin = $null
$pinPointer = [IntPtr]::Zero
$plainPin = $null
$restoreError = $null
$serviceWasRunning = $false
$stopAttempted = $false
$hadOriginalDataDir = Test-Path Env:JIANZUO_DATA_DIR
$originalDataDir = if ($hadOriginalDataDir) { $env:JIANZUO_DATA_DIR } else { $null }

try {
  $securePin = Read-Host '请输入该备份使用的本地 PIN' -AsSecureString
  if ($securePin.Length -eq 0) { throw 'PIN 不能为空。' }

  # 在停止服务前再次校验，避免等待人工输入期间路径发生变化。
  $resolvedBackup = Resolve-BackupSource -Path $resolvedBackup
  $restoreTarget = Assert-RestoreTarget -Path $restoreTarget -Root $projectRoot
  $serviceWasRunning = Test-CoreServiceWasStarted -Root $projectRoot

  Write-Host '正在停止核心服务……'
  $stopAttempted = $true
  & (Join-Path $projectRoot 'scripts\stop.ps1')
  if (-not $?) { throw '停止核心服务失败，恢复未开始。' }
  Wait-CoreServiceStopped

  $pinPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePin)
  $plainPin = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pinPointer)
  $env:JIANZUO_RESTORE_PIN = $plainPin
  $env:JIANZUO_DATA_DIR = Split-Path -Parent $restoreTarget

  $pnpmPath = (Get-Command pnpm.cmd -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
  & $pnpmPath --filter '@jianzuo/api' exec tsx src/cli-restore.ts $resolvedBackup
  if ($LASTEXITCODE -ne 0) { throw "受控恢复程序失败，退出码：$LASTEXITCODE" }
} catch {
  $restoreError = $_.Exception.Message
} finally {
  Remove-Item Env:JIANZUO_RESTORE_PIN -ErrorAction SilentlyContinue
  if ($hadOriginalDataDir) {
    $env:JIANZUO_DATA_DIR = $originalDataDir
  } else {
    Remove-Item Env:JIANZUO_DATA_DIR -ErrorAction SilentlyContinue
  }
  $originalDataDir = $null
  $plainPin = $null
  if ($pinPointer -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pinPointer)
    $pinPointer = [IntPtr]::Zero
  }
  if ($null -ne $securePin) {
    $securePin.Dispose()
    $securePin = $null
  }
}

if ($restoreError) {
  $restartMessage = '恢复前核心服务未处于可用状态，因此未自动启动服务。'
  if ($stopAttempted -and $serviceWasRunning) {
    try {
      Write-Host '恢复未完成，正在尝试重新启动原核心服务……'
      & (Join-Path $projectRoot 'scripts\start.ps1') -NoOpen
      if (-not $?) { throw '启动脚本返回失败。' }
      if (-not (Test-CoreServiceRunning)) { throw '启动后健康检查未通过。' }
      $restartMessage = '原核心服务已重新启动。'
    } catch {
      $restartMessage = "原核心服务重新启动失败：$($_.Exception.Message)"
    }
  }
  [Console]::Error.WriteLine("恢复失败：$restoreError $restartMessage 请保留现状并人工检查，不要连续重复恢复。")
  exit 1
}

Write-Host ''
Write-Host '恢复完成。核心服务保持停止；请关闭本窗口后，使用桌面快捷方式重新启动工作台。'
