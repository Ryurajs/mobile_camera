import { randomUUID, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

const port = Number(process.env.PORT ?? 8787);
const requestTimeoutMs = 60_000;
const devices = new Map();
const pendingRequests = new Map();
const httpServer = createServer((request, response) => {
  if (request.url === '/healthz') {
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.end('ok');
    return;
  }
  response.writeHead(404);
  response.end('Not found');
});
const server = new WebSocketServer({ server: httpServer });

function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function sameSecret(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function reject(socket, message) {
  send(socket, { type: 'error', message });
}

server.on('connection', (socket) => {
  let registeredDeviceId;

  socket.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      reject(socket, 'Invalid message.');
      return;
    }

    if (message.type === 'register') {
      if (!/^\d{8}$/.test(message.deviceId) || !/^[A-F0-9]{16}$/.test(message.pairingKey)) {
        reject(socket, 'Invalid phone credentials.');
        return;
      }
      const current = devices.get(message.deviceId);
      if (current && !sameSecret(current.pairingKey, message.pairingKey)) {
        reject(socket, 'That phone number is already paired.');
        return;
      }
      if (current && current.socket !== socket) current.socket.close(4001, 'Replaced by a newer connection');
      registeredDeviceId = message.deviceId;
      devices.set(message.deviceId, { pairingKey: message.pairingKey, socket });
      send(socket, { type: 'registered' });
      return;
    }

    if (message.type === 'request') {
      const device = devices.get(message.deviceId);
      if (!device || device.socket.readyState !== WebSocket.OPEN) {
        reject(socket, 'That phone is offline.');
        return;
      }
      if ([...pendingRequests.values()].some((pending) => pending.deviceId === message.deviceId)) {
        reject(socket, 'A request is already waiting on that phone.');
        return;
      }

      const requestId = randomUUID();
      const timer = setTimeout(() => {
        const pending = pendingRequests.get(requestId);
        if (!pending) return;
        pendingRequests.delete(requestId);
        send(pending.browser, { type: 'response', requestId, accepted: false, message: 'The request expired.' });
        send(pending.phone, { type: 'closed', requestId });
      }, requestTimeoutMs);
      pendingRequests.set(requestId, { browser: socket, phone: device.socket, deviceId: message.deviceId, timer });
      send(device.socket, { type: 'request', requestId });
      send(socket, { type: 'queued', requestId });
      return;
    }

    if (message.type === 'response') {
      const pending = pendingRequests.get(message.requestId);
      if (!pending || pending.phone !== socket || registeredDeviceId !== pending.deviceId) return;
      clearTimeout(pending.timer);
      pendingRequests.delete(message.requestId);
      send(pending.browser, { type: 'response', requestId: message.requestId, accepted: message.accepted === true });
      return;
    }

    reject(socket, 'Unsupported message type.');
  });

  socket.on('close', () => {
    if (registeredDeviceId && devices.get(registeredDeviceId)?.socket === socket) {
      devices.delete(registeredDeviceId);
    }
    for (const [requestId, pending] of pendingRequests) {
      if (pending.browser !== socket && pending.phone !== socket) continue;
      clearTimeout(pending.timer);
      pendingRequests.delete(requestId);
      if (pending.browser !== socket) send(pending.browser, { type: 'response', requestId, accepted: false, message: 'The phone disconnected.' });
    }
  });
});

httpServer.listen(port, '0.0.0.0', () => {
  console.log(`Camera Link relay listening on port ${port}`);
});