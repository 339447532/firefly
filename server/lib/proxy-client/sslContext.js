/**
 * SslContextCreator - Creates SSL context for TLS connections
 * Supports PEM format certificates for Node.js
 * Certificate paths resolve relative to the server root directory.
 */

const fs = require('fs');
const path = require('path');
const tls = require('tls');
const config = require('./config');

const SERVER_DIR = path.join(__dirname, '..', '..');
const RUNTIME_DIR = process.pkg ? path.dirname(process.execPath) : SERVER_DIR;

function resolveCertPath(certPath) {
  if (path.isAbsolute(certPath)) {
    return certPath;
  }
  // Resolve relative to runtime directory (next to the binary or server root)
  const runtimePath = path.join(RUNTIME_DIR, certPath);
  if (fs.existsSync(runtimePath)) {
    return runtimePath;
  }
  // Fall back to the source server directory during development.
  return path.join(SERVER_DIR, certPath);
}

/**
 * Create SSL context from PEM certificates
 */
function createSSLContext() {
  const certPath = config.getStringValue('ssl.certPath');
  const keyPath = config.getStringValue('ssl.keyPath');
  const keyPassword = config.getStringValue('ssl.keyPassword');

  if (!certPath || !keyPath) {
    console.warn('[proxy] SSL certificate or key path is null or empty. SSL context won\'t be initialized.');
    return null;
  }

  try {
    const resolvedCertPath = resolveCertPath(certPath);
    const resolvedKeyPath = resolveCertPath(keyPath);

    if (!fs.existsSync(resolvedCertPath)) {
      console.warn(`[proxy] Certificate file does not exist: ${resolvedCertPath}`);
      return null;
    }

    if (!fs.existsSync(resolvedKeyPath)) {
      console.warn(`[proxy] Key file does not exist: ${resolvedKeyPath}`);
      return null;
    }

    // Read certificates
    const cert = fs.readFileSync(resolvedCertPath);
    const key = fs.readFileSync(resolvedKeyPath);

    const options = {
      cert: cert,
      key: key,
      passphrase: keyPassword || undefined
    };

    // Create TLS context
    const sslContext = tls.createSecureContext(options);
    console.info('[proxy] SSL context initialized successfully');
    return sslContext;

  } catch (err) {
    console.error(`[proxy] Unable to initialize SSL context. Cause: ${err.message}`);
    return null;
  }
}

module.exports = {
  createSSLContext
};
