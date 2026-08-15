'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { QrCode, renderQrText } = require('./mobile-connect-qr');

test('QR renderer encodes pairing URL into bounded matrix with quiet zone', () => {
  const payload = 'https://relay.example.invalid/pair#pairingId=p_test&token=0123456789abcdefghijklmnopqrstuvwxyz';
  const qr = QrCode.encodeText(payload);
  const rendered = renderQrText(payload);
  const lines = rendered.split('\n');

  assert.ok(qr.size >= 21 && qr.size <= 57);
  assert.equal(lines.length, Math.ceil((qr.size + 8) / 2));
  assert.equal(lines.every((line) => line.length === qr.size + 8), true);
  assert.equal(/[█▀▄]/.test(rendered), true);
  assert.equal(rendered.includes(payload), false);
  assert.equal(qr.getModule(-1, -1), false);
  assert.equal(qr.getModule(qr.size, qr.size), false);
  assert.equal(qr.getModule(3, 3), true);
});

test('QR renderer supports Unicode input through byte mode', () => {
  const qr = QrCode.encodeText('Freebuff 📱 pairing');
  assert.ok(qr.size >= 21);
  let dark = 0;
  for (let y = 0; y < qr.size; y += 1) {
    for (let x = 0; x < qr.size; x += 1) dark += qr.getModule(x, y) ? 1 : 0;
  }
  assert.ok(dark > 0 && dark < qr.size * qr.size);
});

test('QR renderer rejects payloads beyond supported terminal range', () => {
  assert.throws(
    () => QrCode.encodeText('x'.repeat(300)),
    /too long/i,
  );
});
