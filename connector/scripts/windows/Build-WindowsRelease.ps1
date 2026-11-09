#requires -Version 5.1

[CmdletBinding()]
param(
  [string]$OutputRoot = '',
  [string]$DshProviderPackageDirectory = '',
  [string]$Dsh015ProviderPackageDirectory = '',
  [string]$Dsh016ProviderPackageDirectory = '',
  [string]$Dsh017ProviderPackageDirectory = '',
  [string]$Dsh017Rc2ProviderPackageDirectory = '',
  [string]$Dsh020Rc1ProviderPackageDirectory = '',
  [string]$Dsh020Rc2ProviderPackageDirectory = '',
  [string]$Dsh021Rc2ProviderPackageDirectory = '',
  [string]$Dsh021Rc3ProviderPackageDirectory = '',
  [string]$Dsh021Rc5ProviderPackageDirectory = '',
  [string]$Dsh022Rc1ProviderPackageDirectory = '',
  [switch]$SkipTests
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$connectorRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
if ($OutputRoot.Length -eq 0) {
  $OutputRoot = Join-Path $connectorRoot 'release-output'
}
$OutputRoot = [System.IO.Path]::GetFullPath($OutputRoot)
$packageJson = Get-Content -LiteralPath (Join-Path $connectorRoot 'package.json') -Raw | ConvertFrom-Json
$version = [string]$packageJson.version
if ($version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$') {
  throw 'connector/package.json contains an invalid release version.'
}

$releaseName = "DSHOS-Link-Connector-$version-Windows"
$stage = Join-Path $OutputRoot $releaseName
$archive = Join-Path $OutputRoot ($releaseName + '.zip')
if ((Test-Path -LiteralPath $stage) -or (Test-Path -LiteralPath $archive)) {
  throw "Release output already exists: $releaseName"
}
if ($DshProviderPackageDirectory.Length -eq 0 -or $Dsh015ProviderPackageDirectory.Length -eq 0 -or $Dsh016ProviderPackageDirectory.Length -eq 0 -or $Dsh017ProviderPackageDirectory.Length -eq 0 -or $Dsh017Rc2ProviderPackageDirectory.Length -eq 0 -or $Dsh020Rc1ProviderPackageDirectory.Length -eq 0 -or $Dsh020Rc2ProviderPackageDirectory.Length -eq 0 -or $Dsh021Rc2ProviderPackageDirectory.Length -eq 0 -or $Dsh021Rc3ProviderPackageDirectory.Length -eq 0 -or $Dsh021Rc5ProviderPackageDirectory.Length -eq 0 -or $Dsh022Rc1ProviderPackageDirectory.Length -eq 0) {
  throw 'Provide the pinned official DSH provider directory for every supported version, including 0.2.2-rc.1.'
}
$DshProviderPackageDirectory = [System.IO.Path]::GetFullPath($DshProviderPackageDirectory)
$Dsh015ProviderPackageDirectory = [System.IO.Path]::GetFullPath($Dsh015ProviderPackageDirectory)
$Dsh016ProviderPackageDirectory = [System.IO.Path]::GetFullPath($Dsh016ProviderPackageDirectory)
$Dsh017ProviderPackageDirectory = [System.IO.Path]::GetFullPath($Dsh017ProviderPackageDirectory)

$Dsh017Rc2ProviderPackageDirectory = [System.IO.Path]::GetFullPath($Dsh017Rc2ProviderPackageDirectory)
$Dsh020Rc1ProviderPackageDirectory = [System.IO.Path]::GetFullPath($Dsh020Rc1ProviderPackageDirectory)
$Dsh020Rc2ProviderPackageDirectory = [System.IO.Path]::GetFullPath($Dsh020Rc2ProviderPackageDirectory)
$Dsh021Rc2ProviderPackageDirectory = [System.IO.Path]::GetFullPath($Dsh021Rc2ProviderPackageDirectory)
$Dsh021Rc3ProviderPackageDirectory = [System.IO.Path]::GetFullPath($Dsh021Rc3ProviderPackageDirectory)
$Dsh021Rc5ProviderPackageDirectory = [System.IO.Path]::GetFullPath($Dsh021Rc5ProviderPackageDirectory)
$Dsh022Rc1ProviderPackageDirectory = [System.IO.Path]::GetFullPath($Dsh022Rc1ProviderPackageDirectory)

New-Item -ItemType Directory -Path $stage -Force | Out-Null

function Invoke-ReleaseCommand {
  param([string]$Command, [string[]]$Arguments)
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Release command failed: $Command $($Arguments -join ' ')"
  }
}

function Get-ReleaseFileSha256 {
  param([string]$Path)
  $algorithm = [System.Security.Cryptography.SHA256]::Create()
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $bytes = $algorithm.ComputeHash($stream)
    return (($bytes | ForEach-Object { $_.ToString('X2') }) -join '')
  } finally {
    $stream.Dispose()
    $algorithm.Dispose()
  }
}

Push-Location $connectorRoot
try {
  if (-not $SkipTests) {
    Invoke-ReleaseCommand 'corepack' @('pnpm@11.7.0', 'test')
  }
  $payloads = [ordered]@{}
  foreach ($provider in @(
    @{ path = $DshProviderPackageDirectory; name = 'dshos-link-deepseek-provider.tgz'; version = '0.1.1-rc.2' },
    @{ path = $Dsh015ProviderPackageDirectory; name = 'dshos-link-deepseek-provider-015.tgz'; version = '0.1.5-rc.2' },
    @{ path = $Dsh016ProviderPackageDirectory; name = 'dshos-link-deepseek-provider-016.tgz'; version = '0.1.6-alpha.1' },
    @{ path = $Dsh017ProviderPackageDirectory; name = 'dshos-link-deepseek-provider-017.tgz'; version = '0.1.7-alpha.2' },
    @{ path = $Dsh017Rc2ProviderPackageDirectory; name = 'dshos-link-deepseek-provider-017rc2.tgz'; version = '0.1.7-rc.2' },
    @{ path = $Dsh020Rc1ProviderPackageDirectory; name = 'dshos-link-deepseek-provider-020rc1.tgz'; version = '0.2.0-rc.1' },
    @{ path = $Dsh020Rc2ProviderPackageDirectory; name = 'dshos-link-deepseek-provider-020rc2.tgz'; version = '0.2.0-rc.2' },
    @{ path = $Dsh021Rc2ProviderPackageDirectory; name = 'dshos-link-deepseek-provider-021rc2.tgz'; version = '0.2.1-rc.2' },
    @{ path = $Dsh021Rc3ProviderPackageDirectory; name = 'dshos-link-deepseek-provider-021rc3.tgz'; version = '0.2.1-rc.3' },
    @{ path = $Dsh021Rc5ProviderPackageDirectory; name = 'dshos-link-deepseek-provider-021rc5.tgz'; version = '0.2.1-rc.5' },
    @{ path = $Dsh022Rc1ProviderPackageDirectory; name = 'dshos-link-deepseek-provider-022rc1.tgz'; version = '0.2.2-rc.1' }
  )) {
    $providerManifest = Get-Content (Join-Path $provider.path 'package.json') -Raw | ConvertFrom-Json
    if ($providerManifest.version -cne $provider.version) { throw 'Provider directory/version mapping mismatch.' }
    $providerBuild = Join-Path $OutputRoot ('provider-build-' + [Guid]::NewGuid().ToString('N'))
    Invoke-ReleaseCommand 'node' @('../patches/dsh-deepseek-balance/build.mjs', $provider.path, $providerBuild)
    Push-Location $providerBuild
    try { Invoke-ReleaseCommand 'corepack' @('pnpm@11.7.0', 'pack', '--pack-destination', $providerBuild) }
    finally { Pop-Location }
    $providerTarballs = @(Get-ChildItem -LiteralPath $providerBuild -File -Filter '*.tgz')
    if ($providerTarballs.Count -ne 1) { throw 'Expected exactly one integrated provider tarball.' }
    $providerHash = Get-ReleaseFileSha256 $providerTarballs[0].FullName
    $payloads[$provider.name] = $providerHash.ToLowerInvariant()
    foreach ($directory in @((Join-Path $connectorRoot 'dist'), $stage)) {
      New-Item -ItemType Directory -Path $directory -Force | Out-Null
      Copy-Item -LiteralPath $providerTarballs[0].FullName -Destination (Join-Path $directory $provider.name)
      Set-Content -LiteralPath (Join-Path $directory ($provider.name + '.sha256')) -Value $providerHash -Encoding Ascii
    }
  }
  $sources = [ordered]@{}
  foreach ($name in @('balance-api.ts', 'build.mjs', 'baseline.json', 'baseline-0.1.5.json', 'baseline-0.1.6.json', 'baseline-0.1.7.json', 'baseline-0.1.7-rc.2.json', 'baseline-0.2.0-rc.1.json', 'baseline-0.2.0-rc.2.json', 'baseline-0.2.1-rc.2.json', 'baseline-0.2.1-rc.3.json', 'baseline-0.2.1-rc.5.json', 'baseline-0.2.2-rc.1.json', 'balance-provider.mjs', 'LICENSE')) {
    $sources[$name] = (Get-ReleaseFileSha256 (Join-Path $connectorRoot "..\patches\dsh-deepseek-balance\$name")).ToLowerInvariant()
  }
  $stamp = [ordered]@{ payloads = $payloads; sources = $sources } | ConvertTo-Json
  [System.IO.File]::WriteAllText((Join-Path $connectorRoot 'dist\dshos-balance-build.json'), $stamp, [System.Text.UTF8Encoding]::new($false))
  Invoke-ReleaseCommand 'corepack' @('pnpm@11.7.0', 'pack', '--pack-destination', $stage)
} finally {
  Pop-Location
}

$packages = @(Get-ChildItem -LiteralPath $stage -File -Filter 'dshos-link-connector-*.tgz')
if ($packages.Count -ne 1 -or $packages[0].Name -ne "dshos-link-connector-$version.tgz") {
  throw 'pnpm pack did not produce the expected connector tarball.'
}

$releaseFiles = @(
  'Manage-DshosLinkConnector.ps1',
  'Manage-DshosLinkBalance.ps1',
  'Manage-DshosLinkDesktop.ps1',
  'Inspect-DshosBalance.mjs',
  'install-or-upgrade.cmd',
  'uninstall.cmd',
  'status.cmd'
)
foreach ($file in $releaseFiles) {
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination (Join-Path $stage $file)
}
Copy-Item -LiteralPath (Join-Path $connectorRoot 'docs\windows-installation.md') -Destination (Join-Path $stage 'README.md')
foreach ($file in @('dsh-desktop-compatibility.md', 'one-click-upgrade.md', 'pairing-diagnostics.md')) {
  Copy-Item -LiteralPath (Join-Path $connectorRoot "docs\$file") -Destination (Join-Path $stage $file)
}

$hash = Get-ReleaseFileSha256 $packages[0].FullName
$sums = @("$hash  $($packages[0].Name)") + @($payloads.GetEnumerator() | ForEach-Object { "$($_.Value)  $($_.Key)" })
Set-Content -LiteralPath (Join-Path $stage 'SHA256SUMS.txt') -Encoding Ascii -Value $sums
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $archive -CompressionLevel Optimal

Write-Host "Windows connector release created: $archive" -ForegroundColor Green
