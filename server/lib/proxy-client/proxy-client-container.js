/**
 * ProxyClientContainer - Main entry point for proxy client
 * Mirrors Java ProxyClientContainer with full feature parity
 * Integrated into the Firefly server as an optional module.
 */

const net = require('net');
const tls = require('tls');
const config = require('./config');
const logger = require('./logger');
const {
  encodeProxyMessage,
  decodeProxyMessage,
  frameDecoder,
  C_TYPE_AUTH,
  TYPE_CONNECT,
  TYPE_DISCONNECT,
  P_TYPE_TRANSFER,
  TYPE_HEARTBEAT,
  ProxyMessage
} = require('./protocol');
const channelManager = require('./channelManager');
const { createSSLContext } = require('./sslContext');

// Constants (matching Java)
const READ_IDLE_TIME = 60;    // seconds
const WRITE_IDLE_TIME = 40;   // seconds

// Reconnection settings
let sleepTimeMill = 1000;
const MAX_SLEEP_TIME = 60000;

// Timers
let sslContext = null;

// Track if this is the first connection (command channel)
let firstConnection = true;

// Socket metadata storage
const socketMeta = new WeakMap();

function setSocketMeta(socket, meta) {
  socketMeta.set(socket, meta);
}

function getSocketMeta(socket) {
  return socketMeta.get(socket);
}

/**
 * Create a proxy socket connection
 */
function createProxyConnection(port, host) {
  const sslEnabled = config.getBooleanValue('ssl.enable', false);

  if (sslEnabled) {
    if (!sslContext) {
      sslContext = createSSLContext();
    }
    return tls.connect({
      host: host,
      port: port,
      rejectUnauthorized: false,
      ...(sslContext ? { secureContext: sslContext } : {})
    });
  } else {
    const socket = new net.Socket();
    socket.connect(port, host);
    return socket;
  }
}

/**
 * Start heartbeat timer
 */
function startHeartbeat(socket) {
  const meta = getSocketMeta(socket);
  if (!meta) return;
  stopHeartbeat(socket);

  meta.heartbeatTimer = setInterval(() => {
    if (!socket.destroyed && socket.writable) {
      const msg = new ProxyMessage();
      msg.setType(TYPE_HEARTBEAT);
      socket.write(encodeProxyMessage(msg));
    }
  }, WRITE_IDLE_TIME * 1000);
  setSocketMeta(socket, meta);
}

/**
 * Stop heartbeat timer
 */
function stopHeartbeat(socket) {
  const meta = getSocketMeta(socket);
  if (!meta) return;
  if (meta.heartbeatTimer) {
    clearInterval(meta.heartbeatTimer);
    meta.heartbeatTimer = null;
    setSocketMeta(socket, meta);
  }
}

/**
 * Start idle check timer
 */
function startIdleCheck(socket) {
  const meta = getSocketMeta(socket);
  if (!meta) return;
  stopIdleCheck(socket);

  meta.idleTimer = setInterval(() => {
    if (!socket || socket.destroyed) return;
    const lastReadAt = meta.lastReadAt || 0;
    if (Date.now() - lastReadAt > READ_IDLE_TIME * 1000) {
      socket.destroy();
    }
  }, 1000);
  setSocketMeta(socket, meta);
}

/**
 * Stop idle check timer
 */
function stopIdleCheck(socket) {
  const meta = getSocketMeta(socket);
  if (!meta) return;
  if (meta.idleTimer) {
    clearInterval(meta.idleTimer);
    meta.idleTimer = null;
    setSocketMeta(socket, meta);
  }
}

/**
 * Handle TYPE_CONNECT message - connect to real server
 */
function handleConnectMessage(proxyChannel, msg) {
  const userId = msg.getUri();
  const serverInfo = msg.getData().toString('utf8').split(':');
  const ip = serverInfo[0];
  const port = parseInt(serverInfo[1], 10);

  logger.info(`TYPE_CONNECT: Real server ${ip}:${port} for user ${userId}`);

  const realServerSocket = new net.Socket();

  realServerSocket.connect(port, ip, () => {
    logger.info(`Connected to real server: ${ip}:${port}`);

    // Borrow a proxy data channel
    channelManager.borrowProxyChannel({}, (err, dataChannel) => {
      if (err) {
        logger.error(`Failed to borrow proxy channel: ${err.message}`);
        const disconnectMsg = new ProxyMessage();
        disconnectMsg.setType(TYPE_DISCONNECT);
        disconnectMsg.setUri(userId);
        proxyChannel.write(encodeProxyMessage(disconnectMsg));
        realServerSocket.destroy();
        return;
      }

      // Bind channels bidirectionally
      channelManager.setNextChannel(dataChannel, realServerSocket);
      channelManager.setNextChannel(realServerSocket, dataChannel);
      channelManager.setAttribute(realServerSocket, 'userId', userId);

      // Track connection
      channelManager.addRealServerChannel(userId, realServerSocket);
      channelManager.setRealServerChannelUserId(realServerSocket, userId);

      // Send TYPE_CONNECT to proxy server with userId@clientKey
      const connectMsg = new ProxyMessage();
      connectMsg.setType(TYPE_CONNECT);
      connectMsg.setUri(`${userId}@${config.getStringValue('client.key')}`);
      dataChannel.write(encodeProxyMessage(connectMsg));

      // Set up real server handlers
      setupRealServerHandler(realServerSocket, dataChannel, userId);
    });
  });

  realServerSocket.on('error', (err) => {
    logger.error(`Real server connection error: ${err.message}`);
    const disconnectMsg = new ProxyMessage();
    disconnectMsg.setType(TYPE_DISCONNECT);
    disconnectMsg.setUri(userId);
    proxyChannel.write(encodeProxyMessage(disconnectMsg));
  });
}

/**
 * Set up real server handlers
 */
function setupRealServerHandler(realServerSocket, dataChannel, userId) {
  realServerSocket.on('data', (data) => {
    const nextChannel = channelManager.getNextChannel(realServerSocket);
    if (!nextChannel || !nextChannel.writable) {
      realServerSocket.destroy();
      return;
    }

    const msg = new ProxyMessage();
    msg.setType(P_TYPE_TRANSFER);
    msg.setUri(userId);
    msg.setData(data);
    const ok = nextChannel.write(encodeProxyMessage(msg));
    if (!ok) {
      realServerSocket.pause();
      nextChannel.once('drain', () => {
        if (!realServerSocket.destroyed) realServerSocket.resume();
      });
    }
  });

  realServerSocket.on('end', () => {
    channelManager.removeRealServerChannel(userId);
    const nextChannel = channelManager.getNextChannel(realServerSocket);
    if (nextChannel && nextChannel.writable) {
      const msg = new ProxyMessage();
      msg.setType(TYPE_DISCONNECT);
      msg.setUri(userId);
      nextChannel.write(encodeProxyMessage(msg));
    }
  });

  realServerSocket.on('error', (err) => {
    logger.error(`Real server error: ${err.message}`);
  });

  realServerSocket.on('close', () => {
    channelManager.removeRealServerChannel(userId);
  });
}

/**
 * Handle TYPE_DISCONNECT message
 */
function handleDisconnectMessage(proxyChannel, msg) {
  const realServerChannel = channelManager.getNextChannel(proxyChannel);
  logger.info(`TYPE_DISCONNECT received`);

  if (realServerChannel) {
    channelManager.setNextChannel(proxyChannel, null);
    channelManager.returnProxyChannel(proxyChannel);
    realServerChannel.end();
  }
}

/**
 * Handle P_TYPE_TRANSFER message
 */
function handleTransferMessage(proxyChannel, msg) {
  const realServerChannel = channelManager.getNextChannel(proxyChannel);
  if (realServerChannel && realServerChannel.writable) {
    realServerChannel.write(msg.getData());
  }
}

/**
 * Handle incoming socket data
 */
function handleSocketData(socket, data) {
  const meta = getSocketMeta(socket);
  if (!meta) return;
  meta.lastReadAt = Date.now();

  let buffer = meta.readBuffer || Buffer.alloc(0);
  buffer = Buffer.concat([buffer, data]);

  const { frames, remaining } = frameDecoder(buffer);
  meta.readBuffer = remaining;
  setSocketMeta(socket, meta);

  for (const frame of frames) {
    const msg = decodeProxyMessage(frame);
    if (!msg) continue;

    logger.debug(`Received message type: ${msg.getType()}`);

    switch (msg.getType()) {
      case TYPE_CONNECT:
        handleConnectMessage(socket, msg);
        break;
      case TYPE_DISCONNECT:
        handleDisconnectMessage(socket, msg);
        break;
      case P_TYPE_TRANSFER:
        handleTransferMessage(socket, msg);
        break;
      default:
        break;
    }
  }
}

/**
 * Connect to proxy server
 */
function connectProxyServer() {
  const host = config.getStringValue('server.host');
  const port = config.getIntValue('server.port', 4900);

  logger.info(`Connecting to proxy server ${host}:${port}...`);

  const socket = createProxyConnection(port, host);

  // Initialize metadata
  const isFirst = firstConnection;
  setSocketMeta(socket, {
    isCmdChannel: isFirst,
    readBuffer: Buffer.alloc(0),
    lastReadAt: Date.now(),
    heartbeatTimer: null,
    idleTimer: null
  });

  // If first connection, set as command channel
  if (isFirst) {
    channelManager.setCmdChannel(socket);
    firstConnection = false;
  }

  // Connection successful
  socket.on('connect', () => {
    logger.info(`Connected to proxy server: ${host}:${port}`);
    sleepTimeMill = 1000; // Reset backoff

    if (isFirst) {
      // Send authentication
      const authMsg = new ProxyMessage();
      authMsg.setType(C_TYPE_AUTH);
      authMsg.setUri(config.getStringValue('client.key'));
      socket.write(encodeProxyMessage(authMsg));
      logger.info(`Sent AUTH message`);

      // Start heartbeat
      startHeartbeat(socket);
    }

    // Start idle check
    startIdleCheck(socket);
  });

  // Handle data events
  socket.on('data', (data) => {
    handleSocketData(socket, data);
  });

  // Handle close
  socket.on('close', () => {
    logger.warn(`Connection closed`);
    stopHeartbeat(socket);
    stopIdleCheck(socket);

    const meta = getSocketMeta(socket);
    if (meta && meta.isCmdChannel) {
      // Command channel closed - reconnect
      channelManager.setCmdChannel(null);
      channelManager.clearRealServerChannels();
      firstConnection = true; // Next connection is command channel
      reconnectWithBackoff();
    } else {
      // Data channel closed
      const realServerChannel = channelManager.getNextChannel(socket);
      if (realServerChannel && realServerChannel.writable) {
        realServerChannel.destroy();
      }
      channelManager.removeProxyChannel(socket);
    }
  });

  // Handle errors
  socket.on('error', (err) => {
    logger.error(`Socket error: ${err.message}`);
  });

  socket.on('end', () => {
    logger.warn(`Socket ended`);
  });
}

/**
 * Exponential backoff reconnection
 */
async function reconnectWithBackoff() {
  if (sleepTimeMill > MAX_SLEEP_TIME) {
    sleepTimeMill = 1000;
  }
  logger.info(`Waiting ${sleepTimeMill}ms before reconnect...`);

  await new Promise(resolve => setTimeout(resolve, sleepTimeMill));
  sleepTimeMill *= 2;

  connectProxyServer();
}

/**
 * Main client class
 */
class ProxyClientContainer {
  start() {
    logger.info(`Starting lanproxy client...`);
    firstConnection = true;
    sleepTimeMill = 1000;
    sslContext = null;
    connectProxyServer();
  }

  stop() {
    const cmd = channelManager.getCmdChannel();
    if (cmd) {
      stopHeartbeat(cmd);
      stopIdleCheck(cmd);
      cmd.destroy();
    }
    channelManager.clearRealServerChannels();
    firstConnection = true;
    logger.info(`lanproxy client stopped`);
  }

  getStatus() {
    const connected = channelManager.isConnected();
    const host = config.getStringValue('server.host');
    const port = config.getIntValue('server.port', 4900);
    return {
      enabled: true,
      connected,
      server: `${host}:${port}`,
      activeConnections: channelManager.getActiveConnections(),
      poolSize: channelManager.getPoolSize()
    };
  }
}

/**
 * Factory function - validates config before creating client
 */
function createProxyClient() {
  const clientKey = config.getStringValue('client.key');
  const serverHost = config.getStringValue('server.host');

  if (!clientKey) {
    console.error('[proxy] PROXY_CLIENT_KEY is required but not set');
    return null;
  }

  if (!serverHost) {
    console.error('[proxy] PROXY_SERVER_HOST is required but not set');
    return null;
  }

  return new ProxyClientContainer();
}

module.exports = {
  ProxyClientContainer,
  createProxyClient
};
