import type { Server as SocketIOServer } from 'socket.io';
import { ServerEvents, type FlowState } from '@clocktower/shared';
import type { GameSession } from '../session/store.js';
import { buildNightOrder, firstPlayerOwingAChoice } from './nightEngine.js';
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
export function buildFlowState(session: GameSession): FlowState {
  const base = {
    dayNumber: session.dayNumber,
    nightNumber: session.nightNumber,
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
    };
  }

  if (session.phase === 'night') {
    return buildNightFlow(session, base);
  }

  return buildDayFlow(session, base);
}

type FlowBase = Pick<
  FlowState,
  'dayNumber' | 'nightNumber' | 'nominationId' | 'votingOpen' | 'executionPending'
>;

function buildNightFlow(session: GameSession, base: FlowBase): FlowState {
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
    };
  }

  const order = buildNightOrder(session);
  const pending = order.filter((step) => {
    const stored = night.steps.find((s) => s.wakerPlayerId === step.wakerPlayerId && s.characterId === step.characterId);
    return (step.targetCount ?? 0) > 0 && stored && !stored.resolved;
  });

  // The Storyteller's cursor decides who is "up" — that is the person they are
  // talking to, which is exactly what the real game does.
  const cursorIndex = Math.max(0, Math.min(night.activeIndex, Math.max(0, order.length - 1)));
  const cursorStep = order[cursorIndex];
  const cursorWaker = cursorStep ? session.players.get(cursorStep.wakerPlayerId) : undefined;

  // Who still owes a choice. When the cursor is already on an unresolved picker,
  // that player is the one to announce.
  // Prefer the person under the Storyteller's cursor when they still owe a
  // choice, so clicking "next" wakes who they clicked on; otherwise fall back to
  // whoever is first in the official order. Either way it is the same
  // computation `sendActiveNightPrompt` uses, so the spoken name and the person
  // holding a prompt on their screen can never be two different people.
  const cursorOwes =
    cursorStep && pending.some((s) => s.wakerPlayerId === cursorStep.wakerPlayerId && s.characterId === cursorStep.characterId)
      ? cursorStep
      : null;
  const owedWaker = cursorOwes
    ? (session.players.get(cursorOwes.wakerPlayerId) ?? null)
    : firstPlayerOwingAChoice(session);

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
    };
  }

  return {
    ...base,
    stage: 'night-step',
    phase: 'night',
    // The spoken line names a person. Naming somebody is public in this game —
    // the real table shouts "Bram, wake up" — while their ROLE is not, and the
    // role is not in this string.
    announcement: owedWaker
      ? `${owedWaker.displayName}, wake up.`
      : cursorWaker
        ? `${cursorWaker.displayName}, close your eyes.`
        : 'Everyone, close your eyes.',
    activePlayerId: cursorWaker?.playerId ?? null,
    activePlayerName: cursorWaker?.displayName ?? null,
    needsChoiceFromPlayerId: owedWaker?.playerId ?? null,
    needsChoiceFromName: owedWaker?.displayName ?? null,
    stepNumber: cursorIndex + 1,
    totalSteps: order.length,
    resolvedCount,
    readyToResolve: pending.length === 0,
    executedPlayerName: null,
  };
}

function buildDayFlow(session: GameSession, base: FlowBase): FlowState {
  const empty = {
    ...base,
    phase: 'day' as const,
    activePlayerId: null,
    activePlayerName: null,
    needsChoiceFromPlayerId: null,
    needsChoiceFromName: null,
    stepNumber: null,
    totalSteps: 0,
    resolvedCount: 0,
    readyToResolve: false,
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
