$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot '..\scripts\windows\Manage-DshosLinkConnector.ps1')

$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('dshos-balance-test-' + [Guid]::NewGuid().ToString('N'))
$RuntimeRoot = Join-Path $testRoot 'runtime'
$profileRoot = Join-Path $testRoot 'profile'
New-Item -ItemType Directory -Path $RuntimeRoot, $profileRoot -Force | Out-Null
$checks = 0
function Assert-Balance($condition, [string]$message) {
  if (-not $condition) { throw $message }
  $script:checks += 1
}
$original = '{"name":"fixture","dependencies":{}}'
[System.IO.File]::WriteAllText((Join-Path $profileRoot 'package.json'), $original)
[System.IO.File]::WriteAllText((Join-Path $profileRoot 'pnpm-lock.yaml'), 'original-lock')
$script:mode = 'absent'
$script:authMode = 'absent'
$authInspector = (Get-Item Function:Get-DshosBalanceAuthPrior).ScriptBlock
$script:authActualVersion = ''
$script:managedVersion = ''
function Get-DshosBalanceAuthPrior {
  param([string]$ProfileRoot, [string]$ExpectedVersion = $SplitBalanceAuthVersion)
  if ($script:authMode -ceq 'versioned') {
    if ($script:authActualVersion -ceq $ExpectedVersion) { return 'official' }
    return 'custom'
  }
  return $script:authMode
}
$script:fallbackVersion = ''
$script:failInstall = $false
$script:failRestore = $false
$script:commands = @()
$script:recoveryPackages = @{}
function Get-DshosProfileManifestPath { return Join-Path $profileRoot 'package.json' }
function Get-DshosBalanceProfile {
  param([string]$DshCommand, [string]$ProfileName)
  return [pscustomobject]@{ root = $profileRoot; prior = $script:mode; connectorVersion = ''; version = $(if ($script:mode -eq 'managed') { if ($script:managedVersion) { $script:managedVersion } else { $BalancePackageVersion } } elseif ($script:fallbackVersion) { $script:fallbackVersion } else { $OfficialBalancePackageVersion }) }
}
function Invoke-DshosPluginCommand {
  param([string]$DshCommand, [string[]]$Arguments)
  $script:commands += ,$Arguments
  if ($Arguments -contains 'remove' -and $Arguments -contains $SplitBalanceAuthPackageName) { $script:authMode = 'absent' }
  if ($Arguments -contains "$SplitBalanceAuthPackageName@$SplitBalanceAuthVersion") { $script:authMode = 'official' }
  if ($Arguments -contains 'install' -and $script:failRestore) { throw 'simulated restore failure' }
  if ($Arguments -contains 'install') {
    # Model the package cache that reconciles a saved lockfile, independently
    # of the product's new originalProfile verification fields.
    $intent = Get-Content -LiteralPath (Join-Path $RuntimeRoot 'balance-recovery-required.json') -Raw | ConvertFrom-Json
    $originalPackages = $script:recoveryPackages[$intent.transaction.backup]
    $script:mode = $originalPackages.prior
    $script:managedVersion = if ($script:mode -eq 'managed') { $originalPackages.version } else { '' }
    $script:fallbackVersion = if ($script:mode -ne 'managed' -and $originalPackages.version -cne $OfficialBalancePackageVersion) { $originalPackages.version } else { '' }
  }
  if ($Arguments -contains 'add') {
    [System.IO.File]::WriteAllText((Join-Path $profileRoot 'package.json'), '{"name":"changed"}')
    [System.IO.File]::WriteAllText((Join-Path $profileRoot 'pnpm-workspace.yaml'), 'created-by-install')
    if ($script:failInstall) { throw 'simulated package install failure' }
    $script:mode = 'managed'
    $script:managedVersion = ''
  }
}

$intentWriter = (Get-Item Function:Write-DshosBalanceRecoveryIntent).ScriptBlock
function Write-DshosBalanceRecoveryIntent { throw 'simulated recovery intent creation failure' }
$failed = $false
try { Install-DshosConnectorWithBalance 'fake-dsh' 'web' 'connector.tgz' 'provider.tgz' | Out-Null }
catch { $failed = $true }
Assert-Balance $failed 'intent creation failure was ignored'
Assert-Balance ($script:commands.Count -eq 0) 'dependencies changed without durable recovery intent'
Assert-Balance ([System.IO.File]::ReadAllText((Join-Path $profileRoot 'package.json')) -ceq $original) 'intent failure changed the existing profile'
Set-Item Function:Write-DshosBalanceRecoveryIntent $intentWriter
function Write-DshosBalanceRecoveryIntent {
  param($Transaction, [string]$DshCommand, [string]$ProfileName)
  if (-not $script:recoveryPackages.ContainsKey($Transaction.backup)) {
    $script:recoveryPackages[$Transaction.backup] = Get-DshosBalanceProfile $DshCommand $ProfileName
  }
  & $intentWriter $Transaction $DshCommand $ProfileName
}

$transaction = Install-DshosConnectorWithBalance 'fake-dsh' 'web' 'connector.tgz' 'provider.tgz'
Assert-Balance ($script:commands.Count -eq 1) 'install was split into separate package operations'
Assert-Balance ($script:commands[0] -contains 'connector.tgz' -and $script:commands[0] -contains 'provider.tgz') 'install omitted one component'
$state = Get-Content (Join-Path $RuntimeRoot 'balance-provider-state.json') -Raw | ConvertFrom-Json
Assert-Balance ($state.prior -eq 'absent') 'initial provider state was not preserved'

# A repeated upgrade must retain the original state, including Windows UTF8 BOM handling.
$second = Install-DshosConnectorWithBalance 'fake-dsh' 'web' 'connector-next.tgz' 'provider.tgz'
$state = Get-Content (Join-Path $RuntimeRoot 'balance-provider-state.json') -Raw | ConvertFrom-Json
Assert-Balance ($state.prior -eq 'absent') 'upgrade lost the original provider state'

Restore-DshosBalanceTransaction $transaction 'fake-dsh' 'web'
Assert-Balance ([System.IO.File]::ReadAllText((Join-Path $profileRoot 'package.json')) -ceq $original) 'rollback did not restore manifest bytes'
Assert-Balance (-not (Test-Path (Join-Path $profileRoot 'pnpm-workspace.yaml'))) 'rollback retained a new workspace file'
Assert-Balance (-not (Test-Path (Join-Path $RuntimeRoot 'balance-provider-state.json'))) 'rollback retained a new ownership record'
Assert-Balance ($script:commands[-1] -contains '--frozen-lockfile') 'rollback did not restore the locked dependency graph'

$script:mode = 'absent'
$script:failInstall = $true
$failed = $false
try { Install-DshosConnectorWithBalance 'fake-dsh' 'web' 'bad.tgz' 'provider.tgz' | Out-Null } catch { $failed = $true }
Assert-Balance $failed 'install error was hidden'
Assert-Balance ([System.IO.File]::ReadAllText((Join-Path $profileRoot 'package.json')) -ceq $original) 'failed install was not rolled back'

$script:failInstall = $false
$script:mode = 'custom'
$before = $script:commands.Count
$failed = $false
try { Install-DshosConnectorWithBalance 'fake-dsh' 'web' 'connector.tgz' 'provider.tgz' | Out-Null } catch { $failed = $true }
Assert-Balance $failed 'custom provider accepted'
Assert-Balance ($script:commands.Count -eq $before) 'custom provider was modified'

$script:mode = 'absent'
Install-DshosConnectorWithBalance 'fake-dsh' 'web' 'connector.tgz' 'provider.tgz' | Out-Null
Restore-DshosOriginalBalanceProvider 'fake-dsh' 'web'
Assert-Balance ($script:commands[-1] -contains 'remove' -and $script:commands[-1] -contains $BalancePackageName) 'uninstall did not restore fallback to official provider'
Assert-Balance (-not (Test-Path (Join-Path $RuntimeRoot 'balance-provider-state.json'))) 'uninstall retained ownership state'

$script:mode = 'official'
Install-DshosConnectorWithBalance 'fake-dsh' 'web' 'connector.tgz' 'provider.tgz' | Out-Null
Restore-DshosOriginalBalanceProvider 'fake-dsh' 'web'
Assert-Balance ($script:commands[-1] -contains "$BalancePackageName@$RequiredDshVersion") 'uninstall did not restore the original direct official dependency'

$script:mode = 'absent'
Install-DshosConnectorWithBalance 'fake-dsh' 'web' 'connector.tgz' 'provider.tgz' | Out-Null
$script:mode = 'custom'
$before = $script:commands.Count
Restore-DshosOriginalBalanceProvider 'fake-dsh' 'web'
Assert-Balance ($script:commands.Count -eq $before) 'uninstall overwrote a user replacement provider'

$script:mode = 'absent'
$script:failInstall = $true
$script:failRestore = $true
$failed = $false
try { Install-DshosConnectorWithBalance 'fake-dsh' 'web' 'bad.tgz' 'provider.tgz' | Out-Null }
catch { $failed = $_.Exception.Data.Contains('DshosRollbackFailed') }
Assert-Balance $failed 'restore failure was not marked to prevent restarting the runtime'
Assert-Balance (Test-Path -LiteralPath (Join-Path $RuntimeRoot 'balance-recovery-required.json')) 'restore failure was not persisted'

$RuntimeManagerPath = Join-Path $RuntimeRoot 'Manage-DshosLinkConnector.ps1'
Save-DshosRuntimeManager
$childPath = Join-Path $testRoot 'check-new-process.ps1'
@'
param([string]$TestManagerPath, [string]$TestRuntimeRoot)
$ErrorActionPreference = 'Stop'
. $TestManagerPath
$RuntimeRoot = $TestRuntimeRoot
$script:started = $false
function Start-DshosProfileProcess { $script:started = $true }
function Start-Process { $script:started = $true }
foreach ($entry in @('run', 'start')) {
  $blocked = $false
  try {
    if ($entry -eq 'run') { $Action = 'run'; Invoke-DshosConnectorManager }
    else { Start-DshosRuntimeProcess }
  } catch {
    # Public run is retired; the lower-level legacy start must still enforce recovery.
    $blocked = if ($entry -eq 'run') { $_.Exception.Message -match '^\u672c\u5019\u9009\u4ec5\u7531\u5b98\u65b9 DSH' }
      else { $_.Exception.Message.Contains('recovery is incomplete') }
  }
  if (-not $blocked -or $script:started) { exit 1 }
}
exit 0
'@ | Set-Content -LiteralPath $childPath -Encoding Ascii
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $childPath -TestManagerPath $RuntimeManagerPath -TestRuntimeRoot $RuntimeRoot
Assert-Balance ($LASTEXITCODE -eq 0) 'a fresh process started DSH while dependency recovery was incomplete'
$script:failRestore = $false
Resume-DshosBalanceRecovery 'fake-dsh' 'web'
Assert-DshosBalanceRuntimeReady
Assert-Balance (-not (Test-Path -LiteralPath (Join-Path $RuntimeRoot 'balance-recovery-required.json'))) 'successful complete recovery did not unblock startup'

$script:failInstall = $false
$script:mode = 'official'
Set-DshosBalanceCompatibility '0.1.5-rc.1'
Install-DshosConnectorWithBalance 'fake-dsh' 'web' 'connector.tgz' 'provider-015.tgz' | Out-Null
Restore-DshosOriginalBalanceProvider 'fake-dsh' 'web'
Assert-Balance ($script:commands[-1] -contains "$BalancePackageName@0.1.5-rc.2") 'new DSH uninstall restored the old provider'
Assert-Balance ($BalancePayloadName -ceq 'dshos-link-deepseek-provider-015.tgz') 'new DSH selected the old payload'
$script:mode = 'absent'
$script:fallbackVersion = '0.1.5-rc.1'
Install-DshosConnectorWithBalance 'fake-dsh' 'web' 'connector.tgz' 'provider-015.tgz' | Out-Null
Restore-DshosOriginalBalanceProvider 'fake-dsh' 'web'
Assert-Balance ($script:commands[-1] -contains 'remove') 'pnpm fallback uninstall did not restore host resolution'
foreach ($prior in @('official', 'custom')) {
  $script:mode = $prior
  $before = $script:commands.Count
  $failed = $false
  try { Install-DshosConnectorWithBalance 'fake-dsh' 'web' 'connector.tgz' 'provider-015.tgz' | Out-Null } catch { $failed = $true }
  Assert-Balance ($failed -and $script:commands.Count -eq $before) 'fallback exception replaced a direct user override'
}
$script:fallbackVersion = ''
Set-DshosBalanceCompatibility '0.1.6-alpha.1'
Assert-Balance ($BalancePayloadName -ceq 'dshos-link-deepseek-provider-016.tgz' -and $BalancePackageVersion -ceq '0.1.6-alpha.1-dshoslink.1') 'DSH 0.1.6 selected an incompatible payload'
$script:mode = 'official'
$alphaOriginalManifest = [System.IO.File]::ReadAllText((Join-Path $profileRoot 'package.json'))
$alphaTransaction = Install-DshosConnectorWithBalance 'fake-dsh' 'web' 'connector.tgz' 'provider-016.tgz'
Install-DshosConnectorWithBalance 'fake-dsh' 'web' 'connector-next.tgz' 'provider-016.tgz' | Out-Null
Restore-DshosOriginalBalanceProvider 'fake-dsh' 'web'
Assert-Balance ($script:commands[-1] -contains "$BalancePackageName@0.1.6-alpha.1") 'DSH 0.1.6 uninstall restored an older provider'
Restore-DshosBalanceTransaction $alphaTransaction 'fake-dsh' 'web'
Assert-Balance ([System.IO.File]::ReadAllText((Join-Path $profileRoot 'package.json')) -ceq $alphaOriginalManifest) 'DSH 0.1.6 rollback changed original manifest'
$script:mode = 'absent'
Install-DshosConnectorWithBalance 'fake-dsh' 'web' 'connector.tgz' 'provider-016.tgz' | Out-Null
Restore-DshosOriginalBalanceProvider 'fake-dsh' 'web'
Assert-Balance ($script:commands[-1] -contains 'remove') 'DSH 0.1.6 fallback uninstall retained an override'
foreach ($prior in @('official', 'custom')) {
  $script:mode = $prior
  $script:fallbackVersion = '0.1.5-rc.1'
  $before = $script:commands.Count
  $failed = $false
  try { Install-DshosConnectorWithBalance 'fake-dsh' 'web' 'connector.tgz' 'provider-016.tgz' | Out-Null } catch { $failed = $true }
  Assert-Balance ($failed -and $script:commands.Count -eq $before) 'DSH 0.1.6 replaced an incompatible direct provider'
}
$script:mode = 'absent'
$script:fallbackVersion = ''
Set-DshosBalanceCompatibility '0.1.7-alpha.2'
Assert-Balance ($BalancePayloadName -ceq 'dshos-link-deepseek-provider-017.tgz' -and $BalancePackageVersion -ceq '0.1.7-alpha.2-dshoslink.1') 'DSH 0.1.7 selected an incompatible payload'
$script:mode = 'official'
$alphaOriginalManifest = [System.IO.File]::ReadAllText((Join-Path $profileRoot 'package.json'))
$alphaTransaction = Install-DshosConnectorWithBalance 'fake-dsh' 'web' 'connector.tgz' 'provider-017.tgz'
Install-DshosConnectorWithBalance 'fake-dsh' 'web' 'connector-next.tgz' 'provider-017.tgz' | Out-Null
Restore-DshosOriginalBalanceProvider 'fake-dsh' 'web'
Assert-Balance ($script:commands[-1] -contains "$BalancePackageName@0.1.7-alpha.2") 'DSH 0.1.7 uninstall restored an older provider'
Restore-DshosBalanceTransaction $alphaTransaction 'fake-dsh' 'web'
Assert-Balance ([System.IO.File]::ReadAllText((Join-Path $profileRoot 'package.json')) -ceq $alphaOriginalManifest) 'DSH 0.1.7 rollback changed original manifest'
$script:mode = 'absent'
Install-DshosConnectorWithBalance 'fake-dsh' 'web' 'connector.tgz' 'provider-017.tgz' | Out-Null
Restore-DshosOriginalBalanceProvider 'fake-dsh' 'web'
Assert-Balance ($script:commands[-1] -contains 'remove') 'DSH 0.1.7 fallback uninstall retained an override'
foreach ($prior in @('official', 'custom')) {
  $script:mode = $prior
  $script:fallbackVersion = '0.1.5-rc.1'
  $before = $script:commands.Count
  $failed = $false
  try { Install-DshosConnectorWithBalance 'fake-dsh' 'web' 'connector.tgz' 'provider-017.tgz' | Out-Null } catch { $failed = $true }
  Assert-Balance ($failed -and $script:commands.Count -eq $before) 'DSH 0.1.7 replaced an incompatible direct provider'
}
$script:fallbackVersion = ''
Set-DshosBalanceCompatibility '0.1.7-rc.2'
Assert-Balance ($BalancePayloadName -ceq 'dshos-link-deepseek-provider-017rc2.tgz' -and $BalancePackageVersion -ceq '0.1.7-rc.2-dshoslink.1') 'DSH 0.1.7 rc.2 selected an incompatible payload'
$script:mode = 'official'
$alphaOriginalManifest = [System.IO.File]::ReadAllText((Join-Path $profileRoot 'package.json'))
$alphaTransaction = Install-DshosConnectorWithBalance 'fake-dsh' 'web' 'connector.tgz' 'provider-017rc2.tgz'
Install-DshosConnectorWithBalance 'fake-dsh' 'web' 'connector-next.tgz' 'provider-017rc2.tgz' | Out-Null
Restore-DshosOriginalBalanceProvider 'fake-dsh' 'web'
Assert-Balance ($script:commands[-1] -contains "$BalancePackageName@0.1.7-rc.2") 'DSH 0.1.7 rc.2 uninstall restored an older provider'
Restore-DshosBalanceTransaction $alphaTransaction 'fake-dsh' 'web'
Assert-Balance ([System.IO.File]::ReadAllText((Join-Path $profileRoot 'package.json')) -ceq $alphaOriginalManifest) 'DSH 0.1.7 rc.2 rollback changed original manifest'
$script:mode = 'absent'
Install-DshosConnectorWithBalance 'fake-dsh' 'web' 'connector.tgz' 'provider-017rc2.tgz' | Out-Null
Restore-DshosOriginalBalanceProvider 'fake-dsh' 'web'
Assert-Balance ($script:commands[-1] -contains 'remove') 'DSH 0.1.7 rc.2 fallback uninstall retained an override'
foreach ($prior in @('official', 'custom')) {
  $script:mode = $prior
  $script:fallbackVersion = '0.1.5-rc.1'
  $before = $script:commands.Count
  $failed = $false
  try { Install-DshosConnectorWithBalance 'fake-dsh' 'web' 'connector.tgz' 'provider-017rc2.tgz' | Out-Null } catch { $failed = $true }
  Assert-Balance ($failed -and $script:commands.Count -eq $before) 'DSH 0.1.7 rc.2 replaced an incompatible direct provider'
}
$script:mode = 'absent'
$script:fallbackVersion = ''
Set-DshosBalanceCompatibility '0.1.1-rc.2'
Assert-Balance ($BalancePackageVersion -ceq '0.1.1-rc.2-dshoslink.1' -and $BalancePayloadName -ceq 'dshos-link-deepseek-provider.tgz') 'old DSH no longer selects its compatible payload'
$before = $script:commands.Count
$failed = $false
try { Set-DshosBalanceCompatibility '0.1.6'; Install-DshosConnectorWithBalance 'fake-dsh' 'web' 'connector.tgz' 'provider.tgz' | Out-Null }
catch { $failed = $true }
Assert-Balance ($failed -and $script:commands.Count -eq $before) 'unverified DSH modified the package graph'

# New, unbooted profiles need exact restoration without inventing a lockfile.
Restore-DshosBalanceTransaction $transaction 'fake-dsh' 'web'
$script:mode = 'absent'
Remove-Item -LiteralPath (Join-Path $profileRoot 'pnpm-lock.yaml')
$emptyTransaction = Install-DshosConnectorWithBalance 'fake-dsh' 'web' 'connector.tgz' 'provider.tgz'
Restore-DshosBalanceTransaction $emptyTransaction 'fake-dsh' 'web'
Assert-Balance ($script:commands[-1] -contains '--lockfile=false' -and $script:commands[-1] -contains '--offline') 'empty-profile restoration requires a nonexistent lockfile'
Assert-Balance (-not (Test-Path -LiteralPath (Join-Path $profileRoot 'pnpm-lock.yaml'))) 'empty-profile restoration created a lockfile'
Assert-Balance ([System.IO.File]::ReadAllText((Join-Path $profileRoot 'package.json')) -ceq $original) 'empty-profile restoration changed manifest bytes'
[System.IO.File]::WriteAllText((Join-Path $profileRoot 'package.json'), '{"dependencies":{"existing-plugin":"^1.0.0"}}')
$script:mode = 'absent'
$before = $script:commands.Count
$failed = $false
try { Install-DshosConnectorWithBalance 'fake-dsh' 'web' 'connector.tgz' 'provider.tgz' | Out-Null }
catch { $failed = $true }
Assert-Balance ($failed -and $script:commands.Count -eq $before) 'an unlocked existing dependency graph was changed'

# Official DSH writes UTF-8 without BOM; original profiles may contain a BOM.
$selectionPath = Join-Path $testRoot 'selection-utf8.json'
foreach ($withBom in @($false, $true)) {
  $selection = '{"description":"中文配置","dependencies":{"fixture":"file:D:/插件/fixture"},"dsh":{"profile":{"bundles":[]}}}'
  [IO.File]::WriteAllText($selectionPath, $selection, [Text.UTF8Encoding]::new($withBom))
  $originalBytes = [IO.File]::ReadAllBytes($selectionPath)
  $rewritten = $selection | ConvertFrom-Json
  $rewritten.dsh.profile.bundles = @('fixture')
  [IO.File]::WriteAllText($selectionPath, ($rewritten | ConvertTo-Json -Depth 100), [Text.UTF8Encoding]::new($false))
  Restore-DshosBundleSelection $selectionPath $originalBytes
  Assert-Balance ([Convert]::ToBase64String([IO.File]::ReadAllBytes($selectionPath)) -ceq [Convert]::ToBase64String($originalBytes)) 'UTF-8 selection restoration changed original bytes or BOM'
  $saved = Get-Content -LiteralPath $selectionPath -Raw -Encoding UTF8 | ConvertFrom-Json
  Assert-Balance ($saved.description -ceq '中文配置' -and $saved.dependencies.fixture -ceq 'file:D:/插件/fixture') 'UTF-8 metadata or dependency path changed'
}

foreach ($splitVersion in @('0.1.7-rc.2', '0.2.0-rc.1', '0.2.0-rc.2', '0.2.1-rc.2', '0.2.1-rc.3', '0.2.1-rc.5', '0.2.2-rc.1', '0.2.2-rc.2')) {
# rc.2 must install the real API-key entrypoint, and remember whether we added it.
[IO.File]::WriteAllText((Join-Path $profileRoot 'package.json'), '{"dependencies":{}}')
[IO.File]::WriteAllText((Join-Path $profileRoot 'pnpm-lock.yaml'), 'synthetic-rc2-lock')
Set-DshosBalanceCompatibility $splitVersion
$script:mode = 'absent'
$script:authMode = 'absent'
$script:fallbackVersion = ''
$script:failInstall = $false
$script:failRestore = $false
Remove-Item -LiteralPath (Join-Path $RuntimeRoot 'balance-provider-state.json') -ErrorAction SilentlyContinue
$before = $script:commands.Count
Install-DshosConnectorWithBalance 'fake-dsh' 'web' 'connector.tgz' 'provider-017rc2.tgz' | Out-Null
Assert-Balance ($script:commands.Count -eq $before + 1 -and $script:commands[-1] -contains "$SplitBalanceAuthPackageName@$SplitBalanceAuthVersion") 'rc.2 omitted official API-key entrypoint or split the install'
Install-DshosConnectorWithBalance 'fake-dsh' 'web' 'connector-next.tgz' 'provider-017rc2.tgz' | Out-Null
$state = Get-Content (Join-Path $RuntimeRoot 'balance-provider-state.json') -Raw | ConvertFrom-Json
Assert-Balance ($state.schemaVersion -eq 2 -and $state.authPrior -ceq 'absent') 'repeat upgrade forgot that the API-key entrypoint was absent'
$before = $script:commands.Count
Restore-DshosOriginalBalanceProvider 'fake-dsh' 'web'
Assert-Balance ($script:commands[$before] -contains 'remove' -and $script:commands[$before] -contains $SplitBalanceAuthPackageName) 'uninstall retained the API-key dependency we added'

$script:mode = 'absent'
$script:authMode = 'official'
Install-DshosConnectorWithBalance 'fake-dsh' 'web' 'connector.tgz' 'provider-017rc2.tgz' | Out-Null
$before = $script:commands.Count
Restore-DshosOriginalBalanceProvider 'fake-dsh' 'web'
Assert-Balance ($script:commands.Count -eq $before + 1 -and $script:authMode -ceq 'official') 'uninstall removed the original API-key dependency'

$script:mode = 'absent'
$script:authMode = 'custom'
$before = $script:commands.Count
$failed = $false
try { Install-DshosConnectorWithBalance 'fake-dsh' 'web' 'connector.tgz' 'provider-017rc2.tgz' | Out-Null } catch { $failed = $true }
Assert-Balance ($failed -and $script:commands.Count -eq $before) 'custom API-key entrypoint was overwritten'

}
Set-DshosBalanceCompatibility '0.1.7-rc.2'

# Read real manifests, rather than accepting the installation mock as inspector evidence.
foreach ($entry in @(@{spec=$null; prior='absent'}, @{spec='0.1.7-rc.2'; prior='official'}, @{spec='file:custom'; prior='custom'}, @{spec='0.1.7-rc.1'; prior='custom'})) {
  $dependencies = @{}
  if ($null -ne $entry.spec) { $dependencies[$SplitBalanceAuthPackageName] = $entry.spec }
  [IO.File]::WriteAllText((Join-Path $profileRoot 'package.json'), (@{ dependencies=$dependencies } | ConvertTo-Json))
  Assert-Balance ((& $authInspector $profileRoot) -ceq $entry.prior) 'API-key inspector misclassified an existing override'
}
$invalidState = [pscustomobject]@{schemaVersion=2;profile='web';root=$profileRoot;prior='absent';authPrior='custom'}
Assert-Balance (-not (Test-DshosBalanceSavedState $invalidState 'web' $profileRoot)) 'invalid auxiliary ownership was accepted'

# Advancing a recorded managed provider may update only its matching official auth entry.
foreach ($upgrade in @(@{from='0.1.7-rc.2';to='0.2.0-rc.1'}, @{from='0.2.0-rc.1';to='0.2.0-rc.2'}, @{from='0.2.0-rc.2';to='0.2.1-rc.2'}, @{from='0.2.1-rc.2';to='0.2.1-rc.3'}, @{from='0.2.1-rc.3';to='0.2.1-rc.2'}, @{from='0.2.1-rc.3';to='0.2.1-rc.5'}, @{from='0.2.1-rc.5';to='0.2.1-rc.3'}, @{from='0.2.1-rc.5';to='0.2.2-rc.1'}, @{from='0.2.2-rc.1';to='0.2.1-rc.5'}, @{from='0.2.2-rc.1';to='0.2.2-rc.2'}, @{from='0.2.2-rc.2';to='0.2.2-rc.1'})) {
foreach ($authOriginal in @($upgrade.from, '0.1.7-rc.1', 'file:custom')) {
  Set-DshosBalanceCompatibility $upgrade.to
  $script:mode = 'managed'
  $script:managedVersion = $upgrade.from + '-dshoslink.1'
  $script:authMode = 'versioned'
  $script:authActualVersion = $authOriginal
  $statePath = Join-Path $RuntimeRoot 'balance-provider-state.json'
  @{schemaVersion=2;profile='web';root=$profileRoot;prior='absent';authPrior='absent'} | ConvertTo-Json | Set-Content $statePath -Encoding UTF8
  $before = $script:commands.Count
  $failed = $false
  try { Install-DshosConnectorWithBalance 'fake-dsh' 'web' 'connector.tgz' $BalancePayloadName | Out-Null } catch { $failed = $true }
  if ($authOriginal -ceq $upgrade.from) {
    Assert-Balance (-not $failed -and $script:commands.Count -eq $before + 1) 'managed rc.2 auth could not advance to 0.2'
    Assert-Balance ($script:commands[-1] -contains ($SplitBalanceAuthPackageName + '@' + $upgrade.to)) '0.2 upgrade kept a mismatched API-key plugin'
    $state = Get-Content $statePath -Raw | ConvertFrom-Json
    Assert-Balance ($state.authPrior -ceq 'absent' -and $state.prior -ceq 'absent') '0.2 upgrade rewrote original ownership'
    Restore-DshosOriginalBalanceProvider 'fake-dsh' 'web'
    Assert-Balance ($script:authMode -ceq 'absent') '0.2 uninstall kept its managed auth dependency'
  } else {
    Assert-Balance ($failed -and $script:commands.Count -eq $before) 'managed state allowed overwriting a user-replaced auth dependency'
  }
}
}
# The actual inspector accepts only the requested official version.
foreach ($authVersion in @('0.1.7-rc.2','0.2.0-rc.1','0.2.0-rc.2','0.2.1-rc.2','0.2.1-rc.3', '0.2.1-rc.5', '0.2.2-rc.1', '0.2.2-rc.2')) {
  [IO.File]::WriteAllText((Join-Path $profileRoot 'package.json'), (@{dependencies=@{$SplitBalanceAuthPackageName=$authVersion}} | ConvertTo-Json))
  Assert-Balance ((& $authInspector $profileRoot $authVersion) -ceq 'official') 'actual inspector rejected matching split auth'
  Assert-Balance ((& $authInspector $profileRoot '0.2.0-rc.3') -ceq 'custom') 'actual inspector accepted a different auth version'
}
Set-DshosBalanceCompatibility '0.1.7-rc.2'
Assert-Balance ($SplitBalanceAuthVersion -ceq '0.1.7-rc.2') 'returning to rc.2 kept 0.2 auth selection'
Set-DshosBalanceCompatibility '0.1.6-alpha.1'
Assert-Balance ($SplitBalanceAuthVersion.Length -eq 0) 'legacy runtime inherited a split auth dependency'

Write-Output "Windows balance installer checks passed: $checks"
