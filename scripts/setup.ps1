$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw '需要 Node.js 24 或更高版本。' }
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) { throw '需要 pnpm 10 或更高版本。' }

Write-Host '正在安装依赖并构建简作工作台...'
& pnpm install
if ($LASTEXITCODE -ne 0) { throw '依赖安装失败。' }
& pnpm typecheck
if ($LASTEXITCODE -ne 0) { throw '类型检查失败。' }
& pnpm build
if ($LASTEXITCODE -ne 0) { throw '构建失败。' }

$dataDirectories = @(
  (Join-Path $projectRoot 'data'),
  (Join-Path $projectRoot 'data\runtime'),
  (Join-Path $projectRoot 'data\logs'),
  (Join-Path $projectRoot 'data\backups'),
  (Join-Path $projectRoot 'data\artifacts'),
  (Join-Path $projectRoot 'data\browser-profile')
)
foreach ($directory in $dataDirectories) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }

$desktopPath = [Environment]::GetFolderPath('Desktop')
$shell = New-Object -ComObject WScript.Shell
$startShortcut = $shell.CreateShortcut((Join-Path $desktopPath '启动简作闲鱼工作台.lnk'))
$startShortcut.TargetPath = (Get-Command powershell.exe).Source
$startShortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $projectRoot 'scripts\start-desktop.ps1')`""
$startShortcut.WorkingDirectory = $projectRoot
$startShortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,137"
$startShortcut.Description = '启动简作桌面壳、系统托盘与闲鱼 AI 运营工作台'
$startShortcut.Save()

$stopShortcut = $shell.CreateShortcut((Join-Path $desktopPath '停止简作闲鱼工作台.lnk'))
$stopShortcut.TargetPath = (Get-Command powershell.exe).Source
$stopShortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $projectRoot 'scripts\stop.ps1')`""
$stopShortcut.WorkingDirectory = $projectRoot
$stopShortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,131"
$stopShortcut.Description = '停止简作工作台本地服务'
$stopShortcut.Save()

Write-Host '安装完成。桌面已创建带系统托盘的“启动简作闲鱼工作台”和“停止简作闲鱼工作台”。'
