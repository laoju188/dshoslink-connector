# Windows 连接器变更日志

本页按插件版本倒序记录。手机当前正式版见 [首页兼容表](README.md#版本与兼容性)，历史条目不作为当前手机版兼容基线。

## 0.2.19

2026-11-19 已在 npm 发布；2026-11-25 同步公开源码。[npm 0.2.19](https://www.npmjs.com/package/@dshos-link/connector/v/0.2.19)

- 支持官方 Windows **DSH 0.2.2-rc.5**，适配事件连接、余额组件与升级助手。[官方发行说明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.5)
- 升级助手更新为 **0.1.6**，支持从 0.2.16 分发的 0.1.5 助手迁移，保留升级记录与本地改动保护。
- 修复 DeepSeek 账号余额的精度合计与显示；负余额按分位取整，读取失败不伪造金额。
- 桌面宿主升级后，连接器与余额组件给出与当前桌面版本匹配的恢复指引。
- 当前手机兼容基线为已获审 **1.1.2/build192**；1.1.1/build187 为历史兼容与升级起点。本次为桌面插件专项发行，手机与服务沿用原版本。
- 1.1.2 同版原测试签名包与 0.2.19、原服务的配对、LAN 收发、余额、重开原绑定已有真机验证；无旧绑定的首次配对在发行时经负责人批准免测，未列入本轮结果。Pro 恢复复用未受影响的历史真机证据，本次没有重做最终组合的物理跨网测试。

源码构建使用本仓库的 MIT 许可；npm 正式发行包附有对应的 Connector Use License。公开源码不包含手机端和服务器端实现。

## 0.2.16

2026-11-16 已在 npm 发布，并同步公开源码。[npm 0.2.16](https://www.npmjs.com/package/@dshos-link/connector/v/0.2.16)

- 支持官方 Windows **DSH 0.2.2-rc.3**，适配事件连接和对应版本的余额组件。[官方发行说明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.3)
- 升级助手更新为 **0.1.5**，加入 npm 0.2.15 所带 0.1.4 助手的迁移识别，保留升级记录与本地改动保护。
- 当前手机兼容基线为已获审 **1.1.1/build187**。手机 **1.1.2/build192** 尚在审核；不需要等手机审核通过才更新插件。
- 1.1.1 同版原测试签名包与新插件、新服务的配对、LAN 收发、余额、重开原绑定已有真机验证。Pro 恢复复用未受影响的历史真机证据，本次没有重做最终组合的物理跨网测试。

源码构建使用本仓库的 MIT 许可；npm 正式发行包附有对应的 Connector Use License。公开源码不包含手机端和服务器端实现。

## 0.2.15

已在 npm 发布。源码构建和用户安装分别见仓库说明。 [npm 0.2.15](https://www.npmjs.com/package/@dshos-link/connector/v/0.2.15) · [Windows 安装与配对](connector/docs/windows-installation.md) · [源码构建](connector/docs/building-windows-package.md)

- 支持官方 Windows 版 DSH `0.2.2-rc.2`，适配新版事件连接和消息队列，配套更新账户余额与 API Key 余额组件。 [DSH 官方发行说明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.2)
- 待发消息在授权失效时保留原文，重新取得授权后可以继续。提交结果未知的消息保留原状态，避免重复发送。
- DSH 重开或局域网地址变化后，恢复手机访问时会重新检查可用地址，沿用原配对。
- 优化完成记录与已读回执的处理，细化配对资料保存、读取失败时的诊断。
- 内置升级助手更新为 `0.1.4`，改进旧助手迁移和升级失败后的恢复。

已在用 DSH `0.2.2-rc.2` 且连接器仍为 `0.2.14` 时，先保存工作并完全退出 DSH，再在 PowerShell 运行以下命令。更新完成后重新打开 DSH，原配对可以继续使用。 [版本兼容和升级路径](connector/docs/dsh-desktop-compatibility.md)

```powershell
npx --yes @dshos-link/connector@latest upgrade
```

当时的兼容验收使用手机版 `1.1.0`。旧版手机在未读记录积累较多时可能暂时无法同步提醒或角标，聊天可继续使用。该项手机端修复随 `1.1.1` 提供，新版需要 API 26 或更高版本。

## 0.2.14

- 支持 DSH `0.2.2-rc.1`，配套余额组件按实际桌面版本选择。
- 内置升级助手 `0.1.3`，提供安装、升级和恢复支持。
- 公开包全新安装、从 `0.2.13` 升级均通过隔离验证，合成配对、会话及设置保持；隔离结果不等同于真实用户设备升级。

[npm 0.2.14](https://www.npmjs.com/package/@dshos-link/connector/v/0.2.14)

## 0.2.13

历史正式发行版，内置升级助手 0.1.2。可查看 [npm 0.2.13](https://www.npmjs.com/package/@dshos-link/connector/v/0.2.13) 的版本资料。

## 0.2.12

历史正式发行版，内置升级助手 0.1.2。可查看 [npm 0.2.12](https://www.npmjs.com/package/@dshos-link/connector/v/0.2.12) 的版本资料。

更早版本见 [npm 版本列表](https://www.npmjs.com/package/@dshos-link/connector?activeTab=versions)。历史包用于版本追溯，日常安装请使用最新版。
