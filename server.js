import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PORT = Number(process.env.PORT || 3000);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const COUNTDOWN_MS = Number(process.env.COUNTDOWN_MS || 5000);
const GAME_DURATION_MS = Number(process.env.GAME_DURATION_MS || 120000);
const SHUFFLE_MS = Number(process.env.SHUFFLE_MS || 20000);
const ROOM_IDLE_MS = Number(process.env.ROOM_IDLE_MS || 10 * 60 * 1000);
const MAX_FRAME_BYTES = 1024 * 1024;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROLES = {
  4: ['moveCamera', 'pace', 'jump', 'actionThrow'],
  5: ['move', 'pace', 'jump', 'camera', 'actionThrow'],
  6: ['move', 'pace', 'jump', 'action', 'camera', 'throw'],
};
const ACTIONS = {
  move: ['left', 'right'],
  pace: ['accelerate', 'brake'],
  jump: ['jump'],
  action: ['slide'],
  camera: ['cameraLeft', 'cameraRight'],
  throw: ['throw'],
  actionThrow: ['slide', 'throw'],
  moveCamera: ['left', 'right', 'cameraLeft', 'cameraRight'],
};
const OBSTACLE_TEMPLATE = [
  { id: 'crate-1', x: 18, type: 'jump', label: 'Thùng hàng' },
  { id: 'sign-1', x: 32, type: 'slide', label: 'Biển thấp' },
  { id: 'cone-1', x: 47, type: 'jump', label: 'Cọc đường' },
  { id: 'bar-1', x: 63, type: 'slide', label: 'Thanh chắn' },
  { id: 'crate-2', x: 78, type: 'jump', label: 'Đống rác' },
];

export const rooms = new Map();
const clients = new Set();

export function validName(value) {
  const name = String(value ?? '').trim();
  return name.length >= 2 && name.length <= 16 && /^[\p{L}\p{N}_ -]+$/u.test(name);
}

export function rolesForCount(count) {
  if (!ROLES[count]) throw new RangeError('Cần 4–6 người');
  return [...ROLES[count]];
}

export function canPerform(role, action) {
  return Boolean(ACTIONS[role]?.includes(action));
}

export function newRoomCode(random = Math.random) {
  let code;
  do {
    code = Array.from({ length: 5 }, () => ALPHABET[Math.floor(random() * ALPHABET.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function shuffle(values) {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function releaseInputs(room, playerId) {
  const input = room.inputs[playerId] || {};
  for (const action of Object.keys(input)) input[action] = false;
  room.inputs[playerId] = input;
}

function assign(room) {
  const players = room.players.filter((player) => player.bot || player.connected || room.phase !== 'LOBBY');
  const roles = shuffle(rolesForCount(players.length));
  room.assignment = Object.fromEntries(players.map((player, index) => [player.id, roles[index]]));
  room.inputs = Object.fromEntries(players.map((player) => [player.id, {}]));
}

function createPlayer(name, bot = false) {
  return {
    id: crypto.randomUUID(),
    token: crypto.randomBytes(18).toString('base64url'),
    name,
    bot,
    connected: true,
    disconnectedAt: null,
    sequence: -1,
  };
}

function createInitialGame(now = Date.now()) {
  return {
    x: 4,
    lastX: 4,
    y: 0,
    vy: 0,
    speed: 0,
    truckX: 40,
    collisions: 0,
    bagIntegrity: 100,
    delivered: false,
    score: null,
    reason: null,
    endsAt: now + GAME_DURATION_MS,
    nextShuffleAt: now + SHUFFLE_MS,
    obstacles: OBSTACLE_TEMPLATE.map((obstacle) => ({ ...obstacle, hit: false })),
    cameraOffset: 0,
  };
}

function publicRoom(room, viewerId) {
  return {
    code: room.code,
    phase: room.phase,
    viewerId,
    hostId: room.hostId,
    announcement: room.announcement,
    players: room.players.map((player) => ({
      id: player.id,
      name: player.name,
      bot: player.bot,
      connected: player.connected,
      role: room.assignment[player.id] || null,
    })),
    countdownMs: Math.max(0, (room.countdownEndsAt || 0) - Date.now()),
    game: room.game
      ? {
          ...room.game,
          remainingMs: Math.max(0, room.game.endsAt - Date.now()),
          nextShuffleMs: Math.max(0, room.game.nextShuffleAt - Date.now()),
        }
      : null,
  };
}

function encodeFrame(text, opcode = 0x1) {
  const data = Buffer.isBuffer(text) ? text : Buffer.from(text);
  let header;
  if (data.length < 126) {
    header = Buffer.from([0x80 | opcode, data.length]);
  } else if (data.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  return Buffer.concat([header, data]);
}

function readFrame(buffer) {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  let length = buffer[1] & 0x7f;
  const masked = Boolean(buffer[1] & 0x80);
  let cursor = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    cursor = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    const largeLength = buffer.readBigUInt64BE(2);
    if (largeLength > BigInt(MAX_FRAME_BYTES)) throw new Error('Payload quá lớn');
    length = Number(largeLength);
    cursor = 10;
  }
  if (length > MAX_FRAME_BYTES) throw new Error('Payload quá lớn');
  let mask;
  if (masked) {
    if (buffer.length < cursor + 4) return null;
    mask = buffer.subarray(cursor, cursor + 4);
    cursor += 4;
  }
  if (buffer.length < cursor + length) return null;
  const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
  if (mask) for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
  return { opcode, payload, consumed: cursor + length };
}

function send(client, value) {
  if (client.socket.destroyed || !client.socket.writable) return;
  client.socket.write(encodeFrame(JSON.stringify(value)));
}

function welcome(client, room, player, resumed = false) {
  client.room = room.code;
  client.id = player.id;
  send(client, {
    type: 'welcome',
    roomCode: room.code,
    sessionId: player.id,
    reconnectToken: player.token,
    resumed,
  });
}

function findAuthenticatedPlayer(client) {
  const room = rooms.get(client.room);
  const player = room?.players.find((candidate) => candidate.id === client.id);
  if (!room || !player) throw new Error('Chưa vào phòng');
  return { room, player };
}

function setNewHost(room) {
  const nextHost = room.players.find((player) => !player.bot && player.connected);
  if (nextHost) room.hostId = nextHost.id;
}

function handleMessage(client, message) {
  let room;
  let player;

  if (message.type === 'create') {
    if (!validName(message.name)) throw new Error('Tên không hợp lệ');
    player = createPlayer(message.name.trim());
    room = {
      code: newRoomCode(),
      phase: 'LOBBY',
      hostId: player.id,
      players: [player],
      assignment: {},
      inputs: {},
      announcement: 'Phòng đã tạo',
      countdownEndsAt: null,
      game: null,
      updatedAt: Date.now(),
    };
    rooms.set(room.code, room);
    welcome(client, room, player);
    return;
  }

  if (message.type === 'join') {
    room = rooms.get(String(message.code || '').toUpperCase());
    if (!room || room.phase !== 'LOBBY') throw new Error('Không thể vào phòng');
    if (room.players.length >= 6) throw new Error('Phòng đầy');
    if (!validName(message.name)) throw new Error('Tên không hợp lệ');
    player = createPlayer(message.name.trim());
    room.players.push(player);
    room.updatedAt = Date.now();
    welcome(client, room, player);
    return;
  }

  if (message.type === 'resume') {
    room = rooms.get(String(message.roomCode || '').toUpperCase());
    player = room?.players.find(
      (candidate) =>
        candidate.id === message.sessionId &&
        candidate.token === message.reconnectToken &&
        !candidate.bot,
    );
    if (!room || !player) throw new Error('Phiên kết nối không hợp lệ');
    player.connected = true;
    player.disconnectedAt = null;
    releaseInputs(room, player.id);
    room.updatedAt = Date.now();
    welcome(client, room, player, true);
    return;
  }

  ({ room, player } = findAuthenticatedPlayer(client));
  room.updatedAt = Date.now();

  if (message.type === 'add_bot') {
    if (room.hostId !== player.id || room.phase !== 'LOBBY' || room.players.length >= 6) {
      throw new Error('Không thể thêm bot');
    }
    room.players.push(createPlayer(`Bot ${room.players.filter((candidate) => candidate.bot).length + 1}`, true));
    return;
  }

  if (message.type === 'start') {
    if (room.hostId !== player.id || room.phase !== 'LOBBY' || room.players.length < 4) {
      throw new Error('Cần đủ 4 người và quyền chủ phòng');
    }
    assign(room);
    room.phase = 'COUNTDOWN';
    room.countdownEndsAt = Date.now() + COUNTDOWN_MS;
    room.announcement = 'Chuẩn bị!';
    return;
  }

  if (message.type === 'input') {
    if (
      room.phase === 'PLAYING' &&
      Number.isSafeInteger(message.sequence) &&
      message.sequence > player.sequence &&
      canPerform(room.assignment[player.id], message.action)
    ) {
      player.sequence = message.sequence;
      room.inputs[player.id] ||= {};
      room.inputs[player.id][message.action] = Boolean(message.pressed);
    }
    return;
  }

  if (message.type === 'release_all') {
    releaseInputs(room, player.id);
    return;
  }

  if (message.type === 'rematch') {
    if (room.phase !== 'FINISHED' || room.hostId !== player.id) throw new Error('Chỉ chủ phòng được chơi lại');
    room.phase = 'LOBBY';
    room.game = null;
    room.assignment = {};
    room.inputs = {};
    room.countdownEndsAt = null;
    room.announcement = 'Sẵn sàng chơi lại';
  }
}

function mergeHumanInputs(room) {
  const merged = {};
  for (const player of room.players) {
    if (!player.connected && !player.bot) continue;
    const role = room.assignment[player.id];
    const input = room.inputs[player.id] || {};
    for (const [action, pressed] of Object.entries(input)) {
      if (pressed && canPerform(role, action)) merged[action] = true;
    }
  }
  return merged;
}

function applyAutopilot(room, merged) {
  const game = room.game;
  for (const player of room.players.filter((candidate) => candidate.bot || !candidate.connected)) {
    const role = room.assignment[player.id];
    if (['move', 'moveCamera'].includes(role)) merged.right = true;
    if (role === 'pace') merged.accelerate = true;
    const nextObstacle = game.obstacles.find((obstacle) => !obstacle.hit && obstacle.x > game.x && obstacle.x - game.x < 2.2);
    if (role === 'jump' && nextObstacle?.type === 'jump') merged.jump = true;
    if (['action', 'actionThrow'].includes(role) && nextObstacle?.type === 'slide') merged.slide = true;
    if (['throw', 'actionThrow'].includes(role) && Math.abs(game.truckX - game.x) < 7 && game.x > 20) merged.throw = true;
  }
}

function applyObstacleCollisions(game) {
  for (const obstacle of game.obstacles || []) {
    if (obstacle.hit || obstacle.x <= (game.lastX ?? game.x) || obstacle.x > game.x) continue;
    const avoided = obstacle.type === 'jump' ? game.y >= 0.85 : game.sliding;
    obstacle.hit = true;
    obstacle.avoided = avoided;
    if (!avoided) {
      game.collisions += 1;
      game.bagIntegrity = Math.max(0, game.bagIntegrity - 18);
      game.speed *= 0.25;
    }
  }
}

function finish(room, reason) {
  const game = room.game;
  if (!game || game.reason) return;
  game.reason = reason;
  game.delivered = reason === 'delivered';
  game.score = game.delivered
    ? Math.max(0, Math.round((game.endsAt - Date.now()) / 20 + game.bagIntegrity * 20 - game.collisions * 100))
    : 0;
  room.phase = 'FINISHED';
  room.announcement = game.delivered ? 'Giao rác thành công!' : reason === 'bag_destroyed' ? 'Túi rác vỡ mất rồi!' : 'Xe rác chạy mất!';
}

export function simulateGameStep(room, deltaSeconds, now = Date.now()) {
  const game = room.game;
  if (!game || game.reason) return;
  const merged = mergeHumanInputs(room);
  applyAutopilot(room, merged);
  game.lastX = game.x;
  game.sliding = Boolean(merged.slide) && game.y === 0;
  const direction = Number(Boolean(merged.right)) - Number(Boolean(merged.left));
  const targetSpeed = merged.brake ? 1.2 : merged.accelerate ? 8.2 : 4.8;
  game.speed += (targetSpeed - game.speed) * Math.min(1, deltaSeconds * 5);
  game.x = Math.max(0, Math.min(106, game.x + direction * game.speed * deltaSeconds));
  if (merged.jump && game.y === 0 && !game.sliding) game.vy = 8.5;
  game.vy -= 21 * deltaSeconds;
  game.y = Math.max(0, game.y + game.vy * deltaSeconds);
  if (game.y === 0 && game.vy < 0) game.vy = 0;
  game.cameraOffset += ((merged.cameraRight ? 1 : 0) - (merged.cameraLeft ? 1 : 0)) * deltaSeconds * 8;
  game.cameraOffset *= Math.max(0, 1 - deltaSeconds * 1.5);
  game.truckX += 2.3 * deltaSeconds;
  applyObstacleCollisions(game);

  if (merged.throw && Math.abs(game.truckX - game.x) <= 7.5 && game.x > 20) finish(room, 'delivered');
  else if (game.bagIntegrity <= 0) finish(room, 'bag_destroyed');
  else if (now >= game.endsAt) finish(room, 'timeout');
  else if (game.truckX >= 106) finish(room, 'truck_left');
}

function serveStatic(req, res) {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }
  const rawPath = req.url === '/' ? 'index.html' : decodeURIComponent(String(req.url || '').split('?')[0]).replace(/^\/+/, '');
  const file = path.resolve(ROOT, rawPath);
  if (!file.startsWith(`${ROOT}${path.sep}`) && file !== path.join(ROOT, 'index.html')) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const contentType = file.endsWith('.html')
    ? 'text/html; charset=utf-8'
    : file.endsWith('.js')
      ? 'text/javascript; charset=utf-8'
      : file.endsWith('.css')
        ? 'text/css; charset=utf-8'
        : 'application/octet-stream';
  res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}

export const server = http.createServer(serveStatic);

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (req.url !== '/ws' || !key) {
    socket.destroy();
    return;
  }
  const accept = crypto
    .createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  const client = { socket, room: null, id: null, buffer: Buffer.alloc(0) };
  clients.add(client);

  socket.on('data', (chunk) => {
    client.buffer = Buffer.concat([client.buffer, chunk]);
    try {
      while (true) {
        const frame = readFrame(client.buffer);
        if (!frame) break;
        client.buffer = client.buffer.subarray(frame.consumed);
        if (frame.opcode === 0x8) {
          socket.end(encodeFrame(frame.payload, 0x8));
          break;
        }
        if (frame.opcode === 0x9) {
          socket.write(encodeFrame(frame.payload, 0xA));
          continue;
        }
        if (frame.opcode !== 0x1) continue;
        try {
          handleMessage(client, JSON.parse(frame.payload.toString('utf8')));
        } catch (error) {
          send(client, { type: 'error', message: error.message });
        }
      }
    } catch (error) {
      send(client, { type: 'error', message: error.message });
      socket.destroy();
    }
  });

  socket.on('close', () => {
    clients.delete(client);
    const room = rooms.get(client.room);
    const player = room?.players.find((candidate) => candidate.id === client.id);
    if (!room || !player) return;
    player.connected = false;
    player.disconnectedAt = Date.now();
    releaseInputs(room, player.id);
    room.updatedAt = Date.now();
    if (room.hostId === player.id) setNewHost(room);
  });
});

let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const deltaSeconds = Math.min(0.1, (now - lastTick) / 1000);
  lastTick = now;
  for (const room of rooms.values()) {
    if (room.phase === 'COUNTDOWN' && now >= room.countdownEndsAt) {
      room.phase = 'PLAYING';
      room.game = createInitialGame(now);
      room.announcement = 'Chạy!';
    }
    if (room.phase === 'PLAYING' && room.game) {
      if (now >= room.game.nextShuffleAt) {
        assign(room);
        room.game.nextShuffleAt = now + SHUFFLE_MS;
        room.announcement = 'ĐỔI QUYỀN!';
      }
      simulateGameStep(room, deltaSeconds, now);
    }
    if (now - room.updatedAt > ROOM_IDLE_MS && !room.players.some((player) => player.connected && !player.bot)) {
      rooms.delete(room.code);
    }
  }
}, 1000 / 30).unref();

setInterval(() => {
  for (const client of clients) {
    const room = rooms.get(client.room);
    if (room) send(client, { type: 'state', state: publicRoom(room, client.id) });
  }
}, 100).unref();

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(PORT, '0.0.0.0', () => console.log(`Game: http://localhost:${PORT}`));
}
