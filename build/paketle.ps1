# MobilMotor kurulum paketini üretir: build\cikti\MobilMotor-Kurulum.exe
# İndirme yapmaz: bu bilgisayardaki doğrulanmış bileşenleri paketler.
#   - node.exe          : C:\Program Files\nodejs (Authenticode imzası OpenJS Foundation olmalı)
#   - platform-tools    : Android SDK'daki adb (imzası Google olmalı)
#   - scrcpy            : tools\scrcpy (SHA-256 + GPG ile doğrulanmıştı)
# Çalıştır: powershell -ExecutionPolicy Bypass -File build\paketle.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$out = Join-Path $PSScriptRoot 'cikti'
$stage = Join-Path $out 'paket'
$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$fw = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319"

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force $stage | Out-Null

function Imza($file, $beklenen) {
  $s = Get-AuthenticodeSignature $file
  if ($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notmatch $beklenen) { throw "İmza doğrulanamadı: $file ($($s.Status), $($s.SignerCertificate.Subject))" }
  Write-Host "  imza tamam: $(Split-Path $file -Leaf) — $($s.SignerCertificate.Subject -replace ',.*','')"
}

Write-Host '1) Uygulama dosyaları'
foreach ($f in 'server.js', 'package.json', 'README.md') { Copy-Item (Join-Path $root $f) $stage }
foreach ($d in 'lib', 'public', 'qa') { Copy-Item (Join-Path $root $d) (Join-Path $stage $d) -Recurse }
New-Item -ItemType Directory -Force "$stage\tools\dil" | Out-Null
Copy-Item "$root\tools\dil\mm-dil.dex" "$stage\tools\dil\"
Copy-Item "$root\tools\dil\src" "$stage\tools\dil\src" -Recurse
Copy-Item "$root\tools\scrcpy" "$stage\tools\scrcpy" -Recurse
New-Item -ItemType Directory -Force "$stage\data" | Out-Null

Write-Host '2) Node.js çalışma ortamı'
$node = 'C:\Program Files\nodejs\node.exe'
Imza $node 'OpenJS Foundation'
New-Item -ItemType Directory -Force "$stage\runtime" | Out-Null
Copy-Item $node "$stage\runtime\node.exe"
Copy-Item 'C:\Program Files\nodejs\LICENSE' "$stage\runtime\LICENSE-node.txt" -ErrorAction SilentlyContinue

Write-Host '3) Android adb (platform-tools)'
$pt = "$env:LOCALAPPDATA\Android\Sdk\platform-tools"
Imza "$pt\adb.exe" 'Google'
New-Item -ItemType Directory -Force "$stage\sdk\platform-tools" | Out-Null
foreach ($f in 'adb.exe', 'AdbWinApi.dll', 'AdbWinUsbApi.dll', 'NOTICE.txt', 'source.properties') {
  if (Test-Path "$pt\$f") { Copy-Item "$pt\$f" "$stage\sdk\platform-tools\" }
}

Write-Host '4) Başlatıcı ve kurulum programı'
& "$root\launcher\ikon.ps1" | Out-Null
& $csc /nologo /target:winexe /optimize+ /codepage:65001 /win32icon:"$root\launcher\mobilmotor.ico" /out:"$stage\MobilMotor.exe" /r:System.Windows.Forms.dll /r:System.Drawing.dll "$root\launcher\MobilMotor.cs"
if ($LASTEXITCODE) { throw 'Başlatıcı derlenemedi' }
Copy-Item "$root\launcher" "$stage\launcher-kaynak" -Recurse

Write-Host '5) Paket (zip)'
$zip = Join-Path $out 'payload.zip'
if (Test-Path $zip) { Remove-Item $zip }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip, [System.IO.Compression.CompressionLevel]::Optimal, $false)

# Yönetici izni istemesin (Windows, "kurulum" adlı exe'leri yönetici sanabilir)
$manifest = Join-Path $out 'kurulum.manifest'
@'
<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <assemblyIdentity version="1.0.0.0" name="MobilMotor.Kurulum" type="win32"/>
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
    <security><requestedPrivileges><requestedExecutionLevel level="asInvoker" uiAccess="false"/></requestedPrivileges></security>
  </trustInfo>
  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1">
    <application><supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}"/></application>
  </compatibility>
</assembly>
'@ | Set-Content $manifest -Encoding UTF8

$setup = Join-Path $out 'MobilMotor-Kurulum.exe'
& $csc /nologo /target:winexe /optimize+ /codepage:65001 /win32icon:"$root\launcher\mobilmotor.ico" /win32manifest:$manifest `
  /out:$setup /resource:"$zip,payload.zip" `
  /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Management.dll `
  /r:"$fw\System.IO.Compression.dll" /r:"$fw\System.IO.Compression.FileSystem.dll" `
  "$root\launcher\Kurulum.cs"
if ($LASTEXITCODE) { throw 'Kurulum programı derlenemedi' }
Remove-Item $zip, $manifest

$h = (Get-FileHash $setup -Algorithm SHA256).Hash
"$h  MobilMotor-Kurulum.exe" | Set-Content (Join-Path $out 'MobilMotor-Kurulum.sha256.txt')
$mb = [math]::Round((Get-Item $setup).Length / 1MB, 1)
Write-Host ""
Write-Host "HAZIR: $setup ($mb MB)"
Write-Host "SHA-256: $h"
