# Firefly

远程终端控制方案 — 通过 WebSocket 在移动端实时操控服务器上的 tmux 终端会话。

## 项目结构

```
firefly/
├── server/          # Node.js WebSocket 网关 + 内网穿透客户端
│   ├── server.js    # 主服务入口
│   ├── .env         # 配置文件
│   ├── lib/
│   │   ├── tmux-manager.js     # tmux 管理
│   │   ├── tui-parser.js       # TUI 提示解析
│   │   └── proxy-client/       # 内网穿透模块
│   │       ├── proxy-client-container.js  # 主入口
│   │       ├── config.js        # 环境变量配置
│   │       ├── protocol.js      # 协议编解码
│   │       ├── channelManager.js # 通道管理
│   │       ├── sslContext.js    # SSL 上下文
│   │       ├── logger.js        # 日志
│   │       └── constants.js     # 常量
│   ├── conf/        # SSL 证书文件
│   └── public/      # 终端页面静态资源
├── mobile/          # React Native 移动端 (Android/iOS)
├── proxy-client/    # 独立 lanproxy 客户端（参考，已集成到 server）
└── scripts/         # 辅助脚本
```

## 功能特性

- **远程终端** — 移动端通过 WebSocket 实时操控服务器 tmux 会话
- **多窗口管理** — tmux 窗格分割、切换、滚动
- **文件上传** — 从移动端上传文件到服务器
- **中文屏幕键盘** — 内置基于 WebView 的中文键盘，支持拼音输入并直接写入终端
- **输入模式切换** — 底部“键盘”按钮可切换 Web 键盘模式；开启后点击终端唤出 Web 键盘，关闭后恢复系统输入法
- **移动端安全区适配** — 底部键盘兼容 iPhone Home Indicator / 弧形底边，最后一排按键不会贴底
- **智能提示** — 自动识别 Claude Code 等终端交互提示并提供快捷操作
- **内网穿透** — 可选的 lanproxy 客户端，将内网服务暴露到公网
- **SSL 加密** — 内网穿透支持 TLS 加密连接

## 快速开始

### 服务端

```bash
cd server
npm install
node server.js
```

启动后输出：

```
✅ Node 网关已启动: ws://0.0.0.0:8080
🔑 Token: D6E0311D-0880-4D8C-8884-3B1AD1F93491
ℹ️ 内网穿透未启用 (设置 PROXY_ENABLE=true 启用)
```

### 移动端

```bash
cd mobile
npm install

# Android
npm run android

# iOS
npm run ios

# 构建 APK
npm run build:android
```

Node >= 22.11.0 要求。

## 移动端交互说明

### 中文键盘 / 输入模式

- 底部工具区的 `键盘` 按钮是一个**输入模式开关**，不是立即弹出键盘。
- `键盘` 按钮未选中时：
  - 点击终端输入区域，使用系统输入法
  - 不会弹出 Web 中文键盘
- `键盘` 按钮选中时：
  - 按钮会高亮
  - 点击终端输入区域，会唤出底部 Web 中文键盘
  - Web 中文键盘输入的内容会实时发送到终端
- 再次点击 `键盘` 按钮会退出 Web 键盘模式，并恢复默认系统输入法行为

### 键盘加载与缓存

- 中文键盘页面由服务端 `GET /keyboard?token=<WS_TOKEN>` 提供
- 移动端会在终端稳定后预热键盘 WebView，减少首次打开等待
- 键盘相关静态资源（`/assets/*`、`/vendor/*`、拼音数据）启用了缓存，后续打开会更快

## 配置说明

所有配置通过 `server/.env` 环境变量设置。

### 基础配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `8080` | WebSocket 服务端口 |
| `WS_TOKEN` | `D6E0311D-...` | WebSocket 认证令牌 |
| `TMUX_PATH` | `/opt/homebrew/bin/tmux` | tmux 二进制路径 |
| `TMUX_SESSION_PATH` | `$HOME` | tmux 会话工作目录 |
| `TMUX_SESSION` | `mobile-dev` | 默认 tmux 会话名 |

### 内网穿透配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PROXY_ENABLE` | `false` | 是否启用内网穿透 |
| `PROXY_CLIENT_KEY` | — | 客户端认证密钥（启用时必填） |
| `PROXY_SERVER_HOST` | — | 代理服务器地址（启用时必填） |
| `PROXY_SERVER_PORT` | `4900` | 代理服务器端口 |
| `PROXY_SSL_ENABLE` | `false` | 是否启用 SSL 加密 |
| `PROXY_SSL_CERT_PATH` | `conf/client-cert.pem` | SSL 证书路径 |
| `PROXY_SSL_KEY_PATH` | `conf/client-key.pem` | SSL 私钥路径 |
| `PROXY_SSL_KEY_PASSWORD` | `changeit` | SSL 私钥密码 |
| `PROXY_LOG_LEVEL` | `INFO` | 日志级别：DEBUG / INFO / WARN / ERROR |

**启用示例：**

```env
PROXY_ENABLE=true
PROXY_CLIENT_KEY=your-client-key
PROXY_SERVER_HOST=39.108.124.205
PROXY_SERVER_PORT=4993
PROXY_SSL_ENABLE=true
```

## WebSocket 协议

连接地址：`ws://<server-ip>:8080?token=<WS_TOKEN>`

协议支持两种消息类型：

- **原始数据** — 终端输出，直接写入 xterm.js 渲染
- **JSON 控制消息** — 根据 `type` 字段分发处理

支持的 `type`：

| type | 说明 |
|------|------|
| `input` | 终端输入 |
| `resize` | 终端尺寸调整 |
| `upload_file` | 文件上传 |
| `claude_action` | Claude Code 快捷操作 |
| `tui_action` | TUI 提示交互 |
| `tmux_ctrl` | tmux 窗口控制 |
| `tmux_scroll` | tmux 滚动 |
| `get_cwd` | 获取当前工作目录 |
| `list_directory` | 目录列表 |
| `recover_screen` | 恢复终端屏幕 |
| `new_session` | 创建新 tmux 会话 |
| `ping` | 心跳检测 |

## HTTP 页面

除 WebSocket 外，服务端还提供给移动端 WebView 使用的页面：

| 路径 | 说明 |
|------|------|
| `/terminal?token=<WS_TOKEN>` | xterm.js 终端页面 |
| `/keyboard?token=<WS_TOKEN>` | 中文屏幕键盘页面 |
| `/health` | 服务健康检查 |

## 健康检查

访问 `/health` 获取服务状态：

```bash
curl http://localhost:8080/health
```

返回示例（未启用内网穿透）：

```json
{ "ok": true, "tmuxSession": "mobile-dev", "proxy": { "enabled": false } }
```

返回示例（已启用内网穿透）：

```json
{ "ok": true, "tmuxSession": "mobile-dev", "proxy": { "enabled": true, "connected": true, "server": "39.108.124.205:4993", "activeConnections": 0, "poolSize": 0 } }
```

## 打包部署

```bash
cd server
npm run build:bin    # 使用 pkg 打包为独立可执行文件
```

打包产物输出到 `server/dist/` 目录，可直接部署无需 Node.js 环境。

## 内网穿透工作原理

1. 客户端使用 `PROXY_CLIENT_KEY` 连接到代理服务器
2. 服务器验证通过后，客户端等待连接指令
3. 当外部用户请求访问时，服务器下发 `TYPE_CONNECT` 指令
4. 客户端连接到内网目标服务（如 `192.168.1.99:80`）
5. 建立双向数据通道，外部用户与内网服务之间的数据实时转发

断线时采用指数退避重连策略：1s → 2s → 4s → 8s → 16s → 32s → 60s
