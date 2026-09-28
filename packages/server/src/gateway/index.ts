import type { Server as SocketIOServer, Socket } from 'socket.io';
import { ZodError } from 'zod';
import {
  AnswerQuestionSchema,
  AskQuestionSchema,
  AuthPayloadSchema,
  ChatSendSchema,
  CloseVoteSchema,
  ConfirmExecutionSchema,
  DemonKillSchema,
  EndGameSchema,
  MarkDeadSchema,
  NominateSchema,
  ServerEvents,
  ClientEvents,
  ReorderSeatsSchema,
  SetPhaseSchema,
  SetPlayerAlignmentSchema,
  SetPlayerStatusSchema,
  SetTimerSchema,
  SetDiscretionOverrideSchema,
  ShareAbilityResultSchema,
  SubmitNightActionSchema,
  VoteSchema,
  MIN_PLAYERS,
  getCharacterById,
  type GameEndReason,
  type QuestionEntryView,
  type WinningTeam,
} from '@clocktower/shared';
import type { SessionStore, GameSession, PlayerRecord, QuestionEntry } from '../session/store.js';
import { reorderSeats } from '../session/store.js';
import { syncEvilRoomMembership, sendEvilHistoryTo, sendEvilMessage, sendOpenHistoryTo, sendOpenMessage } from '../game/chat.js';
import {
  distributeRoles,
  resetDistribution,
  buildPlayerDistributionPayload,
  buildDiscretionLogView,
  setDiscretionOverride,
} from '../game/distribution.js';
import { askQuestion, answerQuestion, resetQuestionQueue } from '../game/questions.js';
import { resolveDemonKill } from '../game/demonKill.js';
import { checkWinCondition, endGame, tryScarletWomanTakeover } from '../game/winConditions.js';
import {
  advanceNightStep,
  buildNightRoster,
  eligibleNightTargets,
  resolveChef,
  resolveEmpath,
  resolveUndertaker,
  startNight,
  submitAssistedNightAction,
} from '../game/nightEngine.js';
import {
  broadcastGrimoire,
  broadcastLobby,
  buildGrimoire,
  sendError,
  sendToPlayer,
  sendToStoryteller,
  sessionRoom,
  STORYTELLER_SOCKET_KEY,
} from '../game/broadcast.js';
import { castVote, closeVote, confirmExecution, nominate, resetForNewDay, toNominationView } from '../game/rules.js';
import { ClocktowerError, Errors } from '../errors.js';
import { resolveAndBind, type AuthenticatedIdentity } from './socketAuth.js';

interface SocketState {
  identity: AuthenticatedIdentity | null;
}

const socketStates = new WeakMap<Socket, SocketState>();

function getState(socket: Socket): SocketState {
  let state = socketStates.get(socket);
  if (!state) {
    state = { identity: null };
    socketStates.set(socket, state);
  }
  return state;
}

function requireAuth(socket: Socket): AuthenticatedIdentity {
  const state = getState(socket);
  if (!state.identity) throw Errors.notAuthenticated();
  return state.identity;
}

function requireStoryteller(socket: Socket): GameSession {
  const identity = requireAuth(socket);
  if (!identity.isStoryteller) throw Errors.notStoryteller();
  return identity.session;
}

function requirePlayer(socket: Socket): { session: GameSession; player: PlayerRecord } {
  const identity = requireAuth(socket);
  if (identity.isStoryteller || !identity.player) throw Errors.notAuthenticated();
  return { session: identity.session, player: identity.player };
}

/** Wraps a handler so any thrown ClocktowerError becomes a scoped `error` event instead of crashing the process. */
function guarded(io: SocketIOServer, socket: Socket, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    if (err instanceof ClocktowerError) {
      sendError(io, socket.id, err.code, err.message);
    } else if (err instanceof ZodError) {
      sendError(io, socket.id, 'VALIDATION_FAILED', "That action wasn't formatted correctly. Please try again.");
    } else {
      console.error('Unexpected gateway error:', err);
      sendError(io, socket.id, 'INTERNAL_ERROR', 'Something went wrong. Please try again.');
    }
  }
}

function broadcastPhaseChanged(io: SocketIOServer, session: GameSession): void {
  io.to(sessionRoom(session.code)).emit(ServerEvents.GamePhaseChanged, {
    phase: session.phase,
    dayNumber: session.dayNumber,
    phaseEndsAt: session.phaseEndsAt,
  });
}

/** Sends the live night roster to the Storyteller only -- it reveals every waking player's true character, same information-hiding rule as the Grimoire. */
function broadcastNightRoster(io: SocketIOServer, session: GameSession): void {
  const roster = buildNightRoster(session);
  if (roster) {
    sendToStoryteller(io, session, ServerEvents.NightRosterUpdate, roster);
  }
}

/**
 * Handles the current wake-order step:
 *  - 'auto'-class characters (Chef, Empath, Undertaker) need no player
 *    choice at all, so their info is composed and delivered immediately,
 *    with no prompt shown, the moment their step becomes current.
 *  - Any character with a nightPrompt (assisted/Imp) gets sent their
 *    private prompt + target picker and waits for PlayerSubmitNightAction.
 *  - Everything else (policy/manual roles with no in-app action, e.g.
 *    Washerwoman, Drunk, Recluse) gets neither -- those stay exactly where
 *    they always were, resolved by the Storyteller's free-text ability
 *    result box / discretion panel.
 */
function sendCurrentNightPrompt(io: SocketIOServer, session: GameSession): void {
  const nightState = session.nightState;
  if (!nightState) return;
  const currentPlayerId = nightState.wakeOrder[nightState.currentStepIndex];
  if (!currentPlayerId) return;
  if (nightState.submissions.has(currentPlayerId) || nightState.results.has(currentPlayerId)) return;

  const player = session.players.get(currentPlayerId);
  const def = player?.character ? getCharacterById(player.character) : undefined;
  if (!player || !def) return;

  if (def.automationClass === 'auto') {
    const resultText = resolveAutoNightInfo(session, player, def.id);
    if (resultText) {
      nightState.results.set(player.playerId, resultText);
      sendToPlayer(io, player, ServerEvents.NightInfoResult, { characterId: def.id, text: resultText });
      broadcastNightRoster(io, session);
    }
    return;
  }

  if (!def.nightPrompt) return;
  sendToPlayer(io, player, ServerEvents.NightPrompt, {
    characterId: def.id,
    characterName: def.name,
    prompt: def.nightPrompt,
    targetCount: def.targetCount ?? 0,
    eligibleTargetIds: eligibleNightTargets(session, currentPlayerId),
  });
}

/** Composes the delivered info text for an 'auto'-class character's step. Returns null for anything not yet wired (there is currently no other auto-class role). */
function resolveAutoNightInfo(session: GameSession, player: PlayerRecord, characterId: string): string | null {
  switch (characterId) {
    case 'chef':
      return resolveChef(session);
    case 'empath':
      return resolveEmpath(session, player.playerId);
    case 'undertaker':
      return resolveUndertaker(session, session.executedTodayCharacterId);
    default:
      return null;
  }
}

function toQuestionView(q: QuestionEntry): QuestionEntryView {
  return {
    questionId: q.id,
    playerId: q.playerId,
    playerName: q.playerName,
    text: q.text,
    answer: q.answer,
    answered: q.answered,
    askedAt: q.askedAt,
  };
}

/**
 * Questions are private: only the Storyteller (full queue, so they can
 * answer in the correct Evil-first order) and the asking player themselves
 * (their own questions only) see them. Other players never see anyone
 * else's question or answer unless that player chooses to repeat it aloud
 * during discussion — that's a conversation the app doesn't need to
 * mediate, so nothing is broadcast to the room.
 */
function sendQuestionQueueUpdates(io: SocketIOServer, session: GameSession): void {
  sendToStoryteller(io, session, ServerEvents.QuestionQueueUpdate, {
    questions: session.questionQueue.map(toQuestionView),
  });
  for (const player of session.players.values()) {
    const own = session.questionQueue.filter((q) => q.playerId === player.playerId).map(toQuestionView);
    sendToPlayer(io, player, ServerEvents.QuestionQueueUpdate, { questions: own });
  }
}

function broadcastGameEnded(io: SocketIOServer, session: GameSession, winner: WinningTeam, reason: GameEndReason): void {
  endGame(session, winner, reason);
  io.to(sessionRoom(session.code)).emit(ServerEvents.GameEnded, { winner, reason });
}

/** Tells the Storyteller only that a Minion has secretly inherited the Demon role. Nobody else is informed by the server — the new Demon keeps playing as whatever they were already claiming to be. */
function sendDemonInherited(
  io: SocketIOServer,
  session: GameSession,
  previousDemonPlayerId: string,
  newDemonPlayerId: string,
  newDemonCharacterId: string
): void {
  sendToStoryteller(io, session, ServerEvents.DemonInherited, {
    previousDemonPlayerId,
    newDemonPlayerId,
    newDemonCharacterId,
  });
}

/**
 * Runs after ANY player death (execution or night kill) that was not
 * itself a resolved Demon self-kill hand-off: applies the Scarlet Woman
 * takeover if applicable, then checks whether the game has ended. Returns
 * true if the game ended (caller should skip further game-state broadcasts
 * beyond the GameEnded event, since the session is now frozen).
 */
function handlePostDeath(
  io: SocketIOServer,
  session: GameSession,
  deadPlayerId: string,
  wasDemon: boolean,
  deathReason: 'executed' | 'self-killed'
): boolean {
  if (wasDemon) {
    const takeover = tryScarletWomanTakeover(session, deadPlayerId);
    if (takeover) {
      sendDemonInherited(
        io,
        session,
        takeover.previousDemonPlayerId,
        takeover.newDemonPlayerId,
        takeover.newDemonCharacterId
      );
      // A legitimate hand-off happened; there IS still a living Demon, so
      // do not run the "no Demon left" win check this round.
      const evilWin = checkWinCondition(session, deathReason);
      if (evilWin && evilWin.winner === 'evil') {
        broadcastGameEnded(io, session, evilWin.winner, evilWin.reason);
        return true;
      }
      return false;
    }
  }

  const result = checkWinCondition(session, deathReason);
  if (result) {
    broadcastGameEnded(io, session, result.winner, result.reason);
    return true;
  }
  return false;
}

function requireGameNotEnded(session: GameSession): void {
  if (session.phase === 'ended') throw Errors.gameAlreadyEnded();
}

function broadcastDistribution(io: SocketIOServer, session: GameSession): void {
  for (const player of session.players.values()) {
    const payload = buildPlayerDistributionPayload(session, player);
    sendToPlayer(io, player, ServerEvents.GameDistributed, payload);
  }
  sendToStoryteller(io, session, ServerEvents.GameDistributed, {
    role: 'storyteller',
    grimoire: buildGrimoire(session),
  });
  syncEvilRoomMembership(io, session);
}

/** Storyteller-only: the auditable log of discretionary hidden-state defaults/overrides (Drunk cover, Fortune Teller red herring). */
function broadcastDiscretionLog(io: SocketIOServer, session: GameSession): void {
  sendToStoryteller(io, session, ServerEvents.DiscretionLogUpdate, { entries: buildDiscretionLogView(session) });
}

export function registerGatewayHandlers(io: SocketIOServer, store: SessionStore): void {
  io.on('connection', (socket) => {
    // Lightweight keep-alive: no auth required, just touches the session
    // (if this socket is already authenticated) so idle-but-open connections
    // don't get recycled by hosting-platform idle timeouts.
    socket.on('ping', () => {
      const identity = getState(socket).identity;
      if (identity) store.touch(identity.session);
    });

    socket.on(ClientEvents.Auth, (raw: unknown) =>
      guarded(io, socket, () => {
        const parsed = AuthPayloadSchema.parse(raw);
        const identity = resolveAndBind(store, socket, parsed.token);
        getState(socket).identity = identity;
        socket.join(sessionRoom(identity.session.code));
        sendOpenHistoryTo(io, socket.id, identity.session);
        if (identity.isStoryteller) {
          io.to(identity.session.code).emit(ServerEvents.StorytellerConnectionStatus, { connected: true });
          broadcastGrimoire(io, identity.session);
          broadcastDiscretionLog(io, identity.session);
          broadcastNightRoster(io, identity.session);
        } else if (identity.player) {
          if (identity.player.alignment === 'evil') {
            syncEvilRoomMembership(io, identity.session);
            sendEvilHistoryTo(io, socket.id, identity.session);
          }
          if (identity.player.character) {
            const payload = buildPlayerDistributionPayload(identity.session, identity.player);
            sendToPlayer(io, identity.player, ServerEvents.GameDistributed, payload);
          }
        }
        socket.emit(ServerEvents.AuthOk, {
          role: identity.isStoryteller ? 'storyteller' : 'player',
          phase: identity.session.phase,
          dayNumber: identity.session.dayNumber,
          phaseEndsAt: identity.session.phaseEndsAt,
          gameResult: identity.session.gameResult,
        });
        if (identity.isStoryteller) {
          socket.emit(ServerEvents.QuestionQueueUpdate, {
            questions: identity.session.questionQueue.map(toQuestionView),
          });
        } else if (identity.player) {
          const own = identity.session.questionQueue
            .filter((q) => q.playerId === identity.player!.playerId)
            .map(toQuestionView);
          socket.emit(ServerEvents.QuestionQueueUpdate, { questions: own });
        }
        broadcastLobby(io, identity.session);
        store.touch(identity.session);
      })
    );

    socket.on(ClientEvents.StorytellerStartDistribution, () =>
      guarded(io, socket, () => {
        const session = requireStoryteller(socket);
        if (session.phase !== 'lobby') throw Errors.distributionAlreadyDone();
        if (session.players.size < MIN_PLAYERS) throw Errors.belowMinPlayers(MIN_PLAYERS);
        distributeRoles(session);
        session.phase = 'day';
        session.dayNumber = 1;
        session.phaseEndsAt = null;
        broadcastDistribution(io, session);
        broadcastDiscretionLog(io, session);
        broadcastPhaseChanged(io, session);
        store.touch(session);
      })
    );

    socket.on(ClientEvents.StorytellerRedistribute, () =>
      guarded(io, socket, () => {
        const session = requireStoryteller(socket);
        if (session.phase !== 'lobby') throw Errors.distributionAlreadyDone();
        resetDistribution(session);
        distributeRoles(session);
        broadcastDistribution(io, session);
        broadcastDiscretionLog(io, session);
        store.touch(session);
      })
    );

    socket.on(ClientEvents.StorytellerSetPhase, (raw: unknown) =>
      guarded(io, socket, () => {
        const session = requireStoryteller(socket);
        const { phase, timerSeconds } = SetPhaseSchema.parse(raw);
        if (session.phase !== 'day' && session.phase !== 'night') throw Errors.invalidPhaseTransition();
        // A redundant transition to the CURRENT phase (double-click, client
        // retry after a dropped ack, etc.) must not re-run resetForNewDay --
        // that would silently drop a pendingExecution nomination and hand
        // everyone a fresh nomination mid-day. Only the timer can be updated.
        if (phase !== session.phase) {
          if (phase === 'day') {
            resetForNewDay(session);
            resetQuestionQueue(session);
            session.dayNumber += 1;
            session.nightState = null;
          } else {
            // Entering night: the game always starts on Day 1, so the first
            // night reached is the one where dayNumber is still 1.
            startNight(session, session.dayNumber === 1);
          }
          session.phase = phase;
        }
        session.phaseEndsAt = timerSeconds ? Date.now() + timerSeconds * 1000 : null;
        broadcastPhaseChanged(io, session);
        broadcastGrimoire(io, session);
        sendQuestionQueueUpdates(io, session);
        broadcastNightRoster(io, session);
        if (session.phase === 'night') sendCurrentNightPrompt(io, session);
        store.touch(session);
      })
    );

    socket.on(ClientEvents.StorytellerSetTimer, (raw: unknown) =>
      guarded(io, socket, () => {
        const session = requireStoryteller(socket);
        const { timerSeconds } = SetTimerSchema.parse(raw);
        session.phaseEndsAt = timerSeconds ? Date.now() + timerSeconds * 1000 : null;
        broadcastPhaseChanged(io, session);
        store.touch(session);
      })
    );

    socket.on(ClientEvents.StorytellerSetPlayerStatus, (raw: unknown) =>
      guarded(io, socket, () => {
        const session = requireStoryteller(socket);
        const { playerId, statusEffects } = SetPlayerStatusSchema.parse(raw);
        const player = session.players.get(playerId);
        if (!player) throw Errors.playerNotFound();
        player.statusEffects = { ...player.statusEffects, ...statusEffects };
        broadcastGrimoire(io, session);
        store.touch(session);
      })
    );

    socket.on(ClientEvents.StorytellerMarkDead, (raw: unknown) =>
      guarded(io, socket, () => {
        const session = requireStoryteller(socket);
        requireGameNotEnded(session);
        const { playerId } = MarkDeadSchema.parse(raw);
        const player = session.players.get(playerId);
        if (!player) throw Errors.playerNotFound();
        const wasDemon = player.characterType === 'demon';
        player.alive = false;
        broadcastGrimoire(io, session);
        broadcastLobby(io, session);
        sendToPlayer(io, player, ServerEvents.PlayerSelfUpdate, { alive: false });
        const ended = handlePostDeath(io, session, playerId, wasDemon, 'executed');
        if (ended) broadcastGrimoire(io, session);
        store.touch(session);
      })
    );

    socket.on(ClientEvents.StorytellerShareAbilityResult, (raw: unknown) =>
      guarded(io, socket, () => {
        const session = requireStoryteller(socket);
        const { playerId, text } = ShareAbilityResultSchema.parse(raw);
        const player = session.players.get(playerId);
        if (!player) throw Errors.playerNotFound();
        sendToPlayer(io, player, ServerEvents.PlayerSelfUpdate, { abilityResult: text });
        store.touch(session);
      })
    );

    socket.on(ClientEvents.StorytellerSetPlayerAlignment, (raw: unknown) =>
      guarded(io, socket, () => {
        const session = requireStoryteller(socket);
        const { playerId, alignment } = SetPlayerAlignmentSchema.parse(raw);
        const player = session.players.get(playerId);
        if (!player) throw Errors.playerNotFound();
        player.alignment = alignment;
        syncEvilRoomMembership(io, session);
        broadcastGrimoire(io, session);
        const payload = player.character ? buildPlayerDistributionPayload(session, player) : null;
        if (payload) sendToPlayer(io, player, ServerEvents.GameDistributed, payload);
        store.touch(session);
      })
    );

    socket.on(ClientEvents.StorytellerSetDiscretionOverride, (raw: unknown) =>
      guarded(io, socket, () => {
        const session = requireStoryteller(socket);
        const { kind, playerId, value } = SetDiscretionOverrideSchema.parse(raw);
        setDiscretionOverride(session, kind, playerId, value);
        broadcastDiscretionLog(io, session);
        if (kind === 'drunk-cover') {
          // The cover character name/ability is what the Drunk's own client
          // displays -- resend their distribution payload so it reflects
          // the new cover immediately, same as any other character change.
          const drunkPlayer = session.players.get(playerId);
          if (drunkPlayer?.character) {
            sendToPlayer(io, drunkPlayer, ServerEvents.GameDistributed, buildPlayerDistributionPayload(session, drunkPlayer));
          }
        }
        store.touch(session);
      })
    );

    socket.on(ClientEvents.StorytellerReorderSeats, (raw: unknown) =>
      guarded(io, socket, () => {
        const session = requireStoryteller(socket);
        const { orderedPlayerIds } = ReorderSeatsSchema.parse(raw);
        reorderSeats(session, orderedPlayerIds);
        broadcastGrimoire(io, session);
        broadcastLobby(io, session);
        store.touch(session);
      })
    );

    socket.on(ClientEvents.PlayerNominate, (raw: unknown) =>
      guarded(io, socket, () => {
        const { session, player } = requirePlayer(socket);
        requireGameNotEnded(session);
        const { targetPlayerId } = NominateSchema.parse(raw);
        const nomination = nominate(session, player.playerId, targetPlayerId);
        io.to(sessionRoom(session.code)).emit(ServerEvents.NominationOpened, toNominationView(session, nomination));
        broadcastLobby(io, session);
        store.touch(session);
      })
    );

    socket.on(ClientEvents.PlayerVote, (raw: unknown) =>
      guarded(io, socket, () => {
        const { session, player } = requirePlayer(socket);
        requireGameNotEnded(session);
        const { nominationId, voting } = VoteSchema.parse(raw);
        const nomination = castVote(session, nominationId, player.playerId, voting);
        io.to(sessionRoom(session.code)).emit(ServerEvents.NominationVoteUpdate, toNominationView(session, nomination));
        store.touch(session);
      })
    );

    socket.on(ClientEvents.StorytellerCloseVote, (raw: unknown) =>
      guarded(io, socket, () => {
        const session = requireStoryteller(socket);
        requireGameNotEnded(session);
        const { nominationId } = CloseVoteSchema.parse(raw);
        const nomination = closeVote(session, nominationId);
        io.to(sessionRoom(session.code)).emit(ServerEvents.NominationClosed, toNominationView(session, nomination));
        store.touch(session);
      })
    );

    socket.on(ClientEvents.StorytellerConfirmExecution, (raw: unknown) =>
      guarded(io, socket, () => {
        const session = requireStoryteller(socket);
        requireGameNotEnded(session);
        const { nominationId } = ConfirmExecutionSchema.parse(raw);
        const result = confirmExecution(session, nominationId);
        io.to(sessionRoom(session.code)).emit(ServerEvents.ExecutionConfirmed, { playerId: result.targetPlayerId });
        broadcastGrimoire(io, session);
        broadcastLobby(io, session);
        handlePostDeath(io, session, result.targetPlayerId, result.wasDemon, 'executed');
        store.touch(session);
      })
    );

    socket.on(ClientEvents.StorytellerDemonKill, (raw: unknown) =>
      guarded(io, socket, () => {
        const session = requireStoryteller(socket);
        requireGameNotEnded(session);
        const { targetPlayerId: killTargetId } = DemonKillSchema.parse(raw);
        // The Storyteller acts on the Demon's behalf, so find the (only)
        // living Demon rather than requiring a specific killer socket.
        const demon = [...session.players.values()].find((p) => p.alive && p.characterType === 'demon');
        if (!demon) throw Errors.notTheDemon();
        const killResult = resolveDemonKill(session, demon.playerId, killTargetId);
        broadcastGrimoire(io, session);
        broadcastLobby(io, session);
        if (!killResult.died) {
          // Monk protection or Soldier immunity blocked the kill entirely --
          // nothing died, so there's nothing further to broadcast.
          store.touch(session);
          return;
        }
        sendToPlayer(io, session.players.get(killResult.targetPlayerId)!, ServerEvents.PlayerSelfUpdate, {
          alive: false,
        });
        if (killResult.inheritance) {
          sendDemonInherited(
            io,
            session,
            killResult.inheritance.previousDemonPlayerId,
            killResult.inheritance.newDemonPlayerId,
            killResult.inheritance.newDemonCharacterId
          );
          const heir = session.players.get(killResult.inheritance.newDemonPlayerId);
          if (heir) {
            const payload = buildPlayerDistributionPayload(session, heir);
            sendToPlayer(io, heir, ServerEvents.GameDistributed, payload);
          }
          // A Minion inherited the Demon role, so "no Demon left" never
          // fires — but the self-kill may still have dropped the living
          // count to 2, which is an independent Evil win condition.
          const livingCountResult = checkWinCondition(session, 'self-killed');
          if (livingCountResult && livingCountResult.winner === 'evil') {
            broadcastGameEnded(io, session, livingCountResult.winner, livingCountResult.reason);
          }
          store.touch(session);
        } else {
          handlePostDeath(io, session, killResult.targetPlayerId, true, 'self-killed');
          store.touch(session);
        }
      })
    );

    socket.on(ClientEvents.StorytellerEndGame, (raw: unknown) =>
      guarded(io, socket, () => {
        const session = requireStoryteller(socket);
        requireGameNotEnded(session);
        const { winner } = EndGameSchema.parse(raw);
        broadcastGameEnded(io, session, winner, 'storyteller-ended');
        store.touch(session);
      })
    );

    socket.on(ClientEvents.ChatEvilSend, (raw: unknown) =>
      guarded(io, socket, () => {
        const { session, player } = requirePlayer(socket);
        const { text } = ChatSendSchema.parse(raw);
        sendEvilMessage(io, session, player.playerId, player.displayName, text);
        store.touch(session);
      })
    );

    socket.on(ClientEvents.ChatOpenSend, (raw: unknown) =>
      guarded(io, socket, () => {
        const identity = requireAuth(socket);
        const { text } = ChatSendSchema.parse(raw);
        const senderId = identity.isStoryteller ? STORYTELLER_SOCKET_KEY : identity.player!.playerId;
        const senderName = identity.isStoryteller ? 'Storyteller' : identity.player!.displayName;
        sendOpenMessage(io, identity.session, senderId, senderName, text);
        store.touch(identity.session);
      })
    );

    socket.on(ClientEvents.PlayerAskQuestion, (raw: unknown) =>
      guarded(io, socket, () => {
        const { session, player } = requirePlayer(socket);
        const { text } = AskQuestionSchema.parse(raw);
        askQuestion(session, player.playerId, text);
        sendQuestionQueueUpdates(io, session);
        store.touch(session);
      })
    );

    socket.on(ClientEvents.PlayerSubmitNightAction, (raw: unknown) =>
      guarded(io, socket, () => {
        const { session, player } = requirePlayer(socket);
        if (session.phase !== 'night' || !session.nightState) throw Errors.notNightPhase();
        const nightState = session.nightState;
        const currentPlayerId = nightState.wakeOrder[nightState.currentStepIndex];
        if (currentPlayerId !== player.playerId) throw Errors.notYourNightAction();
        if (nightState.submissions.has(player.playerId) || nightState.results.has(player.playerId)) {
          throw Errors.nightActionAlreadySubmitted();
        }

        const { targetPlayerIds } = SubmitNightActionSchema.parse(raw);
        const def = player.character ? getCharacterById(player.character) : undefined;
        if (!def) throw Errors.playerNotFound();

        nightState.submissions.set(player.playerId, {
          characterId: def.id,
          targetPlayerIds,
          submittedAt: Date.now(),
        });

        // The Imp's kill has its own dedicated event/handler (StorytellerDemonKill)
        // with its own broadcast/win-check/inheritance side effects, so a
        // submission here just records intent for the Storyteller's roster;
        // it does not resolve the kill itself.
        if (def.automationClass === 'assisted' && def.id !== 'imp') {
          const result = submitAssistedNightAction(session, player.playerId, targetPlayerIds);
          if (result.resultText) {
            nightState.results.set(player.playerId, result.resultText);
            sendToPlayer(io, player, ServerEvents.NightInfoResult, { characterId: def.id, text: result.resultText });
          }
          broadcastGrimoire(io, session);
        }

        broadcastNightRoster(io, session);
        store.touch(session);
      })
    );

    socket.on(ClientEvents.StorytellerAdvanceNightStep, () =>
      guarded(io, socket, () => {
        const session = requireStoryteller(socket);
        if (session.phase !== 'night' || !session.nightState) throw Errors.notNightPhase();
        advanceNightStep(session);
        broadcastNightRoster(io, session);
        sendCurrentNightPrompt(io, session);
        store.touch(session);
      })
    );

    socket.on(ClientEvents.StorytellerAnswerQuestion, (raw: unknown) =>
      guarded(io, socket, () => {
        const session = requireStoryteller(socket);
        const { questionId, answer } = AnswerQuestionSchema.parse(raw);
        answerQuestion(session, questionId, answer);
        sendQuestionQueueUpdates(io, session);
        store.touch(session);
      })
    );

    socket.on('disconnect', () => {
      const state = getState(socket);
      const identity = state.identity;
      if (!identity) return;
      // Only clear the connection if THIS socket is still the current one for
      // that identity. A page refresh authenticates a new socket before the
      // old socket's disconnect event fires; without this check, the stale
      // disconnect would wipe out the new (already-reconnected) connection
      // id and everyone would see the player as disconnected even though
      // they're actually online.
      if (identity.isStoryteller) {
        if (identity.session.storytellerConnectionId === socket.id) {
          identity.session.storytellerConnectionId = null;
          io.to(sessionRoom(identity.session.code)).emit(ServerEvents.StorytellerConnectionStatus, { connected: false });
        }
      } else if (identity.player) {
        if (identity.player.connectionId === socket.id) {
          identity.player.connectionId = null;
          identity.player.disconnectedAt = Date.now();
          broadcastLobby(io, identity.session);
        }
      }
    });
  });
}
