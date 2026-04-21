/**
 * ProxyConfig - Environment variable based configuration
 * Replaces the original properties-file based Config class.
 * Reads all proxy settings from environment variables (loaded via dotenv).
 */

class ProxyConfig {
  constructor() {
    this.properties = {};
    this._loadFromEnv();
  }

  _loadFromEnv() {
    this.properties = {
      'client.key': process.env.PROXY_CLIENT_KEY || '',
      'ssl.enable': process.env.PROXY_SSL_ENABLE || 'false',
      'ssl.certPath': process.env.PROXY_SSL_CERT_PATH || 'conf/client-cert.pem',
      'ssl.keyPath': process.env.PROXY_SSL_KEY_PATH || 'conf/client-key.pem',
      'ssl.keyPassword': process.env.PROXY_SSL_KEY_PASSWORD || 'changeit',
      'server.host': process.env.PROXY_SERVER_HOST || '',
      'server.port': process.env.PROXY_SERVER_PORT || '4900',
      'log.level': process.env.PROXY_LOG_LEVEL || 'INFO'
    };
  }

  getStringValue(key, defaultValue = null) {
    const value = this.properties[key];
    return value !== undefined ? value : defaultValue;
  }

  getIntValue(key, defaultValue = 0) {
    const value = this.properties[key];
    if (value === undefined) return defaultValue;
    const parsed = parseInt(value, 10);
    return isNaN(parsed) ? defaultValue : parsed;
  }

  getBooleanValue(key, defaultValue = false) {
    const value = this.properties[key];
    if (value === undefined) return defaultValue;
    return value.toLowerCase() === 'true';
  }
}

module.exports = new ProxyConfig();