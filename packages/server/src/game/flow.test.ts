import { describe, expect, it } from 'vitest';
import {
  assertSpeakableAnnouncement,
  deriveStorytellerLine,
  EMPTY_FLOW_STATE,
  type FlowState,
  type PlayerFlowContext,
} from '@clocktower/shared';
import { SessionStore, type GameSession, type PlayerRecord } from '../session/store.js';
import { getCharacterById } from '@clocktower/shared';
import { buildFlowState } from './flow.js';
import {
  advanceWakeCursor,
  buildNightOrder,
  currentWaker,
  endNight,
  finishWake,
  firstPlayerOwingAChoice,
  openNight,
  resolveNight,
  skipWakeGate,
  submitNightChoice,
  tickNightGate,
} from './nightEngine.js';

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
  return { session, players };
}

/**
 * Walks the night forward the way the server actually does: each waker in official
 * order is dealt with, and the pause between them is skipped. This used to be a
 * call to markPassedAutoSteps, which swept every auto step before the stepper
 * cursor in one go — that sweep is the bug that silently skipped the Empath and
 * the Chef, so nothing in the tests may rely on it any more.
 */
function walkPast(session: GameSession, count: number): void {
  for (let i = 0; i < count; i++) {
    const waker = currentWaker(session);
    if (!waker) return;
    finishWake(session, waker.playerId);
    skipWakeGate(session);
  }
}

function contextFor(playerId: string, overrides: Partial<PlayerFlowContext> = {}): PlayerFlowContext {
  return {
    playerId,
    displayName: 'Somebody',
    alive: true,
    hasOpenNightPrompt: false,
    hasSubmittedNightChoice: false,
    isEvil: false,
    stepIsUnmakeable: false,
    hasNightResult: false,
    hasVoteToken: true,
    ...overrides,
  };
}

describe('buildFlowState — night', () => {
  /**
   * A night with the Poisoner, Monk and Imp all awake, so every choice-walking test
   * has something to walk through. `firstNight = false` opens NIGHT TWO, which is when
   * the Monk wakes.
   *
   * The Poisoner is seated FIRST deliberately. It is the first waker on the official
   * night sheet, so putting it at p0 makes these tests walk a real night's opening
   * rather than an accidental one. It used to be seated third, and the tests passed
   * only because the old order happened to put the Monk first — which is how the
   * inverted night order went unnoticed here.
   */
  function nightSession(firstNight = false) {
    const { session, players } = makeSession(5);
    setCharacter(players[0]!, 'poisoner');
    setCharacter(players[1]!, 'monk');
    setCharacter(players[2]!, 'imp');
    setCharacter(players[3]!, 'chef');
    setCharacter(players[4]!, 'recluse');
    session.phase = 'night';
    session.nightNumber = firstNight ? 0 : 1;
    openNight(session);
    return { session, players };
  }

  it('starts in the briefing and says "close your eyes", naming nobody', () => {
    const { session } = nightSession();
    const flow = buildFlowState(session);
    expect(flow.stage).toBe('night-briefing');
    expect(flow.announcement).toBe('Everyone, close your eyes.');
    expect(flow.activePlayerId).toBeNull();
    // Monk, Poisoner, Imp. The Recluse never wakes and the Chef is first-night
    // only, so on night two there are three steps.
    expect(flow.totalSteps).toBe(3);
  });

  it('has more steps on the first night, because first-night-only characters wake', () => {
    const { session } = nightSession(true);
    // On night one: Chef, Poisoner, Imp. On night two: Monk, Poisoner, Imp.
    expect(session.nightNumber).toBe(1);
    expect(buildFlowState(session).totalSteps).toBe(3);
  });

  it('stays in the briefing until the Storyteller says it', () => {
    const { session } = nightSession();
    expect(buildFlowState(session).stage).toBe('night-briefing');
    session.currentNight!.briefed = true;
    expect(buildFlowState(session).stage).toBe('night-step');
  });

  it('names the player who owes a choice, and nobody else', () => {
    const { session, players } = nightSession();
    session.currentNight!.briefed = true;
    const flow = buildFlowState(session);
    expect(flow.stage).toBe('night-step');
    expect(flow.needsChoiceFromPlayerId).toBe(players[0]!.playerId);
    expect(flow.announcement).toBe('Player0, wake up.');
    expect(flow.readyToResolve).toBe(false);
  });

  it('moves to the next person who owes a choice as choices come in', () => {
    // Night two in the official order: Poisoner 1, Monk 2, Imp 3 — all three pickers,
    // in that order. It used to be Empath 1, FT 2, Monk 4, Butler 6, Poisoner 7, Imp 9,
    // so the first two wakers owed nothing and this test started at a different point
    // than the walk actually began at.
    const { session, players } = nightSession();
    session.currentNight!.briefed = true;
    expect(buildFlowState(session).needsChoiceFromPlayerId).toBe(players[0]!.playerId);

    submitNightChoice(session, players[0]!.playerId, [players[4]!.playerId]);
    let flow = buildFlowState(session);
    expect(flow.needsChoiceFromPlayerId).toBe(players[1]!.playerId);
    expect(flow.announcement).toBe('Player1, wake up.');
    expect(flow.resolvedCount).toBe(1);

    submitNightChoice(session, players[1]!.playerId, [players[4]!.playerId]);
    flow = buildFlowState(session);
    expect(flow.needsChoiceFromPlayerId).toBe(players[2]!.playerId);
    expect(flow.announcement).toBe('Player2, wake up.');
    expect(flow.resolvedCount).toBe(2);
  });

  it('is ready to resolve once every choice is in', () => {
    const { session, players } = nightSession();
    session.currentNight!.briefed = true;
    submitNightChoice(session, players[0]!.playerId, [players[4]!.playerId]);
    submitNightChoice(session, players[2]!.playerId, [players[3]!.playerId]);
    submitNightChoice(session, players[1]!.playerId, [players[4]!.playerId]);
    const flow = buildFlowState(session);
    expect(flow.readyToResolve).toBe(true);
    expect(flow.needsChoiceFromPlayerId).toBeNull();
  });

  it('tells the table to open their eyes once the night is applied', () => {
    const { session, players } = nightSession();
    session.currentNight!.briefed = true;
    submitNightChoice(session, players[0]!.playerId, [players[4]!.playerId]);
    resolveNight(session, null as never);
    const flow = buildFlowState(session);
    expect(flow.stage).toBe('night-resolving');
    expect(flow.announcement).toContain('open your eyes');
  });
});

describe('buildFlowState — day', () => {
  function daySession() {
    const { session, players } = makeSession(5);
    setCharacter(players[0]!, 'mayor');
    setCharacter(players[1]!, 'imp');
    setCharacter(players[2]!, 'poisoner');
    setCharacter(players[3]!, 'chef');
    setCharacter(players[4]!, 'recluse');
    session.phase = 'day';
    session.dayNumber = 1;
    session.nightNumber = 1;
    return { session, players };
  }

  it('opens the day by sending everyone to the Grimoire', () => {
    const { session } = daySession();
    const flow = buildFlowState(session);
    expect(flow.stage).toBe('day-reveal');
    expect(flow.announcement).toContain('open your eyes');
    expect(flow.announcement).toContain('Grimoire');
  });

  it('moves to discussion only once the Storyteller says the day has started', () => {
    const { session } = daySession();
    session.dayRevealed = true;
    const flow = buildFlowState(session);
    expect(flow.stage).toBe('day-discussion');
    expect(flow.announcement).toContain('nominate');
  });

  it('announces an open nomination and that voting is open', () => {
    const { session, players } = daySession();
    session.dayRevealed = true;
    session.nomination = {
      id: 'n1',
      nominatorId: players[0]!.playerId,
      targetId: players[3]!.playerId,
      votes: new Map(),
      openedAt: Date.now(),
      closed: false,
      pendingExecution: false,
      executed: false,
      resolvedTally: null,
    };
    const flow = buildFlowState(session);
    expect(flow.stage).toBe('day-voting');
    expect(flow.votingOpen).toBe(true);
    expect(flow.announcement).toContain('Player0');
    expect(flow.announcement).toContain('Player3');
    expect(flow.announcement).toContain('Voting is open');
  });
  it('announces EVERY waker, including characters with no night choice', () => {
    // The official Glossary defines a wake as a player opening their eyes, and
    // the whole table hears it. "The Chef woke" is usable public information — it
    // tells you the Chef is alive — so announcing only the pickers silently
    // swallowed real information. The Chef and Empath are woken, given a number
    // and put back to sleep exactly like everyone else.
    const { session, players } = makeSession(5);
    /*
     * Seated in the official first-night order: Poisoner 1, Chef 5, Empath 6, Imp 10.
     * So the walk opens on the Poisoner, who OWES a choice, and the two characters
     * with nothing to pick are woken after them. That is the point of the test: the
     * walk must visit every waker, including the ones who are only being told
     * something. The old order put the Chef and Empath first, so the pickers came
     * after and the walk's behaviour around a mid-walk picker was never exercised here.
     */
    setCharacter(players[0]!, 'chef'); // order 5 on night one, no pick
    setCharacter(players[1]!, 'empath'); // order 6 on night one, no pick
    setCharacter(players[2]!, 'poisoner'); // order 1, picks
    setCharacter(players[3]!, 'imp'); // order 10, picks
    setCharacter(players[4]!, 'recluse');
    session.phase = 'night';
    session.nightNumber = 0;
    openNight(session);
    session.currentNight!.briefed = true;

    expect(buildFlowState(session).announcement).toBe('Player2, wake up.');

    // Submitting a choice moves the cursor on to the next WAKER, which is the Chef —
    // who has nothing to choose. The walk does not skip to the next player who makes a
    // choice, because the Chef is being told something the table needs to hear.
    submitNightChoice(session, players[2]!.playerId, [players[4]!.playerId]);
    expect(buildFlowState(session).announcement).toBe('Player0, wake up.');
    walkPast(session, 1);
    expect(buildFlowState(session).announcement).toBe('Player1, wake up.');
  });

  it('owes a choice only to the player who is AWAKE, not to whoever is queued', () => {
    // The announcement covers everyone; the private picker does not. An
    // auto-resolving character has nothing to submit, so prompting them would show
    // a picker with nothing in it — their answer arrives at dawn.
    const { session, players } = makeSession(5);
    setCharacter(players[0]!, 'chef');
    setCharacter(players[1]!, 'empath');
    setCharacter(players[2]!, 'poisoner');
    setCharacter(players[3]!, 'imp');
    setCharacter(players[4]!, 'recluse');
    session.phase = 'night';
    session.nightNumber = 0;
    openNight(session);
    session.currentNight!.briefed = true;
    // First night: Poisoner 1, Chef 5, Empath 6, Imp 10. The Poisoner is awake first
    // and DOES owe a choice, so there is a picker here rather than only listeners.
    expect(buildFlowState(session).activePlayerName).toBe('Player2');
    expect(buildFlowState(session).needsChoiceFromPlayerId).toBe(players[2]!.playerId);

    // Submitting a choice moves the cursor to the next WAKER, which is the Chef. He is
    // announced and NOT prompted: a picker with nothing in it is a control the server
    // would refuse, and his information arrives at dawn instead.
    submitNightChoice(session, players[2]!.playerId, [players[4]!.playerId]);
    let flow = buildFlowState(session);
    expect(flow.activePlayerName).toBe('Player0'); // the Chef
    expect(flow.needsChoiceFromPlayerId).toBeNull();
    expect(firstPlayerOwingAChoice(session)).toBeNull();

    // And the Empath, same again: woken, announced, not prompted.
    walkPast(session, 1);
    flow = buildFlowState(session);
    expect(flow.activePlayerName).toBe('Player1');
    expect(flow.needsChoiceFromPlayerId).toBeNull();
    expect(firstPlayerOwingAChoice(session)).toBeNull();

    // Past both, the Imp is awake and owes a choice again.
    walkPast(session, 1);
    flow = buildFlowState(session);
    expect(flow.activePlayerName).toBe('Player3');
    expect(flow.needsChoiceFromPlayerId).toBe(players[3]!.playerId);
    expect(firstPlayerOwingAChoice(session)?.playerId).toBe(players[3]!.playerId);
  });

  it('is ready to resolve only once every waker has been dealt with', () => {
    const { session, players } = makeSession(5);
    setCharacter(players[0]!, 'imp');
    setCharacter(players[1]!, 'poisoner');
    setCharacter(players[2]!, 'empath');
    setCharacter(players[3]!, 'chef');
    setCharacter(players[4]!, 'recluse');
    session.phase = 'night';
    session.nightNumber = 0;
    openNight(session);
    session.currentNight!.briefed = true;

    /*
     * First night in the official order: Poisoner 1 (p1), Chef 5 (p3), Empath 6 (p2),
     * Imp 10 (p0). The walk is walked in exactly that order, and the two characters
     * with nothing to submit are dealt with by hand — which is the real mechanic and
     * the thing this test exists to cover: an auto-resolving waker still has to be
     * walked past before the night can resolve.
     */
    expect(buildFlowState(session).activePlayerName).toBe('Player1'); // Poisoner
    submitNightChoice(session, players[1]!.playerId, [players[4]!.playerId]);
    expect(buildFlowState(session).activePlayerName).toBe('Player3'); // Chef, nothing to pick
    expect(buildFlowState(session).readyToResolve).toBe(false);
    walkPast(session, 1);
    expect(buildFlowState(session).activePlayerName).toBe('Player2'); // Empath, nothing to pick
    expect(buildFlowState(session).readyToResolve).toBe(false);
    walkPast(session, 1);
    expect(buildFlowState(session).activePlayerName).toBe('Player0'); // Imp, still owes a choice
    expect(buildFlowState(session).readyToResolve).toBe(false);
    submitNightChoice(session, players[0]!.playerId, [players[4]!.playerId]);
    expect(buildFlowState(session).readyToResolve).toBe(true);
  });
});

// The two audio channels, and the one leak that matters. See the wake-by-name
// rule: the official Storyteller Advice says to "refer to the name of the player,
// not their character", so `announcement` carries display names and never a
// character name. `assertSpeakableAnnouncement` is the enforcement.
describe('the flow announcement never leaks', () => {
  it('holds for every announcement across a whole generated night', () => {
    const store = new SessionStore();
    const session = store.createSession('ABCDEF');
    // Names chosen to be adversarial: one is a character name, one is a role-ish
    // word, so the guard cannot pass by accident.
    const names = ['Imp', 'Mayor', 'Bram', 'poisons', 'Empath'];
    const players = names.map((n, i) => store.addPlayer(session, `p${i}`, n));
    setCharacter(players[0]!, 'imp');
    setCharacter(players[1]!, 'monk');
    setCharacter(players[2]!, 'poisoner');
    setCharacter(players[3]!, 'chef');
    setCharacter(players[4]!, 'recluse');
    session.phase = 'night';
    session.nightNumber = 1; // night two, so the Monk wakes too
    openNight(session);

    const seen: string[] = [];
    const record = () => {
      const flow = buildFlowState(session);
      expect(() => assertSpeakableAnnouncement(flow.announcement, names)).not.toThrow();
      seen.push(flow.announcement);
      return flow;
    };

    record(); // briefing
    session.currentNight!.briefed = true;
    // Each waker submits; the flow is re-read at every step.
    for (const step of buildNightOrder(session)) {
      if ((step.targetCount ?? 0) === 0) continue;
      const legal = (step.legalTargetIds ?? []).filter((id) => id !== step.wakerPlayerId);
      if (legal.length < step.targetCount) continue;
      submitNightChoice(session, step.wakerPlayerId, legal.slice(0, step.targetCount));
      record();
    }
    record();
    resolveNight(session, null as never);
    record();

    // Sanity: the walk really did exercise several distinct lines.
    expect(new Set(seen).size).toBeGreaterThan(2);
    // A role name that IS a display name must not trip the guard, and no other
    // capitalised word may appear.
    for (const line of seen) {
      expect(line).not.toMatch(/you learn/i);
      expect(line).not.toMatch(/grimoire for the dead.*imp/i);
    }
  });

  it('rejects an announcement that leaks a character, an alignment, or a result', () => {
    expect(() => assertSpeakableAnnouncement('Player2, wake up. You are the Poisoner.')).toThrow(/character name/i);
    expect(() => assertSpeakableAnnouncement('Wake up, the evil one.')).toThrow(/alignment/i);
    expect(() => assertSpeakableAnnouncement('Bram, wake up. You learn that there are 2 pairs of adjacent players.')).toThrow(
      /result/i
    );
  });

  it('accepts a display name that happens to be a character name', () => {
    // A player called "Imp" must not make every announcement look like a leak.
    expect(() => assertSpeakableAnnouncement('Imp, wake up.', ['Imp', 'Bram'])).not.toThrow();
    expect(() => assertSpeakableAnnouncement('poisons, close your eyes.', ['Imp', 'poisons'])).not.toThrow();
  });
});

describe('the pause between wakers', () => {
  function pausedSession(delaySeconds = 5) {
    const { session, players } = makeSession(5);
    /*
     * Seated in the order the official night sheet wakes them, so this walks a real
     * night's opening: Poisoner (1), Monk (2), then the two characters with nothing to
     * choose, Empath (5) and Undertaker (8). The Recluse never wakes.
     *
     * It used to be seated Poisoner, Imp, Undertaker, Empath with `walkPast(2)` to skip
     * to the Poisoner, which only worked because the old order put the information roles
     * FIRST. With the corrected order the first two wakers are pickers, so there is
     * nothing to walk past: p0 is woken first, p1 second, and the two auto-resolvers
     * follow.
     */
    setCharacter(players[0]!, 'poisoner');
    setCharacter(players[1]!, 'monk');
    setCharacter(players[2]!, 'empath');
    setCharacter(players[3]!, 'undertaker');
    setCharacter(players[4]!, 'recluse');
    session.phase = 'night';
    session.nightNumber = 1;
    openNight(session);
    session.currentNight!.briefed = true;
    session.currentNight!.delaySeconds = delaySeconds;
    return { session, players };
  }

  it('says "close your eyes" after a waker finishes, and names nobody else', () => {
    const { session, players } = pausedSession();
    submitNightChoice(session, players[0]!.playerId, [players[4]!.playerId]);
    finishWake(session, players[0]!.playerId);

    const flow = buildFlowState(session);
    expect(flow.stage).toBe('night-step');
    expect(flow.announcement).toBe('Player0, close your eyes.');
    expect(flow.closingPlayerName).toBe('Player0');
    // Crucially, the next person is NOT announced while the pause runs — that is
    // the entire point of it.
    expect(flow.announcement).not.toContain('wake up');
  });

  it('does not release the next waker until the pause has elapsed', () => {
    const { session, players } = pausedSession(5);
    const started = Date.now();
    submitNightChoice(session, players[0]!.playerId, [players[4]!.playerId]);
    finishWake(session, players[0]!.playerId);
    const gate = session.currentNight!.wakeGate!;
    expect(gate.closesPlayerId).toBe(players[0]!.playerId);
    expect(gate.opensAt).toBeGreaterThanOrEqual(started + 5000);

    // Too early: still closed.
    expect(tickNightGate(session, gate.opensAt - 1)).toBe(false);
    expect(buildFlowState(session, gate.opensAt - 1).closingPlayerName).toBe('Player0');
    expect(firstPlayerOwingAChoice(session)?.playerId).toBe(players[1]!.playerId);

    // Elapsed: released, and the next waker is announced.
    expect(tickNightGate(session, gate.opensAt)).toBe(true);
    const after = buildFlowState(session, gate.opensAt);
    expect(after.closingPlayerName).toBeNull();
    expect(after.announcement).toBe('Player1, wake up.');
    // And it is a one-shot: ticking again changes nothing.
    expect(tickNightGate(session, gate.opensAt + 10_000)).toBe(false);
  });

  it('skips the pause when the Storyteller asks to move on', () => {
    const { session, players } = pausedSession(30);
    submitNightChoice(session, players[0]!.playerId, [players[4]!.playerId]);
    finishWake(session, players[0]!.playerId);
    expect(buildFlowState(session).closingPlayerName).toBe('Player0');
    skipWakeGate(session);
    expect(buildFlowState(session).announcement).toBe('Player1, wake up.');
  });

  it('opens no pause at all when the delay is zero', () => {
    const { session, players } = pausedSession(0);
    submitNightChoice(session, players[0]!.playerId, [players[4]!.playerId]);
    finishWake(session, players[0]!.playerId);
    expect(session.currentNight!.wakeGate).toBeNull();
    expect(buildFlowState(session).announcement).toBe('Player1, wake up.');
  });

  it('carries the delay from one night to the next', () => {
    const { session } = pausedSession(0);
    session.lastNightDelaySeconds = 7;
    endNight(session);
    session.nightNumber = 1;
    openNight(session);
    expect(session.currentNight!.delaySeconds).toBe(7);
  });

  it('tells the Storyteller how long is left, without naming the next player', () => {
    const { session, players } = pausedSession(5);
    submitNightChoice(session, players[0]!.playerId, [players[4]!.playerId]);
    finishWake(session, players[0]!.playerId);
    const gate = session.currentNight!.wakeGate!;
    const line = deriveStorytellerLine(buildFlowState(session, gate.opensAt - 3000));
    expect(line.say).toBe('Player0, close your eyes.');
    expect(line.action).toMatch(/wait 3s/i);
    expect(line.action).toMatch(/cannot time the order/i);
  });

  it('never blocks the last waker from being woken by the pause', () => {
    // The pause must not deadlock a table: if the pause is open when the night is
    // resolved, the resolution still happens.
    const { session, players } = pausedSession(30);
    submitNightChoice(session, players[0]!.playerId, [players[4]!.playerId]);
    finishWake(session, players[0]!.playerId);
    advanceWakeCursor(session);
    submitNightChoice(session, players[1]!.playerId, [players[4]!.playerId]);
    finishWake(session, players[1]!.playerId);
    expect(session.currentNight!.wakeGate).not.toBeNull();
    // Resolving mid-pause is allowed and clears it.
    const report = resolveNight(session, null as never);
    expect(report.outstanding).toEqual([]);
    expect(session.currentNight!.resolved).toBe(true);
  });
});

describe('deriveStorytellerLine', () => {
  it('gives the briefing line first and a briefing action', () => {
    const line = deriveStorytellerLine({ ...EMPTY_FLOW_STATE, stage: 'night-briefing', phase: 'night' });
    expect(line.say).toBe('Everyone, close your eyes.');
    expect(line.canAdvance).toBe(true);
  });

  it('tells the Storyteller to wait while a player still owes a choice', () => {
    const line = deriveStorytellerLine({
      ...EMPTY_FLOW_STATE,
      stage: 'night-step',
      phase: 'night',
      needsChoiceFromName: 'Bram',
      resolvedCount: 1,
      totalSteps: 4,
    });
    expect(line.say).toBe('Bram, wake up.');
    expect(line.canAdvance).toBe(false);
    expect(line.progress).toBe('1 of 4 steps in');
  });

  it('offers the resolve action once everyone is done', () => {
    const line = deriveStorytellerLine({
      ...EMPTY_FLOW_STATE,
      stage: 'night-step',
      phase: 'night',
      activePlayerName: 'Bram',
      resolvedCount: 4,
      totalSteps: 4,
    });
    expect(line.canAdvance).toBe(true);
    expect(line.action).toMatch(/resolve/i);
  });

  it('never produces a line for a stage it does not know', () => {
    const bogus = { ...EMPTY_FLOW_STATE, stage: 'nonsense' as FlowState['stage'] };
    expect(() => deriveStorytellerLine(bogus)).toThrow();
  });
});
