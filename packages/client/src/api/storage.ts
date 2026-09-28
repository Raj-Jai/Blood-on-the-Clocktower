const ONBOARDING_SEEN_KEY = 'botc:onboarding:seen';
const GAMES_INDEX_KEY = 'botc:games:index';

// Referenced via `window.localStorage` rather than the bare global: in the
// browser these are the same object, but in the Vitest/jsdom test environment
// under Node's newer built-in `localStorage` global this avoids ambiguity
// between Node's native implementation and jsdom's per-window implementation.
function storage(): Storage {
  return window.localStorage;
}

export interface StoredGameSession {
  code: string;
  role: 'storyteller' | 'player';
  token: string;
  /** Only set for a player session. */
  playerId?: string;
}

function gameKey(code: string): string {
  return `botc:games:${code.toUpperCase()}`;
}

function readIndex(): string[] {
  const raw = storage().getItem(GAMES_INDEX_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeIndex(codes: string[]): void {
  storage().setItem(GAMES_INDEX_KEY, JSON.stringify(codes));
}

function addToIndex(code: string): void {
  const upper = code.toUpperCase();
  const codes = readIndex();
  if (!codes.includes(upper)) {
    writeIndex([...codes, upper]);
  }
}

function removeFromIndex(code: string): void {
  const upper = code.toUpperCase();
  writeIndex(readIndex().filter((c) => c !== upper));
}

/**
 * Saves a session, namespaced per game code. Unlike the old single flat
 * slot, saving a session for one game code never touches any other game's
 * stored session -- joining a second game (or switching roles) does not
 * wipe an unrelated Storyteller or player session on the same device.
 */
export function saveStorytellerSession(code: string, token: string): void {
  const session: StoredGameSession = { code: code.toUpperCase(), role: 'storyteller', token };
  storage().setItem(gameKey(code), JSON.stringify(session));
  addToIndex(code);
}

export function savePlayerSession(code: string, playerId: string, token: string): void {
  const session: StoredGameSession = { code: code.toUpperCase(), role: 'player', token, playerId };
  storage().setItem(gameKey(code), JSON.stringify(session));
  addToIndex(code);
}

/** Returns the stored session for a specific game code, or null if none is stored. */
export function getStoredSession(code: string): StoredGameSession | null {
  const raw = storage().getItem(gameKey(code));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredGameSession;
    if (!parsed || typeof parsed.token !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Clears the stored session for one specific game code. Other games' stored sessions are untouched. */
export function clearStoredSession(code: string): void {
  storage().removeItem(gameKey(code));
  removeFromIndex(code);
}

/** Lists every game code this device has a stored session for (Storyteller or Player). */
export function listStoredGameCodes(): string[] {
  return readIndex();
}

export function hasSeenOnboarding(): boolean {
  return storage().getItem(ONBOARDING_SEEN_KEY) === 'true';
}

export function markOnboardingSeen(): void {
  storage().setItem(ONBOARDING_SEEN_KEY, 'true');
}
