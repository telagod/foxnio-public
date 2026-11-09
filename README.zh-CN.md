# foxnio

[![Release](https://img.shields.io/github/v/release/telagod/foxnio-public?logo=github)](https://github.com/telagod/foxnio-public/releases/latest)
[![Verify](https://github.com/telagod/foxnio-public/actions/workflows/verify-pr.yml/badge.svg?branch=foxnio)](https://github.com/telagod/foxnio-public/actions/workflows/verify-pr.yml)
[![Node.js](https://img.shields.io/badge/node-%3E%3D24-44cc11?logo=node.js)](https://nodejs.org)
[![License: MIT](https://img.shields.io/github/license/telagod/foxnio-public?color=44cc11)](./LICENSE)

[English](./README.md) | [简体中文](./README.zh-CN.md) | [日本語](./README.ja.md)

foxnio 是 [oh-my-pi](https://github.com/can1357/oh-my-pi)（`omp`）编程智能体的浏览器工作区。它运行在 `omp` 所在的机器上，与 `omp` CLI 使用同一套会话和设置。你可以在桌面浏览器或手机上与智能体对话、查看它的改动并配置它。

foxnio 是 [kahme247/ompweb](https://github.com/kahme247/ompweb) 的 fork，专注于智能体定制。它沿用 ompweb 的 `OMP_WEB_*` 环境变量和数据文件，已有的 ompweb 配置可直接继续使用。

![foxnio：已完成的一轮折叠为摘要行，旁边是会话侧边栏和 Git 变更面板](docs/screenshot-light.png)

<details>
<summary>深色主题与手机布局</summary>

![foxnio 深色主题，展开了这一轮的各个步骤](docs/screenshot-dark.png)

![手机上的 foxnio](docs/screenshot-mobile.png)

</details>

## 功能特性

**与智能体对话**

- 流式回复，包含思考、工具调用及其实时输出，以及 token 和费用计数、上下文用量表和每秒 token 数。
- 已完成的一轮会折叠为最终回复上方的一行摘要（“已完成 7 个步骤 · 5 次工具调用 · 2m 41s”），展开即可查看每一步。
- 智能体工作时可以排队发送消息，把排队的消息转为引导，或停止运行并把排队的文本取回输入框。队列是 omp 自己的队列，因此每台设备看到的都一样。
- 编辑较早的消息以回退对话，从任意位置分叉出新会话，用 `/btw` 提一个旁支问题，用 `!` 运行 shell 命令。
- 斜杠命令、`Ctrl/Cmd+K` 命令面板、单词补全、语音输入和全屏输入框。未发送的草稿在重新加载后仍然保留。

**会话与工作区**

- 侧边栏按最近活跃排列工作区：有运行中、等待你处理或未读会话的工作区会自动展开，其余保持折叠；置顶会话在所有设备间共享。搜索覆盖标题和会话内容。
- 桌面端的会话标签页、归档与恢复、会话文件导入，以及可直接打开某个会话的链接（`?session=`）。
- 输入框上方的实时计划和子智能体面板，可查看每个子智能体的转录。
- 文件浏览器支持预览（代码、Markdown、Mermaid、图片、音频、PDF），另有带 diff 的 Git 变更面板，以及按项目管理的 Git worktree（[docs/worktrees.zh-CN.md](./docs/worktrees.zh-CN.md)）。

**配置智能体**

- omp 自身的设置（审批、模型与思考、顾问、记忆、压缩、重试）在浏览器中编辑，并保存到 omp 的 `config.yml`。
- 提供商与模型（`models.yml`）、模型角色、API 密钥与提供商登录、MCP 服务器、技能、插件和任务智能体。
- 工具预设，以及每个工作区的启动配置（omp profile 和额外的 `omp` 参数）。
- 用量仪表盘：按提供商、模型、项目和日期统计 token、费用和缓存节省。

**在每台设备上使用**

- 运行结束、失败或等待你回答时发送通知，包括通过 Web Push 推送到已关闭的浏览器或手机上的应用。
- 可作为应用安装（PWA）。在手机上，侧边栏和文件面板变为从屏幕边缘滑入的抽屉。
- 14 种配色主题（包括 Catppuccin、Dracula、Nord、Rosé Pine、Tokyo Night 和 omp.sh 午夜主题），文字大小和界面缩放可调，支持英语、简体中文和日本語。

## 环境要求

- [omp](https://github.com/can1357/oh-my-pi) 在 `PATH` 中，或通过 `OMP_WEB_OMP_BIN` 指定其路径。foxnio 针对 omp **18.16.0** 测试（见 [omp 兼容性](#omp-兼容性)）。更早的 omp 版本缺少部分功能所需的命令，例如队列面板、引导排队消息和完成通知。
- npm 包需要 Node.js 24 或更高版本。桌面应用自带 Node.js。

## 安装

### npm 包

foxnio 发布在 GitHub Packages，而不是 npmjs.com。GitHub 要求使用 access token 才能安装其中的任何包，Public 包也不例外，因此需要先配置一次：

1. 创建具有 `read:packages` 权限的 classic personal access token（GitHub → Settings → Developer settings → Personal access tokens (classic)）。
2. 将 `@telagod` scope 指向 GitHub Packages。`npm login` 会要求输入 GitHub 用户名，并把 token 当作密码：

   ```bash
   npm login --scope=@telagod --auth-type=legacy --registry=https://npm.pkg.github.com
   ```

   它会向 `~/.npmrc` 写入下面两行，你也可以手动添加：

   ```ini
   @telagod:registry=https://npm.pkg.github.com
   //npm.pkg.github.com/:_authToken=<token>
   ```

只有 `@telagod` scope 从 GitHub Packages 获取，foxnio 的依赖仍从 npmjs.com 安装。使用 Bun 时，请在 `bunfig.toml` 的 `[install.scopes]` 中映射该 scope 和 token。

然后安装并启动 foxnio：

```bash
npm install -g @telagod/foxnio
foxnio
```

foxnio 会在浏览器中打开 <http://127.0.0.1:30177>。也可以用 `npx @telagod/foxnio@latest` 免安装直接运行。

### 桌面应用

每个[发布版本](https://github.com/telagod/foxnio-public/releases/latest)都附带 Windows（安装包和便携版 `.exe`）、macOS（DMG 和 ZIP，支持 Apple silicon 和 Intel）、Linux（AppImage 和 `.deb`）的安装包。应用会在 30177 端口启动自己的 foxnio 服务，该端口被占用时改用下一个空闲端口。它不包含 `omp`，请另外安装。

安装包没有代码签名：

- **Windows：** SmartScreen 会显示“Windows 已保护你的电脑”。选择 **更多信息 → 仍要运行**。
- **macOS：** Gatekeeper 会拦截首次启动。右键点击应用并选择 **打开** 后确认，或执行 `xattr -dr com.apple.quarantine /Applications/foxnio.app`。

### Nix

```bash
nix run github:telagod/foxnio-public
```

### 更新

通过 npm 或 Bun 安装的 foxnio 可在 **设置 → 系统与更新** 中自行更新，该页面也会提示 `omp` 是否有新版本。foxnio 从 GitHub Releases 得知新版本，并通过上文配置的 registry 安装。它会在停止任何进程之前先确认 registry 能提供新版本。桌面应用不会自行更新：请安装新版安装包。设置 `OMP_WEB_DISABLE_AUTOUPDATE=1` 可关闭检查。

### 从 ompweb / omp-web 迁移

`~/.omp` 下的设置、会话和通知历史是共用的，无需迁移。但后台服务改了名称，旧服务会继续运行（或持续启动失败），与新服务并存，直到你把它们删除：

```bash
# npm 包
npm uninstall -g @kahme247/ompweb

# Linux：systemd 用户单元和托盘自启动
systemctl --user disable --now ompweb.service
rm ~/.config/systemd/user/ompweb.service ~/.config/autostart/ompweb-tray.desktop
systemctl --user daemon-reload

# macOS：launchd agent（日志原在 ~/Library/Logs/ompweb）
launchctl bootout "gui/$(id -u)/com.kahme247.ompweb"
rm ~/Library/LaunchAgents/com.kahme247.ompweb.plist
```

```powershell
# Windows：omp-web 创建的计划任务和快捷方式（先退出其托盘图标）
schtasks /delete /tn "omp-web" /f
$programs = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs"
Remove-Item "$programs\Startup\omp-web-tray.lnk", "$programs\omp-web.lnk", "$([Environment]::GetFolderPath('Desktop'))\omp-web.lnk" -ErrorAction SilentlyContinue
```

之后为你的平台安装 foxnio 服务（[后台服务](#后台服务)）。

## 运行 foxnio

### 命令行

```text
foxnio [options]
  -p, --port <port>        Server port (default 30177, env PORT)
  -H, --hostname <host>    Bind address (default 127.0.0.1, env OMP_WEB_HOSTNAME)
      --no-open            Do not open the browser
      --install-tray       Install the system tray (Windows: with the background service and shortcuts)
      --uninstall-tray     Remove it again
      --tray               Start the tray
  -h, --help               Show the help
      --version            Show the version

foxnio hash-password       Read a password from stdin and print the value for OMP_WEB_PASSWORD_HASH
foxnio systemd <command>   Manage the Linux systemd service (same as foxnio-systemd)
foxnio launchd <command>   Manage the macOS launchd agent (same as foxnio-launchd)
```

### 后台服务

这些服务在登录时启动 foxnio，在它意外停止时重启，并且不会打开浏览器。在 Linux 和 macOS 上，安装时设置的环境变量（端口、绑定地址、密码）会写入服务配置，密码只以哈希形式保存；如需打开浏览器，在这两个平台上安装时设置 `OMP_WEB_NO_OPEN=0`。

**Linux（systemd 用户服务）**，在 `npm install -g` 之后：

```bash
foxnio systemd install        # 创建 ~/.omp/agent/web-service.env，安装并启动 foxnio.service
foxnio systemd status         # 另有 start、stop、restart、open、uninstall
journalctl --user -u foxnio -f
```

服务运行的是安装时找到的 `foxnio`（可用 `OMP_WEB_SYSTEMD_BIN` 覆盖）。它从 `~/.omp/agent/web-service.env`（权限 `600`）读取端口、绑定地址和密码哈希：修改该文件并重启服务即可，无需重新安装。要让网络上的其他设备访问，请在安装时设置密码：

```bash
OMP_WEB_HOSTNAME=0.0.0.0 OMP_WEB_PASSWORD='change-me' foxnio systemd install
```

在无图形界面的服务器上，执行 `loginctl enable-linger "$USER"` 可让服务在你退出登录后继续运行。

**Linux 托盘**（KDE Plasma 及其他带 StatusNotifierItem host 的桌面环境）：

```bash
foxnio-tray --install         # 图标、自启动项，并启动托盘
foxnio-tray --status
foxnio-tray --uninstall
```

托盘菜单可以打开 Web UI、复制其 URL、启动/停止/重启 systemd 服务、查看日志、修改端口和 Web 密码，以及开关自启动（`~/.config/autostart/foxnio-tray.desktop`）。**Expose to Network** 会把服务绑定到 `0.0.0.0`；尚未设置密码时，它会先（通过 `kdialog` 或 `zenity`）要求你设置密码。

**macOS（launchd agent）：**

```bash
foxnio launchd install        # 另有 status、uninstall
```

该 agent 运行 `npx --yes @telagod/foxnio@latest`，因此需要 [npm 包](#npm-包)一节中的 GitHub Packages 配置。可以用 `foxnio launchd install @telagod/foxnio@0.6.2`（或 `OMP_WEB_PKG`）固定版本。plist 为 `~/Library/LaunchAgents/com.telagod.foxnio.plist`（权限 `600`），日志为 `~/Library/Logs/foxnio/foxnio.log`。

**Windows（托盘和后台服务）：**

```powershell
foxnio --install-tray         # 托盘、后台服务、登录自启动、桌面和开始菜单快捷方式
foxnio --uninstall-tray
```

可在 **设置 → 系统与更新 → Windows 后台服务与系统托盘** 中管理。托盘和服务每次启动服务器时，都会从你的用户或系统环境变量中读取 `OMP_WEB_PASSWORD_HASH` 和 `OMP_WEB_TRUSTED_HEADER_SHA256`（例如 `setx OMP_WEB_PASSWORD_HASH "scrypt$…"`），因此修改后在下次重启服务器时生效，无需退出 Windows 登录。

## 远程访问与安全

foxnio 运行的 `omp` 智能体带有 shell：任何能使用其 Web UI 的人都能以你的用户身份执行命令。因此除非你另行指定，它只绑定到 `127.0.0.1`。

- **未设置密码时**，foxnio 只响应 `Host` 头为回环名称（`localhost`、`127.0.0.0/8`、`[::1]`）的请求，其余一律返回 `403`。这可以阻止你访问的网页通过 DNS rebinding 访问你的智能体。如需通过反向代理、隧道或 Tailscale 域名访问未设密码的服务，请把该域名写入 `OMP_WEB_ALLOWED_HOSTS`，更推荐直接设置密码。
- **绑定到任何其他地址都需要密码哈希**（`OMP_WEB_PASSWORD_HASH`）。请通过 HTTPS（反向代理或 VPN）提供 foxnio，这样密码和会话 cookie 就不会以明文形式经过网络。
- **登录会被限速：** 输错 5 次密码，该客户端锁定 15 秒，之后逐次翻倍，最长 5 分钟（HTTP `429`）。
- **导出的会话**（“查看完整历史”）在沙箱中打开，无法读取你的 cookie，也无法调用 API，因为导出的对话可能包含模型或网页写入的 HTML。自 omp 18.14 起，该页面从 omp 的 CDN（`stencil.so`）加载查看器，因此需要联网才能渲染，下载下来的副本也一样。

### 密码

foxnio 绝不把明文密码交给服务器。每个 `omp` 会话都会继承服务器的环境变量，智能体只要运行 `env`，就会把密码写入会话文件并发送给模型提供商。请改为给 foxnio 提供哈希：

```bash
foxnio hash-password                                   # 输入两次，内容不回显
echo "a-long-random-password" | foxnio hash-password   # 也可通过管道输入

OMP_WEB_PASSWORD_HASH='scrypt$15$8$1$…' foxnio
```

`foxnio hash-password` 从标准输入读取密码，绝不通过参数传入，因此不会留在 shell 历史或 `ps` 输出中。哈希使用 scrypt（N = 2^15、r = 8、p = 1）和新生成的 16 字节盐，输出格式为 `scrypt$<ln>$<r>$<p>$<salt>$<digest>`。任何人都无法用哈希登录，也无法把它还原成密码。会话 cookie 用一个随机密钥签名，该密钥来自 `~/.omp/agent/omp-web/web-auth-secret.json`（权限 `0600`），并与哈希混合，因此修改密码会让所有人退出登录，而仅凭保存的哈希无法伪造会话。

`--password` 会被拒绝。旧的 `OMP_WEB_PASSWORD` 暂时仍可使用：foxnio 会在启动时将其哈希，使其不进入服务器的环境变量，并在日志中输出应改用的哈希。请尽快切换：智能体仍能从 `foxnio` 启动器进程中读取明文，而且每次启动都会生成新的哈希，使所有浏览器退出登录。同时设置两个变量会被拒绝。

### 在受信任的网络中跳过密码

foxnio 看不到客户端的地址，因此把这个判断交给你的反向代理。代理在 `X-Omp-Web-Auth` 请求头中发送一个密钥，foxnio 只在 `OMP_WEB_TRUSTED_HEADER_SHA256` 中保存该密钥的 SHA-256 摘要。请求头哈希后与该摘要一致的请求视为已登录，其他人用密码登录。未设置密码时没有可跳过的内容，该请求头会被忽略。请让 foxnio 保持绑定到 `127.0.0.1`，这样只有代理能访问它。

生成密钥时不要在命令行里输入它，以免它进入 shell 历史。下面的命令把一个随机密钥写入只有 root 和 nginx 可读的 nginx include 文件，并且只输出摘要：

```bash
secret=$(openssl rand -hex 32)
printf 'map $foxnio_trusted $foxnio_auth {\n    1        "%s";\n    default  "";\n}\n' "$secret" \
  | sudo install -m 0640 -o root -g www-data /dev/stdin /etc/nginx/foxnio-auth.conf
printf %s "$secret" | sha256sum | cut -d' ' -f1
unset secret
```

请把 `www-data` 换成你的 nginx 用户组（某些发行版是 `nginx`），并把输出的摘要设为 `OMP_WEB_TRUSTED_HEADER_SHA256`。务必按这种方式生成密钥，不要复用密码：foxnio 保存的是快速、不加盐的 SHA-256 摘要，只有对足够长的随机密钥才安全。

只向你信任的地址范围发送该密钥：

```nginx
# http {} 上下文
geo $foxnio_trusted {
    default       0;
    10.0.0.0/16   1;
}
include /etc/nginx/foxnio-auth.conf;  # 上面写入的 map

# 代理到 foxnio 的 location
proxy_set_header X-Omp-Web-Auth $foxnio_auth;
```

请始终按上面的方式设置该请求头：对其他客户端设置的空值会覆盖客户端自己发送的任何 `X-Omp-Web-Auth`。只有当某个块自己没有设置任何 `proxy_set_header` 时，nginx 才会从外层块继承它，因此请把这一行放在该 location 的其他 `proxy_set_header` 旁边。

只为 foxnio 自己的主机名提供服务：给它的 `server` 块设置明确的 `server_name`，再添加一个 `default_server` 块，用 `return 444;` 应答所有其他主机名。否则，受信任的浏览器所访问的网页可以把它自己的域名指向你的 nginx（DNS rebinding），让 nginx 为它的请求加上该密钥。

`geo` 检查的是 `$remote_addr`，即连接到 nginx 的地址。如果客户端是经由另一层代理访问 nginx 的，请用 [`realip` 模块](https://nginx.org/en/docs/http/ngx_http_realip_module.html)把它替换为真实的客户端地址，该模块只会对来自 `set_real_ip_from` 所列地址的连接这样做：

- **Cloudflare（代理 DNS）：** 信任 `CF-Connecting-IP`，且只信任来自 Cloudflare 的请求。列出 <https://www.cloudflare.com/ips-v4/> 和 <https://www.cloudflare.com/ips-v6/> 中的所有网段，并保持更新。

  ```nginx
  set_real_ip_from 173.245.48.0/20;  # ...每个 Cloudflare 网段一行
  real_ip_header   CF-Connecting-IP;
  ```

  同时拒绝既不来自 Cloudflare、也不来自你信任网段的连接。`$realip_remote_addr` 是实际发起连接的地址：

  ```nginx
  geo $realip_remote_addr $foxnio_peer_allowed {
      default          0;
      173.245.48.0/20  1;  # ...所有 Cloudflare 网段
      10.0.0.0/16      1;
  }
  # 在 server 块中
  if ($foxnio_peer_allowed = 0) { return 403; }
  ```

- **Cloudflare Tunnel（`cloudflared`）：** 隧道从 `cloudflared` 的地址发起连接（它运行在同一台机器上时是 `127.0.0.1`），因此使用 `set_real_ip_from 127.0.0.1;` 和 `real_ip_header CF-Connecting-IP;`。这样任何本地进程都可以通过自己发送 `CF-Connecting-IP` 来冒充受信任的地址；而不带该请求头的本地连接保持为 `127.0.0.1`，所以把 `127.0.0.1` 列入 `$foxnio_trusted` 就等于信任所有连接 nginx 的本地进程。
- **其他代理或负载均衡器：**

  ```nginx
  set_real_ip_from  <proxy address or range>;
  real_ip_header    X-Forwarded-For;
  real_ip_recursive on;
  ```

  `real_ip_recursive on` 从右向左读取 `X-Forwarded-For`，并跳过 `set_real_ip_from` 中列出的跳点，因此客户端自己添加的地址会被忽略。

## 手机、通知与应用

**作为应用安装：** 先登录，然后使用浏览器的安装菜单。应用清单（manifest）及其图标放在密码保护之后提供（图标是内嵌的，因为 Android 的安装程序获取图标 URL 时不带 cookie），所以在 Cloudflare Access 或其他登录页之后安装也不需要绕过规则。应用依赖服务器，不能离线使用。在 Android 和 iOS 上，它是你电脑或服务器上 foxnio 服务器的远程客户端。

**通知：** 在 **设置 → 通知** 中开启。每个浏览器各自保存自己的选择：哪些事件会发通知（任务完成、等待你的输入、运行失败、模型自动切换），以及 foxnio 在另一个标签页中打开时怎么处理（应用内提示，或始终发送系统通知）。你正在查看的会话不会发通知，点击通知会打开对应的会话。

- **Web Push** 即使没有打开任何 foxnio 标签页，也能送达浏览器。它需要安全上下文（HTTPS 或 `localhost`），并要求 foxnio 服务器能通过 HTTPS 访问各浏览器厂商的推送服务。foxnio 在首次使用时创建推送（VAPID）密钥，并将其与设备列表和通知历史一起保存在自己的数据目录中（仅所有者可访问）。
- **iPhone 和 iPad**（iOS 16.4 或更高版本）只有添加到主屏幕的应用才能接收推送。
- 不支持推送时，只要有 foxnio 标签页打开，安全上下文仍会显示系统通知。在 `localhost` 以外的地址上使用纯 HTTP 时，浏览器只允许 foxnio 的应用内提示。

## 配置

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `PORT` | 服务端口 | `30177` |
| `OMP_WEB_HOSTNAME` | 绑定地址 | `127.0.0.1` |
| `OMP_WEB_PASSWORD_HASH` | Web 登录密码的 scrypt 哈希，由 `foxnio hash-password` 生成。绑定非回环地址时必须设置 | _无（不需要登录）_ |
| `OMP_WEB_TRUSTED_HEADER_SHA256` | 受信任的反向代理在 `X-Omp-Web-Auth` 中发送的密钥的 SHA-256 十六进制摘要（[在受信任的网络中跳过密码](#在受信任的网络中跳过密码)） | _无_ |
| `OMP_WEB_ALLOWED_HOSTS` | 未设置密码时，除回环名称外额外接受的 `Host` 名称，逗号分隔（`name` 或 `*.example.com`） | _无_ |
| `OMP_WEB_PUSH_ALLOWED_HOSTS` | 除 Google（FCM）、Mozilla、Apple 和 Windows 外额外接受的 Web Push 服务主机（`name` 或 `*.example.com`） | _无_ |
| `OMP_WEB_OMP_BIN` | `omp` 可执行文件的路径 | 在 `PATH` 中查找 |
| `PI_CODING_AGENT_DIR` | omp 的 agent 目录，与 omp 本身的用法相同 | `~/.omp/agent` |
| `OMP_WEB_NO_OPEN` | `1`：不打开浏览器 | `0` |
| `OMP_WEB_DISABLE_AUTOUPDATE` | `1`：不检查更新，也不进行应用内更新（重启后生效） | `0` |
| `OMP_WEB_NAME` | 浏览器标签页和已安装应用中显示的名称。设为 `url`、`host` 或 `domain` 时使用浏览器所连接的主机名（localhost 和 IP 地址仍显示 `foxnio`）；其他值按原样使用。重启后生效 | `foxnio` |
| `OMP_WEB_STT_ENDPOINT` | 用于语音输入的 OpenAI 兼容语音转文字接口。不设置时，使用 `OMP_WEB_STT_MODEL` 通过 omp 自身的登录凭据转录 | _无_ |
| `OMP_WEB_STT_KEY` | 该接口的 API 密钥 | _无_ |
| `OMP_WEB_STT_MODEL` | 接口使用的模型。未设置接口时，使用 omp 的语音转文字模型，例如 `openai-codex/codex-transcribe`（ChatGPT 订阅） | _无（未设置接口时关闭语音输入）_ |
| `OMP_WEB_DEV_ORIGIN` | 开发服务器额外接受的主机名（不含协议和端口） | _无_ |

已安装的应用通常以安装时所在页面的名称命名，因此修改 `OMP_WEB_NAME`，或在其为 `url`、`host` 或 `domain` 时通过其他地址访问 foxnio，都可能让已安装的应用被重命名。建议留空，或设置一个无论通过哪个地址访问都能识别这台服务器的名称。

桌面应用有几项自己的设置（端口和内置运行时），见 [docs/desktop-packaging.zh-CN.md](./docs/desktop-packaging.zh-CN.md)。

## omp 兼容性

foxnio 从不加载 omp 的代码：omp 的包需要 Bun，而 foxnio 运行在 Node.js 上。它转而驱动 `omp` 可执行文件，每个打开的会话对应一个 `omp --mode rpc-ui` 进程，并调用 `omp skill list` 等子命令，同时直接读取 `~/.omp/agent` 下 omp 的文件（[DESIGN.md](./DESIGN.md)）。

omp 每隔几天发布一个版本。[`.github/omp-version.json`](./.github/omp-version.json) 记录了 foxnio 所验证的 omp 版本。每天会有一个 [workflow](./.github/workflows/omp-tracking.yml) 查找更新的 omp 版本，针对它运行 foxnio 中驱动真实 `omp` 的测试，并创建一个带 [`omp-update`](https://github.com/telagod/foxnio-public/issues?q=label%3Aomp-update) 标签的 issue，写明结果，以及 omp 的 RPC 协议、CLI 参数、设置和会话格式有哪些变化。

## 开发

```bash
git clone https://github.com/telagod/foxnio-public.git foxnio
cd foxnio
npm install
npm run dev        # http://127.0.0.1:30178
```

```bash
npm run typecheck
npm run lint
npm test
```

`npm test` 不需要安装 `omp`。驱动真实 `omp` 的测试（使用 `OMP_WEB_OMP_BIN` 或 `PATH` 中的 `omp`，与你的凭据和配置隔离）需要主动开启：

```bash
OMP_WEB_TEST_NATIVE_COMPAT=1 node --experimental-strip-types --test lib/omp/omp-compat.native.test.mjs
OMP_WEB_TEST_NATIVE_EDIT=1 node --experimental-strip-types --test lib/omp/session-edit.native.test.mjs
```

请勿在用于 `npm run dev` 的检出目录中运行 `npm run build`：生产构建会写入 `.next/`，导致开发服务器异常。

开发服务器接受回环地址和私有 IPv4 来源（`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`）。如需使用隧道或代理主机名，请用 `OMP_WEB_DEV_ORIGIN=dev.example.com npm run dev` 启动。私有 IPv6 来源也要用同样的方式指定（例如 `[fd00::1]`）。

更多内容：[AGENTS.md](./AGENTS.md)（架构、约定和陷阱）、[CONTRIBUTING.md](./CONTRIBUTING.md)、[docs/release.md](./docs/release.md)、[docs/desktop-packaging.zh-CN.md](./docs/desktop-packaging.zh-CN.md)。

## 许可证与致谢

采用 MIT 许可证，见 [LICENSE](./LICENSE)。foxnio 是 [kahme247/ompweb](https://github.com/kahme247/ompweb) 的 fork，后者源自 [agegr/pi-web](https://github.com/agegr/pi-web)。上游社区在 [ompweb Discord](https://discord.gg/evqgGzRfM5) 交流。
