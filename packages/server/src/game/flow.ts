import type { Server as SocketIOServer } from 'socket.io';
import { ServerEvents, type FlowState } from '@clocktower/shared';
import type { GameSession } from '../session/store.js';
import { buildNightOrder, markPassedAutoSteps } from './nightEngine.js';
import { sendToStoryteller } from './broadcast.js';

/**
 * Builds the public, room-wide flow state.
 *
 * Deriving it from existing session state — rather than storing a stage and
 * keeping it in sync — means the flow cannot drift out of step with the game.
 * There is exactly one source of truth (the session) and this is a pure read of
 * it.
 *
 * WHAT DELIBERATELY IS NOT HERE: any role, alignment, ability result, or
 * Grimoire entry. This object goes to every socket and, on the host device, gets
 * read aloud. See the leak invariant documented in shared/protocol/flow.ts.
 */
export function buildFlowState(session: GameSession, now: number = Date.now()): FlowState {
  const base = {
    dayNumber: session.dayNumber,
    nightNumber: session.nightNumber,
    now,
    nominationId: session.nomination?.id ?? null,
    votingOpen: Boolean(session.nomination && !session.nomination.closed),
    executionPending: Boolean(session.nomination?.pendingExecution),
  };

  if (session.phase === 'lobby') {
    return {
      ...base,
      stage: 'setup',
      phase: 'lobby',
      announcement: 'Roles are being dealt. Nobody is awake yet.',
      activePlayerId: null,
      activePlayerName: null,
      needsChoiceFromPlayerId: null,
      needsChoiceFromName: null,
      stepNumber: null,
      totalSteps: 0,
      resolvedCount: 0,
      readyToResolve: false,
      executedPlayerName: null,
      wakeBlockedUntil: null,
      closingPlayerName: null,
      delaySeconds: 0,
    };
  }

  if (session.phase === 'ended') {
    return {
      ...base,
      stage: 'ended',
      phase: 'ended',
      announcement: 'The game is over.',
      activePlayerId: null,
      activePlayerName: null,
      needsChoiceFromPlayerId: null,
      needsChoiceFromName: null,
      stepNumber: null,
      totalSteps: 0,
      resolvedCount: 0,
      readyToResolve: false,
      executedPlayerName: null,
      wakeBlockedUntil: null,
      closingPlayerName: null,
      delaySeconds: 0,
    };
  }

  if (session.phase === 'night') {
    return buildNightFlow(session, base, now);
  }

  return buildDayFlow(session, base);
}

type FlowBase = Pick<
  FlowState,
  'dayNumber' | 'nightNumber' | 'nominationId' | 'votingOpen' | 'executionPending' | 'now'
>;

function buildNightFlow(session: GameSession, base: FlowBase, now: number): FlowState {
  const night = session.currentNight;

  if (!night) {
    return {
      ...base,
      stage: 'night-briefing',
      phase: 'night',
      announcement: 'Everyone, close your eyes.',
      activePlayerId: null,
      activePlayerName: null,
      needsChoiceFromPlayerId: null,
      needsChoiceFromName: null,
      stepNumber: null,
      totalSteps: 0,
      resolvedCount: 0,
      readyToResolve: true,
      executedPlayerName: null,
      wakeBlockedUntil: null,
      closingPlayerName: null,
      delaySeconds: 0,
    };
  }

  if (night.resolved) {
    return {
      ...base,
      stage: 'night-resolving',
      phase: 'night',
      announcement: 'Everyone, open your eyes. It is morning.',
      activePlayerId: null,
      activePlayerName: null,
      needsChoiceFromPlayerId: null,
      needsChoiceFromName: null,
      stepNumber: null,
      totalSteps: night.steps.length,
      resolvedCount: night.steps.length,
      readyToResolve: false,
      executedPlayerName: null,
      wakeBlockedUntil: null,
      closingPlayerName: null,
      delaySeconds: night.delaySeconds,
    };
  }

  const order = buildNightOrder(session);
  // EVERY waker, not just the ones who make a choice.
  //
  // The official Glossary defines a wake as a player opening their eyes, and the
  // whole table hears their name called. That makes "who woke tonight" usable
  // public information — a Chef who woke is a Chef who is alive — so announcing
  // only the pickers silently swallowed real information. The Chef and the
  // Empath are woken, given a number and put back to sleep exactly like anyone
  // else, and the table is entitled to hear it.
  //
  // A step counts as not-yet-announced until it is resolved. Auto-resolving steps
  // are marked resolved as the Storyteller's cursor walks past them, since there
  // is nothing for their player to do (see markPassedAutoSteps).
  const pending = order.filter((step) => {
    const stored = night.steps.find((s) => s.wakerPlayerId === step.wakerPlayerId && s.characterId === step.characterId);
    return stored && !stored.resolved;
  });

  // The Storyteller's cursor decides who is "up" — that is the person they are
  // talking to, which is exactly what the real game does.
  const cursorIndex = Math.max(0, Math.min(night.activeIndex, Math.max(0, order.length - 1)));
  const cursorStep = order[cursorIndex];
  const cursorWaker = cursorStep ? session.players.get(cursorStep.wakerPlayerId) : undefined;

  // The person to ANNOUNCE is the first waker in official order who has not been
  // dealt with yet, preferring whoever the cursor is on so clicking "next" wakes
  // who the Storyteller clicked on.
  const pickers = pending.filter((s) => (s.targetCount ?? 0) > 0);
  const nextWaker =
    cursorStep && pending.some((s) => s.wakerPlayerId === cursorStep.wakerPlayerId && s.characterId === cursorStep.characterId)
      ? cursorStep
      : pending[0];
  const nextWakerPlayer = nextWaker ? session.players.get(nextWaker.wakerPlayerId) : undefined;

  // Who needs a private prompt: only the pickers. An auto-resolving character has
  // no choice to submit, so prompting them would show a picker with nothing to
  // pick — their answer arrives at dawn, when the engine resolves the night.
  const owed = pickers[0];
  const owedWaker = owed ? session.players.get(owed.wakerPlayerId) : undefined;

  const resolvedCount = night.steps.filter((s) => s.resolved).length;

  // "Everyone, close your eyes" is an ACTION, not a derivation. It is tracked
  // explicitly so the table stays in the briefing until the Storyteller has
  // actually said it, rather than flipping the instant the night opens.
  if (!night.briefed) {
    return {
      ...base,
      stage: 'night-briefing',
      phase: 'night',
      announcement: 'Everyone, close your eyes.',
      activePlayerId: null,
      activePlayerName: null,
      needsChoiceFromPlayerId: null,
      needsChoiceFromName: null,
      stepNumber: null,
      totalSteps: order.length,
      resolvedCount: 0,
      readyToResolve: order.every((step) => (step.targetCount ?? 0) === 0),
      executedPlayerName: null,
      wakeBlockedUntil: null,
      closingPlayerName: null,
      delaySeconds: night.delaySeconds,
    };
  }

  // The pause between consecutive wakers. While it runs, the table is told that
  // the waker who just acted is going back to sleep, and NOBODY is told who is
  // next until it expires — that is the whole point of the pause.
  const gatePending = night.wakeGate !== null && now < night.wakeGate.opensAt;
  const closingPlayer = gatePending ? session.players.get(night.wakeGate!.closesPlayerId) : undefined;

  return {
    ...base,
    stage: 'night-step',
    phase: 'night',
    wakeBlockedUntil: gatePending ? night.wakeGate!.opensAt : null,
    closingPlayerName: closingPlayer?.displayName ?? null,
    delaySeconds: night.delaySeconds,
    // The spoken line names a person. Naming somebody is public in this game —
    // the real table shouts "Bram, wake up" — while their ROLE is not, and the
    // role is not in this string.
    // The spoken line names a person. Naming somebody is public in this game —
    // the real table shouts "Bram, wake up" — while their ROLE is not, and the
    // role is not in this string. See the leak guard in shared/protocol/flow.ts.
    announcement: gatePending
      ? `${closingPlayer!.displayName}, close your eyes.`
      : nextWakerPlayer
        ? `${nextWakerPlayer.displayName}, wake up.`
        : cursorWaker
          ? `${cursorWaker.displayName}, close your eyes.`
          : 'Everyone, close your eyes.',
    activePlayerId: nextWakerPlayer?.playerId ?? cursorWaker?.playerId ?? null,
    activePlayerName: nextWakerPlayer?.displayName ?? cursorWaker?.displayName ?? null,
    needsChoiceFromPlayerId: owedWaker?.playerId ?? null,
    needsChoiceFromName: owedWaker?.displayName ?? null,
    stepNumber: cursorIndex + 1,
    totalSteps: order.length,
    resolvedCount,
    // Everything dealt with: every picker has submitted and every auto waker has been passed.
    readyToResolve: pending.length === 0,
    executedPlayerName: null,
  };
}

function buildDayFlow(session: GameSession, base: FlowBase): FlowState {
  const empty = {
    ...base,
    phase: 'day' as const,
    now: base.now,
    activePlayerId: null,
    activePlayerName: null,
    needsChoiceFromPlayerId: null,
    needsChoiceFromName: null,
    stepNumber: null,
    totalSteps: 0,
    resolvedCount: 0,
    readyToResolve: false,
    wakeBlockedUntil: null,
    closingPlayerName: null,
    delaySeconds: 0,
  };

  if (session.nomination && !session.nomination.closed) {
    const nominator = session.players.get(session.nomination.nominatorId);
    const target = session.players.get(session.nomination.targetId);
    return {
      ...empty,
      stage: 'day-voting',
      announcement: session.nomination.pendingExecution
        ? 'The vote passed. That player is executed.'
        : `${nominator?.displayName ?? 'Someone'} nominated ${target?.displayName ?? 'a player'}. Voting is open.`,
      executedPlayerName: session.nomination.pendingExecution ? (target?.displayName ?? null) : null,
    };
  }

  if (!session.dayRevealed) {
    return {
      ...empty,
      stage: 'day-reveal',
      announcement: 'Everyone, open your eyes. It is day. Check the Grimoire for the dead.',
      executedPlayerName: null,
    };
  }

  return {
    ...empty,
    stage: 'day-discussion',
    announcement: 'Anyone can nominate. Otherwise, discuss.',
    executedPlayerName: null,
  };
}

/** Broadcasts the public flow state to the whole room. Contains no secret data. */
export function broadcastFlow(io: SocketIOServer, session: GameSession): void {
  io.to(`session:${session.code}`).emit(ServerEvents.FlowUpdate, buildFlowState(session));
}

/** Storyteller-only refresh of the flow, used when nothing else changed. */
export function sendFlowToStoryteller(io: SocketIOServer, session: GameSession): void {
  sendToStoryteller(io, session, ServerEvents.FlowUpdate, buildFlowState(session));
}
