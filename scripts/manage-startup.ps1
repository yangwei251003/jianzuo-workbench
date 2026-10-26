param(
  [ValidateSet('Enable', 'Disable', 'Status')]
  [string]$Action = 'Status',
  [string]$StartupDirectory,
  [switch]$TestMode,
  [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

$shortcutName = '简作闲鱼工作台-开机启动.lnk'
$expectedScriptName = 'start-desktop.ps1'

function Get-NormalizedPath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [switch]$MustExist
  )

  if ([string]::IsNullOrWhiteSpace($Path)) { throw '路径不能为空。' }
  if ($Path.IndexOfAny([System.IO.Path]::GetInvalidPathChars()) -ge 0) { throw '路径包含无效字符。' }
  if ($Path.Contains('"')) { throw '路径不能包含双引号。' }

  $fullPath = [System.IO.Path]::GetFullPath($Path)
  if ($MustExist) {
    $fullPath = (Resolve-Path -LiteralPath $fullPath -ErrorAction Stop).Path
  }
  return $fullPath.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
}

function Test-SamePath {
  param(
    [Parameter(Mandatory = $true)][string]$Left,
    [Parameter(Mandatory = $true)][string]$Right
  )

  return [string]::Equals(
    (Get-NormalizedPath -Path $Left),
    (Get-NormalizedPath -Path $Right),
    [System.StringComparison]::OrdinalIgnoreCase
  )
}

function Test-PathWithin {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Directory
  )

  $normalizedPath = Get-NormalizedPath -Path $Path
  $normalizedDirectory = Get-NormalizedPath -Path $Directory
  $prefix = $normalizedDirectory + [System.IO.Path]::DirectorySeparatorChar
  return $normalizedPath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-ValidatedStartupDirectory {
  $actualStartup = Get-NormalizedPath -Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)) -MustExist

  if ($TestMode) {
    if ([string]::IsNullOrWhiteSpace($StartupDirectory)) {
      throw '测试模式必须通过 -StartupDirectory 指定隔离目录。'
    }
    if (-not [System.IO.Path]::IsPathRooted($StartupDirectory)) {
      throw '测试目录必须是绝对路径。'
    }
    $testDirectory = Get-NormalizedPath -Path $StartupDirectory -MustExist
    if (-not (Test-Path -LiteralPath $testDirectory -PathType Container)) {
      throw '测试目录不存在或不是文件夹。'
    }
    if (Test-SamePath -Left $testDirectory -Right $actualStartup) {
      throw '测试目录不能使用真实的 Windows Startup 文件夹。'
    }
    if (Test-SamePath -Left $testDirectory -Right ([System.IO.Path]::GetPathRoot($testDirectory))) {
      throw '测试目录不能是磁盘根目录。'
    }
    return $testDirectory
  }

  if (-not [string]::IsNullOrWhiteSpace($StartupDirectory)) {
    throw '自定义 Startup 目录只允许与 -TestMode 一起用于安全自检。'
  }

  $applicationData = Get-NormalizedPath -Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)) -MustExist
  if (-not (Test-PathWithin -Path $actualStartup -Directory $applicationData)) {
    throw 'Windows Startup 文件夹不在当前用户的 AppData 目录内，已拒绝操作。'
  }
  return $actualStartup
}

function Get-ProjectPaths {
  $scriptsDirectory = Get-NormalizedPath -Path $PSScriptRoot -MustExist
  $projectRoot = Get-NormalizedPath -Path (Join-Path $scriptsDirectory '..') -MustExist
  $startScript = Get-NormalizedPath -Path (Join-Path $scriptsDirectory $expectedScriptName) -MustExist

  if (-not (Test-Path -LiteralPath $startScript -PathType Leaf)) {
    throw "未找到启动脚本：$startScript"
  }
  if (-not (Test-SamePath -Left (Split-Path -Parent $startScript) -Right $scriptsDirectory)) {
    throw '启动脚本不在本项目 scripts 目录内，已拒绝操作。'
  }
  if (-not [string]::Equals((Split-Path -Leaf $startScript), $expectedScriptName, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw '启动脚本名称不符合预期，已拒绝操作。'
  }

  return [PSCustomObject]@{
    ProjectRoot = $projectRoot
    StartScript = $startScript
  }
}

function Get-ShortcutPath {
  param([Parameter(Mandatory = $true)][string]$Directory)

  $shortcutPath = Get-NormalizedPath -Path (Join-Path $Directory $shortcutName)
  if (-not (Test-SamePath -Left (Split-Path -Parent $shortcutPath) -Right $Directory)) {
    throw '快捷方式路径越出 Startup 文件夹，已拒绝操作。'
  }
  if (-not [string]::Equals((Split-Path -Leaf $shortcutPath), $shortcutName, [System.StringComparison]::Ordinal)) {
    throw '快捷方式名称不符合项目固定名称，已拒绝操作。'
  }
  if (-not [string]::Equals([System.IO.Path]::GetExtension($shortcutPath), '.lnk', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw '只允许管理固定命名的 .lnk 快捷方式。'
  }
  return $shortcutPath
}

function Get-PowerShellPath {
  $command = Get-Command powershell.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1
  $powerShellPath = Get-NormalizedPath -Path $command.Source -MustExist
  if (-not (Test-Path -LiteralPath $powerShellPath -PathType Leaf)) {
    throw '未找到 Windows PowerShell。'
  }
  return $powerShellPath
}

function Get-ExpectedArguments {
  param([Parameter(Mandatory = $true)][string]$StartScript)
  return "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$StartScript`""
}

function Get-ShortcutStatus {
  param(
    [Parameter(Mandatory = $true)][string]$ShortcutPath,
    [Parameter(Mandatory = $true)][string]$PowerShellPath,
    [Parameter(Mandatory = $true)][string]$ExpectedArguments,
    [Parameter(Mandatory = $true)][string]$ProjectRoot
  )

  if (-not (Test-Path -LiteralPath $ShortcutPath)) {
    return [PSCustomObject]@{ Status = 'Disabled'; Enabled = $false; Message = '开机自启当前已关闭。' }
  }
  if (-not (Test-Path -LiteralPath $ShortcutPath -PathType Leaf)) {
    return [PSCustomObject]@{ Status = 'Invalid'; Enabled = $false; Message = '固定快捷方式路径不是文件，请先关闭开机自启后再重新启用。' }
  }

  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($ShortcutPath)
  $problems = New-Object System.Collections.Generic.List[string]

  if ([string]::IsNullOrWhiteSpace($shortcut.TargetPath) -or -not (Test-SamePath -Left $shortcut.TargetPath -Right $PowerShellPath)) {
    $problems.Add('启动程序不匹配')
  }
  if (-not [string]::Equals($shortcut.Arguments, $ExpectedArguments, [System.StringComparison]::Ordinal)) {
    $problems.Add('启动参数不匹配')
  }
  if ([string]::IsNullOrWhiteSpace($shortcut.WorkingDirectory) -or -not (Test-SamePath -Left $shortcut.WorkingDirectory -Right $ProjectRoot)) {
    $problems.Add('项目目录不匹配')
  }

  if ($problems.Count -gt 0) {
    return [PSCustomObject]@{
      Status = 'Invalid'
      Enabled = $false
      Message = "检测到旧的或异常的开机启动快捷方式（$($problems -join '、')）。请先关闭，再重新启用。"
    }
  }

  return [PSCustomObject]@{ Status = 'Enabled'; Enabled = $true; Message = '开机自启当前已启用。' }
}

function Write-OperationResult {
  param(
    [Parameter(Mandatory = $true)][string]$RequestedAction,
    [Parameter(Mandatory = $true)][object]$StatusResult,
    [Parameter(Mandatory = $true)][string]$ShortcutPath
  )

  $result = [PSCustomObject]@{
    Action = $RequestedAction
    Status = $StatusResult.Status
    Enabled = [bool]$StatusResult.Enabled
    Message = $StatusResult.Message
    ShortcutPath = $ShortcutPath
  }

  if ($Json) {
    $result | ConvertTo-Json -Compress
    return
  }

  Write-Host $result.Message
  Write-Host "快捷方式：$ShortcutPath"
}

try {
  $startupDirectory = Get-ValidatedStartupDirectory
  $paths = Get-ProjectPaths
  $shortcutPath = Get-ShortcutPath -Directory $startupDirectory
  $powerShellPath = Get-PowerShellPath
  $expectedArguments = Get-ExpectedArguments -StartScript $paths.StartScript
  $currentStatus = Get-ShortcutStatus -ShortcutPath $shortcutPath -PowerShellPath $powerShellPath -ExpectedArguments $expectedArguments -ProjectRoot $paths.ProjectRoot

  switch ($Action) {
    'Enable' {
      if ($currentStatus.Status -eq 'Invalid') {
        throw $currentStatus.Message
      }
      if ($currentStatus.Status -ne 'Enabled') {
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($shortcutPath)
        $shortcut.TargetPath = $powerShellPath
        $shortcut.Arguments = $expectedArguments
        $shortcut.WorkingDirectory = $paths.ProjectRoot
        $shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,137"
        $shortcut.Description = '登录 Windows 后启动简作桌面壳与系统托盘'
        $shortcut.WindowStyle = 7
        $shortcut.Save()
      }
      $currentStatus = Get-ShortcutStatus -ShortcutPath $shortcutPath -PowerShellPath $powerShellPath -ExpectedArguments $expectedArguments -ProjectRoot $paths.ProjectRoot
      if ($currentStatus.Status -ne 'Enabled') { throw '快捷方式创建后校验失败，未启用开机自启。' }
      $currentStatus.Message = '已启用开机自启。下次登录 Windows 时会启动简作工作台。'
    }
    'Disable' {
      if (Test-Path -LiteralPath $shortcutPath) {
        if (-not (Test-Path -LiteralPath $shortcutPath -PathType Leaf)) {
          throw '固定快捷方式路径不是文件，已拒绝删除。'
        }
        Remove-Item -LiteralPath $shortcutPath -Force
      }
      if (Test-Path -LiteralPath $shortcutPath) { throw '快捷方式删除失败，开机自启仍可能生效。' }
      $currentStatus = [PSCustomObject]@{
        Status = 'Disabled'
        Enabled = $false
        Message = '已关闭开机自启。手动启动方式不受影响。'
      }
    }
    'Status' { }
  }

  Write-OperationResult -RequestedAction $Action -StatusResult $currentStatus -ShortcutPath $shortcutPath
} catch {
  $message = "开机自启操作失败：$($_.Exception.Message)"
  if ($Json) {
    [PSCustomObject]@{
      Action = $Action
      Status = 'Error'
      Enabled = $false
      Message = $message
      ShortcutPath = $null
    } | ConvertTo-Json -Compress
  } else {
    Write-Error $message
  }
  exit 1
}
