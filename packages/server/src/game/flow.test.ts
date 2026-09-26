import { describe, expect, it } from 'vitest';
import {
  assertSpeakableAnnouncement,
  derivePlayerInstruction,
  deriveStorytellerLine,
  EMPTY_FLOW_STATE,
  type FlowState,
  type PlayerFlowContext,
} from '@clocktower/shared';
import { SessionStore, type GameSession, type PlayerRecord } from '../session/store.js';
import { getCharacterById } from '@clocktower/shared';
import { buildFlowState } from './flow.js';
import {
  buildNightOrder,
  firstPlayerOwingAChoice,
  markPassedAutoSteps,
  openNight,
  resolveNight,
  submitNightChoice,
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

function contextFor(playerId: string, overrides: Partial<PlayerFlowContext> = {}): PlayerFlowContext {
  return {
    playerId,
    alive: true,
    hasOpenNightPrompt: false,
    hasSubmittedNightChoice: false,
    isEvil: false,
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

    // Passing the Chef records that the wake-up happened, so the walk moves to
    // the Empath (order 5) — the next waker — rather than skipping to the next
    // player who happens to make a choice.
    session.currentNight!.activeIndex = 1;
    markPassedAutoSteps(session);
    expect(buildFlowState(session).announcement).toBe('Player3, wake up.');
    session.currentNight!.activeIndex = 2;
    markPassedAutoSteps(session);
    expect(buildFlowState(session).announcement).toBe('Player2, wake up.');
  });

  it('still prompts only the players who actually have a choice to make', () => {
    // The announcement covers everyone; the private picker does not. An
    // auto-resolving character has nothing to submit, so prompting them would
    // show a picker with nothing in it — their answer arrives at dawn.
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
    session.currentNight!.activeIndex = 1;
    markPassedAutoSteps(session);

    const flow = buildFlowState(session);
    // The Empath is the announced waker (first-night order 5, no pick), while the
    // Poisoner is the one who owes a choice (order 8). Two different people, two
    // different jobs, and the announcement must not imply they are the same.
    expect(flow.activePlayerId).toBe(players[3]!.playerId);
    expect(flow.activePlayerName).toBe('Player3');
    expect(flow.needsChoiceFromPlayerId).toBe(players[2]!.playerId);
    expect(firstPlayerOwingAChoice(session)?.playerId).toBe(players[2]!.playerId);
  });

  it('is ready to resolve only once every waker has been dealt with', () => {
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

    // Every step walked past, and the Poisoner submitted.
    session.currentNight!.activeIndex = session.currentNight!.steps.length;
    markPassedAutoSteps(session);
    expect(buildFlowState(session).readyToResolve).toBe(false);
    submitNightChoice(session, players[2]!.playerId, [players[4]!.playerId]);
    submitNightChoice(session, players[1]!.playerId, [players[4]!.playerId]);
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

describe('derivePlayerInstruction', () => {
  const nightStep: FlowState = {
    ...EMPTY_FLOW_STATE,
    stage: 'night-step',
    phase: 'night',
    nightNumber: 1,
    announcement: 'Bram, wake up.',
    activePlayerId: 'p0',
    activePlayerName: 'Bram',
    needsChoiceFromPlayerId: 'p0',
    needsChoiceFromName: 'Bram',
    stepNumber: 1,
    totalSteps: 4,
  };

  it('tells the waker to act and everyone else to sleep', () => {
    const waker = derivePlayerInstruction(nightStep, contextFor('p0', { hasOpenNightPrompt: true }));
    expect(waker.title).toMatch(/awake/i);
    expect(waker.action).toBe('submit-night-choice');
    expect(waker.tone).toBe('action');

    const sleeper = derivePlayerInstruction(nightStep, contextFor('p1'));
    expect(sleeper.title).toMatch(/close your eyes/i);
    expect(sleeper.detail).toContain('Bram');
    expect(sleeper.action).toBe('wait');
    expect(sleeper.tone).toBe('sleep');
  });

  it('never tells a finished player to get up when the cursor is still on them', () => {
    // REGRESSION. `activePlayerId` is the Storyteller's stepper cursor and stays
    // where it was left, so it can point at somebody who has ALREADY submitted
    // while somebody else still owes a choice. Keying "you are awake" off the
    // cursor told the finished player to get up again.
    const cursorStillOnThem: FlowState = {
      ...nightStep,
      activePlayerId: 'p0',
      activePlayerName: 'Bram',
      needsChoiceFromPlayerId: 'p2',
      needsChoiceFromName: 'Cleo',
    };
    const finished = derivePlayerInstruction(
      cursorStillOnThem,
      contextFor('p0', { hasSubmittedNightChoice: true })
    );
    expect(finished.title).toMatch(/close your eyes/i);
    expect(finished.tone).toBe('wait');

    const owed = derivePlayerInstruction(cursorStillOnThem, contextFor('p2', { hasOpenNightPrompt: true }));
    expect(owed.action).toBe('submit-night-choice');

    const bystander = derivePlayerInstruction(cursorStillOnThem, contextFor('p3'));
    expect(bystander.tone).toBe('sleep');
  });

  it('believes the private prompt over the cursor', () => {
    // The server only ever prompts the waker, so an open prompt is ground truth
    // for "this person is awake", even if the flow has not caught up yet.
    const stale: FlowState = { ...nightStep, needsChoiceFromPlayerId: 'p2', needsChoiceFromName: 'Cleo' };
    expect(derivePlayerInstruction(stale, contextFor('p0', { hasOpenNightPrompt: true })).action).toBe(
      'submit-night-choice'
    );
  });

  it('tells a waker who already submitted to wait', () => {
    const waker = derivePlayerInstruction(nightStep, contextFor('p0', { hasSubmittedNightChoice: true }));
    expect(waker.title).toMatch(/close your eyes/i);
    expect(waker.action).toBe('wait');
  });

  it('sends everyone to the Grimoire at dawn', () => {
    const reveal: FlowState = { ...EMPTY_FLOW_STATE, stage: 'day-reveal', phase: 'day', dayNumber: 1 };
    const instruction = derivePlayerInstruction(reveal, contextFor('p0'));
    expect(instruction.title).toMatch(/open your eyes/i);
    expect(instruction.detail).toMatch(/grimoire/i);
    expect(instruction.tone).toBe('talk');
  });

  it('sends living players to discuss and dead players to listen', () => {
    const discuss: FlowState = { ...EMPTY_FLOW_STATE, stage: 'day-discussion', phase: 'day', dayNumber: 2 };
    expect(derivePlayerInstruction(discuss, contextFor('p0')).action).toBe('discuss');
    const dead = derivePlayerInstruction(discuss, contextFor('p0', { alive: false }));
    expect(dead.title).toMatch(/dead/i);
    expect(dead.action).toBe('none');
  });

  it('tells players to vote during an open vote', () => {
    const voting: FlowState = { ...EMPTY_FLOW_STATE, stage: 'day-voting', phase: 'day', dayNumber: 2, votingOpen: true };
    expect(derivePlayerInstruction(voting, contextFor('p0')).action).toBe('vote');
    expect(derivePlayerInstruction(voting, contextFor('p0', { alive: false })).title).toMatch(/one vote/i);
  });

  it('points an Evil player at their private chat', () => {
    const discuss: FlowState = { ...EMPTY_FLOW_STATE, stage: 'day-discussion', phase: 'day', dayNumber: 2 };
    const evil = derivePlayerInstruction(discuss, contextFor('p0', { isEvil: true }));
    expect(evil.detail).toMatch(/evil chat/i);
    expect(evil.detail).toMatch(/nobody else can see it/i);
  });

  it('tells a player to wait before the game starts', () => {
    const instruction = derivePlayerInstruction(EMPTY_FLOW_STATE, contextFor('p0'));
    expect(instruction.action).toBe('wait');
    expect(instruction.tone).toBe('wait');
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
