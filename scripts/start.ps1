param([switch]$NoOpen)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $projectRoot 'data\runtime'
$logDir = Join-Path $projectRoot 'data\logs'
$pidFile = Join-Path $runtimeDir 'launcher.pid'
$url = 'http://127.0.0.1:8787'
New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
New-Item -ItemType Directory -Path $logDir -Force | Out-Null

try {
  $health = Invoke-WebRequest -UseBasicParsing -Uri "$url/api/health" -TimeoutSec 2
  if ($health.StatusCode -eq 200) { if (-not $NoOpen) { Start-Process $url }; exit 0 }
} catch { }

$pnpmPath = (Get-Command pnpm.cmd -ErrorAction Stop).Source
$stdoutLog = Join-Path $logDir 'workbench.out.log'
$stderrLog = Join-Path $logDir 'workbench.err.log'

function Invoke-WorkbenchLogRotation {
  param(
    [Parameter(Mandatory = $true)]
    [string]$LogPath
  )

  $allowedLogPaths = @(
    [System.IO.Path]::GetFullPath($stdoutLog),
    [System.IO.Path]::GetFullPath($stderrLog)
  )
  $fullLogPath = [System.IO.Path]::GetFullPath($LogPath)
  if ($fullLogPath -notin $allowedLogPaths) {
    throw "拒绝轮转非工作台日志：$fullLogPath"
  }

  if (-not (Test-Path -LiteralPath $fullLogPath -PathType Leaf)) { return }
  if ((Get-Item -LiteralPath $fullLogPath).Length -lt 10MB) { return }

  $oldestGeneration = "$fullLogPath.5"
  if (Test-Path -LiteralPath $oldestGeneration -PathType Leaf) {
    Remove-Item -LiteralPath $oldestGeneration -Force
  }

  for ($generation = 4; $generation -ge 1; $generation--) {
    $sourcePath = "$fullLogPath.$generation"
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) { continue }

    $destinationPath = "$fullLogPath.$($generation + 1)"
    if (Test-Path -LiteralPath $destinationPath -PathType Leaf) {
      Remove-Item -LiteralPath $destinationPath -Force
    }
    Move-Item -LiteralPath $sourcePath -Destination $destinationPath
  }

  $firstGeneration = "$fullLogPath.1"
  if (Test-Path -LiteralPath $firstGeneration -PathType Leaf) {
    Remove-Item -LiteralPath $firstGeneration -Force
  }
  Move-Item -LiteralPath $fullLogPath -Destination $firstGeneration
}

Invoke-WorkbenchLogRotation -LogPath $stdoutLog
Invoke-WorkbenchLogRotation -LogPath $stderrLog
$process = Start-Process -FilePath $pnpmPath -ArgumentList @('start') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru
Set-Content -LiteralPath $pidFile -Value $process.Id -Encoding ascii

$ready = $false
for ($attempt = 0; $attempt -lt 40; $attempt++) {
  Start-Sleep -Milliseconds 500
  try {
    $health = Invoke-WebRequest -UseBasicParsing -Uri "$url/api/health" -TimeoutSec 2
    if ($health.StatusCode -eq 200) { $ready = $true; break }
  } catch { }
  if ($process.HasExited) { break }
}
if (-not $ready) { throw "工作台启动失败，请查看 $stderrLog" }
if (-not $NoOpen) { Start-Process $url }
