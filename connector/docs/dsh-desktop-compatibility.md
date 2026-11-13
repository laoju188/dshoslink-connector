# DeepSeek Harness 桌面兼容

连接器 **0.2.15** 新增对官方 Windows 版 **DeepSeek Harness 0.2.2-rc.2** 的适配。本次验证了 `0.2.2-rc.1` 的页面内更新，以及 `0.2.2-rc.2` 的完整安装与升级。安装前可在 DSH 的「应用 → 关于」核对宿主版本，安装后在「插件 → DSHOS Link」核对连接器版本。 [DSH 0.2.2-rc.2 官方发行说明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.2)

| 电脑当前组合 | 如何更新 |
| --- | --- |
| DSH `0.2.2-rc.1` + 连接器 `0.2.14` | 插件页显示可用的更新按钮时，可从页面更新。也可以退出 DSH 后用命令行升级。 |
| DSH `0.2.2-rc.2` + 连接器 `0.2.14` | 完全退出 DSH 后，用命令行升级连接器和余额组件。 |
| DSH `0.2.2-rc.2` + 连接器 `0.2.15` | 可继续使用，余额组件按当前 DSH 版本安装。 |

`0.2.15` 可搭配华为应用市场手机版 `1.1.0` 使用。手机版 `1.1.1` 需要 API 26 或更高版本。

[Windows 安装与配对](windows-installation.md) · [页面内更新说明](one-click-upgrade.md)
