import { useEffect, useState } from 'react';
import type { Socket } from 'socket.io-client';
import {
  ServerEvents,
  type ActiveNominationView,
  type DemonInheritedPayload,
  type DiscretionLogEntryView,
  type DistributionPayload,
  type ErrorPayload,
  type GameEndedPayload,
  type GamePhase,
  type GrimoirePlayerEntry,
  type NightInfoResultPayload,
  type NightPromptPayload,
  type NightRosterPayload,
  type QuestionEntryView,
} from '@clocktower/shared';

export interface LobbyPlayer {
  playerId: string;
  displayName: string;
  connected: boolean;
  alive: boolean;
  seatIndex: number;
  hasNominatedToday: boolean;
}

export interface ChatMessageView {
  senderId: string;
  senderName: string;
  text: string;
  ts: number;
}

export interface SessionState {
  role: 'storyteller' | 'player' | null;
  phase: GamePhase;
  dayNumber: number;
  lobbyPlayers: LobbyPlayer[];
  distribution: DistributionPayload | null;
  grimoire: GrimoirePlayerEntry[] | null;
  nomination: ActiveNominationView | null;
  lastExecutedPlayerId: string | null;
  executionEventId: number;
  chatMessages: ChatMessageView[];
  openChatMessages: ChatMessageView[];
  storytellerConnected: boolean;
  abilityResult: string | null;
  alive: boolean;
  lastError: ErrorPayload | null;
  /** Epoch ms when the current phase's countdown ends, or null if no timer is set. */
  phaseEndsAt: number | null;
  questionQueue: QuestionEntryView[];
  /** Set once the game has ended, whether by automatic detection or Storyteller override. */
  gameResult: GameEndedPayload | null;
  /** Storyteller-only: set when a Minion secretly inherits the Demon role (e.g. after an Imp self-kill). */
  demonInherited: DemonInheritedPayload | null;
  /** Storyteller-only: the live, steppable night roster. Null outside the night phase. */
  nightRoster: NightRosterPayload | null;
  /** Set on the waking player's own client when it's their turn to act tonight. Cleared once they submit or the step advances past them. */
  nightPrompt: NightPromptPayload | null;
  /** The most recent night-info result delivered to this player (e.g. Empath's count), kept visible until the next one arrives. */
  nightInfoResult: NightInfoResultPayload | null;
  /** Storyteller-only: the auditable log of discretionary hidden-state defaults/overrides. */
  discretionLog: DiscretionLogEntryView[];
}

const initialState: SessionState = {
  role: null,
  phase: 'lobby',
  dayNumber: 0,
  lobbyPlayers: [],
  distribution: null,
  grimoire: null,
  nomination: null,
  lastExecutedPlayerId: null,
  executionEventId: 0,
  chatMessages: [],
  openChatMessages: [],
  storytellerConnected: true,
  abilityResult: null,
  alive: true,
  lastError: null,
  phaseEndsAt: null,
  questionQueue: [],
  gameResult: null,
  demonInherited: null,
  nightRoster: null,
  nightPrompt: null,
  nightInfoResult: null,
  discretionLog: [],
};

export function useSession(socket: Socket | null): SessionState {
  const [state, setState] = useState<SessionState>(initialState);

  useEffect(() => {
    if (!socket) return undefined;

    const onAuthOk = (payload: {
      role: 'storyteller' | 'player';
      phase: GamePhase;
      dayNumber: number;
      phaseEndsAt: number | null;
      gameResult?: GameEndedPayload | null;
    }) => {
      setState((s) => ({
        ...s,
        role: payload.role,
        phase: payload.phase,
        dayNumber: payload.dayNumber,
        phaseEndsAt: payload.phaseEndsAt,
        gameResult: payload.gameResult ?? s.gameResult,
      }));
    };
    const onLobbyUpdate = (payload: { players: LobbyPlayer[] }) => {
      setState((s) => ({ ...s, lobbyPlayers: payload.players }));
    };
    const onDistributed = (payload: DistributionPayload) => {
      setState((s) => ({
        ...s,
        distribution: payload,
        grimoire: payload.role === 'storyteller' ? payload.grimoire : s.grimoire,
      }));
    };
    const onPhaseChanged = (payload: { phase: GamePhase; dayNumber: number; phaseEndsAt: number | null }) => {
      setState((s) => ({
        ...s,
        phase: payload.phase,
        dayNumber: payload.dayNumber,
        phaseEndsAt: payload.phaseEndsAt,
        nomination: null,
        nightRoster: payload.phase === 'night' ? s.nightRoster : null,
        nightPrompt: payload.phase === 'night' ? s.nightPrompt : null,
      }));
    };
    const onGrimoireUpdate = (payload: { grimoire: GrimoirePlayerEntry[] }) => {
      setState((s) => ({ ...s, grimoire: payload.grimoire }));
    };
    const onSelfUpdate = (payload: { alive?: boolean; abilityResult?: string }) => {
      setState((s) => ({
        ...s,
        alive: payload.alive ?? s.alive,
        abilityResult: payload.abilityResult ?? s.abilityResult,
      }));
    };
    const onNominationOpened = (payload: ActiveNominationView) => {
      setState((s) => ({ ...s, nomination: payload }));
    };
    const onNominationVoteUpdate = (payload: ActiveNominationView) => {
      setState((s) => ({ ...s, nomination: payload }));
    };
    const onNominationClosed = (payload: ActiveNominationView) => {
      setState((s) => ({ ...s, nomination: payload }));
    };
    const onExecutionConfirmed = (payload: { playerId: string }) => {
      setState((s) => ({ ...s, lastExecutedPlayerId: payload.playerId, executionEventId: s.executionEventId + 1 }));
    };
    const onChatMessage = (payload: ChatMessageView) => {
      setState((s) => ({ ...s, chatMessages: [...s.chatMessages, payload] }));
    };
    const onChatHistory = (payload: { messages: ChatMessageView[] }) => {
      setState((s) => ({ ...s, chatMessages: payload.messages }));
    };
    const onOpenChatMessage = (payload: ChatMessageView) => {
      setState((s) => ({ ...s, openChatMessages: [...s.openChatMessages, payload] }));
    };
    const onOpenChatHistory = (payload: { messages: ChatMessageView[] }) => {
      setState((s) => ({ ...s, openChatMessages: payload.messages }));
    };
    const onStorytellerStatus = (payload: { connected: boolean }) => {
      setState((s) => ({ ...s, storytellerConnected: payload.connected }));
    };
    const onError = (payload: ErrorPayload) => {
      setState((s) => ({ ...s, lastError: payload }));
    };
    const onQuestionQueueUpdate = (payload: { questions: QuestionEntryView[] }) => {
      setState((s) => ({ ...s, questionQueue: payload.questions }));
    };
    const onGameEnded = (payload: GameEndedPayload) => {
      setState((s) => ({ ...s, gameResult: payload, phase: 'ended' }));
    };
    const onDemonInherited = (payload: DemonInheritedPayload) => {
      setState((s) => ({ ...s, demonInherited: payload }));
    };
    const onNightRosterUpdate = (payload: NightRosterPayload) => {
      setState((s) => ({ ...s, nightRoster: payload }));
    };
    const onNightPrompt = (payload: NightPromptPayload) => {
      setState((s) => ({ ...s, nightPrompt: payload }));
    };
    const onNightInfoResult = (payload: NightInfoResultPayload) => {
      setState((s) => ({ ...s, nightInfoResult: payload, nightPrompt: null }));
    };
    const onDiscretionLogUpdate = (payload: { entries: DiscretionLogEntryView[] }) => {
      setState((s) => ({ ...s, discretionLog: payload.entries }));
    };

    socket.on(ServerEvents.AuthOk, onAuthOk);
    socket.on(ServerEvents.LobbyUpdate, onLobbyUpdate);
    socket.on(ServerEvents.GameDistributed, onDistributed);
    socket.on(ServerEvents.GamePhaseChanged, onPhaseChanged);
    socket.on(ServerEvents.GrimoireUpdate, onGrimoireUpdate);
    socket.on(ServerEvents.PlayerSelfUpdate, onSelfUpdate);
    socket.on(ServerEvents.NominationOpened, onNominationOpened);
    socket.on(ServerEvents.NominationVoteUpdate, onNominationVoteUpdate);
    socket.on(ServerEvents.NominationClosed, onNominationClosed);
    socket.on(ServerEvents.ExecutionConfirmed, onExecutionConfirmed);
    socket.on(ServerEvents.ChatEvilMessage, onChatMessage);
    socket.on(ServerEvents.ChatEvilHistory, onChatHistory);
    socket.on(ServerEvents.ChatOpenMessage, onOpenChatMessage);
    socket.on(ServerEvents.ChatOpenHistory, onOpenChatHistory);
    socket.on(ServerEvents.StorytellerConnectionStatus, onStorytellerStatus);
    socket.on(ServerEvents.Error, onError);
    socket.on(ServerEvents.QuestionQueueUpdate, onQuestionQueueUpdate);
    socket.on(ServerEvents.GameEnded, onGameEnded);
    socket.on(ServerEvents.DemonInherited, onDemonInherited);
    socket.on(ServerEvents.NightRosterUpdate, onNightRosterUpdate);
    socket.on(ServerEvents.NightPrompt, onNightPrompt);
    socket.on(ServerEvents.NightInfoResult, onNightInfoResult);
    socket.on(ServerEvents.DiscretionLogUpdate, onDiscretionLogUpdate);

    return () => {
      socket.off(ServerEvents.AuthOk, onAuthOk);
      socket.off(ServerEvents.LobbyUpdate, onLobbyUpdate);
      socket.off(ServerEvents.GameDistributed, onDistributed);
      socket.off(ServerEvents.GamePhaseChanged, onPhaseChanged);
      socket.off(ServerEvents.GrimoireUpdate, onGrimoireUpdate);
      socket.off(ServerEvents.PlayerSelfUpdate, onSelfUpdate);
      socket.off(ServerEvents.NominationOpened, onNominationOpened);
      socket.off(ServerEvents.NominationVoteUpdate, onNominationVoteUpdate);
      socket.off(ServerEvents.NominationClosed, onNominationClosed);
      socket.off(ServerEvents.ExecutionConfirmed, onExecutionConfirmed);
      socket.off(ServerEvents.ChatEvilMessage, onChatMessage);
      socket.off(ServerEvents.ChatEvilHistory, onChatHistory);
      socket.off(ServerEvents.ChatOpenMessage, onOpenChatMessage);
      socket.off(ServerEvents.ChatOpenHistory, onOpenChatHistory);
      socket.off(ServerEvents.StorytellerConnectionStatus, onStorytellerStatus);
      socket.off(ServerEvents.Error, onError);
      socket.off(ServerEvents.QuestionQueueUpdate, onQuestionQueueUpdate);
      socket.off(ServerEvents.GameEnded, onGameEnded);
      socket.off(ServerEvents.DemonInherited, onDemonInherited);
      socket.off(ServerEvents.NightRosterUpdate, onNightRosterUpdate);
      socket.off(ServerEvents.NightPrompt, onNightPrompt);
      socket.off(ServerEvents.NightInfoResult, onNightInfoResult);
      socket.off(ServerEvents.DiscretionLogUpdate, onDiscretionLogUpdate);
    };
  }, [socket]);

  return state;
}
