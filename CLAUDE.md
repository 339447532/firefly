# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Architecture

This is a two-component project called **Firefly**:

- `server/` — Node.js WebSocket gateway that attaches to a tmux session via `node-pty` and exposes it over WebSocket. Also includes an optional **lanproxy client** for intranet penetration (内网穿透).
- `mobile/` — React Native app (Android/iOS) named "FireflyMobileApp" that renders a terminal in a WebView using xterm.js
- `proxy-client/` — Standalone Node.js lanproxy client (source reference; the same code is integrated into `server/lib/proxy-client/`)

### How they connect

The mobile app embeds xterm.js in a `WebView` (inline HTML injected via `source={{ html: ... }}`). The WebView opens a WebSocket to the server. The server spawns a PTY that runs `tmux attach`, so all clients share the same tmux session.

**Message protocol** — two types of traffic on the same WebSocket:
- Raw bytes/strings → terminal output written directly to xterm
- JSON objects → control messages (connection status, file upload, tmux control, TUI prompts, directory listing, etc.)

The server dispatches on `payload.type`: `input`, `resize`, `upload_file`, `claude_action`, `tui_action`, `tmux_ctrl`, `tmux_scroll`, `get_cwd`, `list_directory`, `recover_screen`, `new_session`.

### Intranet Penetration (内网穿透)

The server can optionally run a lanproxy client to expose internal services through a proxy server. This is controlled by environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PROXY_ENABLE` | `false` | Enable/disable the proxy client |
| `PROXY_CLIENT_KEY` | — | Client authentication key (required when enabled) |
| `PROXY_SERVER_HOST` | — | Proxy server host (required when enabled) |
| `PROXY_SERVER_PORT` | `4900` | Proxy server port |
| `PROXY_SSL_ENABLE` | `false` | Enable SSL for proxy connection |
| `PROXY_SSL_CERT_PATH` | `conf/client-cert.pem` | SSL certificate path (relative to server dir) |
| `PROXY_SSL_KEY_PATH` | `conf/client-key.pem` | SSL private key path |
| `PROXY_SSL_KEY_PASSWORD` | `changeit` | SSL key passphrase |
| `PROXY_LOG_LEVEL` | `INFO` | Log level: DEBUG, INFO, WARN, ERROR |

When `PROXY_ENABLE=true` and both `PROXY_CLIENT_KEY` and `PROXY_SERVER_HOST` are set, the proxy client starts alongside the WebSocket gateway. The `/health` endpoint includes proxy status.

### Key server files

- `server/server.js` — WebSocket server, PTY lifecycle, message routing, proxy client integration
- `server/lib/tmux-manager.js` — tmux commands (split, scroll, session management)
- `server/lib/tui-parser.js` — parses terminal output to detect TUI prompts (e.g. Claude Code permission dialogs) and sends `tui_prompt` JSON back to the mobile app
- `server/lib/proxy-client/` — lanproxy client modules (config, protocol, channel management, SSL)

### Key mobile files

- `mobile/src/components/TerminalScreen.jsx` — entire UI: status bar, toolbar, modals (commands, keyboard combos, config, file browser), WebView with inline xterm.js HTML
- `mobile/src/App.js` — root component, wraps `TerminalScreen` in `SafeAreaProvider` + `GestureHandlerRootView`
- `mobile/src/lib/ws-robust.js` — `RobustWS` class with exponential backoff reconnect (not currently used by TerminalScreen, which has its own inline reconnect logic)

### xterm.js assets

xterm.js is loaded from Android assets (`file:///android_asset/xterm/`). The files must be placed in `mobile/android/app/src/main/assets/xterm/`.

## Server commands

```bash
cd server
npm install
node server.js        # start the gateway
```

Config via `.env` or environment variables:
- `PORT` — WebSocket port (default: `8080`)
- `WS_TOKEN` — auth token required in WebSocket URL query param `?token=` (default: `dev-secure-token-2026`)
- `TMUX_PATH` — path to tmux binary (default: `/opt/homebrew/bin/tmux`)
- `TMUX_SESSION_PATH` — working directory for new tmux sessions (default: `$HOME`)
- `PROXY_ENABLE` — enable intranet penetration (default: `false`)

## Mobile commands

```bash
cd mobile
npm install
npm run android          # run on Android device/emulator
npm run ios              # run on iOS simulator
npm run start            # start Metro bundler only
npm run build:android    # build debug APK and install via adb
npm run lint             # ESLint
npm test                 # Jest
```

Node >= 22.11.0 required.

## WebSocket URL format

```
ws://<server-ip>:8080?token=<WS_TOKEN>
```

The default hardcoded URL in `TerminalScreen.jsx:11` is `ws://192.168.1.100:8080?token=D6E0311D-0880-4D8C-8884-3B1AD1F93491` — change this or configure it via the in-app config modal.
