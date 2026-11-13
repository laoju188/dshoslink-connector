#requires -Version 5.1

[CmdletBinding()]
param(
  [ValidateSet('install', 'upgrade', 'uninstall', 'open', 'status', 'run')]
  [string]$Action = 'install',
  [string]$PackagePath = '',
  [string]$PackageSpec = '',
  [ValidatePattern('^$|^[A-Za-z0-9_-]{1,64}$')]
  [string]$Profile = '',
  [string]$DshHome = '',
  [ValidateSet('', 'production', 'sandbox')]
  [string]$ServiceEnvironment = '',
  [string]$HostAddress = '',
  [string]$DshPath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ConnectorPackageName = '@dshos-link/connector'
$ConnectorVersion = '0.2.15'
$PreviousConnectorVersions = @('0.2.14', '0.2.13', '0.2.12', '0.2.11', '0.2.10', '0.2.9', '0.2.8', '0.2.7', '0.2.6', '0.2.5', '0.2.4', '0.2.3', '0.2.2', '0.2.1', '0.2.0', '0.1.19', '0.1.18', '0.1.17', '0.1.16', '0.1.15', '0.1.14', '0.1.13', '0.1.12', '0.1.11', '0.1.10', '0.1.9', '0.1.8', '0.1.7', '0.1.6', '0.1.5', '0.1.4', '0.1.3', '0.1.2', '0.1.1', '0.1.0')
$RequiredDshVersion = '0.1.1-rc.2'
$RequiredPnpmVersion = '11.7.0'
$ConnectorEnvironment = [ordered]@{
  DSHOS_LINK_PAIRING_ENABLED = '1'
  DSHOS_LINK_PAIRING_PORT = '24690'
  DSHOS_LINK_PAIRING_BOOTSTRAP_PORT = '24691'
}
$LegacyConnectorEnvironmentNames = @('DSHOS_LINK_PORT')
$RuntimeSchemaVersion = 4
$RuntimeStartupName = 'DSHOS Link Runtime'
$RuntimeStartupKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$LegacyRuntimeTaskName = 'DSHOS Link Runtime'
$RuntimeRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'DSHOSLink\Runtime'
$RuntimeManagerPath = Join-Path $RuntimeRoot 'Manage-DshosLinkConnector.ps1'
$RuntimeConfigPath = Join-Path $RuntimeRoot 'runtime.json'
$RuntimeStatusPath = Join-Path $RuntimeRoot 'status.json'
$RuntimeListenerStatusPath = Join-Path $RuntimeRoot 'listener-status-v1.json'
$RuntimePidPath = Join-Path $RuntimeRoot 'runtime.pid'
$RuntimeWebLaunchPath = Join-Path $RuntimeRoot 'web-launch-v1.json'
$ManagedRuntimeEnvironmentName = 'DSHOS_LINK_MANAGED_RUNTIME'
$ListenerReadinessTimeoutMilliseconds = 60000
$RuntimeMutexName = 'Local\DSHOSLinkRuntime'
$ManagerMutexName = 'Local\DSHOSLinkManager'
$RuntimePackageRoot = Join-Path $RuntimeRoot 'packages'
$ReadyPackageStateSchemaVersion = 1
$ReadyPackageStateFileName = 'ready-packages.json'
$ManagerSourcePath = $PSCommandPath
. (Join-Path $PSScriptRoot 'Manage-DshosLinkBalance.ps1')
. (Join-Path $PSScriptRoot 'Manage-DshosLinkDesktop.ps1')

function Test-DshosPrivateIpv4 {
  param([Parameter(Mandatory = $true)][string]$Value)

  $parsed = [System.Net.IPAddress]::None
  if (-not [System.Net.IPAddress]::TryParse($Value, [ref]$parsed) -or
    $parsed.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) {
    return $false
  }
  $bytes = $parsed.GetAddressBytes()
  return $bytes[0] -eq 10 -or
    ($bytes[0] -eq 172 -and $bytes[1] -ge 16 -and $bytes[1] -le 31) -or
    ($bytes[0] -eq 192 -and $bytes[1] -eq 168)
}

function Test-DshosSupportedNodeVersion {
  param([Parameter(Mandatory = $true)][string]$Value)

  if ($Value -notmatch '^(\d+)\.(\d+)\.(\d+)$') { return $false }
  $major = [int]$Matches[1]
  $minor = [int]$Matches[2]
  return $major -ge 24 -or ($major -eq 22 -and $minor -ge 19)
}

function Get-DshosHostCandidates {
  $addresses = @(
    Get-NetIPConfiguration -ErrorAction Stop |
      Where-Object { $null -ne $_.IPv4DefaultGateway } |
      ForEach-Object { $_.IPv4Address.IPAddress }
  )
  if ($addresses.Count -eq 0) {
    $addresses = @(
      Get-NetIPAddress -AddressFamily IPv4 -AddressState Preferred -ErrorAction Stop |
        ForEach-Object { $_.IPAddress }
    )
  }
  return @($addresses | Where-Object { Test-DshosPrivateIpv4 $_ } | Sort-Object -Unique)
}

function Resolve-DshosHostAddress {
  param(
    [string]$Requested,
    [string[]]$Candidates = @()
  )

  if ($Requested.Length -gt 0) {
    if (-not (Test-DshosPrivateIpv4 $Requested)) {
      throw '电脑地址必须是 10.x、172.16-31.x 或 192.168.x 的局域网 IPv4。'
    }
    return $Requested
  }
  if ($Candidates.Count -eq 0) {
    throw '没有找到可用的局域网 IPv4，请连接 Wi-Fi 或网线后重试。'
  }
  if ($Candidates.Count -eq 1) { return $Candidates[0] }

  Write-Host '检测到多个局域网地址，请选择当前手机能够访问的网络：'
  for ($index = 0; $index -lt $Candidates.Count; $index += 1) {
    Write-Host ("  {0}. {1}" -f ($index + 1), $Candidates[$index])
  }
  while ($true) {
    $selection = Read-Host '请输入序号'
    if ($selection -match '^\d+$') {
      $candidateIndex = [int]$selection - 1
      if ($candidateIndex -ge 0 -and $candidateIndex -lt $Candidates.Count) {
        return $Candidates[$candidateIndex]
      }
    }
    Write-Host '序号无效，请重新输入。' -ForegroundColor Yellow
  }
}

function Resolve-DshosInstallHostAddress {
  param([string]$Requested)

  if ($Requested.Length -gt 0) {
    return Resolve-DshosHostAddress $Requested
  }
  return Resolve-DshosHostAddress '' @(Get-DshosHostCandidates)
}

function Get-DshosCommandPath {
  param([Parameter(Mandatory = $true)][string]$Name)

  $command = Get-Command ($Name + '.cmd') -ErrorAction SilentlyContinue
  if ($null -eq $command) { $command = Get-Command $Name -ErrorAction SilentlyContinue }
  if ($null -eq $command) { throw "未找到 $Name，请先安装官方 DSH 及其依赖。" }
  return $command.Source
}

function Assert-DshosExecutablePath {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not [System.IO.Path]::IsPathRooted($Path)) {
    throw 'DSH 程序路径必须是绝对路径。'
  }
  $resolved = [System.IO.Path]::GetFullPath($Path)
  if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
    throw "DSH 程序不存在：$resolved"
  }
  if ([System.IO.Path]::GetExtension($resolved) -notin @('.cmd', '.exe')) {
    throw 'DSH 程序只允许使用 .cmd 或 .exe 启动文件。'
  }
  return $resolved
}

function Read-DshosRuntimeConfiguration {
  param([string]$Path = $RuntimeConfigPath)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw '尚未配置 DSHOS Link 后台运行，请先执行安装或升级。'
  }
  try {
    $configuration = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    $schemaVersion = [int]$configuration.schemaVersion
    if ($schemaVersion -notin @(1, 2, 3, $RuntimeSchemaVersion)) {
      throw '后台运行配置版本不受支持'
    }
    $requiredProperties = @(
      'schemaVersion', 'connectorVersion', 'dshPath', 'profile', 'hostAddress',
      'pairingPort', 'pairingBootstrapPort'
    )
    if ($schemaVersion -eq 1) { $requiredProperties += 'connectorPort' }
    if ($schemaVersion -ge 3) { $requiredProperties += 'serviceEnvironment' }
    if ($schemaVersion -ge 4) { $requiredProperties += 'dshHome' }
    foreach ($property in $requiredProperties) {
      if ($configuration.PSObject.Properties.Name -notcontains $property) {
        throw "缺少字段 $property"
      }
    }
    $configurationConnectorVersion = [string]$configuration.connectorVersion
    if ($configurationConnectorVersion -ne $ConnectorVersion -and
      $configurationConnectorVersion -notin $PreviousConnectorVersions) {
      throw '后台运行配置与当前连接器版本不一致'
    }
    if ([string]$configuration.profile -notmatch '^[A-Za-z0-9_-]{1,64}$') {
      throw 'DSH Profile 名称无效'
    }
    if (-not (Test-DshosPrivateIpv4 ([string]$configuration.hostAddress))) {
      throw '后台运行配置中的局域网地址无效'
    }
    if (($schemaVersion -eq 1 -and [string]$configuration.connectorPort -ne '24680') -or
      [string]$configuration.pairingPort -ne $ConnectorEnvironment.DSHOS_LINK_PAIRING_PORT -or
      [string]$configuration.pairingBootstrapPort -ne $ConnectorEnvironment.DSHOS_LINK_PAIRING_BOOTSTRAP_PORT) {
      throw '后台运行配置中的固定端口无效'
    }
    $configuration.dshPath = Assert-DshosExecutablePath ([string]$configuration.dshPath)
    if ($configurationConnectorVersion -ne $ConnectorVersion) {
      $configuration.connectorVersion = $ConnectorVersion
    }
    if ($schemaVersion -lt 3) {
      $configuration.schemaVersion = 3
      $configuration.PSObject.Properties.Remove('connectorPort')
      $configuration | Add-Member -NotePropertyName serviceEnvironment -NotePropertyValue 'production' -Force
    }
    if ($configuration.serviceEnvironment -cnotin @('production', 'sandbox')) {
      throw '后台服务环境无效'
    }
    if ($configuration.PSObject.Properties.Name -contains 'dshHome' -and (-not [IO.Path]::IsPathRooted([string]$configuration.dshHome) -or
      [string]::IsNullOrWhiteSpace([string]$configuration.dshHome))) {
      throw '原 DSH 数据目录无效'
    }
    return $configuration
  } catch {
    throw "DSHOS Link 后台运行配置无效：$($_.Exception.Message)"
  }
}

function Resolve-DshosExecutablePath {
  param(
    [string]$RequestedPath,
    [switch]$AllowSavedConfiguration
  )

  if ($RequestedPath.Length -gt 0) {
    if ($AllowSavedConfiguration -and (Test-Path -LiteralPath $RuntimeConfigPath -PathType Leaf) -and
      [IO.Path]::GetFullPath($RequestedPath) -ine [string](Read-DshosRuntimeConfiguration).dshPath) {
      throw '已有连接器绑定另一份 DSH 程序，不能在升级时切换；原安装保持不变。'
    }
    return Assert-DshosExecutablePath $RequestedPath
  }
  if ($AllowSavedConfiguration -and (Test-Path -LiteralPath $RuntimeConfigPath -PathType Leaf)) {
    return [string](Read-DshosRuntimeConfiguration).dshPath
  }
  try {
    return Assert-DshosExecutablePath (Get-DshosCommandPath 'dsh')
  } catch {
    if ($AllowSavedConfiguration -and (Test-Path -LiteralPath $RuntimeConfigPath -PathType Leaf)) {
      return [string](Read-DshosRuntimeConfiguration).dshPath
    }
    throw '未找到 DSH。请在安装或升级时通过 -DshPath 指定官方 DSH 启动文件。'
  }
}

function Resolve-DshosHomePath {
  param([string]$Requested = '')
  $value = if (-not [string]::IsNullOrWhiteSpace($Requested)) { $Requested }
    elseif (-not [string]::IsNullOrWhiteSpace($env:DSH_HOME)) { $env:DSH_HOME }
    else { Join-Path ([Environment]::GetFolderPath('UserProfile')) '.dsh' }
  if ($value -eq '~' -or $value.StartsWith('~/') -or $value.StartsWith('~\')) {
    $value = Join-Path ([Environment]::GetFolderPath('UserProfile')) $value.Substring(1).TrimStart('\', '/')
  }
  $full = [IO.Path]::GetFullPath($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($value))
  $root = [IO.Path]::GetPathRoot($full)
  if ($full.TrimEnd('\', '/') -ieq $root.TrimEnd('\', '/')) { return $root.TrimEnd('\', '/') + '\' }
  return $full.TrimEnd('\', '/')
}

function Resolve-DshosInstance {
  param([string]$RequestedProfile = '', [string]$RequestedHome = '')
  $saved = if (Test-Path -LiteralPath $RuntimeConfigPath -PathType Leaf) { Read-DshosRuntimeConfiguration } else { $null }
  $selectedProfile = $RequestedProfile
  $selectedHome = ''
  if ($null -ne $saved) {
    if ($RequestedProfile.Length -gt 0 -and $RequestedProfile -cne [string]$saved.profile) {
      throw '已有连接器绑定另一份 DSH 配置，不能在升级时切换；原配置保持不变。'
    }
    $selectedProfile = [string]$saved.profile
    if ($saved.PSObject.Properties.Name -contains 'dshHome') { $selectedHome = [string]$saved.dshHome }
    else {
      # Older installers recorded the profile root during the existing provider transaction.
      $statePath = Join-Path $RuntimeRoot 'balance-provider-state.json'
      if (Test-Path -LiteralPath $statePath -PathType Leaf) {
        $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
        $root = [string]$state.root
        if ($state.schemaVersion -ne 1 -or $state.profile -cne $selectedProfile -or
          -not [IO.Path]::IsPathRooted($root) -or (Split-Path -Leaf $root) -cne $selectedProfile -or
          (Split-Path -Leaf (Split-Path -Parent $root)) -cne 'profiles') {
          throw '旧安装的数据目录记录不一致，已停止，原内容保持不变。'
        }
        $selectedHome = Split-Path -Parent (Split-Path -Parent $root)
      } elseif ($RequestedHome.Length -eq 0) {
        throw '旧安装未记录数据目录。请用 --dsh-home 明确原 DSH 数据目录，不能自动改用空目录。'
      }
    }
  }
  if ($selectedHome.Length -gt 0) {
    $selectedHome = Resolve-DshosHomePath $selectedHome
    if ($RequestedHome.Length -gt 0 -and (Resolve-DshosHomePath $RequestedHome) -ine $selectedHome) {
      throw '指定的数据目录与原 DSH 不一致，已停止；不会迁移或覆盖原会话。'
    }
  } else { $selectedHome = Resolve-DshosHomePath $RequestedHome }
  $profilesPath = Join-Path $selectedHome 'profiles'
  if (-not (Test-Path -LiteralPath $profilesPath -PathType Container)) {
    throw '没有找到原 DSH 数据目录，请在原 DSH 环境中安装或指定 --dsh-home；不会新建空数据目录。'
  }
  if ($selectedProfile.Length -eq 0) {
    $profiles = @(Get-ChildItem -LiteralPath $profilesPath -Directory | Where-Object {
      $_.Name -match '^[A-Za-z0-9_-]{1,64}$' -and
      (Test-Path -LiteralPath (Join-Path $_.FullName 'package.json') -PathType Leaf)
    })
    if ($profiles.Count -ne 1) {
      throw '不能唯一确定原 DSH 配置，请用 --profile 指定原配置；不会默认改用 web。'
    }
    $selectedProfile = $profiles[0].Name
  }
  if ($selectedProfile -notmatch '^[A-Za-z0-9_-]{1,64}$' -or
    -not (Test-Path -LiteralPath (Join-Path $profilesPath "$selectedProfile\package.json") -PathType Leaf)) {
    throw '指定的 DSH 配置不存在；不会创建另一套空配置。'
  }
  return [pscustomobject]@{profile=$selectedProfile; dshHome=$selectedHome}
}

function New-DshosRuntimeConfiguration {
  param(
    [Parameter(Mandatory = $true)][string]$DshCommand,
    [Parameter(Mandatory = $true)][string]$ProfileName,
    [Parameter(Mandatory = $true)][string]$HostIp,
    [ValidateSet('production', 'sandbox')][string]$EnvironmentName = 'production',
    [string]$DataHome = ''
  )

  return [ordered]@{
    schemaVersion = $RuntimeSchemaVersion
    connectorVersion = $ConnectorVersion
    dshPath = Assert-DshosExecutablePath $DshCommand
    profile = $ProfileName
    dshHome = Resolve-DshosHomePath $DataHome
    hostAddress = Resolve-DshosHostAddress $HostIp
    serviceEnvironment = $EnvironmentName.ToLowerInvariant()
    pairingPort = $ConnectorEnvironment.DSHOS_LINK_PAIRING_PORT
    pairingBootstrapPort = $ConnectorEnvironment.DSHOS_LINK_PAIRING_BOOTSTRAP_PORT
  }
}

function Resolve-DshosServiceEnvironment {
  param([ValidateSet('', 'production', 'sandbox')][string]$Requested = '', [string]$Path = $RuntimeConfigPath)
  if ($Requested.Length -gt 0) { return $Requested.ToLowerInvariant() }
  if (Test-Path -LiteralPath $Path -PathType Leaf) {
    return [string](Read-DshosRuntimeConfiguration $Path).serviceEnvironment
  }
  return 'production'
}

function Write-DshosRuntimeConfiguration {
  param(
    [Parameter(Mandatory = $true)]$Configuration,
    [string]$Path = $RuntimeConfigPath
  )

  $directory = Split-Path -Parent $Path
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
  $temporary = Join-Path $directory ([guid]::NewGuid().ToString('N') + '.runtime.tmp')
  try {
    $Configuration | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $temporary -Encoding UTF8
    Read-DshosRuntimeConfiguration $temporary | Out-Null
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
      [IO.File]::Replace($temporary, $Path, [NullString]::Value)
    } else {
      [IO.File]::Move($temporary, $Path)
    }
  } finally {
    if (Test-Path -LiteralPath $temporary -PathType Leaf) { Remove-Item -LiteralPath $temporary -Force }
  }
}

function Write-DshosRuntimeStatus {
  param(
    [Parameter(Mandatory = $true)][ValidateSet('starting', 'running', 'stopped', 'failed')][string]$State,
    [int]$ExitCode = 0,
    [ValidateSet('none', 'configuration', 'existing_instance', 'dsh_process')][string]$FailureStage = 'none',
    [string]$Path = $RuntimeStatusPath
  )

  $directory = Split-Path -Parent $Path
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
  [ordered]@{
    state = $State
    updatedAt = [DateTimeOffset]::Now.ToString('o')
    exitCode = $ExitCode
    failureStage = if ($State -eq 'failed') { $FailureStage } else { 'none' }
  } | ConvertTo-Json | Set-Content -LiteralPath $Path -Encoding UTF8
}

function Write-DshosUnavailableListenerStatus {
  param(
    [Parameter(Mandatory = $true)]$Configuration,
    [string]$Path = $RuntimeListenerStatusPath
  )

  $directory = Split-Path -Parent $Path
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
  [ordered]@{
    version = 1
    state = 'DSH_UNAVAILABLE'
    port = [int]$Configuration.pairingPort
    bootstrapPort = [int]$Configuration.pairingBootstrapPort
    failureStage = 'UNKNOWN'
    repairAvailable = $false
    updatedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    processId = $PID
  } | ConvertTo-Json -Compress | Set-Content -LiteralPath $Path -Encoding UTF8
}

function Read-DshosListenerStatus {
  param([string]$Path = $RuntimeListenerStatusPath)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  try {
    $status = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    $expected = @(
      'version', 'state', 'port', 'bootstrapPort', 'failureStage', 'repairAvailable',
      'updatedAt', 'processId'
    )
    if (@($status.PSObject.Properties.Name).Count -ne $expected.Count) {
      throw '字段数量错误'
    }
    for ($index = 0; $index -lt $expected.Count; $index += 1) {
      if ($status.PSObject.Properties.Name[$index] -cne $expected[$index]) {
        throw '字段顺序错误'
      }
    }
    if ([int]$status.version -ne 1 -or
      [string]$status.state -notin @(
        'READY', 'PORT_CONFLICT', 'NO_PRIVATE_ADDRESS', 'DSH_UNAVAILABLE',
        'REPAIRING', 'RESTART_REQUIRED', 'FAILED'
      ) -or
      [int]$status.port -lt 1 -or [int]$status.port -gt 65535 -or
      [int]$status.bootstrapPort -lt 1 -or [int]$status.bootstrapPort -gt 65535 -or
      [int]$status.port -eq [int]$status.bootstrapPort -or
      [string]$status.failureStage -notin @(
        'NONE', 'PAIRING_HTTPS', 'BOOTSTRAP_HTTP', 'CONFIGURATION',
        'NO_AVAILABLE_PAIR', 'UNKNOWN'
      ) -or
      $status.repairAvailable -isnot [bool] -or
      [long]$status.updatedAt -le 0 -or [int]$status.processId -le 0) {
      throw '字段值错误'
    }
    return $status
  } catch {
    throw '连接器监听状态记录无效。'
  }
}

function Wait-DshosListenerStatus {
  param(
    [int]$TimeoutMilliseconds = $ListenerReadinessTimeoutMilliseconds,
    [string]$Path = $RuntimeListenerStatusPath,
    [long]$NotBeforeUnixMilliseconds = 0,
    [int]$ManagedRuntimeProcessId = 0
  )

  $timer = [System.Diagnostics.Stopwatch]::StartNew()
  do {
    $status = Read-DshosListenerStatus $Path
    if ($null -ne $status -and [string]$status.state -ne 'REPAIRING' -and
      [long]$status.updatedAt -ge $NotBeforeUnixMilliseconds) {
      if ($ManagedRuntimeProcessId -le 0 -or
        (Test-DshosProcessDescendantOrSelf ([int]$status.processId) $ManagedRuntimeProcessId)) {
        return $status
      }
    }
    Start-Sleep -Milliseconds 200
  } while ($timer.ElapsedMilliseconds -lt $TimeoutMilliseconds)
  throw '等待连接器真实监听状态超时；本次安装或升级不能判定为完成。'
}

function Test-DshosProcessDescendantOrSelf {
  param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][int]$AncestorProcessId,
    [object[]]$Processes = @()
  )

  if ($ProcessId -eq $AncestorProcessId) { return $true }
  if ($Processes.Count -eq 0) { $Processes = @(Get-CimInstance Win32_Process) }
  $current = $ProcessId
  $seen = New-Object System.Collections.Generic.HashSet[int]
  while ($current -gt 0 -and $seen.Add($current)) {
    $process = $Processes | Where-Object { [int]$_.ProcessId -eq $current } | Select-Object -First 1
    if ($null -eq $process) { return $false }
    $parent = [int]$process.ParentProcessId
    if ($parent -eq $AncestorProcessId) { return $true }
    $current = $parent
  }
  return $false
}

function Test-DshosExpectedWebProcess {
  param(
    [Parameter(Mandatory = $true)]$Process,
    [Parameter(Mandatory = $true)][string]$DshCommand,
    [Parameter(Mandatory = $true)][string]$ProfileName,
    [switch]$AllowProfileShorthand
  )

  if ($null -eq $Process.CommandLine) { return $false }
  $commandLine = [string]$Process.CommandLine
  $profilePattern = '(?i)(?:^|\s)--profile(?:\s+|=)"?' + [regex]::Escape($ProfileName) + '"?(?:\s|$)'
  if ($commandLine -notmatch $profilePattern) {
    # Official CLI also accepts `dsh web`. This is only a conflict detector;
    # protected web-entry ownership still requires our explicit launch form.
    $entryPattern = if ([IO.Path]::GetExtension($DshCommand) -ieq '.exe') {
      '^(?:"[^"\r\n]+"|\S+)'
    } else { '@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js"?' }
    $shorthand = '(?i)' + $entryPattern + '\s+"?' + [regex]::Escape($ProfileName) + '"?(?:\s|$)'
    if (-not $AllowProfileShorthand -or $commandLine -notmatch $shorthand) { return $false }
  }

  $extension = [System.IO.Path]::GetExtension($DshCommand)
  if ($extension -ieq '.exe') {
    if ($null -eq $Process.ExecutablePath) { return $false }
    return [System.IO.Path]::GetFullPath([string]$Process.ExecutablePath) -ieq `
      [System.IO.Path]::GetFullPath($DshCommand)
  }
  if ($extension -ine '.cmd' -or [string]$Process.Name -ine 'node.exe') { return $false }
  return $commandLine -match '(?i)@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js(?:"|\s|$)'
}

function Assert-DshosInstanceNotRunningElsewhere {
  param(
    [Parameter(Mandatory = $true)][string]$DshCommand,
    [Parameter(Mandatory = $true)][string]$ProfileName,
    [switch]$AllowManagedRuntime,
    [object[]]$Processes
  )
  if (-not $PSBoundParameters.ContainsKey('Processes')) {
    $Processes = @(Get-CimInstance Win32_Process -ErrorAction Stop)
  }
  $managed = @($Processes | Where-Object { Test-DshosManagedRuntimeProcess $_ })
  if ($AllowManagedRuntime -and $managed.Count -gt 1) { throw '检测到多个 DSHOS Link 后台进程，已停止自动操作。' }
  foreach ($process in $Processes) {
    if (-not (Test-DshosExpectedWebProcess $process $DshCommand $ProfileName -AllowProfileShorthand)) { continue }
    if ([IO.Path]::GetExtension($DshCommand) -ieq '.cmd') {
      # A different proven executable is not this installation. Relative or
      # unparseable entry paths remain ambiguous, never permission to start.
      if ([string]$process.CommandLine -match '^(?:"[^"]+"|\S+)\s+(?:"(?<entry>[^"]+)"|(?<entry>\S+))\s+') {
        $entry = [string]$Matches['entry']
        if ([IO.Path]::IsPathRooted($entry) -and
          [IO.Path]::GetFullPath($entry) -ine (Get-DshosWebCommandEntry $DshCommand)) { continue }
      }
    }
    if ($AllowManagedRuntime -and $managed.Count -eq 1 -and
      (Test-DshosProcessDescendantOrSelf $process.ProcessId $managed[0].ProcessId $Processes)) { continue }
    throw '原 DSH 配置仍由另一进程运行，请先在电脑关闭该实例后重试；不会安装、改端口或另开实例。'
  }
}

function Invoke-DshosCommand {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )

  $output = & $Command @Arguments 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) {
    throw ("命令执行失败：{0} {1}`n{2}" -f $Command, ($Arguments -join ' '), $output.Trim())
  }
  return $output.Trim()
}

function Invoke-DshosPluginCommand {
  param(
    [Parameter(Mandatory = $true)][string]$DshCommand,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [ValidateSet('preserve', 'install', 'remove')][string]$ConnectorBundleChange = 'preserve'
  )

  if ($Arguments.Count -lt 4 -or $Arguments[0] -cne 'plugin' -or $Arguments[1] -cne '--profile') {
    throw 'Invalid DSH plugin command.'
  }
  $manifestPath = Get-DshosProfileManifestPath $Arguments[2]
  $originalBytes = [IO.File]::ReadAllBytes($manifestPath)
  $originalManifest = [Text.Encoding]::UTF8.GetString($originalBytes).TrimStart([char]0xFEFF) | ConvertFrom-Json
  if ($originalManifest.dsh.profile.bundles -isnot [Array] -or
    @($originalManifest.dsh.profile.bundles | Where-Object { $_ -isnot [string] }).Count -gt 0) {
    throw 'Invalid DSH bundle selection; original profile was retained.'
  }
  $change = 'preserve'
  $maintenanceStage = if ($Arguments[3] -eq 'install') { 'recovery' } else { 'install' }
  $maintenanceStarted = [Diagnostics.Stopwatch]::StartNew()
  $maintenanceReason = 'package'
  $nativeExitCode = 0
  try {
    $maintenanceReason = 'policy'
    Repair-DshosConnectorAgePolicy (Split-Path -Parent $manifestPath)
    $maintenanceReason = 'package'
    # pnpm add/remove cannot migrate an older store layout. Reconcile the
    # existing locked graph first; install can rebuild it without --force,
    # changing package versions or relaxing engine/host compatibility checks.
    $profileRoot = Split-Path -Parent $manifestPath
    $modulesPath = Join-Path $profileRoot 'node_modules/.modules.yaml'
    if ($Arguments[3] -in @('add', 'remove') -and
      (Test-Path -LiteralPath $modulesPath -PathType Leaf) -and
      (Test-Path -LiteralPath (Join-Path $profileRoot 'pnpm-lock.yaml') -PathType Leaf)) {
      $modulesText = Get-Content -LiteralPath $modulesPath -Raw -Encoding UTF8
      if ($modulesText -match '(?m)^\s*["'']?packageManager["'']?:\s*["'']?pnpm@(\d+)\.' -and
        [int]$Matches[1] -lt [int]($RequiredPnpmVersion.Split('.')[0])) {
        Invoke-DshosPluginCommand $DshCommand @('plugin', '--profile', $Arguments[2], 'install', '--frozen-lockfile', '--config.confirm-modules-purge=false', '--config.optimistic-repeat-install=false') | Out-Host
      }
    }
    Write-Host '正在安装连接器，请等待最终结果。'
    # CLI precedence also covers a workspace which enables updateNotifier.
    # Keep this fixed transaction independent of pnpm self-update requests,
    # without changing the user's process environment or configuration files.
    $commandArguments = @($Arguments) + @('--config.update-notifier=false')
    $nativeErrorPreference=$ErrorActionPreference
    try {
      $ErrorActionPreference='Continue'
      & $DshCommand @commandArguments 2>&1 | ForEach-Object {
      $line=[string]$_
      if ($line -match 'ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION|ERR_PNPM_NO_MATURE_MATCHING_VERSION') { $maintenanceReason='release_age' }
      elseif ($maintenanceReason -eq 'package' -and $line -match 'UND_ERR_CONNECT_TIMEOUT|ETIMEDOUT') { $maintenanceReason='timeout' }
      elseif ($maintenanceReason -eq 'package' -and $line -match 'ENOTFOUND|EAI_AGAIN') { $maintenanceReason='dns' }
      elseif ($maintenanceReason -eq 'package' -and $line -match 'ECONNRESET|ECONNREFUSED|ERR_PNPM_FETCH_') { $maintenanceReason='network' }
      Write-Host $line
    }
      $nativeExitCode = $LASTEXITCODE
    } finally { $ErrorActionPreference=$nativeErrorPreference }
    if ($nativeExitCode -ne 0) {
      $failure = [InvalidOperationException]::new('安装过程未能完成。')
      $failure.Data['DshosPackageExitCode'] = $nativeExitCode
      # Observed Windows process crash, not a generic network or package error.
      # This marker alone never authorizes a retry before transaction recovery.
      if ([long]$nativeExitCode -in @(-2147483645L, 2147483651L)) {
        $failure.Data['DshosPackageProcessCrash'] = $true
        $maintenanceReason = 'process_crash'
      }
      throw $failure
    }
    Repair-DshosConnectorAgePolicy (Split-Path -Parent $manifestPath)
    $change = $ConnectorBundleChange
    Write-DshosInstallDiagnostic $maintenanceStage 'ok' 'none' 0 $maintenanceStarted.ElapsedMilliseconds
  } catch {
    Write-DshosInstallDiagnostic $maintenanceStage 'failed' $maintenanceReason $nativeExitCode $maintenanceStarted.ElapsedMilliseconds
    throw
  } finally {
    Restore-DshosBundleSelection $manifestPath $originalBytes $change
  }
}

function Get-DshosReleasePackage {
  param([string]$RequestedPath)

  if ($RequestedPath.Length -gt 0) {
    $candidate = Get-Item -LiteralPath $RequestedPath -ErrorAction Stop
    if ($candidate.PSIsContainer -or $candidate.Name -notmatch '^dshos-link-connector-[0-9A-Za-z.-]+\.tgz$') {
      throw '请选择 DSHOS Link 官方发行包中的连接器 tgz 文件。'
    }
    return $candidate
  }
  $matches = @(Get-ChildItem -LiteralPath $PSScriptRoot -File -Filter 'dshos-link-connector-*.tgz')
  if ($matches.Count -ne 1) {
    throw '当前目录必须恰好包含一个 dshos-link-connector-*.tgz 连接器包。'
  }
  return $matches[0]
}

function Resolve-DshosInstallTarget {
  param(
    [string]$RequestedPath,
    [string]$RequestedSpec
  )

  if ($RequestedPath.Length -gt 0 -and $RequestedSpec.Length -gt 0) {
    throw '连接器安装包路径和 NPM 包名不能同时提供。'
  }
  if ($RequestedSpec.Length -gt 0) {
    $expected = "$ConnectorPackageName@$ConnectorVersion"
    if ($RequestedSpec -cne $expected) {
      throw "只允许安装当前固定版本 $expected。"
    }
    return $RequestedSpec
  }

  $package = Get-DshosReleasePackage $RequestedPath
  Assert-DshosPackageHash $package | Out-Null
  return $package.FullName
}

function Get-DshosFileSha256 {
  param([Parameter(Mandatory = $true)][string]$Path)

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

function Assert-DshosPackageHash {
  param([Parameter(Mandatory = $true)][System.IO.FileInfo]$Package)

  $manifestPath = Join-Path $Package.DirectoryName 'SHA256SUMS.txt'
  $line = (Get-Content -LiteralPath $manifestPath -ErrorAction Stop | Where-Object {
    $_ -match ("^[0-9A-Fa-f]{64}  " + [regex]::Escape($Package.Name) + '$')
  } | Select-Object -First 1)
  if ($null -eq $line) { throw '校验文件中没有当前连接器包的 SHA-256。' }
  $expected = ($line -split '  ', 2)[0].ToUpperInvariant()
  $actual = Get-DshosFileSha256 $Package.FullName
  if ($actual -ne $expected) { throw '连接器包校验失败，请重新下载官方发行包。' }
  return $expected
}

function Copy-DshosVerifiedReleasePackage {
  param(
    [Parameter(Mandatory = $true)][System.IO.FileInfo]$Package,
    [Parameter(Mandatory = $true)][string]$DestinationPath,
    [Parameter(Mandatory = $true)][string]$ExpectedHash
  )

  $temporaryPath = $DestinationPath + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
  try {
    Copy-Item -LiteralPath $Package.FullName -Destination $temporaryPath
    if ((Get-DshosFileSha256 $temporaryPath) -ne $ExpectedHash) {
      throw '连接器包在校验后发生变化，请重新选择官方发行包。'
    }
    Move-Item -LiteralPath $temporaryPath -Destination $DestinationPath -Force
  } finally {
    Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
  }
}

function Save-DshosReleasePackage {
  param(
    [Parameter(Mandatory = $true)][System.IO.FileInfo]$Package,
    [string]$DestinationRoot = $RuntimePackageRoot
  )

  $packageHash = Assert-DshosPackageHash $Package
  $versionDirectory = Join-Path $DestinationRoot $ConnectorVersion
  $destinationDirectory = Join-Path $versionDirectory $packageHash
  New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null
  $destinationPath = Join-Path $destinationDirectory $Package.Name
  if ([System.IO.Path]::GetFullPath($Package.FullName) -ne [System.IO.Path]::GetFullPath($destinationPath)) {
    if (-not (Test-Path -LiteralPath $destinationPath -PathType Leaf) -or
      (Get-DshosFileSha256 $destinationPath) -ne $packageHash) {
      Copy-DshosVerifiedReleasePackage $Package $destinationPath $packageHash
    }
  }
  if ((Get-DshosFileSha256 $destinationPath) -ne $packageHash) {
    throw '连接器包复制到稳定目录后校验失败。'
  }
  $destinationManifestPath = Join-Path $destinationDirectory 'SHA256SUMS.txt'
  Set-Content -LiteralPath $destinationManifestPath -Encoding Ascii -Value `
    ("{0}  {1}" -f $packageHash, $Package.Name)
  return $destinationPath
}

function Get-DshosManagedPackageLocation {
  param(
    [Parameter(Mandatory = $true)][string]$CurrentPackagePath,
    [string]$DestinationRoot = $RuntimePackageRoot
  )

  $resolvedRoot = [System.IO.Path]::GetFullPath($DestinationRoot)
  $resolvedCurrent = [System.IO.Path]::GetFullPath($CurrentPackagePath)
  $rootPrefix = $resolvedRoot.TrimEnd('\') + '\'
  if (-not $resolvedCurrent.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw '当前连接器包不在受管缓存目录中。'
  }
  $currentDirectory = Split-Path -Parent $resolvedCurrent
  $versionDirectory = Split-Path -Parent $currentDirectory
  if (-not (Split-Path -Parent $versionDirectory).Equals(
    $resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw '连接器包缓存目录结构无效。'
  }
  $currentHash = Split-Path -Leaf $currentDirectory
  if ($currentHash -cnotmatch '^[0-9A-F]{64}$' -or
    (Get-DshosFileSha256 $resolvedCurrent) -ne $currentHash) {
    throw '当前连接器包缓存哈希无效。'
  }
  foreach ($path in @($resolvedRoot, $versionDirectory, $currentDirectory)) {
    $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw '连接器包缓存目录不能是重解析点。'
    }
  }
  return [pscustomobject][ordered]@{
    root = $resolvedRoot
    currentPath = $resolvedCurrent
    currentDirectory = $currentDirectory
    currentHash = $currentHash
    versionDirectory = $versionDirectory
    packageName = Split-Path -Leaf $resolvedCurrent
  }
}

function Read-DshosReadyPackageState {
  param([Parameter(Mandatory = $true)][string]$VersionDirectory)

  $path = Join-Path $VersionDirectory $ReadyPackageStateFileName
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
  try {
    $state = Get-Content -LiteralPath $path -Raw -ErrorAction Stop |
      ConvertFrom-Json -ErrorAction Stop
    $expected = @('schemaVersion', 'currentHash', 'previousHash')
    if (@($state.PSObject.Properties.Name).Count -ne $expected.Count) {
      throw '字段数量错误'
    }
    for ($index = 0; $index -lt $expected.Count; $index += 1) {
      if ($state.PSObject.Properties.Name[$index] -cne $expected[$index]) {
        throw '字段顺序错误'
      }
    }
    if ([int]$state.schemaVersion -ne $ReadyPackageStateSchemaVersion -or
      $state.currentHash -isnot [string] -or
      [string]$state.currentHash -cnotmatch '^[0-9A-F]{64}$' -or
      ($null -ne $state.previousHash -and
        ($state.previousHash -isnot [string] -or
          [string]$state.previousHash -cnotmatch '^[0-9A-F]{64}$')) -or
      ($null -ne $state.previousHash -and
        [string]$state.previousHash -ceq [string]$state.currentHash)) {
      throw '字段值错误'
    }
    return $state
  } catch {
    throw '连接器成功包缓存状态无效。'
  }
}

function Test-DshosCachedPackageHash {
  param(
    [Parameter(Mandatory = $true)][string]$VersionDirectory,
    [Parameter(Mandatory = $true)][string]$PackageName,
    [string]$Hash = ''
  )

  if ($Hash -cnotmatch '^[0-9A-F]{64}$') { return $false }
  $path = Join-Path (Join-Path $VersionDirectory $Hash) $PackageName
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $false }
  try {
    return (Get-DshosFileSha256 $path) -eq $Hash
  } catch {
    return $false
  }
}

function Update-DshosReadyPackageState {
  param(
    [Parameter(Mandatory = $true)][string]$CurrentPackagePath,
    [string]$DestinationRoot = $RuntimePackageRoot
  )

  $location = Get-DshosManagedPackageLocation $CurrentPackagePath $DestinationRoot
  $existing = Read-DshosReadyPackageState $location.versionDirectory
  $previousHash = $null
  if ($null -ne $existing) {
    $candidates = if ([string]$existing.currentHash -ceq [string]$location.currentHash) {
      @([string]$existing.previousHash)
    } else {
      @([string]$existing.currentHash, [string]$existing.previousHash)
    }
    foreach ($candidate in $candidates) {
      if (Test-DshosCachedPackageHash $location.versionDirectory $location.packageName $candidate) {
        $previousHash = $candidate
        break
      }
    }
  }
  $pruningAllowed = $null -ne $existing -and $null -ne $previousHash
  $state = [pscustomobject][ordered]@{
    schemaVersion = $ReadyPackageStateSchemaVersion
    currentHash = [string]$location.currentHash
    previousHash = $previousHash
  }
  $statePath = Join-Path $location.versionDirectory $ReadyPackageStateFileName
  $temporaryPath = $statePath + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
  try {
    $state | ConvertTo-Json -Compress | Set-Content -LiteralPath $temporaryPath -Encoding UTF8
    Move-Item -LiteralPath $temporaryPath -Destination $statePath -Force
  } finally {
    Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
  }
  $saved = Read-DshosReadyPackageState $location.versionDirectory
  if ([string]$saved.currentHash -cne [string]$state.currentHash -or
    [string]$saved.previousHash -cne [string]$state.previousHash) {
    throw '连接器成功包缓存状态写入失败。'
  }
  return [pscustomobject][ordered]@{
    state = $saved
    pruningAllowed = $pruningAllowed
  }
}

function Remove-DshosStaleReleasePackages {
  param(
    [Parameter(Mandatory = $true)][string]$CurrentPackagePath,
    [string]$PreviousSuccessfulHash = '',
    [string]$DestinationRoot = $RuntimePackageRoot
  )

  $location = Get-DshosManagedPackageLocation $CurrentPackagePath $DestinationRoot
  if ($PreviousSuccessfulHash.Length -gt 0 -and
    -not (Test-DshosCachedPackageHash `
      $location.versionDirectory $location.packageName $PreviousSuccessfulHash)) {
    throw '上一个成功连接器包缓存无效。'
  }
  $keep = @([string]$location.currentHash)
  if ($PreviousSuccessfulHash.Length -gt 0) { $keep += $PreviousSuccessfulHash }
  $candidates = @(Get-ChildItem -LiteralPath $location.versionDirectory -Directory | Where-Object {
    $_.Name -match '^[0-9A-F]{64}$' -and
      ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0
  })
  @($candidates | Where-Object { $_.Name -notin $keep }) | ForEach-Object {
    $resolvedCandidate = [System.IO.Path]::GetFullPath($_.FullName)
    $versionPrefix = $location.versionDirectory.TrimEnd('\') + '\'
    if ($resolvedCandidate.StartsWith($versionPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      Remove-Item -LiteralPath $resolvedCandidate -Recurse -Force
    }
  }
}

function Enter-DshosManagerMutex {
  param([string]$Name = $ManagerMutexName)

  $mutex = [System.Threading.Mutex]::new($false, $Name)
  $ownsMutex = $false
  try {
    try {
      $ownsMutex = $mutex.WaitOne(0)
    } catch [System.Threading.AbandonedMutexException] {
      $ownsMutex = $true
    }
    if (-not $ownsMutex) {
      throw '已有连接器安装、升级或卸载操作正在进行，请等待完成后重试。'
    }
    return $mutex
  } catch {
    if ($ownsMutex) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
    throw
  }
}

function Exit-DshosManagerMutex {
  param([Parameter(Mandatory = $true)][System.Threading.Mutex]$Mutex)

  $Mutex.ReleaseMutex()
  $Mutex.Dispose()
}

function Enable-DshosPinnedPnpm {
  param([string]$ToolsRoot = (Join-Path $RuntimeRoot 'tools'))

  $corepackCommand = Get-DshosCommandPath 'corepack'
  $pnpmVersion = Invoke-DshosCommand $corepackCommand @("pnpm@$RequiredPnpmVersion", '--version')
  if ($pnpmVersion -ne $RequiredPnpmVersion) {
    throw "无法通过 Corepack 启动固定版本 pnpm $RequiredPnpmVersion。"
  }
  if ($corepackCommand.Contains('"')) {
    throw 'Corepack 程序路径无效。'
  }

  New-Item -ItemType Directory -Path $ToolsRoot -Force | Out-Null
  $shimPath = Join-Path $ToolsRoot 'pnpm.cmd'
  Set-Content -LiteralPath $shimPath -Encoding Ascii -Value @(
    '@echo off',
    ('"{0}" pnpm@{1} %*' -f $corepackCommand, $RequiredPnpmVersion)
  )
  $pathEntries = @($env:PATH -split ';')
  if ($pathEntries -notcontains $ToolsRoot) {
    $env:PATH = "$ToolsRoot;$env:PATH"
  }
  return $shimPath
}

function Set-DshosConnectorEnvironment {
  param([Parameter(Mandatory = $true)][string]$HostIp)

  foreach ($name in $LegacyConnectorEnvironmentNames) {
    [Environment]::SetEnvironmentVariable($name, $null, 'User')
    Remove-Item -LiteralPath ("Env:\{0}" -f $name) -ErrorAction SilentlyContinue
  }
  [Environment]::SetEnvironmentVariable($ManagedRuntimeEnvironmentName, $null, 'User')
  Remove-Item -LiteralPath ("Env:\{0}" -f $ManagedRuntimeEnvironmentName) -ErrorAction SilentlyContinue
  $values = [ordered]@{ DSHOS_LINK_HOST = $HostIp }
  foreach ($entry in $ConnectorEnvironment.GetEnumerator()) {
    $values[$entry.Key] = $entry.Value
  }
  foreach ($entry in $values.GetEnumerator()) {
    [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'User')
    Set-Item -LiteralPath ("Env:\{0}" -f $entry.Key) -Value $entry.Value
  }
}

function Remove-DshosConnectorEnvironment {
  foreach ($name in @('DSHOS_LINK_HOST', $ManagedRuntimeEnvironmentName) + @($ConnectorEnvironment.Keys) + $LegacyConnectorEnvironmentNames) {
    [Environment]::SetEnvironmentVariable($name, $null, 'User')
    Remove-Item -LiteralPath ("Env:\{0}" -f $name) -ErrorAction SilentlyContinue
  }
}

function Set-DshosProcessEnvironment {
  param([Parameter(Mandatory = $true)]$Configuration)

  if ($Configuration.serviceEnvironment -cnotin @('production', 'sandbox')) {
    throw '后台服务环境无效'
  }
  if ($Configuration.PSObject.Properties.Name -notcontains 'dshHome' -or
    -not [IO.Path]::IsPathRooted([string]$Configuration.dshHome)) {
    throw '后台尚未绑定原 DSH 数据目录，请先升级连接器；不会改用默认空目录。'
  }
  foreach ($name in $LegacyConnectorEnvironmentNames) {
    [Environment]::SetEnvironmentVariable($name, $null, 'Process')
  }
  $values = [ordered]@{
    DSH_HOME = [string]$Configuration.dshHome
    DSHOS_LINK_HOST = [string]$Configuration.hostAddress
    DSHOS_LINK_PAIRING_ENABLED = '1'
    DSHOS_LINK_PAIRING_PORT = [string]$Configuration.pairingPort
    DSHOS_LINK_PAIRING_BOOTSTRAP_PORT = [string]$Configuration.pairingBootstrapPort
    DSHOS_LINK_MANAGED_RUNTIME = '1'
    DSHOS_LINK_SERVICE_ENVIRONMENT = [string]$Configuration.serviceEnvironment
  }
  foreach ($entry in $values.GetEnumerator()) {
    [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
  }
}

function Save-DshosRuntimeManager {
  if (-not (Test-Path -LiteralPath $ManagerSourcePath -PathType Leaf)) {
    throw '找不到连接器后台管理脚本。'
  }
  New-Item -ItemType Directory -Path $RuntimeRoot -Force | Out-Null
  if ([System.IO.Path]::GetFullPath($ManagerSourcePath) -ne [System.IO.Path]::GetFullPath($RuntimeManagerPath)) {
    foreach ($helper in @('Manage-DshosLinkBalance.ps1', 'Manage-DshosLinkDesktop.ps1', 'Inspect-DshosBalance.mjs')) {
      Copy-Item -LiteralPath (Join-Path $BalanceHelperDirectory $helper) -Destination (Join-Path $RuntimeRoot $helper) -Force
    }
    Copy-Item -LiteralPath $ManagerSourcePath -Destination $RuntimeManagerPath -Force
  }
}

function Remove-DshosLegacyRuntimeTask {
  try {
    Get-ScheduledTask -TaskName $LegacyRuntimeTaskName -ErrorAction Stop | Out-Null
  } catch {
    return
  }
  Stop-ScheduledTask -TaskName $LegacyRuntimeTaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $LegacyRuntimeTaskName -Confirm:$false -ErrorAction Stop
}

function Get-DshosRuntimePowerShellPath {
  $windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  if (-not (Test-Path -LiteralPath $windowsPowerShell -PathType Leaf)) {
    throw '找不到 Windows PowerShell，无法创建后台启动项。'
  }
  return $windowsPowerShell
}

function Get-DshosRuntimeStartupCommand {
  $windowsPowerShell = Get-DshosRuntimePowerShellPath
  if ($windowsPowerShell.Contains('"') -or $RuntimeManagerPath.Contains('"')) {
    throw '后台管理脚本路径无效。'
  }
  return '"{0}" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{1}" -Action run' -f `
    $windowsPowerShell, $RuntimeManagerPath
}

function Get-DshosRuntimeStartupState {
  try {
    $actual = [string](Get-ItemPropertyValue -LiteralPath $RuntimeStartupKey -Name $RuntimeStartupName -ErrorAction Stop)
  } catch {
    return '未注册'
  }
  if ($actual -ceq (Get-DshosRuntimeStartupCommand)) {
    return '已注册'
  }
  return '配置不一致'
}

function Remove-DshosRuntimeStartup {
  Remove-ItemProperty -LiteralPath $RuntimeStartupKey -Name $RuntimeStartupName -ErrorAction SilentlyContinue
  Remove-DshosLegacyRuntimeTask
}

function Register-DshosRuntimeStartup {
  Save-DshosRuntimeManager
  Remove-DshosLegacyRuntimeTask
  New-Item -Path $RuntimeStartupKey -Force | Out-Null
  Set-ItemProperty `
    -LiteralPath $RuntimeStartupKey `
    -Name $RuntimeStartupName `
    -Value (Get-DshosRuntimeStartupCommand) `
    -Type String
}

function Start-DshosRuntimeProcess {
  Assert-DshosBalanceRuntimeReady
  if (Test-Path -LiteralPath $RuntimeListenerStatusPath) {
    Remove-Item -LiteralPath $RuntimeListenerStatusPath -Force -ErrorAction Stop
  }
  if (Test-Path -LiteralPath $RuntimeListenerStatusPath) {
    throw '无法清除上一次连接器监听状态；本次启动已安全停止。'
  }
  $windowsPowerShell = Get-DshosRuntimePowerShellPath
  return Start-Process `
    -FilePath $windowsPowerShell `
    -ArgumentList @(
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', $RuntimeManagerPath, '-Action', 'run'
    ) `
    -WindowStyle Hidden `
    -PassThru
}

function Start-DshosProfileProcess {
  param(
    [Parameter(Mandatory = $true)][string]$DshCommand,
    [Parameter(Mandatory = $true)][string]$ProfileName
  )

  return Start-Process `
    -FilePath $DshCommand `
    -ArgumentList @('--profile', $ProfileName, '--no-open') `
    -WindowStyle Hidden `
    -PassThru
}

function Read-DshosWebLaunch {
  param([string]$Path = $RuntimeWebLaunchPath)
  $encrypted = $null
  $plaintext = $null
  try {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf) -or
      (Get-Item -LiteralPath $Path).Length -gt 32768) { throw 'Unavailable' }
    $stored = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    if ($stored.version -ne 1 -or $stored.protectedLaunch -isnot [string]) { throw 'Unavailable' }
    $encrypted = [Convert]::FromBase64String($stored.protectedLaunch)
    Add-Type -AssemblyName System.Security
    $entropy = [Text.Encoding]::UTF8.GetBytes('DSHOS-LINK/WEB-LAUNCH/V1')
    $plaintext = [Security.Cryptography.ProtectedData]::Unprotect(
      $encrypted, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    if ($plaintext.Length -gt 8192) { throw 'Unavailable' }
    return ([Text.Encoding]::UTF8.GetString($plaintext) | ConvertFrom-Json)
  } catch {
    throw '当前 DSH 的网页登录入口尚未就绪，请确认后台状态；不会另开实例或自动重启。'
  } finally {
    if ($null -ne $encrypted) { [Array]::Clear($encrypted, 0, $encrypted.Length) }
    if ($null -ne $plaintext) { [Array]::Clear($plaintext, 0, $plaintext.Length) }
  }
}

function Get-DshosWebCommandEntry {
  param([string]$DshCommand)
  if ((Get-Item -LiteralPath $DshCommand).Length -gt 65536) { throw 'Unsupported DSH launcher' }
  $source = Get-Content -LiteralPath $DshCommand -Raw
  $directory = (Split-Path -Parent ([IO.Path]::GetFullPath($DshCommand))).TrimEnd('\') + '\'
  $entries = @([regex]::Matches($source, '"([^"\r\n]*@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js)"') | ForEach-Object {
    $path = $_.Groups[1].Value.Replace('%~dp0', $directory).Replace('%dp0%', $directory)
    if ($path.Contains('%') -or -not [IO.Path]::IsPathRooted($path)) { throw 'Unsupported DSH launcher' }
    [IO.Path]::GetFullPath($path)
  } | Select-Object -Unique)
  if ($entries.Count -ne 1 -or -not (Test-Path -LiteralPath $entries[0] -PathType Leaf)) { throw 'Unsupported DSH launcher' }
  return $entries[0]
}

function Test-DshosWebEntryOwner {
  param($Owner, $Configuration, $Managed, [object[]]$Processes)
  if ($null -eq $Owner -or $null -eq $Managed -or
    -not (Test-DshosExpectedWebProcess $Owner $Configuration.dshPath $Configuration.profile)) { return $false }
  if ([IO.Path]::GetExtension($Configuration.dshPath) -ieq '.exe') {
    return $Owner.ParentProcessId -eq $Managed.ProcessId
  }
  $wrapper = $Processes | Where-Object ProcessId -eq $Owner.ParentProcessId | Select-Object -First 1
  if ($null -eq $wrapper -or $wrapper.Name -ine 'cmd.exe' -or $wrapper.ParentProcessId -ne $Managed.ProcessId -or
    $wrapper.CommandLine -notmatch ('(?i)(?:^|\s|")' + [regex]::Escape($Configuration.dshPath) + '(?:"|\s|$)')) { return $false }
  if ($Owner.CommandLine -notmatch '^(?:"[^"]+"|\S+)\s+(?:"(?<entry>[^"]+)"|(?<entry>\S+))\s+') { return $false }
  $entry = [IO.Path]::GetFullPath($Matches['entry'])
  return $entry -ieq (Get-DshosWebCommandEntry $Configuration.dshPath)
}

function Get-DshosWebEntryOwner {
  param($Configuration, $Managed, [object[]]$Processes)
  $owners = @($Processes | Where-Object { Test-DshosWebEntryOwner $_ $Configuration $Managed $Processes })
  if ($owners.Count -ne 1) { throw '无法唯一确认原 DSH 网页进程；不会打开其他实例。' }
  return $owners[0]
}

function Assert-DshosWebLaunch {
  param($Record, $Configuration, $Owner, $Managed, [object[]]$Processes, [object[]]$Listeners)
  try {
    if ($Record.version -ne 1 -or $Record.url -isnot [string] -or
      $Record.url -notmatch '^http://127\.0\.0\.1:([1-9][0-9]{0,4})/(?:\?token=[A-Za-z0-9_-]{43})?$') { throw 'Invalid' }
    $port = [int]$Matches[1]
    if ($port -gt 65535 -or $null -eq $Owner -or $null -eq $Managed -or
      $Record.pid -ne $Owner.ProcessId -or
      -not (Test-DshosWebEntryOwner $Owner $Configuration $Managed $Processes)) { throw 'Invalid' }
    $profileRoot = [IO.Path]::GetFullPath((Join-Path $Configuration.dshHome ('profiles\' + $Configuration.profile)))
    if ([IO.Path]::GetFullPath([string]$Record.profileRoot).TrimEnd('\', '/') -ine $profileRoot.TrimEnd('\', '/')) { throw 'Invalid' }
    $created = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$Record.createdAt)
    if ($created -lt ([DateTimeOffset]$Owner.CreationDate) -or $created -gt [DateTimeOffset]::UtcNow.AddSeconds(1)) { throw 'Invalid' }
    if (@($Listeners | Where-Object {
      $_.OwningProcess -eq $Owner.ProcessId -and $_.LocalPort -eq $port -and $_.LocalAddress -in @('127.0.0.1', '0.0.0.0', '::')
    }).Count -eq 0) { throw 'Invalid' }
  } catch {
    throw '网页登录入口与当前 DSH 实例不匹配或已过期，已停止打开；不会修改端口或重启 DSH。'
  }
}

function Open-DshosManagedWeb {
  $configuration = Read-DshosRuntimeConfiguration
  $managed = Get-DshosManagedRuntimeProcess
  $processes = @(Get-CimInstance Win32_Process)
  $owner = Get-DshosWebEntryOwner $configuration $managed $processes
  $record = Read-DshosWebLaunch (Join-Path $RuntimeRoot ('web-launch-' + $owner.ProcessId + '.json'))
  $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop)
  Assert-DshosWebLaunch $record $configuration $owner $managed $processes $listeners
  try { Start-Process -FilePath $record.url | Out-Null }
  catch { throw '无法调用系统默认浏览器；DSH 后台实例未改变。' }
  Write-Host '已请求默认浏览器打开原 DSH 网页；完成官方验证后仍使用原网页地址。'
}

function Test-DshosManagedRuntimeProcess {
  param([Parameter(Mandatory = $true)]$Process)

  if ([string]$Process.Name -ine 'powershell.exe' -or $null -eq $Process.CommandLine) {
    return $false
  }
  return ([string]$Process.CommandLine).IndexOf(
    $RuntimeManagerPath,
    [System.StringComparison]::OrdinalIgnoreCase
  ) -ge 0 -and [string]$Process.CommandLine -match '(?i)(?:^|\s)-Action\s+run(?:\s|$)'
}

function Get-DshosManagedRuntimeProcess {
  $allProcesses = @(Get-CimInstance Win32_Process)
  if (Test-Path -LiteralPath $RuntimePidPath -PathType Leaf) {
    $pidText = (Get-Content -LiteralPath $RuntimePidPath -Raw).Trim()
    if ($pidText -match '^\d{1,10}$') {
      $savedProcess = $allProcesses | Where-Object { $_.ProcessId -eq [uint32]$pidText } | Select-Object -First 1
      if ($null -ne $savedProcess -and (Test-DshosManagedRuntimeProcess $savedProcess)) {
        return $savedProcess
      }
    }
    Remove-Item -LiteralPath $RuntimePidPath -Force -ErrorAction SilentlyContinue
  }

  $matches = @($allProcesses | Where-Object { Test-DshosManagedRuntimeProcess $_ })
  if ($matches.Count -gt 1) {
    throw '检测到多个 DSHOS Link 后台进程，已停止自动操作。'
  }
  if ($matches.Count -eq 1) {
    return $matches[0]
  }
  return $null
}

function Stop-DshosRuntimeProcess {
  $rootProcess = Get-DshosManagedRuntimeProcess
  if ($null -eq $rootProcess) {
    Remove-Item -LiteralPath $RuntimePidPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $RuntimeListenerStatusPath -Force -ErrorAction SilentlyContinue
    return
  }

  $allProcesses = @(Get-CimInstance Win32_Process)
  $selected = New-Object System.Collections.Generic.List[object]
  $queue = New-Object System.Collections.Generic.Queue[object]
  $queue.Enqueue([pscustomobject]@{ Id = [uint32]$rootProcess.ProcessId; Depth = 0 })
  while ($queue.Count -gt 0) {
    $item = $queue.Dequeue()
    $process = $allProcesses | Where-Object { $_.ProcessId -eq $item.Id } | Select-Object -First 1
    if ($null -ne $process) {
      $selected.Add([pscustomobject]@{ Process = $process; Depth = $item.Depth })
      @($allProcesses | Where-Object { $_.ParentProcessId -eq $item.Id }) | ForEach-Object {
        $queue.Enqueue([pscustomobject]@{ Id = [uint32]$_.ProcessId; Depth = ($item.Depth + 1) })
      }
    }
  }
  $selected | Sort-Object Depth -Descending | ForEach-Object {
    Stop-Process -Id ([int]$_.Process.ProcessId) -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $RuntimePidPath -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $RuntimeRoot -PathType Container) {
    Write-DshosRuntimeStatus 'stopped'
  }
  Remove-Item -LiteralPath $RuntimeListenerStatusPath -Force -ErrorAction SilentlyContinue
}

function Invoke-DshosRuntime {
  Assert-DshosBalanceRuntimeReady
  $runtimeMutex = [System.Threading.Mutex]::new($false, $RuntimeMutexName)
  $ownsRuntimeMutex = $false
  try {
    $configuration = $null
    try {
      $ownsRuntimeMutex = $runtimeMutex.WaitOne(0)
    } catch [System.Threading.AbandonedMutexException] {
      $ownsRuntimeMutex = $true
    }
    if (-not $ownsRuntimeMutex) { return }

    New-Item -ItemType Directory -Path $RuntimeRoot -Force | Out-Null
    Set-Content -LiteralPath $RuntimePidPath -Encoding Ascii -Value ([string]$PID)
    $runtimeExitCode = 1
    $failureStage = 'configuration'
    try {
      Write-DshosRuntimeStatus 'starting'
      $configuration = Read-DshosRuntimeConfiguration
      $instance = Resolve-DshosInstance ([string]$configuration.profile) ''
      # A failed upgrade can restore a schema-3 configuration. Use its proven
      # original profile root without rewriting that rollback configuration.
      $configuration | Add-Member -NotePropertyName dshHome -NotePropertyValue $instance.dshHome -Force
      $failureStage = 'existing_instance'
      Assert-DshosInstanceNotRunningElsewhere ([string]$configuration.dshPath) ([string]$configuration.profile)
      Set-DshosProcessEnvironment $configuration
      $failureStage = 'dsh_process'
      if (Test-Path -LiteralPath $RuntimeWebLaunchPath) {
        Remove-Item -LiteralPath $RuntimeWebLaunchPath -Force -ErrorAction Stop
      }
      Get-ChildItem -LiteralPath $RuntimeRoot -Filter 'web-launch-*.json' -File | Where-Object Name -match '^web-launch-[0-9]+\.json$' | ForEach-Object {
        Remove-Item -LiteralPath $_.FullName -Force -ErrorAction Stop
      }
      $dshProcess = Start-DshosProfileProcess `
        ([string]$configuration.dshPath) `
        ([string]$configuration.profile)
      Write-DshosRuntimeStatus 'running'
      $dshProcess.WaitForExit()
      $runtimeExitCode = [int]$dshProcess.ExitCode
      Write-DshosUnavailableListenerStatus $configuration
      if ($runtimeExitCode -ne 0) {
        throw "DSH 后台进程退出，错误码 $runtimeExitCode。"
      }
      Write-DshosRuntimeStatus 'stopped'
    } catch {
      if ($failureStage -eq 'dsh_process' -and $null -ne $configuration) {
        Write-DshosUnavailableListenerStatus $configuration
      }
      Write-DshosRuntimeStatus 'failed' $runtimeExitCode $failureStage
      throw
    } finally {
      if ((Test-Path -LiteralPath $RuntimePidPath -PathType Leaf) -and
        (Get-Content -LiteralPath $RuntimePidPath -Raw).Trim() -eq [string]$PID) {
        Remove-Item -LiteralPath $RuntimePidPath -Force -ErrorAction SilentlyContinue
      }
    }
  } finally {
    if ($ownsRuntimeMutex) { $runtimeMutex.ReleaseMutex() }
    $runtimeMutex.Dispose()
  }
}

function Remove-DshosRuntimeFiles {
  $resolvedRuntimeRoot = [System.IO.Path]::GetFullPath($RuntimeRoot)
  $expectedRuntimeRoot = [System.IO.Path]::GetFullPath(
    (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'DSHOSLink\Runtime')
  )
  if ($resolvedRuntimeRoot -ne $expectedRuntimeRoot) {
    throw '后台运行目录校验失败，已停止删除。'
  }
  if (Test-Path -LiteralPath $resolvedRuntimeRoot -PathType Container) {
    Remove-Item -LiteralPath $resolvedRuntimeRoot -Recurse -Force
  }
}

function Test-DshosConnectorLayer {
  param(
    [Parameter(Mandatory = $true)][string]$DshCommand,
    [Parameter(Mandatory = $true)][string]$ProfileName
  )

  $dump = Invoke-DshosCommand $DshCommand @('--profile', $ProfileName, '--dump-config')
  return $dump.Contains("name: '$ConnectorPackageName'") -or
    $dump.Contains("# == $ConnectorPackageName")
}

function Get-DshosInstalledConnectorVersion {
  param(
    [Parameter(Mandatory = $true)][string]$DshCommand,
    [Parameter(Mandatory = $true)][string]$ProfileName
  )

  return (Get-DshosBalanceProfile $DshCommand $ProfileName).connectorVersion
}

function Assert-DshosInstallPrerequisites {
  param([Parameter(Mandatory = $true)][string]$DshCommand)

  $nodeVersion = (Invoke-DshosCommand (Get-DshosCommandPath 'node') @('--version')).TrimStart('v')
  if (-not (Test-DshosSupportedNodeVersion $nodeVersion)) {
    throw "当前 Node.js 为 $nodeVersion；连接器要求 22.19.0 以上的 22.x，或 24.x 及以上版本。"
  }
  $dshVersion = Invoke-DshosCommand $DshCommand @('--version')
  Set-DshosBalanceCompatibility $dshVersion
}

function Invoke-DshosConnectorManager {
  if ($Action -eq 'run') { throw '本候选仅由官方 DSH 桌面版加载，不启动网页后台实例。' }
  if ($Profile.Length -eq 0) { $Profile = 'desktop' }
  if ($Action -in @('install', 'upgrade', 'open')) {
    if ($Profile.Length -eq 0) { $Profile = 'desktop' }
    if ($Profile -cne 'desktop') { throw '当前插件仅连接官方 DSH 桌面版；原网页版实例和数据保持不变。' }
  }
  if ($Profile -ceq 'desktop') {
    Invoke-DshosDesktopManager
    return
  }
  if ($ServiceEnvironment.Length -gt 0 -and $Action -notin @('install', 'upgrade')) {
    throw '仅安装或升级时可选择后台服务环境。'
  }
  if ($Action -eq 'run') {
    Invoke-DshosRuntime
    return
  }
  if ($Action -eq 'open') {
    if ($Profile.Length -gt 0 -or $DshHome.Length -gt 0 -or $DshPath.Length -gt 0) {
      throw 'open 只打开已保存的后台实例，不接受替代实例参数。'
    }
    Open-DshosManagedWeb
    return
  }

  $managerMutex = $null
  $previousDshHome = [Environment]::GetEnvironmentVariable('DSH_HOME', 'Process')
  if ($Action -ne 'status') {
    $managerMutex = Enter-DshosManagerMutex
  }
  try {
    $dshCommand = Resolve-DshosExecutablePath $DshPath -AllowSavedConfiguration
    $instance = Resolve-DshosInstance $Profile $DshHome
    if ($instance.profile -ceq 'desktop') {
      throw '检测到桌面配置。请在安装命令中明确加上 --profile desktop；不会改用网页实例。'
    }
    $Profile = $instance.profile
    [Environment]::SetEnvironmentVariable('DSH_HOME', $instance.dshHome, 'Process')

    if ($Action -eq 'status') {
      $dshVersion = Invoke-DshosCommand $dshCommand @('--version')
      $installed = Test-DshosConnectorLayer $dshCommand $Profile
      $installedVersion = Get-DshosInstalledConnectorVersion $dshCommand $Profile
      $managedRuntime = Get-DshosManagedRuntimeProcess
      Write-Host "DSH 版本：$dshVersion"
      $connectorStatusText = if (-not $installed) {
        '未安装'
      } elseif ($null -eq $installedVersion) {
        '配置存在，但无法确认安装包版本'
      } elseif ($installedVersion -eq $ConnectorVersion) {
        "已安装（实际版本 $installedVersion）"
      } else {
        "已安装（实际版本 $installedVersion；当前管理器版本 $ConnectorVersion）"
      }
      Write-Host ("连接器状态：{0}" -f $connectorStatusText)
      Write-Host ("登录后后台启动：{0}" -f (Get-DshosRuntimeStartupState))
      if (Test-Path -LiteralPath $RuntimeConfigPath -PathType Leaf) {
        $configuration = Read-DshosRuntimeConfiguration
        Write-Host ("局域网地址：{0}" -f $configuration.hostAddress)
        Write-Host ("DSH 启动文件：{0}" -f $configuration.dshPath)
      } else {
        Write-Host ("局域网地址：{0}" -f $([Environment]::GetEnvironmentVariable('DSHOS_LINK_HOST', 'User')))
      }
      if (Test-Path -LiteralPath $RuntimeStatusPath -PathType Leaf) {
        $runtimeStatus = Get-Content -LiteralPath $RuntimeStatusPath -Raw | ConvertFrom-Json
        if ($runtimeStatus.state -in @('starting', 'running') -and $null -eq $managedRuntime) {
          Write-Host ("后台进程状态：未运行（上次状态记录已过期，记录时间 {0}）" -f $runtimeStatus.updatedAt)
        } else {
          Write-Host ("后台进程状态：{0}（{1}）" -f $runtimeStatus.state, $runtimeStatus.updatedAt)
        }
        if ($runtimeStatus.state -eq 'failed' -and
          $runtimeStatus.PSObject.Properties.Name -contains 'failureStage') {
          $failureText = switch ([string]$runtimeStatus.failureStage) {
            'configuration' { '读取后台运行配置失败' }
            'existing_instance' { '原 DSH 配置仍在另一进程运行，请先关闭该实例后重试' }
            'dsh_process' { 'DSH 进程启动或运行失败' }
            default { '后台运行初始化失败' }
          }
          Write-Host ("后台启动诊断：{0}（错误码 {1}）" -f $failureText, $runtimeStatus.exitCode)
        }
      }
      if (Test-Path -LiteralPath $RuntimeListenerStatusPath -PathType Leaf) {
        try {
          $listenerStatus = Read-DshosListenerStatus
          $listenerStateText = switch ([string]$listenerStatus.state) {
            'READY' { '可用' }
            'PORT_CONFLICT' { '端口被占用，等待用户修复' }
            'NO_PRIVATE_ADDRESS' { '没有可用的局域网地址' }
            'DSH_UNAVAILABLE' { 'DSH 服务不可用' }
            'REPAIRING' { '正在修复端口' }
            'RESTART_REQUIRED' { '需要重启 DSH' }
            default { '启动失败' }
          }
          Write-Host ("连接器监听状态：{0}（HTTPS {1}；引导 {2}）" -f `
            $listenerStateText, $listenerStatus.port, $listenerStatus.bootstrapPort)
        } catch {
          Write-Host '连接器监听状态：记录无效，请重新启动 DSH。' -ForegroundColor Yellow
        }
      }
      return
    }

    Assert-DshosInstanceNotRunningElsewhere $dshCommand $Profile -AllowManagedRuntime
    if ($Action -eq 'uninstall') {
      Set-DshosBalanceCompatibility (Invoke-DshosCommand $dshCommand @('--version'))
      Stop-DshosRuntimeProcess
      Remove-DshosRuntimeStartup
      Enable-DshosPinnedPnpm | Out-Null
      Resume-DshosBalanceRecovery $dshCommand $Profile
      Restore-DshosOriginalBalanceProvider $dshCommand $Profile
      $manifest = Get-Content -LiteralPath (Get-DshosProfileManifestPath $Profile) -Raw -Encoding UTF8 | ConvertFrom-Json
      $dependencies = $manifest.PSObject.Properties['dependencies']
      if ($null -ne $dependencies -and $null -ne $dependencies.Value -and
        $null -ne $dependencies.Value.PSObject.Properties[$ConnectorPackageName]) {
        Invoke-DshosPluginCommand $dshCommand @('plugin', '--profile', $Profile, 'remove', $ConnectorPackageName) -ConnectorBundleChange remove
      }
      Remove-DshosConnectorEnvironment
      Remove-DshosRuntimeFiles
      Write-Host '连接器已卸载；已有配对数据保持不变，重新安装后仍可继续使用。' -ForegroundColor Green
      return
    }

    Assert-DshosInstallPrerequisites $dshCommand
    Enable-DshosPinnedPnpm | Out-Null
    $installTarget = Resolve-DshosInstallTarget $PackagePath $PackageSpec
    if ($PackageSpec.Length -eq 0) {
      $installTarget = Save-DshosReleasePackage (Get-Item -LiteralPath $installTarget)
    }
    $providerTarget = Save-DshosBalancePayload $PackagePath
    $hostIp = Resolve-DshosInstallHostAddress $HostAddress
    $selectedEnvironment = Resolve-DshosServiceEnvironment $ServiceEnvironment
    $wasInstalled = Test-DshosConnectorLayer $dshCommand $Profile
    $recoverPreviousRuntime = (Test-Path -LiteralPath $RuntimeConfigPath -PathType Leaf) -and
      (Get-DshosRuntimeStartupState) -eq '已注册'
    $previousConfiguration = if (Test-Path -LiteralPath $RuntimeConfigPath -PathType Leaf) {
      Read-DshosRuntimeConfiguration
    } else { $null }
    if ($null -ne $previousConfiguration -and $previousConfiguration.PSObject.Properties.Name -notcontains 'dshHome') {
      # Persist the verified original home before stopping or replacing anything.
      # Keep the old schema/version readable by the old manager, including if an
      # interruption occurs before its replacement. Provider rollback cannot erase it.
      $legacyConfiguration = Get-Content -LiteralPath $RuntimeConfigPath -Raw | ConvertFrom-Json
      $legacyConfiguration | Add-Member -NotePropertyName dshHome -NotePropertyValue $instance.dshHome
      Write-DshosRuntimeConfiguration $legacyConfiguration
      $previousConfiguration = Read-DshosRuntimeConfiguration
    }
    $configurationChanged = $false
    Stop-DshosRuntimeProcess

    $startedManagedRuntime = $false
    $balanceTransaction = $null
    try {
      # Existing login startup must also use the durable recovery guard.
      Save-DshosRuntimeManager
      $balanceTransaction = Install-DshosConnectorWithBalance $dshCommand $Profile $installTarget $providerTarget
      if (-not (Test-DshosConnectorLayer $dshCommand $Profile)) {
        throw '连接器已写入依赖，但 DSH 配置中没有找到连接器层。'
      }
      $installedVersion = Get-DshosInstalledConnectorVersion $dshCommand $Profile
      if ($installedVersion -ne $ConnectorVersion) {
        throw "DSH 实际加载的连接器版本为 $installedVersion，未达到要求的 $ConnectorVersion。"
      }
      Set-DshosConnectorEnvironment $hostIp
      $runtimeConfiguration = New-DshosRuntimeConfiguration $dshCommand $Profile $hostIp $selectedEnvironment $instance.dshHome
      Write-DshosRuntimeConfiguration $runtimeConfiguration
      $configurationChanged = $true
      Register-DshosRuntimeStartup
      $listenerStatusNotBefore = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      $managedRuntimeProcess = Start-DshosRuntimeProcess
      $startedManagedRuntime = $true
      $listenerStatus = Wait-DshosListenerStatus `
        $ListenerReadinessTimeoutMilliseconds `
        $RuntimeListenerStatusPath `
        $listenerStatusNotBefore `
        ([int]$managedRuntimeProcess.Id)
      if ([string]$listenerStatus.state -ne 'READY') {
        $stateText = switch ([string]$listenerStatus.state) {
          'PORT_CONFLICT' { '端口被其他程序占用' }
          'NO_PRIVATE_ADDRESS' { '没有可用的局域网地址' }
          'DSH_UNAVAILABLE' { '原 DSH 尚未就绪，请检查原网页端口和运行状态后重试' }
          'RESTART_REQUIRED' { '需要重启 DSH' }
          default { '连接器监听启动失败' }
        }
        throw ('连接器文件已更新，但尚未完成：{0}。请打开 DSH 的“设置 → 插件 → DSHOS Link”按页面提示处理。' -f $stateText)
      }
      if ($PackageSpec.Length -eq 0) {
        $readyPackageUpdate = Update-DshosReadyPackageState $installTarget
        if ([bool]$readyPackageUpdate.pruningAllowed) {
          Remove-DshosStaleReleasePackages `
            $installTarget `
            ([string]$readyPackageUpdate.state.previousHash)
        }
      }
      $completedAction = if ($wasInstalled -or $Action -eq 'upgrade') { '升级' } else { '安装' }
      Write-Host "连接器 $ConnectorVersion 已$completedAction。" -ForegroundColor Green
      Write-Host "局域网地址：$hostIp"
      Write-Host 'DSHOS Link 已在后台启动，并会在以后每次登录 Windows 后自动恢复。'
      Write-Host '打开原 DSH 网页：npx --yes @dshos-link/connector@latest open'
      Write-Host '请打开 DSH 的“设置 → 插件 → DSHOS Link”检查配对状态。'
    } catch {
      $originalException = $_.Exception
      $recoveryFailures = @()
      if ($null -ne $balanceTransaction) {
        try {
          if ($startedManagedRuntime) { Stop-DshosRuntimeProcess; $startedManagedRuntime = $false }
          Restore-DshosBalanceTransaction $balanceTransaction $dshCommand $Profile
        } catch { $recoveryFailures += '进程或依赖恢复' }
      }
      if ($configurationChanged -and $null -ne $previousConfiguration) {
        try { Write-DshosRuntimeConfiguration $previousConfiguration }
        catch { $recoveryFailures += '原运行配置恢复' }
      }
      if ($recoveryFailures.Count -gt 0) {
        $recoveryException = [InvalidOperationException]::new(
          ('升级失败，自动恢复未完成：{0}。未自动重新启动，请先恢复原依赖和运行配置。' -f ($recoveryFailures -join '、')))
        $recoveryException.Data['DshosRollbackFailed'] = $true
        throw $recoveryException
      }
      if (-not $startedManagedRuntime -and $recoverPreviousRuntime -and
        -not $originalException.Data.Contains('DshosRollbackFailed')) {
        try { Start-DshosRuntimeProcess | Out-Null } catch { }
      }
      throw $originalException
    }
  } finally {
    [Environment]::SetEnvironmentVariable('DSH_HOME', $previousDshHome, 'Process')
    if ($null -ne $managerMutex) {
      Exit-DshosManagerMutex $managerMutex
    }
  }
}

if ($MyInvocation.InvocationName -ne '.') {
  try {
    Invoke-DshosConnectorManager
  } catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
  }
}
