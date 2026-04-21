/**
 * ProxyMessage - Protocol message types and wire format
 * Mirrors Java ProxyMessage, ProxyMessageEncoder, ProxyMessageDecoder
 */

const TYPE_SIZE = 1;
const SERIAL_NUMBER_SIZE = 8;
const URI_LENGTH_SIZE = 1;
const HEADER_SIZE = 4; // length field

// Message types
const TYPE_HEARTBEAT = 0x07;
const C_TYPE_AUTH = 0x01;
const TYPE_CONNECT = 0x03;
const TYPE_DISCONNECT = 0x04;
const P_TYPE_TRANSFER = 0x05;
const C_TYPE_WRITE_CONTROL = 0x06;

class ProxyMessage {
  constructor() {
    this.type = 0;
    this.serialNumber = 0;
    this.uri = '';
    this.data = null;
  }

  setType(type) {
    this.type = type;
  }

  getType() {
    return this.type;
  }

  setUri(uri) {
    this.uri = uri;
  }

  getUri() {
    return this.uri;
  }

  setData(data) {
    this.data = data;
  }

  getData() {
    return this.data;
  }

  setSerialNumber(sn) {
    this.serialNumber = sn;
  }

  getSerialNumber() {
    return this.serialNumber;
  }

  toString() {
    return `ProxyMessage [type=${this.type}, serialNumber=${this.serialNumber}, uri=${this.uri}, data=${this.data ? '[bytes]' : null}]`;
  }
}

/**
 * ProxyMessageEncoder - Encodes ProxyMessage to wire format
 * Format: [4-byte length][1-byte type][8-byte sn][1-byte uriLen][uri][data]
 */
function encodeProxyMessage(msg) {
  const uriBytes = msg.uri ? Buffer.from(msg.uri, 'utf8') : Buffer.alloc(0);
  const dataBytes = msg.data ? Buffer.from(msg.data) : Buffer.alloc(0);

  let bodyLength = TYPE_SIZE + SERIAL_NUMBER_SIZE + URI_LENGTH_SIZE;
  if (uriBytes.length > 0) bodyLength += uriBytes.length;
  if (dataBytes.length > 0) bodyLength += dataBytes.length;

  // Allocate buffer: 4 (length) + bodyLength
  const buf = Buffer.alloc(4 + bodyLength);
  let offset = 0;

  // Write length (big-endian 4-byte int)
  buf.writeUInt32BE(bodyLength, offset);
  offset += 4;

  // Write type (1 byte)
  buf.writeUInt8(msg.type, offset);
  offset += TYPE_SIZE;

  // Write serial number (8 bytes big-endian)
  buf.writeBigUInt64BE(BigInt(msg.serialNumber), offset);
  offset += SERIAL_NUMBER_SIZE;

  // Write URI length + URI
  buf.writeUInt8(uriBytes.length, offset);
  offset += URI_LENGTH_SIZE;
  if (uriBytes.length > 0) {
    uriBytes.copy(buf, offset);
    offset += uriBytes.length;
  }

  // Write data
  if (dataBytes.length > 0) {
    dataBytes.copy(buf, offset);
  }

  return buf;
}

/**
 * ProxyMessageDecoder - Decodes wire format to ProxyMessage
 * Uses LengthFieldBasedFrameDecoder logic
 */
const MAX_FRAME_LENGTH = 1024 * 1024; // 1 MB

function decodeProxyMessage(buffer) {
  if (buffer.length < HEADER_SIZE) {
    return null;
  }

  const bodyLength = buffer.readUInt32BE(0);
  if (buffer.length < HEADER_SIZE + bodyLength) {
    return null;
  }

  let offset = HEADER_SIZE;

  // Read type
  const type = buffer.readUInt8(offset);
  offset += TYPE_SIZE;

  // Read serial number
  const sn = Number(buffer.readBigUInt64BE(offset));
  offset += SERIAL_NUMBER_SIZE;

  // Read URI length and URI
  const uriLength = buffer.readUInt8(offset);
  offset += URI_LENGTH_SIZE;

  let uri = '';
  if (uriLength > 0) {
    uri = buffer.slice(offset, offset + uriLength).toString('utf8');
    offset += uriLength;
  }

  // Read data
  const dataLength = bodyLength - TYPE_SIZE - SERIAL_NUMBER_SIZE - URI_LENGTH_SIZE - uriLength;
  let data = null;
  if (dataLength > 0) {
    data = buffer.slice(offset, offset + dataLength);
  }

  const msg = new ProxyMessage();
  msg.setType(type);
  msg.setSerialNumber(sn);
  msg.setUri(uri);
  msg.setData(data ? data : null);

  return msg;
}

/**
 * FrameDecoder - Mimics LengthFieldBasedFrameDecoder
 * Returns array of complete frames from buffer
 */
function frameDecoder(buffer) {
  const frames = [];
  let offset = 0;

  while (offset + HEADER_SIZE <= buffer.length) {
    const bodyLength = buffer.readUInt32BE(offset);
    const frameLength = HEADER_SIZE + bodyLength;

    if (offset + frameLength > buffer.length) {
      break; // Incomplete frame
    }

    const frame = buffer.slice(offset, offset + frameLength);
    frames.push(frame);
    offset += frameLength;
  }

  // Keep remaining bytes in buffer
  const remaining = buffer.slice(offset);

  return { frames, remaining };
}

module.exports = {
  TYPE_HEARTBEAT,
  C_TYPE_AUTH,
  TYPE_CONNECT,
  TYPE_DISCONNECT,
  P_TYPE_TRANSFER,
  C_TYPE_WRITE_CONTROL,
  ProxyMessage,
  encodeProxyMessage,
  decodeProxyMessage,
  frameDecoder,
  MAX_FRAME_LENGTH
};