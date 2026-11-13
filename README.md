# DSHOS Link

**离开电脑，也能在鸿蒙手机上继续 DeepSeek Harness 的工作。**

DSHOS Link 把鸿蒙手机和 Windows 上的 DSH 桌面端连起来。任务继续在电脑上运行，你可以用手机接着聊、补资料、看结果。

## 本次更新

**Windows 连接器 0.2.15 已发布。** 新增对官方 Windows 版 DSH **0.2.2-rc.2** 的支持，适配新版消息队列和余额组件，改进断网后恢复手机访问、待发消息恢复和插件升级。已经把 DSH 升到 `0.2.2-rc.2`、仍在用插件 `0.2.14` 的用户，请完全退出 DSH 后按下方步骤更新。 [连接器变更日志](CHANGELOG.md) · [npm 发行包](https://www.npmjs.com/package/@dshos-link/connector/v/0.2.15) · [DSH 0.2.2-rc.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.2)

**鸿蒙 App 1.1.1 已提交华为应用市场审核。** 市场版 **1.1.0** 可以继续搭配连接器 0.2.15 使用。新版 App 需要 **API 26 或更高版本**。

- **胖肥鱼桌面卡片**可以查看电脑任务状态和新回复。开启相应通知后，任务完成时可播放庆祝动画。点提示可打开原会话，读完后同步未读角标。
- **会话与通知**修复了未读回复较多时的同步问题，改善了连续完成提醒、切换会话和消息发送状态。
- **界面**优化了日夜主题下的弹层、菜单和模型选择，并改善横屏显示。

## 什么时候用得上

- **在家或办公室，离开座位也能跟进。** 手机和电脑在同一局域网时，可以免费直连，打开原来的会话，看看任务做到哪了，也可以接着追问。
- **临时想到一个需求，随手发给电脑。** 手机上可以新建会话、选择模型和调整思考强度。需要说明问题时，可以拍照、发图片或文件，也可以把语音转成文字再发送。
- **通勤或出差，手头的事接着做。** 开通 Pro 后，手机和电脑在不同网络时，也能通过端到端加密连接继续原来的会话。使用时请保持电脑开机联网，DSH 桌面端和插件保持运行。
- **任务做完了，手机上就能看结果。** 开启通知后，回复完成时手机会提醒你，应用图标会显示未读数量。打开会话就能看图片、复制有用的文字，或者播放电脑端 Bot 或 Agent 发来的语音。

手机版 **1.1.0** 支持引用回复、查看 GIF 动图和在局域网内预览视频。聊天默认显示最终回答，想看过程时可以展开。

## 快速开始

1. **鸿蒙手机**在华为应用市场搜索 **DSHOS Link**，安装后用华为账号登录。也可以扫码，在打开的页面选择「华为应用市场」。 [打开鸿蒙下载页](https://dshoslink.cn/open)

   [![扫码打开 DSHOS Link 鸿蒙下载页](./assets/harmonyos-download-qr.png)](https://dshoslink.cn/open)

2. **Windows 电脑**先安装并打开一次 DeepSeek Harness 桌面端，并准备好 Node.js 22.19 及以上的 22.x 版本，或 Node.js 24 及以上版本。完全退出 DSH，在 PowerShell 运行以下命令，装好后重新打开 DSH。 [DeepSeek Harness 官方下载](https://www.deepseek.com/harness/)

   ```powershell
   npx --yes @dshos-link/connector@latest install
   ```

3. **连接两台设备**。在手机打开「配对 DSH」，把 8 位配对码填入电脑的「插件 → DSHOS Link」。点击「连接手机」后，回到手机核对并确认这台电脑。

### 已安装连接器

保存电脑上的工作并完全退出 DSH。在 PowerShell 运行以下命令，再重新打开 DSH。已配对用户可以继续使用原绑定。

```powershell
npx --yes @dshos-link/connector@latest upgrade
```

[Windows 安装与更新](connector/docs/windows-installation.md) · [DSH 桌面端兼容说明](connector/docs/dsh-desktop-compatibility.md) · [页面内更新说明](connector/docs/one-click-upgrade.md)

## 开源与贡献

我们把 **Windows 连接器**开源，是希望实际使用它的人也能参与改进。比如配对时哪一步容易卡住、哪条提示看不懂、从电脑切换到手机时哪里不顺手，都欢迎在 GitHub Issues 里说说你遇到的场景和希望怎么改。**有建议就可以提，会写代码的朋友也欢迎提交 PR。** [提交问题或建议](https://github.com/laoju188/dshoslink-connector/issues)

仓库提供连接器源码、构建脚本和测试。反馈问题时，请隐去配对码、账号信息和聊天内容。本仓库公开的连接器自有源码采用 MIT 许可。npm 安装包附带对应版本的《DSHOS Link Connector Use License》，第三方组件保留各自的许可。

[从源码构建](connector/docs/building-windows-package.md) · [MIT 许可](LICENSE) · [第三方许可](connector/THIRD_PARTY_NOTICES.md)
