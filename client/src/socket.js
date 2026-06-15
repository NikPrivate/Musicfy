import { io } from 'socket.io-client';

// Same-origin connection (dev proxies /socket.io to the Node server).
export const socket = io({
  autoConnect: true,
  transports: ['websocket', 'polling'],
});

// Promise-based emit helper using Socket.IO acknowledgements.
export function emit(event, payload = {}) {
  return new Promise((resolve) => {
    socket.emit(event, payload, (res) => resolve(res || { ok: false }));
  });
}
