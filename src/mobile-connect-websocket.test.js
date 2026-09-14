'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { RelayWebSocket } = require('./mobile-connect-websocket');

// Minimal stand-in for net.Socket: only what RelayWebSocket touches.
function fakeSocket({ writeThrows = false } = {}) {
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.ended = false;
  socket.writes = [];
  socket.setNoDelay = () => {};
  socket.write = (buffer) => {
    if (writeThrows) {
      const error = new Error('write ECONNABORTED');
      error.code = 'ECONNABORTED';
      throw error;
    }
    socket.writes.push(buffer);
    return true;
  };
  socket.end = () => {
    socket.ended = true;
  };
  socket.destroy = () => {
    socket.destroyed = true;
    socket.emit('close');
  };
  return socket;
}

function abortedWriteError() {
  const error = new Error('write ECONNABORTED');
  error.code = 'ECONNABORTED';
  return error;
}

test('a socket error closes one connection instead of crashing the host', () => {
  const socket = fakeSocket();
  const connection = new RelayWebSocket(socket);
  let closes = 0;
  connection.on('close', () => {
    closes += 1;
  });

  const failure = abortedWriteError();
  // Neither the relay nor the agent subscribes to this class's 'error' event,
  // so re-emitting the socket error here used to take the whole process down.
  assert.doesNotThrow(() => socket.emit('error', failure));

  assert.equal(connection.closed, true);
  assert.equal(closes, 1);
  assert.equal(connection.lastError, failure);
});

test('repeated socket errors close the connection once', () => {
  const socket = fakeSocket();
  const connection = new RelayWebSocket(socket);
  let closes = 0;
  connection.on('close', () => {
    closes += 1;
  });

  socket.emit('error', abortedWriteError());
  socket.emit('error', abortedWriteError());
  socket.emit('error', abortedWriteError());

  assert.equal(closes, 1);
  assert.equal(connection.closed, true);
});

test('a failing write closes the connection and reports failure', () => {
  const socket = fakeSocket({ writeThrows: true });
  const connection = new RelayWebSocket(socket);
  let closes = 0;
  connection.on('close', () => {
    closes += 1;
  });

  let result;
  assert.doesNotThrow(() => {
    result = connection.sendFrame(0x1, Buffer.from('hello'));
  });

  assert.equal(result, false);
  assert.equal(connection.closed, true);
  assert.equal(closes, 1);
  assert.ok(connection.lastError, 'the write failure is recorded');
});

test('a closed connection drops later frames instead of writing to a dead socket', () => {
  const socket = fakeSocket();
  const connection = new RelayWebSocket(socket);
  socket.emit('error', abortedWriteError());
  const writesBefore = socket.writes.length;

  assert.equal(connection.sendFrame(0x1, Buffer.from('late')), false);
  connection.sendJson({ type: 'late' });
  assert.equal(socket.writes.length, writesBefore);
});
