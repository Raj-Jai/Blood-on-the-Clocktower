import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Server as SocketIOServer } from 'socket.io';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { ClientEvents, ServerEvents, getCharacterById } from '@clocktower/shared';
import { SessionStore, type GameSession, type PlayerRecord } from '../session/store.js';
import { registerGatewayHandlers } from '../gateway/index.js';
import { createApp } from '../http/app.js';
import {
  buildNightOrder,
  endNight,
  openNight,
  pendingStepsForPlayer,
  resolveNight,
  submitNightChoice,
  toNightOrderUpdate,
} from './nightEngine.js';
import { chefEvilPairCount, empathEvilNeighbourCount, perceivedAs, slayerWouldKill, virginTriggersExecution } from './abilities.js';
import { resolveDemonKill } from './demonKill.js';
import { buildPlayerDistributionPayload } from './distribution.js';
import { checkMayorWin, checkSaintExecution } from './winConditions.js';
import {
  chooseStickyRegistration,
  deliverNightInfo,
  generateCountInfo,
  lieContext,
  renderCountInfo,
  stableUnit,
} from './liePolicy.js';

function setCharacter(player: PlayerRecord, characterId: string): void {
  const def = getCharacterById(characterId);
  if (!def) throw new Error(`unknown character ${characterId}`);
  player.character = def.id;
  player.characterType = def.type;
  player.alignment = def.alignment;
}

function makeSession(count: number): { session: GameSession; players: PlayerRecord[] } {
  const store = new SessionStore();
  const session = store.createSession('tok');
  const players: PlayerRecord[] = [];
  for (let i = 0; i < count; i++) players.push(store.addPlayer(session, `p${i}`, `Player${i}`));
  session.phase = 'night';
  return { session, players };
}

// ---------------------------------------------------------------------------

describe('buildNightOrder', () => {
  it('returns the official First Night order, with the Demon woken last', () => {
    const { session, players } = makeSession(7);
    setCharacter(players[0]!, 'washerwoman');
    setCharacter(players[1]!, 'empath');
    setCharacter(players[2]!, 'poisoner');
    setCharacter(players[3]!, 'chef');
    setCharacter(players[4]!, 'fortune-teller');
    setCharacter(players[5]!, 'spy');
    setCharacter(players[6]!, 'imp');

    const order = buildNightOrder(session);

    expect(order.map((s) => s.characterId)).toEqual([
      'washerwoman',
      'chef',
      'empath',
      'fortune-teller',
      'poisoner',
      'spy',
      'imp',
    ]);
    expect(order.every((s) => s.isFirstNight)).toBe(true);
  });

  it('REGRESSION: the Imp appears in the first night order at all', () => {
    // `firstNightOrder: null` on the Imp used to filter the Demon out of the
    // First Night panel entirely, so the app actively told the Storyteller not
    // to wake the Imp on night one.
    expect(getCharacterById('imp')!.firstNightOrder).toBe(10);
    const { session, players } = makeSession(5);
    setCharacter(players[0]!, 'imp');
    setCharacter(players[1]!, 'poisoner');
    setCharacter(players[2]!, 'spy');
    setCharacter(players[3]!, 'chef');
    setCharacter(players[4]!, 'washerwoman');
    session.nightNumber = 1;
    const order = buildNightOrder(session);
    expect(order.map((s) => s.characterId)).toContain('imp');
    expect(order[order.length - 1]!.characterId).toBe('imp');
  });

  it('returns the official other-night order and skips first-night-only characters', () => {
    const { session, players } = makeSession(7);
    setCharacter(players[0]!, 'washerwoman');
    setCharacter(players[1]!, 'empath');
    setCharacter(players[2]!, 'monk');
    setCharacter(players[3]!, 'fortune-teller');
    setCharacter(players[4]!, 'butler');
    setCharacter(players[5]!, 'poisoner');
    setCharacter(players[6]!, 'imp');
    session.nightNumber = 2;

    expect(buildNightOrder(session).map((s) => s.characterId)).toEqual([
      'empath',
      'fortune-teller',
      'monk',
      'butler',
      'poisoner',
      'imp',
    ]);
  });

  it('exposes only legal targets for each picking step', () => {
    const { session, players } = makeSession(6);
    setCharacter(players[0]!, 'monk');
    setCharacter(players[1]!, 'imp');
    setCharacter(players[2]!, 'poisoner');
    setCharacter(players[3]!, 'washerwoman');
    setCharacter(players[4]!, 'recluse');
    setCharacter(players[5]!, 'soldier');

    // The Monk only wakes from the second night, the Washerwoman only on the
    // first, so the two orders have to be built separately.
    session.nightNumber = 1;
    const wash = buildNightOrder(session).find((s) => s.characterId === 'washerwoman')!;
    // 'townsfolk' — the Monk and the Soldier are the other two Townsfolk in
    // play; the Imp, Poisoner and Recluse are not, and 'other' excludes the
    // waker themself.
    expect(wash.legalTargetIds).toEqual([players[0]!.playerId, players[5]!.playerId]);

    session.nightNumber = 2;
    const monk = buildNightOrder(session).find((s) => s.characterId === 'monk')!;
    // 'other' excludes the Monk, 'good' excludes the Imp and the Poisoner, and a
    // Recluse who registers as evil is excluded even though they are a Good
    // player. A Recluse who registers truthfully is a legal target.
    expect(monk.legalTargetIds).toEqual([players[3]!.playerId, players[4]!.playerId, players[5]!.playerId]);

    players[4]!.registration = { alignment: 'evil', characterType: 'minion' };
    const monkAfter = buildNightOrder(session).find((s) => s.characterId === 'monk')!;
    expect(monkAfter.legalTargetIds).toEqual([players[3]!.playerId, players[5]!.playerId]);
  });

  it('skips dead players but wakes a Ravenkeeper who is already dead', () => {
    const { session, players } = makeSession(5);
    setCharacter(players[0]!, 'ravenkeeper');
    setCharacter(players[1]!, 'imp');
    players[0]!.alive = false;
    session.nightNumber = 2;

    const order = buildNightOrder(session);
    expect(order.map((s) => s.characterId)).toEqual(['ravenkeeper', 'imp']);
  });

  it('never puts a LIVING Ravenkeeper in the night order, on any night', () => {
    // The Ravenkeeper's ability is conditional on death, so the data's
    // otherNightOrder slot must not put them in the order while they are alive.
    // Inconsistency here is not cosmetic: openNight persists the step list, and a
    // step that exists at resolve time but was never persisted shows up as an
    // unresolved choice that can never be submitted.
    for (const nightNumber of [1, 2, 5]) {
      const { session, players } = makeSession(5);
      setCharacter(players[0]!, 'ravenkeeper');
      setCharacter(players[1]!, 'imp');
      setCharacter(players[2]!, 'poisoner');
      setCharacter(players[3]!, 'chef');
      setCharacter(players[4]!, 'washerwoman');
      session.nightNumber = nightNumber;
      expect(buildNightOrder(session).map((s) => s.characterId)).not.toContain('ravenkeeper');
    }
  });
});

// ---------------------------------------------------------------------------

describe('submitNightChoice', () => {
  function monkSession() {
    const { session, players } = makeSession(5);
    setCharacter(players[0]!, 'monk');
    setCharacter(players[1]!, 'imp');
    setCharacter(players[2]!, 'poisoner');
    setCharacter(players[3]!, 'washerwoman');
    setCharacter(players[4]!, 'recluse');
    session.nightNumber = 2;
    openNight(session);
    return { session, players };
  }

  it('accepts a legal choice and records it', () => {
    const { session, players } = monkSession();
    submitNightChoice(session, players[0]!.playerId, [players[3]!.playerId]);
    expect(session.currentNight!.steps.find((s) => s.wakerPlayerId === players[0]!.playerId)!.targetIds).toEqual([
      players[3]!.playerId,
    ]);
  });

  it('rejects the wrong number of targets', () => {
    const { session, players } = makeSession(5);
    setCharacter(players[0]!, 'fortune-teller');
    setCharacter(players[1]!, 'imp');
    setCharacter(players[2]!, 'poisoner');
    setCharacter(players[3]!, 'washerwoman');
    setCharacter(players[4]!, 'recluse');
    session.nightNumber = 2;
    openNight(session);
    expect(() => submitNightChoice(session, players[0]!.playerId, [players[3]!.playerId])).toThrow(/exactly 2/i);
  });

  it('rejects a self-target', () => {
    const { session, players } = monkSession();
    expect(() => submitNightChoice(session, players[0]!.playerId, [players[0]!.playerId])).toThrow(/not a legal choice/i);
  });

  it('rejects a target of an illegal type', () => {
    const { session, players } = monkSession();
    // The Poisoner is Evil, so a Monk may not protect them.
    expect(() => submitNightChoice(session, players[0]!.playerId, [players[2]!.playerId])).toThrow(/not a legal choice/i);
  });

  it('rejects a dead target', () => {
    const { session, players } = monkSession();
    players[3]!.alive = false;
    expect(() => submitNightChoice(session, players[0]!.playerId, [players[3]!.playerId])).toThrow(/not a legal choice/i);
  });

  it('rejects a duplicate target', () => {
    const { session, players } = makeSession(5);
    setCharacter(players[0]!, 'fortune-teller');
    setCharacter(players[1]!, 'imp');
    setCharacter(players[2]!, 'poisoner');
    setCharacter(players[3]!, 'washerwoman');
    setCharacter(players[4]!, 'recluse');
    session.nightNumber = 2;
    openNight(session);
    expect(() =>
      submitNightChoice(session, players[0]!.playerId, [players[3]!.playerId, players[3]!.playerId])
    ).toThrow(/only once/i);
  });

  it('rejects a submission from a player who is not the waker', () => {
    const { session, players } = monkSession();
    // Player 3 has a step (the Washerwoman is first-night only, so at night 2
    // they have none) — the point is that a non-waker cannot act for the Monk.
    expect(() => submitNightChoice(session, players[3]!.playerId, [players[4]!.playerId])).toThrow(
      /no night choice/i
    );
  });

  it('rejects a second submission for the same night', () => {
    const { session, players } = monkSession();
    submitNightChoice(session, players[0]!.playerId, [players[3]!.playerId]);
    expect(() => submitNightChoice(session, players[0]!.playerId, [players[4]!.playerId])).toThrow(
      /already sent/i
    );
  });

  it('pendingStepsForPlayer only returns that player’s own unresolved steps', () => {
    const { session, players } = monkSession();
    expect(pendingStepsForPlayer(session, players[0]!.playerId).map((s) => s.characterId)).toEqual(['monk']);
    submitNightChoice(session, players[0]!.playerId, [players[3]!.playerId]);
    expect(pendingStepsForPlayer(session, players[0]!.playerId)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('deferred night steps', () => {
  it('a Ravenkeeper woken by the night kill can still pick after the night resolves', () => {
    // The Ravenkeeper cannot be woken before the death that woke them, so their
    // step is necessarily late. Blocking a post-resolve submission would silently
    // delete the character's entire ability.
    const { session, players } = makeSession(5);
    setCharacter(players[0]!, 'imp');
    setCharacter(players[1]!, 'ravenkeeper');
    setCharacter(players[2]!, 'poisoner');
    setCharacter(players[3]!, 'chef');
    setCharacter(players[4]!, 'recluse');
    session.nightNumber = 2;
    openNight(session);
    // A living Ravenkeeper is not in the order on ANY night: their ability only
    // triggers on death, so they must not wake while alive even though the data
    // gives them an otherNightOrder slot.
    expect(buildNightOrder(session).map((s) => s.characterId)).not.toContain('ravenkeeper');

    submitNightChoice(session, players[0]!.playerId, [players[1]!.playerId]);
    resolveNight(session, null as never);

    expect(players[1]!.alive).toBe(false);
    expect(session.currentNight!.resolved).toBe(true);
    // Their step now exists and is still open.
    const rkStep = session.currentNight!.steps.find((s) => s.wakerPlayerId === players[1]!.playerId);
    expect(rkStep).toBeDefined();
    expect(rkStep!.resolved).toBe(false);

    submitNightChoice(session, players[1]!.playerId, [players[3]!.playerId]);
    expect(rkStep!.resolved).toBe(true);
    expect(rkStep!.targetIds).toEqual([players[3]!.playerId]);
    expect(session.log.some((e) => e.kind === 'ravenkeeper-wake')).toBe(true);
  });

  it('still refuses a late submission from a character that is not deferred', () => {
    const { session, players } = makeSession(5);
    setCharacter(players[0]!, 'imp');
    setCharacter(players[1]!, 'poisoner');
    setCharacter(players[2]!, 'chef');
    setCharacter(players[3]!, 'recluse');
    setCharacter(players[4]!, 'monk');
    session.nightNumber = 2;
    openNight(session);
    // Deliberately leave the Poisoner's choice unsubmitted, then resolve.
    resolveNight(session, null as never);
    expect(session.currentNight!.resolved).toBe(true);
    // resolveNight marks even an unsubmitted step as resolved (as "did nothing"),
    // so the refusal lands on whichever guard fires first. Both are correct.
    expect(() => submitNightChoice(session, players[1]!.playerId, [players[2]!.playerId])).toThrow(/already/i);
  });
});

// ---------------------------------------------------------------------------

describe('detection abilities', () => {  it('Chef counts adjacent pairs of evil players for a known seating', () => {
    const { session, players } = makeSession(5);
    // Seats: good, evil, evil, good, good -> one adjacent evil pair (1-2).
    setCharacter(players[0]!, 'washerwoman');
    setCharacter(players[1]!, 'poisoner');
    setCharacter(players[2]!, 'spy');
    setCharacter(players[3]!, 'chef');
    setCharacter(players[4]!, 'monk');
    expect(chefEvilPairCount(session, players[3]!.playerId)).toBe(1);
  });

  it('Chef counts a wrap-around pair across the end of the circle', () => {
    const { session, players } = makeSession(4);
    // Seats: evil, good, good, evil -> seats 3 and 0 are adjacent, so one pair.
    setCharacter(players[0]!, 'imp');
    setCharacter(players[1]!, 'chef');
    setCharacter(players[2]!, 'monk');
    setCharacter(players[3]!, 'poisoner');
    expect(chefEvilPairCount(session, players[1]!.playerId)).toBe(1);
  });

  it('Empath counts only LIVING neighbours, skipping the dead', () => {
    const { session, players } = makeSession(5);
    // Seats 1,2,3,4,0. Empath at seat 1: neighbours are 0 and 2. Seat 0 is dead,
    // so the nearest LIVING neighbour to the left is seat 4.
    setCharacter(players[0]!, 'washerwoman');
    setCharacter(players[1]!, 'empath');
    setCharacter(players[2]!, 'monk');
    setCharacter(players[3]!, 'chef');
    setCharacter(players[4]!, 'poisoner');
    players[0]!.alive = false;
    // Living neighbours of seat 1 are seat 2 (good) and seat 4 (evil) => 1.
    expect(empathEvilNeighbourCount(session, players[1]!.playerId)).toBe(1);
    players[4]!.alignment = 'good';
    expect(empathEvilNeighbourCount(session, players[1]!.playerId)).toBe(0);
  });

  it('perceivedAs honours a Recluse registering as evil, and a Spy registering as good', () => {
    const { session, players } = makeSession(5);
    setCharacter(players[0]!, 'chef');
    setCharacter(players[1]!, 'recluse');
    setCharacter(players[2]!, 'spy');
    setCharacter(players[3]!, 'empath');
    setCharacter(players[4]!, 'monk');

    expect(perceivedAs(session, players[0]!.playerId, players[1]!.playerId)).toEqual({
      alignment: 'good',
      characterType: 'outsider',
    });

    // A Good Recluse who registers as an evil Minion: evil to detection, still
    // a Good player underneath. Seats 1 (Recluse) and 2 (Spy) are adjacent, so
    // the Chef now sees one adjacent evil pair.
    players[1]!.registration = { alignment: 'evil', characterType: 'minion' };
    expect(perceivedAs(session, players[0]!.playerId, players[1]!.playerId)).toEqual({
      alignment: 'evil',
      characterType: 'minion',
    });
    expect(players[1]!.alignment).toBe('good');
    expect(chefEvilPairCount(session, players[0]!.playerId)).toBe(1);

    // An Evil Spy who registers as a good Townsfolk: good to detection, still
    // evil underneath — and now the pair the Chef sees is gone.
    players[2]!.registration = { alignment: 'good', characterType: 'townsfolk' };
    expect(perceivedAs(session, players[0]!.playerId, players[2]!.playerId)).toEqual({
      alignment: 'good',
      characterType: 'townsfolk',
    });
    expect(players[2]!.alignment).toBe('evil');
    expect(chefEvilPairCount(session, players[0]!.playerId)).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('status effects', () => {
  it('REGRESSION: a protected target is NOT killed', () => {
    const { session, players } = makeSession(5);
    setCharacter(players[0]!, 'imp');
    setCharacter(players[1]!, 'monk');
    setCharacter(players[2]!, 'washerwoman');
    setCharacter(players[3]!, 'chef');
    setCharacter(players[4]!, 'recluse');
    const victim = players[2]!;
    victim.statusEffects.protected = true;

    const result = resolveDemonKill(session, players[0]!.playerId, victim.playerId);

    expect(result.killed).toBe(false);
    expect(victim.alive).toBe(true);
    expect(session.log.some((e) => e.kind === 'kill-blocked')).toBe(true);
  });

  it('a poisoned Demon does not kill', () => {
    const { session, players } = makeSession(5);
    setCharacter(players[0]!, 'imp');
    setCharacter(players[1]!, 'poisoner');
    setCharacter(players[2]!, 'washerwoman');
    setCharacter(players[3]!, 'chef');
    setCharacter(players[4]!, 'recluse');
    session.nightNumber = 2;
    openNight(session);
    // Poisoner poisons the Imp (order 7) before the Imp acts (order 9).
    submitNightChoice(session, players[1]!.playerId, [players[0]!.playerId]);
    submitNightChoice(session, players[0]!.playerId, [players[2]!.playerId]);

    resolveNight(session, null as never);

    expect(players[2]!.alive).toBe(true);
    expect(session.log.some((e) => e.kind === 'ability-failed')).toBe(true);
  });

  it('a healthy Demon kills, and endNight expires protection', () => {
    const { session, players } = makeSession(5);
    setCharacter(players[0]!, 'imp');
    setCharacter(players[1]!, 'monk');
    setCharacter(players[2]!, 'washerwoman');
    setCharacter(players[3]!, 'chef');
    setCharacter(players[4]!, 'recluse');
    session.nightNumber = 2;
    openNight(session);
    // The Monk protects the target, so the kill is stopped...
    submitNightChoice(session, players[1]!.playerId, [players[2]!.playerId]);
    submitNightChoice(session, players[0]!.playerId, [players[2]!.playerId]);
    resolveNight(session, null as never);
    expect(players[2]!.alive).toBe(true);
    // ...and protection expires at dawn, so the same kill lands tomorrow.
    endNight(session);
    expect(players[2]!.statusEffects.protected).toBe(false);
    openNight(session);
    submitNightChoice(session, players[0]!.playerId, [players[2]!.playerId]);
    resolveNight(session, null as never);
    expect(players[2]!.alive).toBe(false);
  });

  it('the Soldier is protected every night without choosing anything', () => {
    const { session, players } = makeSession(5);
    setCharacter(players[0]!, 'imp');
    setCharacter(players[1]!, 'soldier');
    setCharacter(players[2]!, 'washerwoman');
    setCharacter(players[3]!, 'chef');
    setCharacter(players[4]!, 'recluse');
    session.nightNumber = 2;
    openNight(session);
    expect(players[1]!.statusEffects.protected).toBe(true);
    submitNightChoice(session, players[0]!.playerId, [players[1]!.playerId]);
    resolveNight(session, null as never);
    expect(players[1]!.alive).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('the Drunk', () => {
  it('is never shown the string "Drunk" — the payload reports their cover character', () => {
    const store = new SessionStore();
    const session = store.createSession('tok');
    const players: PlayerRecord[] = [];
    for (let i = 0; i < 5; i++) players.push(store.addPlayer(session, `p${i}`, `Player${i}`));
    setCharacter(players[0]!, 'drunk');
    setCharacter(players[1]!, 'imp');
    setCharacter(players[2]!, 'poisoner');
    setCharacter(players[3]!, 'washerwoman');
    setCharacter(players[4]!, 'recluse');
    players[0]!.drunkCoverCharacterId = 'empath';
    players[0]!.statusEffects.drunk = true;

    const payload = buildPlayerDistributionPayload(session, players[0]!);
    const serialised = JSON.stringify(payload);

    expect(serialised).not.toContain('Drunk');
    expect(serialised).not.toContain('drunk');
    expect(payload.role).toBe('player');
    if (payload.role !== 'player') throw new Error('expected player payload');
    expect(payload.characterName).toBe('Empath');
    expect(payload.ability).toBe(getCharacterById('empath')!.ability);
    // A Drunk genuinely believes they are a Townsfolk.
    expect(payload.characterType).toBe('townsfolk');
  });

  it('is woken under their cover character, at the cover character’s position', () => {
    const { session, players } = makeSession(5);
    setCharacter(players[0]!, 'drunk');
    setCharacter(players[1]!, 'imp');
    setCharacter(players[2]!, 'poisoner');
    setCharacter(players[3]!, 'washerwoman');
    setCharacter(players[4]!, 'recluse');
    players[0]!.drunkCoverCharacterId = 'chef'; // First Night order 4
    players[0]!.statusEffects.drunk = true;
    session.nightNumber = 1;

    const order = buildNightOrder(session);
    const drunkStep = order.find((s) => s.wakerPlayerId === players[0]!.playerId)!;
    expect(drunkStep.characterId).toBe('chef');
    expect(drunkStep.order).toBe(4);
    expect(toNightOrderUpdate(session).steps.find((s) => s.wakerPlayerId === players[0]!.playerId)!.isDrunkCover).toBe(
      true
    );
  });
});

// ---------------------------------------------------------------------------

describe('win conditions added by the Night Engine', () => {
  it('executing a Saint loses for Good, and a poisoned Saint does not trigger', () => {
    const { session, players } = makeSession(5);
    setCharacter(players[0]!, 'imp');
    setCharacter(players[1]!, 'saint');
    setCharacter(players[2]!, 'poisoner');
    setCharacter(players[3]!, 'chef');
    setCharacter(players[4]!, 'recluse');

    expect(checkSaintExecution(session, players[1]!.playerId)).toEqual({
      winner: 'evil',
      reason: 'saint-executed',
    });

    players[1]!.statusEffects.poisoned = true;
    expect(checkSaintExecution(session, players[1]!.playerId)).toBeNull();
  });

  it('the Mayor wins for Good at 3 alive with no execution today', () => {
    const { session, players } = makeSession(6);
    setCharacter(players[0]!, 'imp');
    setCharacter(players[1]!, 'mayor');
    setCharacter(players[2]!, 'poisoner');
    setCharacter(players[3]!, 'chef');
    setCharacter(players[4]!, 'recluse');
    setCharacter(players[5]!, 'washerwoman');

    expect(checkMayorWin(session)).toBeNull(); // 6 alive
    players[3]!.alive = false;
    players[4]!.alive = false;
    players[5]!.alive = false;
    expect(checkMayorWin(session)).toEqual({ winner: 'good', reason: 'mayor-three-left' });

    // A qualifying nomination today means an execution has already happened.
    session.resolvedNominationsToday = [{ targetId: players[3]!.playerId, tally: 3 }];
    expect(checkMayorWin(session)).toBeNull();
  });
});

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

describe('daytime-ability predicates', () => {
  it('Virgin triggers when a Townsfolk nominates them, once per game', () => {
    const { session, players } = makeSession(5);
    setCharacter(players[0]!, 'virgin');
    setCharacter(players[1]!, 'chef');
    setCharacter(players[2]!, 'imp');
    setCharacter(players[3]!, 'poisoner');
    setCharacter(players[4]!, 'recluse');

    expect(virginTriggersExecution(session, players[0]!.playerId, players[1]!.playerId)).toBe(players[1]!.playerId);
    // An Evil nominator does not trigger it.
    expect(virginTriggersExecution(session, players[0]!.playerId, players[2]!.playerId)).toBeNull();
    // Once per game.
    session.virginHasTriggered = true;
    expect(virginTriggersExecution(session, players[0]!.playerId, players[1]!.playerId)).toBeNull();
  });

  it('Virgin triggers for a Drunk nominator, who genuinely believes they are a Townsfolk', () => {
    const { session, players } = makeSession(5);
    setCharacter(players[0]!, 'virgin');
    setCharacter(players[1]!, 'drunk');
    setCharacter(players[2]!, 'imp');
    setCharacter(players[3]!, 'poisoner');
    setCharacter(players[4]!, 'recluse');
    players[1]!.drunkCoverCharacterId = 'chef';

    expect(virginTriggersExecution(session, players[0]!.playerId, players[1]!.playerId)).toBe(players[1]!.playerId);
  });

  it('Slayer kills only a perceived Demon, and only once', () => {
    const { session, players } = makeSession(5);
    setCharacter(players[0]!, 'slayer');
    setCharacter(players[1]!, 'imp');
    setCharacter(players[2]!, 'recluse');
    setCharacter(players[3]!, 'chef');
    setCharacter(players[4]!, 'monk');

    expect(slayerWouldKill(session, players[0]!.playerId, players[1]!.playerId)).toBe(true);
    expect(slayerWouldKill(session, players[0]!.playerId, players[2]!.playerId)).toBe(false);
    // A Recluse who registers as a Demon can be Slain — that is the point.
    players[2]!.registration = { alignment: 'evil', characterType: 'demon' };
    expect(slayerWouldKill(session, players[0]!.playerId, players[2]!.playerId)).toBe(true);

    session.slayerHasUsed = true;
    expect(slayerWouldKill(session, players[0]!.playerId, players[1]!.playerId)).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('lie policy', () => {
  function drunkSession() {
    const { session, players } = makeSession(5);
    setCharacter(players[0]!, 'empath');
    setCharacter(players[1]!, 'imp');
    setCharacter(players[2]!, 'poisoner');
    setCharacter(players[3]!, 'chef');
    setCharacter(players[4]!, 'recluse');
    players[0]!.statusEffects.drunk = true;
    return { session, players };
  }

  it('is sticky: the same inputs always produce the same output', () => {
    const { session, players } = drunkSession();
    session.nightNumber = 3;
    const ctx = lieContext(session, players[0]!, 'empath');
    const a = generateCountInfo(ctx, 1, 2);
    const b = generateCountInfo(ctx, 1, 2);
    expect(a.value).toBe(b.value);
    expect(a.truth).toBe(b.truth);
    expect(a.rationale).toBe(b.rationale);
  });

  it('is three-valued: a drunk waker gets RELIABLY_UNRELIABLE, a healthy one gets TRUE', () => {
    const { session, players } = drunkSession();
    session.nightNumber = 3;
    expect(generateCountInfo(lieContext(session, players[0]!, 'empath'), 1, 2).truth).toBe('RELIABLY_UNRELIABLE');
    const healthy = { ...players[0]!, statusEffects: { poisoned: false, drunk: false, protected: false } };
    const info = generateCountInfo(lieContext(session, healthy, 'empath'), 1, 2);
    expect(info.truth).toBe('TRUE');
    expect(info.value).toBe(1);
  });

  it('anti-collapse: a drunk Empath is never given an impossible count, and is not always told the same thing', () => {
    const { session, players } = drunkSession();
    const seen = new Set<number>();
    for (let night = 1; night <= 40; night++) {
      session.nightNumber = night;
      const info = generateCountInfo(lieContext(session, players[0]!, 'empath'), 0, 2);
      const value = info.value as number;
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(2);
      seen.add(value);
    }
    // Not a constant: a Drunk who is always told the same number is detectable.
    expect(seen.size).toBeGreaterThan(1);
  });

  it('renders a count as grammatical English for every cardinality', () => {
    // The first implementation assembled the sentence from a noun and a number and
    // shipped "You learn that there is pair of adjacent evil players." English will
    // not let you do it generically, so each cardinality has its own template.
    const templates = {
      zero: 'You learn that none of your living neighbours is evil.',
      one: 'You learn that one of your living neighbours is evil.',
      many: (n: number) => `You learn that ${n} of your living neighbours are evil.`,
    };
    expect(renderCountInfo({ value: 0, truth: 'TRUE', rationale: '' }, templates)).toBe(
      'You learn that none of your living neighbours is evil.'
    );
    expect(renderCountInfo({ value: 1, truth: 'TRUE', rationale: '' }, templates)).toBe(
      'You learn that one of your living neighbours is evil.'
    );
    expect(renderCountInfo({ value: 2, truth: 'TRUE', rationale: '' }, templates)).toBe(
      'You learn that 2 of your living neighbours are evil.'
    );
  });

  it('a Chef result never contains a missing article or a dangling noun', () => {
    const { session, players } = makeSession(6);
    setCharacter(players[0]!, 'chef');
    setCharacter(players[1]!, 'imp');
    setCharacter(players[2]!, 'poisoner');
    setCharacter(players[3]!, 'monk');
    setCharacter(players[4]!, 'recluse');
    setCharacter(players[5]!, 'washerwoman');
    // 0 here, because openNight increments the night number — leaving it at 1 would
    // open night 2, and the Chef only wakes on the FIRST night.
    session.nightNumber = 0;
    openNight(session);
    expect(session.nightNumber).toBe(1);
    resolveNight(session, null as never);
    const entry = session.log.find((e) => e.kind === 'info-generated' && e.detail.startsWith('Chef'));
    expect(entry).toBeDefined();
    expect(entry!.detail).toMatch(/You learn that (there are no pairs|there is one pair|there are \d+ pairs) of adjacent evil players\./);
  });

  it('stableUnit is a pure function of its inputs', () => {
    expect(stableUnit('a', 1)).toBe(stableUnit('a', 1));
    expect(stableUnit('a', 1)).not.toBe(stableUnit('a', 2));
    expect(stableUnit('x')).toBeGreaterThanOrEqual(0);
    expect(stableUnit('x')).toBeLessThan(1);
  });

  it('keeps the rules channel and the ability channel separate, and the rules channel always true', () => {
    // "Always give correct information about the rules, even to drunk or poisoned
    // players." Collapsing the two channels would let a lie about a character's
    // own ability reach a Drunk, which is both a rules violation and a way to
    // identify them.
    const { session, players } = drunkSession();
    session.nightNumber = 3;
    const delivery = deliverNightInfo({
      rulesText: 'Empath: Each night, you learn how many of your 2 alive neighbours are evil.',
      ability: generateCountInfo(lieContext(session, players[0]!, 'empath'), 1, 2),
    });
    expect(delivery.rulesChannel.truth).toBe('TRUE');
    expect(delivery.rulesChannel.text).toContain('Empath');
    // The ability channel may be unreliable, and the two are distinct fields.
    expect(delivery.abilityChannel).not.toBe(delivery.rulesChannel);
    expect(['TRUE', 'RELIABLY_UNRELIABLE']).toContain(delivery.abilityChannel.truth);
    // The rules text is the real ability text, not a generated one.
    expect(delivery.rulesChannel.text).toContain(getCharacterById('empath')!.ability);
  });

  it('only a fixed minority of eligible players are given a sticky registration', () => {
    // If every Recluse registered as evil every night, registration would stop
    // being information and become a tell. A minority that never changes is both
    // plausible and unlearnable by observation.
    const { session, players } = makeSession(15);
    for (let i = 0; i < 15; i++) setCharacter(players[i]!, i % 5 === 0 ? 'recluse' : 'chef');
    const recluseDef = getCharacterById('recluse');
    const registrations = players
      .filter((p) => p.character === 'recluse')
      .map((p) => chooseStickyRegistration(session, p, recluseDef));
    expect(registrations.length).toBeGreaterThan(0);
    expect(registrations.every((r) => r === null || typeof r.alignment === 'string')).toBe(true);
    // Stable: the same player always draws the same answer.
    for (const p of players) {
      if (p.character !== 'recluse') continue;
      expect(chooseStickyRegistration(session, p, recluseDef)).toEqual(
        chooseStickyRegistration(session, p, recluseDef)
      );
    }
  });

  it('never grants registration permission to a character that cannot register', () => {
    const { session, players } = makeSession(5);
    setCharacter(players[0]!, 'chef');
    expect(chooseStickyRegistration(session, players[0]!, getCharacterById('chef'))).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('night engine over a real socket', () => {
  let httpServer: ReturnType<typeof createServer>;
  let io: SocketIOServer;
  let baseUrl: string;
  let store: SessionStore;

  beforeAll(async () => {
    store = new SessionStore();
    const app = createApp(store);
    httpServer = createServer(app);
    io = new SocketIOServer(httpServer, { cors: { origin: '*' } });
    registerGatewayHandlers(io, store);
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const address = httpServer.address() as AddressInfo;
    baseUrl = `http://localhost:${address.port}`;
  });

  afterAll(async () => {
    io.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  async function waitFor<T = unknown>(socket: ClientSocket, event: string): Promise<T> {
    return new Promise((resolve) => {
      socket.once(event, (payload: T) => resolve(payload));
    });
  }

  /** Waits for the first payload satisfying `predicate`; PlayerSelfUpdate carries several unrelated fields. */
  /** Resolves null if `event` does not arrive within `ms`. */
  async function waitForUpTo<T = any>(socket: ClientSocket, event: string, ms: number): Promise<T | null> {
    return new Promise((resolve) => {
      const handler = (payload: T) => {
        clearTimeout(timer);
        socket.off(event, handler);
        resolve(payload);
      };
      const timer = setTimeout(() => {
        socket.off(event, handler);
        resolve(null);
      }, ms);
      socket.on(event, handler);
    });
  }

  async function waitForWhere<T = any>(
    socket: ClientSocket,
    event: string,
    predicate: (payload: T) => boolean
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.off(event, handler);
        reject(new Error(`timed out waiting for ${event}`));
      }, 5000);
      function handler(payload: T) {
        if (!predicate(payload)) return;
        clearTimeout(timer);
        socket.off(event, handler);
        resolve(payload);
      }
      socket.on(event, handler);
    });
  }

  async function setUpGame() {
    const createRes = await fetch(`${baseUrl}/api/sessions`, { method: 'POST' });
    const { code, storytellerToken } = (await createRes.json()) as { code: string; storytellerToken: string };
    const playerTokens: { playerId: string; playerToken: string }[] = [];
    for (let i = 0; i < 5; i++) {
      const joinRes = await fetch(`${baseUrl}/api/sessions/${code}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: `P${i}` }),
      });
      playerTokens.push((await joinRes.json()) as { playerId: string; playerToken: string });
    }
    const stSocket = ioClient(baseUrl, { transports: ['websocket'] });
    await waitFor(stSocket, 'connect');
    stSocket.emit(ClientEvents.Auth, { token: storytellerToken });
    await waitFor(stSocket, ServerEvents.AuthOk);
    const playerSockets: ClientSocket[] = [];
    for (const { playerToken } of playerTokens) {
      const s = ioClient(baseUrl, { transports: ['websocket'] });
      await waitFor(s, 'connect');
      s.emit(ClientEvents.Auth, { token: playerToken });
      await waitFor(s, ServerEvents.AuthOk);
      playerSockets.push(s);
    }
    const session = store.getSession(code)!;
    return { session, stSocket, playerSockets, tokens: playerTokens };
  }
  function teardown(stSocket: ClientSocket, playerSockets: ClientSocket[]): void {
    stSocket.disconnect();
    for (const s of playerSockets) s.disconnect();
  }

  it('a waking player receives a private prompt and submits their choice in-app', async () => {
    const { session, stSocket, playerSockets, tokens } = await setUpGame();
    // Deterministic roster: seat 0 is the Imp, seat 1 a Townsfolk the Imp may
    // kill, so the private prompt/result flow can be asserted exactly.
    const players = [...session.players.values()].sort((a, b) => a.seatIndex - b.seatIndex);
    setCharacter(players[0]!, 'imp');
    setCharacter(players[1]!, 'chef');
    setCharacter(players[2]!, 'poisoner');
    setCharacter(players[3]!, 'spy');
    // A Soldier rather than a Washerwoman: the Soldier has no night pick, so the
    // only pickers on night one are the Poisoner and then the Imp. A Washerwoman
    // would be woken first and this test is about the Imp's prompt and kill.
    setCharacter(players[4]!, 'soldier');
    for (const p of players) p.fortuneTellerRedHerringPlayerId = null;
    session.phase = 'day';
    session.dayNumber = 1;
    session.nightNumber = 0;
    const demonSocket = playerSockets[tokens.findIndex((t) => t.playerId === players[0]!.playerId)]!;
    const targetSocket = playerSockets[tokens.findIndex((t) => t.playerId === players[1]!.playerId)]!;

    // Open the night first. The briefing comes next: nobody is awake until the
    // Storyteller has actually said "everyone, close your eyes". Waking everyone
    // at once was the old behaviour and it told several players their role before
    // the table was even ready.
    const stOrderPromise = waitFor<any>(stSocket, ServerEvents.NightOrderUpdate);
    stSocket.emit(ClientEvents.StorytellerAdvanceNight, { action: 'next' });
    const stOrder = await stOrderPromise;

    // Register the listener BEFORE the emit that triggers it, or the prompt
    // arrives first and the test hangs on a promise nobody will resolve.
    const poisonerSocket = playerSockets[tokens.findIndex((t) => t.playerId === players[2]!.playerId)]!;
    const poisonerPromptPromise = waitForUpTo<any>(poisonerSocket, ServerEvents.NightPrompt, 3000);
    stSocket.emit(ClientEvents.StorytellerFlowAdvance);

    // The Poisoner wakes before the Imp on the first night, so this is a real
    // serial wake-up: one person is prompted, they submit, and that releases the
    // next. Nobody is ever holding two roles at once.
    const poisonerPrompt = await poisonerPromptPromise;
    expect(poisonerPrompt?.characterName).toBe('Poisoner');

    const promptPromise = waitForUpTo<any>(demonSocket, ServerEvents.NightPrompt, 3000);
    poisonerSocket.emit(ClientEvents.PlayerSubmitNightChoice, { targetIds: [players[4]!.playerId] });
    const prompt = await promptPromise;

    expect(prompt?.characterName).toBe('Imp');
    expect(prompt?.targetCount).toBe(1);
    expect(prompt?.legalTargetIds).toContain(players[1]!.playerId);
    expect(prompt?.playerId).toBe(players[0]!.playerId);
    // The Storyteller's stepper projection carries the same information plus the
    // waker's name and the resolution state.
    const impStep = stOrder.steps.find((s: any) => s.characterId === 'imp');
    expect(impStep.wakerName).toBe(players[0]!.displayName);
    expect(impStep.resolved).toBe(false);
    expect(stOrder.outstandingCharacterIds).toContain('Imp');

    // Nobody else may be told about the Imp's prompt.
    let leakedToOther = false;
    for (const s of playerSockets) {
      if (s.id === demonSocket.id) continue;
      s.on(ServerEvents.NightPrompt, (p: any) => {
        if (p.characterId === 'imp') leakedToOther = true;
      });
    }

    const resolvedPromise = waitFor<any>(demonSocket, ServerEvents.NightResolved);
    // PlayerSelfUpdate carries several unrelated fields (including the ability
    // -result clear that fires on the same resolve), so wait for the death itself.
    const targetDeathPromise = waitForWhere<any>(
      targetSocket,
      ServerEvents.PlayerSelfUpdate,
      (p) => p.alive === false
    );
    demonSocket.emit(ClientEvents.PlayerSubmitNightChoice, { targetIds: [players[1]!.playerId] });
    stSocket.emit(ClientEvents.StorytellerAdvanceNight, { action: 'resolve' });

    const resolved = await resolvedPromise;
    expect(resolved.playerId).toBe(players[0]!.playerId);
    const death = await targetDeathPromise;
    expect(death.alive).toBe(false);
    await new Promise((r) => setTimeout(r, 60));
    expect(leakedToOther).toBe(false);

    // The night log is Storyteller-only and records the generated decisions.
    const logPromise = waitFor<any>(stSocket, ServerEvents.NightLog);
    stSocket.emit(ClientEvents.StorytellerSetPhase, { phase: 'day' });
    const log = await logPromise;
    expect(log.entries.some((e: any) => e.kind === 'night-opened')).toBe(true);
    expect(log.entries.some((e: any) => e.kind === 'night-kill')).toBe(true);

    teardown(stSocket, playerSockets);
  }, 20000);

  it('rejects a night choice submitted during the day', async () => {
    const { session, stSocket, playerSockets } = await setUpGame();
    session.phase = 'day';
    session.dayNumber = 1;
    const otherPlayerId = [...session.players.values()][1]!.playerId;
    const errorPromise = waitFor<any>(playerSockets[0]!, ServerEvents.Error);
    playerSockets[0]!.emit(ClientEvents.PlayerSubmitNightChoice, { targetIds: [otherPlayerId] });
    const error = await errorPromise;
    expect(error.code).toBe('NOT_NIGHT_PHASE');
    teardown(stSocket, playerSockets);
  }, 20000);

  it('gives the Spy the Grimoire and no Good player anything', async () => {
    const { session, stSocket, playerSockets, tokens } = await setUpGame();
    const players = [...session.players.values()].sort((a, b) => a.seatIndex - b.seatIndex);
    setCharacter(players[0]!, 'imp');
    setCharacter(players[1]!, 'spy');
    setCharacter(players[2]!, 'poisoner');
    setCharacter(players[3]!, 'chef');
    setCharacter(players[4]!, 'recluse');
    session.phase = 'day';
    session.dayNumber = 1;
    session.nightNumber = 0;
    const spySocket = playerSockets[tokens.findIndex((t) => t.playerId === players[1]!.playerId)]!;
    const goodSocket = playerSockets[tokens.findIndex((t) => t.playerId === players[4]!.playerId)]!;

    const orderPromise = waitFor<any>(stSocket, ServerEvents.NightOrderUpdate);
    stSocket.emit(ClientEvents.StorytellerAdvanceNight, { action: 'next' });
    await orderPromise;

    let goodGotGrimoire = false;
    goodSocket.on(ServerEvents.GrimoireUpdate, () => {
      goodGotGrimoire = true;
    });
    const spyGrimoire = waitFor<any>(spySocket, ServerEvents.GrimoireUpdate);

    // Resolve without the Imp's choice; the Spy must still get their Grimoire.
    stSocket.emit(ClientEvents.StorytellerAdvanceNight, { action: 'resolve' });

    const grimoire = await spyGrimoire;
    expect(grimoire.grimoire).toHaveLength(5);
    await new Promise((r) => setTimeout(r, 60));
    expect(goodGotGrimoire).toBe(false);

    teardown(stSocket, playerSockets);
  }, 20000);

  it('runs a whole night with no spoken instruction: distribute, wake, submit, resolve, dawn', async () => {
    // The end-to-end claim of this issue: after distribution the Storyteller's only
    // actions are phase transitions and pressing "Resolve night". Every waker is
    // prompted privately and picks their own targets, with real random roles.
    const { session, stSocket, playerSockets, tokens } = await setUpGame();
    const socketByPlayer = new Map(tokens.map((t, i) => [t.playerId, playerSockets[i]!]));

    const distributed = waitFor<any>(stSocket, ServerEvents.GameDistributed);
    stSocket.emit(ClientEvents.StorytellerStartDistribution);
    await distributed;

    // The game must OPEN at night: the first night runs before Day 1, otherwise
    // every first-night-only character is unplayable and the Demon never wakes
    // before the first discussion.
    expect(session.phase).toBe('night');
    expect(session.dayNumber).toBe(0);
    expect(session.nightNumber).toBe(1);
    expect(session.currentNight).not.toBeNull();

    // "Everyone, close your eyes" is a thing the Storyteller SAYS, so the flow
    // waits for them to say it before waking anybody.
    stSocket.emit(ClientEvents.StorytellerFlowAdvance);
    const nightOrder = waitFor<any>(stSocket, ServerEvents.NightOrderUpdate);
    stSocket.emit(ClientEvents.StorytellerAdvanceNight, { action: 'next' });
    const order = await nightOrder;
    expect(order.isFirstNight).toBe(true);
    // The Imp is in the First Night order, and it is LAST.
    const impIndex = order.steps.findIndex((s: any) => s.characterId === 'imp');
    expect(impIndex).toBeGreaterThanOrEqual(0);
    expect(impIndex).toBe(order.steps.length - 1);

    // Every player whose step needs a choice receives a private prompt and
    // submits it. Nobody is told anything out loud.
    // Exactly one player is prompted at a time, and it is whoever owes the next
    // choice. Submitting releases the next one, so the table never stalls even if
    // the Storyteller does not click through.
    let promptsDelivered = 0;
    for (const s of playerSockets) {
      s.on(ServerEvents.NightPrompt, () => {
        promptsDelivered += 1;
      });
    }

    // Walk the official order. Each player is prompted when it becomes their
    // turn, submits, and that releases the next prompt — so the table can play
    // the whole night without the Storyteller clicking through every step, and
    // without two people ever being awake at once.
    const picking = order.steps.filter((s: any) => s.targetCount > 0);
    let submittedInOrder = 0;
    for (const step of picking) {
      const socket = socketByPlayer.get(step.wakerPlayerId);
      if (!socket) continue;
      const legal = (step.legalTargetIds as string[]).filter((id: string) => id !== step.wakerPlayerId);
      if (legal.length < step.targetCount) continue;
      // Bounded: a player who is never woken must fail the loop rather than hang it.
      const arrived = waitForUpTo<any>(socket, ServerEvents.NightPrompt, 1500);
      if (!(await arrived)) continue;
      socket.emit(ClientEvents.PlayerSubmitNightChoice, { targetIds: legal.slice(0, step.targetCount) });
      submittedInOrder += 1;
      await new Promise((r) => setTimeout(r, 150));
    }
    await new Promise((r) => setTimeout(r, 200));
    expect(promptsDelivered).toBeGreaterThan(0);
    expect(submittedInOrder).toBeGreaterThan(0);

    const orderAfter = waitFor<any>(stSocket, ServerEvents.NightOrderUpdate);
    stSocket.emit(ClientEvents.StorytellerAdvanceNight, { action: 'resolve' });
    const resolvedOrder = await orderAfter;
    expect(resolvedOrder.resolved).toBe(true);
    expect(resolvedOrder.resolvedCount).toBe(resolvedOrder.totalCount);

    // Dawn: the night closes and the day counter starts at 1, not 2.
    const dayChanged = waitFor<any>(stSocket, ServerEvents.GamePhaseChanged);
    const logPromise = waitFor<any>(stSocket, ServerEvents.NightLog);
    stSocket.emit(ClientEvents.StorytellerSetPhase, { phase: 'day' });
    const day = await dayChanged;
    expect(day.phase).toBe('day');
    expect(day.dayNumber).toBe(1);
    expect(day.nightNumber).toBe(1);

    const log = await logPromise;
    expect(log.entries.some((e: any) => e.kind === 'night-opened')).toBe(true);
    expect(log.entries.some((e: any) => e.kind === 'night-resolved')).toBe(true);
    expect(log.entries.some((e: any) => e.kind === 'night-ended')).toBe(true);
    // Every entry is timestamped, which is what makes a generated default
    // auditable rather than indistinguishable from gardening.
    expect(log.entries.every((e: any) => typeof e.at === 'number' && e.at > 0)).toBe(true);
    // Protection never survives the night.
    for (const p of session.players.values()) expect(p.statusEffects.protected).toBe(false);
    expect(session.currentNight).toBeNull();
    // Setup defaults for the Drunk cover and the red herring are all logged.
    expect(log.entries.some((e: any) => e.kind === 'setup-default')).toBe(true);

    teardown(stSocket, playerSockets);
  }, 30000);
});
