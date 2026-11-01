# 桌面打包

foxnio 的桌面版是**现有本地服务的桌面启动器**，不是移动端 Agent 运行时，目前也不会把 `omp` 一起打进安装包。

## 本地构建

要求：

- Node.js `>= 24`，用于运行打包后的服务；
- 目标机器已安装 `omp` 并在 `PATH` 中，或设置 `OMP_WEB_OMP_BIN` 指向它；
- 使用与目标系统匹配的原生构建机，确保 `sharp` 和捆绑的 Node runtime 对应正确的平台与架构。

在与目标平台匹配的机器或 runner 上执行：

```bash
npm ci
npm run desktop:dist
```

产物位于 `dist-desktop/`：

- Windows：NSIS installer 和 portable executable；
- macOS：DMG 和 ZIP；
- Linux：AppImage 和 Debian package。

构建过程会从 `OMP_WEB_NODE_BIN`，或执行 `desktop:prepare-runtime` 时正在使用的 Node.js，复制一个独立的 Node.js executable。Electron 主进程**不会**直接运行 `bin/omp-web.js`；launcher 会明确选择这个 Node.js `>=24` runtime。找不到符合版本要求的 runtime 时，构建会失败。

第一版桌面包故意不内置 `omp`。这样可以将 provider credentials、Agent 原生发行、平台二进制和版本策略与 foxnio 分开。若图形界面启动时找不到 PATH 中的 `omp`，请在启动桌面应用前设置 `OMP_WEB_OMP_BIN`。

## 目标平台与 CI

当前 CI 配置的首发目标为 Windows x64、macOS x64/arm64 和 Linux x64。只有配置对应的原生 runner 后才增加 Windows/Linux arm64；本打包流程要求 bundled Node.js runtime 与安装包在相同主机和架构上构建。

每个目标都应在匹配的 GitHub Actions runner 上构建。不能把 Linux Node binary 复制进 Windows 或 macOS installer，也不能跨系统复用 `node_modules`：`sharp` 是 native dependency，必须在目标构建 runner 上安装。仓库暂未配置代码签名和 notarization；正式公开发布前，需要在 CI 中注入各平台签名凭据。

## 移动端边界

Android 和 iOS 使用现有的 authenticated PWA 作为远程客户端，通过 HTTPS 连接运行在桌面或服务器上的 foxnio。移动端不会运行 Node.js、`omp`、git 或本地 workspace。未来可以把 PWA 包装成 Play Store/App Store 应用，但除非另行设计并分发移动端 Agent runtime，否则它仍然是远程客户端。
