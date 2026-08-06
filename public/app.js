import {
  clearActiveControls,
  createInputController,
  createSafeStorage,
  readBrowserStorage,
  currentRole,
  formatSeconds,
  resumeMessage,
  roleActions,
  screenKey,
  tryCapturePointer,
} from './client-core.js';

const app = document.querySelector('#app');
const canvas = document.querySelector('#game-canvas');
const context = canvas.getContext('2d');
const toastElement = document.querySelector('#toast');
const connectionElement = document.querySelector('#connection');
const storage = createSafeStorage(readBrowserStorage(globalThis));
const SESSION_KEY = 'control-chaos-session-v1';
const labels = {
  left: '← Trái', right: 'Phải →', accelerate: '⚡ Chạy', brake: '■ Phanh',
  jump: '↑ Nhảy', slide: '↘ Trượt', cameraLeft: '◀ Cam', cameraRight: 'Cam ▶', throw: '◎ Ném',
};
const keys = {
  left: 'A / ←', right: 'D / →', accelerate: 'W / ↑', brake: 'S / ↓',
  jump: 'Space', slide: 'Shift', cameraLeft: 'Q', cameraRight: 'E', throw: 'E',
};
const roleLabels = {
  move: 'Di chuyển', pace: 'Tăng tốc / phanh', jump: 'Nhảy', action: 'Trượt', camera: 'Camera',
  throw: 'Ném túi', actionThrow: 'Trượt + ném', moveCamera: 'Di chuyển + camera',
};

let socket;
let state = null;
let session = storage.get(SESSION_KEY);
let renderedKey = '';
let reconnectTimer;
let toastTimer;
let lastAnnouncement = '';
let connectionAttempt = 0;
const input = createInputController(send);

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function showToast(message, error = false) {
  clearTimeout(toastTimer);
  toastElement.textContent = message;
  toastElement.classList.toggle('error', error);
  toastElement.hidden = false;
  toastTimer = setTimeout(() => { toastElement.hidden = true; }, 2200);
}

function setConnecting(show, text = 'Đang kết nối máy chủ…') {
  connectionElement.classList.toggle('show', show);
  connectionElement.querySelector('b').textContent = text;
}

function connect() {
  clearTimeout(reconnectTimer);
  connectionAttempt += 1;
  setConnecting(true, connectionAttempt === 1 ? 'Đang kết nối máy chủ…' : 'Đang nối lại phòng…');
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  socket.addEventListener('open', () => {
    connectionAttempt = 0;
    setConnecting(false);
    const resume = resumeMessage(session);
    if (resume) send(resume);
  });
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.type === 'error') {
      if (message.message === 'Phiên kết nối không hợp lệ') {
        session = null;
        state = null;
        storage.remove(SESSION_KEY);
        renderedKey = '';
        render();
      }
      showToast(message.message, true);
      return;
    }
    if (message.type === 'welcome') {
      session = {
        roomCode: message.roomCode,
        sessionId: message.sessionId,
        reconnectToken: message.reconnectToken,
      };
      storage.set(SESSION_KEY, session);
      if (message.resumed) showToast('Đã nối lại phòng');
      return;
    }
    if (message.type === 'state') {
      state = message.state;
      if (state.announcement && state.announcement !== lastAnnouncement) {
        lastAnnouncement = state.announcement;
        showToast(lastAnnouncement);
      }
      render();
    }
  });
  socket.addEventListener('close', () => {
    input.releaseAll();
    clearActiveControls(document);
    setConnecting(true, session ? 'Mất kết nối — đang thử lại…' : 'Đang kết nối lại…');
    reconnectTimer = setTimeout(connect, Math.min(5000, 700 + connectionAttempt * 500));
  });
  socket.addEventListener('error', () => socket.close());
}

function render() {
  const nextKey = screenKey(state);
  if (nextKey !== renderedKey) {
    input.releaseAll();
    renderedKey = nextKey;
    if (nextKey === 'home') buildHome();
    else if (nextKey === 'lobby') buildLobby();
    else if (nextKey.startsWith('game:')) buildGame();
    else buildResult();
  }
  updateDynamicContent();
}

function shell(inner) {
  return `<div class="wrap"><header class="top"><div class="brand"><span class="mark">?</span>AI ĐANG ĐIỀU KHIỂN TÔI?</div><div class="status"><span class="dot online"></span><span>ONLINE · 4–6 NGƯỜI</span></div></header>${inner}</div>`;
}

function buildHome() {
  document.body.classList.remove('playing', 'result-page');
  app.innerHTML = shell(`<section class="hero"><div><div class="eyebrow">WEB PARTY GAME</div><h1>Không ai tự điều khiển <span>chính mình.</span></h1><p class="muted">Cả nhóm cùng điều khiển một nhân vật. Người chạy, người nhảy, người phanh — và cứ 20 giây mọi quyền lại bị tráo.</p></div><div class="card"><div class="tabs"><button class="btn active" id="create-tab">Tạo phòng</button><button class="btn alt" id="join-tab">Vào phòng</button></div><form id="room-form" class="grid"></form><div class="tip" style="margin-top:12px">Mẹo: tạo phòng rồi thêm 3 bot để thử một mình.</div></div></section>`);
  let joining = false;
  const form = document.querySelector('#room-form');
  const createTab = document.querySelector('#create-tab');
  const joinTab = document.querySelector('#join-tab');
  const setMode = (joinMode) => {
    joining = joinMode;
    createTab.className = `btn ${joining ? 'alt' : 'active'}`;
    joinTab.className = `btn ${joining ? 'active' : 'alt'}`;
    form.innerHTML = `${joining ? '<input name="code" maxlength="5" autocomplete="off" placeholder="Mã phòng 5 ký tự" required>' : ''}<input name="name" minlength="2" maxlength="16" autocomplete="nickname" placeholder="Tên của bạn" required><button class="btn">${joining ? 'Vào phòng' : 'Tạo phòng'}</button>`;
  };
  createTab.onclick = () => setMode(false);
  joinTab.onclick = () => setMode(true);
  form.onsubmit = (event) => {
    event.preventDefault();
    const data = new FormData(form);
    send(joining
      ? { type: 'join', code: String(data.get('code')).toUpperCase(), name: data.get('name') }
      : { type: 'create', name: data.get('name') });
  };
  setMode(false);
}

function buildLobby() {
  document.body.classList.remove('playing', 'result-page');
  const isHost = state.hostId === state.viewerId;
  app.innerHTML = shell(`<section class="lobby"><div class="card"><div class="room-head"><div><small>MÃ PHÒNG</small><div class="code" id="room-code"></div></div><button class="btn alt" id="copy-code">Sao chép mã</button></div><div class="players" id="players"></div></div><aside class="card"><h2>Chạy Trốn Xe Rác</h2><p class="muted">Đuổi theo xe rác, né chướng ngại và ném túi vào thùng trước khi xe rời thành phố.</p><div class="tip">Mỗi người chỉ giữ một phần điều khiển. Bot tự dùng quyền còn thiếu.</div><div class="actions" id="lobby-actions" style="margin-top:16px">${isHost ? '<button class="btn alt" id="add-bot">+ Bot thử</button><button class="btn" id="start-game">Bắt đầu</button>' : '<p class="muted">Chờ chủ phòng bắt đầu…</p>'}</div></aside></section>`);
  document.querySelector('#copy-code').onclick = async () => {
    try { await navigator.clipboard.writeText(state.code); showToast('Đã sao chép mã phòng'); }
    catch { showToast(`Mã phòng: ${state.code}`); }
  };
  if (isHost) {
    document.querySelector('#add-bot').onclick = () => send({ type: 'add_bot' });
    document.querySelector('#start-game').onclick = () => send({ type: 'start' });
  }
}

function buildGame() {
  document.body.classList.remove('result-page');
  document.body.classList.add('playing');
  const role = currentRole(state);
  const actions = roleActions[role] || [];
  app.innerHTML = `<div class="hud"><div class="hudtop"><div class="pill"><strong id="timer">--</strong><br><small id="collision-count">Va chạm 0</small><div class="meters"><div><small>Túi rác</small><div class="meter"><span id="bag-meter"></span></div></div></div></div><div class="pill"><small>QUYỀN CỦA BẠN</small><br><strong>${roleLabels[role] || 'Đang chia…'}</strong><br><small id="shuffle-time"></small></div></div></div><div class="controls">${actions.map((action) => `<button class="control" data-action="${action}">${labels[action]}<span class="key">${keys[action]}</span></button>`).join('')}</div><div class="legend">Thùng/cọc: nhảy · Biển/thanh chắn: trượt</div>`;
  for (const button of document.querySelectorAll('[data-action]')) {
    const action = button.dataset.action;
    const release = () => { input.release(action); button.classList.remove('active'); };
    button.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      tryCapturePointer(button, event.pointerId);
      input.press(action);
      button.classList.add('active');
    });
    button.addEventListener('pointerup', release);
    button.addEventListener('pointercancel', release);
    button.addEventListener('lostpointercapture', release);
  }
}

function buildResult() {
  document.body.classList.remove('playing');
  document.body.classList.add('result-page');
  const game = state.game;
  const won = game?.reason === 'delivered';
  const isHost = state.hostId === state.viewerId;
  const reason = game?.reason === 'bag_destroyed' ? 'Túi rác vỡ mất!' : won ? 'Giao được rồi!' : 'Xe chạy mất!';
  app.innerHTML = `<section class="card result"><div style="font-size:5rem">${won ? '🎉' : game?.reason === 'bag_destroyed' ? '💥🗑️' : '🗑️💨'}</div><h1>${reason}</h1><div class="score">${game?.score || 0} điểm</div><p class="muted">Túi còn ${game?.bagIntegrity ?? 0}% · ${game?.collisions || 0} lần va chạm</p>${isHost ? '<button class="btn" id="rematch">Chơi lại</button>' : '<p class="muted">Chờ chủ phòng chọn chơi lại…</p>'}</section>`;
  if (isHost) document.querySelector('#rematch').onclick = () => send({ type: 'rematch' });
}

function updateDynamicContent() {
  if (!state) return;
  if (state.phase === 'LOBBY') {
    const code = document.querySelector('#room-code');
    const players = document.querySelector('#players');
    if (code) code.textContent = state.code;
    if (players) players.innerHTML = state.players.map((player) => `<div class="player ${player.connected ? '' : 'offline'}"><b>${escapeHtml(player.name)}${player.id === state.hostId ? ' 👑' : ''}</b><br><small>${player.bot ? 'Bot thử nghiệm' : player.connected ? 'Đã kết nối' : 'Đang nối lại…'}</small></div>`).join('');
    const start = document.querySelector('#start-game');
    const bot = document.querySelector('#add-bot');
    if (start) start.disabled = state.players.length < 4;
    if (bot) bot.disabled = state.players.length >= 6;
  }
  if (state.phase === 'COUNTDOWN' || state.phase === 'PLAYING') {
    const game = state.game;
    const timer = document.querySelector('#timer');
    const collisions = document.querySelector('#collision-count');
    const bag = document.querySelector('#bag-meter');
    const shuffle = document.querySelector('#shuffle-time');
    if (timer) timer.textContent = state.phase === 'COUNTDOWN' ? formatSeconds(state.countdownMs) : `${formatSeconds(game?.remainingMs)}s`;
    if (collisions) collisions.textContent = `Va chạm ${game?.collisions || 0}`;
    if (bag) bag.style.width = `${game?.bagIntegrity ?? 100}%`;
    if (shuffle) shuffle.textContent = state.phase === 'PLAYING' ? `Đổi quyền sau ${formatSeconds(game?.nextShuffleMs)}s` : 'Chuẩn bị chạy';
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

const keyboardActions = {
  ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
  ArrowUp: 'accelerate', KeyW: 'accelerate', ArrowDown: 'brake', KeyS: 'brake',
  Space: 'jump', ShiftLeft: 'slide', ShiftRight: 'slide', KeyQ: 'cameraLeft',
};
function actionForKey(code) {
  const allowed = new Set(roleActions[currentRole(state)] || []);
  if (code === 'KeyE') return allowed.has('throw') ? 'throw' : allowed.has('cameraRight') ? 'cameraRight' : null;
  const action = keyboardActions[code];
  return allowed.has(action) ? action : null;
}
addEventListener('keydown', (event) => {
  const action = actionForKey(event.code);
  if (!action || event.repeat || ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
  event.preventDefault();
  input.press(action);
  document.querySelector(`[data-action="${action}"]`)?.classList.add('active');
});
addEventListener('keyup', (event) => {
  const action = actionForKey(event.code);
  if (!action) return;
  event.preventDefault();
  input.release(action);
  document.querySelector(`[data-action="${action}"]`)?.classList.remove('active');
});
function releaseEverything() {
  input.releaseAll();
  send({ type: 'release_all' });
  clearActiveControls(document);
}
addEventListener('blur', releaseEverything);
document.addEventListener('visibilitychange', () => { if (document.hidden) releaseEverything(); });
addEventListener('pagehide', releaseEverything);

function resizeCanvas() {
  const ratio = Math.min(2, devicePixelRatio || 1);
  canvas.width = Math.round(innerWidth * ratio);
  canvas.height = Math.round(innerHeight * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
}
addEventListener('resize', resizeCanvas);
resizeCanvas();

function drawRoundedRect(x, y, width, height, radius) {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
  context.fill();
}

function draw() {
  requestAnimationFrame(draw);
  if (!document.body.classList.contains('playing')) return;
  const width = innerWidth;
  const height = innerHeight;
  const game = state?.game || { x: 4, y: 0, truckX: 40, obstacles: [], cameraOffset: 0 };
  const road = height * 0.73;
  const scale = Math.max(9, Math.min(17, width / 65));
  const center = game.x * 0.76 + game.truckX * 0.24 + (game.cameraOffset || 0);
  const worldX = (x) => width * 0.42 + (x - center) * scale;
  const gradient = context.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, '#6559da');
  gradient.addColorStop(1, '#efc985');
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);

  for (let index = 0; index < 9; index += 1) {
    const buildingX = ((index * 170 - center * 2.3) % (width + 260)) - 100;
    const buildingHeight = 100 + (index % 4) * 38;
    context.fillStyle = index % 2 ? '#443f75' : '#36355f';
    context.fillRect(buildingX, road - buildingHeight, 120, buildingHeight);
    context.fillStyle = '#ffd86a88';
    for (let row = 0; row < 3; row += 1) for (let column = 0; column < 3; column += 1) context.fillRect(buildingX + 18 + column * 31, road - buildingHeight + 20 + row * 30, 13, 16);
  }

  context.fillStyle = '#555369';
  context.fillRect(0, road, width, height - road);
  context.strokeStyle = '#fff9';
  context.lineWidth = 4;
  context.setLineDash([35, 25]);
  context.beginPath();
  context.moveTo(0, road + 48);
  context.lineTo(width, road + 48);
  context.stroke();
  context.setLineDash([]);

  for (const obstacle of game.obstacles || []) {
    const x = worldX(obstacle.x);
    if (x < -80 || x > width + 80) continue;
    context.globalAlpha = obstacle.hit ? 0.35 : 1;
    if (obstacle.type === 'jump') {
      context.fillStyle = '#ff9c48';
      drawRoundedRect(x - 22, road - 42, 44, 42, 8);
      context.fillStyle = '#ffe070';
      context.fillRect(x - 15, road - 31, 30, 7);
    } else {
      context.fillStyle = '#ff5f87';
      context.fillRect(x - 34, road - 76, 68, 12);
      context.fillRect(x - 30, road - 76, 8, 76);
      context.fillRect(x + 22, road - 76, 8, 76);
    }
    context.globalAlpha = 1;
  }

  const truckX = worldX(game.truckX);
  context.fillStyle = '#c8ff4d';
  drawRoundedRect(truckX - 68, road - 84, 125, 76, 13);
  context.fillStyle = '#1e1b37';
  context.fillRect(truckX - 51, road - 68, 66, 43);
  context.fillStyle = '#fff9';
  context.fillRect(truckX + 26, road - 69, 18, 22);
  context.fillStyle = '#211d42';
  context.beginPath();
  context.arc(truckX - 40, road - 5, 15, 0, Math.PI * 2);
  context.arc(truckX + 42, road - 5, 15, 0, Math.PI * 2);
  context.fill();

  const characterX = worldX(game.x);
  const characterY = road - 55 - game.y * 25;
  context.save();
  context.translate(characterX, characterY);
  if (game.sliding) context.scale(1.2, 0.65);
  context.fillStyle = '#ff7dbb';
  context.beginPath();
  context.arc(0, 0, 34, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = '#211d42';
  context.beginPath();
  context.arc(-10, -7, 4, 0, Math.PI * 2);
  context.arc(10, -7, 4, 0, Math.PI * 2);
  context.fill();
  context.strokeStyle = '#211d42';
  context.lineWidth = 3;
  context.beginPath();
  context.arc(0, 2, 10, 0.15, Math.PI - 0.15);
  context.stroke();
  context.fillStyle = '#ffd34d';
  context.fillRect(-25, 25, 17, 39);
  context.fillRect(8, 25, 17, 39);
  context.fillStyle = '#6c4c28';
  drawRoundedRect(21, -3, 27, 35, 8);
  context.restore();
}
requestAnimationFrame(draw);
render();
connect();
