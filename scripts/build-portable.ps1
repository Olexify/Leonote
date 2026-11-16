# The app as one exe, no installer:  release\windows-portable\Leonote-<version>-portable.exe
. "$PSScriptRoot\_common.ps1"
Step-Aside
Invoke-Tauri @("--no-bundle")
$dir = New-OutDir "windows-portable"
$to = Join-Path $dir "Leonote-$Version-portable.exe"
Copy-Item (Join-Path $Release "leonote-rs.exe") $to -Force
Write-Done "Portable exe" $to
