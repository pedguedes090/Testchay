export const roleActions = {
  move: ['left', 'right'],
  pace: ['accelerate', 'brake'],
  jump: ['jump'],
  action: ['slide'],
  camera: ['cameraLeft', 'cameraRight'],
  throw: ['throw'],
  actionThrow: ['slide', 'throw'],
  moveCamera: ['left', 'right', 'cameraLeft', 'cameraRight'],
};

export function readBrowserStorage(globalObject) {
  try { return globalObject?.localStorage ?? null; } catch { return null; }
}

export function createSafeStorage(browserStorage) {
  const memory = new Map();
  const read = (key) => {
    try {
      const raw = browserStorage?.getItem(key);
      if (raw != null) return raw;
    } catch {}
    return memory.get(key) ?? null;
  };
  return {
    get(key) {
      const raw = read(key);
      if (raw == null) return null;
      try { return JSON.parse(raw); } catch { return null; }
    },
    set(key, value) {
      const raw = JSON.stringify(value);
      memory.set(key, raw);
      try { browserStorage?.setItem(key, raw); } catch {}
    },
    remove(key) {
      memory.delete(key);
      try { browserStorage?.removeItem(key); } catch {}
    },
  };
}

export function createInputController(send) {
  const held = new Set();
  let sequence = 0;
  const emit = (action, pressed) => send({ type: 'input', action, pressed, sequence: sequence++ });
  return {
    press(action) {
      if (!action || held.has(action)) return;
      held.add(action);
      emit(action, true);
    },
    release(action) {
      if (!held.delete(action)) return;
      emit(action, false);
    },
    releaseAll() {
      for (const action of [...held]) {
        held.delete(action);
        emit(action, false);
      }
    },
    isHeld(action) { return held.has(action); },
  };
}

export function currentRole(state) {
  return state?.players?.find((player) => player.id === state.viewerId)?.role ?? null;
}

export function screenKey(state) {
  if (!state) return 'home';
  if (state.phase === 'LOBBY') return 'lobby';
  if (state.phase === 'COUNTDOWN' || state.phase === 'PLAYING') return `game:${currentRole(state) ?? 'pending'}`;
  return 'result';
}

export function resumeMessage(session) {
  return session ? { type: 'resume', ...session } : null;
}

export function formatSeconds(milliseconds) {
  return Math.max(0, Math.ceil(Number(milliseconds || 0) / 1000));
}

export function tryCapturePointer(element, pointerId) {
  try {
    element?.setPointerCapture?.(pointerId);
    return true;
  } catch {
    return false;
  }
}

export function clearActiveControls(root) {
  root?.querySelectorAll?.('.control.active').forEach((element) => element.classList.remove('active'));
}
