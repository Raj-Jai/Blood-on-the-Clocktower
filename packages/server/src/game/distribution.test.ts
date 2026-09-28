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

// ---------------------------------------------------------------------------

/**
 * What Evil is told about Evil.
 *
 * `evilTeammatesOf` used to return every other Evil player's TRUE CHARACTER NAME, at
 * every player count. That is the entire script handed to every Evil player in one
 * payload, at the moment the game starts, before anyone has spoken — and it also told a
 * Minion who the Demon was, which the rules do not grant at any count.
 *
 * "You learn who the other Minions are" is a list of NAMES, and only at 7 or more
 * players. Six is the most common table size in the app's own test sweep, so this is
 * the case that mattered most.
 */
describe('Evil is told identities, never characters', () => {
  function evilTable(n: number) {
    const session = makeSessionWithPlayers(n);
    distributeRoles(session);
    const players = [...session.players.values()];
    const demon = players.find((p) => p.characterType === 'demon')!;
    const minion = players.find((p) => p.characterType === 'minion')!;
    return { session, demon, minion, players };
  }

  it('tells a 5- or 6-player Minion NOTHING about the other Minions', () => {
    for (const n of [5, 6]) {
      const { session, minion, demon } = evilTable(n);
      const payload = buildPlayerDistributionPayload(session, minion);
      // No Minion information exists below 7 players, so there is nothing to send.
      expect(payload.teammates ?? []).toEqual([]);
      // And emphatically not the Demon's name, which is a separate grant entirely.
      expect(JSON.stringify(payload)).not.toContain(demon.playerId);
    }
  });

  it('tells a 7+ Minion who the other Minions are, and not what they are', () => {
    const { session, minion, demon, players } = evilTable(7);
    const payload = buildPlayerDistributionPayload(session, minion);

    // The 7-player script is 5 Townsfolk, 0 Outsiders, 1 Minion, 1 Demon: there are no
    // other Minions, so the list is legitimately empty here. What matters is that the
    // Demon is not in it.
    expect(payload.teammates ?? []).toEqual([]);
    expect(JSON.stringify(payload)).not.toContain(demon.playerId);

    // Hand-build the case that has a second Minion, since 7+ with 2 Minions needs 10
    // players. Directly asserting the shape here: a NAME and nothing else.
    const second = players.find((p) => p.characterType === 'townsfolk')!;
    second.character = 'poisoner';
    second.characterType = 'minion';
    second.alignment = 'evil';
    const withTeammate = buildPlayerDistributionPayload(session, minion);
    expect(withTeammate.teammates).toEqual([
      { playerId: second.playerId, displayName: second.displayName },
    ]);
    /*
     * The guarantee is structural, and this is the assertion that carries it: a teammate
     * entry has exactly two keys, and neither is a character. A `not.toContain('Poisoner')`
     * search over the whole payload cannot work here and never did — a Minion's own BLUFF is
     * legitimately any character not in play, so their payload names characters that have
     * nothing to do with the leak. Changing the type is what actually prevents it.
     */
    expect(Object.keys(withTeammate.teammates![0]!)).toEqual(['playerId', 'displayName']);
    expect(withTeammate.teammates![0]).not.toHaveProperty('character');
    expect(withTeammate.teammates![0]).not.toHaveProperty('characterName');
  });

  it('leaks no other player character to an Evil player at any count', () => {
    for (const n of [5, 7, 10]) {
      const { session, players } = evilTable(n);
      for (const p of players.filter((x) => x.alignment === 'evil')) {
        const serialised = JSON.stringify(buildPlayerDistributionPayload(session, p));
        // Every Good player's character, by name, must be absent.
        for (const other of players.filter((x) => x.alignment !== 'evil')) {
          expect(serialised).not.toContain(other.displayName);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------

/**
 * The Drunk's cover has to be a character they can actually use.
 *
 * The cover pool was every unused Townsfolk, which includes Soldier, Virgin and Slayer —
 * all three have abilities that do nothing on their own. Such a Drunk is shown ability
 * text at night, is given a slot in the night order, and can never once use any of it.
 */
describe('the Drunk is never dealt a cover with no usable ability', () => {
  const UNUSABLE = ['soldier', 'virgin', 'slayer'];

  it('never picks Soldier, Virgin or Slayer, across many deals and player counts', () => {
    for (const n of [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]) {
      for (let attempt = 0; attempt < 12; attempt++) {
        const session = makeSessionWithPlayers(n);
        distributeRoles(session);
        const drunk = [...session.players.values()].find((p) => p.character === 'drunk');
        if (!drunk) continue;
        expect(UNUSABLE).not.toContain(drunk.drunkCoverCharacterId);
        // And the cover is still a real Townsfolk they can be told about.
        const payload = buildPlayerDistributionPayload(session, drunk);
        expect(payload.characterType).toBe('townsfolk');
        expect(payload.characterName).not.toBe('Drunk');
      }
    }
  });

  it('gives up the cover of a character that IS in play rather than falling back to a dead one', () => {
    // The fallback is what runs on a small table where the usable Townsfolk are all in
    // play. Reaching for an unusable one there would reintroduce the bug exactly when it is
    // least noticeable, so the fallback is the usable set too.
    //
    // Six players, not five: the Drunk is an Outsider and the 5-player script is
    // 3 Townsfolk / 0 Outsiders, so there is no Drunk to deal at that size at all.
    // Dealt repeatedly: the one Outsider in a 6-player script is one of four, so a single
    // deal is a one-in-four chance of having a Drunk at all.
    let drunk: ReturnType<typeof Object> | undefined;
    for (let attempt = 0; attempt < 20 && !drunk; attempt++) {
      const session = makeSessionWithPlayers(6);
      distributeRoles(session);
      drunk = [...session.players.values()].find((p) => p.character === 'drunk');
    }
    expect(drunk).toBeDefined();
    expect(UNUSABLE).not.toContain(drunk!.drunkCoverCharacterId);
  });
});
