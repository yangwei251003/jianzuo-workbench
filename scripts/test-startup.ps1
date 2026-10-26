Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

$managerScript = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'manage-startup.ps1')).Path
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$startScript = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'start-desktop.ps1')).Path
$powerShellPath = (Get-Command powershell.exe -CommandType Application | Select-Object -First 1).Source
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("jianzuo-startup-test-$([guid]::NewGuid().ToString('N'))")
$shortcutName = '简作闲鱼工作台-开机启动.lnk'
$unrelatedName = '保留-其他程序.lnk'

function Assert-True {
  param(
    [Parameter(Mandatory = $true)][bool]$Condition,
    [Parameter(Mandatory = $true)][string]$Message
  )
  if (-not $Condition) { throw "自检失败：$Message" }
}

function Invoke-Manager {
  param(
    [Parameter(Mandatory = $true)][ValidateSet('Enable', 'Disable', 'Status')][string]$Action,
    [switch]$ExpectFailure,
    [switch]$WithoutTestMode
  )

  $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $managerScript, '-Action', $Action, '-StartupDirectory', $testRoot, '-Json')
  if (-not $WithoutTestMode) { $arguments += '-TestMode' }
  $output = & $powerShellPath @arguments 2>&1 | Out-String
  $exitCode = $LASTEXITCODE

  if ($ExpectFailure) {
    Assert-True -Condition ($exitCode -ne 0) -Message "$Action 本应失败但返回成功。"
  } else {
    Assert-True -Condition ($exitCode -eq 0) -Message "$Action 返回退出码 $exitCode。输出：$output"
  }

  $line = ($output.Trim() -split "`r?`n")[-1]
  return $line | ConvertFrom-Json
}

New-Item -ItemType Directory -Path $testRoot | Out-Null
$resolvedTestRoot = (Resolve-Path -LiteralPath $testRoot).Path

try {
  $startupDirectory = [Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)
  $actualStartup = (Resolve-Path -LiteralPath $startupDirectory).Path
  Assert-True -Condition (-not [string]::Equals($resolvedTestRoot, $actualStartup, [System.StringComparison]::OrdinalIgnoreCase)) -Message '测试目录意外指向真实 Startup。'

  $rejected = Invoke-Manager -Action Status -ExpectFailure -WithoutTestMode
  Assert-True -Condition ($rejected.Status -eq 'Error') -Message '未启用测试模式时应拒绝注入目录。'

  $status = Invoke-Manager -Action Status
  Assert-True -Condition ($status.Status -eq 'Disabled') -Message '初始状态应为关闭。'

  $enabled = Invoke-Manager -Action Enable
  Assert-True -Condition ($enabled.Status -eq 'Enabled' -and $enabled.Enabled) -Message '启用后状态不正确。'

  $shortcutPath = Join-Path $resolvedTestRoot $shortcutName
  Assert-True -Condition (Test-Path -LiteralPath $shortcutPath -PathType Leaf) -Message '未创建固定命名的快捷方式。'
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $expectedArguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$startScript`""
  Assert-True -Condition ([string]::Equals($shortcut.TargetPath, $powerShellPath, [System.StringComparison]::OrdinalIgnoreCase)) -Message '快捷方式启动程序不正确。'
  Assert-True -Condition ([string]::Equals($shortcut.Arguments, $expectedArguments, [System.StringComparison]::Ordinal)) -Message '快捷方式未严格指向 start-desktop.ps1。'
  Assert-True -Condition ([string]::Equals($shortcut.WorkingDirectory, $projectRoot, [System.StringComparison]::OrdinalIgnoreCase)) -Message '快捷方式工作目录不正确。'
  Assert-True -Condition ($shortcut.Arguments -notmatch '(?i)pin|credential|browser-profile|cookie') -Message '快捷方式参数包含不允许复制的数据字段。'

  $enabledAgain = Invoke-Manager -Action Enable
  Assert-True -Condition ($enabledAgain.Status -eq 'Enabled') -Message '重复启用应保持幂等。'

  $unrelatedPath = Join-Path $resolvedTestRoot $unrelatedName
  $unrelatedShortcut = $shell.CreateShortcut($unrelatedPath)
  $unrelatedShortcut.TargetPath = "$env:SystemRoot\System32\notepad.exe"
  $unrelatedShortcut.Save()

  $disabled = Invoke-Manager -Action Disable
  Assert-True -Condition ($disabled.Status -eq 'Disabled' -and -not $disabled.Enabled) -Message '关闭后状态不正确。'
  Assert-True -Condition (-not (Test-Path -LiteralPath $shortcutPath)) -Message '固定命名的快捷方式未删除。'
  Assert-True -Condition (Test-Path -LiteralPath $unrelatedPath -PathType Leaf) -Message '关闭操作误删了无关快捷方式。'

  $invalidShortcut = $shell.CreateShortcut($shortcutPath)
  $invalidShortcut.TargetPath = "$env:SystemRoot\System32\notepad.exe"
  $invalidShortcut.Arguments = ''
  $invalidShortcut.WorkingDirectory = $resolvedTestRoot
  $invalidShortcut.Save()

  $invalid = Invoke-Manager -Action Status
  Assert-True -Condition ($invalid.Status -eq 'Invalid') -Message '异常固定快捷方式未被识别。'
  $refused = Invoke-Manager -Action Enable -ExpectFailure
  Assert-True -Condition ($refused.Status -eq 'Error') -Message '启用操作不应覆盖异常快捷方式。'
  $stillInvalid = $shell.CreateShortcut($shortcutPath)
  Assert-True -Condition ([string]::Equals($stillInvalid.TargetPath, "$env:SystemRoot\System32\notepad.exe", [System.StringComparison]::OrdinalIgnoreCase)) -Message '异常快捷方式被意外覆盖。'

  Invoke-Manager -Action Disable | Out-Null
  Assert-True -Condition (-not (Test-Path -LiteralPath $shortcutPath)) -Message '关闭操作未删除项目固定名称的异常快捷方式。'
  Assert-True -Condition (Test-Path -LiteralPath $unrelatedPath -PathType Leaf) -Message '最终清理误删了无关快捷方式。'

  Write-Host '开机自启安全自检通过：真实 Startup 未写入，启用/状态/关闭、路径校验和定向删除均符合预期。'
} finally {
  $tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\') + '\'
  $verifiedTestRoot = [System.IO.Path]::GetFullPath($resolvedTestRoot)
  if ($verifiedTestRoot.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase) -and
      (Split-Path -Leaf $verifiedTestRoot).StartsWith('jianzuo-startup-test-', [System.StringComparison]::Ordinal)) {
    Remove-Item -LiteralPath $verifiedTestRoot -Recurse -Force -ErrorAction SilentlyContinue
  } else {
    Write-Warning "未自动清理未通过路径校验的测试目录：$verifiedTestRoot"
  }
}
