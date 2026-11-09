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

- Windows：NSIS installer（`foxnio-Setup-<version>-win-x64.exe`）和 portable executable（`foxnio-<version>-win-x64-portable.exe`）。两者使用不同的 `artifactName` 模式，因为 electron-builder 会让所有 target 回退到全局模式，导致二者互相覆盖，`latest.yml` 也只描述最后写入的那个；
- macOS：DMG 和 ZIP；
- Linux：AppImage 和 Debian package。

构建过程会从 `OMP_WEB_NODE_BIN`，或执行 `desktop:prepare-runtime` 时正在使用的 Node.js，复制一个独立的 Node.js executable。Electron 主进程**不会**直接运行 `bin/omp-web.js`；launcher 会明确选择这个 Node.js `>=24` runtime。找不到符合版本要求的 runtime 时，构建会失败。

第一版桌面包故意不内置 `omp`。这样可以将 provider credentials、Agent 原生发行、平台二进制和版本策略与 foxnio 分开。若图形界面启动时找不到 PATH 中的 `omp`，请在启动桌面应用前设置 `OMP_WEB_OMP_BIN`。

安装包不包含测试文件（`*.test.*`）。

Chromium 只保留 UI 实际提供的语言包（`en-US`、`ja`、`zh-CN`），而不是全部 55 个。`.next` 已经编译进静态 bundle 的包源码（`mermaid`、`katex`、`lucide-react`、`@base-ui`、`react-syntax-highlighter`、`cytoscape`、`es-toolkit` 等）和仅构建期使用的 SWC 二进制也被排除：服务端运行时真正加载的恰好是 `.next/server/**/*.nft.json` 列出的 external 模块，而 `bin/omp-web.js` 用 `--experimental-next-config-strip-types` 启动 Next，由 Node ≥24 自己剥离 `next.config.ts` 的类型，不需要加载 SWC。去掉这个参数后，缺少 `@next/swc-*` 的包会在首次启动时把它下载到 `~/.cache/next-swc`，离线环境下直接失败——改动服务启动方式时务必保留该参数。Linux x64 的 AppImage 从 194 MB 降到 148 MB，解包后的应用从 758 MB 降到 554 MB。

## 运行时行为

- 应用会在 `127.0.0.1:30177` 启动自己的本地服务。固定端口可以让浏览器存储（界面偏好）保持在同一个 origin。该端口被占用（例如被 CLI 或服务实例占用）时，应用改用下一个空闲端口（最多到 30196）并写入日志。通过 `OMP_WEB_DESKTOP_PORT`（或 `PORT`）指定的端口按原样使用，被占用时应用拒绝启动。如果服务进程在响应之前退出，应用会报错退出，而不会连接到该端口上的其他服务。
- 应用内更新器已禁用（服务环境中设置 `OMP_WEB_DISABLE_AUTOUPDATE=1`），因为它会停止桌面应用持有的服务进程。请安装新的安装包来更新。
- 离开应用的链接只有 `http:`、`https:` 和 `mailto:` 会交给默认浏览器或邮件客户端，其他 scheme（例如 `file:`）会被忽略。

## 目标平台与 CI

当前 CI 配置的首发目标为 Windows x64、macOS x64/arm64 和 Linux x64。只有配置对应的原生 runner 后才增加 Windows/Linux arm64；本打包流程要求 bundled Node.js runtime 与安装包在相同主机和架构上构建。

每个目标都应在匹配的 GitHub Actions runner 上构建。不能把 Linux Node binary 复制进 Windows 或 macOS installer，也不能跨系统复用 `node_modules`：`sharp` 是 native dependency，必须在目标构建 runner 上安装。仓库暂未配置代码签名和 notarization，因此安装包是未签名的（Windows SmartScreen 会警告；macOS 请右键点击 **打开**，或执行 `xattr -dr com.apple.quarantine /Applications/foxnio.app`）。面向更多用户发布前，需要在 CI 中注入各平台签名凭据。

桌面 workflow 只把安装包、blockmap 和更新元数据（不含 `*-unpacked` 构建目录）作为 workflow artifact 上传，保留 7 天。在 `v*` tag 上，由独立的 `release` job（唯一拥有 `contents: write` 的 job）把它们附加到 GitHub Release。macOS 不上传 `latest-mac.yml`：arm64 和 x64 构建会写出同名文件，而且应用没有使用它的自动更新组件。与 package workflow 的配合见 [`release.md`](./release.md)。

## 移动端边界

Android 和 iOS 使用现有的 authenticated PWA 作为远程客户端，通过 HTTPS 连接运行在桌面或服务器上的 foxnio。移动端不会运行 Node.js、`omp`、git 或本地 workspace。未来可以把 PWA 包装成 Play Store/App Store 应用，但除非另行设计并分发移动端 Agent runtime，否则它仍然是远程客户端。
