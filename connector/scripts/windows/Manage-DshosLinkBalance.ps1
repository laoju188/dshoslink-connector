# Internal part of the connector installer; no separate user action or process.
$BalancePackageName = '@deepseek-ai/dsh-llm-deepseek'
$BalancePackageVersion = '0.1.1-rc.2-dshoslink.1'
$OfficialBalancePackageVersion = '0.1.1-rc.2'
$ManagedBalancePackageVersions = @('0.1.1-rc.2-dshoslink.1', '0.1.5-rc.2-dshoslink.1', '0.1.6-alpha.1-dshoslink.1', '0.1.7-alpha.2-dshoslink.1', '0.1.7-rc.2-dshoslink.1', '0.2.0-rc.1-dshoslink.1', '0.2.0-rc.2-dshoslink.1', '0.2.1-rc.2-dshoslink.1', '0.2.1-rc.3-dshoslink.1', '0.2.1-rc.5-dshoslink.1', '0.2.2-rc.1-dshoslink.1')
$BalancePayloadName = 'dshos-link-deepseek-provider.tgz'
$BalanceHelperDirectory = $PSScriptRoot

function Set-DshosBalanceCompatibility {
  param([string]$DshVersion)
  $script:SplitBalanceAuthVersion = ''
  switch ($DshVersion) {
    '0.1.1-rc.2' {
      $script:OfficialBalancePackageVersion = '0.1.1-rc.2'
      $script:BalancePackageVersion = '0.1.1-rc.2-dshoslink.1'
      $script:BalancePayloadName = 'dshos-link-deepseek-provider.tgz'
    }
    '0.1.5-rc.1' {
      $script:OfficialBalancePackageVersion = '0.1.5-rc.2'
      $script:BalancePackageVersion = '0.1.5-rc.2-dshoslink.1'
      $script:BalancePayloadName = 'dshos-link-deepseek-provider-015.tgz'
    }
    '0.1.6-alpha.1' {
      $script:OfficialBalancePackageVersion = '0.1.6-alpha.1'
      $script:BalancePackageVersion = '0.1.6-alpha.1-dshoslink.1'
      $script:BalancePayloadName = 'dshos-link-deepseek-provider-016.tgz'
    }
    '0.1.7-alpha.2' {
      $script:OfficialBalancePackageVersion = '0.1.7-alpha.2'
      $script:BalancePackageVersion = '0.1.7-alpha.2-dshoslink.1'
      $script:BalancePayloadName = 'dshos-link-deepseek-provider-017.tgz'
    }
    '0.1.7-rc.2' {
      $script:SplitBalanceAuthVersion = '0.1.7-rc.2'
      $script:OfficialBalancePackageVersion = '0.1.7-rc.2'
      $script:BalancePackageVersion = '0.1.7-rc.2-dshoslink.1'
      $script:BalancePayloadName = 'dshos-link-deepseek-provider-017rc2.tgz'
    }
    '0.2.0-rc.1' {
      $script:SplitBalanceAuthVersion = '0.2.0-rc.1'
      $script:OfficialBalancePackageVersion = '0.2.0-rc.1'
      $script:BalancePackageVersion = '0.2.0-rc.1-dshoslink.1'
      $script:BalancePayloadName = 'dshos-link-deepseek-provider-020rc1.tgz'
    }
    '0.2.0-rc.2' {
      $script:SplitBalanceAuthVersion = '0.2.0-rc.2'
      $script:OfficialBalancePackageVersion = '0.2.0-rc.2'
      $script:BalancePackageVersion = '0.2.0-rc.2-dshoslink.1'
      $script:BalancePayloadName = 'dshos-link-deepseek-provider-020rc2.tgz'
    }
    '0.2.1-rc.2' {
      $script:SplitBalanceAuthVersion = '0.2.1-rc.2'
      $script:OfficialBalancePackageVersion = '0.2.1-rc.2'
      $script:BalancePackageVersion = '0.2.1-rc.2-dshoslink.1'
      $script:BalancePayloadName = 'dshos-link-deepseek-provider-021rc2.tgz'
    }
    '0.2.1-rc.3' {
      $script:SplitBalanceAuthVersion = '0.2.1-rc.3'
      $script:OfficialBalancePackageVersion = '0.2.1-rc.3'
      $script:BalancePackageVersion = '0.2.1-rc.3-dshoslink.1'
      $script:BalancePayloadName = 'dshos-link-deepseek-provider-021rc3.tgz'
    }
    '0.2.1-rc.5' {
      $script:SplitBalanceAuthVersion = '0.2.1-rc.5'
      $script:OfficialBalancePackageVersion = '0.2.1-rc.5'
      $script:BalancePackageVersion = '0.2.1-rc.5-dshoslink.1'
      $script:BalancePayloadName = 'dshos-link-deepseek-provider-021rc5.tgz'
    }
    '0.2.2-rc.1' {
      $script:SplitBalanceAuthVersion = '0.2.2-rc.1'
      $script:OfficialBalancePackageVersion = '0.2.2-rc.1'
      $script:BalancePackageVersion = '0.2.2-rc.1-dshoslink.1'
      $script:BalancePayloadName = 'dshos-link-deepseek-provider-022rc1.tgz'
    }
    default { throw "当前 DSH 为 $DshVersion；此版本尚未适配。最新支持的 DSH 为 0.2.2-rc.1。" }
  }
}

function Assert-DshosBalanceRuntimeReady {
  if (Test-Path -LiteralPath (Join-Path $RuntimeRoot 'balance-recovery-required.json')) {
    throw 'DSH dependency recovery is incomplete. Run connector upgrade to retry recovery before starting DSH.'
  }
}

function Resume-DshosBalanceRecovery {
  param([string]$DshCommand, [string]$ProfileName)
  $path = Join-Path $RuntimeRoot 'balance-recovery-required.json'
  if (-not (Test-Path -LiteralPath $path)) { return }
  try { $saved = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json }
  catch { throw '安装恢复记录无法读取，已保留原资料。请保持 DSH 关闭，并联系支持；不要删除恢复资料或反复重装。' }
  if ($saved -isnot [pscustomobject] -or
    @($saved.PSObject.Properties).Count -ne 3 -or
    $null -eq $saved.PSObject.Properties['schemaVersion'] -or
    $null -eq $saved.PSObject.Properties['profile'] -or
    $null -eq $saved.PSObject.Properties['transaction'] -or
    $saved.profile -cne $ProfileName) { throw '安装恢复记录无法核对，已保留原资料。请保持 DSH 关闭，并联系支持。' }
  if ($saved.schemaVersion -eq 1) {
    # Old records never captured the original loaded versions. Current modules
    # may already be partly upgraded, so they cannot supply the missing truth.
    throw '上次安装留下的旧恢复记录缺少原版本信息，无法安全自动恢复。请保持 DSH 关闭，并联系支持；不要删除恢复资料或反复重装。'
  }
  if ($saved.schemaVersion -ne 2) { throw '安装恢复记录版本无法识别，已保留原资料。请保持 DSH 关闭，并联系支持。' }
  Restore-DshosBalanceTransaction $saved.transaction $DshCommand $ProfileName
}

function Assert-DshosBalanceTransaction {
  param($Transaction, [string]$ProfileName)
  $fields = @('root', 'backup', 'files', 'previousState', 'originalProfile')
  if ($Transaction -isnot [pscustomobject] -or
    @($Transaction.PSObject.Properties).Count -ne $fields.Count -or
    @($fields | Where-Object { $null -eq $Transaction.PSObject.Properties[$_] }).Count -gt 0) {
    throw '安装恢复资料格式不正确，已停止操作并保留原记录。'
  }
  $profileRoot = Split-Path -Parent (Get-DshosProfileManifestPath $ProfileName)
  $backupRoot = [System.IO.Path]::GetFullPath((Join-Path $RuntimeRoot 'install-backups'))
  if ($Transaction.root -isnot [string] -or $Transaction.root -ine $profileRoot -or
    $Transaction.backup -isnot [string] -or -not [IO.Path]::IsPathRooted($Transaction.backup)) {
    throw '安装恢复目录无法核对，已停止操作并保留原记录。'
  }
  $backup = [System.IO.Path]::GetFullPath($Transaction.backup)
  if (
    (Split-Path -Parent $backup) -cne $backupRoot -or
    (Split-Path -Leaf $backup) -cnotmatch '^[a-f0-9]{32}$' -or
    @($Transaction.files).Count -ne 3) { throw 'Invalid DSH dependency recovery record; startup remains blocked.' }
  $names = @('package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml')
  for ($i = 0; $i -lt $names.Count; $i++) {
    $entry = $Transaction.files[$i]
    if ($entry -isnot [pscustomobject] -or @($entry.PSObject.Properties).Count -ne 2 -or
      $null -eq $entry.PSObject.Properties['name'] -or $null -eq $entry.PSObject.Properties['existed'] -or
      $entry.name -cne $names[$i] -or $entry.existed -isnot [bool] -or
      ($entry.existed -and -not (Test-Path -LiteralPath (Join-Path $backup $entry.name) -PathType Leaf))) {
      throw 'Invalid DSH dependency backup; startup remains blocked.'
    }
  }
  $original = $Transaction.originalProfile
  $versionPattern = '^(?:[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)?$'
  if ($original -isnot [pscustomobject] -or @($original.PSObject.Properties).Count -ne 3 -or
    $null -eq $original.PSObject.Properties['prior'] -or $null -eq $original.PSObject.Properties['version'] -or
    $null -eq $original.PSObject.Properties['connectorVersion'] -or
    $original.prior -cnotin @('absent', 'official', 'managed') -or
    $original.version -isnot [string] -or $original.version -cnotmatch $versionPattern -or
    $original.connectorVersion -isnot [string] -or $original.connectorVersion -cnotmatch $versionPattern) {
    throw '原安装版本资料无法核对，已停止操作并保留原记录。'
  }
  if ($null -ne $Transaction.previousState) {
    foreach ($value in $Transaction.previousState) {
      if (($value -isnot [byte] -and $value -isnot [int] -and $value -isnot [long]) -or $value -lt 0 -or $value -gt 255) {
        throw '原配置恢复资料无法核对，已停止操作并保留原记录。'
      }
    }
  }
}

function Get-DshosProfileManifestPath {
  param([ValidatePattern('^[A-Za-z0-9_-]{1,64}$')][string]$ProfileName)
  return Join-Path (Join-Path (Join-Path (Resolve-DshosHomePath) 'profiles') $ProfileName) 'package.json'
}

# The official plugin command reconciles every installed bundle, including
# dependencies deliberately disabled by the user. Only change our own selection.
function Restore-DshosBundleSelection {
  param([string]$ManifestPath, [byte[]]$OriginalBytes,
    [ValidateSet('preserve', 'install', 'remove')][string]$ConnectorBundleChange = 'preserve')
  $before = [Text.Encoding]::UTF8.GetString($OriginalBytes).TrimStart([char]0xFEFF) | ConvertFrom-Json
  $after = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $bundles = @($before.dsh.profile.bundles)
  if ($ConnectorBundleChange -eq 'install' -and $bundles -cnotcontains $ConnectorPackageName) {
    if ($after.dsh.profile.bundles -cnotcontains $ConnectorPackageName) { throw 'Installed connector bundle is missing.' }
    $bundles += $ConnectorPackageName
  } elseif ($ConnectorBundleChange -eq 'remove') {
    $bundles = @($bundles | Where-Object { $_ -cne $ConnectorPackageName })
  }
  $after.dsh.profile.bundles = $bundles
  $updated = $after | ConvertTo-Json -Depth 100
  if ($updated -ceq ($before | ConvertTo-Json -Depth 100)) {
    [IO.File]::WriteAllBytes($ManifestPath, $OriginalBytes)
  } else {
    [IO.File]::WriteAllText($ManifestPath, $updated, [Text.UTF8Encoding]::new($false))
  }
}

function Get-DshosBalanceProfile {
  param([string]$DshCommand, [string]$ProfileName)
  $inspector = Join-Path $BalanceHelperDirectory 'Inspect-DshosBalance.mjs'
  $profileRoot = Split-Path -Parent (Get-DshosProfileManifestPath $ProfileName)
  $output = Invoke-DshosCommand (Get-DshosCommandPath 'node') @($inspector, $profileRoot)
  $lines = @($output -split '\r?\n' | Where-Object { $_.StartsWith('DSHOS_BALANCE_PROFILE=') })
  if ($lines.Count -ne 1) { throw 'DSH package inspection did not return one result.' }
  $value = $lines[0].Substring('DSHOS_BALANCE_PROFILE='.Length) | ConvertFrom-Json
  if (@($value.PSObject.Properties).Count -ne 4 -or
    $value.root -ine $profileRoot -or
    ($null -ne $value.connectorVersion -and $value.connectorVersion -cnotmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$') -or
    $value.prior -notin @('absent', 'official', 'managed', 'custom') -or
    -not [System.IO.Path]::IsPathRooted([string]$value.root) -or
    -not (Test-Path -LiteralPath (Join-Path $value.root 'package.json') -PathType Leaf)) {
    throw 'DSH 配置目录核验失败。'
  }
  return $value
}

function Save-DshosBalancePayload {
  param([string]$RequestedConnectorPath)
  $candidates = @((Join-Path $BalanceHelperDirectory $BalancePayloadName),
    (Join-Path $BalanceHelperDirectory "..\..\dist\$BalancePayloadName"))
  if ($RequestedConnectorPath.Length -gt 0) {
    $candidates = @((Join-Path (Split-Path -Parent ([System.IO.Path]::GetFullPath($RequestedConnectorPath))) $BalancePayloadName)) + $candidates
  }
  $source = @($candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1)
  if ($source.Count -ne 1) { throw '连接器安装包缺少内置余额组件，请使用完整安装包。' }
  $hash = (Get-Content -LiteralPath ($source[0] + '.sha256') -Raw).Trim()
  if ($hash -notmatch '^[A-Fa-f0-9]{64}$' -or (Get-DshosFileSha256 $source[0]) -cne $hash.ToUpperInvariant()) {
    throw '连接器内置余额组件校验失败。'
  }
  $directory = Join-Path $RuntimeRoot ('provider-packages\' + $hash.ToUpperInvariant())
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
  $destination = Join-Path $directory $BalancePayloadName
  if (-not (Test-Path -LiteralPath $destination)) { Copy-Item -LiteralPath $source[0] -Destination $destination }
  if ((Get-DshosFileSha256 $destination) -cne $hash.ToUpperInvariant()) { throw '缓存的余额组件校验失败。' }
  return $destination
}

function Write-DshosBalanceRecoveryIntent {
  param($Transaction, [string]$DshCommand, [string]$ProfileName)
  Assert-DshosBalanceTransaction $Transaction $ProfileName
  $guard = Join-Path $RuntimeRoot 'balance-recovery-required.json'
  [ordered]@{ schemaVersion = 2; profile = $ProfileName; transaction = $Transaction } |
    ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $guard -Encoding UTF8
}

function Assert-DshosUnlockedProfileEmpty {
  param([string]$ProfileRoot)
  $manifest = Get-Content -LiteralPath (Join-Path $ProfileRoot 'package.json') -Raw | ConvertFrom-Json
  foreach ($name in @('dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies')) {
    $property = $manifest.PSObject.Properties[$name]
    if ($null -ne $property -and $null -ne $property.Value -and @($property.Value.PSObject.Properties).Count -gt 0) {
      throw 'DSH profile has dependencies but no lockfile; exact dependency recovery cannot be guaranteed.'
    }
  }
}

function Restore-DshosBalanceTransaction {
  param($Transaction, [string]$DshCommand, [string]$ProfileName)
  Assert-DshosBalanceTransaction $Transaction $ProfileName
  $guard = Join-Path $RuntimeRoot 'balance-recovery-required.json'
  if (-not (Test-Path -LiteralPath $guard)) {
    Write-DshosBalanceRecoveryIntent $Transaction $DshCommand $ProfileName
  }
  foreach ($entry in $Transaction.files) {
    $target = Join-Path $Transaction.root $entry.name
    if ($entry.existed) { Copy-Item -LiteralPath (Join-Path $Transaction.backup $entry.name) -Destination $target -Force }
    elseif (Test-Path -LiteralPath $target -PathType Leaf) { Remove-Item -LiteralPath $target -Force }
  }
  # Restored files keep old timestamps. pnpm's optimistic repeat-install can
  # then skip reconciliation and leave the newer modules active. Always compare
  # the installed graph with the restored lockfile before clearing recovery.
  if (Test-Path -LiteralPath (Join-Path $Transaction.root 'pnpm-lock.yaml') -PathType Leaf) {
    Invoke-DshosPluginCommand $DshCommand @('plugin', '--profile', $ProfileName, 'install', '--offline', '--frozen-lockfile', '--config.optimistic-repeat-install=false', '--config.confirm-modules-purge=false') | Out-Host
  } else {
    # A never-booted 0.1.5 profile has no package dependencies or lockfile.
    Assert-DshosUnlockedProfileEmpty $Transaction.root
    Invoke-DshosPluginCommand $DshCommand @('plugin', '--profile', $ProfileName, 'install', '--offline', '--no-frozen-lockfile', '--lockfile=false', '--ignore-scripts', '--config.optimistic-repeat-install=false', '--config.confirm-modules-purge=false') | Out-Host
  }
  $state = Join-Path $RuntimeRoot 'balance-provider-state.json'
  if ($Transaction.previousState) { [System.IO.File]::WriteAllBytes($state, [byte[]]$Transaction.previousState) }
  elseif (Test-Path -LiteralPath $state -PathType Leaf) { Remove-Item -LiteralPath $state -Force }
  # Every caller, including the next process and final desktop postcheck, must
  # verify against the pre-mutation snapshot before removing the durable guard.
  $restored = Get-DshosBalanceProfile $DshCommand $ProfileName
  $original = $Transaction.originalProfile
  if ($restored.root -ine $Transaction.root -or $restored.prior -cne $original.prior -or
    [string]$restored.version -cne $original.version -or [string]$restored.connectorVersion -cne $original.connectorVersion) {
    throw '安装尚未完成，原版本仍未恢复。请保持 DSH 关闭，稍后再运行同一条安装命令，程序会先继续恢复。'
  }
  Remove-Item -LiteralPath $guard -Force
}

# rc.2 resolves the API-key plugin from the profile so its peer import reaches
# the integrated core. The official auth package itself is never modified.
$SplitBalanceAuthPackageName = '@deepseek-ai/dsh-llm-deepseek-api-key'
$SplitBalanceAuthVersion = ''

function Get-DshosBalanceAuthPrior {
  param([string]$ProfileRoot, [string]$ExpectedVersion = $SplitBalanceAuthVersion)
  $manifest = Get-Content -LiteralPath (Join-Path $ProfileRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $dependencies = $manifest.PSObject.Properties['dependencies']
  if ($null -eq $dependencies -or $null -eq $dependencies.Value) { return 'absent' }
  $entry = $dependencies.Value.PSObject.Properties[$SplitBalanceAuthPackageName]
  if ($null -eq $entry) { return 'absent' }
  if ($entry.Value -is [string] -and $ExpectedVersion.Length -gt 0 -and $entry.Value -ceq $ExpectedVersion) { return 'official' }
  return 'custom'
}

function Test-DshosBalanceSavedState {
  param($State, [string]$ProfileName, [string]$ProfileRoot)
  $properties = @($State.PSObject.Properties.Name)
  $baseFields = @('schemaVersion', 'profile', 'root', 'prior')
  if (@($baseFields | Where-Object { $properties -cnotcontains $_ }).Count -gt 0) { return $false }
  if ($State.profile -cne $ProfileName -or $State.root -cne $ProfileRoot -or $State.prior -notin @('absent', 'official')) { return $false }
  if ($State.schemaVersion -eq 1) { return $properties.Count -eq 4 }
  return $State.schemaVersion -eq 2 -and $properties.Count -eq 5 -and $properties -ccontains 'authPrior' -and $State.authPrior -cin @('absent', 'official')
}

function Install-DshosConnectorWithBalance {
  param([string]$DshCommand, [string]$ProfileName, [string]$ConnectorTarget, [string]$ProviderTarget)
  Resume-DshosBalanceRecovery $DshCommand $ProfileName
  $profile = Get-DshosBalanceProfile $DshCommand $ProfileName
  # pnpm can resolve the CLI 0.1.5-rc.1 fallback to rc.1; its provider code is
  # byte-identical to the reviewed rc.2 payload. Only an absent override qualifies.
  $compatibleFallback = $profile.prior -eq 'absent' -and $OfficialBalancePackageVersion -ceq '0.1.5-rc.2' -and $profile.version -ceq '0.1.5-rc.1'
  if ($profile.prior -eq 'custom' -or (-not $compatibleFallback -and $profile.version -notin (@('', $OfficialBalancePackageVersion) + $ManagedBalancePackageVersions))) {
    throw '当前 DSH 使用自定义或不兼容的模型组件，已保留原配置，不能自动替换。'
  }
  if (-not (Test-Path -LiteralPath (Join-Path $profile.root 'pnpm-lock.yaml') -PathType Leaf)) {
    Assert-DshosUnlockedProfileEmpty $profile.root
  }
  $authPrior = $null
  if ($OfficialBalancePackageVersion -ceq $SplitBalanceAuthVersion) {
    $authPrior = Get-DshosBalanceAuthPrior $profile.root
  }
  $statePath = Join-Path $RuntimeRoot 'balance-provider-state.json'
  $previousState = if (Test-Path -LiteralPath $statePath -PathType Leaf) { [System.IO.File]::ReadAllBytes($statePath) } else { $null }
  $prior = [string]$profile.prior
  if ($previousState) {
    $saved = [System.Text.Encoding]::UTF8.GetString($previousState).TrimStart([char]0xFEFF) | ConvertFrom-Json
    if (-not (Test-DshosBalanceSavedState $saved $ProfileName $profile.root)) {
      throw '余额组件恢复记录与当前 DSH 配置不一致。'
    }
    if ($profile.prior -eq 'managed') {
      # A recorded managed split provider may advance only its matching official
      # auth dependency. A user-replaced version or path is still preserved.
      if ($authPrior -ceq 'custom' -and $saved.schemaVersion -eq 2) {
        $previousAuthVersion = ([string]$profile.version) -creplace '-dshoslink\.1$', ''
        if ((Get-DshosBalanceAuthPrior $profile.root $previousAuthVersion) -ceq 'official') { $authPrior = 'official' }
      }
      if ($authPrior -ceq 'custom') { throw '当前 DSH 使用自定义 API Key 接入组件，已保留原配置，不能自动替换。' }
      $prior = [string]$saved.prior
      if ($saved.schemaVersion -eq 2) { $authPrior = [string]$saved.authPrior }
    }
  } elseif ($prior -eq 'managed') { throw '余额组件缺少恢复记录，已保留现有安装。' }
  if ($authPrior -ceq 'custom') { throw '当前 DSH 使用自定义 API Key 接入组件，已保留原配置，不能自动替换。' }
  $backup = Join-Path $RuntimeRoot ('install-backups\' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $backup -Force | Out-Null
  $files = @('package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml') | ForEach-Object {
    $path = Join-Path $profile.root $_
    $existed = Test-Path -LiteralPath $path -PathType Leaf
    if ($existed) { Copy-Item -LiteralPath $path -Destination (Join-Path $backup $_) }
    [pscustomobject]@{ name = $_; existed = $existed }
  }
  $originalProfile = [pscustomobject]@{ prior = [string]$profile.prior; version = [string]$profile.version; connectorVersion = [string]$profile.connectorVersion }
  $transaction = [pscustomobject]@{ root = $profile.root; backup = $backup; files = $files; previousState = $previousState; originalProfile = $originalProfile }
  # Fail before changing dependencies if durable recovery intent cannot be saved.
  Write-DshosBalanceRecoveryIntent $transaction $DshCommand $ProfileName
  try {
    $targets = @('plugin', '--profile', $ProfileName, 'add', '--save-exact', $ConnectorTarget, $ProviderTarget)
    if ($OfficialBalancePackageVersion -ceq $SplitBalanceAuthVersion) { $targets += "$SplitBalanceAuthPackageName@$SplitBalanceAuthVersion" }
    Invoke-DshosPluginCommand $DshCommand $targets -ConnectorBundleChange install | Out-Host
    $installed = Get-DshosBalanceProfile $DshCommand $ProfileName
    if ($installed.version -cne $BalancePackageVersion) { throw 'DSH 未加载预期的内置余额组件。' }
    $savedState = [ordered]@{ schemaVersion = 1; profile = $ProfileName; root = $profile.root; prior = $prior }
    if ($null -ne $authPrior) { $savedState.schemaVersion = 2; $savedState.authPrior = $authPrior }
    $savedState | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8
    Remove-Item -LiteralPath (Join-Path $RuntimeRoot 'balance-recovery-required.json') -Force
    return $transaction
  } catch {
    $failure = $_
    try {
      Restore-DshosBalanceTransaction $transaction $DshCommand $ProfileName
      if (Test-Path -LiteralPath (Join-Path $RuntimeRoot 'balance-recovery-required.json')) {
        throw 'Original installation could not be verified after dependency recovery.'
      }
    }
    catch {
      $restoreError = $_.Exception
      # Do not leave startup unguarded if the package manager returned success
      # but readback disagreed. Retain the original durable recovery transaction.
      if (-not (Test-Path -LiteralPath (Join-Path $RuntimeRoot 'balance-recovery-required.json'))) {
        try { Write-DshosBalanceRecoveryIntent $transaction $DshCommand $ProfileName }
        catch { $restoreError = $_.Exception }
      }
      $rollbackFailure = [System.InvalidOperationException]::new('安装未完成，原配置尚未恢复完成。请保持 DSH 关闭，再运行同一条安装命令，程序会先恢复原配置。', $restoreError)
      $rollbackFailure.Data['DshosRollbackFailed'] = $true
      throw $rollbackFailure
    }
    $failure.Exception.Data['DshosInstallRollbackComplete'] = $true
    throw $failure
  }
}

function Restore-DshosOriginalBalanceProvider {
  param([string]$DshCommand, [string]$ProfileName)
  $statePath = Join-Path $RuntimeRoot 'balance-provider-state.json'
  if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { return }
  $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
  $current = Get-DshosBalanceProfile $DshCommand $ProfileName
  if (-not (Test-DshosBalanceSavedState $state $ProfileName $current.root)) {
    throw '余额组件恢复记录无效，已保留原文件。'
  }
  if ($current.prior -eq 'managed') {
    # Restore the auxiliary dependency first; a failure retains the core and ownership for retry.
    if ($state.schemaVersion -eq 2 -and $state.authPrior -ceq 'absent' -and (Get-DshosBalanceAuthPrior $current.root) -ceq 'official') {
      Invoke-DshosPluginCommand $DshCommand @('plugin', '--profile', $ProfileName, 'remove', $SplitBalanceAuthPackageName)
    }
    if ($state.prior -eq 'absent') {
      Invoke-DshosPluginCommand $DshCommand @('plugin', '--profile', $ProfileName, 'remove', $BalancePackageName)
    } else {
      Invoke-DshosPluginCommand $DshCommand @('plugin', '--profile', $ProfileName, 'add', '--save-exact', "$BalancePackageName@$OfficialBalancePackageVersion")
    }
  }
  Remove-Item -LiteralPath $statePath -Force
}


# pnpm 11 selects the first rule for a package name, not the union of later
# exact-version entries. Merge only this connector's already-listed exact
# versions. No new version, wildcard, other package or age setting is added.
function Repair-DshosConnectorAgePolicy {
  param([string]$ProfileRoot)
  $path = Join-Path $ProfileRoot 'pnpm-workspace.yaml'
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return }
  $bytes = [IO.File]::ReadAllBytes($path)
  if ($bytes.Length -gt 1048576) { throw '安装配置过大，已保留原文件。' }
  $text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes).TrimStart([char]0xFEFF)
  $headers = [regex]::Matches($text, '(?m)^minimumReleaseAgeExclude:[ \t]*(?:#[^\r\n]*)?\r?$')
  if ($headers.Count -eq 0) { return } # Other YAML forms stay owned by pnpm.
  if ($headers.Count -ne 1) { throw '安装版本规则重复，已保留原文件。' }
  $start = $headers[0].Index + $headers[0].Length
  $tail = $text.Substring($start)
  $end = [regex]::Match($tail, '(?m)^[^\s#-][^\r\n]*:')
  $length = if ($end.Success) { $end.Index } else { $tail.Length }
  $block = $tail.Substring(0,$length)
  $entries = [regex]::Matches($block, '(?m)^(?<indent> +)-[ \t]+(?<q>[''"])(?<rule>@dshos-link/connector@[^''"\r\n]+)\k<q>[ \t]*(?<comment>#[^\r\n]*)?\r?$')
  if ($entries.Count -lt 2) { return }
  $versions = [Collections.Generic.List[string]]::new()
  foreach ($entry in $entries) {
    $rule = $entry.Groups['rule'].Value.Substring('@dshos-link/connector@'.Length)
    foreach ($version in ($rule -split '\s*\|\|\s*')) {
      if ($version -cnotmatch '^(0|[1-9][0-9]{0,7})\.(0|[1-9][0-9]{0,7})\.(0|[1-9][0-9]{0,7})(?:-[0-9A-Za-z.-]{1,40})?$') { return }
      if (-not $versions.Contains($version)) { $versions.Add($version) }
    }
  }
  # Leave a broad or unrecognized rule untouched, rather than reinterpret it.
  $stripped = $block
  for ($i=$entries.Count-1; $i -ge 0; $i--) { $stripped=$stripped.Remove($entries[$i].Index,$entries[$i].Length) }
  if ($stripped -match '@dshos-link/connector') { return }
  $updated = $block
  for ($i=$entries.Count-1; $i -ge 0; $i--) {
    $entry=$entries[$i]; $comment=$entry.Groups['comment'].Value
    $replacement=if($i -eq 0){ $entry.Groups['indent'].Value + "- '@dshos-link/connector@" + ($versions -join ' || ') + "'" + $(if($comment){' '+$comment}else{''}) }
      elseif($comment){$entry.Groups['indent'].Value+$comment}else{''}
    $updated=$updated.Remove($entry.Index,$entry.Length).Insert($entry.Index,$replacement)
  }
  $result=$text.Substring(0,$start)+$updated+$tail.Substring($length)
  $encoding=[Text.UTF8Encoding]::new(($bytes.Length -ge 3 -and $bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191))
  $temp=$path+'.dshos-'+[Guid]::NewGuid().ToString('N')+'.tmp'
  try {
    [IO.File]::WriteAllText($temp,$result,$encoding)
    if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($path)) -cne [Convert]::ToBase64String($bytes)) { throw '安装配置已变化，已停止覆盖。' }
    [IO.File]::Replace($temp,$path,[NullString]::Value)
  } finally { if(Test-Path -LiteralPath $temp){Remove-Item -LiteralPath $temp -Force} }
}

# Bounded diagnostic only: never save native output, paths, arguments or secrets.
function Write-DshosInstallDiagnostic {
  param([ValidateSet('install','recovery')][string]$Stage,
    [ValidateSet('ok','failed')][string]$Result,
    [ValidateSet('none','release_age','timeout','dns','network','process_crash','package','policy','verification')][string]$Reason,
    [long]$ExitCode=0,[long]$ElapsedMs=0)
  try {
    if (-not (Test-Path -LiteralPath $RuntimeRoot -PathType Container)) { return }
    $path=Join-Path $RuntimeRoot 'install-diagnostic-v1.json'
    $lastFailure=$null
    if (Test-Path -LiteralPath $path -PathType Leaf) {
      if ((Get-Item -LiteralPath $path).Length -le 4096) {
        try { $old=Get-Content -LiteralPath $path -Raw -Encoding UTF8|ConvertFrom-Json; $lastFailure=$old.lastFailure } catch {}
      }
    }
    $event=[ordered]@{stage=$Stage;result=$Result;reason=$Reason;atMs=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();elapsedMs=[Math]::Min(3600000,[Math]::Max(0,$ElapsedMs));exitCode=$ExitCode;version=$ConnectorVersion}
    if($Result -eq 'failed'){$lastFailure=$event}
    # Validate old retained fields instead of carrying arbitrary local JSON.
    if($null -ne $lastFailure -and ($lastFailure -isnot [System.Collections.IDictionary])) {
      $fields=@($lastFailure.PSObject.Properties.Name)
      if (($fields -join ',') -cne 'stage,result,reason,atMs,elapsedMs,exitCode,version' -or
        $lastFailure.stage -cnotin @('install','recovery') -or $lastFailure.result -cne 'failed' -or
        $lastFailure.reason -cnotin @('release_age','timeout','dns','network','process_crash','package','policy','verification') -or
        $lastFailure.version -cnotmatch '^\d{1,5}\.\d{1,5}\.\d{1,5}$') {$lastFailure=$null}
    }
    $body=[ordered]@{last=$event;lastFailure=$lastFailure}|ConvertTo-Json -Depth 5 -Compress
    if($body.Length -le 4096){[IO.File]::WriteAllText($path,$body,[Text.UTF8Encoding]::new($false))}
  } catch { } # Diagnostics must never obstruct installation or recovery.
}
