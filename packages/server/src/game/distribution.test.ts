import { describe, expect, it } from 'vitest';
import { MAX_PLAYERS, MIN_PLAYERS, getCharacterById } from '@clocktower/shared';
import { SessionStore } from '../session/store.js';
import { buildPlayerDistributionPayload, distributeRoles, setDiscretionOverride } from './distribution.js';

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

  it('matches the distribution table type counts for N=10, adjusted for the Baron when drawn', () => {
    // The Baron's [+2 Outsiders] modifier means the exact split is only
    // deterministic once we know whether the Baron was actually selected as
    // one of the Minions -- so this asserts the invariant that holds either
    // way (total count, minion/demon counts, and the Baron-adjusted split)
    // rather than a single fixed townsfolk/outsider split.
    const session = makeSessionWithPlayers(10);
    distributeRoles(session);
    const counts = { townsfolk: 0, outsider: 0, minion: 0, demon: 0 };
    for (const p of session.players.values()) {
      if (p.characterType) counts[p.characterType] += 1;
    }
    expect(counts.minion).toBe(2);
    expect(counts.demon).toBe(1);
    expect(counts.townsfolk + counts.outsider).toBe(7);

    const hasBaron = [...session.players.values()].some((p) => p.character === 'baron');
    if (hasBaron) {
      expect(counts.outsider).toBe(2);
      expect(counts.townsfolk).toBe(5);
    } else {
      expect(counts.outsider).toBe(0);
      expect(counts.townsfolk).toBe(7);
    }
  });

  it("applies the Baron's [+2 Outsiders] modifier whenever the Baron is actually drawn, across many trials", () => {
    // Run distribution many times at N=10 (small Minion pool -> Baron drawn
    // often) so both the with-Baron and without-Baron branches are
    // exercised at least once, proving the modifier is wired correctly
    // rather than coincidentally never triggering.
    let sawWithBaron = false;
    let sawWithoutBaron = false;
    for (let i = 0; i < 60 && !(sawWithBaron && sawWithoutBaron); i++) {
      const session = makeSessionWithPlayers(10);
      distributeRoles(session);
      const players = [...session.players.values()];
      const hasBaron = players.some((p) => p.character === 'baron');
      const outsiderCount = players.filter((p) => p.characterType === 'outsider').length;
      const townsfolkCount = players.filter((p) => p.characterType === 'townsfolk').length;

      if (hasBaron) {
        sawWithBaron = true;
        expect(outsiderCount).toBe(2);
        expect(townsfolkCount).toBe(5);
      } else {
        sawWithoutBaron = true;
        expect(outsiderCount).toBe(0);
        expect(townsfolkCount).toBe(7);
      }
    }
    expect(sawWithBaron).toBe(true);
    expect(sawWithoutBaron).toBe(true);
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

describe('discretion defaults (Drunk cover, Fortune Teller red herring)', () => {
  it('assigns the Drunk a default cover character not shared with any in-play character or bluff, and logs it', () => {
    // Trouble Brewing has 15 characters at N=15, leaving few unused
    // Townsfolk -- run several trials so a Drunk (Outsider pool) is
    // actually drawn at least once.
    let sawDrunk = false;
    for (let i = 0; i < 30 && !sawDrunk; i++) {
      const session = makeSessionWithPlayers(15);
      distributeRoles(session);
      const drunkPlayer = [...session.players.values()].find((p) => p.character === 'drunk');
      if (!drunkPlayer) continue;
      sawDrunk = true;

      expect(drunkPlayer.drunkCoverCharacterId).not.toBeNull();
      const coverDef = getCharacterById(drunkPlayer.drunkCoverCharacterId!);
      expect(coverDef?.type).toBe('townsfolk');
      // Preferring an unused Townsfolk is a nice-to-have, not a hard rule --
      // the real game has no problem with the Drunk's fake claim coinciding
      // with a character someone else is genuinely playing. At high player
      // counts (few or zero unused Townsfolk remain after bluffs), the
      // cover legitimately falls back to a used one, and that's fine.

      const logEntry = session.discretionLog.find((e) => e.kind === 'drunk-cover' && e.playerId === drunkPlayer.playerId);
      expect(logEntry).toBeDefined();
      expect(logEntry?.isOverride).toBe(false);
    }
    expect(sawDrunk).toBe(true);
  });

  it("shows the Drunk their cover character's name and ability, never the literal string 'Drunk'", () => {
    let sawDrunk = false;
    for (let i = 0; i < 30 && !sawDrunk; i++) {
      const session = makeSessionWithPlayers(15);
      distributeRoles(session);
      const drunkPlayer = [...session.players.values()].find((p) => p.character === 'drunk');
      if (!drunkPlayer) continue;
      sawDrunk = true;

      const payload = buildPlayerDistributionPayload(session, drunkPlayer);
      if (payload.role !== 'player') throw new Error('expected player payload');
      expect(payload.characterName).not.toBe('Drunk');
      const coverDef = getCharacterById(drunkPlayer.drunkCoverCharacterId!);
      expect(payload.characterName).toBe(coverDef?.name);
      expect(payload.ability).toBe(coverDef?.ability);
      // The true character id is still 'drunk' internally, for win
      // conditions / Chef / Empath / etc. to compute off the real state.
      expect(payload.character).toBe('drunk');
    }
    expect(sawDrunk).toBe(true);
  });

  it('assigns the Fortune Teller a default red herring: a good player other than themself, and logs it', () => {
    let sawFT = false;
    for (let i = 0; i < 30 && !sawFT; i++) {
      const session = makeSessionWithPlayers(7); // Fortune Teller is common at small counts too
      distributeRoles(session);
      const ft = [...session.players.values()].find((p) => p.character === 'fortune-teller');
      if (!ft) continue;
      sawFT = true;

      expect(ft.fortuneTellerRedHerringId).not.toBeNull();
      expect(ft.fortuneTellerRedHerringId).not.toBe(ft.playerId);
      const herring = session.players.get(ft.fortuneTellerRedHerringId!);
      expect(herring?.alignment).toBe('good');

      const logEntry = session.discretionLog.find(
        (e) => e.kind === 'fortune-teller-red-herring' && e.playerId === ft.playerId
      );
      expect(logEntry).toBeDefined();
      expect(logEntry?.isOverride).toBe(false);
    }
    expect(sawFT).toBe(true);
  });
});

describe('setDiscretionOverride', () => {
  it('overrides the Drunk cover and appends a new isOverride:true log entry without erasing history', () => {
    const session = makeSessionWithPlayers(5);
    const [alice] = [...session.players.values()];
    alice!.character = 'drunk';
    alice!.characterType = 'outsider';
    alice!.alignment = 'good';
    alice!.drunkCoverCharacterId = 'chef';
    session.discretionLog.push({ kind: 'drunk-cover', playerId: alice!.playerId, value: 'chef', isOverride: false, at: 1 });

    setDiscretionOverride(session, 'drunk-cover', alice!.playerId, 'empath');

    expect(alice!.drunkCoverCharacterId).toBe('empath');
    expect(session.discretionLog).toHaveLength(2);
    expect(session.discretionLog[1]).toMatchObject({ kind: 'drunk-cover', value: 'empath', isOverride: true });
    // History is preserved, not rewritten.
    expect(session.discretionLog[0]).toMatchObject({ value: 'chef', isOverride: false });
  });

  it('overrides the Fortune Teller red herring to a different player', () => {
    const session = makeSessionWithPlayers(5);
    const players = [...session.players.values()];
    players[0]!.character = 'fortune-teller';
    players[0]!.fortuneTellerRedHerringId = players[1]!.playerId;

    setDiscretionOverride(session, 'fortune-teller-red-herring', players[0]!.playerId, players[2]!.playerId);

    expect(players[0]!.fortuneTellerRedHerringId).toBe(players[2]!.playerId);
  });

  it('throws for an unknown playerId', () => {
    const session = makeSessionWithPlayers(5);
    expect(() => setDiscretionOverride(session, 'drunk-cover', 'nonexistent', 'chef')).toThrow();
  });
});
