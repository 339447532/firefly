# Firefly Gateway

一个基于 Node.js 的轻量终端网关，用浏览器页面连接本机 `tmux` 会话，并通过 WebSocket 转发终端输入输出。

它适合下面这类场景：

- 在浏览器中访问本机终端
- 将现有 `tmux` session 暴露成网页终端
- 在移动端 WebView 或嵌入式页面中承载终端
- 通过单个可执行文件部署一个终端网关

## 功能概览

- 提供 HTTP 页面入口：`/terminal?token=...`
- 提供 WebSocket 终端连接
- 自动连接现有 `tmux` session，或按需创建新 session
- 支持 pane 列表、分屏、切换、关闭、滚动
- 支持恢复当前屏幕内容，减少重连后的空白期
- 支持将 base64 文件内容写入服务端临时目录，并把文件路径回填到终端
- 支持识别部分 TUI 提示并回传给上层容器
- 支持通过 `pkg` 打包为 macOS 可执行文件

## 项目结构

- `server.js`：服务端入口，负责 HTTP、WebSocket、PTY、tmux、打包兼容
- `lib/tmux-manager.js`：tmux pane 和滚动控制
- `lib/tui-parser.js`：终端输出中的简单 TUI 提示识别
- `public/index.html`：终端页面
- `public/terminal-client.js`：浏览器端 xterm.js 客户端
- `test-pty.js`：`node-pty` 本地调试脚本
- `dist/`：`pkg` 构建输出目录

## 运行要求

- macOS
- Node.js 18+
- 已安装 `tmux`

默认 `tmux` 路径是：

```text
/opt/homebrew/bin/tmux
```

如果你的环境不同，请通过 `TMUX_PATH` 覆盖。

## 安装依赖

```bash
cd /Users/zhanqi/Desktop/firefly/server
npm install
```

## 本地启动

```bash
cd /Users/zhanqi/Desktop/firefly/server
npm start
```

启动后默认监听：

```text
http://127.0.0.1:8080
```

终端页面地址：

```text
http://127.0.0.1:8080/terminal?token=你的WS_TOKEN
```

健康检查地址：

```text
http://127.0.0.1:8080/health
```

## 启动行为

服务启动时会执行以下逻辑：

1. 创建运行时上传目录
2. 检查当前配置的 `tmux` session 是否存在
3. 若不存在，则尝试复用第一个已存在的 `tmux` session
4. 若仍不存在，则创建一个新的默认 session
5. 对目标 session 设置 4 行空白 `status` 区，给终端内容留出空间

每个 WebSocket 连接都会创建一个新的 PTY，并执行：

```bash
tmux attach -t <session-name>
```

## 环境变量

- `PORT`：监听端口，默认 `8080`
- `WS_TOKEN`：页面访问和 WebSocket 鉴权 token
- `TMUX_PATH`：`tmux` 可执行文件路径，默认 `/opt/homebrew/bin/tmux`
- `TMUX_SESSION_PATH`：创建新 session 时的工作目录，默认当前用户家目录
- `TMUX_SESSION`：默认连接的 session 名称，默认 `mobile-dev`
- `NODE_PTY_SPAWN_HELPER`：通常由程序自动设置，无需手动指定

建议至少显式配置：

```bash
PORT=8080
WS_TOKEN=replace-with-your-token
TMUX_PATH=/opt/homebrew/bin/tmux
TMUX_SESSION=mobile-dev
TMUX_SESSION_PATH=/Users/your-name
```

## 页面与连接方式

### HTTP 页面

- `GET /terminal?token=...`：返回终端页面
- `GET /health`：返回健康状态和当前 tmux session
- `GET /assets/terminal-client.js`：前端终端脚本

当访问 `/terminal` 时，query 中的 `token` 必须等于 `WS_TOKEN`，否则返回 `401 Unauthorized`。

### WebSocket

浏览器端通过当前 host 直接建立 WebSocket 连接：

```text
ws://127.0.0.1:8080/?token=你的WS_TOKEN
```

连接建立后，服务端会先发送：

```json
{ "type": "connected", "sessionId": "...", "tmux": "mobile-dev" }
```

## 消息协议

服务端支持的典型消息如下。

### 终端基础控制

- `input`：发送字符串到 PTY
- `resize`：同步终端尺寸
- 二进制消息：按原始终端输入写入 PTY
- `ping`：返回 `pong`
- `recover_screen`：补发当前 tmux pane 已有内容

示例：

```json
{ "type": "resize", "cols": 120, "rows": 35 }
```

```json
{ "type": "ping" }
```

### 文件上传

前端可发送：

```json
{
  "type": "upload_file",
  "ext": "txt",
  "content": "base64-encoded-content"
}
```

服务端会把文件写入运行时 `uploads/` 目录，并把生成后的文件绝对路径直接写入当前终端输入流。

### tmux 控制

`tmux_ctrl` 支持以下动作：

- `list`：获取 pane 列表
- `split`：分屏，`dir` 为 `h` 或 `v`
- `switch`：切换 pane
- `close`：关闭 pane
- `new_session`：新建 session 并自动切换当前连接

示例：

```json
{ "type": "tmux_ctrl", "action": "list" }
```

```json
{ "type": "tmux_ctrl", "action": "split", "dir": "h" }
```

### tmux 滚动

`tmux_scroll` 支持：

- `page_up`
- `page_down`
- `to_top`
- `to_bottom`

### 辅助能力

- `get_cwd`：返回当前 pane 工作目录
- `list_directory`：列出指定目录
- `tui_action`：把上层选择的快捷键写回 PTY
- `claude_action`：把预定义按键映射写回 PTY
- `new_session`：直接创建并切换到新 session

## 前端说明

前端基于 `xterm.js`，主要行为包括：

- 自动根据窗口变化调整终端尺寸
- 连接建立后立即请求 `recover_screen`
- WebSocket 断开后自动重连，最多重试 12 次
- 支持把结构化消息通过 `postMessage` 回传给宿主环境

如果页面运行在 React Native WebView 中，会优先调用：

```js
window.ReactNativeWebView.postMessage(...)
```

否则会尝试发送给：

```js
window.parent.postMessage(...)
```

## 打包为二进制

项目已配置 `pkg`：

```bash
cd /Users/zhanqi/Desktop/firefly/server
npm run build:bin
```

也可以直接执行：

```bash
npx pkg .
```

当前构建目标：

```text
node18-macos-arm64
```

默认输出文件：

```text
dist/firefly-gateway
```

## 二进制运行时行为

打包后程序会额外处理以下事项：

- 运行目录改为可执行文件所在目录
- `.env` 优先从 `dist/.env` 读取
- 如果 `dist/.env` 不存在，会从包内复制一份出来
- 上传目录写入 `dist/uploads/`
- `node-pty` 的 `spawn-helper` 会复制到 `dist/node-pty-bin/`
- 自动设置 `NODE_PTY_SPAWN_HELPER`，兼容打包后的 PTY 启动

运行方式：

```bash
cd /Users/zhanqi/Desktop/firefly/server
./dist/firefly-gateway
```

临时改端口：

```bash
PORT=18080 ./dist/firefly-gateway
```

## 常用命令

```bash
# 安装依赖
npm install

# 本地启动
npm start

# 构建二进制
npm run build:bin

# 运行二进制
./dist/firefly-gateway
```

## 常见问题

### 1. 页面返回 401

检查访问 URL 中的 `token` 是否与服务端 `WS_TOKEN` 一致。

### 2. 无法连接 tmux

检查以下内容：

- `tmux` 已正确安装
- `TMUX_PATH` 配置正确
- 当前用户有权限访问目标 session

### 3. 打包后二进制启动 PTY 失败

项目已经在 `server.js` 中处理了 `spawn-helper` 的复制与注入逻辑。如果你重新安装过依赖，建议重点确认 `node-pty` 相关资源仍被 `pkg` 正确打包。
