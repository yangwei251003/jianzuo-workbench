$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$securePin = Read-Host '请输入当前本地 PIN' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePin)
try {
  $plainPin = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  $env:JIANZUO_BACKUP_PIN = $plainPin
  & pnpm --filter '@jianzuo/api' exec tsx src/cli-backup.ts
  if ($LASTEXITCODE -ne 0) { throw '备份失败。' }
} finally {
  Remove-Item Env:JIANZUO_BACKUP_PIN -ErrorAction SilentlyContinue
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
}

