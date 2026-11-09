# Windows 安装与配对

先在 Windows 上安装并打开一次 DeepSeek Harness 桌面端，准备好 Node.js。安装插件前正常退出 DSH。在 PowerShell 运行以下命令，再用原桌面入口打开 DSH。

```powershell
npx --yes @dshos-link/connector@latest install
```

在 DSH 左侧打开「插件 → DSHOS Link」。从手机「配对 DSH」取得 8 位码，在电脑提交后回手机确认电脑身份。电脑端保持 DSH 和连接器运行，手机端可用原会话发一条消息确认。

已有绑定可以先打开原会话核对。日常升级可用桌面插件的更新入口。手动升级时，正常退出 DSH 后运行 `npx --yes @dshos-link/connector@latest upgrade`，再重新打开 DSH。

[桌面兼容说明](dsh-desktop-compatibility.md) · [配对诊断说明](pairing-diagnostics.md) · [更新说明](one-click-upgrade.md)
