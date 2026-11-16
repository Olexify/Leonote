# Everything, one after another. The installer build also refreshes the exe,
# so the portable copy is taken from it rather than compiling twice.
. "$PSScriptRoot\_common.ps1"
& "$PSScriptRoot\build-installer.ps1"
$dir = New-OutDir "windows-portable"
$to = Join-Path $dir "Leonote-$Version-portable.exe"
Copy-Item (Join-Path $Release "leonote-rs.exe") $to -Force
Write-Done "Portable exe" $to
try { & "$PSScriptRoot\build-linux.ps1" } catch { Write-Host "  Linux: $($_.Exception.Message)" -ForegroundColor Yellow }
Write-Host ""
Write-Host "  Everything is under $Out" -ForegroundColor Green
