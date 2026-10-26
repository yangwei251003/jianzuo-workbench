$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $projectRoot
& pnpm --filter '@jianzuo/desktop' start
exit $LASTEXITCODE
