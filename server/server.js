const { WebSocketServer } = require('ws');
const { createServer } = require('http');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs/promises');
const { createReadStream, existsSync, copyFileSync, chmodSync, mkdirSync } = require('fs');
const path = require('path');
const os = require('os');
const { exec, execFile, spawn } = require('child_process');
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

function readBoundedNumberEnv(name, defaultValue, min, max) {
  const value = Number(process.env[name] ?? defaultValue);
  if (!Number.isFinite(value)) {
    return defaultValue;
  }
  return Math.min(Math.max(value, min), max);
}

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
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const SCREEN_STREAM_FPS = (() => {
  const fps = Math.min(Math.max(Number(process.env.SCREEN_STREAM_FPS || 24), 5), 30);
  const supported = [24, 25, 30];
  return supported.reduce((best, item) => (Math.abs(item - fps) < Math.abs(best - fps) ? item : best), 24);
})();
const SCREEN_STREAM_WIDTH = (() => {
  const width = Number(process.env.SCREEN_STREAM_WIDTH ?? 1024);
  if (!Number.isFinite(width) || width <= 0) {
    return 0;
  }
  return Math.min(Math.max(width, 480), 1920);
})();
const SCREEN_STREAM_QUALITY = readBoundedNumberEnv('SCREEN_STREAM_QUALITY', 2, 1, 31);
const SCREEN_STREAM_QMAX = Math.max(
  readBoundedNumberEnv('SCREEN_STREAM_QMAX', 6, 1, 31),
  SCREEN_STREAM_QUALITY
);
const SCREEN_STREAM_BITRATE = process.env.SCREEN_STREAM_BITRATE || '2200k';
const SCREEN_STREAM_BUFFER_SIZE = process.env.SCREEN_STREAM_BUFFER_SIZE || '800k';
const SCREEN_STREAM_GOP = readBoundedNumberEnv(
  'SCREEN_STREAM_GOP',
  Math.round(SCREEN_STREAM_FPS / 2),
  1,
  SCREEN_STREAM_FPS * 2
);
const SCREEN_STREAM_MUXDELAY = process.env.SCREEN_STREAM_MUXDELAY || '0';
const SCREEN_STREAM_DROP_DUPLICATE_FRAMES = process.env.SCREEN_STREAM_DROP_DUPLICATE_FRAMES === 'true';
const SCREEN_STREAM_DEDUP_FILTER = process.env.SCREEN_STREAM_DEDUP_FILTER || 'mpdecimate=hi=768:lo=320:frac=0.33';
const SCREEN_STREAM_MAX_BUFFERED_BYTES = Math.min(
  Math.max(Number(process.env.SCREEN_STREAM_MAX_BUFFERED_BYTES || 512 * 1024), 256 * 1024),
  16 * 1024 * 1024
);
const SCREEN_STREAM_INPUT = process.env.SCREEN_STREAM_INPUT || (process.platform === 'darwin' ? 'Capture screen 0:none' : ':0.0');

// macOS virtual keycodes for CGEventCreateKeyboardEvent
const MAC_KEYCODE = {
  a:0, s:1, d:2, f:3, h:4, g:5, z:6, x:7, c:8, v:9, b:11, q:12, w:13, e:14, r:15,
  y:16, t:17, '1':18, '2':19, '3':20, '4':21, '6':22, '5':23, '=':24, '9':25, '7':26,
  '-':27, '8':29, '0':28, ']':30, o:31, u:32, '[':33, i:34, p:35, l:37, j:38, '\'':39,
  k:40, ';':41, '\\':42, ',':43, '/':44, n:45, m:46, '.':47, '`':50,
  enter:36, tab:48, space:49, delete:51, escape:53, backspace:51, capslock:57,
  ctrl:59, shift:56, alt:58, cmd:55, fn:63,
  up:126, down:125, left:123, right:124,
  f1:122, f2:120, f3:99, f4:118, f5:96, f6:97, f7:98, f8:100, f9:101, f10:109, f11:103, f12:111,
  insert:114, home:115, end:119, pageup:116, pagedown:121
};

// xdotool key name mapping
const XDO_KEY = {
  escape:'Escape', tab:'Tab', enter:'Return', space:'space', backspace:'BackSpace', delete:'Delete',
  up:'Up', down:'Down', left:'Left', right:'Right',
  f1:'F1', f2:'F2', f3:'F3', f4:'F4', f5:'F5', f6:'F6', f7:'F7', f8:'F8', f9:'F9', f10:'F10', f11:'F11', f12:'F12',
  insert:'Insert', home:'Home', end:'End', pageup:'Prior', pagedown:'Next',
  '`':'grave', '\\':'backslash',
  ctrl:'ctrl', shift:'shift', alt:'alt', cmd:'super', capslock:'Caps_Lock'
};

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
  ['/vendor/jsmpeg-player.umd.min.js', path.join(PUBLIC_DIR, 'vendor', 'jsmpeg-player.umd.min.js')],
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
let lastScreenImageBounds = null;
let lastScreenControlBounds = null;
let macMouseQueue = Promise.resolve();
let macPendingMove = null;
let macPendingMoveResolvers = [];
let macMoveFlushTimer = null;

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

function getScreenStreamFfmpegArgs() {
  const outputArgs = [
    '-an',
    '-c:v', 'mpeg1video',
    '-q:v', String(SCREEN_STREAM_QUALITY),
    '-maxrate', SCREEN_STREAM_BITRATE,
    '-bufsize', SCREEN_STREAM_BUFFER_SIZE,
    '-qmin', String(SCREEN_STREAM_QUALITY),
    '-qmax', String(SCREEN_STREAM_QMAX),
    '-bf', '0',
    '-g', String(SCREEN_STREAM_GOP),
    '-f', 'mpegts',
    '-muxdelay', SCREEN_STREAM_MUXDELAY,
    '-muxpreload', '0',
    '-flush_packets', '1',
    'pipe:1'
  ];

  const filters = [];
  if (SCREEN_STREAM_WIDTH > 0) {
    filters.push(`scale=${SCREEN_STREAM_WIDTH}:-2`);
  }
  filters.push('format=yuv420p');
  if (SCREEN_STREAM_DROP_DUPLICATE_FRAMES) {
    filters.push(SCREEN_STREAM_DEDUP_FILTER);
    outputArgs.unshift('-fps_mode', 'vfr');
  } else {
    outputArgs.unshift('-r', String(SCREEN_STREAM_FPS));
  }

  if (process.platform === 'darwin') {
    return [
      '-hide_banner',
      '-loglevel', 'warning',
      '-fflags', 'nobuffer',
      '-flags', 'low_delay',
      '-f', 'avfoundation',
      '-pixel_format', 'uyvy422',
      '-framerate', String(SCREEN_STREAM_FPS),
      '-capture_cursor', '1',
      '-capture_mouse_clicks', '0',
      '-i', SCREEN_STREAM_INPUT,
      '-vf', filters.join(','),
      ...outputArgs
    ];
  }

  if (process.platform === 'linux') {
    const linuxInput = process.env.SCREEN_STREAM_INPUT || process.env.DISPLAY || ':0.0';
    return [
      '-hide_banner',
      '-loglevel', 'warning',
      '-fflags', 'nobuffer',
      '-flags', 'low_delay',
      '-f', 'x11grab',
      '-draw_mouse', '1',
      '-framerate', String(SCREEN_STREAM_FPS),
      '-i', linuxInput,
      '-vf', filters.join(','),
      ...outputArgs
    ];
  }

  throw new Error(`暂不支持 ${process.platform} 的推流屏幕采集`);
}

function getLinuxX11Env() {
  const env = { ...process.env };
  if (process.platform !== 'linux') {
    return env;
  }

  if (!env.DISPLAY) {
    env.DISPLAY = ':0';
  }

  if (!env.XAUTHORITY) {
    const candidates = [
      path.join(os.homedir(), '.Xauthority'),
      path.join(os.tmpdir(), `.X11-unix/X${env.DISPLAY.replace(/^:/, '')}`),
      `/run/user/${process.getuid?.() || 1000}/gdm/Xauthority`,
      `/run/user/${process.getuid?.() || 1000}/.mutter-Xauthority`,
    ];
    for (const p of candidates) {
      if (existsSync(p)) {
        env.XAUTHORITY = p;
        break;
      }
    }
  }

  return env;
}

function startScreenMpegTsStream(ws) {
  const args = getScreenStreamFfmpegArgs();
  const env = getLinuxX11Env();
  const ffmpeg = spawn(FFMPEG_PATH, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  let closed = false;
  let stderr = '';

  if (process.platform === 'linux') {
    console.log(`[+] 屏幕 MPEG-TS 推流启动: DISPLAY=${env.DISPLAY || '(none)'} XAUTHORITY=${env.XAUTHORITY || '(none)'} ${FFMPEG_PATH} ${args.map(shellQuote).join(' ')}`);
  } else {
    console.log(`[+] 屏幕 MPEG-TS 推流启动: ${FFMPEG_PATH} ${args.map(shellQuote).join(' ')}`);
  }

  const stop = () => {
    if (closed) {
      return;
    }
    closed = true;
    if (!ffmpeg.killed) {
      ffmpeg.kill('SIGTERM');
      setTimeout(() => {
        if (!ffmpeg.killed) {
          ffmpeg.kill('SIGKILL');
        }
      }, 1200).unref();
    }
  };

  ws.on('close', stop);
  ws.on('error', stop);

  ffmpeg.stdout.on('data', (chunk) => {
    if (closed || ws.readyState !== 1) {
      return;
    }
    if (ws.bufferedAmount > SCREEN_STREAM_MAX_BUFFERED_BYTES) {
      return;
    }
    ws.send(chunk, { binary: true }, (error) => {
      if (error) {
        stop();
      }
    });
  });

  ffmpeg.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4000);
  });

  ffmpeg.on('error', (error) => {
    console.error('[ERR] 屏幕 MPEG-TS 推流启动失败:', error.message);
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'error', error: `ffmpeg 启动失败: ${error.message}` }));
    }
    stop();
  });

  ffmpeg.on('close', (code, signal) => {
    if (!closed) {
      console.error(`[ERR] 屏幕 MPEG-TS 推流退出: code=${code} signal=${signal} ${stderr.trim()}`);
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'error', error: stderr.trim() || `ffmpeg exited: ${code ?? signal}` }));
      }
    }
    if (ws.readyState === 1) {
      ws.close();
    }
  });

  return stop;
}

function bindScreenControlSocket(ws) {
  ws.on('message', async (msg, isBinary) => {
    if (isBinary) {
      return;
    }

    try {
      const msgStr =
        typeof msg === 'string' ? msg : Buffer.isBuffer(msg) ? msg.toString('utf8') : Buffer.from(msg).toString('utf8');
      const payload = JSON.parse(msgStr);

      if (payload?.type === 'screen_mouse') {
        handleScreenMouse(payload).catch((error) => {
          console.error('[ERR] 屏幕鼠标控制失败:', error.message);
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'control_error', error: error.message }));
          }
        });
      } else if (payload?.type === 'screen_keyboard') {
        handleScreenKeyboard(payload).catch((error) => {
          console.error('[ERR] 屏幕键盘控制失败:', error.message);
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'control_error', error: error.message }));
          }
        });
      }
    } catch (error) {
      console.error('[ERR] 屏幕控制失败:', error.message);
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'control_error', error: error.message }));
      }
    }
  });
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
        transport: 'mpegts-websocket',
        encoding: 'mpeg1video-mpegts',
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
      transport: 'mpegts-websocket',
      encoding: 'mpeg1video-mpegts',
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
      transport: 'mpegts-websocket',
      encoding: 'mpeg1video-mpegts',
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
      await execFileAsync('/usr/sbin/screencapture', ['-x', '-C', '-t', 'jpg', framePath], { timeout: 8000 });
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

    try {
      const metadata = await sharp(frame).metadata();
      if (metadata.width && metadata.height) {
        lastScreenImageBounds = { width: metadata.width, height: metadata.height };
        lastScreenControlBounds = await getScreenControlBounds(lastScreenImageBounds);
      }
    } catch (_error) {
      // Keep the previous bounds; mouse control can continue with the last good frame size.
    }

    return frame;
  } finally {
    fs.unlink(framePath).catch(() => {});
  }
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return min;
  }
  return Math.min(Math.max(number, min), max);
}

function getMouseButton(button) {
  if (button === 'right') return 'right';
  if (button === 'middle') return 'middle';
  return 'left';
}

async function handleScreenMouse(payload) {
  if (!lastScreenControlBounds?.width || !lastScreenControlBounds?.height) {
    throw new Error('屏幕尺寸尚未就绪，请等首帧加载后再操作');
  }

  const button = getMouseButton(payload.button);
  const action = String(payload.action || 'click');

  if (action === 'move_relative') {
    const dx = clampNumber(payload.dx, -1, 1) * lastScreenControlBounds.width;
    const dy = clampNumber(payload.dy, -1, 1) * lastScreenControlBounds.height;
    await performMouseAction({ action, x: 0, y: 0, dx, dy, button });
    return;
  }

  if (action === 'click_current') {
    await performMouseAction({ action, x: 0, y: 0, button });
    return;
  }

  if (action === 'down_current' || action === 'up_current') {
    await performMouseAction({ action, x: 0, y: 0, button });
    return;
  }

  if (action === 'scroll_current') {
    const dx = Math.round(clampNumber(payload.dx, -2400, 2400));
    const dy = Math.round(clampNumber(payload.dy, -2400, 2400));
    await performMouseAction({ action, x: 0, y: 0, dx, dy, button });
    return;
  }

  const x = lastScreenControlBounds.x + clampNumber(payload.x, 0, 1) * (lastScreenControlBounds.width - 1);
  const y = lastScreenControlBounds.y + clampNumber(payload.y, 0, 1) * (lastScreenControlBounds.height - 1);

  if (action === 'scroll') {
    const dx = Math.round(clampNumber(payload.dx, -2400, 2400));
    const dy = Math.round(clampNumber(payload.dy, -2400, 2400));
    await performMouseAction({ action, x, y, dx, dy, button });
    return;
  }

  if (!['move', 'down', 'up', 'click'].includes(action)) {
    return;
  }

  await performMouseAction({ action, x, y, button });
}

async function handleScreenKeyboard(payload) {
  const action = String(payload.action || '');
  const key = String(payload.key || '');
  const text = String(payload.text || '');
  const modifiers = Array.isArray(payload.modifiers) ? payload.modifiers : [];

  if (action === 'type_text' && text) {
    if (process.platform === 'darwin') {
      const b64 = Buffer.from(text, 'utf8').toString('base64');
      sendToMacDaemon(`type_text ${b64}`);
    } else {
      await performLinuxKeyboardAction({ action: 'type_text', text });
    }
    return;
  }

  if (!key) return;

  if (process.platform === 'darwin') {
    await performMacKeyboardAction({ action, key, modifiers });
  } else {
    const xdoKey = XDO_KEY[key.toLowerCase()] || key;
    const xdoMods = modifiers.map(m => XDO_KEY[m] || m).filter(Boolean);
    await performLinuxKeyboardAction({ action, key: xdoKey, modifiers: xdoMods });
  }
}

async function getScreenControlBounds(imageBounds) {
  if (process.platform === 'darwin') {
    try {
      const script = `
ObjC.import('ApplicationServices');
const id = $.CGMainDisplayID();
const bounds = $.CGDisplayBounds(id);
JSON.stringify({
  x: bounds.origin.x,
  y: bounds.origin.y,
  width: bounds.size.width,
  height: bounds.size.height,
  pixelWidth: $.CGDisplayPixelsWide(id),
  pixelHeight: $.CGDisplayPixelsHigh(id)
});
`;
      const { stdout } = await execFileAsync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { timeout: 3000 });
      const data = JSON.parse(stdout.trim());
      if (data.width && data.height) {
        return {
          x: Number(data.x) || 0,
          y: Number(data.y) || 0,
          width: Number(data.width),
          height: Number(data.height),
          pixelWidth: Number(data.pixelWidth) || imageBounds?.width,
          pixelHeight: Number(data.pixelHeight) || imageBounds?.height
        };
      }
    } catch (error) {
      console.error('[ERR] 获取 macOS 屏幕控制尺寸失败:', error.message);
    }
  }

  return {
    x: 0,
    y: 0,
    width: imageBounds?.width || 1,
    height: imageBounds?.height || 1,
    pixelWidth: imageBounds?.width || 1,
    pixelHeight: imageBounds?.height || 1
  };
}

async function getScreenMouseState() {
  if (!lastScreenControlBounds?.width || !lastScreenControlBounds?.height) {
    return null;
  }

  let point;
  if (process.platform === 'darwin') {
    const script = `
ObjC.import('ApplicationServices');
const event = $.CGEventCreate(null);
const point = $.CGEventGetLocation(event);
JSON.stringify({ x: point.x, y: point.y });
`;
    const { stdout } = await execFileAsync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { timeout: 3000 });
    point = JSON.parse(stdout.trim());
  } else if (process.platform === 'linux') {
    if (!(await commandExists('xdotool'))) {
      return null;
    }
    const { stdout } = await execFileAsync('xdotool', ['getmouselocation', '--shell'], { timeout: 3000 });
    const values = Object.fromEntries(
      stdout
        .split('\n')
        .map((line) => line.trim().split('='))
        .filter((parts) => parts.length === 2)
    );
    point = { x: Number(values.X), y: Number(values.Y) };
  } else {
    return null;
  }

  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    return null;
  }

  return {
    x: clampNumber((point.x - lastScreenControlBounds.x) / Math.max(1, lastScreenControlBounds.width - 1), 0, 1),
    y: clampNumber((point.y - lastScreenControlBounds.y) / Math.max(1, lastScreenControlBounds.height - 1), 0, 1)
  };
}

async function performMouseAction(event) {
  if (process.platform === 'darwin') {
    await queueMacMouseAction(event);
    return;
  }

  if (process.platform === 'linux') {
    await performLinuxMouseAction(event);
    return;
  }

  throw new Error(`暂不支持 ${process.platform} 的鼠标控制`);
}

function queueMacMouseAction(event) {
  if (event.action === 'move_relative') {
    return queueMacRelativeMove(event);
  }

  macMouseQueue = macMouseQueue
    .catch(() => {})
    .then(() => performMacMouseAction(event));
  return macMouseQueue;
}

function queueMacRelativeMove(event) {
  if (!macPendingMove) {
    macPendingMove = { ...event, dx: 0, dy: 0 };
  }

  macPendingMove.dx += event.dx || 0;
  macPendingMove.dy += event.dy || 0;

  const promise = new Promise((resolve, reject) => {
    macPendingMoveResolvers.push({ resolve, reject });
  });

  if (!macMoveFlushTimer) {
    macMoveFlushTimer = setTimeout(() => {
      macMoveFlushTimer = null;
      const move = macPendingMove;
      const resolvers = macPendingMoveResolvers;
      macPendingMove = null;
      macPendingMoveResolvers = [];

      macMouseQueue = macMouseQueue
        .catch(() => {})
        .then(() => performMacMouseAction(move));

      macMouseQueue.then(
        () => resolvers.forEach(({ resolve }) => resolve()),
        (error) => resolvers.forEach(({ reject }) => reject(error))
      );
    }, 16);
  }

  return promise;
}

// --- macOS persistent mouse daemon (avoids spawning osascript per event) ---
let macMouseDaemon = null;
let macMouseReady = false;
let macMousePending = [];

function ensureMacMouseDaemon() {
  if (macMouseDaemon && !macMouseDaemon.killed) return;
  macMouseReady = false;
  macMousePending = [];

  const daemonScript = `
ObjC.import('ApplicationServices');
ObjC.import('Foundation');

var buttons = {
  left: { button: $.kCGMouseButtonLeft, down: $.kCGEventLeftMouseDown, up: $.kCGEventLeftMouseUp },
  right: { button: $.kCGMouseButtonRight, down: $.kCGEventRightMouseDown, up: $.kCGEventRightMouseUp },
  middle: { button: $.kCGMouseButtonCenter, down: $.kCGEventOtherMouseDown, up: $.kCGEventOtherMouseUp }
};

function post(ev) { $.CGEventPost($.kCGHIDEventTap, ev); }

var heldButton = null;

var dragEvents = {
  left: $.kCGEventLeftMouseDragged,
  right: $.kCGEventRightMouseDragged,
  middle: $.kCGEventOtherMouseDragged
};

var modFlags = {
  shift: $.kCGEventFlagMaskShift,
  ctrl: $.kCGEventFlagMaskControl,
  alt: $.kCGEventFlagMaskAlternate,
  cmd: $.kCGEventFlagMaskCommand,
  fn: $.kCGEventFlagMaskSecondaryFn
};

function makeKeyEvent(keycode, down, mods) {
  var src = $.CGEventSourceCreate($.kCGEventSourceStateHIDSystemState);
  var ev = $.CGEventCreateKeyboardEvent(src, keycode, down);
  if ($.kCGKeyboardEventAutorepeat !== undefined) {
    $.CGEventSetIntegerValueField(ev, $.kCGKeyboardEventAutorepeat, 0);
  }
  if (mods) {
    var flags = 0;
    var modList = mods.split(',');
    for (var i = 0; i < modList.length; i++) {
      var m = modList[i].trim();
      if (modFlags[m]) flags = flags | modFlags[m];
    }
    if (flags) $.CGEventSetFlags(ev, flags);
  }
  return ev;
}

var modifierKeycodes = {
  shift: 56,
  ctrl: 59,
  alt: 58,
  cmd: 55,
  fn: 63
};

function parseMods(mods) {
  if (!mods) return [];
  var out = [];
  var seen = {};
  var modList = mods.split(',');
  for (var i = 0; i < modList.length; i++) {
    var m = modList[i].trim();
    if (modifierKeycodes[m] !== undefined && !seen[m]) {
      seen[m] = true;
      out.push(m);
    }
  }
  return out;
}

function postModifierKeys(modList, down) {
  var list = down ? modList : modList.slice().reverse();
  for (var i = 0; i < list.length; i++) {
    post(makeKeyEvent(modifierKeycodes[list[i]], down, ''));
  }
}

function postKeyPress(keycode, mods) {
  var modList = parseMods(mods);
  postModifierKeys(modList, true);
  post(makeKeyEvent(keycode, true, mods));
  post(makeKeyEvent(keycode, false, mods));
  postModifierKeys(modList, false);
}

function b64decode(str) {
  var data = $.NSData.alloc.initWithBase64EncodedStringOptions(str, $.NSDataBase64DecodingIgnoreUnknownCharacters);
  return $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js;
}

var finderActivated = false;
function ensureFinderActive() {
  if (finderActivated) return;
  try {
    var se = Application('System Events');
    var procs = se.processes();
    var frontName = '';
    for (var i = 0; i < procs.length; i++) {
      if (procs[i].frontmost()) {
        frontName = procs[i].name();
        break;
      }
    }
    if (frontName === 'Terminal' || frontName === 'iTerm2' || frontName === 'iTerm' || frontName === 'Warp' || frontName === 'Hyper' || frontName === 'Tabby' || frontName === 'kitty') {
      Application('Finder').activate();
    }
    finderActivated = true;
  } catch (e) {}
}

function handle(line) {
  var parts = line.split(' ');
  var action = parts[0];
  var btn = parts[1] || 'left';
  var x = parseFloat(parts[2]) || 0;
  var y = parseFloat(parts[3]) || 0;
  var dx = parseFloat(parts[4]) || 0;
  var dy = parseFloat(parts[5]) || 0;

  if (action === 'move_relative') {
    var ev = $.CGEventCreate(null);
    var cur = $.CGEventGetLocation(ev);
    var eventType = heldButton ? dragEvents[heldButton] : $.kCGEventMouseMoved;
    post($.CGEventCreateMouseEvent(null, eventType, { x: cur.x + dx, y: cur.y + dy }, $.kCGMouseButtonLeft));
  } else if (action === 'move') {
    var eventType = heldButton ? dragEvents[heldButton] : $.kCGEventMouseMoved;
    post($.CGEventCreateMouseEvent(null, eventType, { x: x, y: y }, $.kCGMouseButtonLeft));
  } else if (action === 'click_current') {
    var ev = $.CGEventCreate(null);
    var cur = $.CGEventGetLocation(ev);
    var p = { x: cur.x, y: cur.y };
    post($.CGEventCreateMouseEvent(null, buttons[btn].down, p, buttons[btn].button));
    post($.CGEventCreateMouseEvent(null, buttons[btn].up, p, buttons[btn].button));
  } else if (action === 'down_current') {
    var ev = $.CGEventCreate(null);
    var cur = $.CGEventGetLocation(ev);
    post($.CGEventCreateMouseEvent(null, buttons[btn].down, { x: cur.x, y: cur.y }, buttons[btn].button));
    heldButton = btn;
  } else if (action === 'up_current') {
    var ev = $.CGEventCreate(null);
    var cur = $.CGEventGetLocation(ev);
    post($.CGEventCreateMouseEvent(null, buttons[btn].up, { x: cur.x, y: cur.y }, buttons[btn].button));
    if (heldButton === btn) heldButton = null;
  } else if (action === 'scroll_current') {
    var wy = Math.max(-1200, Math.min(1200, Math.round(-dy)));
    var wx = Math.max(-1200, Math.min(1200, Math.round(-dx)));
    post($.CGEventCreateScrollWheelEvent(null, $.kCGScrollEventUnitPixel, 2, wy, wx));
  } else if (action === 'scroll') {
    post($.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, { x: x, y: y }, $.kCGMouseButtonLeft));
    var wy = Math.max(-1200, Math.min(1200, Math.round(-dy)));
    var wx = Math.max(-1200, Math.min(1200, Math.round(-dx)));
    post($.CGEventCreateScrollWheelEvent(null, $.kCGScrollEventUnitPixel, 2, wy, wx));
  } else if (action === 'key_press') {
    ensureFinderActive();
    var keycode = parseInt(parts[1]) || 0;
    var mods = parts[2] || '';
    postKeyPress(keycode, mods);
  } else if (action === 'key_down') {
    ensureFinderActive();
    var keycode = parseInt(parts[1]) || 0;
    var mods = parts[2] || '';
    postModifierKeys(parseMods(mods), true);
    post(makeKeyEvent(keycode, true, mods));
  } else if (action === 'key_up') {
    ensureFinderActive();
    var keycode = parseInt(parts[1]) || 0;
    var mods = parts[2] || '';
    post(makeKeyEvent(keycode, false, mods));
    postModifierKeys(parseMods(mods), false);
  } else if (action === 'type_text') {
    ensureFinderActive();
    var b64 = parts[1] || '';
    if (b64) {
      var text = b64decode(b64);
      for (var i = 0; i < text.length; i++) {
        var code = text.charCodeAt(i);
        var src = $.CGEventSourceCreate($.kCGEventSourceStateHIDSystemState);
        var down = $.CGEventCreateKeyboardEvent(src, 0, true);
        var up = $.CGEventCreateKeyboardEvent(src, 0, false);
        $.CGEventKeyboardSetUnicodeString(down, 1, [code]);
        $.CGEventKeyboardSetUnicodeString(up, 1, [code]);
        post(down);
        post(up);
      }
    }
  }
}

var buf = '';
var stdin = $.NSFileHandle.fileHandleWithStandardInput;
while (true) {
  var data = stdin.availableData;
  if (!data || data.length === 0) break;
  var str = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js;
  buf += str;
  var lines = buf.split('\\n');
  buf = lines.pop();
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (line !== '') handle(line);
  }
}
`;

  const proc = spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', daemonScript], {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  proc.stderr.on('data', (chunk) => {
    const msg = chunk.toString().trim();
    if (msg) console.error('[macMouseDaemon]', msg);
  });

  proc.on('error', (err) => {
    console.error('[macMouseDaemon] 启动失败:', err.message);
    macMouseDaemon = null;
    macMouseReady = false;
  });

  proc.on('exit', (code) => {
    console.log('[macMouseDaemon] 退出:', code);
    macMouseDaemon = null;
    macMouseReady = false;
  });

  proc.stdin.on('error', () => {
    macMouseDaemon = null;
    macMouseReady = false;
  });

  macMouseDaemon = proc;
  macMouseReady = true;
  console.log('[macMouseDaemon] 鼠标控制守护进程已启动');

  // flush pending
  for (const cmd of macMousePending) {
    if (proc.stdin.writable) proc.stdin.write(cmd + '\n');
  }
  macMousePending = [];
}

function sendToMacDaemon(cmd) {
  ensureMacMouseDaemon();
  if (!macMouseDaemon || !macMouseDaemon.stdin.writable) {
    macMousePending.push(cmd);
    if (macMousePending.length > 50) macMousePending.shift();
    return;
  }
  try {
    macMouseDaemon.stdin.write(cmd + '\n');
  } catch (_e) {
    macMouseDaemon = null;
    macMouseReady = false;
  }
}

async function performMacMouseAction({ action, x, y, button, dx = 0, dy = 0 }) {
  // Use persistent daemon for high-frequency actions
  if (action === 'move_relative' || action === 'click_current' || action === 'down_current' || action === 'up_current' || action === 'scroll_current') {
    sendToMacDaemon(`${action} ${button || 'left'} ${x} ${y} ${dx} ${dy}`);
    return;
  }

  // Fallback: spawn osascript for rare actions (move to absolute position, scroll at point)
  const script = `
ObjC.import('ApplicationServices');
const action = ${JSON.stringify(action)};
const buttonName = ${JSON.stringify(button)};
const x = ${Number(x)};
const y = ${Number(y)};
const dx = ${Number(dx)};
const dy = ${Number(dy)};
const point = { x, y };
const buttons = {
  left: { button: $.kCGMouseButtonLeft, down: $.kCGEventLeftMouseDown, up: $.kCGEventLeftMouseUp, drag: $.kCGEventLeftMouseDragged },
  right: { button: $.kCGMouseButtonRight, down: $.kCGEventRightMouseDown, up: $.kCGEventRightMouseUp, drag: $.kCGEventRightMouseDragged },
  middle: { button: $.kCGMouseButtonCenter, down: $.kCGEventOtherMouseDown, up: $.kCGEventOtherMouseUp, drag: $.kCGEventOtherMouseDragged }
};
function post(event) { $.CGEventPost($.kCGHIDEventTap, event); }
function mouse(type) { post($.CGEventCreateMouseEvent(null, type, point, buttons[buttonName].button)); }
if (action === 'move') {
  mouse($.kCGEventMouseMoved);
} else if (action === 'scroll') {
  mouse($.kCGEventMouseMoved);
  post($.CGEventCreateScrollWheelEvent(null, $.kCGScrollEventUnitPixel, 2, Math.max(-1200, Math.min(1200, Math.round(-dy))), Math.max(-1200, Math.min(1200, Math.round(-dx)))));
}
`;

  try {
    await execFileAsync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { timeout: 3000 });
  } catch (error) {
    const detail = error.stderr || error.stdout || error.message;
    throw new Error(`macOS 鼠标控制失败，请确认运行 server 的终端或 Firefly 程序已授予”辅助功能”权限: ${detail}`);
  }
}

async function performLinuxMouseAction({ action, x, y, button, dx = 0, dy = 0 }) {
  if (!(await commandExists('xdotool'))) {
    throw new Error('Linux 鼠标控制需要安装 xdotool');
  }

  const buttonId = button === 'right' ? '3' : button === 'middle' ? '2' : '1';
  let args = action === 'click_current'
    ? ['click', buttonId]
    : action === 'down_current'
      ? ['mousedown', buttonId]
      : action === 'up_current'
        ? ['mouseup', buttonId]
        : action === 'move_relative'
          ? ['mousemove_relative', '--', String(Math.round(dx)), String(Math.round(dy))]
          : ['mousemove', String(Math.round(x)), String(Math.round(y))];

  if (action === 'move_relative' || action === 'click_current' || action === 'down_current' || action === 'up_current') {
    // xdotool has already received the full command.
  } else if (action === 'down') {
    args.push('mousedown', buttonId);
  } else if (action === 'up') {
    args.push('mouseup', buttonId);
  } else if (action === 'click') {
    args.push('click', buttonId);
  } else if (action === 'scroll') {
    const verticalClicks = Math.min(8, Math.max(1, Math.round(Math.abs(dy) / 90)));
    const horizontalClicks = Math.min(8, Math.max(1, Math.round(Math.abs(dx) / 90)));
    if (dy !== 0) {
      args.push('click', '--repeat', String(verticalClicks), dy > 0 ? '5' : '4');
    }
    if (dx !== 0) {
      args.push('click', '--repeat', String(horizontalClicks), dx > 0 ? '7' : '6');
    }
  } else if (action === 'scroll_current') {
    const verticalClicks = Math.min(8, Math.max(1, Math.round(Math.abs(dy) / 90)));
    const horizontalClicks = Math.min(8, Math.max(1, Math.round(Math.abs(dx) / 90)));
    args = [];
    if (dy !== 0) {
      args.push('click', '--repeat', String(verticalClicks), dy > 0 ? '5' : '4');
    }
    if (dx !== 0) {
      args.push('click', '--repeat', String(horizontalClicks), dx > 0 ? '7' : '6');
    }
  }

  await execFileAsync('xdotool', args, { timeout: 3000 });
}

async function performLinuxKeyboardAction({ action, key, text, modifiers = [] }) {
  if (!(await commandExists('xdotool'))) {
    throw new Error('Linux 键盘控制需要安装 xdotool');
  }

  if (action === 'type_text') {
    await execFileAsync('xdotool', ['type', '--clearmodifiers', '--', text], { timeout: 3000 });
    return;
  }

  const modPrefix = modifiers.length ? modifiers.join('+') + '+' : '';
  const keyName = modPrefix + (key || '');

  if (action === 'key_press') {
    await execFileAsync('xdotool', ['key', keyName], { timeout: 3000 });
  } else if (action === 'key_down') {
    await execFileAsync('xdotool', ['keydown', key || ''], { timeout: 3000 });
  } else if (action === 'key_up') {
    await execFileAsync('xdotool', ['keyup', key || ''], { timeout: 3000 });
  }
}

function normalizeKeyboardModifiers(modifiers = []) {
  const allowed = new Set(['ctrl', 'shift', 'alt', 'cmd', 'fn']);
  const normalized = [];
  for (const modifier of modifiers) {
    const item = String(modifier || '').toLowerCase();
    if (allowed.has(item) && !normalized.includes(item)) {
      normalized.push(item);
    }
  }
  return normalized;
}

function resolveMacKeyStroke(key, modifiers = []) {
  const normalizedKey = String(key || '').toLowerCase();
  const normalizedModifiers = normalizeKeyboardModifiers(modifiers);

  if (normalizedKey === 'f3' && normalizedModifiers.length === 0) {
    return { key: 'up', modifiers: ['ctrl'] };
  }

  return { key: normalizedKey, modifiers: normalizedModifiers };
}

function getSystemEventsModifierName(modifier) {
  const names = {
    ctrl: 'control down',
    shift: 'shift down',
    alt: 'option down',
    cmd: 'command down'
  };
  return names[modifier] || null;
}

async function performMacKeyboardAction({ action, key, modifiers = [] }) {
  const resolved = resolveMacKeyStroke(key, modifiers);
  const keycode = MAC_KEYCODE[resolved.key];

  if (keycode === undefined) {
    return;
  }

  const macMods = normalizeKeyboardModifiers(resolved.modifiers);
  const daemonMods = macMods.join(',');

  if (macMods.includes('fn') || action === 'key_down' || action === 'key_up') {
    if (action === 'key_press') {
      sendToMacDaemon(`key_press ${keycode}${daemonMods ? ' ' + daemonMods : ''}`);
    } else if (action === 'key_down') {
      sendToMacDaemon(`key_down ${keycode}${daemonMods ? ' ' + daemonMods : ''}`);
    } else if (action === 'key_up') {
      sendToMacDaemon(`key_up ${keycode}${daemonMods ? ' ' + daemonMods : ''}`);
    }
    return;
  }

  if (action !== 'key_press') {
    return;
  }

  const systemEventMods = macMods
    .map(getSystemEventsModifierName)
    .filter(Boolean);
  const script = `
const se = Application('System Events');
${systemEventMods.length
  ? `se.keyCode(${Number(keycode)}, { using: ${JSON.stringify(systemEventMods)} });`
  : `se.keyCode(${Number(keycode)});`}
`;

  try {
    await execFileAsync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { timeout: 3000 });
  } catch (error) {
    console.warn('[WARN] System Events 键盘发送失败，回退到 CGEvent:', error.message);
    sendToMacDaemon(`key_press ${keycode}${daemonMods ? ' ' + daemonMods : ''}`);
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
    body { touch-action: none; }
    #stage { width: 100vw; height: 100vh; display: flex; align-items: center; justify-content: center; background: #050505; overflow: hidden; }
    #screen { width: auto; height: auto; max-width: 100%; max-height: 100%; background: #050505; user-select: none; -webkit-user-drag: none; touch-action: none; transform: translate(var(--pan-x, 0px), var(--pan-y, 0px)) scale(var(--zoom, 1)); transform-origin: center center; will-change: transform; }
    #mousePad { position: fixed; left: max(20px, env(safe-area-inset-left)); bottom: max(26px, env(safe-area-inset-bottom)); width: 100px; height: 100px; border-radius: 999px; background: rgba(255,255,255,.08); border: 1.5px solid rgba(255,255,255,.15); box-shadow: inset 0 0 0 1px rgba(255,255,255,.04); touch-action: none; z-index: 4; }
    #mouseKnob { position: absolute; left: 50%; top: 50%; width: 40px; height: 40px; margin: -20px 0 0 -20px; border-radius: 999px; background: rgba(255,255,255,.18); border: 1.5px solid rgba(255,255,255,.3); box-shadow: 0 2px 12px rgba(0,0,0,.2); transform: translate3d(0,0,0); transition: transform .1s ease-out, background .1s ease; }
    #mousePad.active #mouseKnob { background: rgba(255,255,255,.3); transition: none; }
    #gesturePad { --gesture-wheel-offset: 0px; position: fixed; left: max(18px, env(safe-area-inset-left)); bottom: calc(max(26px, env(safe-area-inset-bottom)) + 268px); width: 96px; height: 50px; border-radius: 999px; background: linear-gradient(180deg, rgba(255,255,255,.14), rgba(255,255,255,.06)); border: 1.5px solid rgba(255,255,255,.22); box-shadow: 0 10px 24px rgba(0,0,0,.28), inset 0 1px 0 rgba(255,255,255,.14), inset 0 0 0 1px rgba(255,255,255,.04); display: flex; align-items: center; justify-content: center; touch-action: none; z-index: 4; user-select: none; -webkit-user-select: none; -webkit-tap-highlight-color: transparent; overflow: hidden; transform: translateZ(0); transition: background .16s ease, border-color .16s ease, transform .16s ease; }
    #gesturePad::before, #gesturePad::after { content: ''; position: absolute; top: 11px; bottom: 11px; width: 16px; border-radius: 999px; opacity: .42; pointer-events: none; }
    #gesturePad::before { left: 8px; background: linear-gradient(90deg, rgba(255,255,255,.28), transparent); }
    #gesturePad::after { right: 8px; background: linear-gradient(270deg, rgba(255,255,255,.28), transparent); }
    #gesturePad .gesture-hint { width: 58px; height: 28px; border-radius: 999px; border: 1px solid rgba(255,255,255,.18); background: linear-gradient(180deg, rgba(255,255,255,.2), rgba(255,255,255,.07)), repeating-linear-gradient(90deg, rgba(255,255,255,.42) 0 2px, transparent 2px 9px); box-shadow: inset 0 1px 0 rgba(255,255,255,.22), inset 0 -8px 14px rgba(0,0,0,.12), 0 3px 12px rgba(0,0,0,.2); pointer-events: none; transform: translateX(var(--gesture-wheel-offset)); transition: transform .18s cubic-bezier(.2,.8,.2,1), background .16s ease; }
    #gesturePad.active { background: linear-gradient(180deg, rgba(255,255,255,.22), rgba(255,255,255,.09)); border-color: rgba(255,255,255,.36); transform: translateY(-1px); }
    #gesturePad.swipe-left .gesture-hint { transform: translateX(-10px); }
    #gesturePad.swipe-right .gesture-hint { transform: translateX(10px); }
    #mouseActions { position: fixed; right: max(18px, env(safe-area-inset-right)); bottom: max(24px, env(safe-area-inset-bottom)); display: flex; flex-direction: column; align-items: center; gap: 12px; z-index: 4; touch-action: none; }
    .mouseAction { margin: 0; border: 1.5px solid rgba(255,255,255,.2); border-radius: 999px; background: rgba(255,255,255,.1); color: rgba(255,255,255,.85); font-size: 13px; font-weight: 600; box-shadow: 0 2px 8px rgba(0,0,0,.15); touch-action: none; display: flex; align-items: center; justify-content: center; }
    .mouseAction.btn-lr { width: 52px; height: 52px; }
    .mouseAction.active { background: rgba(255,255,255,.28); border-color: rgba(255,255,255,.4); }
    .mouseAction.wheel { width: 52px; height: 76px; border-radius: 26px; flex-direction: column; font-size: 11px; position: relative; overflow: hidden; padding: 0; }
    .wheel-cylinder { width: 32px; height: 52px; border-radius: 16px; background: linear-gradient(90deg, rgba(255,255,255,.06) 0%, rgba(255,255,255,.14) 40%, rgba(255,255,255,.14) 60%, rgba(255,255,255,.06) 100%); border: 1px solid rgba(255,255,255,.12); position: relative; overflow: hidden; }
    .wheel-cylinder::before { content: ''; position: absolute; inset: 0; background: repeating-linear-gradient(0deg, transparent 0px, transparent 6px, rgba(255,255,255,.12) 6px, rgba(255,255,255,.12) 7px); transform: translateY(var(--wheel-offset, 0px)); }
    .mouseAction.wheel.active .wheel-cylinder { border-color: rgba(255,255,255,.3); }
    .mouseAction.wheel.active .wheel-cylinder::before { background: repeating-linear-gradient(0deg, transparent 0px, transparent 6px, rgba(255,255,255,.25) 6px, rgba(255,255,255,.25) 7px); }
    #kbToggle { position: fixed; right: max(22px, env(safe-area-inset-right)); bottom: calc(max(24px, env(safe-area-inset-bottom)) + 216px); width: 44px; height: 44px; border-radius: 999px; border: 1.5px solid rgba(255,255,255,.2); background: rgba(255,255,255,.1); color: rgba(255,255,255,.85); font-size: 18px; display: flex; align-items: center; justify-content: center; z-index: 5; touch-action: none; margin: 0; }
    #kbToggle.active { background: rgba(255,255,255,.25); border-color: rgba(255,255,255,.4); }
    #kbPanel { position: fixed; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,.85); backdrop-filter: blur(10px); padding: 2px max(60px, env(safe-area-inset-right)) max(3px, env(safe-area-inset-bottom)) max(60px, env(safe-area-inset-left)); z-index: 5; display: none; flex-direction: column; gap: 2px; }
    #kbPanel.visible { display: flex; }
    #kbHeader { display: flex; justify-content: flex-end; padding: 0 0 2px; }
    #kbClose { margin: 0; border: none; background: transparent; color: rgba(255,255,255,.55); font-size: 11px; font-weight: 500; padding: 2px 8px; touch-action: none; }
    #kbClose:active { color: rgba(255,255,255,.9); }
    .kbKey { flex: 1 1 0; height: 28px; min-width: 0; padding: 0 2px; border-radius: 5px; border: 1px solid rgba(255,255,255,.12); background: rgba(255,255,255,.07); color: rgba(255,255,255,.8); font-size: 11px; font-weight: 500; display: flex; align-items: center; justify-content: center; touch-action: none; white-space: nowrap; margin: 0; user-select: none; -webkit-user-select: none; }
    .kbKey:active { background: rgba(255,255,255,.2); }
    .kbKey.w1 { flex: 1.5 1 0; }
    .kbKey.w2 { flex: 1.8 1 0; }
    .kbKey.w3 { flex: 2.2 1 0; }
    .kbKey.w4 { flex: 2.5 1 0; }
    .kbKey.space { flex: 5 1 0; }
    .kbKey.mod { background: rgba(77,124,255,.12); border-color: rgba(77,124,255,.3); }
    .kbKey.mod.armed { background: rgba(77,124,255,.5); border-color: rgba(77,124,255,.8); color: #fff; }
    #kbRow { display: flex; gap: 2px; justify-content: center; }
    #panel { position: fixed; inset: 0; display: none; align-items: center; justify-content: center; padding: 28px; background: rgba(0,0,0,.82); box-sizing: border-box; text-align: center; }
    #panel.visible { display: flex; }
    #message { max-width: 680px; line-height: 1.55; font-size: 16px; color: #e8e8e8; }
    button { margin-top: 18px; border: 1px solid #5f8cff; background: #1e4fd6; color: #fff; border-radius: 6px; padding: 10px 14px; font-size: 14px; }
  </style>
</head>
<body>
  <div id="stage"><canvas id="screen" aria-label="server screen live"></canvas></div>
  <div id="mousePad" aria-label="mouse joystick"><div id="mouseKnob"></div></div>
  <div id="gesturePad" aria-label="trackpad gestures"><div class="gesture-hint"></div></div>
  <div id="mouseActions" aria-label="mouse buttons">
    <button class="mouseAction btn-lr" data-button="left">左</button>
    <button class="mouseAction btn-lr" data-button="right">右</button>
    <button class="mouseAction wheel" data-wheel="1"><div class="wheel-cylinder"></div></button>
  </div>
  <button id="kbToggle" aria-label="keyboard">&#9000;</button>
  <div id="kbPanel" aria-label="keyboard panel">
    <div id="kbHeader">
      <button id="kbClose" aria-label="close keyboard">收起</button>
    </div>
    <div id="kbRow">
      <button class="kbKey" data-key="escape">ESC</button>
      <button class="kbKey" data-key="f1">F1</button>
      <button class="kbKey" data-key="f2">F2</button>
      <button class="kbKey" data-key="f3">F3</button>
      <button class="kbKey" data-key="f4">F4</button>
      <button class="kbKey" data-key="f5">F5</button>
      <button class="kbKey" data-key="f6">F6</button>
      <button class="kbKey" data-key="f7">F7</button>
      <button class="kbKey" data-key="f8">F8</button>
      <button class="kbKey" data-key="f9">F9</button>
      <button class="kbKey" data-key="f10">F10</button>
      <button class="kbKey" data-key="f11">F11</button>
      <button class="kbKey" data-key="f12">F12</button>
    </div>
    <div id="kbRow">
      <button class="kbKey" data-key="\`">&grave;</button>
      <button class="kbKey" data-key="1">1</button>
      <button class="kbKey" data-key="2">2</button>
      <button class="kbKey" data-key="3">3</button>
      <button class="kbKey" data-key="4">4</button>
      <button class="kbKey" data-key="5">5</button>
      <button class="kbKey" data-key="6">6</button>
      <button class="kbKey" data-key="7">7</button>
      <button class="kbKey" data-key="8">8</button>
      <button class="kbKey" data-key="9">9</button>
      <button class="kbKey" data-key="0">0</button>
      <button class="kbKey" data-key="-">-</button>
      <button class="kbKey" data-key="=">=</button>
      <button class="kbKey w1" data-key="backspace">&#9003;</button>
    </div>
    <div id="kbRow">
      <button class="kbKey w1" data-key="tab">Tab</button>
      <button class="kbKey" data-key="q">Q</button>
      <button class="kbKey" data-key="w">W</button>
      <button class="kbKey" data-key="e">E</button>
      <button class="kbKey" data-key="r">R</button>
      <button class="kbKey" data-key="t">T</button>
      <button class="kbKey" data-key="y">Y</button>
      <button class="kbKey" data-key="u">U</button>
      <button class="kbKey" data-key="i">I</button>
      <button class="kbKey" data-key="o">O</button>
      <button class="kbKey" data-key="p">P</button>
      <button class="kbKey" data-key="[">[</button>
      <button class="kbKey" data-key="]">]</button>
      <button class="kbKey" data-key="\\">\</button>
    </div>
    <div id="kbRow">
      <button class="kbKey w2" data-key="capslock">Caps</button>
      <button class="kbKey" data-key="a">A</button>
      <button class="kbKey" data-key="s">S</button>
      <button class="kbKey" data-key="d">D</button>
      <button class="kbKey" data-key="f">F</button>
      <button class="kbKey" data-key="g">G</button>
      <button class="kbKey" data-key="h">H</button>
      <button class="kbKey" data-key="j">J</button>
      <button class="kbKey" data-key="k">K</button>
      <button class="kbKey" data-key="l">L</button>
      <button class="kbKey" data-key=";">;</button>
      <button class="kbKey" data-key="'">'</button>
      <button class="kbKey w3" data-key="enter">Enter</button>
    </div>
    <div id="kbRow">
      <button class="kbKey w4" data-key="shift">Shift</button>
      <button class="kbKey" data-key="z">Z</button>
      <button class="kbKey" data-key="x">X</button>
      <button class="kbKey" data-key="c">C</button>
      <button class="kbKey" data-key="v">V</button>
      <button class="kbKey" data-key="b">B</button>
      <button class="kbKey" data-key="n">N</button>
      <button class="kbKey" data-key="m">M</button>
      <button class="kbKey" data-key=",">,</button>
      <button class="kbKey" data-key=".">.</button>
      <button class="kbKey" data-key="/">/</button>
      <button class="kbKey w4" data-key="shift">Shift</button>
    </div>
    <div id="kbRow">
      <button class="kbKey mod" data-mod="ctrl">Ctrl</button>
      <button class="kbKey mod" data-mod="alt">Alt</button>
      <button class="kbKey mod" data-mod="cmd">⌘</button>
      <button class="kbKey space" data-key="space">Space</button>
      <button class="kbKey mod" data-mod="alt">Alt</button>
      <button class="kbKey mod" data-mod="ctrl">Ctrl</button>
      <button class="kbKey" data-key="left">&#9664;</button>
      <button class="kbKey" data-key="up">&#9650;</button>
      <button class="kbKey" data-key="down">&#9660;</button>
      <button class="kbKey" data-key="right">&#9654;</button>
      <button class="kbKey mod" data-mod="fn">Fn</button>
    </div>
  </div>
  <div id="panel"><div><div id="message">正在检测屏幕实况...</div><button id="permissionBtn" hidden>打开屏幕录制权限</button></div></div>
  <script src="/vendor/jsmpeg-player.umd.min.js"></script>
  <script>
    const token = ${JSON.stringify(encodedToken)};
    const screen = document.getElementById('screen');
    const mousePad = document.getElementById('mousePad');
    const mouseKnob = document.getElementById('mouseKnob');
    const mouseActionButtons = Array.from(document.querySelectorAll('.mouseAction'));
    const panel = document.getElementById('panel');
    const message = document.getElementById('message');
    const permissionBtn = document.getElementById('permissionBtn');
    let frameCount = 0;
    let screenWs = null;
    let streamPlayer = null;
    let activeTouch = null;
    let longPressTimer = null;
    let lastScrollTouch = null;
    let lastMouseMoveAt = 0;
    let zoom = 1;
    let panX = 0;
    let panY = 0;
    let pinchState = null;
    let suppressNextClickUntil = 0;
    let joystickTouchId = null;
    let joystickStartX = 0;
    let joystickStartY = 0;
    let joystickMoved = false;
    let joystickVectorX = 0;
    let joystickVectorY = 0;
    let joystickMoveTimer = null;
    let wheelTimer = null;
    const videoFps = ${JSON.stringify(SCREEN_STREAM_FPS)};
    const joystickDeadZone = 10;
    const joystickRadius = 37;
    const joystickBaseSpeed = Math.max(0.9, Math.min(2.4, videoFps * 0.22));

    function showMessage(text, canOpenPermission) {
      message.textContent = text;
      permissionBtn.hidden = !canOpenPermission;
      panel.classList.add('visible');
    }

    // --- Keyboard ---
    const kbToggle = document.getElementById('kbToggle');
    const kbPanel = document.getElementById('kbPanel');
    const kbClose = document.getElementById('kbClose');
    const kbModifiers = Array.from(document.querySelectorAll('.kbKey.mod'));
    const kbKeys = Array.from(document.querySelectorAll('.kbKey:not(.mod)'));
    let kbVisible = false;
    let armedModifiers = new Set();
    let suppressSyntheticClickUntil = 0;
    function sendKeyboard(payload) {
      if (!screenWs || screenWs.readyState !== WebSocket.OPEN) return;
      screenWs.send(JSON.stringify(Object.assign({ type: 'screen_keyboard' }, payload)));
    }

    function bindTap(element, handler) {
      element.addEventListener('touchend', (e) => {
        suppressSyntheticClickUntil = Date.now() + 500;
        handler(e);
      }, { passive: false });
      element.addEventListener('click', (e) => {
        if (Date.now() < suppressSyntheticClickUntil) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        handler(e);
      });
    }

    function toggleKeyboard() {
      kbVisible = !kbVisible;
      kbPanel.classList.toggle('visible', kbVisible);
      kbToggle.classList.toggle('active', kbVisible);
      if (!kbVisible) {
        armedModifiers.clear();
        kbModifiers.forEach(m => m.classList.remove('armed'));
      }
    }

    bindTap(kbToggle, (e) => { e.preventDefault(); e.stopPropagation(); toggleKeyboard(); });
    bindTap(kbClose, (e) => { e.preventDefault(); e.stopPropagation(); toggleKeyboard(); });

    kbModifiers.forEach(btn => {
      const mod = btn.dataset.mod;
      const toggle = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (armedModifiers.has(mod)) {
          armedModifiers.delete(mod);
          btn.classList.remove('armed');
        } else {
          armedModifiers.add(mod);
          btn.classList.add('armed');
        }
      };
      bindTap(btn, toggle);
    });

    function sendKeyAction(key) {
      const mods = Array.from(armedModifiers);
      sendKeyboard({ action: 'key_press', key, modifiers: mods });
      if (armedModifiers.size) {
        armedModifiers.clear();
        kbModifiers.forEach(m => m.classList.remove('armed'));
      }
    }

    kbKeys.forEach(btn => {
      const key = btn.dataset.key;
      const handler = (e) => {
        e.preventDefault();
        e.stopPropagation();
        sendKeyAction(key);
      };
      bindTap(btn, handler);
    });

    // Desktop keyboard passthrough when panel is visible
    document.addEventListener('keydown', (e) => {
      if (!kbVisible) return;
      e.preventDefault();
      const specialKeys = {
        Escape: 'escape', Tab: 'tab', Enter: 'enter', Backspace: 'backspace', Delete: 'delete',
        ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
        F1:'f1', F2:'f2', F3:'f3', F4:'f4', F5:'f5', F6:'f6', F7:'f7', F8:'f8', F9:'f9', F10:'f10', F11:'f11', F12:'f12',
        Insert:'insert', Home:'home', End:'end', PageUp:'pageup', PageDown:'pagedown'
      };
      let key = specialKeys[e.key] || null;
      if (!key && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
        key = e.key.toLowerCase();
      }
      if (!key) return;
      const mods = [];
      if (e.ctrlKey) mods.push('ctrl');
      if (e.altKey) mods.push('alt');
      if (e.metaKey) mods.push('cmd');
      sendKeyboard({ action: 'key_press', key, modifiers: mods });
    });

    // --- Gesture Pad (macOS trackpad three-finger gestures) ---
    const gesturePad = document.getElementById('gesturePad');
    let gesturePointer = null;
    let gestureClickSuppressUntil = 0;

    function flashGesture(direction) {
      gesturePad.classList.remove('swipe-left', 'swipe-right');
      if (direction) {
        gesturePad.style.setProperty('--gesture-wheel-offset', direction === 'left' ? '-10px' : '10px');
        gesturePad.classList.add(direction === 'left' ? 'swipe-left' : 'swipe-right');
        setTimeout(() => {
          gesturePad.classList.remove('swipe-left', 'swipe-right');
          gesturePad.style.setProperty('--gesture-wheel-offset', '0px');
        }, 180);
      }
    }

    function finishGesture(clientX, clientY) {
      if (!gesturePointer) return;
      const dx = clientX - gesturePointer.startX;
      const dy = clientY - gesturePointer.startY;
      const elapsed = Date.now() - gesturePointer.startTime;
      gesturePointer = null;
      gesturePad.classList.remove('active');
      gestureClickSuppressUntil = Date.now() + 450;

      if (Math.abs(dx) >= 22 && Math.abs(dx) > Math.abs(dy) * 1.15) {
        const direction = dx > 0 ? 'right' : 'left';
        flashGesture(direction);
        sendKeyboard({ action: 'key_press', key: direction, modifiers: ['ctrl'] });
      } else if (Math.abs(dx) < 18 && Math.abs(dy) < 18 && elapsed < 420) {
        sendKeyboard({ action: 'key_press', key: 'up', modifiers: ['ctrl'] });
      }
    }

    gesturePad.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      gesturePad.setPointerCapture?.(e.pointerId);
      gesturePad.classList.add('active');
      gesturePointer = { id: e.pointerId, startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY, startTime: Date.now() };
    });

    gesturePad.addEventListener('pointermove', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!gesturePointer || gesturePointer.id !== e.pointerId) return;
      gesturePointer.lastX = e.clientX;
      gesturePointer.lastY = e.clientY;
      const dx = e.clientX - gesturePointer.startX;
      const dy = e.clientY - gesturePointer.startY;
      const wheelOffset = Math.max(-12, Math.min(12, Math.round(dx * 0.34)));
      gesturePad.style.setProperty('--gesture-wheel-offset', wheelOffset + 'px');
      if (Math.abs(dx) >= 18 && Math.abs(dx) > Math.abs(dy)) {
        flashGesture(dx > 0 ? 'right' : 'left');
      }
    });

    gesturePad.addEventListener('pointerup', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (gesturePointer?.id !== e.pointerId) return;
      gesturePad.releasePointerCapture?.(e.pointerId);
      finishGesture(e.clientX, e.clientY);
    });

    gesturePad.addEventListener('pointercancel', (e) => {
      e.preventDefault();
      e.stopPropagation();
      gesturePointer = null;
      gesturePad.classList.remove('active');
      gesturePad.style.setProperty('--gesture-wheel-offset', '0px');
    });

    gesturePad.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (Date.now() < gestureClickSuppressUntil) return;
      sendKeyboard({ action: 'key_press', key: 'up', modifiers: ['ctrl'] });
    });

    function clamp(value, min, max) {
      return Math.min(Math.max(value, min), max);
    }

    function applyViewportTransform() {
      if (zoom < 1) {
        zoom = 1;
      }
      if (zoom > 1.01) {
        const maxPanX = window.innerWidth * (zoom - 1) * 0.5;
        const maxPanY = window.innerHeight * (zoom - 1) * 0.5;
        panX = clamp(panX, -maxPanX, maxPanX);
        panY = clamp(panY, -maxPanY, maxPanY);
      }

      screen.style.setProperty('--zoom', String(zoom));
      screen.style.setProperty('--pan-x', panX + 'px');
      screen.style.setProperty('--pan-y', panY + 'px');
    }

    function getTouchDistance(a, b) {
      return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    }

    function getTouchCenter(a, b) {
      return {
        x: (a.clientX + b.clientX) / 2,
        y: (a.clientY + b.clientY) / 2
      };
    }

    function getScreenMetrics() {
      const rect = screen.getBoundingClientRect();
      const naturalWidth = screen.width || rect.width;
      const naturalHeight = screen.height || rect.height;
      const imageRatio = naturalWidth / naturalHeight;
      const rectRatio = rect.width / rect.height;
      let drawWidth = rect.width;
      let drawHeight = rect.height;
      let left = rect.left;
      let top = rect.top;

      if (rectRatio > imageRatio) {
        drawWidth = rect.height * imageRatio;
        left += (rect.width - drawWidth) / 2;
      } else {
        drawHeight = rect.width / imageRatio;
        top += (rect.height - drawHeight) / 2;
      }

      return { left, top, drawWidth, drawHeight };
    }

    function getScreenClientPoint(x, y) {
      const { left, top, drawWidth, drawHeight } = getScreenMetrics();

      return {
        x: left + clamp(x, 0, 1) * drawWidth,
        y: top + clamp(y, 0, 1) * drawHeight
      };
    }

    function getScreenPoint(clientX, clientY) {
      const { left, top, drawWidth, drawHeight } = getScreenMetrics();

      const x = (clientX - left) / drawWidth;
      const y = (clientY - top) / drawHeight;
      if (x < 0 || x > 1 || y < 0 || y > 1) {
        return null;
      }
      return { x, y };
    }

    function sendMouse(payload) {
      if (!screenWs || screenWs.readyState !== WebSocket.OPEN) {
        return;
      }
      if (payload.action === 'move_relative' && screenWs.bufferedAmount > 256 * 1024) {
        return;
      }
      screenWs.send(JSON.stringify(Object.assign({ type: 'screen_mouse' }, payload)));
    }

    function sendRelativeMove(dx, dy) {
      const { drawWidth, drawHeight } = getScreenMetrics();
      if (!drawWidth || !drawHeight) {
        return;
      }
      if (Math.hypot(dx, dy) < 0.2) {
        return;
      }

      sendMouse({
        action: 'move_relative',
        button: 'left',
        dx: dx / drawWidth,
        dy: dy / drawHeight
      });
    }

    function sendWheel(deltaY) {
      sendMouse({
        action: 'scroll_current',
        button: 'left',
        dx: 0,
        dy: deltaY
      });
    }

    function setKnob(dx, dy) {
      const radius = 37;
      const distance = Math.hypot(dx, dy);
      const scale = distance > radius ? radius / distance : 1;
      mouseKnob.style.transform = 'translate3d(' + (dx * scale) + 'px,' + (dy * scale) + 'px,0)';
    }

    function resetKnob() {
      mousePad.classList.remove('active');
      mouseKnob.style.transform = 'translate3d(0,0,0)';
      joystickTouchId = null;
      joystickMoved = false;
      joystickVectorX = 0;
      joystickVectorY = 0;
      stopJoystickLoop();
    }

    function startJoystickLoop() {
      if (joystickMoveTimer) {
        return;
      }

      joystickMoveTimer = setInterval(() => {
        if (!joystickTouchId || (!joystickVectorX && !joystickVectorY)) {
          return;
        }

        const distance = Math.hypot(joystickVectorX, joystickVectorY);
        if (distance < joystickDeadZone) {
          return;
        }

        const normalized = Math.min(1, (distance - joystickDeadZone) / (joystickRadius - joystickDeadZone));
        const backlogSlowdown = screenWs?.bufferedAmount > 96 * 1024 ? 0.35 : 1;
        const speed = Math.pow(normalized, 2.25) * joystickBaseSpeed * backlogSlowdown;
        sendRelativeMove((joystickVectorX / distance) * speed, (joystickVectorY / distance) * speed);
      }, 50);
    }

    function stopJoystickLoop() {
      if (joystickMoveTimer) {
        clearInterval(joystickMoveTimer);
        joystickMoveTimer = null;
      }
    }

    function clearLongPress() {
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    }

    function startStream() {
      showMessage('正在启动屏幕推流...', false);
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const controlWs = new WebSocket(protocol + '//' + location.host + '/screen-ws?token=' + token);
      screenWs = controlWs;

      controlWs.onmessage = (event) => {
        if (typeof event.data === 'string') {
          try {
            const data = JSON.parse(event.data);
            if (data.type === 'error') {
              showMessage(data.error || '屏幕实况不可用', false);
            } else if (data.type === 'control_error') {
              showMessage(data.error || '鼠标控制不可用', false);
            }
          } catch (_error) {}
        }
      };

      controlWs.onerror = () => {
        showMessage('鼠标控制连接失败，请检查 server 是否已重启。', false);
      };

      controlWs.onclose = () => {
        if (!frameCount) {
          showMessage('鼠标控制通道已断开。', false);
        }
      };

      if (!window.JSMpeg?.Player) {
        showMessage('JSMpeg 播放器加载失败，请检查 server/public/vendor/jsmpeg-player.umd.min.js。', false);
        return;
      }

      const streamUrl = protocol + '//' + location.host + '/screen-stream?token=' + token;
      streamPlayer = new JSMpeg.Player(streamUrl, {
        canvas: screen,
        autoplay: true,
        audio: false,
        loop: false,
        videoBufferSize: 1024 * 1024,
        disableGl: false,
        preserveDrawingBuffer: false,
        onSourceEstablished: () => {
          frameCount += 1;
          panel.classList.remove('visible');
        },
        onVideoDecode: () => {
          if (frameCount === 0) {
            frameCount += 1;
            panel.classList.remove('visible');
          }
        }
      });

      window.addEventListener('pagehide', () => {
        controlWs.close();
        streamPlayer?.destroy?.();
      }, { once: true });
    }

    screen.addEventListener('click', (event) => {
      event.preventDefault();
      if (Date.now() < suppressNextClickUntil) {
        return;
      }
      sendMouse({ action: 'click_current', button: 'left' });
    });

    screen.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      sendMouse({ action: 'click_current', button: 'right' });
    });

    mousePad.addEventListener('mousemove', (event) => {
      sendRelativeMove(event.movementX || 0, event.movementY || 0);
    });

    mousePad.addEventListener('mousedown', (event) => {
      event.preventDefault();
      mousePad.classList.add('active');
    });

    window.addEventListener('mouseup', () => {
      resetKnob();
    });

    function bindMouseButton(button) {
      const mouseButton = button.dataset.button;
      if (!mouseButton) {
        return;
      }

      let lastTapAt = 0;
      let doubleClickPending = false;
      let longPressTimer = null;

      const press = (event) => {
        event.preventDefault();
        event.stopPropagation();
        button.classList.add('active');

        const now = Date.now();
        if (mouseButton === 'left' && now - lastTapAt < 350) {
          // Double click: send two rapid clicks
          doubleClickPending = true;
          sendMouse({ action: 'click_current', button: mouseButton });
          sendMouse({ action: 'click_current', button: mouseButton });
          lastTapAt = 0;
          return;
        }

        sendMouse({ action: 'down_current', button: mouseButton });
      };

      const release = (event) => {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        if (!button.classList.contains('active')) {
          return;
        }
        button.classList.remove('active');
        if (longPressTimer) {
          clearTimeout(longPressTimer);
          longPressTimer = null;
        }
        if (doubleClickPending) {
          doubleClickPending = false;
          return;
        }
        sendMouse({ action: 'up_current', button: mouseButton });
        if (mouseButton === 'left') {
          lastTapAt = Date.now();
        }
      };

      button.addEventListener('mousedown', press);
      button.addEventListener('touchstart', press, { passive: false });
      button.addEventListener('mouseup', release);
      button.addEventListener('mouseleave', release);
      button.addEventListener('touchend', release, { passive: false });
      button.addEventListener('touchcancel', release, { passive: false });
    }

    function bindWheelButton(button) {
      let wheelTouchId = null;
      let wheelLastY = 0;
      let wheelVelocity = 0;
      let wheelOffset = 0;
      const cylinder = button.querySelector('.wheel-cylinder');

      const updateCylinder = (vel) => {
        if (!cylinder) return;
        wheelOffset = (wheelOffset + (vel > 0 ? 2 : -2)) % 7;
        cylinder.style.setProperty('--wheel-offset', wheelOffset + 'px');
      };

      const stopWheel = (event) => {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        button.classList.remove('active');
        wheelTouchId = null;
        wheelVelocity = 0;
        if (wheelTimer) {
          clearInterval(wheelTimer);
          wheelTimer = null;
        }
      };

      const startWheelLoop = () => {
        if (wheelTimer) {
          return;
        }
        wheelTimer = setInterval(() => {
          if (wheelVelocity) {
            sendWheel(wheelVelocity);
            updateCylinder(wheelVelocity);
          }
        }, 40);
      };

      button.addEventListener('touchstart', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const touch = event.changedTouches[0];
        if (!touch) {
          return;
        }
        wheelTouchId = touch.identifier;
        wheelLastY = touch.clientY;
        wheelVelocity = 0;
        button.classList.add('active');
        startWheelLoop();
      }, { passive: false });

      button.addEventListener('touchmove', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const touch = Array.from(event.changedTouches).find((item) => item.identifier === wheelTouchId);
        if (!touch) {
          return;
        }
        const dy = touch.clientY - wheelLastY;
        wheelVelocity = clamp(dy * 5, -520, 520);
        wheelLastY = touch.clientY;
      }, { passive: false });

      button.addEventListener('touchend', stopWheel, { passive: false });
      button.addEventListener('touchcancel', stopWheel, { passive: false });

      button.addEventListener('mousedown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        wheelVelocity = -260;
        button.classList.add('active');
        startWheelLoop();
      });
      button.addEventListener('mouseup', stopWheel);
      button.addEventListener('mouseleave', stopWheel);
    }

    mouseActionButtons.forEach((button) => {
      if (button.dataset.wheel) {
        bindWheelButton(button);
      } else {
        bindMouseButton(button);
      }
    });

    screen.addEventListener('wheel', (event) => {
      event.preventDefault();
      const point = getScreenPoint(event.clientX, event.clientY);
      if (!point) {
        return;
      }
      sendMouse(Object.assign({ action: 'scroll', dx: event.deltaX, dy: event.deltaY }, point));
    }, { passive: false });

    screen.addEventListener('touchstart', (event) => {
      event.preventDefault();
      if (event.touches.length === 1) {
        const touch = event.touches[0];
        activeTouch = {
          id: touch.identifier,
          startX: touch.clientX,
          startY: touch.clientY,
          lastX: touch.clientX,
          lastY: touch.clientY,
          moved: false,
          startedAt: Date.now()
        };
        lastScrollTouch = { x: touch.clientX, y: touch.clientY };
      } else if (event.touches.length === 2) {
        clearLongPress();
        activeTouch = null;
        lastScrollTouch = null;
        const firstTouch = event.touches[0];
        const secondTouch = event.touches[1];
        pinchState = {
          distance: getTouchDistance(firstTouch, secondTouch),
          center: getTouchCenter(firstTouch, secondTouch),
          zoom,
          panX,
          panY
        };
      }
    }, { passive: false });

    screen.addEventListener('touchmove', (event) => {
      event.preventDefault();
      const touch = event.touches[0];
      if (!touch) {
        return;
      }

      if (event.touches.length >= 2) {
        clearLongPress();
        const firstTouch = event.touches[0];
        const secondTouch = event.touches[1];
        const center = getTouchCenter(firstTouch, secondTouch);

        if (!pinchState) {
          pinchState = {
            distance: getTouchDistance(firstTouch, secondTouch),
            center,
            zoom,
            panX,
            panY
          };
          return;
        }

        const nextZoom = clamp(pinchState.zoom * (getTouchDistance(firstTouch, secondTouch) / Math.max(1, pinchState.distance)), 1, 4);
        zoom = nextZoom;
        panX = pinchState.panX + (center.x - pinchState.center.x);
        panY = pinchState.panY + (center.y - pinchState.center.y);
        applyViewportTransform();
        return;
      }

      if (activeTouch) {
        activeTouch.moved = Math.hypot(touch.clientX - activeTouch.startX, touch.clientY - activeTouch.startY) > 8;
        panX += touch.clientX - activeTouch.lastX;
        panY += touch.clientY - activeTouch.lastY;
        activeTouch.lastX = touch.clientX;
        activeTouch.lastY = touch.clientY;
        applyViewportTransform();
      }
    }, { passive: false });

    screen.addEventListener('touchend', (event) => {
      event.preventDefault();
      clearLongPress();
      suppressNextClickUntil = Date.now() + 450;

      if (event.touches.length >= 2) {
        return;
      }

      if (event.touches.length === 1) {
        const touch = event.touches[0];
        if (pinchState) {
          activeTouch = {
            id: touch.identifier,
            startX: touch.clientX,
            startY: touch.clientY,
            lastX: touch.clientX,
            lastY: touch.clientY,
            moved: true,
            startedAt: Date.now()
          };
          pinchState = null;
          return;
        }

        activeTouch = {
          id: touch.identifier,
          startX: touch.clientX,
          startY: touch.clientY,
          lastX: touch.clientX,
          lastY: touch.clientY,
          moved: false,
          startedAt: Date.now()
        };
        return;
      }

      if (activeTouch && !activeTouch.moved && !activeTouch.sentLongPress && zoom <= 1.01) {
        sendMouse({ action: 'click_current', button: 'left' });
      }

      if (!event.touches.length) {
        activeTouch = null;
        lastScrollTouch = null;
        pinchState = null;
      }
    }, { passive: false });

    screen.addEventListener('touchcancel', () => {
      clearLongPress();
      activeTouch = null;
      lastScrollTouch = null;
      pinchState = null;
    });

    mousePad.addEventListener('touchstart', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const touch = event.changedTouches[0];
      if (!touch) {
        return;
      }
      joystickTouchId = touch.identifier;
      joystickStartX = touch.clientX;
      joystickStartY = touch.clientY;
      joystickMoved = false;
      mousePad.classList.add('active');
      setKnob(0, 0);
      startJoystickLoop();
    }, { passive: false });

    mousePad.addEventListener('touchmove', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const touch = Array.from(event.changedTouches).find((item) => item.identifier === joystickTouchId);
      if (!touch) {
        return;
      }

      joystickMoved = joystickMoved || Math.hypot(touch.clientX - joystickStartX, touch.clientY - joystickStartY) > 8;
      const knobX = touch.clientX - joystickStartX;
      const knobY = touch.clientY - joystickStartY;
      setKnob(knobX, knobY);
      joystickVectorX = knobX;
      joystickVectorY = knobY;
    }, { passive: false });

    mousePad.addEventListener('touchend', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const touch = Array.from(event.changedTouches).find((item) => item.identifier === joystickTouchId);
      if (!touch) {
        return;
      }
      resetKnob();
    }, { passive: false });

    mousePad.addEventListener('touchcancel', (event) => {
      event.preventDefault();
      event.stopPropagation();
      resetKnob();
    }, { passive: false });

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

  if (url.pathname === '/screen-stream') {
    console.log('[+] 屏幕 MPEG-TS 推流 WebSocket 连接');
    try {
      startScreenMpegTsStream(ws);
    } catch (error) {
      console.error('[ERR] 屏幕 MPEG-TS 推流启动失败:', error.message);
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'error', error: error.message }));
        ws.close();
      }
    }
    return;
  }

  if (url.pathname === '/screen-ws') {
    console.log('[+] 屏幕控制 WebSocket 连接');
    bindScreenControlSocket(ws);
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
