import { describe, expect, it } from 'vitest';
import { SessionStore, type GameSession, type PlayerRecord } from '../session/store.js';
import {
  advanceNightStep,
  buildNightRoster,
  computeWakeOrder,
  eligibleNightTargets,
  resolveChef,
  resolveEmpath,
  resolveUndertaker,
  scarletWomanEligible,
  startNight,
  submitAssistedNightAction,
} from './nightEngine.js';

function makeSession(count: number): { session: GameSession; players: PlayerRecord[] } {
  const store = new SessionStore();
  const session = store.createSession('tok');
  const players: PlayerRecord[] = [];
  for (let i = 0; i < count; i++) {
    players.push(store.addPlayer(session, `p${i}`, `Player${i}`));
  }
  return { session, players };
}

function setCharacter(player: PlayerRecord, character: string, characterType: PlayerRecord['characterType']) {
  player.character = character;
  player.characterType = characterType;
  player.alignment = characterType === 'demon' || characterType === 'minion' ? 'evil' : 'good';
}

describe('computeWakeOrder', () => {
  it('orders living, in-play characters by firstNightOrder on the first night', () => {
    const { session, players } = makeSession(5);
    setCharacter(players[0]!, 'imp', 'demon'); // firstNightOrder 0.5
    setCharacter(players[1]!, 'washerwoman', 'townsfolk'); // firstNightOrder 1
    setCharacter(players[2]!, 'chef', 'townsfolk'); // firstNightOrder 4
    setCharacter(players[3]!, 'poisoner', 'minion'); // firstNightOrder 0
    setCharacter(players[4]!, 'virgin', 'townsfolk'); // no night order at all

    const order = computeWakeOrder(session, true);
    expect(order).toEqual([players[3]!.playerId, players[0]!.playerId, players[1]!.playerId, players[2]!.playerId]);
  });

  it('uses otherNightOrder on nights after the first, and excludes first-night-only roles', () => {
    const { session, players } = makeSession(3);
    setCharacter(players[0]!, 'washerwoman', 'townsfolk'); // firstNightOrder only, no otherNightOrder
    setCharacter(players[1]!, 'empath', 'townsfolk'); // otherNightOrder 1
    setCharacter(players[2]!, 'imp', 'demon'); // otherNightOrder 8

    const order = computeWakeOrder(session, false);
    expect(order).toEqual([players[1]!.playerId, players[2]!.playerId]);
  });

  it('excludes dead players even if their character would otherwise wake', () => {
    const { session, players } = makeSession(2);
    setCharacter(players[0]!, 'empath', 'townsfolk');
    setCharacter(players[1]!, 'imp', 'demon');
    players[0]!.alive = false;

    const order = computeWakeOrder(session, false);
    expect(order).toEqual([players[1]!.playerId]);
  });

  it('excludes players with no character assigned yet', () => {
    const { session, players } = makeSession(2);
    setCharacter(players[0]!, 'empath', 'townsfolk');
    // players[1] never got a character.

    const order = computeWakeOrder(session, false);
    expect(order).toEqual([players[0]!.playerId]);
  });
});

describe('startNight and buildNightRoster', () => {
  it('starts fresh night state and builds a roster with the first step marked current', () => {
    const { session, players } = makeSession(3);
    setCharacter(players[0]!, 'poisoner', 'minion');
    setCharacter(players[1]!, 'empath', 'townsfolk');
    setCharacter(players[2]!, 'imp', 'demon');

    startNight(session, true);
    const roster = buildNightRoster(session);

    expect(roster).not.toBeNull();
    expect(roster!.isFirstNight).toBe(true);
    // Poisoner (0) wakes before Imp (0.5); Empath has no firstNightOrder here... wait Empath IS 5.
    expect(roster!.steps.map((s) => s.characterId)).toEqual(['poisoner', 'imp', 'empath']);
    expect(roster!.steps[0]!.current).toBe(true);
    expect(roster!.steps[0]!.done).toBe(false);
    expect(roster!.steps[0]!.automationClass).toBe('assisted');
  });

  it('advanceNightStep moves the current pointer forward and is idempotent past the end', () => {
    const { session, players } = makeSession(2);
    setCharacter(players[0]!, 'poisoner', 'minion');
    setCharacter(players[1]!, 'empath', 'townsfolk');

    startNight(session, true);
    advanceNightStep(session);
    let roster = buildNightRoster(session)!;
    expect(roster.steps[0]!.current).toBe(false);
    expect(roster.steps[1]!.current).toBe(true);

    advanceNightStep(session);
    advanceNightStep(session); // past the end -- must not throw or go out of bounds
    roster = buildNightRoster(session)!;
    expect(roster.steps.every((s) => !s.current)).toBe(true);
  });

  it('returns null when no night is in progress', () => {
    const { session } = makeSession(2);
    expect(buildNightRoster(session)).toBeNull();
  });
});

describe('resolveChef', () => {
  it('counts adjacent evil pairs around the full seating circle, including wraparound', () => {
    const { session, players } = makeSession(4);
    // Seats 0,1,2,3 in order. Make 0-1 evil-evil (one pair) and 3-0 evil-good.
    setCharacter(players[0]!, 'imp', 'demon');
    setCharacter(players[1]!, 'poisoner', 'minion');
    setCharacter(players[2]!, 'chef', 'townsfolk');
    setCharacter(players[3]!, 'empath', 'townsfolk');

    expect(resolveChef(session)).toContain('1 pair');
  });

  it('counts two separate evil pairs correctly', () => {
    const { session, players } = makeSession(6);
    // Pairs at (0,1) and (3,4); player 2 and 5 are good, breaking up the pairs.
    setCharacter(players[0]!, 'imp', 'demon');
    setCharacter(players[1]!, 'poisoner', 'minion');
    setCharacter(players[2]!, 'chef', 'townsfolk');
    setCharacter(players[3]!, 'baron', 'minion');
    setCharacter(players[4]!, 'scarlet-woman', 'minion');
    setCharacter(players[5]!, 'empath', 'townsfolk');

    expect(resolveChef(session)).toContain('2 pairs');
  });

  it('reports 0 pairs when no two evil players are seated next to each other', () => {
    const { session, players } = makeSession(4);
    setCharacter(players[0]!, 'imp', 'demon');
    setCharacter(players[1]!, 'chef', 'townsfolk');
    setCharacter(players[2]!, 'poisoner', 'minion');
    setCharacter(players[3]!, 'empath', 'townsfolk');

    expect(resolveChef(session)).toContain('0 pairs');
  });
});

describe('resolveEmpath', () => {
  it('counts how many of the 2 alive neighbours are evil', () => {
    const { session, players } = makeSession(3);
    setCharacter(players[0]!, 'imp', 'demon');
    setCharacter(players[1]!, 'empath', 'townsfolk');
    setCharacter(players[2]!, 'poisoner', 'minion');

    expect(resolveEmpath(session, players[1]!.playerId)).toContain('2 of your 2');
  });

  it('skips a dead neighbour to check the next living one', () => {
    const { session, players } = makeSession(4);
    setCharacter(players[0]!, 'chef', 'townsfolk');
    setCharacter(players[1]!, 'empath', 'townsfolk');
    setCharacter(players[2]!, 'poisoner', 'minion');
    setCharacter(players[3]!, 'imp', 'demon');
    players[2]!.alive = false; // dead evil neighbour skipped; next living right-neighbour is the Imp (still evil)

    expect(resolveEmpath(session, players[1]!.playerId)).toContain('1 of your 2');
  });
});

describe('resolveUndertaker', () => {
  it('reports the executed character name when someone was executed today', () => {
    expect(resolveUndertaker({} as GameSession, 'imp')).toContain('Imp');
  });

  it('reports nobody executed when there was no execution today', () => {
    expect(resolveUndertaker({} as GameSession, null)).toBe('Nobody was executed today.');
  });
});

describe('scarletWomanEligible', () => {
  it('is true with a living Scarlet Woman and 5+ living players', () => {
    const { session, players } = makeSession(5);
    setCharacter(players[0]!, 'imp', 'demon');
    setCharacter(players[1]!, 'scarlet-woman', 'minion');
    setCharacter(players[2]!, 'chef', 'townsfolk');
    setCharacter(players[3]!, 'empath', 'townsfolk');
    setCharacter(players[4]!, 'washerwoman', 'townsfolk');

    expect(scarletWomanEligible(session)).toBe(true);
  });

  it('is false below 5 living players even with a living Scarlet Woman', () => {
    const { session, players } = makeSession(4);
    setCharacter(players[0]!, 'imp', 'demon');
    setCharacter(players[1]!, 'scarlet-woman', 'minion');
    setCharacter(players[2]!, 'chef', 'townsfolk');
    setCharacter(players[3]!, 'empath', 'townsfolk');

    expect(scarletWomanEligible(session)).toBe(false);
  });

  it('is false with no Scarlet Woman in play', () => {
    const { session, players } = makeSession(5);
    setCharacter(players[0]!, 'imp', 'demon');
    setCharacter(players[1]!, 'poisoner', 'minion');
    setCharacter(players[2]!, 'chef', 'townsfolk');
    setCharacter(players[3]!, 'empath', 'townsfolk');
    setCharacter(players[4]!, 'washerwoman', 'townsfolk');

    expect(scarletWomanEligible(session)).toBe(false);
  });
});

describe('eligibleNightTargets', () => {
  it("applies the 'other' restriction, excluding the acting player themself", () => {
    const { session, players } = makeSession(3);
    setCharacter(players[0]!, 'poisoner', 'minion'); // targetRestrictions: ['other']
    setCharacter(players[1]!, 'chef', 'townsfolk');
    setCharacter(players[2]!, 'empath', 'townsfolk');

    const targets = eligibleNightTargets(session, players[0]!.playerId);
    expect(targets).not.toContain(players[0]!.playerId);
    expect(targets).toContain(players[1]!.playerId);
    expect(targets).toContain(players[2]!.playerId);
  });

  it("applies the 'alive' restriction, excluding dead players (Monk)", () => {
    const { session, players } = makeSession(3);
    setCharacter(players[0]!, 'monk', 'townsfolk'); // targetRestrictions: ['other', 'alive']
    setCharacter(players[1]!, 'chef', 'townsfolk');
    setCharacter(players[2]!, 'empath', 'townsfolk');
    players[1]!.alive = false;

    const targets = eligibleNightTargets(session, players[0]!.playerId);
    expect(targets).not.toContain(players[1]!.playerId);
    expect(targets).toContain(players[2]!.playerId);
  });

  it('returns an empty list for a character with no character assigned', () => {
    const { session, players } = makeSession(2);
    expect(eligibleNightTargets(session, players[0]!.playerId)).toEqual([]);
  });
});

describe('submitAssistedNightAction', () => {
  it('Monk: sets protected on the chosen target', () => {
    const { session, players } = makeSession(3);
    setCharacter(players[0]!, 'monk', 'townsfolk');
    setCharacter(players[1]!, 'chef', 'townsfolk');
    setCharacter(players[2]!, 'empath', 'townsfolk');

    const result = submitAssistedNightAction(session, players[0]!.playerId, [players[1]!.playerId]);

    expect(result.resultText).toBeNull();
    expect(players[1]!.statusEffects.protected).toBe(true);
  });

  it('Poisoner: sets poisoned on the chosen target', () => {
    const { session, players } = makeSession(3);
    setCharacter(players[0]!, 'poisoner', 'minion');
    setCharacter(players[1]!, 'chef', 'townsfolk');
    setCharacter(players[2]!, 'empath', 'townsfolk');

    const result = submitAssistedNightAction(session, players[0]!.playerId, [players[1]!.playerId]);

    expect(result.resultText).toBeNull();
    expect(players[1]!.statusEffects.poisoned).toBe(true);
  });

  it('Butler: records the choice but returns no info and sets no status effect (not Storyteller-enforced)', () => {
    const { session, players } = makeSession(3);
    setCharacter(players[0]!, 'butler', 'outsider');
    setCharacter(players[1]!, 'chef', 'townsfolk');
    setCharacter(players[2]!, 'empath', 'townsfolk');

    const result = submitAssistedNightAction(session, players[0]!.playerId, [players[1]!.playerId]);

    expect(result.resultText).toBeNull();
    expect(players[1]!.statusEffects).toEqual({ poisoned: false, drunk: false, protected: false });
  });

  it('Ravenkeeper: returns the true character name of the chosen target', () => {
    const { session, players } = makeSession(3);
    setCharacter(players[0]!, 'ravenkeeper', 'townsfolk');
    setCharacter(players[1]!, 'imp', 'demon');
    setCharacter(players[2]!, 'empath', 'townsfolk');

    const result = submitAssistedNightAction(session, players[0]!.playerId, [players[1]!.playerId]);

    expect(result.resultText).toContain('Imp');
  });

  it('rejects a target outside the legal target list', () => {
    const { session, players } = makeSession(3);
    setCharacter(players[0]!, 'poisoner', 'minion'); // 'other' restriction
    setCharacter(players[1]!, 'chef', 'townsfolk');
    setCharacter(players[2]!, 'empath', 'townsfolk');

    expect(() => submitAssistedNightAction(session, players[0]!.playerId, [players[0]!.playerId])).toThrow();
  });

  it('rejects the wrong number of targets', () => {
    const { session, players } = makeSession(3);
    setCharacter(players[0]!, 'monk', 'townsfolk'); // targetCount: 1
    setCharacter(players[1]!, 'chef', 'townsfolk');
    setCharacter(players[2]!, 'empath', 'townsfolk');

    expect(() => submitAssistedNightAction(session, players[0]!.playerId, [])).toThrow();
    expect(() =>
      submitAssistedNightAction(session, players[0]!.playerId, [players[1]!.playerId, players[2]!.playerId])
    ).toThrow();
  });
});
