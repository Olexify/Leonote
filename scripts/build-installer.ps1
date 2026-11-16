# The Windows installer:  release\windows-installer\Leonote_<version>_x64-setup.exe
. "$PSScriptRoot\_common.ps1"
Step-Aside
Invoke-Tauri @("--bundles", "nsis")
$dir = New-OutDir "windows-installer"
$made = Get-ChildItem (Join-Path $Release "bundle\nsis") -Filter "*-setup.exe" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $made) { throw "the installer was not produced" }
$to = Join-Path $dir $made.Name
Copy-Item $made.FullName $to -Force
(Get-FileHash $to -Algorithm SHA256).Hash.ToLower() + "  " + $made.Name | Set-Content (Join-Path $dir ($made.Name + ".sha256")) -Encoding ascii
Write-Done "Installer" $to
Write-Host "  Unsigned: people will see SmartScreen once - More info, Run anyway."
