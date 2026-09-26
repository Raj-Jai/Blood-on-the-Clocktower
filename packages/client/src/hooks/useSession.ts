import { useEffect, useState } from 'react';
import type { Socket } from 'socket.io-client';
import {
  ServerEvents,
  type ActiveNominationView,
  type AuthOkPayload,
  type DemonInheritedPayload,
  type DistributionPayload,
  type ErrorPayload,
  type GameEndedPayload,
  type GamePhase,
  type GamePhaseChangedPayload,
  type GrimoirePlayerEntry,
  type NightLogEntryView,
  type NightOrderUpdatePayload,
  type NightPromptPayload,
  type NightResolvedPayload,
  type QuestionEntryView,
} from '@clocktower/shared';

export interface LobbyPlayer {
  playerId: string;
  displayName: string;
  connected: boolean;
  alive: boolean;
  seatIndex: number;
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
  /** 0 before the first night is opened, then 1, 2, … */
  nightNumber: number;
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
  /** This player's own private night prompt. Never contains another player's information. */
  nightPrompt: NightPromptPayload | null;
  /** This player's own private night result. Never contains another player's information. */
  nightResult: NightResolvedPayload | null;
  /** Storyteller-only: the live night order stepper state. */
  nightOrder: NightOrderUpdatePayload | null;
  /** Storyteller-only: the auditable night log. */
  nightLog: NightLogEntryView[];
}

const initialState: SessionState = {
  role: null,
  phase: 'lobby',
  dayNumber: 0,
  nightNumber: 0,
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
  nightPrompt: null,
  nightResult: null,
  nightOrder: null,
  nightLog: [],
};

export function useSession(socket: Socket | null): SessionState {
  const [state, setState] = useState<SessionState>(initialState);

  useEffect(() => {
    if (!socket) return undefined;

    const onAuthOk = (payload: AuthOkPayload) => {
      setState((s) => ({
        ...s,
        role: payload.role,
        phase: payload.phase,
        dayNumber: payload.dayNumber,
        nightNumber: payload.nightNumber,
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
    const onPhaseChanged = (payload: GamePhaseChangedPayload) => {
      setState((s) => ({
        ...s,
        phase: payload.phase,
        dayNumber: payload.dayNumber,
        nightNumber: payload.nightNumber,
        phaseEndsAt: payload.phaseEndsAt,
        nomination: null,
        // A phase change is a hard boundary for private information. The old
        // merge (`payload.abilityResult ?? s.abilityResult`) meant a result set
        // once stayed pinned for the rest of the game: Night 1's answer was
        // still on the Character tab on Day 5, indistinguishable from tonight's.
        // On a shared screen that is a serious accidental-information leak.
        abilityResult: null,
        // Likewise the private night prompt/result belong to the night that just
        // ended, so they are dropped at dawn rather than lingering.
        nightPrompt: payload.phase === 'night' ? s.nightPrompt : null,
        nightResult: payload.phase === 'night' ? s.nightResult : null,
      }));
    };
    const onGrimoireUpdate = (payload: { grimoire: GrimoirePlayerEntry[] }) => {
      setState((s) => {
        // Defence in depth. The server only ever sends a Grimoire to the
        // Storyteller and to a Spy (whose character grants it), so a player
        // never needs this field. Storing it on a player client would put every
        // role in the React tree, and React trees are the single most common way
        // a "hidden" secret ends up in the accessibility tree — and therefore
        // read aloud by a screen reader. WebKit exposes `visibility: hidden`
        // content to VoiceOver where Chromium removes it, so hiding it in CSS is
        // not a fix; never receiving it is.
        if (s.role !== 'storyteller') return s;
        return { ...s, grimoire: payload.grimoire };
      });
    };
    const onSelfUpdate = (payload: { alive?: boolean; abilityResult?: string | null }) => {
      setState((s) => ({
        ...s,
        alive: payload.alive ?? s.alive,
        // An explicit null CLEARS the result; a missing key leaves it alone. That
        // distinction is the whole fix: the server sends `abilityResult: null` at
        // the start and end of a night precisely so the stale value goes away.
        abilityResult: 'abilityResult' in payload ? (payload.abilityResult ?? null) : s.abilityResult,
      }));
    };
    const onNominationOpened = (payload: ActiveNominationView) => {
      setState((s) => ({ ...s, nomination: payload }));
    };
    const onNominationVoteUpdate = (payload: ActiveNominationView) => {
      setState((s) => ({ ...s, nomination: payload }));
    };
    const onNominationClosed = (payload: ActiveNominationView) => {
      // The closed nomination is kept so the table can still see the tally, but
      // it is REPLACED by the next NominationOpened rather than blocking it —
      // see PlayerGamePage's canNominate gate, which is issue #4.
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
    const onNightPrompt = (payload: NightPromptPayload) => {
      // Defensive: the server only ever sends a prompt to the waker it belongs
      // to. Dropping anything else here means a bug in the server can never
      // surface another player's night prompt on this screen.
      setState((s) => {
        if (s.role === 'player' && s.distribution?.role === 'player' && payload.playerId !== s.distribution.playerId) {
          return s;
        }
        return { ...s, nightPrompt: payload, nightResult: null };
      });
    };
    const onNightResolved = (payload: NightResolvedPayload) => {
      setState((s) => {
        if (s.role === 'player' && s.distribution?.role === 'player' && payload.playerId !== s.distribution.playerId) {
          return s;
        }
        return { ...s, nightResult: payload, nightPrompt: null };
      });
    };
    const onNightOrderUpdate = (payload: NightOrderUpdatePayload) => {
      setState((s) => (s.role === 'storyteller' ? { ...s, nightOrder: payload } : s));
    };
    const onNightLog = (payload: { entries: NightLogEntryView[] }) => {
      setState((s) => (s.role === 'storyteller' ? { ...s, nightLog: payload.entries } : s));
    };

    socket.on(ServerEvents.AuthOk, onAuthOk);
    socket.on(ServerEvents.LobbyUpdate, onLobbyUpdate);
    socket.on(ServerEvents.GameDistributed, onDistributed);
    socket.on(ServerEvents.GamePhaseChanged, onPhaseChanged);
    socket.on(ServerEvents.GrimoireUpdate, onGrimoireUpdate);
    socket.on(ServerEvents.PlayerSelfUpdate, onSelfUpdate);
    socket.on(ServerEvents.NightPrompt, onNightPrompt);
    socket.on(ServerEvents.NightResolved, onNightResolved);
    socket.on(ServerEvents.NightOrderUpdate, onNightOrderUpdate);
    socket.on(ServerEvents.NightLog, onNightLog);
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

    return () => {
      socket.off(ServerEvents.AuthOk, onAuthOk);
      socket.off(ServerEvents.LobbyUpdate, onLobbyUpdate);
      socket.off(ServerEvents.GameDistributed, onDistributed);
      socket.off(ServerEvents.GamePhaseChanged, onPhaseChanged);
      socket.off(ServerEvents.GrimoireUpdate, onGrimoireUpdate);
      socket.off(ServerEvents.PlayerSelfUpdate, onSelfUpdate);
      socket.off(ServerEvents.NightPrompt, onNightPrompt);
      socket.off(ServerEvents.NightResolved, onNightResolved);
      socket.off(ServerEvents.NightOrderUpdate, onNightOrderUpdate);
      socket.off(ServerEvents.NightLog, onNightLog);
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
    };
  }, [socket]);

  return state;
}
