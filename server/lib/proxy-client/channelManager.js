/**
 * ClientChannelMannager - Manages proxy server connection pool and real server channels
 * Mirrors Java ClientChannelMannager exactly
 */

const net = require('net');
const tls = require('tls');
const {
  encodeProxyMessage,
  decodeProxyMessage,
  frameDecoder,
  TYPE_DISCONNECT,
  TYPE_HEARTBEAT,
  P_TYPE_TRANSFER,
  ProxyMessage
} = require('./protocol');
const config = require('./config');

const MAX_POOL_SIZE = 100;
const READ_IDLE_TIME = 60; // seconds
const WRITE_IDLE_TIME = 30; // seconds (client uses 40-10 in Java)

// Connection pool for proxy data channels
const proxyChannelPool = [];

// Map of userId -> real server channel
const realServerChannels = new Map();

// Map of real server channel -> userId
const realServerChannelUserIds = new Map();

// Channel attributes (simulates Netty AttributeKey)
const channelAttributes = new WeakMap();

// Command channel (primary control connection)
let cmdChannel = null;

// SSL context cache
let sslContext = null;

// Per-socket metadata
const proxySocketMeta = new WeakMap();

/**
 * Set attribute on channel
 */
function setAttribute(channel, key, value) {
  let attrs = channelAttributes.get(channel);
  if (!attrs) {
    attrs = {};
    channelAttributes.set(channel, attrs);
  }
  attrs[key] = value;
}

/**
 * Get attribute from channel
 */
function getAttribute(channel, key) {
  const attrs = channelAttributes.get(channel);
  return attrs ? attrs[key] : undefined;
}

/**
 * Remove attribute from channel
 */
function removeAttribute(channel, key) {
  const attrs = channelAttributes.get(channel);
  if (attrs) {
    delete attrs[key];
  }
}

/**
 * Create a proxy socket (TCP or TLS)
 */
function createProxySocket(options = {}) {
  const sslEnabled = config.getBooleanValue('ssl.enable', false);
  const host = config.getStringValue('server.host');
  const port = config.getIntValue('server.port', 4900);

  let socket;

  if (sslEnabled) {
    if (!sslContext) {
      const { createSSLContext } = require('./sslContext');
      sslContext = createSSLContext();
    }
    socket = tls.connect({
      host: host,
      port: port,
      rejectUnauthorized: false,
      ...(sslContext ? { secureContext: sslContext } : {}),
      ...options
    });
  } else {
    socket = new net.Socket();
    socket.connect(port, host);
  }

  // Initialize attributes
  setAttribute(socket, 'user_channel_writeable', true);
  setAttribute(socket, 'client_channel_writeable', true);

  attachProxySocketHandlers(socket);
  return socket;
}

function ensureProxySocketMeta(socket) {
  let meta = proxySocketMeta.get(socket);
  if (!meta) {
    meta = {
      readBuffer: Buffer.alloc(0),
      lastReadAt: Date.now(),
      heartbeatTimer: null,
      idleTimer: null,
      handlersAttached: false
    };
    proxySocketMeta.set(socket, meta);
  }
  return meta;
}

function stopProxySocketTimers(socket) {
  const meta = proxySocketMeta.get(socket);
  if (!meta) return;
  if (meta.heartbeatTimer) {
    clearInterval(meta.heartbeatTimer);
    meta.heartbeatTimer = null;
  }
  if (meta.idleTimer) {
    clearInterval(meta.idleTimer);
    meta.idleTimer = null;
  }
}

function startProxySocketTimers(socket) {
  const meta = ensureProxySocketMeta(socket);
  stopProxySocketTimers(socket);

  meta.lastReadAt = Date.now();
  meta.heartbeatTimer = setInterval(() => {
    if (!socket.destroyed && socket.writable) {
      const heartbeat = new ProxyMessage();
      heartbeat.setType(TYPE_HEARTBEAT);
      socket.write(encodeProxyMessage(heartbeat));
    }
  }, WRITE_IDLE_TIME * 1000);

  meta.idleTimer = setInterval(() => {
    if (socket.destroyed) return;
    const elapsed = Date.now() - meta.lastReadAt;
    if (elapsed > READ_IDLE_TIME * 1000) {
      socket.destroy();
    }
  }, 1000);
}

function handleProxySocketData(socket, chunk) {
  const meta = ensureProxySocketMeta(socket);
  meta.lastReadAt = Date.now();

  let buffer = meta.readBuffer;
  buffer = Buffer.concat([buffer, chunk]);
  const { frames, remaining } = frameDecoder(buffer);
  meta.readBuffer = remaining;

  for (const frame of frames) {
    const msg = decodeProxyMessage(frame);
    if (!msg) continue;

    switch (msg.getType()) {
      case P_TYPE_TRANSFER: {
        const realServerChannel = getNextChannel(socket);
        if (realServerChannel && !realServerChannel.destroyed) {
          const ok = realServerChannel.write(msg.getData());
          if (!ok) {
            socket.pause();
            realServerChannel.once('drain', () => {
              if (!socket.destroyed) socket.resume();
            });
          }
        }
        break;
      }
      case TYPE_DISCONNECT: {
        const userId = msg.getUri();
        const realServerChannel = getNextChannel(socket);
        setNextChannel(socket, null);
        returnProxyChannel(socket);

        if (userId) {
          removeRealServerChannel(userId);
        }
        if (realServerChannel && !realServerChannel.destroyed) {
          realServerChannel.end();
        }
        break;
      }
      default:
        break;
    }
  }
}

function attachProxySocketHandlers(socket) {
  const meta = ensureProxySocketMeta(socket);
  if (meta.handlersAttached) return;
  meta.handlersAttached = true;

  socket.on('connect', () => {
    startProxySocketTimers(socket);
  });

  socket.on('data', (chunk) => {
    handleProxySocketData(socket, chunk);
  });

  socket.on('close', () => {
    stopProxySocketTimers(socket);
    const realServerChannel = getNextChannel(socket);
    if (realServerChannel && !realServerChannel.destroyed) {
      realServerChannel.destroy();
    }
    removeProxyChannel(socket);
  });

  socket.on('error', () => {});
}

/**
 * Borrow a proxy channel from pool or create new
 * Mirrors Java: borrowProxyChanel(Bootstrap bootstrap, ProxyChannelBorrowListener borrowListener)
 */
function borrowProxyChannel(options, callback) {
  // Try to get from pool first
  while (proxyChannelPool.length > 0) {
    const channel = proxyChannelPool.pop();
    if (channel && !channel.destroyed && channel.writable) {
      callback(null, channel);
      return;
    }
    // Channel is not writable, discard and try next
    if (channel) {
      channel.destroy();
    }
  }

  // Create new connection
  const socket = createProxySocket(options);

  socket.on('connect', () => {
    callback(null, socket);
  });

  socket.on('error', (err) => {
    callback(err, null);
  });
}

/**
 * Return proxy channel to pool
 * Mirrors Java: returnProxyChanel(Channel proxyChanel)
 */
function returnProxyChannel(proxyChannel) {
  if (proxyChannelPool.length >= MAX_POOL_SIZE) {
    proxyChannel.destroy();
  } else {
    // Reset channel state
    removeAttribute(proxyChannel, 'nxt_channel');
    setAttribute(proxyChannel, 'user_channel_writeable', true);
    proxyChannel.resume(); // Ensure it's not paused
    proxyChannelPool.push(proxyChannel);
  }
}

/**
 * Remove proxy channel from pool
 * Mirrors Java: removeProxyChanel(Channel proxyChanel)
 */
function removeProxyChannel(proxyChannel) {
  const idx = proxyChannelPool.indexOf(proxyChannel);
  if (idx !== -1) {
    proxyChannelPool.splice(idx, 1);
  }
}

/**
 * Set command channel
 * Mirrors Java: setCmdChannel(Channel cmdChannel)
 */
function setCmdChannel(channel) {
  cmdChannel = channel;
}

/**
 * Get command channel
 * Mirrors Java: getCmdChannel()
 */
function getCmdChannel() {
  return cmdChannel;
}

/**
 * Set user ID for real server channel
 * Mirrors Java: setRealServerChannelUserId(Channel realServerChannel, String userId)
 */
function setRealServerChannelUserId(realServerChannel, userId) {
  setAttribute(realServerChannel, 'user_id', userId);
  realServerChannelUserIds.set(realServerChannel, userId);
}

/**
 * Get user ID for real server channel
 * Mirrors Java: getRealServerChannelUserId(Channel realServerChannel)
 */
function getRealServerChannelUserId(realServerChannel) {
  return realServerChannelUserIds.get(realServerChannel);
}

/**
 * Get real server channel by user ID
 * Mirrors Java: getRealServerChannel(String userId)
 */
function getRealServerChannel(userId) {
  return realServerChannels.get(userId);
}

/**
 * Add real server channel
 * Mirrors Java: addRealServerChannel(String userId, Channel realServerChannel)
 */
function addRealServerChannel(userId, realServerChannel) {
  realServerChannels.set(userId, realServerChannel);
}

/**
 * Remove real server channel
 * Mirrors Java: removeRealServerChannel(String userId)
 */
function removeRealServerChannel(userId) {
  const realServerChannel = realServerChannels.get(userId);
  if (realServerChannel) {
    realServerChannelUserIds.delete(realServerChannel);
  }
  return realServerChannels.delete(userId);
}

/**
 * Check if real server is readable (flow control)
 * Mirrors Java: isRealServerReadable(Channel realServerChannel)
 */
function isRealServerReadable(realServerChannel) {
  const clientWritable = getAttribute(realServerChannel, 'client_channel_writeable');
  const userWritable = getAttribute(realServerChannel, 'user_channel_writeable');
  return clientWritable && userWritable;
}

/**
 * Clear all real server channels (when cmd channel closes)
 * Mirrors Java: clearRealServerChannels()
 */
function clearRealServerChannels() {
  console.warn('[proxy] command channel closed, clearing real server channels');

  for (const [userId, channel] of realServerChannels) {
    if (channel && !channel.destroyed) {
      channel.end();
    }
  }

  realServerChannels.clear();
  realServerChannelUserIds.clear();

  // Also clear the proxy channel pool
  while (proxyChannelPool.length > 0) {
    const ch = proxyChannelPool.pop();
    ch.destroy();
  }
}

/**
 * Set next channel (bidirectional binding)
 * Mirrors Java: NEXT_CHANNEL attribute
 */
function setNextChannel(channel, nextChannel) {
  setAttribute(channel, 'nxt_channel', nextChannel);
}

/**
 * Get next channel
 * Mirrors Java: NEXT_CHANNEL attribute get
 */
function getNextChannel(channel) {
  return getAttribute(channel, 'nxt_channel');
}

/**
 * Get pool size for debugging
 */
function getPoolSize() {
  return proxyChannelPool.length;
}

/**
 * Get number of active real server connections
 */
function getActiveConnections() {
  return realServerChannels.size;
}

/**
 * Check if proxy client is connected (command channel exists and is writable)
 */
function isConnected() {
  return cmdChannel && !cmdChannel.destroyed && cmdChannel.writable;
}

module.exports = {
  borrowProxyChannel,
  returnProxyChannel,
  removeProxyChannel,
  setCmdChannel,
  getCmdChannel,
  setRealServerChannelUserId,
  getRealServerChannelUserId,
  getRealServerChannel,
  addRealServerChannel,
  removeRealServerChannel,
  clearRealServerChannels,
  isRealServerReadable,
  setNextChannel,
  getNextChannel,
  setAttribute,
  getAttribute,
  removeAttribute,
  getPoolSize,
  getActiveConnections,
  isConnected,
  MAX_POOL_SIZE
};
