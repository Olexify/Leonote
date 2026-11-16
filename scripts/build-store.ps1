# The Microsoft Store package:  release\microsoft-store\Leonote_<version>_x64.msix
#
#   build-store.cmd            build the app, then pack the .msix to upload in Partner Center
#   build-store.cmd -NoBuild   pack the exe this script already built (any other exe is refused)
#   build-store.cmd -Sign      also a copy signed with a test certificate, to install and try here
#
# The Store signs the package itself, so the upload is unsigned. What names the
# package comes from Partner Center (Product management > Product identity) and
# is kept in release\microsoft-store\identity.json - made on the first run.
# MakeAppx and SignTool come from Microsoft's "SDK Build Tools" package, fetched
# once into release\microsoft-store\tools when the Windows SDK is not installed.
param([switch]$NoBuild, [switch]$Sign)
. "$PSScriptRoot\_common.ps1"

$dir = New-OutDir "microsoft-store"
$idFile = Join-Path $dir "identity.json"
if (-not (Test-Path $idFile)) {
    @{
        Name = "PASTE Package/Identity/Name here"
        Publisher = "PASTE Package/Identity/Publisher here (it starts with CN=)"
        PublisherDisplayName = "PASTE Package/Properties/PublisherDisplayName here"
    } | ConvertTo-Json | Set-Content $idFile -Encoding utf8
    Write-Host ""
    Write-Host "  Made $idFile" -ForegroundColor Yellow
    Write-Host "  Paste the three values from Partner Center > your app > Product management > Product identity into it, then run this again."
    exit 1
}
$id = Get-Content $idFile -Raw | ConvertFrom-Json
foreach ($k in "Name", "Publisher", "PublisherDisplayName") {
    if (-not $id.$k -or $id.$k -like "PASTE*") { throw "identity.json: $k is not filled in yet (Partner Center > Product management > Product identity)" }
}
if ($id.Publisher -notlike "CN=*") { throw "identity.json: Publisher must be the whole CN=... line from Partner Center" }

# the tools: the installed Windows SDK, or the Build Tools package fetched once
function Find-Tool([string]$exe) {
    $kits = "${env:ProgramFiles(x86)}\Windows Kits\10\bin"
    $found = @()
    if (Test-Path $kits) { $found += Get-ChildItem $kits -Recurse -Filter $exe -ErrorAction SilentlyContinue | Where-Object { $_.FullName -match "\\x64\\" } }
    $cache = Join-Path $dir "tools"
    if (Test-Path $cache) { $found += Get-ChildItem $cache -Recurse -Filter $exe -ErrorAction SilentlyContinue | Where-Object { $_.FullName -match "\\x64\\" } }
    return ($found | Sort-Object FullName -Descending | Select-Object -First 1).FullName
}
$makeappx = Find-Tool "makeappx.exe"
if (-not $makeappx) {
    Write-Host "  Fetching Microsoft's SDK Build Tools (MakeAppx, SignTool) - once..."
    $cache = New-OutDir "microsoft-store\tools"
    $zip = Join-Path $cache "buildtools.zip"
    Invoke-WebRequest "https://www.nuget.org/api/v2/package/Microsoft.Windows.SDK.BuildTools" -OutFile $zip -UseBasicParsing
    Expand-Archive $zip -DestinationPath (Join-Path $cache "sdk") -Force
    Remove-Item $zip -Force
    $makeappx = Find-Tool "makeappx.exe"
    if (-not $makeappx) { throw "MakeAppx was not found in the Build Tools package" }
}
# whatever we use, downloaded now or found from before, must be Microsoft's own: its Authenticode signature
# valid and Microsoft's - a package swapped on the way or a file planted in the cache is refused, not run
function Assert-Microsoft($path) {
    $sig = Get-AuthenticodeSignature -FilePath $path
    if ($sig.Status -ne "Valid" -or $sig.SignerCertificate.Subject -notmatch "O=Microsoft Corporation") {
        throw "$path is not signed by Microsoft ($($sig.Status)) - delete $(Join-Path $dir 'microsoft-store	ools') and run again"
    }
}
Assert-Microsoft $makeappx

$exe = Join-Path $Release "leonote-rs.exe"
$storeMark = Join-Path $dir "store-exe.sha256"
if (-not $NoBuild) {
    Step-Aside
    # feature "store" marks it as the Store's
    Invoke-Tauri @("--no-bundle", "--features", "store")
    Save-Version
    (Get-FileHash $exe -Algorithm SHA256).Hash | Set-Content $storeMark
}
if (-not (Test-Path $exe)) { throw "no leonote-rs.exe built yet - run without -NoBuild" }
# -NoBuild packs only the exe this script built: the same path also holds the direct-download build
if (-not (Test-Path $storeMark) -or (Get-Content $storeMark -Raw).Trim() -ne (Get-FileHash $exe -Algorithm SHA256).Hash) { throw "that leonote-rs.exe was not built for the Store - run without -NoBuild" }

# a Store version has four parts, the last kept at 0 for the Store; the build counter makes each upload newer
$counter = [int](Get-Content (Join-Path $Release "versions\counter.txt") -Raw)
$v = $Version.Split(".")
$msixVersion = "{0}.{1}.{2}.0" -f $v[0], $v[1], ([int]$v[2] * 1000 + $counter)

$stage = Join-Path $dir "stage"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force (Join-Path $stage "Assets") | Out-Null
Copy-Item $exe (Join-Path $stage "leonote-rs.exe")
$icons = Join-Path $Root "src-tauri\icons"
foreach ($a in "StoreLogo.png", "Square44x44Logo.png", "Square150x150Logo.png") { Copy-Item (Join-Path $icons $a) (Join-Path $stage "Assets\$a") }

$esc = { param($s) [System.Security.SecurityElement]::Escape($s) }
@"
<?xml version="1.0" encoding="utf-8"?>
<Package
  xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:uap3="http://schemas.microsoft.com/appx/manifest/uap/windows10/3"
  xmlns:desktop="http://schemas.microsoft.com/appx/manifest/desktop/windows10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  IgnorableNamespaces="uap uap3 desktop rescap">
  <Identity Name="$(& $esc $id.Name)" Publisher="$(& $esc $id.Publisher)" Version="$msixVersion" ProcessorArchitecture="x64" />
  <Properties>
    <DisplayName>Leonote</DisplayName>
    <PublisherDisplayName>$(& $esc $id.PublisherDisplayName)</PublisherDisplayName>
    <Logo>Assets\StoreLogo.png</Logo>
  </Properties>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.17763.0" MaxVersionTested="10.0.26100.0" />
  </Dependencies>
  <Resources>
    <Resource Language="en-us" />
  </Resources>
  <Applications>
    <Application Id="LeoNote" Executable="leonote-rs.exe" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements DisplayName="Leonote" Description="Notes, tasks, calendar and your media in one fast, private place." BackgroundColor="transparent" Square150x150Logo="Assets\Square150x150Logo.png" Square44x44Logo="Assets\Square44x44Logo.png" />
      <Extensions>
        <uap3:Extension Category="windows.appExecutionAlias" Executable="leonote-rs.exe" EntryPoint="Windows.FullTrustApplication">
          <uap3:AppExecutionAlias>
            <desktop:ExecutionAlias Alias="leonote-rs.exe" />
          </uap3:AppExecutionAlias>
        </uap3:Extension>
        <uap:Extension Category="windows.fileTypeAssociation">
          <uap:FileTypeAssociation Name="leonote.notes">
            <uap:DisplayName>Note</uap:DisplayName>
            <uap:SupportedFileTypes>
              <uap:FileType>.md</uap:FileType>
              <uap:FileType>.markdown</uap:FileType>
              <uap:FileType>.txt</uap:FileType>
            </uap:SupportedFileTypes>
          </uap:FileTypeAssociation>
        </uap:Extension>
        <desktop:Extension Category="windows.startupTask" Executable="leonote-rs.exe" EntryPoint="Windows.FullTrustApplication">
          <desktop:StartupTask TaskId="LeoNoteAtLogin" Enabled="false" DisplayName="Leonote" />
        </desktop:Extension>
      </Extensions>
    </Application>
  </Applications>
  <Capabilities>
    <rescap:Capability Name="runFullTrust" />
  </Capabilities>
</Package>
"@ | Set-Content (Join-Path $stage "AppxManifest.xml") -Encoding utf8

$msix = Join-Path $dir ("Leonote_{0}_x64.msix" -f $msixVersion)
& $makeappx pack /d $stage /p $msix /o /h SHA256 | Out-Null
if ($LASTEXITCODE -ne 0) { & $makeappx pack /d $stage /p $msix /o /h SHA256; throw "MakeAppx could not pack it ($LASTEXITCODE)" }
Write-Done "Store package (upload this in Partner Center)" $msix

if ($Sign) {
    # a test certificate with the same publisher, to install the package on this PC; the Store's own signing replaces it
    $signtool = Find-Tool "signtool.exe"
    if (-not $signtool) { throw "SignTool was not found" }
    Assert-Microsoft $signtool
    $cert = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Subject -eq $id.Publisher -and $_.FriendlyName -eq "LeoNote test signing" } | Select-Object -First 1
    if (-not $cert) {
        $cert = New-SelfSignedCertificate -Type Custom -Subject $id.Publisher -KeyUsage DigitalSignature -FriendlyName "LeoNote test signing" -CertStoreLocation "Cert:\CurrentUser\My" -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3", "2.5.29.19={text}")
    }
    $test = Join-Path $dir ("Leonote_{0}_x64_test-signed.msix" -f $msixVersion)
    Copy-Item $msix $test -Force
    & $signtool sign /fd SHA256 /sha1 $cert.Thumbprint /s My $test | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "SignTool could not sign the test copy ($LASTEXITCODE)" }
    $cer = Join-Path $dir "LeoNote-test.cer"
    Export-Certificate -Cert $cert -FilePath $cer | Out-Null
    Write-Done "Test-signed copy" $test
    Write-Host "  To install it here: trust the test certificate once (as administrator):"
    Write-Host "    Import-Certificate -FilePath `"$cer`" -CertStoreLocation Cert:\LocalMachine\TrustedPeople"
    Write-Host "  then double-click the test-signed .msix."
}
Write-Host "  Upload the unsigned .msix; Partner Center signs it. Each upload needs a higher version - every build raises it by itself."
