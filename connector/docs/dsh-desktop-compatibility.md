# DeepSeek Harness 桌面兼容

连接器 **0.2.16** 支持官方 Windows **DSH 0.2.2-rc.3**，同步适配事件连接、余额组件与升级助手。安装前在 DSH 的「应用 → 关于」核对宿主版本，安装后在「插件 → DSHOS Link」核对连接器版本。[官方发行说明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.3)

| 电脑当前组合 | 如何更新 |
| --- | --- |
| DSH 0.2.2-rc.3 + 旧连接器 | 保存工作、完全退出 DSH，用命令行升级，同时更新连接器和对应余额组件。 |
| DSH 0.2.2-rc.3 + 连接器 0.2.16 | 可继续使用；在插件页核对版本及连接状态。 |
| 其他已识别的 DSH 版本 | 完整名单见包内 `dshosUpgrade.hosts`。页面内升级还需要宿主接口、升级助手及空闲检查通过；识别宿主不等于支持页面内升级。 |

```powershell
npx --yes @dshos-link/connector@latest upgrade
```

当前已获审手机版兼容基线是 **1.1.1/build187**；原送审同版测试签名包已验证新插件和新服务的配对、LAN 收发、余额、重开原绑定。**1.1.2/build192 已提交审核，尚未确认通过**。187→192 同测试签名覆盖已验证保留绑定和数据，不冒充华为市场升级结果。新版获审后再更新兼容基线。

Pro 原绑定跨网和恢复复用未受影响的历史真机证据，最终组合本轮未重新进行物理跨网测试。rc.3 的历史会话导入由 DSH 提供，本插件未新增导入入口。

[Windows 安装与配对](windows-installation.md) · [页面内更新说明](one-click-upgrade.md)
