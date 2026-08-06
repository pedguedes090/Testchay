import test from 'node:test';
import assert from 'node:assert/strict';

const moduleUrl = new URL('../public/client-core.js', import.meta.url);
async function loadCore() {
  try {
    return await import(`${moduleUrl.href}?test=${Date.now()}-${Math.random()}`);
  } catch {
    return {};
  }
}

test('safe storage falls back to memory when browser storage throws', async () => {
  const core = await loadCore();
  assert.equal(typeof core.createSafeStorage, 'function');
  const brokenStorage = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
    removeItem() { throw new Error('blocked'); },
  };
  const storage = core.createSafeStorage(brokenStorage);
  storage.set('session', { roomCode: 'ABCDE' });
  assert.deepEqual(storage.get('session'), { roomCode: 'ABCDE' });
  storage.remove('session');
  assert.equal(storage.get('session'), null);
});

test('input controller sends one press and releases every held action', async () => {
  const core = await loadCore();
  assert.equal(typeof core.createInputController, 'function');
  const sent = [];
  const controller = core.createInputController((message) => sent.push(message));

  controller.press('accelerate');
  controller.press('accelerate');
  controller.press('jump');
  controller.releaseAll();

  assert.deepEqual(sent.map(({ action, pressed }) => ({ action, pressed })), [
    { action: 'accelerate', pressed: true },
    { action: 'jump', pressed: true },
    { action: 'accelerate', pressed: false },
    { action: 'jump', pressed: false },
  ]);
  assert.ok(sent.every((message, index) => message.sequence === index));
});

test('screen keys stay stable during state polling and change with role or phase', async () => {
  const core = await loadCore();
  assert.equal(typeof core.screenKey, 'function');
  const playing = { phase: 'PLAYING', viewerId: 'p1', players: [{ id: 'p1', role: 'jump' }] };
  assert.equal(core.screenKey(playing), 'game:jump');
  assert.equal(core.screenKey({ ...playing, game: { x: 99 } }), 'game:jump');
  assert.equal(core.screenKey({ ...playing, players: [{ id: 'p1', role: 'pace' }] }), 'game:pace');
  assert.equal(core.screenKey({ ...playing, phase: 'FINISHED' }), 'result');
});

test('resume payload contains credentials only in the websocket body', async () => {
  const core = await loadCore();
  assert.equal(typeof core.resumeMessage, 'function');
  const session = { roomCode: 'ABCDE', sessionId: 'p1', reconnectToken: 'secret' };
  assert.deepEqual(core.resumeMessage(session), { type: 'resume', ...session });
});

test('browser storage access is safe when the localStorage property getter throws', async () => {
  const core = await loadCore();
  assert.equal(typeof core.readBrowserStorage, 'function');
  const lockedWindow = {};
  Object.defineProperty(lockedWindow, 'localStorage', {
    get() { throw new DOMException('blocked', 'SecurityError'); },
  });
  assert.equal(core.readBrowserStorage(lockedWindow), null);
});

test('pointer capture failures do not prevent an input press', async () => {
  const core = await loadCore();
  assert.equal(typeof core.tryCapturePointer, 'function');
  const element = {
    setPointerCapture() { throw new DOMException('not active', 'NotFoundError'); },
  };
  assert.equal(core.tryCapturePointer(element, 7), false);
});

test('clears visual active controls after a disconnect', async () => {
  const core = await loadCore();
  assert.equal(typeof core.clearActiveControls, 'function');
  const removed = [];
  const root = {
    querySelectorAll(selector) {
      assert.equal(selector, '.control.active');
      return [
        { classList: { remove(name) { removed.push(`first:${name}`); } } },
        { classList: { remove(name) { removed.push(`second:${name}`); } } },
      ];
    },
  };
  core.clearActiveControls(root);
  assert.deepEqual(removed, ['first:active', 'second:active']);
});
