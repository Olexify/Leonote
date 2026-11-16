# Leonote's security check: run it once a month and before every release.
#   powershell -ExecutionPolicy Bypass -File scripts\security-check.ps1
# What it does (nothing is changed or sent anywhere, apart from downloading the public lists of known holes):
#   1. the guardrails and every test (npm test)
#   2. known holes in the JavaScript libraries (npm audit, the shipped ones)
#   3. known holes in the Rust libraries (cargo audit - its list fetched by git if its own download fails)
#   4. secrets in the code and its history (gitleaks)
#   5. risky code patterns (semgrep, when installed)
# Anything red: fix it (usually `cargo update -p <crate>` or `npm update <package>`), run this again, then build.
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$bad = @()
function Step($name, [scriptblock]$run) {
  Write-Host "`n== $name" -ForegroundColor Cyan
  & $run
  if ($LASTEXITCODE -ne 0) { $script:bad += $name; Write-Host "!! $name found something" -ForegroundColor Red } else { Write-Host "ok" -ForegroundColor Green }
}
function Have($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

Step "Tests and guardrails" { npm test --silent 2>&1 | Select-String -Pattern "^# (pass|fail)|^not ok" }
Step "JavaScript libraries (npm audit)" { npm audit --omit=dev }

if (Have cargo-audit) {
  Step "Rust libraries (cargo audit)" {
    Push-Location src-tauri
    cargo audit 2>$null
    if ($LASTEXITCODE -ne 0) {
      # its own download sometimes fails here: the same public list, fetched with git
      $db = Join-Path $env:TEMP "advisory-db"
      if (Test-Path $db) { git -C $db pull -q } else { git clone -q --depth 1 https://github.com/RustSec/advisory-db $db }
      cargo audit --no-fetch --db $db
    }
    Pop-Location
  }
} else { Write-Host "`n(cargo audit is not installed: cargo install cargo-audit)" -ForegroundColor Yellow }

if (Have gitleaks) { Step "Secrets (gitleaks)" { gitleaks git . --no-banner } } else { Write-Host "`n(gitleaks is not installed: winget install gitleaks)" -ForegroundColor Yellow }

if (Have semgrep) {
  Step "Risky patterns (semgrep)" {
    $out = Join-Path $env:TEMP "leonote-semgrep.json"
    semgrep --config p/javascript --config p/rust --config p/owasp-top-ten --config p/secrets --metrics=off --json --output $out --exclude node_modules --exclude dist --exclude release --exclude target web src-tauri/src 2>$null | Out-Null
    $r = Get-Content $out -Raw | ConvertFrom-Json
    # expected noise in Rust: Windows calls marked unsafe, the temp folder, the program's own arguments and path;
    # in the Dataview frame: messages to its sandbox (which has no address to name)
    $known = "unsafe-usage|temp-dir|args|current-exe|wildcard-postmessage-configuration"
    $new = @($r.results | Where-Object { $_.check_id -notmatch $known })
    $new | ForEach-Object { Write-Host ("  {0}:{1}  {2}" -f $_.path, $_.start.line, $_.check_id) }
    $global:LASTEXITCODE = [int]($new.Count -gt 0)
  }
} else { Write-Host "`n(semgrep is not installed: pip install semgrep)" -ForegroundColor Yellow }

Write-Host ""
if ($bad.Count) { Write-Host ("Needs a look: " + ($bad -join ", ")) -ForegroundColor Red; exit 1 }
Write-Host "All clear." -ForegroundColor Green
