/**
 * Logger - Simple logger with configurable log level
 */

const config = require('./config');

// Log levels
const LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3
};

const LEVEL_NAMES = ['DEBUG', 'INFO', 'WARN', 'ERROR'];

// Get configured log level, default to INFO
const configuredLevel = config.getStringValue('log.level', 'INFO').toUpperCase();
const currentLevel = LEVELS[configuredLevel] !== undefined ? LEVELS[configuredLevel] : LEVELS.INFO;

function formatMessage(level, message) {
  const timestamp = new Date().toISOString();
  return `[${timestamp}] [${level}] [proxy] ${message}`;
}

function debug(message) {
  if (currentLevel <= LEVELS.DEBUG) {
    console.log(formatMessage('DEBUG', message));
  }
}

function info(message) {
  if (currentLevel <= LEVELS.INFO) {
    console.log(formatMessage('INFO', message));
  }
}

function warn(message) {
  if (currentLevel <= LEVELS.WARN) {
    console.warn(formatMessage('WARN', message));
  }
}

function error(message) {
  if (currentLevel <= LEVELS.ERROR) {
    console.error(formatMessage('ERROR', message));
  }
}

module.exports = {
  debug,
  info,
  warn,
  error,
  LEVELS
};