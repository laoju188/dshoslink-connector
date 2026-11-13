# Windows 安装与配对

本说明适用于从 npm 安装的 DSHOS Link 连接器 **0.2.15**。先在 Windows 上安装并打开一次官方 DeepSeek Harness 桌面端，再准备 Node.js 22.19 及以上的 22.x 版本，或 Node.js 24 及以上版本。 [DSH 桌面端兼容说明](dsh-desktop-compatibility.md)

## 首次安装

完全退出 DSH 后，在 PowerShell 运行以下命令，再用原桌面入口打开 DSH。

```powershell
npx --yes @dshos-link/connector@latest install
```

手机安装 DSHOS Link 并用华为账号登录。在 DSH 左侧打开「插件 → DSHOS Link」。从手机「配对 DSH」取得 8 位码，在电脑提交后回手机确认电脑身份。保持电脑开机联网、DSH 和连接器运行，再从手机打开原会话或新建会话确认连接。

免费版在同一局域网内使用，跨网连接需要 Pro。

## 升级已有连接器

先保存工作并完全退出 DSH。在 PowerShell 运行以下命令，再重新打开 DSH。

```powershell
npx --yes @dshos-link/connector@latest upgrade
```

如果已将 DSH 升到 `0.2.2-rc.2`，连接器仍是 `0.2.14`，请用上述命令一起更新连接器和对应的余额组件。重新打开 DSH 后，在「插件 → DSHOS Link」确认版本，再从手机打开原会话。原绑定可以继续使用。

[配对诊断说明](pairing-diagnostics.md) · [页面内更新说明](one-click-upgrade.md)
