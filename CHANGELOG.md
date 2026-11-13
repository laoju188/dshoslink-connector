# Windows 连接器变更日志

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

华为应用市场手机版 `1.1.0` 可以搭配该连接器。旧版手机在未读记录积累较多时可能暂时无法同步提醒或角标，聊天可继续使用。该项手机端修复随 `1.1.1` 提供，新版需要 API 26 或更高版本。
