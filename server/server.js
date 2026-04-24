const { WebSocketServer } = require('ws');
const { createServer } = require('http');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs/promises');
const { createReadStream, existsSync, copyFileSync, chmodSync, mkdirSync } = require('fs');
const path = require('path');
const os = require('os');
const { exec, execFile } = require('child_process');
const util = require('util');
const dotenv = require('dotenv');
const sharp = require('sharp');

const SOURCE_DIR = __dirname;
const RUNTIME_DIR = process.pkg ? path.dirname(process.execPath) : SOURCE_DIR;
const SOURCE_ENV_PATH = path.join(SOURCE_DIR, '.env');
const RUNTIME_ENV_PATH = path.join(RUNTIME_DIR, '.env');

function ensureRuntimeEnvFile() {
  if (!process.pkg) {
    return SOURCE_ENV_PATH;
  }

  if (!existsSync(RUNTIME_ENV_PATH) && existsSync(SOURCE_ENV_PATH)) {
    copyFileSync(SOURCE_ENV_PATH, RUNTIME_ENV_PATH);
  }

  return RUNTIME_ENV_PATH;
}

// Prefer a colocated .env next to the packaged binary.
dotenv.config({ path: ensureRuntimeEnvFile() });
const execAsync = util.promisify(exec);
const execFileAsync = util.promisify(execFile);

function resolveNodePtySpawnHelper() {
  const sourceCandidates = [
    path.join(SOURCE_DIR, 'node_modules', 'node-pty', 'build', 'Release', 'spawn-helper'),
    path.join(SOURCE_DIR, 'node_modules', 'node-pty', 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')
  ];

  const sourceHelper = sourceCandidates.find((candidate) => existsSync(candidate));
  if (!sourceHelper) {
    return null;
  }

  if (!process.pkg) {
    return sourceHelper;
  }

  const helperDir = path.join(RUNTIME_DIR, 'node-pty-bin');
  const runtimeHelper = path.join(helperDir, 'spawn-helper');

  mkdirSync(helperDir, { recursive: true });
  copyFileSync(sourceHelper, runtimeHelper);
  chmodSync(runtimeHelper, 0o755);

  return runtimeHelper;
}

const nodePtySpawnHelper = resolveNodePtySpawnHelper();
if (nodePtySpawnHelper) {
  process.env.NODE_PTY_SPAWN_HELPER = nodePtySpawnHelper;
}

const pty = require('node-pty');
const TUIParser = require('./lib/tui-parser');
const TmuxManager = require('./lib/tmux-manager');

const PORT = Number(process.env.PORT || 8080);
const AUTH_TOKEN = process.env.WS_TOKEN || 'D6E0311D-0880-4D8C-8884-3B1AD1F93491';
const TMUX_PATH = process.env.TMUX_PATH || '/opt/homebrew/bin/tmux';
const TMUX_SESSION_PATH = process.env.TMUX_SESSION_PATH || os.homedir();
const DEFAULT_TMUX_SESSION = process.env.TMUX_SESSION || 'mobile-dev';
const SERVER_TMUX_SESSION = process.env.SERVER_TMUX_SESSION || 'firefly-server';
const PROXY_ENABLE = process.env.PROXY_ENABLE === 'true';
const SCREEN_FPS = Math.min(Math.max(Number(process.env.SCREEN_FPS || 2), 1), 8);
const SCREEN_WEBP_FPS = Math.min(Math.max(Number(process.env.SCREEN_WEBP_FPS || 4), 1), 10);
const SCREEN_WEBP_WIDTH = Math.min(Math.max(Number(process.env.SCREEN_WEBP_WIDTH || 960), 480), 1920);
const SCREEN_WEBP_QUALITY = Math.min(Math.max(Number(process.env.SCREEN_WEBP_QUALITY || 55), 20), 90);
const TMP_DIR = path.join(RUNTIME_DIR, 'uploads');
const PUBLIC_DIR = path.join(SOURCE_DIR, 'public');
const TERMINAL_PAGE = path.join(PUBLIC_DIR, 'index.html');
const TERMINAL_CLIENT_SCRIPT = path.join(PUBLIC_DIR, 'terminal-client.js');
const KEYBOARD_PAGE = path.join(PUBLIC_DIR, 'keyboard.html');
const KEYBOARD_CLIENT_SCRIPT = path.join(PUBLIC_DIR, 'keyboard-client.js');

let currentTmuxSession = DEFAULT_TMUX_SESSION;
let proxyClient = null;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.yaml': 'text/yaml; charset=utf-8'
};

const STATIC_FILES = new Map([
  ['/assets/terminal-client.js', TERMINAL_CLIENT_SCRIPT],
  ['/assets/keyboard-client.js', KEYBOARD_CLIENT_SCRIPT],
  ['/vendor/react.production.min.js', path.join(PUBLIC_DIR, 'vendor', 'react.production.min.js')],
  ['/vendor/react-dom.production.min.js', path.join(PUBLIC_DIR, 'vendor', 'react-dom.production.min.js')],
  ['/vendor/zh-keyboard-react.umd.cjs', path.join(PUBLIC_DIR, 'vendor', 'zh-keyboard-react.umd.cjs')],
  ['/vendor/zh-keyboard-react.css', path.join(PUBLIC_DIR, 'vendor', 'zh-keyboard-react.css')]
]);

const CLAUDE_ACTION_MAP = {
  '1': '1\r',
  '2': '2\r',
  '3': '3\r',
  'y': 'y\r',
  'n': 'n\r',
  'c': 'c\r',
  'up': '\x1b[A',
  'down': '\x1b[B',
  'left': '\x1b[D',
  'right': '\x1b[C',
  'enter': '\r',
  'tab': '\t',
  'esc': '\x1b',
  'ctrl_c': '\x03',
  'delete': '\x7f'
};

const sessions = new Map();

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function getRequestUrl(req) {
  return new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
}

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': MIME['.json'] });
  res.end(JSON.stringify(payload));
}

function writeText(res, statusCode, text) {
  res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function writeHtml(res, statusCode, html) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(html);
}

function getCacheControl(filePath) {
  const relativePath = path.relative(PUBLIC_DIR, filePath).replace(/\\/g, '/');

  if (
    relativePath.startsWith('vendor/') ||
    relativePath.startsWith('assets/') ||
    relativePath.startsWith('pinyin-data/')
  ) {
    return 'public, max-age=31536000, immutable';
  }

  if (relativePath === 'keyboard.html') {
    return 'public, max-age=3600';
  }

  if (relativePath === 'index.html') {
    return 'public, max-age=300';
  }

  return 'public, max-age=3600';
}

function serveFile(res, filePath) {
  const ext = path.extname(filePath);
  const stream = createReadStream(filePath);

  stream.on('error', () => {
    writeText(res, 404, 'Not Found');
  });

  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': getCacheControl(filePath)
  });
  stream.pipe(res);
}

function resolvePublicAsset(pathname) {
  const normalizedPath = path.normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, '');
  const assetPath = path.join(PUBLIC_DIR, normalizedPath);

  if (!assetPath.startsWith(PUBLIC_DIR) || !existsSync(assetPath)) {
    return null;
  }

  return assetPath;
}

async function runTmux(args) {
  return execAsync(`${TMUX_PATH} ${args}`);
}

function normalizeSessionName(value) {
  return String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9_.:-]/g, '-')
    .slice(0, 64);
}

function isReservedTmuxSession(sessionName) {
  return sessionName === SERVER_TMUX_SESSION;
}

async function listTmuxSessions() {
  try {
    const { stdout } = await runTmux(`list-sessions -F '#{session_name}|#{session_windows}|#{session_attached}'`);
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !isReservedTmuxSession(line.split('|')[0]))
      .map((line) => {
        const [name, windows, attached] = line.split('|');
        return {
          name,
          windows: Number.parseInt(windows, 10) || 0,
          attached: Number.parseInt(attached, 10) || 0
        };
      });
  } catch (_error) {
    return [];
  }
}

async function tmuxSessionExists(sessionName) {
  if (!sessionName || isReservedTmuxSession(sessionName)) {
    return false;
  }

  try {
    await runTmux(`has-session -t ${shellQuote(sessionName)}`);
    return true;
  } catch (_error) {
    return false;
  }
}

async function resolveInitialTmuxSession(requestedSessionName) {
  const requested = normalizeSessionName(requestedSessionName);

  if (await tmuxSessionExists(requested)) {
    return requested;
  }

  if (await tmuxSessionExists(currentTmuxSession)) {
    return currentTmuxSession;
  }

  await ensureTmuxSession();
  return currentTmuxSession;
}

async function sendTmuxSessionList(ws, activeSessionName = currentTmuxSession) {
  ws.send(
    JSON.stringify({
      type: 'tmux_sessions',
      active: activeSessionName,
      sessions: await listTmuxSessions()
    })
  );
}

async function getFallbackSessionName(excludedSessionName) {
  const sessionsList = await listTmuxSessions();
  return sessionsList.find((item) => item.name !== excludedSessionName)?.name || '';
}

async function ensureTmuxSession() {
  try {
    await runTmux(`has-session -t ${shellQuote(currentTmuxSession)}`);
    console.log(`✅ tmux session '${currentTmuxSession}' already exists`);
    await applyTmuxStatusSpacing(currentTmuxSession);
    return;
  } catch (_error) {
    try {
      const { stdout } = await runTmux(`list-sessions -F '#{session_name}'`);
      const existing = stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)[0];

      if (existing) {
        currentTmuxSession = existing;
        console.log(`✅ Using existing tmux session '${currentTmuxSession}'`);
        await applyTmuxStatusSpacing(currentTmuxSession);
        return;
      }
    } catch (_listError) {
      // Fall through and create a new default session.
    }
  }

  await createTmuxSession(currentTmuxSession);
  console.log(`✅ Created tmux session '${currentTmuxSession}' at ${TMUX_SESSION_PATH}`);
}

async function createTmuxSession(sessionName) {
  await execAsync(
    `LANG=zh_CN.UTF-8 LC_ALL=zh_CN.UTF-8 ${TMUX_PATH} new-session -d -s ${shellQuote(
      sessionName
    )} -c ${shellQuote(TMUX_SESSION_PATH)}`
  );
  await applyTmuxStatusSpacing(sessionName);
}

async function applyTmuxStatusSpacing(sessionName) {
  const blankStatusLine = '#[bg=default,fg=default] ';

  await runTmux(`set-option -t ${shellQuote(sessionName)} status-style ${shellQuote('bg=default,fg=default')}`);
  await runTmux(`set-option -t ${shellQuote(sessionName)} status 4`);
  await runTmux(`set-option -t ${shellQuote(sessionName)} status-format[0] ${shellQuote(blankStatusLine)}`);
  await runTmux(
    `set-option -t ${shellQuote(sessionName)} status-format[1] ${shellQuote(blankStatusLine)}`
  );
  await runTmux(
    `set-option -t ${shellQuote(sessionName)} status-format[2] ${shellQuote(blankStatusLine)}`
  );
  await runTmux(
    `set-option -t ${shellQuote(sessionName)} status-format[3] ${shellQuote(blankStatusLine)}`
  );
}

function createAttachedPty(sessionName, cols = 120, rows = 35) {
  return pty.spawn(
    '/bin/bash',
    ['-lc', `LANG=zh_CN.UTF-8 LC_ALL=zh_CN.UTF-8 ${TMUX_PATH} attach -t ${shellQuote(sessionName)}`],
    {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: os.homedir(),
      encoding: null,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        LANG: 'zh_CN.UTF-8',
        LC_ALL: 'zh_CN.UTF-8',
        LC_CTYPE: 'zh_CN.UTF-8'
      }
    }
  );
}

function isValidSize(cols, rows) {
  return Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0;
}

function safeSend(session, data, options) {
  const { ws, pty: ptyProcess } = session;
  if (ws.readyState !== 1) {
    return;
  }

  if (ws.bufferedAmount > 100 * 1024 && typeof ptyProcess?.pause === 'function') {
    ws._paused = true;
    ptyProcess.pause();
  }

  ws.send(data, options);
}

function bindPty(session, ptyProcess) {
  session.ptyGeneration += 1;
  const generation = session.ptyGeneration;

  session.pty = ptyProcess;

  if (session.tui) {
    session.tui.pty = ptyProcess;
    session.tui.isWaiting = false;
  } else {
    session.tui = new TUIParser(session.ws, ptyProcess);
  }

  ptyProcess.onData((data) => {
    const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    session.tui.feed(text);
    safeSend(session, data, Buffer.isBuffer(data) ? { binary: true } : undefined);
  });

  ptyProcess.onExit(({ exitCode }) => {
    if (session.closed || session.isReplacingPty || generation !== session.ptyGeneration) {
      return;
    }

    console.log(`[!] PTY 退出: ${exitCode}`);
    session.closed = true;
    sessions.delete(session.id);

    if (session.ws.readyState === 1) {
      session.ws.close();
    }
  });
}

function closeSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session || session.closed) {
    return;
  }

  session.closed = true;
  sessions.delete(sessionId);

  try {
    session.pty?.kill();
  } catch (_error) {
    // PTY may already be closed.
  }
}

async function replaceSessionAttachment(session, nextSessionName) {
  const previousPty = session.pty;

  session.tmuxSession = nextSessionName;
  session.tmuxMgr.session = nextSessionName;
  session.isReplacingPty = true;

  try {
    if (previousPty) {
      try {
        previousPty.kill();
      } catch (_error) {
        // Old PTY may already be gone.
      }
    }

    const nextPty = createAttachedPty(nextSessionName, session.cols, session.rows);
    bindPty(session, nextPty);
  } finally {
    session.isReplacingPty = false;
  }
}

async function sendDirectoryList(ws, dirPath) {
  const items = await fs.readdir(dirPath, { withFileTypes: true });
  const fileList = items
    .map((item) => ({
      name: item.name,
      isDirectory: item.isDirectory(),
      path: path.join(dirPath, item.name)
    }))
    .sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });

  ws.send(
    JSON.stringify({
      type: 'directory_list',
      path: dirPath,
      items: fileList
    })
  );
}

async function commandExists(command) {
  try {
    await execAsync(`command -v ${shellQuote(command)}`);
    return true;
  } catch (_error) {
    return false;
  }
}

async function startScreenWebpStream(ws) {
  let closed = false;

  const stop = () => {
    closed = true;
  };

  ws.on('close', stop);
  ws.on('error', stop);

  while (!closed && ws.readyState === 1) {
    const startedAt = Date.now();
    try {
      const frame = await captureDesktopFrame();
      const webpFrame = await sharp(frame)
        .resize({ width: SCREEN_WEBP_WIDTH, withoutEnlargement: true })
        .webp({ quality: SCREEN_WEBP_QUALITY, effort: 1 })
        .toBuffer();

      if (ws.readyState === 1 && ws.bufferedAmount < 2 * 1024 * 1024) {
        ws.send(webpFrame, { binary: true });
      }
    } catch (error) {
      console.error('[ERR] WebP 屏幕帧失败:', error.message);
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'error', error: error.message }));
      }
      break;
    }

    const waitMs = Math.max(0, Math.round(1000 / SCREEN_WEBP_FPS) - (Date.now() - startedAt));
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  if (ws.readyState === 1) {
    ws.close();
  }
}
async function getScreenCaptureStatus(options = {}) {
  const shouldVerifyCapture = Boolean(options.verifyCapture);
  const withCaptureVerification = async (status) => {
    if (!shouldVerifyCapture || !status.ok) {
      return status;
    }

    try {
      await captureDesktopFrame();
      return {
        ...status,
        webpAvailable: true,
        transport: 'websocket',
        encoding: 'webp',
        permission: 'granted'
      };
    } catch (error) {
      return {
        ...status,
        ok: false,
        permission: process.platform === 'darwin' ? 'denied_or_unset' : 'unknown',
        error: process.platform === 'darwin'
          ? '无法读取屏幕画面，请给运行 server 的终端或 Firefly 程序授予“屏幕录制”权限，然后重启 server'
          : `无法读取屏幕画面: ${error.message}`
      };
    }
  };

  if (process.platform === 'darwin') {
    try {
      await execAsync('pgrep -x WindowServer');
    } catch (_error) {
      return {
        ok: false,
        platform: process.platform,
        guiAvailable: false,
        permission: 'unknown',
        error: '当前 server 没有检测到 macOS 图形桌面'
      };
    }

    return withCaptureVerification({
      ok: true,
      platform: process.platform,
      guiAvailable: true,
      webpAvailable: true,
      transport: 'websocket',
      encoding: 'webp',
      permission: 'unknown',
      permissionUrl: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
    });
  }

  if (process.platform === 'linux') {
    const guiAvailable = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);

    if (!guiAvailable) {
      return {
        ok: false,
        platform: process.platform,
        guiAvailable: false,
        permission: 'unknown',
        error: '当前 server 没有 DISPLAY/WAYLAND_DISPLAY，像是无 GUI 的 Linux 环境'
      };
    }

    const hasGnomeScreenshot = await commandExists('gnome-screenshot');
    const hasImport = await commandExists('import');

    if (!hasGnomeScreenshot && !hasImport) {
      return {
        ok: false,
        platform: process.platform,
        guiAvailable: true,
        permission: 'unknown',
        error: 'Linux 桌面需要安装 gnome-screenshot 或 ImageMagick import'
      };
    }

    return withCaptureVerification({
      ok: true,
      platform: process.platform,
      guiAvailable: true,
      webpAvailable: true,
      transport: 'websocket',
      encoding: 'webp',
      permission: 'unknown'
    });
  }

  return {
    ok: false,
    platform: process.platform,
    guiAvailable: false,
    permission: 'unknown',
    error: `暂不支持 ${process.platform} 的屏幕实况`
  };
}

async function captureDesktopFrame() {
  const framePath = path.join(TMP_DIR, `screen-${process.pid}-${Date.now()}.jpg`);

  try {
    if (process.platform === 'darwin') {
      await execFileAsync('/usr/sbin/screencapture', ['-x', '-t', 'jpg', framePath], { timeout: 8000 });
    } else if (process.platform === 'linux') {
      if (await commandExists('gnome-screenshot')) {
        await execFileAsync('gnome-screenshot', ['-f', framePath], { timeout: 8000 });
      } else {
        await execFileAsync('import', ['-window', 'root', framePath], { timeout: 8000 });
      }
    } else {
      throw new Error(`unsupported platform: ${process.platform}`);
    }

    const frame = await fs.readFile(framePath);
    if (!frame.length) {
      throw new Error('empty screen frame');
    }
    return frame;
  } finally {
    fs.unlink(framePath).catch(() => {});
  }
}

function getScreenPage(token) {
  const encodedToken = encodeURIComponent(token || '');

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=4,user-scalable=yes,viewport-fit=cover">
  <title>Firefly Screen Live</title>
  <style>
    html, body { margin: 0; width: 100%; height: 100%; background: #050505; color: #f2f2f2; overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { touch-action: pan-x pan-y pinch-zoom; }
    #stage { width: 100vw; height: 100vh; display: flex; align-items: center; justify-content: center; background: #050505; overflow: auto; -webkit-overflow-scrolling: touch; }
    #screen { width: 100%; height: 100%; object-fit: contain; background: #050505; user-select: none; -webkit-user-drag: none; }
    #panel { position: fixed; inset: 0; display: none; align-items: center; justify-content: center; padding: 28px; background: rgba(0,0,0,.82); box-sizing: border-box; text-align: center; }
    #panel.visible { display: flex; }
    #message { max-width: 680px; line-height: 1.55; font-size: 16px; color: #e8e8e8; }
    button { margin-top: 18px; border: 1px solid #5f8cff; background: #1e4fd6; color: #fff; border-radius: 6px; padding: 10px 14px; font-size: 14px; }
  </style>
</head>
<body>
  <div id="stage"><img id="screen" alt="server screen live"></div>
  <div id="panel"><div><div id="message">正在检测屏幕实况...</div><button id="permissionBtn" hidden>打开屏幕录制权限</button></div></div>
  <script>
    const token = ${JSON.stringify(encodedToken)};
    const screen = document.getElementById('screen');
    const panel = document.getElementById('panel');
    const message = document.getElementById('message');
    const permissionBtn = document.getElementById('permissionBtn');
    let currentUrl = '';
    let frameCount = 0;

    function showMessage(text, canOpenPermission) {
      message.textContent = text;
      permissionBtn.hidden = !canOpenPermission;
      panel.classList.add('visible');
    }

    function startStream() {
      panel.classList.remove('visible');
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(protocol + '//' + location.host + '/screen-ws?token=' + token);
      ws.binaryType = 'arraybuffer';

      ws.onmessage = (event) => {
        if (typeof event.data === 'string') {
          try {
            const data = JSON.parse(event.data);
            if (data.type === 'error') {
              showMessage(data.error || '屏幕实况不可用', false);
            }
          } catch (_error) {}
          return;
        }

        const blob = new Blob([event.data], { type: 'image/webp' });
        const nextUrl = URL.createObjectURL(blob);
        const previousUrl = currentUrl;
        currentUrl = nextUrl;
        screen.onload = () => {
          if (previousUrl) {
            URL.revokeObjectURL(previousUrl);
          }
        };
        screen.src = nextUrl;
        frameCount += 1;
        if (frameCount === 1) {
          panel.classList.remove('visible');
        }
      };

      ws.onerror = () => {
        showMessage('WebSocket 屏幕实况连接失败，请检查 server 是否已重启。', false);
      };

      ws.onclose = () => {
        if (!frameCount) {
          showMessage('屏幕实况已断开。', false);
        }
      };

      window.addEventListener('pagehide', () => {
        ws.close();
        if (currentUrl) {
          URL.revokeObjectURL(currentUrl);
        }
      }, { once: true });
    }

    async function checkStatus() {
      try {
        const res = await fetch('/api/screen/status?token=' + token, { cache: 'no-store' });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          showMessage(data.error || '屏幕实况不可用', Boolean(data.permissionUrl));
          return;
        }
        if (!data.webpAvailable) {
          showMessage('server 无法使用 WebP 屏幕实况。', false);
          return;
        }
        startStream();
      } catch (error) {
        showMessage('无法连接屏幕实况服务: ' + error.message, false);
      }
    }

    permissionBtn.addEventListener('click', async () => {
      await fetch('/api/screen/open-permissions?token=' + token, { method: 'POST' }).catch(() => {});
      showMessage('已尝试在 server 上打开系统设置。授权后请重启 Firefly server，再重新进入屏幕实况。', false);
    });

    checkStatus();
  </script>
</body>
</html>`;
}

async function handleNewSessionRequest(session, payload = {}) {
  const requestedName = normalizeSessionName(payload.name);
  const newSessionName = requestedName || `mobile-${Date.now()}`;
  await createTmuxSession(newSessionName);

  currentTmuxSession = newSessionName;
  await replaceSessionAttachment(session, newSessionName);

  session.ws.send(
    JSON.stringify({
      type: 'session_created',
      session: newSessionName,
      success: true
    })
  );
  await sendTmuxSessionList(session.ws, newSessionName);

  console.log(`[+] Created and attached to tmux session: ${newSessionName}`);
}

async function handleSwitchSessionRequest(session, payload = {}) {
  const nextSessionName = normalizeSessionName(payload.session || payload.name);

  if (!(await tmuxSessionExists(nextSessionName))) {
    session.ws.send(
      JSON.stringify({
        type: 'session_switched',
        session: nextSessionName,
        success: false,
        error: 'tmux session not found'
      })
    );
    await sendTmuxSessionList(session.ws, session.tmuxSession);
    return;
  }

  currentTmuxSession = nextSessionName;
  await applyTmuxStatusSpacing(nextSessionName);
  await replaceSessionAttachment(session, nextSessionName);

  session.ws.send(
    JSON.stringify({
      type: 'session_switched',
      session: nextSessionName,
      success: true
    })
  );
  await sendTmuxSessionList(session.ws, nextSessionName);

  console.log(`[~] Switched terminal ${session.id} to tmux session: ${nextSessionName}`);
}

async function handleCloseSessionRequest(session, payload = {}) {
  const targetSessionName = normalizeSessionName(payload.session || payload.name);

  if (!(await tmuxSessionExists(targetSessionName))) {
    session.ws.send(
      JSON.stringify({
        type: 'session_closed',
        session: targetSessionName,
        success: false,
        error: 'tmux session not found'
      })
    );
    await sendTmuxSessionList(session.ws, session.tmuxSession);
    return;
  }

  let nextSessionName = session.tmuxSession;

  if (targetSessionName === session.tmuxSession) {
    nextSessionName = await getFallbackSessionName(targetSessionName);

    if (!nextSessionName) {
      nextSessionName = targetSessionName === DEFAULT_TMUX_SESSION
        ? `mobile-${Date.now()}`
        : DEFAULT_TMUX_SESSION;
      await createTmuxSession(nextSessionName);
    }

    currentTmuxSession = nextSessionName;
    await replaceSessionAttachment(session, nextSessionName);
  }

  await runTmux(`kill-session -t ${shellQuote(targetSessionName)}`);

  if (currentTmuxSession === targetSessionName) {
    currentTmuxSession = nextSessionName;
  }

  session.ws.send(
    JSON.stringify({
      type: 'session_closed',
      session: targetSessionName,
      active: nextSessionName,
      success: true
    })
  );
  await sendTmuxSessionList(session.ws, nextSessionName);

  console.log(`[-] Closed tmux session: ${targetSessionName}`);
}

const httpServer = createServer((req, res) => {
  const reqUrl = getRequestUrl(req);
  const pathname = reqUrl.pathname;
  const reqToken = reqUrl.searchParams.get('token');

  if (pathname === '/health') {
    const health = { ok: true, tmuxSession: currentTmuxSession };
    if (PROXY_ENABLE && proxyClient) {
      health.proxy = proxyClient.getStatus();
    } else if (PROXY_ENABLE) {
      health.proxy = { enabled: true, connected: false, error: 'client not initialized' };
    } else {
      health.proxy = { enabled: false };
    }
    writeJson(res, 200, health);
    return;
  }

  if (pathname === '/api/tmux/sessions') {
    if (reqToken !== AUTH_TOKEN) {
      writeJson(res, 401, { ok: false, error: 'Unauthorized' });
      return;
    }

    listTmuxSessions()
      .then((tmuxSessions) => {
        writeJson(res, 200, {
          ok: true,
          active: currentTmuxSession,
          sessions: tmuxSessions
        });
      })
      .catch((error) => {
        writeJson(res, 500, { ok: false, error: error.message });
      });
    return;
  }

  if (pathname === '/api/screen/status') {
    if (reqToken !== AUTH_TOKEN) {
      writeJson(res, 401, { ok: false, error: 'Unauthorized' });
      return;
    }

    getScreenCaptureStatus({ verifyCapture: true })
      .then((status) => writeJson(res, status.ok ? 200 : 503, status))
      .catch((error) => {
        writeJson(res, 500, { ok: false, error: error.message });
      });
    return;
  }

  if (pathname === '/api/screen/open-permissions') {
    if (reqToken !== AUTH_TOKEN) {
      writeJson(res, 401, { ok: false, error: 'Unauthorized' });
      return;
    }

    if (req.method !== 'POST') {
      writeJson(res, 405, { ok: false, error: 'Method Not Allowed' });
      return;
    }

    if (process.platform !== 'darwin') {
      writeJson(res, 400, { ok: false, error: 'Only macOS supports opening screen recording settings' });
      return;
    }

    exec('open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"', (error) => {
      writeJson(res, error ? 500 : 200, {
        ok: !error,
        error: error?.message
      });
    });
    return;
  }

  if (pathname === '/api/screen/stream') {
    if (reqToken !== AUTH_TOKEN) {
      writeText(res, 401, 'Unauthorized');
      return;
    }

    getScreenCaptureStatus()
      .then(async (status) => {
        if (!status.ok) {
          writeJson(res, 503, status);
          return;
        }

        const boundary = `firefly-screen-${Date.now()}`;
        let closed = false;
        const intervalMs = Math.round(1000 / SCREEN_FPS);

        req.on('close', () => {
          closed = true;
        });

        res.writeHead(200, {
          'Content-Type': `multipart/x-mixed-replace; boundary=${boundary}`,
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
          Pragma: 'no-cache',
          Expires: '0',
          Connection: 'close'
        });

        while (!closed && !res.destroyed) {
          const startedAt = Date.now();
          try {
            const frame = await captureDesktopFrame();
            res.write(`--${boundary}\r\n`);
            res.write('Content-Type: image/jpeg\r\n');
            res.write(`Content-Length: ${frame.length}\r\n\r\n`);
            res.write(frame);
            res.write('\r\n');
          } catch (error) {
            console.error('[ERR] 屏幕实况截图失败:', error.message);
            if (!res.headersSent) {
              writeJson(res, 500, { ok: false, error: error.message });
            }
            break;
          }

          const waitMs = Math.max(0, intervalMs - (Date.now() - startedAt));
          await new Promise((resolve) => setTimeout(resolve, waitMs));
        }

        res.end();
      })
      .catch((error) => {
        writeJson(res, 500, { ok: false, error: error.message });
      });
    return;
  }

  if (pathname === '/screen') {
    if (reqToken !== AUTH_TOKEN) {
      writeText(res, 401, 'Unauthorized');
      return;
    }

    writeHtml(res, 200, getScreenPage(reqToken));
    return;
  }

  if (pathname === '/' || pathname === '/terminal' || pathname === '/keyboard') {
    if (reqToken !== AUTH_TOKEN) {
      writeText(res, 401, 'Unauthorized');
      return;
    }

    serveFile(res, pathname === '/keyboard' ? KEYBOARD_PAGE : TERMINAL_PAGE);
    return;
  }

  const staticFile = STATIC_FILES.get(pathname);
  if (staticFile) {
    serveFile(res, staticFile);
    return;
  }

  if (pathname.startsWith('/vendor/')) {
    const assetPath = resolvePublicAsset(pathname.slice(1));
    if (assetPath) {
      serveFile(res, assetPath);
      return;
    }
  }

  if (pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  writeText(res, 404, 'Not Found');
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', async (ws, req) => {
  const url = getRequestUrl(req);
  if (url.searchParams.get('token') !== AUTH_TOKEN) {
    ws.close(4001, 'Unauthorized');
    return;
  }

  if (url.pathname === '/screen-ws') {
    console.log('[+] 屏幕 WebSocket 连接');
    try {
      await startScreenWebpStream(ws);
    } catch (error) {
      console.error('[ERR] 屏幕 WebSocket 启动失败:', error.message);
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'error', error: error.message }));
        ws.close();
      }
    }
    return;
  }

  const initialTmuxSession = await resolveInitialTmuxSession(url.searchParams.get('session'));

  const sessionId = uuidv4();
  const session = {
    id: sessionId,
    ws,
    pty: null,
    tui: null,
    tmuxMgr: new TmuxManager(initialTmuxSession),
    tmuxSession: initialTmuxSession,
    cols: 120,
    rows: 35,
    closed: false,
    ptyGeneration: 0,
    isReplacingPty: false
  };

  sessions.set(sessionId, session);
  bindPty(session, createAttachedPty(session.tmuxSession, session.cols, session.rows));

  console.log(`[+] 终端连接: ${sessionId} -> ${session.tmuxSession}`);

  ws.on('drain', () => {
    if (ws._paused) {
      ws._paused = false;
      session.pty?.resume?.();
    }
  });

  ws.on('message', async (msg, isBinary) => {
    try {
      if (isBinary) {
        const rawInput = Buffer.isBuffer(msg) ? msg.toString('utf8') : Buffer.from(msg).toString('utf8');
        session.pty?.write(rawInput);
        return;
      }

      const msgStr =
        typeof msg === 'string' ? msg : Buffer.isBuffer(msg) ? msg.toString('utf8') : Buffer.from(msg).toString('utf8');

      let payload;
      try {
        payload = JSON.parse(msgStr);
      } catch (_error) {
        session.pty?.write(msgStr);
        return;
      }

      // Raw terminal input like "1" is valid JSON, but it is not a control packet.
      if (!payload || typeof payload !== 'object' || typeof payload.type !== 'string') {
        session.pty?.write(msgStr);
        return;
      }

      switch (payload.type) {
        case 'input':
          if (typeof payload.data === 'string') {
            session.pty?.write(payload.data);
          }
          break;

        case 'resize':
          if (isValidSize(payload.cols, payload.rows)) {
            session.cols = payload.cols;
            session.rows = payload.rows;
            session.pty?.resize(payload.cols, payload.rows);
          }
          break;

        case 'upload_file': {
          const ext = payload.ext || 'txt';
          const fileName = `${uuidv4()}.${ext}`;
          const filePath = path.join(TMP_DIR, fileName);
          await fs.writeFile(filePath, Buffer.from(payload.content, 'base64'));
          session.pty?.write(filePath);
          console.log(`[+] 文件已上传: ${filePath}`);
          break;
        }

        case 'claude_action':
          if (CLAUDE_ACTION_MAP[payload.action]) {
            session.pty?.write(CLAUDE_ACTION_MAP[payload.action]);
          }
          break;

        case 'tui_action':
          session.tui?.handleAction(payload.key);
          break;

        case 'tmux_ctrl': {
          let res;

          if (payload.action === 'list') {
            res = await session.tmuxMgr.getLayout();
          } else if (payload.action === 'split') {
            await session.tmuxMgr.split(payload.dir);
          } else if (payload.action === 'switch') {
            await session.tmuxMgr.switchTo(payload.index);
          } else if (payload.action === 'close') {
            await session.tmuxMgr.closePane(payload.index);
          } else if (payload.action === 'new_session') {
            await handleNewSessionRequest(session, payload);
          } else if (payload.action === 'list_sessions') {
            await sendTmuxSessionList(ws, session.tmuxSession);
          } else if (payload.action === 'switch_session') {
            await handleSwitchSessionRequest(session, payload);
          } else if (payload.action === 'close_session') {
            await handleCloseSessionRequest(session, payload);
          }

          if (res) {
            ws.send(JSON.stringify({ type: 'tmux_state', data: res }));
          }
          break;
        }

        case 'tmux_scroll':
          if (payload.action === 'page_up') {
            await session.tmuxMgr.scrollPageUp();
          } else if (payload.action === 'page_down') {
            await session.tmuxMgr.scrollPageDown();
          } else if (payload.action === 'to_top') {
            await session.tmuxMgr.scrollToTop();
          } else if (payload.action === 'to_bottom') {
            await session.tmuxMgr.scrollToBottom();
          }
          break;

        case 'get_cwd': {
          try {
            const { stdout } = await runTmux(
              `display-message -p -t ${shellQuote(session.tmuxSession)} '#{pane_current_path}'`
            );
            ws.send(JSON.stringify({ type: 'cwd_response', path: stdout.trim() }));
          } catch (error) {
            ws.send(JSON.stringify({ type: 'cwd_response', error: error.message }));
          }
          break;
        }

        case 'list_directory':
          try {
            const dirPath = payload.path || os.homedir();
            await sendDirectoryList(ws, dirPath);
          } catch (error) {
            ws.send(
              JSON.stringify({
                type: 'directory_list',
                error: error.message,
                path: payload.path
              })
            );
          }
          break;

        case 'recover_screen': {
          try {
            const { stdout } = await runTmux(
              `capture-pane -e -p -t ${shellQuote(session.tmuxSession)}`
            );
            if (stdout) {
              safeSend(session, stdout);
            }
          } catch (_error) {
            // Ignore recovery failures so the live attach can still continue.
          }

          ws.send(JSON.stringify({ type: 'screen_recovered' }));
          break;
        }

        case 'new_session':
          await handleNewSessionRequest(session, payload);
          break;

        case 'list_sessions':
          await sendTmuxSessionList(ws, session.tmuxSession);
          break;

        case 'switch_session':
          await handleSwitchSessionRequest(session, payload);
          break;

        case 'close_session':
          await handleCloseSessionRequest(session, payload);
          break;

        case 'ping':
          ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
          break;

        default:
          break;
      }
    } catch (error) {
      console.error('[ERR] 消息解析失败:', error.message);
    }
  });

  ws.on('close', () => {
    console.log(`[-] 连接断开: ${sessionId}`);
    closeSession(sessionId);
  });

  ws.send(JSON.stringify({ type: 'connected', sessionId, tmux: session.tmuxSession }));
  sendTmuxSessionList(ws, session.tmuxSession).catch((error) => {
    console.error('[ERR] 发送 tmux 会话列表失败:', error.message);
  });
});

async function start() {
  await fs.mkdir(TMP_DIR, { recursive: true });
  await ensureTmuxSession();

  console.log(`✅ Node 网关已启动: ws://0.0.0.0:${PORT}`);
  console.log(`🔑 Token: ${AUTH_TOKEN}`);

  // 条件启动内网穿透
  if (PROXY_ENABLE) {
    const { createProxyClient } = require('./lib/proxy-client/proxy-client-container');
    proxyClient = createProxyClient();
    if (proxyClient) {
      proxyClient.start();
      console.log(`✅ 内网穿透客户端已启动`);
    } else {
      console.warn(`⚠️ 内网穿透启用但配置不完整，未启动 (需要 PROXY_CLIENT_KEY 和 PROXY_SERVER_HOST)`);
    }
  } else {
    console.log(`ℹ️ 内网穿透未启用 (设置 PROXY_ENABLE=true 启用)`);
  }

  httpServer.listen(PORT, () => {
    console.log(`🌐 Terminal页面: http://0.0.0.0:${PORT}/terminal?token=${AUTH_TOKEN}`);
  });
}

function gracefulShutdown() {
  console.log('Shutting down...');
  if (proxyClient) {
    proxyClient.stop();
    console.log('✅ 内网穿透客户端已停止');
  }
  process.exit(0);
}

start().catch((error) => {
  console.error('[ERR] 启动失败:', error);
  process.exit(1);
});

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
