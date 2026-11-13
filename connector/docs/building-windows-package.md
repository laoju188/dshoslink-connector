# 构建 Windows 连接器

在 `connector` 目录使用 Node.js 24 与 pnpm 11.7.0。

```powershell
corepack pnpm@11.7.0 install --frozen-lockfile --ignore-scripts
corepack pnpm@11.7.0 build
```

构建生成 `dist` 和本地升级助手资源。可通过 `node scripts/verify-build-output.mjs` 核对生成结果，使用 `node scripts/write-third-party-notices.mjs --check` 核对第三方声明。

要制作含余额组件的完整 Windows 安装包，还需要各支持版本的官方 DSH provider 包。使用 [版本及摘要基线](../../patches/dsh-deepseek-balance/) 核对输入，在独立目录解包，再按 [Windows 发行构建脚本](../scripts/windows/Build-WindowsRelease.ps1) 的参数传入各 provider 目录。`Dsh022Rc2ProviderPackageDirectory` 应指向 DSH `0.2.2-rc.2` 的 `@deepseek-ai/dsh-llm-deepseek` 目录。脚本校验版本和源码摘要，再生成本地安装包及 SHA-256 清单。自行构建的完整包应保留作对应安装的回退材料。日常安装请使用 [npm 安装步骤](windows-installation.md)。

## 测试

- `corepack pnpm@11.7.0 test` 构建插件并测试消息队列、完成记录、暂停访问后的网络恢复、安装版本与已有功能。测试使用本机代码和合成资料。
- `corepack pnpm@11.7.0 test:balance-manager` 在临时 Windows 配置目录检查余额组件选择及恢复。
- `corepack pnpm@11.7.0 test:provider-rc2` 使用官方 DSH `0.2.2-rc.2` 的本地 SDK。把 `DSH_BALANCE_TEST_PACKAGE` 设为该 SDK 内的 `@deepseek-ai/dsh-llm-deepseek` 包目录，保留其 `@deepseek-ai/dsh-llm-deepseek-api-key` 与 Cordis 依赖布局。测试使用合成余额响应。可用 `DSH_BALANCE_TEST_OUTPUT` 指定隔离输出目录。 [DSH 0.2.2-rc.2 官方发行说明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.2)

### 验证旧升级助手迁移

1. 在临时目录下载 npm 的固定 0.2.14 包，核对外包 SHA-256 为 `927e651e9115dadb99c63a49d086f3f0b3b2665e0b3b655ba498d2de4ca034da`。 [npm 0.2.14 包](https://registry.npmjs.org/@dshos-link/connector/-/connector-0.2.14.tgz)
2. 从外包提取 `package/dist/updater.tgz`，核对 SHA-256 为 `8d6ff68704e191a968769275bfc1d63a3a7365685cd6a77ca77ff3c5e7b13c19`，将 `DSHOS_UPGRADE_HELPER_FROM_0214` 指向该临时文件。
3. 完成构建后运行 `corepack pnpm@11.7.0 test:updater-migration`，检查 0.1.3 助手迁移、原记录保留和本地文件有改动时的保护。
