$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $projectRoot 'data\runtime'
$pidFile = Join-Path $runtimeDir 'launcher.pid'
$browserPidFile = Join-Path $runtimeDir 'browser.pid'

function Stop-ProcessTree([int]$processId) {
  $children = Get-CimInstance Win32_Process -Filter "ParentProcessId=$processId" -ErrorAction SilentlyContinue
  foreach ($child in $children) { Stop-ProcessTree -processId ([int]$child.ProcessId) }
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if ($process) { Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue }
}

function Test-WorkbenchProcess([int]$processId, [string]$pidPath) {
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if (-not $process) { return $false }
  $pidFileTime = (Get-Item -LiteralPath $pidPath).LastWriteTimeUtc
  $startTime = $process.StartTime.ToUniversalTime()
  return [Math]::Abs(($startTime - $pidFileTime).TotalMinutes) -lt 2
}

function Test-BrowserProcess([int]$processId) {
  $record = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue
  if (-not $record) { return $false }
  $profilePath = [System.IO.Path]::GetFullPath((Join-Path $projectRoot 'data\browser-profile'))
  return [string]$record.CommandLine -like "*$profilePath*"
}

foreach ($file in @($pidFile, $browserPidFile)) {
  if (-not (Test-Path -LiteralPath $file)) { continue }
  $rawPid = (Get-Content -Raw -LiteralPath $file).Trim()
  if ($rawPid -match '^\d+$') {
    $owned = if ($file -eq $browserPidFile) { Test-BrowserProcess -processId ([int]$rawPid) } else { Test-WorkbenchProcess -processId ([int]$rawPid) -pidPath $file }
    if ($owned) { Stop-ProcessTree -processId ([int]$rawPid) }
  }
  Remove-Item -LiteralPath $file -Force
}

# Edge/Chrome may hand a launch request to an existing profile process and let
# the newly spawned PID exit. Always finish by discovering the exact dedicated
# profile path, never by browser name alone, so a stale PID cannot leave it open.
$profilePath = [System.IO.Path]::GetFullPath((Join-Path $projectRoot 'data\browser-profile'))
$profilePrefix = '--user-data-dir=' + $profilePath
$profileProcesses = @(Get-CimInstance Win32_Process | Where-Object {
  $_.Name -in @('msedge.exe', 'chrome.exe') -and $_.CommandLine -and $_.CommandLine.Contains($profilePrefix)
})
$profileRoots = @($profileProcesses | Where-Object { $_.CommandLine -notmatch '--type=' })
foreach ($root in $profileRoots) { Stop-ProcessTree -processId ([int]$root.ProcessId) }
foreach ($process in $profileProcesses) {
  Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction SilentlyContinue
}
Remove-Item -LiteralPath $browserPidFile -Force -ErrorAction SilentlyContinue
Write-Host '简作工作台和独立浏览器已停止。数据与浏览器资料均已保留。'
