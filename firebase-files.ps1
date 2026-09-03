# Finds the Firebase config files in Downloads, proves they belong to PorchPay,
# and writes the two base64 values Codemagic needs.
#
# The check matters: Chrome saves a second download as "google-services (1).json"
# rather than overwriting, so picking by name alone can silently hand you another
# project's config. That happened once already — Deal Flow Pro's file was sitting
# in Downloads from July and got picked up instead.

$ErrorActionPreference = 'Stop'
$dl   = Join-Path $env:USERPROFILE 'Downloads'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$out  = Join-Path $here 'firebase-codemagic-values.txt'

function Find-PorchPayFile {
    param($Pattern, $Label)

    $files = Get-ChildItem -Path $dl -Filter $Pattern -File -ErrorAction SilentlyContinue |
             Sort-Object LastWriteTime -Descending
    if (-not $files) {
        Write-Host "  [X] No $Label in Downloads." -ForegroundColor Red
        return $null
    }
    foreach ($f in $files) {
        $txt = Get-Content $f.FullName -Raw
        if ($txt -like '*com.porchpay.app*') {
            Write-Host ("  [OK]   {0}" -f $f.Name) -ForegroundColor Green
            Write-Host ("         downloaded {0}" -f $f.LastWriteTime) -ForegroundColor DarkGray
            return $f
        }
        Write-Host ("  [skip] {0} - belongs to another project" -f $f.Name) -ForegroundColor DarkYellow
    }
    Write-Host "  [X] Found $Label but none were PorchPay." -ForegroundColor Red
    return $null
}

Write-Host ''
Write-Host '  Checking Downloads...' -ForegroundColor Cyan
Write-Host ''

$gs = Find-PorchPayFile 'google-services*.json'      'google-services.json'
$pl = Find-PorchPayFile 'GoogleService-Info*.plist'  'GoogleService-Info.plist'

if (-not $gs -or -not $pl) {
    Write-Host ''
    Write-Host '  Download the missing file from the Firebase console:' -ForegroundColor Yellow
    Write-Host '    Project settings > General > scroll to "Your apps"' -ForegroundColor Yellow
    Write-Host '  Then run this again.' -ForegroundColor Yellow
    Write-Host ''
    exit 1
}

Copy-Item $gs.FullName (Join-Path $here 'google-services.json')     -Force
Copy-Item $pl.FullName (Join-Path $here 'GoogleService-Info.plist') -Force

$b1 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($gs.FullName))
$b2 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($pl.FullName))

$sep = '=' * 60
@(
  'PORCHPAY - PASTE THESE INTO CODEMAGIC'
  ''
  'Codemagic > your app > Environment variables'
  'Group: appstore      Secure: TICKED'
  ''
  "Source: $($gs.Name)  and  $($pl.Name)"
  'Both verified to contain com.porchpay.app'
  ''
  $sep
  'VARIABLE NAME:  GOOGLE_SERVICES_JSON'
  $sep
  ''
  $b1
  ''
  ''
  $sep
  'VARIABLE NAME:  GOOGLE_SERVICE_INFO_PLIST'
  $sep
  ''
  $b2
) | Set-Content -Path $out -Encoding ASCII

Write-Host ''
Write-Host '  Written: firebase-codemagic-values.txt' -ForegroundColor Green
Write-Host ''
exit 0
