import type { Server as SocketIOServer } from 'socket.io';
import { ServerEvents, getCharacterById, type FlowState } from '@clocktower/shared';
import type { GameSession } from '../session/store.js';
import {
  buildNightOrder,
  currentWakeStep,
  findStoredStep,
  stepCountsAsOutstanding,
  wakeGateIsPending,
} from './nightEngine.js';
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
      unmakeableSteps: [],
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
      unmakeableSteps: [],
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
      unmakeableSteps: [],
    };
  }

  const order = buildNightOrder(session);
  const unmakeable = order.filter((s) => (s.targetCount ?? 0) > 0 && !s.isPossible);
  const describeUnmakeable = (s: { characterId: string; unavailableReason: string | null }): {
    characterName: string;
    reason: string;
  } => ({
    characterName: getCharacterById(s.characterId)?.name ?? s.characterId,
    reason: s.unavailableReason ?? 'there is nobody to choose',
  });

  // "Everyone, close your eyes" is an ACTION, not a derivation. It is tracked
  // explicitly so the table stays in the briefing until the Storyteller has
  // actually said it, rather than flipping the instant the night opens. Nobody is
  // woken, and no prompt goes out, until then.
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
      readyToResolve: order.every((s) => (s.targetCount ?? 0) === 0 || !s.isPossible),
      executedPlayerName: null,
      wakeBlockedUntil: null,
      closingPlayerName: null,
      delaySeconds: night.delaySeconds,
      unmakeableSteps: unmakeable.map(describeUnmakeable),
    };
  }

  // `passComplete`, not `resolved`: this branch is the night being OVER, not the
  // night being ready. `resolved` is re-derived from the outstanding steps, so it
  // becomes true the moment the last picker submits — before the Storyteller has
  // pressed resolve — and using it here would announce "it is morning" before
  // anything had happened.
  if (night.passComplete) {
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
      unmakeableSteps: [],
    };
  }

  // The wake walk is driven by ONE explicit cursor (NightState.wakeIndex), not by
  // the Storyteller's stepper. The stepper is presentation; letting it drive the
  // walk is what skipped the Empath and the Chef entirely when the Storyteller
  // clicked through quickly.
  const currentStep = currentWakeStep(session);
  const currentPlayer = currentStep ? session.players.get(currentStep.wakerPlayerId) : undefined;
  const cursorIndex = currentStep ? order.findIndex((s) => s === currentStep) : -1;

  // Who needs a private prompt: only the current waker, and only if they actually
  // have a choice to make. An auto-resolving character has nothing to submit, so
  // prompting them would show a picker with nothing in it — their answer arrives
  // at dawn, when the engine resolves the night.
  const owedWaker =
    currentStep && (currentStep.targetCount ?? 0) > 0 && currentStep.isPossible ? (currentPlayer ?? null) : null;

  // Everything still to be dealt with, by the one shared rule. Auto-resolving and
  // unmakeable steps are excluded, because waiting on them would deadlock.
  const outstanding = order.filter((s) => stepCountsAsOutstanding(session, s));

  // The progress counter and the night-level "resolved" flag are the same
  // statement counted two ways, so they can never disagree. Before this, a night
  // could be flagged resolved while this counter said 3 of 4.
  const resolvedCount = order.length - outstanding.length;

  // AWAITABLE is a different question from OUTSTANDING, and conflating them is
  // what let a night finish early or hang forever:
  //
  // - awaitable: is the Storyteller still holding the night open? An auto-resolving
  //   waker (Empath, Chef) is awaitable even though it has nothing to submit,
  //   because the table still has to be told to pass them. An unmakeable step is
  //   not awaitable, because nobody can ever pass it.
  // - outstanding: can the night finish? Auto-resolving and unmakeable steps are
  //   both excluded, since waiting on them would deadlock.
  const awaitable = order.filter(
    (s) => !findStoredStep(night, s)?.resolved && ((s.targetCount ?? 0) === 0 || s.isPossible)
  );

  const gatePending = wakeGateIsPending(session, now);
  const closingPlayer = gatePending && night.wakeGate ? session.players.get(night.wakeGate.closesPlayerId) : undefined;

  return {
    ...base,
    stage: 'night-step',
    phase: 'night',
    wakeBlockedUntil: gatePending && night.wakeGate ? night.wakeGate.opensAt : null,
    closingPlayerName: closingPlayer?.displayName ?? null,
    delaySeconds: night.delaySeconds,
    // The spoken line names a person. Naming somebody is public in this game —
    // the real table shouts "Bram, wake up" — while their ROLE is not, and the
    // role is not in this string. See the leak guard in shared/protocol/flow.ts.
    announcement: gatePending
      ? `${closingPlayer?.displayName ?? 'Everyone'}, close your eyes.`
      : currentPlayer
        ? `${currentPlayer.displayName}, wake up.`
        : 'Everyone, close your eyes.',
    activePlayerId: currentPlayer?.playerId ?? null,
    activePlayerName: currentPlayer?.displayName ?? null,
    needsChoiceFromPlayerId: owedWaker?.playerId ?? null,
    needsChoiceFromName: owedWaker?.displayName ?? null,
    stepNumber: cursorIndex >= 0 ? cursorIndex + 1 : null,
    totalSteps: order.length,
    resolvedCount,
    // Every picker who CAN choose has chosen, and every auto waker has been passed.
    // Unmakeable steps are excluded: they can never be satisfied, so counting them
    // would mean the night could never be resolved.
    readyToResolve: awaitable.length === 0,
    unmakeableSteps: unmakeable.map((s) => ({
      characterName: getCharacterById(s.characterId)?.name ?? s.characterId,
      reason: s.unavailableReason ?? 'there is nobody to choose',
    })),
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
    unmakeableSteps: [],
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
