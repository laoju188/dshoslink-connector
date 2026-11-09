# 构建 Windows 连接器

在 `connector` 目录使用 Node.js 24 与 pnpm 11.7.0。

```powershell
corepack pnpm@11.7.0 install --frozen-lockfile --ignore-scripts
corepack pnpm@11.7.0 build
```

构建生成 `dist` 和本地更新助手资源。要制作含余额组件的完整 Windows 安装包，还需要每个支持版本的官方 DSH provider 包。使用 [版本及摘要基线](../../patches/dsh-deepseek-balance/) 核对输入，在独立目录解包，再按 [Windows 发行构建脚本](../scripts/windows/Build-WindowsRelease.ps1) 的参数传入各 provider 目录。构建脚本校验对应版本和源码摘要，生成本地安装包及 SHA-256 清单。

日常开发使用 `corepack pnpm@11.7.0 test`。这些测试使用连接器本地代码或模拟对象，实际 DSH 安装、手机与服务联调另行验证。
