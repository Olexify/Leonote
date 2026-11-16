# Shared by the build scripts. Dot-sourced, not run on its own.
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Release = Join-Path $Root "src-tauri\target\release"
$Out = Join-Path $Root "release"
$Version = (Get-Content (Join-Path $Root "src-tauri\tauri.conf.json") -Raw | ConvertFrom-Json).version

# Leonote may be running from the very exe the build wants to replace. Windows
# lets a running exe be RENAMED but not overwritten, so it is moved aside and
# the app is never closed. Older leftovers are cleared when nothing holds them.
function Step-Aside {
    $exe = Join-Path $Release "leonote-rs.exe"
    Get-ChildItem $Release -Filter "leonote-rs.old-*.exe" -ErrorAction SilentlyContinue | ForEach-Object {
        try { Remove-Item $_.FullName -Force -ErrorAction Stop } catch {}
    }
    if (Test-Path $exe) { Rename-Item $exe ("leonote-rs.old-{0}.exe" -f (Get-Date -Format "HHmmss")) }
}

function New-OutDir([string]$name) {
    $dir = Join-Path $Out $name
    New-Item -ItemType Directory -Force $dir | Out-Null
    return $dir
}

function Invoke-Tauri([string[]]$buildArgs) {
    Push-Location $Root
    try {
        & npx tauri build @buildArgs
        if ($LASTEXITCODE -ne 0) { throw "tauri build failed ($LASTEXITCODE)" }
    } finally { Pop-Location }
}

function Write-Done([string]$what, [string]$path) {
    $mb = "{0:N1}" -f ((Get-Item $path).Length / 1MB)
    Write-Host ""
    Write-Host "  $what  ->  $path  ($mb MB)" -ForegroundColor Green
}

# Every build is kept as target\release\versions\build-0007 <date>.exe: the 10
# latest, plus every 10th for good in versions\archive - so how the app worked
# before something broke can be started in a moment.
function Save-Version {
  $dir = Join-Path $Release "versions"
  $arch = Join-Path $dir "archive"
  New-Item -ItemType Directory -Force $arch | Out-Null
  $counter = Join-Path $dir "counter.txt"
  $n = 1
  if (Test-Path $counter) { $n = [int](Get-Content $counter -Raw) + 1 }
  Set-Content $counter $n
  $name = "build-{0:D4} {1}.exe" -f $n, (Get-Date -Format "yyyy-MM-dd HHmm")
  Copy-Item (Join-Path $Release "leonote-rs.exe") (Join-Path $dir $name)
  if ($n % 10 -eq 0) { Copy-Item (Join-Path $dir $name) (Join-Path $arch $name) }
  Get-ChildItem $dir -Filter "build-*.exe" | Sort-Object Name -Descending | Select-Object -Skip 10 | Remove-Item -Force
  Write-Host "  Kept as versions\$name"
}
