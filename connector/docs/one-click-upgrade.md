# 连接器更新

在 DSH 的「插件 → DSHOS Link」查看连接器版本和更新提示。页面显示更新按钮，且当前 DSH 和升级助手支持时，可以从页面更新。开始前请先保存工作，并等电脑上的任务完成。

连接器 `0.2.15` 随包提供升级助手 `0.1.4`。如果已经把 DSH 升到 `0.2.2-rc.2`，连接器仍是 `0.2.14`，请完全退出 DSH，在 PowerShell 运行以下命令，让安装工具同时更新连接器和对应的余额组件。

```powershell
npx --yes @dshos-link/connector@latest upgrade
```

更新后重新打开 DSH，在插件页核对连接器版本，再从手机打开原会话检查连接。原绑定可以继续使用。

从本仓库自行构建的版本，请保留原来的完整安装包供回退。页面内更新会核对当前安装来源和回退包，支持条件以插件提示为准。

[Windows 安装与配对](windows-installation.md) · [DSH 桌面端兼容说明](dsh-desktop-compatibility.md)
