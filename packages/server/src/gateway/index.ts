import type { Server as SocketIOServer, Socket } from 'socket.io';
import { ZodError } from 'zod';
import {
  AdvanceNightSchema,
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
  SetDiscretionSchema,
  SetPhaseSchema,
  SetPlayerAlignmentSchema,
  SetPlayerStatusSchema,
  SetTimerSchema,
  ShareAbilityResultSchema,
  SubmitNightChoiceSchema,
  VoteSchema,
  MIN_PLAYERS,
  charactersByType,
  type GameEndReason,
  type QuestionEntryView,
  type WinningTeam,
} from '@clocktower/shared';
import type { SessionStore, GameSession, PlayerRecord, QuestionEntry } from '../session/store.js';
import { logNightEvent, reorderSeats } from '../session/store.js';
import { syncEvilRoomMembership, sendEvilHistoryTo, sendEvilMessage, sendOpenHistoryTo, sendOpenMessage } from '../game/chat.js';
import { distributeRoles, resetDistribution, buildPlayerDistributionPayload } from '../game/distribution.js';
import { askQuestion, answerQuestion, resetQuestionQueue } from '../game/questions.js';
import { resolveDemonKill } from '../game/demonKill.js';
import { checkMayorWin, checkSaintExecution, checkWinCondition, endGame, tryScarletWomanTakeover } from '../game/winConditions.js';
import { broadcastFlow, buildFlowState } from '../game/flow.js';
import {
  endNight,
  openNight,
  resolveNight,
  sendNightLog,
  sendNightOrder,
  sendActiveNightPrompt,
  submitNightChoice,
} from '../game/nightEngine.js';
import { broadcastGrimoire, broadcastLobby, buildGrimoire, sendError, sendToPlayer, sendToStoryteller, sessionRoom, STORYTELLER_SOCKET_KEY } from '../game/broadcast.js';
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
    nightNumber: session.nightNumber,
    phaseEndsAt: session.phaseEndsAt,
  });
}

/** Storyteller-only night state: the stepper projection and the audit log. */
function sendNightState(io: SocketIOServer, session: GameSession): void {
  sendNightOrder(io, session);
  sendNightLog(io, session);
}

/**
 * Clears every player's free-text ability result.
 *
 * The result is a per-player private string that used to be set once and then
 * pinned forever: `useSession` merged it with `payload.abilityResult ?? s.abilityResult`,
 * so Night 1's answer stayed on the Character tab for the rest of the game,
 * indistinguishable from tonight's. On a shared screen that is a serious accidental
 * leak, and it is cleared at both ends of the night now.
 */
function clearAbilityResults(io: SocketIOServer, session: GameSession): void {
  for (const player of session.players.values()) {
    sendToPlayer(io, player, ServerEvents.PlayerSelfUpdate, { abilityResult: null });
  }
}

/** Every Storyteller override is logged too: a hidden state that is never audited is indistinguishable from gardening. */
function logDiscretion(session: GameSession, detail: string): void {
  logNightEvent(session, 'discretion', detail);
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
  broadcastFlow(io, session);
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
  deathReason: 'executed' | 'night-kill' | 'self-killed'
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
      const evilWin = checkWinCondition(session, deathReason === 'executed' ? 'executed' : 'self-killed');
      if (evilWin && evilWin.winner === 'evil') {
        broadcastGameEnded(io, session, evilWin.winner, evilWin.reason);
        return true;
      }
      return false;
    }
  }

  const result = checkWinCondition(session, deathReason === 'executed' ? 'executed' : 'self-killed');
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
        // The game opens at NIGHT, not day. Every first-night-only character
        // (Washerwoman, Librarian, Investigator, Chef, Drunk, Poisoner, Spy, and
        // the Imp) has to be woken before the first discussion, or the setup is
        // broken and half the script is unplayable. dayNumber stays 0 until the
        // Storyteller ends the night, which is what makes the first day "Day 1".
        session.dayNumber = 0;
        session.nightNumber = 0;
        session.phase = 'night';
        session.phaseEndsAt = null;
        openNight(session);
        broadcastDistribution(io, session);
        broadcastPhaseChanged(io, session);
        sendNightState(io, session);
        sendActiveNightPrompt(io, session);
        broadcastFlow(io, session);
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
        store.touch(session);
      })
    );

    socket.on(ClientEvents.StorytellerSetPhase, (raw: unknown) =>
      guarded(io, socket, () => {
        const session = requireStoryteller(socket);
        const { phase, timerSeconds } = SetPhaseSchema.parse(raw);
        if (session.phase !== 'day' && session.phase !== 'night') throw Errors.invalidPhaseTransition();
        if (phase === session.phase) throw Errors.invalidPhaseTransition();

        if (phase === 'day') {
          // Dawn. Close out the night first (protection expires, the night is
          // logged), then reset the day-scoped state.
          endNight(session);
          resetForNewDay(session);
          resetQuestionQueue(session);
          // The first night runs BEFORE Day 1, so dayNumber is still 0 when the
          // Storyteller ends it. Incrementing from 0 would label the first day
          // "Day 2".
          session.dayNumber = session.dayNumber === 0 ? 1 : session.dayNumber + 1;
          session.dayRevealed = false;
        } else {
          // Dusk. Opens the night: increments the night number, expires yesterday's
          // poison, re-arms the Soldier, and prompts every waker privately.
          openNight(session);
        }

        session.phase = phase;
        session.phaseEndsAt = timerSeconds ? Date.now() + timerSeconds * 1000 : null;
        broadcastPhaseChanged(io, session);
        broadcastGrimoire(io, session);
        sendQuestionQueueUpdates(io, session);
        sendNightState(io, session);
        broadcastFlow(io, session);
        if (phase === 'night') {
          sendActiveNightPrompt(io, session);
          // Waking players must not be left holding last night's private result.
          clearAbilityResults(io, session);
        }

        // The Mayor's win is checked as the day starts, when "no execution has
        // occurred today" is true by definition.
        if (phase === 'day') {
          const mayorWin = checkMayorWin(session);
          if (mayorWin) {
            broadcastGameEnded(io, session, mayorWin.winner, mayorWin.reason);
            return;
          }
        }
        store.touch(session);
      })
    );

    socket.on(ClientEvents.StorytellerAdvanceNight, (raw: unknown) =>
      guarded(io, socket, () => {
        const session = requireStoryteller(socket);
        const { action, stepIndex } = AdvanceNightSchema.parse(raw);
        const night = openNight(session);
        if (session.phase !== 'night') {
          session.phase = 'night';
          broadcastPhaseChanged(io, session);
        }

        if (action === 'resolve') {
          const report = resolveNight(session, io);
          // Everyone learns the result of the night, as a public event.
          broadcastGrimoire(io, session);
          broadcastLobby(io, session);
          // Waking players must not still be holding last night's private result.
          clearAbilityResults(io, session);
          for (const deadId of report.killedPlayerIds) {
            const dead = session.players.get(deadId);
            if (dead) sendToPlayer(io, dead, ServerEvents.PlayerSelfUpdate, { alive: false });
          }
          if (report.inheritance) {
            sendDemonInherited(
              io,
              session,
              report.inheritance.previousDemonPlayerId,
              report.inheritance.newDemonPlayerId,
              report.inheritance.newDemonCharacterId
            );
          }
          for (const deadId of report.killedPlayerIds) {
            const dead = session.players.get(deadId);
            if (!dead) continue;
            // The Scarlet Woman only inherits when the Demon dies with NO Minion
            // already promoted. When a hand-off already happened there is a living
            // Demon, and letting a second one be created would be wrong.
            const wasDemon = dead.characterType === 'demon' && report.inheritance === null;
            handlePostDeath(io, session, deadId, wasDemon, report.inheritance ? 'self-killed' : 'night-kill');
          }
          sendNightState(io, session);
          broadcastFlow(io, session);
          store.touch(session);
          return;
        }

        if (action === 'next') night.activeIndex += 1;
        else if (action === 'previous') night.activeIndex -= 1;
        else if (action === 'goto' && stepIndex !== undefined) night.activeIndex = stepIndex;
        const last = Math.max(0, night.steps.length - 1);
        night.activeIndex = Math.max(0, Math.min(night.activeIndex, last));
        // Opening a night has to actually wake people: the prompt is the whole
        // point of the engine, so stepping into a night sends it here too rather
        // than only on the phase change.
        sendActiveNightPrompt(io, session);
        sendNightState(io, session);
        broadcastFlow(io, session);
        store.touch(session);
      })
    );

    socket.on(ClientEvents.PlayerSubmitNightChoice, (raw: unknown) =>
      guarded(io, socket, () => {
        const { session, player } = requirePlayer(socket);
        requireGameNotEnded(session);
        if (session.phase !== 'night') throw Errors.notNightPhase();
        const { targetIds } = SubmitNightChoiceSchema.parse(raw);
        // The waker identity is read from the step inside submitNightChoice, so a
        // player cannot submit on someone else's behalf even if they try.
        submitNightChoice(session, player.playerId, targetIds, io);
        // Releasing the next waker here is what stops the table stalling: once a
        // player has acted, whoever owes the next choice is prompted without the
        // Storyteller having to click through the order.
        sendActiveNightPrompt(io, session);
        sendNightState(io, session);
        broadcastFlow(io, session);
        store.touch(session);
      })
    );

    socket.on(ClientEvents.StorytellerFlowAdvance, () =>
      guarded(io, socket, () => {
        const session = requireStoryteller(socket);
        const flow = buildFlowState(session);
        // Two transitions are the Storyteller's to make by hand, because both are
        // things they SAY rather than things the server can observe:
        //   "everyone, close your eyes"  and  "everyone, open your eyes, it is day".
        if (flow.stage === 'night-briefing' && session.currentNight) {
          session.currentNight.briefed = true;
          // Start on the first step that owes a choice, so the first wake-up line
          // names somebody rather than a random cursor position.
          sendNightState(io, session);
          // Saying "everyone, close your eyes" is what ends the briefing, and it
          // is what wakes the first player. Without this the night opened and
          // nobody was ever prompted.
          sendActiveNightPrompt(io, session);
          broadcastFlow(io, session);
          store.touch(session);
          return;
        }
        if (flow.stage === 'day-reveal') {
          session.dayRevealed = true;
          broadcastFlow(io, session);
          store.touch(session);
          return;
        }
        // Everything else moves on its own (phase changes, resolutions, votes), so
        // pressing advance there would be a no-op with no honest meaning.
        throw Errors.flowNotAdvanceable();
      })
    );

    socket.on(ClientEvents.StorytellerSetDiscretion, (raw: unknown) =>
      guarded(io, socket, () => {
        const session = requireStoryteller(socket);
        const payload = SetDiscretionSchema.parse(raw);

        if (payload.impHeirPlayerId !== undefined) {
          const heir = session.players.get(payload.impHeirPlayerId);
          if (!heir) throw Errors.playerNotFound();
          session.impHeirChoice = { nightNumber: session.nightNumber, playerId: heir.playerId };
          logDiscretion(session, `Imp self-kill heir set to ${heir.displayName} for Night ${session.nightNumber}.`);
        }
        if (payload.drunkCoverPlayerId !== undefined) {
          const drunk = [...session.players.values()].find((p) => p.character === 'drunk');
          if (!drunk) throw Errors.playerNotFound();
          const pool = charactersByType('townsfolk');
          const unused = pool.filter((c) => {
            const inPlay = new Set([...session.players.values()].map((p) => p.character));
            return !inPlay.has(c.id) || c.id === drunk.character;
          });
          const cover = unused[0] ?? pool[0]!;
          drunk.drunkCoverCharacterId = cover.id;
          logDiscretion(
            session,
            `${drunk.displayName}'s Drunk cover is now the ${cover.name}. (The cover is drawn from Townsfolk not in play.)`
          );
          // The Drunk's own client must be re-projected, or they keep the old cover.
          sendToPlayer(io, drunk, ServerEvents.GameDistributed, buildPlayerDistributionPayload(session, drunk));
        }
        if (payload.redHerringPlayerId !== undefined) {
          const herring = session.players.get(payload.redHerringPlayerId);
          if (!herring) throw Errors.playerNotFound();
          for (const player of session.players.values()) {
            player.fortuneTellerRedHerringPlayerId = herring.playerId;
          }
          logDiscretion(session, `Fortune Teller red herring is now ${herring.displayName} for the current night.`);
        }
        for (const entry of payload.registrations ?? []) {
          const player = session.players.get(entry.playerId);
          if (!player) throw Errors.playerNotFound();
          player.registration = {
            alignment: entry.alignment ?? null,
            characterType: entry.characterType ?? null,
          };
          logDiscretion(
            session,
            `${player.displayName} now registers as ${entry.alignment ?? 'themselves'} / ${
              entry.characterType ?? 'their own type'
            } to detection abilities.`
          );
        }
        if (payload.stepOverride) {
          const step = session.currentNight?.steps.find((s) => s.characterId === payload.stepOverride!.characterId);
          if (!step) throw Errors.playerNotFound();
          step.overrideText = payload.stepOverride.text;
          logDiscretion(
            session,
            `Result override queued for ${step.characterId}: "${payload.stepOverride.text}".`
          );
        }
        broadcastGrimoire(io, session);
        sendNightState(io, session);
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
        broadcastFlow(io, session);
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
        io.to(sessionRoom(session.code)).emit(ServerEvents.NominationOpened, toNominationView(nomination));
        broadcastFlow(io, session);
        store.touch(session);
      })
    );

    socket.on(ClientEvents.PlayerVote, (raw: unknown) =>
      guarded(io, socket, () => {
        const { session, player } = requirePlayer(socket);
        requireGameNotEnded(session);
        const { nominationId, voting } = VoteSchema.parse(raw);
        const nomination = castVote(session, nominationId, player.playerId, voting);
        io.to(sessionRoom(session.code)).emit(ServerEvents.NominationVoteUpdate, toNominationView(nomination));
        store.touch(session);
      })
    );

    socket.on(ClientEvents.StorytellerCloseVote, (raw: unknown) =>
      guarded(io, socket, () => {
        const session = requireStoryteller(socket);
        requireGameNotEnded(session);
        const { nominationId } = CloseVoteSchema.parse(raw);
        const nomination = closeVote(session, nominationId);
        io.to(sessionRoom(session.code)).emit(ServerEvents.NominationClosed, toNominationView(nomination));
        broadcastFlow(io, session);
        // A day that ends on a failed vote has had "no execution", which is one
        // of the Mayor's three conditions.
        const mayorWin = checkMayorWin(session);
        if (mayorWin) broadcastGameEnded(io, session, mayorWin.winner, mayorWin.reason);
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
        broadcastFlow(io, session);
        // The Saint's own text: "If you die by execution, your team loses." This
        // is checked before the generic death sweep, because it outranks every
        // other condition — including the Demon's own death in the same vote,
        // which cannot happen but would otherwise be evaluated first.
        if (result.wasSaint) {
          const saintWin = checkSaintExecution(session, result.targetPlayerId);
          if (saintWin) {
            broadcastGameEnded(io, session, saintWin.winner, saintWin.reason);
            store.touch(session);
            return;
          }
        }
        handlePostDeath(io, session, result.targetPlayerId, result.wasDemon, 'executed');
        store.touch(session);
      })
    );

    socket.on(ClientEvents.StorytellerDemonKill, (raw: unknown) =>
      guarded(io, socket, () => {
        const session = requireStoryteller(socket);
        requireGameNotEnded(session);
        // A night kill can only happen at night. Without this the button was
        // live during discussion, which is both a rules violation and the reason
        // `phaseEndsAt` being purely cosmetic went unnoticed for so long.
        if (session.phase !== 'night') throw Errors.notNightPhase();
        const { targetPlayerId: killTargetId } = DemonKillSchema.parse(raw);
        // The Storyteller acts on the Demon's behalf, so find the (only)
        // living Demon rather than requiring a specific killer socket.
        const demon = [...session.players.values()].find((p) => p.alive && p.characterType === 'demon');
        if (!demon) throw Errors.notTheDemon();
        const killResult = resolveDemonKill(session, demon.playerId, killTargetId);
        broadcastGrimoire(io, session);
        broadcastLobby(io, session);
        if (killResult.killed) {
          sendToPlayer(io, session.players.get(killResult.targetPlayerId)!, ServerEvents.PlayerSelfUpdate, {
            alive: false,
          });
        }
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
        } else if (killResult.killed) {
          handlePostDeath(io, session, killResult.targetPlayerId, false, 'night-kill');
          store.touch(session);
        } else {
          // Protected: the target survives, so no win check runs. The night log
          // already records the save.
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
          broadcastLobby(io, identity.session);
        }
      }
    });
  });
}
