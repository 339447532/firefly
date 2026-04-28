# Firefly

Firefly 是一个移动端远程终端控制方案：React Native App 通过 WebView 承载 xterm.js，连接 Node.js WebSocket 网关；网关使用 `node-pty` 附着到 `tmux`，让手机可以实时操控 Mac/服务器上的终端会话。

项目同时集成了可选的 proxy https://github.com/339447532/qiproxy 客户端，可将本机内网服务暴露到公网代理服务器。


https://github.com/user-attachments/assets/50cd2d14-f25d-447f-80ef-73fb3116f581



## 项目结构

```text
firefly/
├── server/                 # Node.js WebSocket 网关 + lanproxy 客户端
│   ├── server.js           # HTTP、WebSocket、PTY、tmux、代理集成入口
│   ├── lib/
│   │   ├── tmux-manager.js # tmux pane / 滚动 / session 管理
│   │   ├── tui-parser.js   # TUI 提示解析
│   │   └── proxy-client/   # 内网穿透客户端模块
│   ├── public/             # 终端页、中文键盘页、前端脚本和 vendor 资源
│   └── conf/               # SSL 证书文件
├── mobile/                 # React Native App (Android / iOS)
│   └── src/components/TerminalScreen.jsx # 主要移动端 UI 和 WebView 宿主
├── proxy-client/           # 独立 lanproxy 客户端源码参考
└── scripts/                # 辅助脚本
```

## 功能特性

### 服务端

- **WebSocket 终端网关**：将移动端输入输出转发到 `tmux attach` 后的 PTY。
- **多控制台支持**：支持列出、新建、切换和彻底关闭多个 `tmux session`。
- **tmux pane 管理**：支持 pane 列表、横/竖分屏、切换、关闭。
- **tmux 滚动控制**：支持上翻、下翻、到顶部、到底部。
- **屏幕恢复**：连接或重连后可通过 `recover_screen` 捕获当前 pane 内容，减少空白屏。
- **文件上传**：接收移动端 base64 文件，写入服务端 `uploads/`，并把路径回填到终端。
- **目录浏览 API**：支持获取当前工作目录和列出目录，供移动端文件浏览器使用。
- **TUI 提示解析**：识别部分终端交互提示，并通过结构化消息回传移动端。
- **健康检查**：`/health` 返回网关、当前 tmux、代理状态。
- **会话列表 HTTP API**：`/api/tmux/sessions` 返回可切换控制台列表，移动端弹窗优先使用它，避免 WebSocket 未 ready 时列表为空。
- **屏幕实况**：提供独立的 `/screen` 页面和 `/screen-ws` WebSocket，实时查看 server 机器的 GUI 桌面。
- **WebP 帧传输**：屏幕实况使用系统截图 + `sharp` 编码 WebP，通过单独 WebSocket 推送二进制帧，不占用终端 WebSocket。
- **GUI 与权限检测**：`/api/screen/status` 检测 server 是否有 GUI 桌面、屏幕录制权限是否可用，并返回屏幕实况状态。
- **macOS 权限入口**：`/api/screen/open-permissions` 可从手机端触发打开 server 上的“屏幕录制”系统设置页。
- **内网穿透**：可选启动 lanproxy 客户端，支持 SSL、断线重连、通道管理。
- **pkg 打包**：服务端可打包为 macOS 独立可执行文件。

### 移动端 App

- **终端 WebView**：内嵌 xterm.js 页面，支持自动适配终端尺寸、断线重连、屏幕恢复。
- **控制台切换器**：状态栏显示当前控制台，弹窗中可刷新列表、切换控制台、新建控制台。
- **彻底关闭控制台**：控制台列表中可关闭指定 `tmux session`；关闭当前控制台时会自动切换到其它可用控制台，必要时创建替代会话。
- **连接配置**：App 内可配置服务器地址、Token、终端字体大小，并持久化到本地。
- **自定义命令**：支持保存、编辑、排序、删除和一键执行常用命令。
- **文件上传**：Android 支持文档上传；iOS 支持文件和相册上传。
- **文件浏览器**：可读取服务端当前目录、向上导航、选择路径并写入终端。
- **快捷按键栏**：ESC、TAB、Ctrl-C、方向键、删除、空格、回车、上翻、下翻等常用操作。
- **组合键面板**：支持 Ctrl / Shift / Alt / Cmd 组合键和常见字母、数字、符号输入。
- **中文 Web 键盘**：内置拼音输入键盘，适合系统输入法在 WebView 终端中体验不佳的场景。
- **输入模式切换**：底部 `键盘` 按钮可在系统输入法和 Web 中文键盘之间切换。
- **屏幕实况按钮**：快捷按键栏中的 `屏幕` 按钮可打开横屏全屏页面，实时查看 server 桌面画面，并支持双指缩放。
- **安全区适配**：兼容 iPhone Home Indicator，底部键盘和工具栏不会贴底。

## 快速开始

### 服务端

```bash
cd server
npm install
node server.js
```

启动后默认监听：

```text
http://0.0.0.0:8080
ws://0.0.0.0:8080
```

终端页面：

```text
http://127.0.0.1:8080/terminal?token=<WS_TOKEN>
```

### 移动端

```bash
cd mobile
npm install

# Metro
npm run start

# Android
npm run android

# iOS 模拟器
npm run ios

# iOS 真机
npm run ios:device

# iOS 真机 Release
npm run ios:release

# 构建并安装 Android debug APK
npm run build:android
```

Node >= 22.11.0。

## 移动端使用说明

### 连接配置

首次启动后可在顶部状态栏点击 `配置`：

- `服务器地址`：格式为 `IP:端口`，例如 `192.168.1.100:8080`
- `密钥`：服务端 `WS_TOKEN`
- `终端字体大小`：8 到 32

保存后 App 会持久化配置；服务器地址或 Token 变化时会重新加载终端 WebView。

### 控制台管理

点击状态栏的当前控制台名称或 `控制台` 按钮打开控制台弹窗：

- `刷新列表`：重新从服务端读取 tmux session 列表
- 点击控制台条目：切换当前终端到该控制台
- `新建控制台`：创建新的 tmux session 并自动切换过去
- `关闭`：彻底关闭对应 tmux session

说明：

- 控制台列表来自 `GET /api/tmux/sessions`，同时保留 WebSocket 消息作为兜底。
- 控制台条目采用无背景列表样式，当前控制台通过绿点和 `当前` 文本标识。
- App 会记住上次使用的控制台，下次连接后自动尝试切回。
- 如果关闭的是当前控制台，服务端会先切换到另一个可用控制台；如果没有其它控制台，会创建一个替代 session，避免连接直接断开。

### 屏幕实况

点击快捷按键栏中的 `屏幕` 可打开全屏屏幕实况页：

- 页面会横屏展示 server 机器的桌面画面。
- 画面通过独立 WebSocket `/screen-ws` 传输，不会阻塞终端输入输出。
- 服务端使用系统截图获取画面，再用 `sharp` 编码为 WebP 帧推送到 App。
- WebView 中使用 `<img>` 连续替换 WebP 帧，支持双指缩放和拖动画面。
- macOS 首次使用需要给运行 server 的终端或应用授予“屏幕录制”权限；授权后通常需要重启 Firefly server。

如果打开后提示权限或 GUI 不可用，可先访问：

```bash
curl "http://127.0.0.1:8080/api/screen/status?token=<WS_TOKEN>"
```

屏幕实况默认参数偏低带宽，可通过环境变量调整：

```env
SCREEN_WEBP_FPS=4
SCREEN_WEBP_WIDTH=960
SCREEN_WEBP_QUALITY=55
```

### 中文键盘 / 输入模式

- 底部工具区的 `键盘` 是输入模式开关，不是立即弹出键盘。
- 未开启时，点击终端输入区域会使用系统输入法。
- 开启后，点击终端输入区域会唤出底部 Web 中文键盘。
- Web 中文键盘输入内容会实时发送到终端。
- 再次点击 `键盘` 会退出 Web 键盘模式，恢复系统输入法。

### 文件与路径

- `文件`：从手机选择文件上传到服务端，服务端会把临时文件路径写入终端。
- `目录`：打开服务端目录浏览器，默认读取当前 pane 工作目录。
- 文件浏览器中点击目录可进入，点击选择按钮会把该路径写入终端。

### 常用命令与组合键

- `命令`：管理自定义命令，支持新增、编辑、删除、排序、执行。
- `组合键`：选择 Ctrl / Shift / Alt / Cmd 后发送组合输入。
- 快捷键栏提供 ESC、TAB、Ctrl-C、方向键、删除、空格等高频操作。

## 服务端配置

服务端通过 `server/.env` 或环境变量配置。

### 基础配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `8080` | HTTP / WebSocket 监听端口 |
| `WS_TOKEN` | `D6E0311D-0880-4D8C-8884-3B1AD1F93491` | 页面和 WebSocket 鉴权 Token |
| `TMUX_PATH` | `/opt/homebrew/bin/tmux` | tmux 可执行文件路径 |
| `TMUX_SESSION_PATH` | `$HOME` | 新建 tmux session 的工作目录 |
| `TMUX_SESSION` | `mobile-dev` | 默认 tmux session 名称 |
| `SERVER_TMUX_SESSION` | `firefly-server` | 服务端自身运行在 tmux 中时的保留 session 名，列表中会过滤它 |

### 屏幕实况配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SCREEN_WEBP_FPS` | `4` | WebP 屏幕实况推送帧率，范围 1~10 |
| `SCREEN_WEBP_WIDTH` | `960` | WebP 帧最大宽度，范围 480~1920 |
| `SCREEN_WEBP_QUALITY` | `55` | WebP 编码质量，范围 20~90 |

说明：

- macOS 使用系统 `screencapture` 获取屏幕帧，需要“屏幕录制”权限。
- Linux 会根据桌面环境使用 `gnome-screenshot` 或 ImageMagick `import` 截图。
- WebP 编码由 Node 侧的 `sharp` 完成，不依赖 ffmpeg 或 H.264。

### 内网穿透配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PROXY_ENABLE` | `false` | 是否启用内网穿透 |
| `PROXY_CLIENT_KEY` | - | 客户端认证密钥，启用时必填 |
| `PROXY_SERVER_HOST` | - | 代理服务器地址，启用时必填 |
| `PROXY_SERVER_PORT` | `4900` | 代理服务器端口 |
| `PROXY_SSL_ENABLE` | `false` | 是否启用 SSL |
| `PROXY_SSL_CERT_PATH` | `conf/client-cert.pem` | SSL 证书路径 |
| `PROXY_SSL_KEY_PATH` | `conf/client-key.pem` | SSL 私钥路径 |
| `PROXY_SSL_KEY_PASSWORD` | `changeit` | SSL 私钥密码 |
| `PROXY_LOG_LEVEL` | `INFO` | 日志级别：DEBUG / INFO / WARN / ERROR |

启用示例：

```env
PROXY_ENABLE=true
PROXY_CLIENT_KEY=your-client-key
PROXY_SERVER_HOST=39.108.124.205
PROXY_SERVER_PORT=4993
PROXY_SSL_ENABLE=true
```

## HTTP 接口

| 路径 | 鉴权 | 说明 |
|------|------|------|
| `GET /terminal?token=<WS_TOKEN>` | 是 | xterm.js 终端页面 |
| `GET /keyboard?token=<WS_TOKEN>` | 是 | 中文屏幕键盘页面 |
| `GET /screen?token=<WS_TOKEN>` | 是 | 屏幕实况页面 |
| `GET /api/tmux/sessions?token=<WS_TOKEN>` | 是 | 返回可切换控制台列表 |
| `GET /api/screen/status?token=<WS_TOKEN>` | 是 | 返回 GUI、权限和屏幕实况能力状态 |
| `POST /api/screen/open-permissions?token=<WS_TOKEN>` | 是 | macOS 上打开屏幕录制权限设置页 |
| `GET /health` | 否 | 健康检查和代理状态 |
| `GET /assets/terminal-client.js` | 否 | 终端页脚本 |
| `GET /assets/keyboard-client.js` | 否 | 中文键盘脚本 |
| `GET /vendor/*` | 否 | 静态 vendor 资源 |

`/api/tmux/sessions` 返回示例：

```json
{
  "ok": true,
  "active": "mobile-dev",
  "sessions": [
    { "name": "mobile-dev", "windows": 1, "attached": 1 },
    { "name": "mobile-1777010199071", "windows": 1, "attached": 0 }
  ]
}
```

`/health` 返回示例：

```json
{
  "ok": true,
  "tmuxSession": "mobile-dev",
  "proxy": { "enabled": false }
}
```

`/api/screen/status` 返回示例：

```json
{
  "ok": true,
  "platform": "darwin",
  "guiAvailable": true,
  "webpAvailable": true,
  "transport": "websocket",
  "encoding": "webp",
  "permission": "granted"
}
```

启用内网穿透后：

```json
{
  "ok": true,
  "tmuxSession": "mobile-dev",
  "proxy": {
    "enabled": true,
    "connected": true,
    "server": "39.108.124.205:4993",
    "activeConnections": 0,
    "poolSize": 0
  }
}
```

## WebSocket 协议

连接地址：

```text
ws://<server-ip>:8080?token=<WS_TOKEN>
```

屏幕实况连接地址：

```text
ws://<server-ip>:8080/screen-ws?token=<WS_TOKEN>
```

协议在同一个 WebSocket 中混合两类消息：

- 原始字节 / 字符串：终端输入输出，直接写入 PTY 或 xterm.js。
- JSON 控制消息：根据 `type` 和 `action` 做结构化控制。

屏幕实况使用单独 WebSocket，不复用终端协议：

- 二进制消息：单帧 WebP 图片，浏览器端直接作为 `image/webp` 显示。
- JSON 消息：错误或关闭提示，例如 `{ "type": "error", "error": "..." }`。

连接成功后服务端会发送：

```json
{ "type": "connected", "sessionId": "...", "tmux": "mobile-dev" }
```

### 支持的消息类型

| type | 说明 |
|------|------|
| `input` | 写入终端输入 |
| `resize` | 调整 PTY 尺寸 |
| `upload_file` | 上传 base64 文件 |
| `claude_action` | 发送预定义快捷键 |
| `tui_action` | 响应 TUI 提示 |
| `tmux_ctrl` | tmux pane / session 控制 |
| `tmux_scroll` | tmux 滚动控制 |
| `get_cwd` | 获取当前 pane 工作目录 |
| `list_directory` | 列出目录内容 |
| `recover_screen` | 捕获并恢复当前屏幕内容 |
| `new_session` | 直接创建新 tmux session |
| `list_sessions` | 直接列出 tmux sessions |
| `switch_session` | 直接切换 tmux session |
| `close_session` | 直接关闭 tmux session |
| `ping` | 心跳检测 |

### tmux_ctrl action

`tmux_ctrl` 支持：

| action | 说明 |
|--------|------|
| `list` | 列出当前 session 的 panes |
| `split` | 分屏，`dir` 为 `h` 或 `v` |
| `switch` | 切换 pane |
| `close` | 关闭 pane |
| `new_session` | 新建并切换控制台 |
| `list_sessions` | 列出控制台 |
| `switch_session` | 切换控制台 |
| `close_session` | 彻底关闭控制台 |

示例：

```json
{ "type": "tmux_ctrl", "action": "list_sessions" }
```

```json
{ "type": "tmux_ctrl", "action": "new_session", "name": "mobile-work" }
```

```json
{ "type": "tmux_ctrl", "action": "switch_session", "session": "mobile-work" }
```

```json
{ "type": "tmux_ctrl", "action": "close_session", "session": "mobile-work" }
```

### tmux_scroll action

| action | 说明 |
|--------|------|
| `page_up` | 上翻一页 |
| `page_down` | 下翻一页 |
| `to_top` | 跳到历史顶部 |
| `to_bottom` | 回到底部并退出 copy-mode |

## xterm.js 和中文键盘资源

- 终端页面：`server/public/index.html`
- 终端脚本：`server/public/terminal-client.js`
- 中文键盘页面：`server/public/keyboard.html`
- 中文键盘脚本：`server/public/keyboard-client.js`
- 拼音数据：`server/public/vendor/pinyin-data/`

移动端 WebView 加载服务端页面；Android/iOS 工程中也保留了 xterm 相关资源，供平台打包和兼容使用。

## 打包部署

服务端可通过 `pkg` 打包：

```bash
cd server
npm run build:bin
```

产物输出到：

```text
server/dist/
```

打包配置会包含：

- `.env`
- `public/**/*`
- `conf/**/*`
- `lib/**/*.js`
- `node-pty` 的 `spawn-helper` 和 prebuilds
- `sharp` 运行时依赖会随 `node_modules` 安装；如需打包为单文件，请确认目标平台包含对应 sharp 原生包

## 内网穿透工作原理

1. Firefly server 内置 proxy client，根据 `PROXY_CLIENT_KEY` 连接代理服务器。
2. 代理服务器认证通过后，客户端等待 `TYPE_CONNECT` 指令。
3. 外部用户访问公网代理端口时，代理服务器下发目标连接指令。
4. 客户端连接本机或内网目标服务。
5. Firefly 在代理连接和内网连接之间做双向数据转发。

断线后采用指数退避重连：1s -> 2s -> 4s -> 8s -> 16s -> 32s -> 60s。

## 常见问题

### 控制台列表为空

确认服务端已经更新并重启，且可以访问：

```bash
curl "http://127.0.0.1:8080/api/tmux/sessions?token=<WS_TOKEN>"
```

如果服务端运行在 tmux 中，默认会过滤名为 `firefly-server` 的保留 session，避免误切换或误关闭网关自身。

### iOS 真机调试时 build.db locked

通常是仍有上一次 `xcodebuild` 在运行。等待其结束，或确认没有并发构建后再执行：

```bash
cd mobile
npm run start
npx react-native run-ios --device "iPhone" --no-packager
```

### 手机无法连接服务端

- 确认手机和服务端机器在同一网络，或已启用内网穿透。
- 确认 App 配置中的 `服务器地址` 是手机可访问的 `IP:端口`。
- 确认 `WS_TOKEN` 和 App 中的密钥一致。
- 确认服务端端口已监听：`lsof -Pan -iTCP:8080 -sTCP:LISTEN`。

### 屏幕实况打不开或没有画面

- 先确认状态接口返回 `ok: true`：

  ```bash
  curl "http://127.0.0.1:8080/api/screen/status?token=<WS_TOKEN>"
  ```

- macOS 需要在“系统设置 -> 隐私与安全性 -> 屏幕录制”中授权运行 Firefly server 的终端或应用。
- 授权后请重启 Firefly server。
- 如果画面带宽过高，可降低 `SCREEN_WEBP_FPS`、`SCREEN_WEBP_WIDTH` 或 `SCREEN_WEBP_QUALITY`。
