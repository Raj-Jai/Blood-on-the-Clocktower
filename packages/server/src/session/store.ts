import { customAlphabet } from 'nanoid';
import type { Alignment, CharacterType, GameEndReason, GamePhase, StatusEffects, WinningTeam } from '@clocktower/shared';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/0/I/1 to avoid confusion
const generateCode = customAlphabet(CODE_ALPHABET, 5);

export interface PlayerRecord {
  playerId: string;
  connectionId: string | null;
  /** Epoch ms when this player's socket last disconnected, or null while connected / before ever connecting. Used to gate the reclaim grace period. */
  disconnectedAt: number | null;
  displayName: string;
  character: string | null;
  characterType: CharacterType | null;
  alignment: Alignment | null;
  alive: boolean;
  usedDeadVote: boolean;
  statusEffects: StatusEffects;
  hasNominatedToday: boolean;
  onboardingSeen: boolean;
  /** Position around the seating circle, 0-indexed clockwise. Defaults to join order. */
  seatIndex: number;
  /** For Evil players: the one fixed bluff character id assigned at distribution time (stable across reconnects). Null for Good players or before distribution. */
  bluffCharacterId: string | null;
  /** Fortune Teller only: the one good player who always registers as the Demon to them. Set once (Storyteller discretion, defaulted automatically) and kept stable for the whole game. */
  fortuneTellerRedHerringId: string | null;
  /** Drunk only: the Townsfolk character they believe themself to be. Set once at distribution (Storyteller discretion, defaulted automatically). */
  drunkCoverCharacterId: string | null;
  /** True for exactly one night/day cycle after a NIGHT death (not an execution) -- gates the Ravenkeeper's conditional wake ("if you die at night"). Cleared at the start of the next night. */
  diedAtNightPending: boolean;
}

/** A player's submitted night-action target(s) for the current night, before resolution. */
export interface NightActionSubmission {
  characterId: string;
  targetPlayerIds: string[];
  submittedAt: number;
}

/** An auditable record of a hidden-state choice (default or override) for roles the rules require to stay discretionary (Drunk cover, Fortune Teller red herring, Recluse/Spy registration). */
export interface DiscretionLogEntry {
  kind: 'drunk-cover' | 'fortune-teller-red-herring' | 'registration-override';
  playerId: string;
  /** The chosen value: a character id for drunk-cover, a playerId for red-herring, free text for registration-override. */
  value: string;
  /** False for the automatic default assigned at distribution time, true once the Storyteller has overridden it. */
  isOverride: boolean;
  at: number;
}

/** Per-night engine state. Reset at the start of every night phase. */
export interface NightState {
  isFirstNight: boolean;
  /** playerIds in tonight's wake order, already filtered to characters in play and sorted by night order. */
  wakeOrder: string[];
  /** Index into wakeOrder of the step currently being acted on. */
  currentStepIndex: number;
  /** Submissions recorded so far tonight, keyed by playerId. */
  submissions: Map<string, NightActionSubmission>;
  /** Composed result text ready for delivery, keyed by playerId. Delivered via PlayerSelfUpdate/NightInfoResult and then read here for reconnect replay. */
  results: Map<string, string>;
}

export interface ActiveNomination {
  id: string;
  nominatorId: string;
  targetId: string;
  votes: Map<string, boolean>;
  openedAt: number;
  closed: boolean;
  pendingExecution: boolean;
  resolvedTally: number | null;
  /** Set once StorytellerConfirmExecution has actually run for this nomination, to make it idempotent. */
  executed: boolean;
}

export interface ChatMessage {
  senderId: string;
  senderName: string;
  text: string;
  ts: number;
}

export interface QuestionEntry {
  id: string;
  playerId: string;
  playerName: string;
  text: string;
  answer: string | null;
  answered: boolean;
  askedAt: number;
}

export interface GameSession {
  code: string;
  storytellerConnectionId: string | null;
  storytellerToken: string;
  phase: GamePhase;
  dayNumber: number;
  script: 'trouble-brewing';
  players: Map<string, PlayerRecord>;
  nomination: ActiveNomination | null;
  resolvedNominationsToday: { targetId: string; tally: number }[];
  /** The true character id of whoever was executed TODAY (not a night kill), for the Undertaker's next-night info. Cleared at the start of each new day. */
  executedTodayCharacterId: string | null;
  evilChatHistory: ChatMessage[];
  /** Open Discussion: visible to every player and the Storyteller (unlike Evil chat, which is Evil-only). */
  openChatHistory: ChatMessage[];
  /** Epoch ms when the current phase's countdown ends, or null if no timer is set. */
  phaseEndsAt: number | null;
  /** Post-night question queue: Evil players' questions surface first, one at a time, gated on the Storyteller answering. */
  questionQueue: QuestionEntry[];
  /** Set once the game ends (phase becomes 'ended'), by automatic detection or a Storyteller override. */
  gameResult: { winner: WinningTeam; reason: GameEndReason } | null;
  /** Null outside the night phase. Set fresh each time the Storyteller transitions into night. */
  nightState: NightState | null;
  /** Auditable history of discretionary hidden-state choices (defaults and overrides), per the automation research's requirement that these never be invisible. */
  discretionLog: DiscretionLogEntry[];
  createdAt: number;
  lastActivityAt: number;
}

const MAX_CHAT_HISTORY = 200;
const SESSION_IDLE_MS = 6 * 60 * 60 * 1000; // 6 hours

export class SessionStore {
  private sessions = new Map<string, GameSession>();

  createSession(storytellerToken: string): GameSession {
    let code = generateCode();
    while (this.sessions.has(code)) {
      code = generateCode();
    }
    const session: GameSession = {
      code,
      storytellerConnectionId: null,
      storytellerToken,
      phase: 'lobby',
      dayNumber: 0,
      script: 'trouble-brewing',
      players: new Map(),
      nomination: null,
      resolvedNominationsToday: [],
      executedTodayCharacterId: null,
      evilChatHistory: [],
      openChatHistory: [],
      phaseEndsAt: null,
      questionQueue: [],
      gameResult: null,
      nightState: null,
      discretionLog: [],
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    };
    this.sessions.set(code, session);
    return session;
  }

  getSession(code: string): GameSession | undefined {
    return this.sessions.get(code.toUpperCase());
  }

  touch(session: GameSession): void {
    session.lastActivityAt = Date.now();
  }

  deleteSession(code: string): void {
    this.sessions.delete(code.toUpperCase());
  }

  isDisplayNameTaken(session: GameSession, displayName: string): boolean {
    const normalized = displayName.trim().toLowerCase();
    for (const p of session.players.values()) {
      if (p.displayName.trim().toLowerCase() === normalized) return true;
    }
    return false;
  }

  addPlayer(session: GameSession, playerId: string, displayName: string): PlayerRecord {
    const record: PlayerRecord = {
      playerId,
      connectionId: null,
      disconnectedAt: null,
      displayName,
      character: null,
      characterType: null,
      alignment: null,
      alive: true,
      usedDeadVote: false,
      statusEffects: { poisoned: false, drunk: false, protected: false },
      hasNominatedToday: false,
      onboardingSeen: false,
      seatIndex: session.players.size,
      bluffCharacterId: null,
      fortuneTellerRedHerringId: null,
      drunkCoverCharacterId: null,
      diedAtNightPending: false,
    };
    session.players.set(playerId, record);
    return record;
  }

  cleanupIdleSessions(): void {
    const now = Date.now();
    for (const [code, session] of this.sessions) {
      if (now - session.lastActivityAt > SESSION_IDLE_MS) {
        this.sessions.delete(code);
      }
    }
  }
}

/** Appends `message` to `history` in place, trimming the oldest entries beyond MAX_CHAT_HISTORY. */
export function pushChatMessage(history: ChatMessage[], message: ChatMessage): void {
  history.push(message);
  if (history.length > MAX_CHAT_HISTORY) {
    history.splice(0, history.length - MAX_CHAT_HISTORY);
  }
}

export function livingPlayerCount(session: GameSession): number {
  let count = 0;
  for (const p of session.players.values()) {
    if (p.alive) count++;
  }
  return count;
}

export function evilPlayers(session: GameSession): PlayerRecord[] {
  return [...session.players.values()].filter((p) => p.alignment === 'evil');
}

export function playersBySeat(session: GameSession): PlayerRecord[] {
  return [...session.players.values()].sort((a, b) => a.seatIndex - b.seatIndex);
}

export interface LivingNeighbors {
  left: PlayerRecord | null;
  right: PlayerRecord | null;
}

/**
 * Finds the nearest LIVING neighbor in each direction around the fixed
 * seating circle, skipping dead players — this is exactly how neighbor-based
 * abilities (Empath, Fortune Teller, etc.) work once players are executed:
 * seat order never changes, but "neighbor" always means nearest living
 * neighbor. Returns null for a side if there are no other living players.
 */
export function livingNeighborsOf(session: GameSession, playerId: string): LivingNeighbors {
  const seated = playersBySeat(session);
  const index = seated.findIndex((p) => p.playerId === playerId);
  if (index === -1 || seated.length < 2) return { left: null, right: null };

  const n = seated.length;
  let left: PlayerRecord | null = null;
  for (let step = 1; step < n; step++) {
    const candidate = seated[(index - step + n) % n]!;
    if (candidate.alive && candidate.playerId !== playerId) {
      left = candidate;
      break;
    }
  }

  let right: PlayerRecord | null = null;
  for (let step = 1; step < n; step++) {
    const candidate = seated[(index + step) % n]!;
    if (candidate.alive && candidate.playerId !== playerId) {
      right = candidate;
      break;
    }
  }

  return { left, right };
}

/**
 * Reassigns seatIndex for every player based on the given ordered list of
 * playerIds (the new clockwise order). playerIds not present in the session
 * are ignored; players missing from the list keep their relative order,
 * appended after the reordered ones.
 */
export function reorderSeats(session: GameSession, orderedPlayerIds: string[]): void {
  let index = 0;
  const seen = new Set<string>();
  for (const playerId of orderedPlayerIds) {
    const player = session.players.get(playerId);
    if (!player || seen.has(playerId)) continue;
    player.seatIndex = index;
    index += 1;
    seen.add(playerId);
  }
  for (const player of playersBySeat(session)) {
    if (!seen.has(player.playerId)) {
      player.seatIndex = index;
      index += 1;
    }
  }
}
