import type { Server as SocketIOServer } from 'socket.io';
import type { SessionStore } from '../session/store.js';
import { MAX_NIGHT_DELAY_SECONDS, MIN_NIGHT_DELAY_SECONDS } from '../session/store.js';
import { broadcastFlow } from '../game/flow.js';
import { sendActiveNightPrompt, sendNightLog, sendNightOrder, tickNightGate } from '../game/nightEngine.js';

/**
 * Polls for expiring pauses between wakers and releases the next one.
 *
 * The pause is server-owned rather than client-owned because every device has to
 * agree on it: the player who is about to be woken must not receive their prompt
 * early, and the host device must not read the next name out before the pause has
 * run. A client-side timer would drift and would leak the name over the wire
 * early, which is the thing the pause exists to prevent.
 *
 * Returns the stop function so a caller (or a test) can shut it down.
 */
export function registerNightGateTicker(io: SocketIOServer, store: SessionStore): () => void {
  const timer = setInterval(() => {
    for (const session of store.allSessions()) {
      if (session.phase !== 'night') continue;
      if (!session.currentNight?.wakeGate) continue;
      if (!tickNightGate(session)) continue;
      sendActiveNightPrompt(io, session);
      sendNightOrder(io, session);
      sendNightLog(io, session);
      broadcastFlow(io, session);
    }
  }, 500);
  // Do not hold the process open for this on shutdown.
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}

export const NIGHT_DELAY_RANGE = {
  min: MIN_NIGHT_DELAY_SECONDS,
  max: MAX_NIGHT_DELAY_SECONDS,
} as const;
