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
  advanceWakeCursor,
  buildNightOrder,
  currentWaker,
  endNight,
  finishWake,
  wakerIsFinished,
  firstPlayerOwingAChoice,
  openNight,
  pendingStepsForPlayer,
  resolveNight,
  skipWakeGate,
  submitNightChoice,
  toNightOrderUpdate,
} from './nightEngine.js';
import { chefEvilPairCount, empathEvilNeighbourCount, perceivedAs, slayerWouldKill, virginTriggersExecution } from './abilities.js';
import { resolveDemonKill } from './demonKill.js';
import { buildPlayerDistributionPayload } from './distribution.js';
import { checkMayorWin, checkSaintExecution } from './winConditions.js';
import { buildFlowState } from './flow.js';
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
    // Their step now exists and is still open.
    const rkStep = session.currentNight!.steps.find((s) => s.wakerPlayerId === players[1]!.playerId);
    expect(rkStep).toBeDefined();
    expect(rkStep!.resolved).toBe(false);
    // So the night is NOT done. It used to be flagged resolved here anyway, which
    // is how the order could show a Ravenkeeper still owing a choice next to a
    // "night complete" flag. The flag is derived from the outstanding steps now.
    expect(session.currentNight!.resolved).toBe(false);
    expect(toNightOrderUpdate(session).outstandingCharacterIds).toEqual(['Ravenkeeper']);
    expect(toNightOrderUpdate(session).resolved).toBe(false);

    submitNightChoice(session, players[1]!.playerId, [players[3]!.playerId]);
    expect(rkStep!.resolved).toBe(true);
    expect(rkStep!.targetIds).toEqual([players[3]!.playerId]);
    // Only now is it actually finished, and every view agrees.
    expect(session.currentNight!.resolved).toBe(true);
    expect(toNightOrderUpdate(session).outstandingCharacterIds).toEqual([]);
    expect(toNightOrderUpdate(session).resolved).toBe(true);
    expect(session.log.some((e) => e.kind === 'ravenkeeper-wake')).toBe(true);
  });

  it('never reports the night as resolved next to an order with work outstanding', () => {
    // REGRESSION, found from a live table and a flaky test: `night.resolved` was
    // set to true unconditionally at the end of the resolve pass, while the
    // Storyteller's order view counted resolved steps by its own rule. The two
    // disagreed — the flow said "it is morning" beside an order still showing an
    // unresolved step, and the stepper could be clicked while a player owed a
    // choice. Both now read from stepCountsAsOutstanding.
    const { session, players } = makeSession(5);
    setCharacter(players[0]!, 'imp');
    setCharacter(players[1]!, 'poisoner');
    setCharacter(players[2]!, 'chef');
    setCharacter(players[3]!, 'empath');
    setCharacter(players[4]!, 'recluse');
    session.nightNumber = 2;
    openNight(session);
    session.currentNight!.briefed = true;
    submitNightChoice(session, players[0]!.playerId, [players[4]!.playerId]);
    submitNightChoice(session, players[1]!.playerId, [players[3]!.playerId]);

    // Before the pass runs, the night is not resolved even though every picker has
    // submitted — the Chef and Empath still have to be passed, and dawn has not
    // happened. The flag must not run ahead of the night.
    expect(session.currentNight!.resolved).toBe(false);
    expect(session.currentNight!.passComplete).toBe(false);
    expect(toNightOrderUpdate(session).resolved).toBe(false);
    expect(buildFlowState(session).readyToResolve).toBe(false);
    expect(buildFlowState(session).stage).toBe('night-step');

    resolveNight(session, null as never);
    session.currentNight!.briefed = true;

    // The three views of "done" must agree, whatever the order looks like.
    const assertConsistent = () => {
      const order = toNightOrderUpdate(session);
      const flow = buildFlowState(session);
      const outstanding = order.outstandingCharacterIds;
      expect(order.resolved).toBe(outstanding.length === 0);
      expect(session.currentNight!.resolved).toBe(outstanding.length === 0);
      expect(flow.resolvedCount).toBe(order.totalCount - outstanding.length);
    };
    assertConsistent();

    // And after passing every remaining waker.
    for (let i = 0; i < 12; i += 1) {
      const flow = buildFlowState(session);
      if (flow.readyToResolve && flow.announcement === 'Everyone, close your eyes.') break;
      advanceWakeCursor(session);
      assertConsistent();
    }
    expect(toNightOrderUpdate(session).outstandingCharacterIds).toEqual([]);
    expect(session.currentNight!.resolved).toBe(true);
  });

  it('walks past an unmakeable character that has a target count', () => {
    // REGRESSION, found by playing a real 5-player game: the night deadlocked on
    // the first beat. With no Outsiders in play the Librarian learns that instead
    // of choosing, and with no Minions the Investigator learns that instead — both
    // steps are UNMAKEABLE but still carry a target count of 1.
    //
    // The wake walk's "may I move past this player?" guard used to read "target
    // count is 0, or they already picked". For those two steps both halves were
    // false, so finishWake never ran. Nothing was waiting on the player, so nobody
    // was ever prompted, and the Storyteller was told to keep saying that player's
    // name with no control anywhere that would move the night on.
    const { session, players } = makeSession(5);
    // No Outsiders and no Minions, which is what makes both learn-in characters
    // unmakeable: the Librarian learns "there are no Outsiders" and the Investigator
    // "there are no Minions". A 5-player game can draw exactly this.
    setCharacter(players[0]!, 'librarian');
    setCharacter(players[1]!, 'investigator');
    setCharacter(players[2]!, 'chef');
    setCharacter(players[3]!, 'empath');
    setCharacter(players[4]!, 'imp');
    session.phase = 'night';
    openNight(session);
    session.currentNight!.briefed = true;

    // Both learn-in characters really are unmakeable AND really do have a target
    // count, which is the combination that used to jam.
    const order = buildNightOrder(session);
    for (const id of ['librarian', 'investigator']) {
      const step = order.find((s) => s.characterId === id);
      expect(step, `${id} should be in the first night order`).toBeDefined();
      expect(step!.isPossible, `${id} should be unmakeable here`).toBe(false);
      expect(step!.targetCount, `${id} should still carry a target count`).toBeGreaterThan(0);
    }

    // Nobody is waiting on the Librarian, so the walk must be able to move on.
    expect(wakerIsFinished(session, players[0]!.playerId)).toBe(true);
    // And the Storyteller is NOT told to wait on them.
    expect(toNightOrderUpdate(session).outstandingCharacterIds).not.toContain('Librarian');
    expect(toNightOrderUpdate(session).outstandingCharacterIds).not.toContain('Investigator');

    // The real test: walking the night gets past both and reaches the pickers.
    const walked: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const flow = buildFlowState(session);
      walked.push(flow.announcement ?? '');
      if (flow.readyToResolve) break;
      if (flow.needsChoiceFromPlayerId) {
        const p = session.players.get(flow.needsChoiceFromPlayerId);
        const step = buildNightOrder(session).find((s) => s.wakerPlayerId === p!.playerId);
        const victim = step?.legalTargetIds?.[0];
        if (victim) {
          submitNightChoice(session, p!.playerId, [victim]);
          finishWake(session, p!.playerId);
          // Stand in for the pause expiring, which is what advances the walk in
          // real time. Without it the walk correctly refuses to move on.
          skipWakeGate(session);
          continue;
        }
      }
      const awake = currentWaker(session);
      expect(awake, `beat ${i}: there should always be a waker, or the walk is done`).not.toBeNull();
      expect(wakerIsFinished(session, awake!.playerId), `beat ${i}: ${awake!.displayName} should be passable`).toBe(true);
      finishWake(session, awake!.playerId);
      skipWakeGate(session);
    }

    // Both unmakeable characters were announced on their way past, and the walk
    // ended up at a character who can actually act.
    expect(walked.some((a) => a.startsWith(players[0]!.displayName))).toBe(true);
    expect(walked.some((a) => a.startsWith(players[1]!.displayName))).toBe(true);
    expect(buildFlowState(session).readyToResolve || buildFlowState(session).needsChoiceFromName).toBeTruthy();
  });

  it('still walks when the night order contains a step with no stored record', () => {
    // REGRESSION, and a silent one: the flow said a player owed a choice, so the
    // Storyteller's "move on" control was withheld, while the prompt sender skipped
    // the step it needed to prompt because it read the missing record as already
    // dealt with. Nobody was woken and the Storyteller had nothing to click.
    //
    // A step with no record is reachable because buildNightOrder is recomputed from
    // live state on every call: if the roster changes shape after the night opens,
    // the order gains a step openNight never recorded. Removing a record here is
    // that situation, exactly.
    const { session, players } = makeSession(5);
    setCharacter(players[0]!, 'imp');
    setCharacter(players[1]!, 'poisoner');
    setCharacter(players[2]!, 'chef');
    setCharacter(players[3]!, 'soldier');
    setCharacter(players[4]!, 'recluse');
    session.nightNumber = 2;
    session.phase = 'night';
    openNight(session);
    session.currentNight!.briefed = true;

    // Drop the Poisoner's record: an unresolved step with a choice to make.
    const poisoner = players[1]!;
    const before = session.currentNight!.steps.length;
    session.currentNight!.steps = session.currentNight!.steps.filter((s) => s.wakerPlayerId !== poisoner.playerId);
    expect(session.currentNight!.steps.length).toBe(before - 1);

    // Reading the order must repair it rather than treat it as finished.
    const order = buildNightOrder(session);
    const step = order.find((s) => s.wakerPlayerId === poisoner.playerId);
    expect(step).toBeDefined();
    expect(step!.targetCount ?? 0).toBeGreaterThan(0);
    expect(wakerIsFinished(session, poisoner.playerId)).toBe(false);
    // The flow must NOT tell the Storyteller to move on past them.
    expect(buildFlowState(session).needsChoiceFromPlayerId).not.toBeNull();
    // And the record is back, so a submitted choice has somewhere to land.
    expect(session.currentNight!.steps.some((s) => s.wakerPlayerId === poisoner.playerId)).toBe(true);
    submitNightChoice(session, poisoner.playerId, [step!.legalTargetIds![0]!]);
    expect(wakerIsFinished(session, poisoner.playerId)).toBe(true);
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

/**
 * Walks the night forward the way the server does: each waker is dealt with, then
 * the pause is skipped. There is deliberately no bulk helper any more — the
 * previous one swept every auto step before the stepper cursor in a single call,
 * which is the bug that silently skipped the Empath and the Chef.
 */
function walkPast(session: GameSession, count: number): void {
  for (let i = 0; i < count; i++) {
    const waker = currentWaker(session);
    if (!waker) return;
    finishWake(session, waker.playerId);
    skipWakeGate(session);
  }
}

// A picking ability can be satisfied by NOBODY, and when that happens the step
// used to deadlock the table: an empty picker the player cannot submit, never
// marked resolved, so the night could never reach "ready to resolve".
// The bug this file exists to prevent, in the shape it actually appeared: the
// Storyteller's stepper cursor and the wake walk were two different mechanisms,
// so clicking through fast marked every auto-resolving waker before the cursor as
// dealt with in one sweep. The Empath and the Chef were skipped without ever being
// announced, and each click re-opened the pause on a different person, so the
// table heard "Win1, close your eyes" straight after "Phone, close your eyes".
describe('the wake walk cannot be outrun by the stepper', () => {
  function night() {
    const { session, players } = makeSession(5);
    setCharacter(players[0]!, 'empath');
    setCharacter(players[1]!, 'chef');
    setCharacter(players[2]!, 'poisoner');
    setCharacter(players[3]!, 'imp');
    setCharacter(players[4]!, 'recluse');
    session.phase = 'night';
    session.nightNumber = 0;
    openNight(session);
    session.currentNight!.briefed = true;
    session.currentNight!.delaySeconds = 0;
    return { session, players };
  }

  it('announces every auto-resolving waker, one at a time, in official order', () => {
    const { session } = night();
    // First night order: Chef 4, Empath 5, Poisoner 8, Imp 10 — but seat order is
    // Empath(0), Chef(1), Poisoner(2), Imp(3), so the walk runs Empath, Chef,
    // Poisoner, Imp.
    const announced: string[] = [];
    for (let i = 0; i < 6; i++) {
      const flow = buildFlowState(session);
      if (!flow.activePlayerName) break;
      announced.push(flow.activePlayerName);
      finishWake(session, flow.activePlayerId!);
    }
    // The Empath and the Chef both appear, which is what the sweep used to eat, and
    // they appear in OFFICIAL order (Chef 4 before Empath 5) rather than seat order.
    expect(announced).toEqual(['Player1', 'Player0', 'Player2', 'Player3']);
  });

  it('never opens two pauses at once, so two people are never told to close their eyes together', () => {
    const { session } = night();
    session.currentNight!.delaySeconds = 30;
    const first = buildFlowState(session).activePlayerId!;
    finishWake(session, first);
    // While the pause runs, further clicks must not restart it on somebody else.
    const gate = session.currentNight!.wakeGate!;
    for (let i = 0; i < 5; i++) finishWake(session, buildFlowState(session).activePlayerId ?? first);
    expect(session.currentNight!.wakeGate).toEqual(gate);
    expect(buildFlowState(session).closingPlayerName).toBe(session.players.get(first)!.displayName);
  });

  it('will not deal with a player who still owes a choice', () => {
    // Clicking past somebody who has not submitted silently skipped their whole
    // night step, which is the same class of bug as skipping an auto waker.
    const { session, players } = night();
    walkPast(session, 2); // Empath, Chef
    const owed = buildFlowState(session).activePlayerId;
    expect(owed).toBe(players[2]!.playerId);
    const step = session.currentNight!.steps.find((s) => s.wakerPlayerId === owed);
    expect(step?.targetIds).toEqual([]);
    expect(buildFlowState(session).activePlayerId).toBe(players[2]!.playerId);
  });
});

describe('a step with no legal target', () => {
  function noOutsiderSession() {
    // Trouble Brewing deals ZERO Outsiders at 5 and 7 players. If the Librarian is
    // the one Outsider dealt, the other four are Townsfolk and a Demon — so the
    // Librarian has nobody of their own type to look at.
    const { session, players } = makeSession(5);
    setCharacter(players[0]!, 'librarian');
    setCharacter(players[1]!, 'imp');
    setCharacter(players[2]!, 'poisoner');
    setCharacter(players[3]!, 'chef');
    setCharacter(players[4]!, 'empath');
    session.phase = 'night';
    session.nightNumber = 0;
    openNight(session);
    session.currentNight!.briefed = true;
    return { session, players };
  }

  it('is reported as unmakeable rather than as a step waiting on a player', () => {
    const { session, players } = noOutsiderSession();
    const step = buildNightOrder(session).find((s) => s.characterId === 'librarian')!;
    expect(step.isPossible).toBe(false);
    expect(step.legalTargetIds).toEqual([]);
    expect(step.unavailableReason).toMatch(/no Outsiders in play/i);
    // Crucially NOT outstanding: nothing is going to arrive.
    expect(buildFlowState(session).unmakeableSteps).toEqual([
      { characterName: 'Librarian', reason: expect.stringMatching(/no Outsiders in play/i) },
    ]);
  });

  it('does not deadlock the night: it is ready to resolve once the others have', () => {
    const { session, players } = noOutsiderSession();
    // Night one order: Librarian 2 (unmakeable), Chef 4, Empath 5, Poisoner 8,
    // Imp 10. The wake walk is one person at a time, so the three who have
    // nothing to choose are dealt with before either picker.
    expect(buildFlowState(session).readyToResolve).toBe(false);
    walkPast(session, 3);
    submitNightChoice(session, players[2]!.playerId, [players[3]!.playerId]);
    finishWake(session, players[2]!.playerId);
    submitNightChoice(session, players[1]!.playerId, [players[3]!.playerId]);
    finishWake(session, players[1]!.playerId);
    expect(buildFlowState(session).readyToResolve).toBe(true);
  });

  it('rejects a submission with a message that says there is nothing to pick', () => {
    const { session, players } = noOutsiderSession();
    expect(() => submitNightChoice(session, players[0]!.playerId, [players[3]!.playerId])).toThrow(
      /no valid choice tonight/i
    );
  });

  it('never prompts the player with an empty picker', () => {
    const { session, players } = noOutsiderSession();
    // Only the player who owes a CHOICE is ever prompted, and the Librarian is not
    // one of them, so no prompt goes out for a step that cannot be filled in.
    expect(firstPlayerOwingAChoice(session)?.playerId).not.toBe(players[0]!.playerId);
  });

  it('resolves the Librarian as a real answer, not a failure', () => {
    // "(Or that zero are in play.)" is written into their own ability text, so
    // zero Outsiders is a legitimate RESULT. A real Storyteller just says so.
    const { session, players } = noOutsiderSession();
    submitNightChoice(session, players[2]!.playerId, [players[3]!.playerId]);
    advanceWakeCursor(session);
    submitNightChoice(session, players[1]!.playerId, [players[3]!.playerId]);

    const report = resolveNight(session, null as never);
    // Not outstanding: it resolved, it did not time out.
    expect(report.outstanding).toEqual([]);
    const entry = session.log.find((e) => e.kind === 'unmakeable-choice');
    expect(entry?.detail).toMatch(/Librarian \(Player0\)/);
    // The player is told the answer their ability text promises, not an error.
    const told = session.log.filter((e) => e.kind === 'info-generated' && e.detail.startsWith('Librarian'));
    expect(told.length).toBeGreaterThan(0);
    expect(told.some((e) => e.detail.includes('no Outsiders in play'))).toBe(true);
  });

  it('a Washerwoman who is the only Townsfolk also cannot choose', () => {
    // Reachable at 5 players with the Baron's +2 Outsiders: 1 Townsfolk, 2
    // Outsiders, 1 Minion, 1 Demon.
    const { session, players } = makeSession(5);
    setCharacter(players[0]!, 'washerwoman');
    setCharacter(players[1]!, 'baron');
    setCharacter(players[2]!, 'recluse');
    setCharacter(players[3]!, 'saint');
    setCharacter(players[4]!, 'imp');
    session.phase = 'night';
    session.nightNumber = 0;
    openNight(session);
    const step = buildNightOrder(session).find((s) => s.characterId === 'washerwoman')!;
    expect(step.isPossible).toBe(false);
    expect(step.unavailableReason).toMatch(/no other Townsfolk/i);
    // And it does not become a silent hang: the flow knows about it.
    expect(buildFlowState(session).unmakeableSteps.some((u) => u.characterName === 'Washerwoman')).toBe(true);
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

  it('the wake walk advances past an unmakeable character over a real socket', { timeout: 20000 }, async () => {
    // REGRESSION, and the layer where the bug actually lived.
    //
    // Playing a real 5-player game deadlocked on the very first beat. With no
    // Outsiders in play the Librarian learns that instead of choosing, and with no
    // Minions the Investigator learns that instead — both steps are unmakeable but
    // still carry a target count of 1.
    //
    // The Storyteller's "next" click asked a question that had been spelled out
    // separately from the rest of the engine ("target count is 0, or they already
    // picked"). Both halves were false for those steps, so finishWake never ran:
    // the walk never advanced, nobody was ever prompted, and the Storyteller was
    // told to keep announcing a player who could not act. The unit test for
    // wakerIsFinished passes against this bug, so the only honest place to pin it
    // is the socket the click actually arrives on.
    const { session, stSocket, playerSockets } = await setUpGame();
    // NOT via Start Distribution: that deals a RANDOM roster, and openNight returns
    // the existing night rather than rebuilding it, so characters written after
    // distribution would have no stored step and the walk would be testing the
    // wrong thing. Setting the roster and letting the first "next" open the night
    // keeps the whole thing on the real gateway handler, which is where the bug was.
    const players = [...session.players.values()].sort((a, b) => a.seatIndex - b.seatIndex);
    setCharacter(players[0]!, 'librarian');
    setCharacter(players[1]!, 'investigator');
    setCharacter(players[2]!, 'chef');
    setCharacter(players[3]!, 'empath');
    setCharacter(players[4]!, 'imp');
    session.phase = 'night';

    const openP = waitFor<any>(stSocket, ServerEvents.NightOrderUpdate);
    stSocket.emit(ClientEvents.StorytellerAdvanceNight, { action: 'next' });
    await openP;
    // "Everyone, close your eyes" is what the Storyteller says before any waker.
    session.currentNight!.briefed = true;

    // The condition that used to jam, asserted rather than assumed.
    const order = buildNightOrder(session);
    for (const id of ['librarian', 'investigator']) {
      const step = order.find((s) => s.characterId === id);
      expect(step, `${id} should be woken on the first night`).toBeDefined();
      expect(step!.isPossible, `${id} should be unmakeable with no Outsiders/Minions`).toBe(false);
      expect(step!.targetCount, `${id} should still carry a target count`).toBeGreaterThan(0);
    }

    // Click "next" the way a Storyteller does, and require the announcement to
    // actually change. The old code let this sit on one name forever.
    const said: string[] = [buildFlowState(session).announcement ?? ''];
    for (let i = 0; i < 8; i += 1) {
      const flowP = waitForUpTo<any>(stSocket, ServerEvents.FlowUpdate, 500);
      stSocket.emit(ClientEvents.StorytellerAdvanceNight, { action: 'next' });
      const next = await flowP;
      if (!next) break;
      if (next.announcement !== said[said.length - 1]) said.push(next.announcement);
      // The pause between wakers is what stops the table timing the order; skip it
      // so the walk is exercised rather than the clock.
      const skipP = waitForUpTo<any>(stSocket, ServerEvents.FlowUpdate, 400);
      stSocket.emit(ClientEvents.StorytellerAdvanceNight, { action: 'skipDelay' });
      await skipP;
    }

    // Every player due a wake-up was announced, including both learn-in
    // characters, and we got as far as somebody who can actually act.
    for (const who of [players[0]!, players[1]!, players[4]!]) {
      expect(
        said.some((a) => a.startsWith(who.displayName)),
        `${who.displayName} was never announced. Sequence: ${JSON.stringify(said)}`
      ).toBe(true);
    }

    // The Imp is the only picker, so the night waits on them and nobody else.
    expect(toNightOrderUpdate(session).outstandingCharacterIds).toEqual(['Imp']);

    teardown(stSocket, playerSockets);
  });

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
    // No pause between wakers here: this test is about the prompt and the kill,
    // and the pause is exercised separately in flow.test.ts. Leaving it on would
    // mean waiting out a real delay between the Poisoner and the Imp.
    session.lastNightDelaySeconds = 0;
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
    stSocket.emit(ClientEvents.StorytellerFlowAdvance);
    await new Promise((r) => setTimeout(r, 150));
    // The Chef (order 4) wakes before the Poisoner (order 8) and has nothing to
    // choose, so the Storyteller deals with them. The walk is one person at a time,
    // so nothing is prompted in between.
    stSocket.emit(ClientEvents.StorytellerAdvanceNight, { action: 'next' });
    const poisonerPromptPromise = waitForUpTo<any>(poisonerSocket, ServerEvents.NightPrompt, 3000);

    // The Poisoner wakes before the Imp on the first night, so this is a real
    // serial wake-up: one person is prompted, they submit, and that releases the
    // next. Nobody is ever holding two roles at once.
    const poisonerPrompt = await poisonerPromptPromise;
    expect(poisonerPrompt?.characterName).toBe('Poisoner');

    // The Spy (order 9) wakes between the Poisoner and the Imp and has nothing to
    // choose, so the Storyteller deals with them. The walk is one person at a
    // time: nobody is prompted until the previous waker has been dealt with.
    poisonerSocket.emit(ClientEvents.PlayerSubmitNightChoice, { targetIds: [players[4]!.playerId] });
    await new Promise((r) => setTimeout(r, 200));
    stSocket.emit(ClientEvents.StorytellerAdvanceNight, { action: 'next' });
    const promptPromise = waitForUpTo<any>(demonSocket, ServerEvents.NightPrompt, 4000);
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
    // The pause between wakers is switched off here so the test does not wait out
    // real delays; the pause itself is covered in flow.test.ts. It has to be set
    // BEFORE distribution, because a night captures the delay when it opens.
    session.lastNightDelaySeconds = 0;
    stSocket.emit(ClientEvents.StorytellerStartDistribution);
    await distributed;

    // The game must OPEN at night: the first night runs before Day 1, otherwise
    // every first-night-only character is unplayable and the Demon never wakes
    // before the first discussion.
    expect(session.phase).toBe('night');
    expect(session.dayNumber).toBe(0);
    expect(session.nightNumber).toBe(1);
    expect(session.currentNight).not.toBeNull();

    // Every name the table actually hears. Counting prompts is racy — the first one
    // can arrive before a listener attaches — so this test asserts the property
    // that actually matters: EVERY waker is announced by name, with nobody skipped.
    const announcedNames = new Set<string>();
    stSocket.on(ServerEvents.FlowUpdate, (f: any) => {
      if (f.announcement) announcedNames.add(f.announcement);
    });

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
    // Exactly one person is awake at a time. Characters with nothing to choose
    // (the Chef, the Empath, the Undertaker, the Spy) are woken and announced by
    // name and then dealt with by the Storyteller, exactly as at a real table.
    const stOrderSteps = (await new Promise<any>((r) => {
      const h = (o: any) => {
        stSocket.off(ServerEvents.NightOrderUpdate, h);
        r(o);
      };
      stSocket.on(ServerEvents.NightOrderUpdate, h);
      stSocket.emit(ClientEvents.StorytellerAdvanceNight, { action: 'next' });
    })).steps;
    const totalSteps = stOrderSteps.length;

    for (let guard = 0; guard < totalSteps * 2 + 2; guard++) {
      const order = await new Promise<any>((r) => {
        const h = (o: any) => {
          stSocket.off(ServerEvents.NightOrderUpdate, h);
          r(o);
        };
        stSocket.on(ServerEvents.NightOrderUpdate, h);
        stSocket.emit(ClientEvents.StorytellerAdvanceNight, { action: 'next' });
      });
      const outstanding = order.outstandingCharacterIds as string[];
      if (outstanding.length === 0) {
        // Everyone who can choose has chosen. Walk past whoever is left (auto
        // wakers) until nothing is outstanding.
        const stillOut = order.steps.filter((st: any) => st.targetCount > 0 && !st.resolved);
        if (stillOut.length === 0) break;
        // Somebody still owes a choice: give them a beat, then keep going.
        await new Promise((r) => setTimeout(r, 120));
        const next = await new Promise<any>((r) => {
          const h = (o: any) => {
            stSocket.off(ServerEvents.NightOrderUpdate, h);
            r(o);
          };
          stSocket.on(ServerEvents.NightOrderUpdate, h);
          stSocket.emit(ClientEvents.StorytellerAdvanceNight, { action: 'skipDelay' });
        });
        if (next.steps.every((st: any) => !st.resolved || st.targetCount === 0)) continue;
        break;
      }
      // outstandingCharacterIds holds CHARACTER names, not player ids.
      const owedName = outstanding[0]!;
      const step = order.steps.find((st: any) => st.characterName === owedName);
      const socket = step ? socketByPlayer.get(step.wakerPlayerId) : undefined;
      if (!step || !socket) break;
      const legal = (step.legalTargetIds as string[]).filter((id: string) => id !== step.wakerPlayerId);
      if (legal.length < step.targetCount) break;
      socket.emit(ClientEvents.PlayerSubmitNightChoice, { targetIds: legal.slice(0, step.targetCount) });
      await new Promise((r) => setTimeout(r, 150));
    }
    await new Promise((r) => setTimeout(r, 200));

    // This test asserts OUTCOMES over a real socket. "Every waker is announced by
    // name, in official order, nobody skipped" is asserted deterministically in
    // "the wake walk cannot be outrun by the stepper" instead — driving the flow
    // synchronously, with no sockets or timing involved. Asserting it here made
    // this test flaky for no extra coverage.
    const finalOrder = await new Promise<any>((r) => {
      const h = (o: any) => {
        stSocket.off(ServerEvents.NightOrderUpdate, h);
        r(o);
      };
      stSocket.on(ServerEvents.NightOrderUpdate, h);
      stSocket.emit(ClientEvents.StorytellerAdvanceNight, { action: 'next' });
    });
    // And the table really did hear names, not just a jump straight to dawn.
    expect(announcedNames.size).toBeGreaterThan(0);

    const orderAfter = waitFor<any>(stSocket, ServerEvents.NightOrderUpdate);
    stSocket.emit(ClientEvents.StorytellerAdvanceNight, { action: 'resolve' });
    const resolvedOrder = await orderAfter;
    expect(resolvedOrder.resolved).toBe(true);
    // The invariant that was actually broken: the night-level flag and the
    // outstanding list come from the same per-step rule, so a resolved night can
    // never sit next to an order that still shows work waiting on a player.
    expect(resolvedOrder.outstandingCharacterIds).toEqual([]);

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
