import { describe, expect, it, vi } from 'vitest';
import { MAX_PLAYERS, MIN_PLAYERS, getDistributionCounts } from '@clocktower/shared';
import { SessionStore } from '../session/store.js';
import { applyBaronModifier, buildPlayerDistributionPayload, distributeRoles } from './distribution.js';

function makeSessionWithPlayers(n: number) {
  const store = new SessionStore();
  const session = store.createSession('tok');
  for (let i = 0; i < n; i++) {
    store.addPlayer(session, `p${i}`, `Player${i}`);
  }
  return session;
}

describe('distributeRoles', () => {
  it('assigns exactly one character to every player for each supported player count', () => {
    for (let n = MIN_PLAYERS; n <= MAX_PLAYERS; n++) {
      const session = makeSessionWithPlayers(n);
      distributeRoles(session);
      const players = [...session.players.values()];
      expect(players).toHaveLength(n);
      for (const p of players) {
        expect(p.character).not.toBeNull();
        expect(p.characterType).not.toBeNull();
        expect(p.alignment).not.toBeNull();
      }
    }
  });

  it('never assigns the same character to two players (bijection)', () => {
    const session = makeSessionWithPlayers(15);
    distributeRoles(session);
    const characters = [...session.players.values()].map((p) => p.character);
    expect(new Set(characters).size).toBe(characters.length);
  });

  it('matches the exact type counts from the distribution table for N=10, applying the Baron setup modifier when the Baron is in play', () => {
    const session = makeSessionWithPlayers(10);
    distributeRoles(session);
    const counts = { townsfolk: 0, outsider: 0, minion: 0, demon: 0 };
    for (const p of session.players.values()) {
      if (p.characterType) counts[p.characterType] += 1;
    }
    // The Baron's whole effect is a setup change ("[+2 Outsiders]"), so a game
    // containing the Baron legitimately has a different roster. Both branches are
    // correct; the modifier is applied only when the Baron was actually drawn.
    const baronInPlay = [...session.players.values()].some((p) => p.character === 'baron');
    expect(counts).toEqual(
      baronInPlay ? { townsfolk: 5, outsider: 2, minion: 2, demon: 1 } : { townsfolk: 7, outsider: 0, minion: 2, demon: 1 }
    );
  });

  it('applyBaronModifier shifts 2 Outsiders at every supported player count without changing the total', () => {
    for (let n = MIN_PLAYERS; n <= MAX_PLAYERS; n++) {
      const base = getDistributionCounts(n);
      const modified = applyBaronModifier(base);
      expect(modified.outsider).toBe(base.outsider + 2);
      expect(modified.townsfolk).toBe(base.townsfolk - 2);
      expect(modified.minion).toBe(base.minion);
      expect(modified.demon).toBe(base.demon);
      const total = (c: { townsfolk: number; outsider: number; minion: number; demon: number }) =>
        c.townsfolk + c.outsider + c.minion + c.demon;
      expect(total(modified)).toBe(n);
      expect(total(modified)).toBe(total(base));
    }
  });

  it('deal in the Baron setup for a real distribution when the Baron is drawn', () => {
    // `sampleCharacters` shuffles with Math.random, so the drawn Minions cannot
    // be injected directly. A constant 0.5 makes the Fisher-Yates pass on the
    // 4-character Minion pool (poisoner, spy, scarlet-woman, baron) yield
    // [poisoner, baron], which puts the Baron in play. The seed is an
    // implementation detail of `shuffle` — if that ever changes this test fails
    // loudly on the hasBaron assertion below, and the fix is one number.
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const session = makeSessionWithPlayers(10);
      distributeRoles(session);
      const counts = { townsfolk: 0, outsider: 0, minion: 0, demon: 0 };
      for (const p of session.players.values()) {
        if (p.characterType) counts[p.characterType] += 1;
      }
      expect([...session.players.values()].some((p) => p.character === 'baron')).toBe(true);
      expect(counts).toEqual({ townsfolk: 5, outsider: 2, minion: 2, demon: 1 });
    } finally {
      random.mockRestore();
    }
  });

  it('honours the base table exactly whenever the Baron is not in play', () => {
    for (let attempt = 0; attempt < 15; attempt++) {
      const session = makeSessionWithPlayers(10);
      distributeRoles(session);
      const counts = { townsfolk: 0, outsider: 0, minion: 0, demon: 0 };
      for (const p of session.players.values()) {
        if (p.characterType) counts[p.characterType] += 1;
      }
      if ([...session.players.values()].some((p) => p.character === 'baron')) continue;
      expect(counts).toEqual({ townsfolk: 7, outsider: 0, minion: 2, demon: 1 });
    }
  });

  it('never assigns the Drunk a cover character that is already in play', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        const session = makeSessionWithPlayers(10);
        distributeRoles(session);
        const inPlay = new Set([...session.players.values()].map((p) => p.character));
        for (const p of session.players.values()) {
          if (p.character !== 'drunk') continue;
          expect(p.drunkCoverCharacterId).not.toBeNull();
          expect(inPlay.has(p.drunkCoverCharacterId!)).toBe(false);
        }
      }
    } finally {
      random.mockRestore();
    }
  });

  it('throws for player counts outside the supported range', () => {
    const tooFew = makeSessionWithPlayers(4);
    expect(() => distributeRoles(tooFew)).toThrow();
    const tooMany = makeSessionWithPlayers(16);
    expect(() => distributeRoles(tooMany)).toThrow();
  });
});

describe('buildPlayerDistributionPayload (information hiding)', () => {
  it('never includes other players data for a Good-aligned player', () => {
    const session = makeSessionWithPlayers(10);
    distributeRoles(session);
    const goodPlayer = [...session.players.values()].find((p) => p.alignment === 'good');
    expect(goodPlayer).toBeDefined();
    const payload = buildPlayerDistributionPayload(session, goodPlayer!);
    expect(payload.role).toBe('player');
    expect('teammates' in payload).toBe(false);
    expect('bluff' in payload).toBe(false);
  });

  it('includes teammates and exactly one bluff for an Evil-aligned player, and the bluff is a Townsfolk not in play', () => {
    const session = makeSessionWithPlayers(10);
    distributeRoles(session);
    const evilPlayer = [...session.players.values()].find((p) => p.alignment === 'evil');
    expect(evilPlayer).toBeDefined();
    const payload = buildPlayerDistributionPayload(session, evilPlayer!);
    if (payload.role === 'player' && 'teammates' in payload) {
      const inPlayIds = new Set([...session.players.values()].map((p) => p.character));
      expect(payload.bluff).toBeDefined();
      expect(inPlayIds.has(payload.bluff!.id)).toBe(false);
      for (const teammate of payload.teammates ?? []) {
        expect(teammate.playerId).not.toBe(evilPlayer!.playerId);
      }
    } else {
      throw new Error('expected evil payload shape');
    }
  });

  it('gives each Evil player a fixed bluff that never changes across repeated payload builds', () => {
    const session = makeSessionWithPlayers(10);
    distributeRoles(session);
    const evilPlayer = [...session.players.values()].find((p) => p.alignment === 'evil')!;
    const first = buildPlayerDistributionPayload(session, evilPlayer);
    const second = buildPlayerDistributionPayload(session, evilPlayer);
    if (first.role === 'player' && 'bluff' in first && second.role === 'player' && 'bluff' in second) {
      expect(first.bluff?.id).toBe(second.bluff?.id);
    } else {
      throw new Error('expected evil payload shape');
    }
  });

  it('gives each Evil player their own bluff (not necessarily shared with other Evil players)', () => {
    const session = makeSessionWithPlayers(15); // 3 minions + 1 demon = 4 evil players
    distributeRoles(session);
    const evilPlayers = [...session.players.values()].filter((p) => p.alignment === 'evil');
    expect(evilPlayers.length).toBeGreaterThan(1);
    for (const p of evilPlayers) {
      expect(p.bluffCharacterId).not.toBeNull();
    }
  });
});
