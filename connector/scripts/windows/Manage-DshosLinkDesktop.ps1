# Desktop owns its host, profile packages and lifecycle. Never register the Web launcher here.
function Resolve-DshosDesktopInstallation {
  param([string]$RequestedCommand)
  if ($RequestedCommand.Length -gt 0) {
    $command = Assert-DshosExecutablePath $RequestedCommand
    $root = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $command) '..\..\..\..'))
  } else {
    $installed = @(Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue | Where-Object {
      $null -ne $_.PSObject.Properties['DisplayName'] -and $_.DisplayName -ceq 'DeepSeek Harness' -and
      $null -ne $_.PSObject.Properties['InstallLocation'] -and [IO.Path]::IsPathRooted([string]$_.InstallLocation)
    } | Select-Object -ExpandProperty InstallLocation -Unique)
    if ($installed.Count -ne 1) { throw '无法唯一确定官方 DSH 桌面版，请用 --dsh-path 指定桌面版 resources/runtime/cli/bin/dsh.cmd。' }
    $root = [IO.Path]::GetFullPath([string]$installed[0])
    $command = Join-Path $root 'resources\runtime\cli\bin\dsh.cmd'
  }
  $expected = Join-Path $root 'resources\runtime\cli\bin\dsh.cmd'
  $application = Join-Path $root 'DeepSeek Harness.exe'
  if ($command -ine $expected -or -not (Test-Path -LiteralPath $application -PathType Leaf) -or
    -not (Test-Path -LiteralPath $command -PathType Leaf) -or
    -not (Test-Path -LiteralPath (Join-Path $root 'resources\app.asar') -PathType Leaf)) {
    throw '必须使用官方桌面版自带的 dsh.cmd；不会用 npm DSH 修改或启动 desktop 配置。'
  }
  return [pscustomobject]@{root=$root;command=$command;application=$application}
}

function Assert-DshosDesktopStopped {
  param([string]$Application)
  $processes = @(Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" -ErrorAction Stop)
  foreach ($process in $processes) {
    if ([string]::IsNullOrEmpty([string]$process.ExecutablePath) -or
      [IO.Path]::GetFullPath([string]$process.ExecutablePath) -ieq $Application) {
      throw '请先从 DSH 桌面版的应用菜单或托盘选择退出，再安装、升级或卸载插件；关闭窗口仍可能在后台运行。'
    }
  }
}

function Install-DshosDesktopConnector {
  param([string]$DshCommand, [string]$Application, [string]$ConnectorTarget, [string]$ProviderTarget)
  for ($attempt = 0; $attempt -lt 2; $attempt++) {
    try {
      return Install-DshosConnectorWithBalance $DshCommand 'desktop' $ConnectorTarget $ProviderTarget
    } catch {
      $failure = $_.Exception
      if ($failure.Data['DshosRollbackFailed'] -eq $true) { throw }
      if ($failure.Data['DshosInstallRollbackComplete'] -ne $true) { throw }
      if ($attempt -eq 0 -and $failure.Data['DshosPackageProcessCrash'] -eq $true) {
        Assert-DshosDesktopStopped $Application
        Write-Host '安装进程意外退出，原配置已恢复。正在自动重试一次，请稍候。'
        continue
      }
      $reported = [InvalidOperationException]::new('此次插件安装未完成，已恢复原来的 DSH，可以继续使用。稍后运行同一条安装命令即可重试。', $failure)
      foreach ($key in $failure.Data.Keys) { $reported.Data[$key] = $failure.Data[$key] }
      throw $reported
    }
  }
}

function Invoke-DshosDesktopManager {
  if ($Action -eq 'run') { throw 'DSH 桌面版由官方应用启动，不运行网页版后台进程。' }
  if ($ServiceEnvironment.Length -gt 0 -or $HostAddress.Length -gt 0) {
    throw '桌面版使用宿主环境及插件内的连接设置，不通过网页版安装器写入全局环境。'
  }
  $installation = Resolve-DshosDesktopInstallation $DshPath
  $previousHome = [Environment]::GetEnvironmentVariable('DSH_HOME', 'Process')
  $desktopMutex = $null
  try {
    $homePath = Resolve-DshosHomePath $DshHome
    $profileRoot = Join-Path $homePath 'profiles\desktop'
    $manifestPath = Join-Path $profileRoot 'package.json'
    [Environment]::SetEnvironmentVariable('DSH_HOME', $homePath, 'Process')
    # Scope recovery from the original directory, not from a potentially
    # truncated current manifest. Keep the ordinary host/lifecycle gates first.
    $RuntimeRoot = Join-Path $profileRoot '.dshos-link\desktop-installer'
    $RuntimePackageRoot = Join-Path $RuntimeRoot 'packages'
    $command = [string]$installation.command
    if ($Action -notin @('open', 'status') -and
      (Test-Path -LiteralPath (Join-Path $RuntimeRoot 'balance-recovery-required.json'))) {
      $desktopMutex = Enter-DshosManagerMutex
      Assert-DshosDesktopStopped $installation.application
      Set-DshosBalanceCompatibility (Invoke-DshosCommand $command @('--version'))
      Resume-DshosBalanceRecovery $command 'desktop'
    }
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
      throw '请先打开一次官方 DSH 桌面版完成初始化；不会创建新的空 desktop 配置。'
    }
    try { $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json }
    catch { throw 'DSH 桌面配置无法读取，已保留原资料并停止安装。请联系支持，不要删除会话或配对后重装。' }
    if ($null -eq $manifest -or $null -eq $manifest.PSObject.Properties['name'] -or
      $manifest.name -cne 'dsh-profile-desktop' -or $null -eq $manifest.PSObject.Properties['dsh'] -or
      $null -eq $manifest.dsh -or $null -eq $manifest.dsh.PSObject.Properties['profile'] -or
      $null -eq $manifest.dsh.profile -or $null -eq $manifest.dsh.profile.PSObject.Properties['bundles'] -or
      $manifest.dsh.profile.bundles -isnot [Array]) {
      throw 'DSH 桌面配置不完整，已保留原资料并停止安装。请联系支持，不要删除会话或配对后重装。'
    }
    if ($Action -eq 'open') {
      Assert-DshosBalanceRuntimeReady
      Start-Process -FilePath $installation.application | Out-Null
      return
    }
    if ($Action -eq 'status') {
      $status = Get-DshosBalanceProfile $command 'desktop'
      Write-Host ('DSH 桌面版：' + (Invoke-DshosCommand $command @('--version')))
      Write-Host ('插件版本：' + [string]$status.connectorVersion)
      Write-Host '桌面宿主由官方应用管理；本插件不另开网页版实例。'
      return
    }
    if ($null -eq $desktopMutex) {
      $desktopMutex = Enter-DshosManagerMutex
      Assert-DshosDesktopStopped $installation.application
      Set-DshosBalanceCompatibility (Invoke-DshosCommand $command @('--version'))
    }
    Resume-DshosBalanceRecovery $command 'desktop'
    if ($Action -eq 'uninstall') {
      Restore-DshosOriginalBalanceProvider $command 'desktop'
      $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($null -ne $manifest.dependencies.PSObject.Properties[$ConnectorPackageName]) {
        Invoke-DshosPluginCommand $command @('plugin','--profile','desktop','remove',$ConnectorPackageName) -ConnectorBundleChange remove
      }
      Write-Host '桌面版插件已卸载，原会话、配对记录和其他插件保留。'
      return
    }
    Write-Host '配对诊断默认开启，仅上传配对进度、错误类别和插件版本，不含聊天内容或文件。'
    Write-Host '可在 DSH 左侧“插件 → DSHOS Link”关闭“帮助改进配对体验”；已有的关闭选择在升级后保留。'
    $target = Resolve-DshosInstallTarget $PackagePath $PackageSpec
    if ($PackageSpec.Length -eq 0) { $target = Save-DshosReleasePackage (Get-Item -LiteralPath $target) $RuntimePackageRoot }
    $provider = Save-DshosBalancePayload $PackagePath
    $transaction = Install-DshosDesktopConnector $command $installation.application $target $provider
    try {
      $installed = Get-DshosBalanceProfile $command 'desktop'
      $selected = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($installed.connectorVersion -cne $ConnectorVersion -or $selected.dsh.profile.bundles -cnotcontains $ConnectorPackageName) {
        Write-DshosInstallDiagnostic 'install' 'failed' 'verification' 0 0
        throw '桌面版插件包或启用记录未达到候选要求。'
      }
    } catch {
      $failure = $_
      Restore-DshosBalanceTransaction $transaction $command 'desktop'
      throw $failure
    }
    Write-DshosInstallDiagnostic 'install' 'ok' 'none' 0 0
    Write-Host ('桌面版插件 ' + $ConnectorVersion + ' 已安装。请打开原 DSH 桌面版，在左侧“插件 → DSHOS Link”开始配对。')
  } finally {
    [Environment]::SetEnvironmentVariable('DSH_HOME', $previousHome, 'Process')
    if ($null -ne $desktopMutex) { Exit-DshosManagerMutex $desktopMutex }
  }
}
