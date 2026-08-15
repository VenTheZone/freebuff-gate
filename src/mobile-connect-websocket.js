'use strict';

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

class RelayWebSocket extends EventEmitter {
  constructor(socket, head = Buffer.alloc(0), options = {}) {
    super();
    this.socket = socket;
    this.maxFrameBytes = options.maxFrameBytes || MAX_FRAME_BYTES;
    this.buffer = Buffer.from(head);
    this.closed = false;
    this.closeEmitted = false;
    this.closeTimer = null;

    socket.setNoDelay(true);
    socket.on('data', (chunk) => this.consume(chunk));
    socket.on('close', () => this.finishClose());
    socket.on('error', (error) => this.emit('error', error));
    if (this.buffer.length > 0) this.consume();
  }

  consume(chunk) {
    if (this.closed && !chunk) return;
    if (chunk) this.buffer = Buffer.concat([this.buffer, chunk]);

    try {
      while (!this.closed) {
        const frame = this.readFrame();
        if (!frame) return;
        this.handleFrame(frame);
      }
    } catch (error) {
      this.emit('protocolError', error);
      this.close(1002, 'Protocol error');
    }
  }

  readFrame() {
    if (this.buffer.length < 2) return null;
    const first = this.buffer[0];
    const second = this.buffer[1];
    const fin = (first & 0x80) !== 0;
    const rsv = first & 0x70;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;

    if (!fin || rsv !== 0 || opcode === 0) {
      throw new Error('Fragmentation and extensions are not supported');
    }
    if (!masked) throw new Error('Client frame was not masked');

    if (length === 126) {
      if (this.buffer.length < offset + 2) return null;
      length = this.buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (this.buffer.length < offset + 8) return null;
      const largeLength = this.buffer.readBigUInt64BE(offset);
      offset += 8;
      if (largeLength > BigInt(this.maxFrameBytes)) {
        throw new Error('Frame is too large');
      }
      length = Number(largeLength);
    }

    if (length > this.maxFrameBytes) throw new Error('Frame is too large');
    const isControl = opcode >= 8;
    if (isControl && (length > 125 || !fin)) throw new Error('Invalid control frame');
    if (this.buffer.length < offset + 4 + length) return null;

    const mask = this.buffer.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
    this.buffer = this.buffer.subarray(offset + length);
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] ^= mask[index % 4];
    }
    return { opcode, payload };
  }

  handleFrame(frame) {
    switch (frame.opcode) {
      case 0x1:
        this.emit('message', frame.payload.toString('utf8'), false);
        break;
      case 0x2:
        this.emit('message', frame.payload, true);
        break;
      case 0x8:
        if (!this.closed) {
          const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1000;
          this.close(code, frame.payload.subarray(2).toString('utf8'));
        }
        break;
      case 0x9:
        this.sendFrame(0xA, frame.payload);
        this.emit('ping');
        break;
      case 0xA:
        this.emit('pong');
        break;
      default:
        throw new Error(`Unsupported WebSocket opcode ${frame.opcode}`);
    }
  }

  sendJson(value) {
    this.sendFrame(0x1, Buffer.from(JSON.stringify(value), 'utf8'));
  }

  sendText(value) {
    this.sendFrame(0x1, Buffer.from(String(value), 'utf8'));
  }

  sendBinary(value) {
    this.sendFrame(0x2, Buffer.from(value));
  }

  sendFrame(opcode, payload) {
    if (this.closed || this.socket.destroyed) return false;
    const body = Buffer.from(payload);
    if (body.length > this.maxFrameBytes) throw new Error('Frame is too large');
    let header;
    if (body.length < 126) {
      header = Buffer.from([0x80 | opcode, body.length]);
    } else if (body.length <= 0xffff) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(body.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(body.length), 2);
    }
    this.socket.write(Buffer.concat([header, body]));
    return true;
  }

  ping(payload = '') {
    this.sendFrame(0x9, Buffer.from(payload));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    this.closed = true;
    const reasonBuffer = Buffer.from(String(reason), 'utf8').subarray(0, 123);
    const payload = Buffer.alloc(2 + reasonBuffer.length);
    payload.writeUInt16BE(code, 0);
    reasonBuffer.copy(payload, 2);
    if (!this.socket.destroyed) {
      this.sendFrameEvenWhenClosing(0x8, payload);
      this.closeTimer = setTimeout(() => this.socket.destroy(), 1000);
      this.socket.end();
    }
    this.finishClose();
  }

  sendFrameEvenWhenClosing(opcode, payload) {
    const wasClosed = this.closed;
    this.closed = false;
    try {
      this.sendFrame(opcode, payload);
    } finally {
      this.closed = wasClosed;
    }
  }

  finishClose() {
    if (this.closeEmitted) return;
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = null;
    this.closed = true;
    this.closeEmitted = true;
    this.emit('close');
  }
}

function parseSubprotocols(value) {
  return String(value || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function acceptUpgrade(req, socket, head, options = {}) {
  const key = String(req.headers['sec-websocket-key'] || '');
  const version = String(req.headers['sec-websocket-version'] || '');
  if (!key || version !== '13') {
    rejectUpgrade(socket, 400, 'Bad WebSocket handshake');
    return null;
  }
  if (options.allowedOrigin) {
    const origin = String(req.headers.origin || '');
    if (origin && origin !== options.allowedOrigin) {
      rejectUpgrade(socket, 403, 'Origin not allowed');
      return null;
    }
  }

  const accept = crypto
    .createHash('sha1')
    .update(`${key}${WEBSOCKET_GUID}`)
    .digest('base64');
  const headers = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
  ];
  if (options.protocol) headers.push(`Sec-WebSocket-Protocol: ${options.protocol}`);
  socket.write(`${headers.join('\r\n')}\r\n\r\n`);
  const connection = new RelayWebSocket(socket, head, options);
  if (typeof options.onConnection === 'function') options.onConnection(connection);
  return connection;
}

function rejectUpgrade(socket, status, message) {
  const body = `${message}\n`;
  socket.end(
    `HTTP/1.1 ${status} ${message}\r\n` +
      'Connection: close\r\n' +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n` +
      body,
  );
}

module.exports = {
  MAX_FRAME_BYTES,
  RelayWebSocket,
  acceptUpgrade,
  parseSubprotocols,
  rejectUpgrade,
};
