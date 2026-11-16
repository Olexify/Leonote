# The Linux build, made inside Docker (Docker Desktop has to be running):
#   release\linux\*.deb  and  *.AppImage
# The first run downloads a few GB of Linux build tools and takes a long time;
# later runs reuse them. Nothing is installed on Windows itself.
. "$PSScriptRoot\_common.ps1"
& docker info *> $null
if ($LASTEXITCODE -ne 0) { throw "Docker is not running. Start Docker Desktop, wait until it says it is running, and try again." }
$dir = New-OutDir "linux"
Push-Location $Root
try {
    # Docker Desktop's network is often not ready in its first minute, and Docker
    # Hub is sometimes unreachable: try it, wait, try again, then use the official
    # mirror of the same Ubuntu image on AWS.
    $base = $null
    foreach ($try in @("ubuntu:22.04", "ubuntu:22.04", "public.ecr.aws/docker/library/ubuntu:22.04")) {
        & docker pull $try
        if ($LASTEXITCODE -eq 0) { $base = $try; break }
        Write-Host "  Could not fetch $try - waiting a little and trying again..." -ForegroundColor Yellow
        Start-Sleep -Seconds 12
    }
    if (-not $base) { throw "Docker cannot reach any image registry. Check the internet connection, a VPN or a firewall asking about Docker, then try again." }
    & docker build --build-arg "BASE=$base" -f scripts/linux.Dockerfile -t leonote-linux-build .
    if ($LASTEXITCODE -ne 0) { throw "could not prepare the Linux build image - the lines above say where it stopped" }
    # target-linux and the cargo cache are volumes: a Linux build tree must not
    # be mixed into the Windows one, and keeping them makes the next build quick
    & docker run --rm `
        -v "${Root}:/src:ro" `
        -v "${dir}:/out" `
        -v leonote-linux-target:/build/src-tauri/target `
        -v leonote-linux-cargo:/root/.cargo/registry `
        -v leonote-linux-node:/build/node_modules `
        leonote-linux-build
    if ($LASTEXITCODE -ne 0) { throw "the Linux build failed - the lines above say where" }
} finally { Pop-Location }
Get-ChildItem $dir -File | ForEach-Object { Write-Done "Linux" $_.FullName }
