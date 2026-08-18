'use strict';

// Phase 1 mobile-connect tunnel:
//   SPAKE2-P256-SHA256-HKDF-HMAC (RFC 9382)
//   AES-256-GCM sequence-bound binary frames
//   blind WebSocket relay and HTTP bridge

const crypto = require('node:crypto');
const { URL } = require('node:url');
const { p256 } = require('@noble/curves/nist.js');

const TUNNEL_PROTOCOL = 'fb-tunnel-v1';
const SPAKE2_SUITE = 'SPAKE2-P256-SHA256-HKDF-HMAC';
const TUNNEL_CONTEXT = Buffer.from('freebuff-gate/tunnel/v1', 'ascii');
const SPAKE2_SCRYPT_SALT = Buffer.from('freebuff-gate/tunnel/v1/spake2', 'ascii');
const SPAKE2_SCRYPT_N = 16_384;
const SPAKE2_SCRYPT_R = 8;
const SPAKE2_SCRYPT_P = 1;
const SPAKE2_SCRYPT_KEY_BYTES = 48;
const HANDSHAKE_TIMEOUT_MS = 20_000;
const FRAME_PREFIX_BYTES = 4;
const FRAME_HEADER_BYTES = 4 + 8 + 12;
const GCM_TAG_BYTES = 16;
const MAX_FRAME_PAYLOAD_BYTES = 8 * 1024 * 1024;
const MAX_FRAME_BYTES = FRAME_PREFIX_BYTES + MAX_FRAME_PAYLOAD_BYTES;
const MAX_MESSAGE_BYTES = MAX_FRAME_PAYLOAD_BYTES - FRAME_HEADER_BYTES - GCM_TAG_BYTES;
const FRAME_MAGIC = Buffer.from('FBT1', 'ascii');
const FIELD_LENGTH_BYTES = 8;
const SCALAR_BYTES = 32;
const POINT_BYTES = 65;
const ZERO = Buffer.from([0]);

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const SPAKE2_M_HEX = '02886e2f97ace46e55ba9dd7242579f2993b64e16ef3dcab95afd497333d8fa12f';
const SPAKE2_N_HEX = '03d8bbd6c639c62937b04d997f38c3770719c629d7014d49a24b4f98baa1292b49';
const SPAKE2_M = hexToBuffer(SPAKE2_M_HEX);
const SPAKE2_N = hexToBuffer(SPAKE2_N_HEX);
const P256_ORDER = p256.Point.Fn.ORDER;
const P256_ORDER_BYTES = bigIntToBuffer(P256_ORDER, SCALAR_BYTES);

function hexToBuffer(value) {
  const text = String(value);
  if (!/^(?:[0-9a-f]{2})*$/i.test(text)) throw new TypeError('Expected an even-length hexadecimal string');
  return Buffer.from(text, 'hex');
}

function toBuffer(value, label = 'value') {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  throw new TypeError(`${label} must be a Buffer, Uint8Array, or string`);
}

function toBigInt(value, label = 'scalar') {
  if (typeof value === 'bigint') return value;
  const bytes = toBuffer(value, label);
  if (!bytes.length) throw new RangeError(`${label} must not be empty`);
  return BigInt(`0x${bytes.toString('hex')}`);
}

function bigIntToBuffer(value, length = SCALAR_BYTES) {
  const number = BigInt(value);
  if (number < 0n) throw new RangeError('Cannot encode negative integer');
  const hex = number.toString(16).padStart(length * 2, '0');
  if (hex.length > length * 2) throw new RangeError('Integer does not fit fixed-width encoding');
  return Buffer.from(hex, 'hex');
}

function sha256(...parts) {
  const hash = crypto.createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest();
}

function hmacSha256(key, ...parts) {
  const mac = crypto.createHmac('sha256', key);
  for (const part of parts) mac.update(part);
  return mac.digest();
}

function hkdfSha256(ikm, salt, info, length) {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, length));
}

function encodeLength(value) {
  const bytes = Buffer.alloc(FIELD_LENGTH_BYTES);
  bytes.writeBigUInt64LE(BigInt(value), 0);
  return bytes;
}

function scalarFromToken(token) {
  const password = toBuffer(token, 'token');
  if (!password.length) throw new Error('SPAKE2 token must not be empty');
  const derived = crypto.scryptSync(password, SPAKE2_SCRYPT_SALT, SPAKE2_SCRYPT_KEY_BYTES, {
    N: SPAKE2_SCRYPT_N,
    r: SPAKE2_SCRYPT_R,
    p: SPAKE2_SCRYPT_P,
    maxmem: 32 * 1024 * 1024,
  });
  const scalar = BigInt(`0x${Buffer.from(derived).toString('hex')}`) % P256_ORDER;
  if (scalar === 0n) throw new Error('SPAKE2 token derived zero scalar');
  return scalar;
}

function randomScalar(randomBytes = crypto.randomBytes) {
  for (;;) {
    const candidate = toBigInt(randomBytes(SCALAR_BYTES), 'random scalar');
    if (candidate > 0n && candidate < P256_ORDER) return candidate;
  }
}

function scalarValue(value, label) {
  const scalar = toBigInt(value, label);
  if (scalar <= 0n || scalar >= P256_ORDER) throw new RangeError(`${label} must be in [1, P-1]`);
  return scalar;
}

function pointBytes(point, compressed = false) {
  return Buffer.from(point.toBytes(compressed));
}

function pointView(point) {
  // noble-curves returns Uint8Array. Buffer-facing view keeps this module's
  // public byte API consistent with Node's crypto APIs and test vectors.
  return {
    toBytes: (compressed = false) => pointBytes(point, compressed),
    toHex: (compressed = false) => pointBytes(point, compressed).toString('hex'),
    equals: (other) => point.equals(other?._point || other),
    get is0() { return point.is0(); },
    _point: point,
  };
}

function parsePoint(value, label = 'point') {
  const bytes = toBuffer(value, label);
  if (bytes.length !== 33 && bytes.length !== POINT_BYTES) {
    throw new Error(`${label} has invalid length`);
  }
  try {
    const point = p256.Point.fromBytes(bytes);
    point.assertValidity();
    if (point.is0()) throw new Error(`${label} must not be identity`);
    return point;
  } catch (error) {
    throw new Error(`Invalid ${label}: ${error.message}`);
  }
}

function deriveKeys(sharedSecret, transcriptHash) {
  const secret = toBuffer(sharedSecret, 'shared secret');
  const transcript = toBuffer(transcriptHash, 'transcript hash');
  if (!secret.length) throw new Error('Shared secret must not be empty');
  if (transcript.length !== 32) throw new Error('Transcript hash must be 32 bytes');

  const salt = sha256(TUNNEL_CONTEXT, ZERO, transcript);
  const mobileToAgent = hkdfSha256(
    secret,
    salt,
    Buffer.concat([TUNNEL_CONTEXT, ZERO, Buffer.from('mobile-to-agent', 'ascii')]),
    32,
  );
  const agentToMobile = hkdfSha256(
    secret,
    salt,
    Buffer.concat([TUNNEL_CONTEXT, ZERO, Buffer.from('agent-to-mobile', 'ascii')]),
    32,
  );
  return {
    mobileToAgent,
    agentToMobile,
    // Compatibility aliases for the old tunnel prototype's callers.
    m2a: mobileToAgent,
    a2m: agentToMobile,
  };
}

class Spake2Session {
  constructor(options = {}) {
    this.role = options.role || 'mobile';
    if (this.role !== 'mobile' && this.role !== 'agent') throw new Error('SPAKE2 role must be mobile or agent');

    this.identityA = toBuffer(options.identityA ?? 'freebuff-gate/mobile', 'identityA');
    this.identityB = toBuffer(options.identityB ?? 'freebuff-gate/agent', 'identityB');
    if (!this.identityA.length || !this.identityB.length) throw new Error('SPAKE2 identities must not be empty');
    if (this.identityA.length > 0xffff || this.identityB.length > 0xffff) throw new Error('SPAKE2 identity too long');

    this.aad = toBuffer(options.aad ?? Buffer.alloc(0), 'AAD');
    this.w = options.w !== undefined
      ? scalarValue(options.w, 'SPAKE2 w')
      : scalarFromToken(options.token);
    this.wBytes = bigIntToBuffer(this.w, SCALAR_BYTES);
    this.scalar = options.scalar !== undefined
      ? scalarValue(options.scalar, 'SPAKE2 ephemeral scalar')
      : randomScalar(options.randomBytes);

    this.mask = p256.Point.fromBytes(this.role === 'mobile' ? SPAKE2_M : SPAKE2_N);
    this.messagePoint = p256.Point.BASE.multiply(this.scalar).add(this.mask.multiply(this.w));
    this.message = pointBytes(this.messagePoint, false);
    this.peerMessage = null;
    this.sharedPoint = null;
    this.transcript = null;
    this.transcriptHash = null;
    this.ke = null;
    this.ka = null;
    this.confirmation = null;
    this.peerConfirmed = false;
    this.ready = false;
  }

  receivePeerMessage(peerMessage) {
    if (this.peerMessage) throw new Error('SPAKE2 peer message already received');
    const peerBytes = toBuffer(peerMessage, 'SPAKE2 peer message');
    const peerPoint = parsePoint(peerBytes, 'SPAKE2 peer message');
    const peerMask = this.role === 'mobile' ? p256.Point.fromBytes(SPAKE2_N) : p256.Point.fromBytes(SPAKE2_M);
    const unmasked = peerPoint.subtract(peerMask.multiply(this.w));
    if (unmasked.is0()) throw new Error('SPAKE2 peer message unmasks to identity');
    const shared = unmasked.multiply(this.scalar);
    if (shared.is0()) throw new Error('SPAKE2 shared point is identity');

    this.peerMessage = peerBytes;
    this.sharedPoint = pointView(shared);
    const pA = this.role === 'mobile' ? this.message : peerBytes;
    const pB = this.role === 'mobile' ? peerBytes : this.message;
    this.transcript = Buffer.concat([
      encodeLength(this.identityA.length), this.identityA,
      encodeLength(this.identityB.length), this.identityB,
      encodeLength(pA.length), pA,
      encodeLength(pB.length), pB,
      encodeLength(POINT_BYTES), pointBytes(shared, false),
      encodeLength(this.wBytes.length), this.wBytes,
    ]);
    this.transcriptHash = sha256(this.transcript);
    this.ke = this.transcriptHash.subarray(0, 16);
    this.ka = this.transcriptHash.subarray(16, 32);

    const confirmationMaterial = hkdfSha256(
      this.ka,
      Buffer.alloc(0),
      Buffer.concat([Buffer.from('ConfirmationKeys', 'ascii'), this.aad]),
      32,
    );
    const keyA = confirmationMaterial.subarray(0, 16);
    const keyB = confirmationMaterial.subarray(16, 32);
    const side = this.role === 'mobile' ? 'A' : 'B';
    const key = side === 'A' ? keyA : keyB;
    this.confirmation = {
      type: 'tunnel.confirm',
      side,
      mac: hmacSha256(key, this.transcript),
    };
    return this.confirmation;
  }

  verifyPeerConfirmation(confirmation) {
    if (!this.confirmation) throw new Error('SPAKE2 peer message not received');
    if (!confirmation || confirmation.type !== 'tunnel.confirm') throw new Error('Invalid SPAKE2 confirmation');
    const expectedSide = this.role === 'mobile' ? 'B' : 'A';
    if (confirmation.side !== expectedSide) throw new Error('SPAKE2 confirmation side mismatch');
    const peerMac = toBuffer(confirmation.mac, 'SPAKE2 confirmation MAC');
    if (peerMac.length !== 32) throw new Error('SPAKE2 confirmation MAC must be 32 bytes');

    const confirmationMaterial = hkdfSha256(
      this.ka,
      Buffer.alloc(0),
      Buffer.concat([Buffer.from('ConfirmationKeys', 'ascii'), this.aad]),
      32,
    );
    const peerKey = expectedSide === 'A' ? confirmationMaterial.subarray(0, 16) : confirmationMaterial.subarray(16, 32);
    const expected = hmacSha256(peerKey, this.transcript);
    if (!crypto.timingSafeEqual(expected, peerMac)) throw new Error('SPAKE2 confirmation verification failed');
    this.peerConfirmed = true;
    this.ready = true;
    return true;
  }

  tunnelKeys() {
    if (!this.transcriptHash || !this.ke) throw new Error('SPAKE2 handshake not complete');
    return deriveKeys(this.ke, this.transcriptHash);
  }
}

function normalizeSequence(value, label = 'sequence') {
  let sequence;
  if (typeof value === 'bigint') sequence = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value)) sequence = BigInt(value);
  else if (typeof value === 'string' && /^\d+$/.test(value)) sequence = BigInt(value);
  else throw new TypeError(`${label} must be an integer`);
  if (sequence < 0n || sequence > 0xffffffffffffffffn) throw new RangeError(`${label} outside uint64 range`);
  return sequence;
}

function jsonBytes(message) {
  const encoded = JSON.stringify(message);
  if (encoded === undefined) throw new TypeError('Tunnel message must be JSON serializable');
  const bytes = Buffer.from(encoded, 'utf8');
  if (bytes.length > MAX_MESSAGE_BYTES) throw new Error('Tunnel message exceeds maximum size');
  return bytes;
}

function encodeFrame(key, sequence, message, options = {}) {
  const secret = toBuffer(key, 'frame key');
  if (secret.length !== 32) throw new Error('Frame key must be 32 bytes');
  const seq = normalizeSequence(sequence);
  const nonce = options.nonce === undefined ? crypto.randomBytes(12) : toBuffer(options.nonce, 'frame nonce');
  if (nonce.length !== 12) throw new Error('Frame nonce must be 12 bytes');
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  FRAME_MAGIC.copy(header, 0);
  header.writeBigUInt64BE(seq, 4);
  nonce.copy(header, 12);

  const plain = jsonBytes(message);
  const cipher = crypto.createCipheriv('aes-256-gcm', secret, nonce);
  cipher.setAAD(header);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  const bodyLength = header.length + encrypted.length;
  const frame = Buffer.alloc(FRAME_PREFIX_BYTES + bodyLength);
  frame.writeUInt32BE(bodyLength, 0);
  header.copy(frame, FRAME_PREFIX_BYTES);
  encrypted.copy(frame, FRAME_PREFIX_BYTES + header.length);
  return frame;
}

function decodeFrame(key, frame, expectedSequence = 0n) {
  const secret = toBuffer(key, 'frame key');
  if (secret.length !== 32) throw new Error('Frame key must be 32 bytes');
  const bytes = toBuffer(frame, 'frame');
  if (bytes.length < FRAME_PREFIX_BYTES) throw new Error('Frame length prefix missing');
  if (bytes.length > MAX_FRAME_BYTES) throw new Error('Frame exceeds maximum size');
  const bodyLength = bytes.readUInt32BE(0);
  if (bodyLength !== bytes.length - FRAME_PREFIX_BYTES) throw new Error('Frame length mismatch');
  if (bodyLength > MAX_FRAME_PAYLOAD_BYTES) throw new Error('Frame exceeds maximum size');
  if (bodyLength < FRAME_HEADER_BYTES + GCM_TAG_BYTES) throw new Error('Frame too short');

  const header = bytes.subarray(FRAME_PREFIX_BYTES, FRAME_PREFIX_BYTES + FRAME_HEADER_BYTES);
  if (!header.subarray(0, 4).equals(FRAME_MAGIC)) throw new Error('Frame magic mismatch');
  const sequence = header.readBigUInt64BE(4);
  const expected = normalizeSequence(expectedSequence, 'expected sequence');
  if (sequence !== expected) throw new Error(`Frame sequence out of order: expected ${expected}, got ${sequence}`);
  const nonce = header.subarray(12, 24);
  const encrypted = bytes.subarray(FRAME_PREFIX_BYTES + FRAME_HEADER_BYTES);
  if (encrypted.length < GCM_TAG_BYTES) throw new Error('Frame authentication tag missing');

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', secret, nonce);
    decipher.setAAD(header);
    decipher.setAuthTag(encrypted.subarray(encrypted.length - GCM_TAG_BYTES));
    const plain = Buffer.concat([
      decipher.update(encrypted.subarray(0, encrypted.length - GCM_TAG_BYTES)),
      decipher.final(),
    ]);
    if (plain.length > MAX_MESSAGE_BYTES) throw new Error('Decoded tunnel message exceeds maximum size');
    return { sequence, message: JSON.parse(plain.toString('utf8')) };
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('Decoded tunnel message is not valid JSON');
    throw new Error(`Frame authentication failed: ${error.message}`);
  }
}

function seal(key, plaintext, aad, nonce = crypto.randomBytes(12)) {
  const secret = toBuffer(key, 'encryption key');
  if (secret.length !== 32) throw new Error('Encryption key must be 32 bytes');
  const iv = toBuffer(nonce, 'nonce');
  if (iv.length !== 12) throw new Error('Nonce must be 12 bytes');
  const plain = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : toBuffer(plaintext, 'plaintext');
  const cipher = crypto.createCipheriv('aes-256-gcm', secret, iv);
  if (aad !== undefined) cipher.setAAD(toBuffer(aad, 'AAD'));
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  return { nonce: iv, body: encrypted };
}

function open(key, nonce, body, aad) {
  const secret = toBuffer(key, 'decryption key');
  if (secret.length !== 32) throw new Error('Decryption key must be 32 bytes');
  const iv = toBuffer(nonce, 'nonce');
  const encrypted = toBuffer(body, 'encrypted body');
  if (iv.length !== 12 || encrypted.length < GCM_TAG_BYTES) throw new Error('Invalid encrypted body');
  const decipher = crypto.createDecipheriv('aes-256-gcm', secret, iv);
  if (aad !== undefined) decipher.setAAD(toBuffer(aad, 'AAD'));
  decipher.setAuthTag(encrypted.subarray(encrypted.length - GCM_TAG_BYTES));
  return Buffer.concat([
    decipher.update(encrypted.subarray(0, encrypted.length - GCM_TAG_BYTES)),
    decipher.final(),
  ]);
}

function messageDataBuffer(data) {
  if (typeof data === 'string') return Promise.resolve(Buffer.from(data, 'utf8'));
  if (data instanceof ArrayBuffer) return Promise.resolve(Buffer.from(data));
  if (Buffer.isBuffer(data)) return Promise.resolve(data);
  if (data && typeof data.arrayBuffer === 'function') return data.arrayBuffer().then((value) => Buffer.from(value));
  return Promise.resolve(Buffer.from(String(data ?? ''), 'utf8'));
}

function normalizeWsUrl(raw) {
  const parsed = new URL(String(raw));
  if (!['wss:', 'ws:'].includes(parsed.protocol)) throw new Error('Tunnel URL must use WSS/WS');
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

function truncateCloseReason(reason) {
  return String(reason || '').slice(0, 120);
}

class TunnelPeer {
  constructor(options = {}) {
    if (typeof WebSocket !== 'function') throw new Error('Node WebSocket client unavailable; use Node 22');
    this.url = normalizeWsUrl(options.url || options.wsUrl);
    this.token = options.token;
    this.role = options.role || 'mobile';
    if (this.role !== 'mobile' && this.role !== 'agent') throw new Error('TunnelPeer role must be mobile or agent');
    this.onReady = typeof options.onReady === 'function' ? options.onReady : () => {};
    this.onMessage = typeof options.onMessage === 'function' ? options.onMessage : () => {};
    this.onClose = typeof options.onClose === 'function' ? options.onClose : () => {};
    this.onError = typeof options.onError === 'function' ? options.onError : () => {};
    this.logger = typeof options.logger === 'function' ? options.logger : () => {};
    this.socket = null;
    this.session = null;
    this.sendKey = null;
    this.recvKey = null;
    this.sendSequence = 0n;
    this.recvSequence = 0n;
    this.sentConfirm = false;
    this.confirmReceived = false;
    this.ready = false;
    this.closed = false;
    this.failureReported = false;
  }

  start() {
    this.closed = false;
    this.failureReported = false;
    try {
      this.session = new Spake2Session({ role: this.role, token: this.token });
    } catch (error) {
      this.fail(error.message);
      return this;
    }
    let socket;
    try {
      socket = new WebSocket(this.url);
    } catch (error) {
      this.onError(error);
      return this;
    }
    this.socket = socket;
    socket.addEventListener('open', () => {
      this.sendJson({
        type: 'tunnel.hello',
        role: this.role,
        protocol: TUNNEL_PROTOCOL,
        suite: SPAKE2_SUITE,
        message: this.session.message.toString('base64'),
      });
    });
    socket.addEventListener('message', (event) => {
      messageDataBuffer(event.data)
        .then((data) => this.handleBytes(data))
        .catch((error) => this.fail(`message handling failed: ${error.message}`));
    });
    socket.addEventListener('error', (event) => {
      this.logger('tunnel_socket_error', { role: this.role });
      this.onError(event);
    });
    socket.addEventListener('close', (event) => {
      this.closed = true;
      this.socket = null;
      if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
      this.onClose(event.code || 1006, event.reason || '');
    });
    this.handshakeTimer = setTimeout(() => {
      if (!this.ready && !this.closed) {
        this.logger('tunnel_handshake_timeout', { role: this.role });
        this.close(4000, 'Handshake timed out');
      }
    }, HANDSHAKE_TIMEOUT_MS);
    return this;
  }

  handleBytes(buffer) {
    const data = toBuffer(buffer, 'relay data');
    if (data[0] === 0x7b) {
      let message;
      try {
        message = JSON.parse(data.toString('utf8'));
      } catch {
        this.fail('relay sent invalid JSON');
        return;
      }
      this.handleControlMessage(message);
      return;
    }
    if (!this.ready || !this.recvKey) {
      this.fail('encrypted frame before handshake completed');
      return;
    }
    try {
      const decoded = decodeFrame(this.recvKey, data, this.recvSequence);
      this.recvSequence = decoded.sequence + 1n;
      this.onMessage(decoded.message);
    } catch (error) {
      this.fail(error.message);
    }
  }

  handleControlMessage(message) {
    if (!message || typeof message !== 'object') {
      this.fail('relay sent invalid control message');
      return;
    }
    if (message.type === 'tunnel.hello') {
      if (this.ready || this.session.peerMessage) {
        this.fail('duplicate tunnel hello');
        return;
      }
      if (message.protocol !== TUNNEL_PROTOCOL || message.suite !== SPAKE2_SUITE) {
        this.fail('tunnel protocol or suite mismatch');
        return;
      }
      const expectedRole = this.role === 'mobile' ? 'agent' : 'mobile';
      if (message.role !== expectedRole) {
        this.fail('tunnel peer role mismatch');
        return;
      }
      try {
        this.session.receivePeerMessage(Buffer.from(String(message.message || ''), 'base64'));
        this.sendKey = this.role === 'agent' ? this.session.tunnelKeys().agentToMobile : this.session.tunnelKeys().mobileToAgent;
        this.recvKey = this.role === 'agent' ? this.session.tunnelKeys().mobileToAgent : this.session.tunnelKeys().agentToMobile;
        this.sendJson({
          type: 'tunnel.confirm',
          protocol: TUNNEL_PROTOCOL,
          side: this.session.confirmation.side,
          mac: this.session.confirmation.mac.toString('base64'),
        });
        this.sentConfirm = true;
        this.maybeReady();
      } catch (error) {
        this.fail(`SPAKE2 handshake failed: ${error.message}`);
      }
      return;
    }
    if (message.type === 'tunnel.confirm') {
      if (!this.session || !this.sentConfirm || message.protocol !== TUNNEL_PROTOCOL) {
        this.fail('unexpected tunnel confirmation');
        return;
      }
      try {
        this.session.verifyPeerConfirmation({
          type: 'tunnel.confirm',
          side: message.side,
          mac: Buffer.from(String(message.mac || ''), 'base64'),
        });
        this.confirmReceived = true;
        this.maybeReady();
      } catch (error) {
        this.fail(`SPAKE2 confirmation failed: ${error.message}`);
      }
      return;
    }
    this.fail(`unexpected tunnel control message: ${message.type}`);
  }

  maybeReady() {
    if (!this.ready && this.sentConfirm && this.confirmReceived && this.session.ready) {
      this.ready = true;
      if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
      this.logger('tunnel_ready', { role: this.role });
      this.onReady();
    }
  }

  send(message) {
    if (!this.ready || !this.sendKey || this.closed) return false;
    try {
      const frame = encodeFrame(this.sendKey, this.sendSequence, message);
      this.sendSequence += 1n;
      return this.sendBinary(frame);
    } catch (error) {
      this.fail(`frame encode failed: ${error.message}`);
      return false;
    }
  }

  sendBinary(frame) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(frame);
    return true;
  }

  sendJson(message) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  fail(reason) {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    this.logger('tunnel_fail', { role: this.role, reason: error.message });
    if (!this.failureReported) {
      this.failureReported = true;
      this.onError(error);
    }
    this.close(4002, error.message);
  }

  close(code = 1000, reason = '') {
    this.closed = true;
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    if (this.socket) {
      try {
        this.socket.close(code, truncateCloseReason(reason));
      } catch {
        // Socket may already be closed.
      }
    }
    this.socket = null;
  }
}

// Desktop side: bridge tunnel HTTP messages to local Freebuff UI (58061).
// WebSocket bridging remains outside Phase 1.
class TunnelAgent {
  constructor(options = {}) {
    this.relayWsUrl = options.relayWsUrl || process.env.FB_MOBILE_RELAY_WS_URL;
    this.sessionId = options.sessionId || process.env.FB_MOBILE_TUNNEL_SESSION;
    this.token = options.token !== undefined ? options.token : process.env.FB_MOBILE_TUNNEL_TOKEN;
    this.upstreamUrl = options.upstreamUrl || process.env.FB_MOBILE_UI_URL || 'http://127.0.0.1:58061';
    this.logger = typeof options.logger === 'function' ? options.logger : () => {};
    if (!this.relayWsUrl || !this.sessionId || !this.token) throw new Error('TunnelAgent needs relayWsUrl, sessionId, and token');
    this.httpControllers = new Map();
    this.upstreamSockets = new Map();
    this.peer = null;
  }

  start() {
    const url = `${this.relayWsUrl}/v1/tunnel?session=${encodeURIComponent(this.sessionId)}`;
    this.peer = new TunnelPeer({
      url,
      token: this.token,
      role: 'agent',
      logger: this.logger,
      onReady: () => this.logger('tunnel_agent_ready', { sessionId: this.sessionId }),
      onMessage: (message) => this.handleMessage(message),
      onClose: (code, reason) => this.logger('tunnel_agent_closed', { code, reason }),
      onError: (error) => this.logger('tunnel_agent_error', { message: error.message }),
    });
    this.peer.start();
    return this;
  }

  stop() {
    for (const controller of this.httpControllers.values()) controller.abort();
    this.httpControllers.clear();
    for (const socket of this.upstreamSockets.values()) socket.close();
    this.upstreamSockets.clear();
    if (this.peer) this.peer.close(1000, 'Agent stopped');
  }

  send(message) {
    return this.peer && this.peer.send(message);
  }

  handleMessage(message) {
    switch (message.type) {
      case 'http.request':
        this.handleHttpRequest(message);
        break;
      case 'http.cancel':
        this.httpControllers.get(String(message.id || ''))?.abort();
        break;
      case 'ws.open':
      case 'ws.message':
      case 'ws.close':
        this.send({ type: 'ws.error', id: message.id, message: 'WebSocket bridging not available in tunnel Phase 1' });
        break;
      default:
        this.logger('tunnel_unknown_message', { type: message.type });
    }
  }

  async handleHttpRequest(message) {
    const id = String(message.id || '');
    if (!id) return;
    const controller = new AbortController();
    this.httpControllers.set(id, controller);
    try {
      const target = new URL(String(message.path || '/'), `${this.upstreamUrl}/`);
      const method = String(message.method || 'GET').toUpperCase();
      const body = message.bodyBase64 ? Buffer.from(message.bodyBase64, 'base64') : null;
      const headers = {};
      for (const [key, value] of Object.entries(message || {})) {
        if (key.startsWith('h:')) headers[key.slice(2)] = String(value);
      }
      const init = {
        method,
        headers: this.filterHeaders(headers),
        redirect: 'manual',
        signal: controller.signal,
      };
      if (body && method !== 'GET' && method !== 'HEAD') init.body = body;
      const response = await fetch(target, init);
      this.send({
        type: 'http.response.start',
        id,
        status: response.status,
        headers: this.responseHeaders(response.headers),
      });
      if (response.body) {
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          this.send({ type: 'http.response.chunk', id, dataBase64: Buffer.from(value).toString('base64') });
        }
      }
      this.send({ type: 'http.response.end', id });
    } catch (error) {
      if (!controller.signal.aborted) this.send({ type: 'http.error', id, message: error.message || 'Upstream request failed' });
    } finally {
      this.httpControllers.delete(id);
    }
  }

  filterHeaders(headers) {
    const result = {};
    for (const [name, value] of Object.entries(headers || {})) {
      const lower = name.toLowerCase();
      if (
        HOP_BY_HOP_HEADERS.has(lower) ||
        lower === 'host' ||
        lower === 'content-length' ||
        lower === 'accept-encoding' ||
        lower === 'sec-websocket-accept' ||
        lower === 'sec-websocket-key' ||
        lower === 'sec-websocket-protocol'
      ) continue;
      result[name] = Array.isArray(value) ? value.join(', ') : String(value ?? '');
    }
    return result;
  }

  responseHeaders(headers) {
    const result = {};
    for (const [name, value] of headers) {
      const lower = name.toLowerCase();
      if (HOP_BY_HOP_HEADERS.has(lower) || lower === 'content-length' || lower === 'content-encoding') continue;
      result[name] = value;
    }
    return result;
  }
}

module.exports = {
  FRAME_HEADER_BYTES,
  FRAME_MAGIC,
  HANDSHAKE_TIMEOUT_MS,
  MAX_FRAME_PAYLOAD_BYTES,
  MAX_FRAME_BYTES,
  MAX_MESSAGE_BYTES,
  P256_ORDER_BYTES,
  SPAKE2_M,
  SPAKE2_N,
  SPAKE2_SCRYPT_SALT,
  SPAKE2_SUITE,
  TUNNEL_CONTEXT,
  TUNNEL_PROTOCOL,
  TunnelAgent,
  TunnelPeer,
  Spake2Session,
  decodeFrame,
  deriveKeys,
  encodeFrame,
  hexToBuffer,
  messageDataBuffer,
  normalizeWsUrl,
  open,
  seal,
  scalarFromToken,
};
