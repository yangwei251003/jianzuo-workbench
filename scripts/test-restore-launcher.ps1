Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

$restoreScript = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'restore.ps1')).Path
$desktopMain = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\apps\desktop\src\main.ts')).Path
$powerShellPath = (Get-Command powershell.exe -CommandType Application | Select-Object -First 1).Source
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("jianzuo-restore-selftest-$([guid]::NewGuid().ToString('N'))")

function Assert-True {
  param(
    [Parameter(Mandatory = $true)][bool]$Condition,
    [Parameter(Mandatory = $true)][string]$Message
  )
  if (-not $Condition) { throw "自检失败：$Message" }
}

function Invoke-PathValidation {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Target,
    [Parameter(Mandatory = $true)][bool]$ShouldSucceed,
    [Parameter(Mandatory = $true)][string]$Scenario
  )

  $arguments = @(
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $restoreScript,
    '-ValidateOnly', '-ProjectRootOverride', $tempRoot, '-BackupPath', $Source,
    '-ValidationTargetPath', $Target
  )
  $previousErrorPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = & $powerShellPath @arguments 2>&1 | Out-String
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorPreference
  }
  if ($ShouldSucceed) {
    Assert-True -Condition ($exitCode -eq 0) -Message "$Scenario 应通过但退出码为 $exitCode。输出：$output"
    Assert-True -Condition ($output -match 'VALIDATION_OK') -Message "$Scenario 未返回校验成功标记。"
  } else {
    Assert-True -Condition ($exitCode -ne 0) -Message "$Scenario 应被拒绝但返回成功。"
  }
}

New-Item -ItemType Directory -Path (Join-Path $tempRoot 'scripts') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $tempRoot 'data\browser-profile') -Force | Out-Null
$validBackup = Join-Path $tempRoot 'safe-backup.jzb'
$wrongExtension = Join-Path $tempRoot 'safe-backup.zip'
$directoryBackup = Join-Path $tempRoot 'directory-backup.jzb'
$validTarget = Join-Path $tempRoot 'data\jianzuo.sqlite'
$markerPath = Join-Path $tempRoot 'REAL_ACTION_MUST_NOT_RUN.marker'
Set-Content -LiteralPath $validBackup -Value 'synthetic backup fixture; never decrypted' -Encoding utf8
Set-Content -LiteralPath $wrongExtension -Value 'synthetic wrong extension fixture' -Encoding utf8
New-Item -ItemType Directory -Path $directoryBackup | Out-Null
Set-Content -LiteralPath (Join-Path $tempRoot 'scripts\stop.ps1') -Value "Set-Content -LiteralPath '$markerPath' -Value 'stop invoked'" -Encoding utf8
Set-Content -LiteralPath (Join-Path $tempRoot 'scripts\start.ps1') -Value "Set-Content -LiteralPath '$markerPath' -Value 'start invoked'" -Encoding utf8

try {
  Invoke-PathValidation -Source $validBackup -Target $validTarget -ShouldSucceed $true -Scenario '合法 .jzb 与固定数据库目标'
  Invoke-PathValidation -Source $wrongExtension -Target $validTarget -ShouldSucceed $false -Scenario '错误扩展名'
  Invoke-PathValidation -Source $directoryBackup -Target $validTarget -ShouldSucceed $false -Scenario '伪装成 .jzb 的目录'
  Invoke-PathValidation -Source (Join-Path $tempRoot 'missing.jzb') -Target $validTarget -ShouldSucceed $false -Scenario '不存在的备份'
  Invoke-PathValidation -Source $validBackup -Target $tempRoot -ShouldSucceed $false -Scenario '项目根作为目标'
  Invoke-PathValidation -Source $validBackup -Target (Join-Path $tempRoot 'data\browser-profile') -ShouldSucceed $false -Scenario 'browser-profile 作为目标'
  Invoke-PathValidation -Source $validBackup -Target (Join-Path $tempRoot 'data') -ShouldSucceed $false -Scenario '目录作为目标'

  Assert-True -Condition (-not (Test-Path -LiteralPath $markerPath)) -Message '纯校验模式调用了停止或启动脚本。'

  $desktopSource = Get-Content -Raw -Encoding UTF8 -LiteralPath $desktopMain
  Assert-True -Condition ($desktopSource.Contains('恢复加密备份（安全向导）')) -Message '托盘缺少安全恢复向导菜单。'
  Assert-True -Condition ($desktopSource.Contains('windowsHide: false')) -Message '恢复向导没有显式要求可见窗口。'
  Assert-True -Condition ($desktopSource.Contains('"-NoExit"')) -Message '恢复向导窗口可能在结果可见前关闭。'

  $restoreSource = Get-Content -Raw -Encoding UTF8 -LiteralPath $restoreScript
  Assert-True -Condition ($restoreSource.Contains('System.Windows.Forms.OpenFileDialog')) -Message '交互恢复缺少 .jzb 文件选择窗口。'
  $stopIndex = $restoreSource.IndexOf('scripts\stop.ps1', [System.StringComparison]::Ordinal)
  $runnerIndex = $restoreSource.IndexOf('exec tsx src/cli-restore.ts', [System.StringComparison]::Ordinal)
  Assert-True -Condition ($stopIndex -ge 0 -and $runnerIndex -gt $stopIndex) -Message 'cli-restore 不是在停止核心服务之后调用。'
  Assert-True -Condition ($restoreSource -notmatch '(?i)Set-Content[^\r\n]*(PIN|JIANZUO_RESTORE_PIN)') -Message '恢复脚本可能把 PIN 写入文件。'
  Assert-True -Condition ($restoreSource -notmatch '(?i)cli-restore[^\r\n]*plainPin') -Message '恢复脚本可能把 PIN 放入命令行。'
  Assert-True -Condition ($restoreSource.Contains('$env:JIANZUO_DATA_DIR = Split-Path -Parent $restoreTarget')) -Message 'cli-restore 没有被固定到已校验的数据目录。'

  Write-Host '恢复启动器安全自检通过：仅使用临时目录和纯校验模式；未停止真实服务、未调用 cli-restore、未接触生产数据库。'
} finally {
  $tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\') + '\'
  $verifiedTempRoot = [System.IO.Path]::GetFullPath($tempRoot)
  if ($verifiedTempRoot.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase) -and
      (Split-Path -Leaf $verifiedTempRoot).StartsWith('jianzuo-restore-selftest-', [System.StringComparison]::Ordinal)) {
    Remove-Item -LiteralPath $verifiedTempRoot -Recurse -Force -ErrorAction SilentlyContinue
  } else {
    Write-Warning "未自动清理未通过路径校验的测试目录：$verifiedTempRoot"
  }
}
