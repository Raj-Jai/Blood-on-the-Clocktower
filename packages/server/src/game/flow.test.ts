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
    alive: true,
    hasOpenNightPrompt: false,
    hasSubmittedNightChoice: false,
    isEvil: false,
    stepIsUnmakeable: false,
    ...overrides,
  };
}

describe('buildFlowState — night', () => {
  /**
   * A night with the Monk, Poisoner and Imp all awake, so every choice-walking
   * test has something to walk through. `firstNight = false` opens NIGHT TWO,
   * which is when the Monk wakes.
   */
  function nightSession(firstNight = false) {
    const { session, players } = makeSession(5);
    setCharacter(players[0]!, 'monk');
    setCharacter(players[1]!, 'imp');
    setCharacter(players[2]!, 'poisoner');
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
    const { session, players } = nightSession();
    session.currentNight!.briefed = true;
    submitNightChoice(session, players[0]!.playerId, [players[4]!.playerId]);
    const flow = buildFlowState(session);
    expect(flow.needsChoiceFromPlayerId).toBe(players[2]!.playerId);
    expect(flow.announcement).toBe('Player2, wake up.');
    expect(flow.resolvedCount).toBe(1);
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
    setCharacter(players[0]!, 'chef'); // 4 on night one, no pick
    setCharacter(players[1]!, 'imp');
    setCharacter(players[2]!, 'poisoner');
    setCharacter(players[3]!, 'empath'); // 5 on night one, no pick
    setCharacter(players[4]!, 'recluse');
    session.phase = 'night';
    session.nightNumber = 0;
    openNight(session);
    session.currentNight!.briefed = true;

    expect(buildFlowState(session).announcement).toBe('Player0, wake up.');

    // The Chef has nothing to choose, so the Storyteller deals with them and the
    // walk moves to the Empath (order 5) — the next waker — rather than skipping
    // to the next player who happens to make a choice.
    walkPast(session, 1);
    expect(buildFlowState(session).announcement).toBe('Player3, wake up.');
    walkPast(session, 1);
    expect(buildFlowState(session).announcement).toBe('Player2, wake up.');
  });

  it('owes a choice only to the player who is AWAKE, not to whoever is queued', () => {
    // The announcement covers everyone; the private picker does not. An
    // auto-resolving character has nothing to submit, so prompting them would show
    // a picker with nothing in it — their answer arrives at dawn.
    const { session, players } = makeSession(5);
    setCharacter(players[0]!, 'chef');
    setCharacter(players[1]!, 'imp');
    setCharacter(players[2]!, 'poisoner');
    setCharacter(players[3]!, 'empath');
    setCharacter(players[4]!, 'recluse');
    session.phase = 'night';
    session.nightNumber = 0;
    openNight(session);
    session.currentNight!.briefed = true;
    // First night order: Chef 4, Empath 5, Poisoner 8, Imp 10.
    expect(buildFlowState(session).activePlayerName).toBe('Player0');
    expect(buildFlowState(session).needsChoiceFromPlayerId).toBeNull();

    // The Chef is dealt with; the Empath is now awake and still owes nothing.
    walkPast(session, 1);
    const flow = buildFlowState(session);
    expect(flow.activePlayerName).toBe('Player3');
    expect(flow.needsChoiceFromPlayerId).toBeNull();
    expect(firstPlayerOwingAChoice(session)).toBeNull();

    // Deal with the Empath and the Poisoner becomes the one who owes a choice.
    walkPast(session, 1);
    expect(buildFlowState(session).activePlayerName).toBe('Player2');
    expect(buildFlowState(session).needsChoiceFromPlayerId).toBe(players[2]!.playerId);
    expect(firstPlayerOwingAChoice(session)?.playerId).toBe(players[2]!.playerId);
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

    // First night: Chef 4, Empath 5, Poisoner 8, Imp 10.
    walkPast(session, 2); // Chef, Empath
    expect(buildFlowState(session).readyToResolve).toBe(false);
    submitNightChoice(session, players[1]!.playerId, [players[4]!.playerId]);
    finishWake(session, players[1]!.playerId);
    expect(buildFlowState(session).readyToResolve).toBe(false); // the Imp is still awake
    submitNightChoice(session, players[0]!.playerId, [players[4]!.playerId]);
    finishWake(session, players[0]!.playerId);
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
    // Two auto-resolving wakers that actually wake on night two (Empath, order 1,
    // and Undertaker, order 3) so there is something to walk past before the
    // Poisoner at order 7. The Chef would NOT do here — it is first night only.
    setCharacter(players[0]!, 'poisoner');
    setCharacter(players[1]!, 'imp');
    setCharacter(players[2]!, 'undertaker');
    setCharacter(players[3]!, 'empath');
    setCharacter(players[4]!, 'recluse');
    session.phase = 'night';
    session.nightNumber = 1;
    openNight(session);
    session.currentNight!.briefed = true;
    session.currentNight!.delaySeconds = delaySeconds;
    // Deal with the Empath and the Chef, who wake before the Poisoner and have
    // nothing to choose. Without this the Poisoner could never be reached.
    walkPast(session, 2);
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
