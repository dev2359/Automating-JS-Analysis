$ErrorActionPreference = 'Continue'
Set-Location (Join-Path $PSScriptRoot '..')
$status = git status --porcelain 2>$null
if (-not $status) { exit 0 }
git add -A 2>&1 | Out-Null
$ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
git commit -m "auto: claude session $ts" 2>&1 | Out-Null
git push 2>&1 | Out-Null
exit 0
