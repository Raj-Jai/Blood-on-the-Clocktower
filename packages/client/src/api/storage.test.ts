import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearStoredSession,
  getStoredSession,
  hasSeenOnboarding,
  listStoredGameCodes,
  markOnboardingSeen,
  savePlayerSession,
  saveStorytellerSession,
} from './storage.js';

describe('session storage', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('stores and retrieves a storyteller session', () => {
    saveStorytellerSession('ABCDE', 'tok123');
    const stored = getStoredSession('ABCDE');
    expect(stored?.role).toBe('storyteller');
    expect(stored?.token).toBe('tok123');
  });

  it('stores and retrieves a player session', () => {
    savePlayerSession('FGHJK', 'p1', 'ptok');
    const stored = getStoredSession('FGHJK');
    expect(stored?.role).toBe('player');
    expect(stored?.token).toBe('ptok');
    expect(stored?.playerId).toBe('p1');
  });

  it('does not clobber an unrelated game session on the same device', () => {
    saveStorytellerSession('ABCDE', 'st-tok');
    savePlayerSession('FGHJK', 'p1', 'player-tok');

    // Saving/reading the player session for FGHJK must not disturb ABCDE's
    // stored Storyteller session -- this is the actual bug: previously a
    // single flat slot meant joining any second game wiped the first.
    expect(getStoredSession('ABCDE')?.role).toBe('storyteller');
    expect(getStoredSession('ABCDE')?.token).toBe('st-tok');
    expect(getStoredSession('FGHJK')?.role).toBe('player');
  });

  it('returns null for a game code with no stored session', () => {
    expect(getStoredSession('ZZZZZ')).toBeNull();
  });

  it('clears only the specified game session, leaving others intact', () => {
    saveStorytellerSession('ABCDE', 'st-tok');
    savePlayerSession('FGHJK', 'p1', 'player-tok');

    clearStoredSession('ABCDE');

    expect(getStoredSession('ABCDE')).toBeNull();
    expect(getStoredSession('FGHJK')?.token).toBe('player-tok');
  });

  it('tracks every game code this device has joined or hosted', () => {
    saveStorytellerSession('ABCDE', 'st-tok');
    savePlayerSession('FGHJK', 'p1', 'player-tok');

    expect(listStoredGameCodes().sort()).toEqual(['ABCDE', 'FGHJK']);

    clearStoredSession('ABCDE');
    expect(listStoredGameCodes()).toEqual(['FGHJK']);
  });

  it('is case-insensitive on the game code', () => {
    saveStorytellerSession('abcde', 'st-tok');
    expect(getStoredSession('ABCDE')?.token).toBe('st-tok');
    expect(getStoredSession('abcde')?.token).toBe('st-tok');
  });

  it('tracks onboarding-seen flag independent of session data', () => {
    expect(hasSeenOnboarding()).toBe(false);
    markOnboardingSeen();
    expect(hasSeenOnboarding()).toBe(true);
  });
});
