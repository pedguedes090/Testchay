import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import {
  validName,
  rolesForCount,
  canPerform,
  newRoomCode,
  server,
  rooms,
} from '../server.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startServer() {
  rooms.clear();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function stopServer() {
  for (const room of rooms.values()) room.phase = 'FINISHED';
  await new Promise((resolve) => server.close(resolve));
  rooms.clear();
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const timer = setTimeout(() => reject(new Error('WebSocket connect timeout')), 1500);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(ws);
    }, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
}

function waitForMessage(ws, predicate, timeoutMs = 1800) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener('message', onMessage);
      reject(new Error('Message timeout'));
    }, timeoutMs);
    function onMessage(event) {
      const message = JSON.parse(event.data);
      if (!predicate(message)) return;
      clearTimeout(timer);
      ws.removeEventListener('message', onMessage);
      resolve(message);
    }
    ws.addEventListener('message', onMessage);
  });
}

async function setup(t) {
  const sockets = [];
  const port = await startServer();
  t.after(async () => {
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    }
    await delay(40);
    if (server.listening) await stopServer();
  });
  return {
    port,
    async open() {
      const ws = await connect(port);
      sockets.push(ws);
      return ws;
    },
  };
}

async function createPlayer(ws, name = 'Cá Mập') {
  const welcomePromise = waitForMessage(ws, (m) => m.type === 'welcome');
  ws.send(JSON.stringify({ type: 'create', name }));
  return welcomePromise;
}

async function joinPlayer(ws, roomCode, name = 'Cá Con') {
  const welcomePromise = waitForMessage(ws, (m) => m.type === 'welcome');
  ws.send(JSON.stringify({ type: 'join', code: roomCode, name }));
  return welcomePromise;
}

test('validates player names', () => {
  assert.equal(validName('Cá Mập'), true);
  assert.equal(validName('x'), false);
  assert.equal(validName('<script>'), false);
});

test('assigns unique roles for 4–6 players', () => {
  for (const n of [4, 5, 6]) assert.equal(new Set(rolesForCount(n)).size, n);
});

test('guards actions by role', () => {
  assert.equal(canPerform('jump', 'jump'), true);
  assert.equal(canPerform('jump', 'throw'), false);
  assert.equal(canPerform('actionThrow', 'throw'), true);
});

test('creates five-character room codes', () => {
  assert.match(newRoomCode(() => 0.1), /^[A-Z2-9]{5}$/);
});

test('reconnects using the session id and reconnect token', async (t) => {
  const env = await setup(t);
  const first = await env.open();
  const session = await createPlayer(first);
  const firstClosed = once(first, 'close');
  first.close();
  await firstClosed;
  const resumed = await env.open();
  const welcomePromise = waitForMessage(resumed, (m) => m.type === 'welcome' && m.resumed === true);
  resumed.send(JSON.stringify({
    type: 'resume', roomCode: session.roomCode, sessionId: session.sessionId,
    reconnectToken: session.reconnectToken,
  }));
  const welcome = await welcomePromise;
  assert.equal(welcome.sessionId, session.sessionId);
  assert.equal(rooms.get(session.roomCode).players[0].connected, true);
});

test('disconnect releases every held input for that player', async (t) => {
  const env = await setup(t);
  const ws = await env.open();
  const session = await createPlayer(ws);
  const room = rooms.get(session.roomCode);
  room.phase = 'PLAYING';
  room.assignment[session.sessionId] = 'pace';
  room.inputs[session.sessionId] = {};
  room.game = {
    x: 4, y: 0, vy: 0, speed: 0, truckX: 42, collisions: 0,
    bagIntegrity: 100, delivered: false, score: null, reason: null,
    endsAt: Date.now() + 120000, nextShuffleAt: Date.now() + 20000,
    obstacles: [], cameraOffset: 0,
  };
  ws.send(JSON.stringify({ type: 'input', action: 'accelerate', pressed: true, sequence: 1 }));
  await delay(40);
  assert.equal(room.inputs[session.sessionId].accelerate, true);
  const socketClosed = once(ws, 'close');
  ws.close();
  await socketClosed;
  await delay(40);
  assert.equal(room.inputs[session.sessionId].accelerate, false);
});

test('only the host can request a rematch after the game finishes', async (t) => {
  const env = await setup(t);
  const host = await env.open();
  const hostSession = await createPlayer(host, 'Chủ Phòng');
  const guest = await env.open();
  await joinPlayer(guest, hostSession.roomCode, 'Khách Chơi');
  const room = rooms.get(hostSession.roomCode);
  room.phase = 'FINISHED';
  room.game = { score: 123, reason: 'timeout' };
  guest.send(JSON.stringify({ type: 'rematch' }));
  await delay(50);
  assert.equal(room.phase, 'FINISHED');
});

test('a started game publishes obstacles and bag integrity', async (t) => {
  const env = await setup(t);
  const ws = await env.open();
  const session = await createPlayer(ws, 'Chủ Phòng');
  t.after(() => ws.close());
  for (let i = 0; i < 3; i += 1) ws.send(JSON.stringify({ type: 'add_bot' }));
  await delay(50);
  ws.send(JSON.stringify({ type: 'start' }));
  await delay(50);
  const room = rooms.get(session.roomCode);
  room.countdownEndsAt = Date.now() - 1;
  const stateMessage = await waitForMessage(ws, (m) => m.type === 'state' && m.state.phase === 'PLAYING');
  assert.ok(Array.isArray(stateMessage.state.game.obstacles));
  assert.ok(stateMessage.state.game.obstacles.length >= 4);
  assert.equal(stateMessage.state.game.bagIntegrity, 100);
});

test('game simulation damages the bag on a missed jump obstacle', async () => {
  const module = await import('../server.js');
  assert.equal(typeof module.simulateGameStep, 'function');
  const now = Date.now();
  const room = {
    phase: 'PLAYING',
    players: [
      { id: 'm', connected: true, bot: false }, { id: 'p', connected: true, bot: false },
      { id: 'j', connected: true, bot: false }, { id: 'a', connected: true, bot: false },
    ],
    assignment: { m: 'move', p: 'pace', j: 'jump', a: 'action' },
    inputs: { m: { right: true }, p: { accelerate: true }, j: {}, a: {} },
    game: {
      x: 17.7, lastX: 17.7, y: 0, vy: 0, speed: 8, truckX: 50,
      collisions: 0, bagIntegrity: 100, delivered: false, score: null, reason: null,
      endsAt: now + 10000, nextShuffleAt: now + 10000, cameraOffset: 0,
      obstacles: [{ id: 'crate', x: 18, type: 'jump', hit: false }],
    },
  };
  module.simulateGameStep(room, 0.1, now);
  assert.equal(room.game.collisions, 1);
  assert.equal(room.game.bagIntegrity, 82);
  assert.equal(room.game.obstacles[0].avoided, false);
});

test('game simulation lets slide input avoid a low obstacle', async () => {
  const module = await import('../server.js');
  assert.equal(typeof module.simulateGameStep, 'function');
  const now = Date.now();
  const room = {
    phase: 'PLAYING',
    players: [
      { id: 'm', connected: true, bot: false }, { id: 'p', connected: true, bot: false },
      { id: 'j', connected: true, bot: false }, { id: 'a', connected: true, bot: false },
    ],
    assignment: { m: 'move', p: 'pace', j: 'jump', a: 'action' },
    inputs: { m: { right: true }, p: { accelerate: true }, j: {}, a: { slide: true } },
    game: {
      x: 31.7, lastX: 31.7, y: 0, vy: 0, speed: 8, truckX: 55,
      collisions: 0, bagIntegrity: 100, delivered: false, score: null, reason: null,
      endsAt: now + 10000, nextShuffleAt: now + 10000, cameraOffset: 0,
      obstacles: [{ id: 'bar', x: 32, type: 'slide', hit: false }],
    },
  };
  module.simulateGameStep(room, 0.1, now);
  assert.equal(room.game.collisions, 0);
  assert.equal(room.game.bagIntegrity, 100);
  assert.equal(room.game.obstacles[0].avoided, true);
});

test('host ownership migrates to the next connected human', async (t) => {
  const env = await setup(t);
  const host = await env.open();
  const hostSession = await createPlayer(host, 'Chủ Phòng');
  const guest = await env.open();
  const guestSession = await joinPlayer(guest, hostSession.roomCode, 'Khách Chơi');
  const hostClosed = once(host, 'close');
  host.close();
  await hostClosed;
  await delay(40);
  assert.equal(rooms.get(hostSession.roomCode).hostId, guestSession.sessionId);
});

test('public websocket state never exposes reconnect tokens', async (t) => {
  const env = await setup(t);
  const ws = await env.open();
  await createPlayer(ws);
  const stateMessage = await waitForMessage(ws, (message) => message.type === 'state');
  assert.equal('token' in stateMessage.state.players[0], false);
  assert.equal(JSON.stringify(stateMessage.state).includes('reconnectToken'), false);
});
