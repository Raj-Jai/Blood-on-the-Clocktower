import { customAlphabet } from 'nanoid';
import type { Alignment, CharacterType, GameEndReason, GamePhase, StatusEffects, WinningTeam } from '@clocktower/shared';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/0/I/1 to avoid confusion
const generateCode = customAlphabet(CODE_ALPHABET, 5);

export interface PlayerRecord {
  playerId: string;
  connectionId: string | null;
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
  /**
   * What this player is treated as by *detection* abilities (Chef, Empath,
   * Fortune Teller, Washerwoman, …). `null` on either field means "the truth".
   *
   * This is deliberately NOT the same as `alignment`: per the official glossary
   * a Recluse "might register as evil" while still being a Good player. Every
   * detection ability must read this via `perceivedAs()`, never `alignment`
   * directly.
   */
  registration: { alignment: Alignment | null; characterType: CharacterType | null };
  /** Set once at distribution for a Drunk: the Townsfolk they believe themself to be. Never shown to them as "Drunk". */
  drunkCoverCharacterId: string | null;
  /**
   * The Good player who registers as the Demon to the Fortune Teller (the
   * "red herring"). Chosen at setup and constant for the whole game unless the
   * Storyteller overrides it — a fixed red herring IS learnable by a careful
   * table, so the discretion panel must be able to move it each night.
   */
  fortuneTellerRedHerringPlayerId: string | null;
  /**
   * Butler: the player they chose, and the day it applies to. Recording the day
   * is how the restriction expires without a separate clear pass — the night
   * that produced it runs BEFORE that day's `resetForNewDay`, so clearing there
   * would wipe the choice before it could ever be used.
   */
  butlerChoice: { masterPlayerId: string; forDayNumber: number } | null;
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

export interface NightStepState {
  characterId: string;
  wakerPlayerId: string;
  targetIds: string[];
  resolved: boolean;
  /** Free-text result the Storyteller supplied via the discretion panel, sent verbatim to the waker. */
  overrideText: string | null;
}

export interface NightState {
  steps: NightStepState[];
  openedAt: number;
  /** Step the Storyteller's stepper is pointing at. Presentation only. */
  activeIndex: number;
  /** True once resolveNight has run for this night. */
  resolved: boolean;
}

export interface GameSession {
  code: string;
  storytellerConnectionId: string | null;
  storytellerToken: string;
  phase: GamePhase;
  dayNumber: number;
  /** 0 before the first night is opened, then 1, 2, … Drives "is this the First Night" order. */
  nightNumber: number;
  /** The night currently being woken, or null between phases. */
  currentNight: NightState | null;
  /** Append-only audit trail of every generated default, override, and night resolution. Storyteller-only. */
  log: NightLogEntry[];
  /** Per-game lie-policy config. 'sticky' is the default; see liePolicy.ts for the trade-off. */
  liePolicy: LiePolicyConfig;
  /**
   * Storyteller's chosen Imp self-kill heir for a specific night, set via the
   * discretion panel. When absent for the current night, demonKill falls back to
   * a random living Minion and LOGS that it did so.
   */
  impHeirChoice: { nightNumber: number; playerId: string } | null;
  /** One-shot ability flags, so Virgin/Slayer cannot trigger twice. */
  virginHasTriggered: boolean;
  slayerHasUsed: boolean;
  script: 'trouble-brewing';
  players: Map<string, PlayerRecord>;
  nomination: ActiveNomination | null;
  resolvedNominationsToday: { targetId: string; tally: number }[];
  evilChatHistory: ChatMessage[];
  /** Open Discussion: visible to every player and the Storyteller (unlike Evil chat, which is Evil-only). */
  openChatHistory: ChatMessage[];
  /** Epoch ms when the current phase's countdown ends, or null if no timer is set. */
  phaseEndsAt: number | null;
  /** Post-night question queue: Evil players' questions surface first, one at a time, gated on the Storyteller answering. */
  questionQueue: QuestionEntry[];
  /** Set once the game ends (phase becomes 'ended'), by automatic detection or a Storyteller override. */
  gameResult: { winner: WinningTeam; reason: GameEndReason } | null;
  createdAt: number;
  lastActivityAt: number;
}

export interface NightLogEntry {
  night: number;
  at: number;
  kind: string;
  detail: string;
}

/**
 * Per-game lie-policy configuration.
 *
 * 'sticky' (the default) makes generated information a pure function of its
 * inputs, so the same table + the same night always produces the same lie. That
 * is more defensible against reverse-engineering and it is auditable, but a
 * table that plays many games can eventually learn it. 'varied' adds a nonce so
 * the same inputs can produce different lies on repeat calls, which is harder
 * to reverse-engineer but also makes a given night non-reproducible. See the
 * trade-off note in liePolicy.ts.
 */
export interface LiePolicyConfig {
  consistency: 'sticky' | 'varied';
}

const MAX_CHAT_HISTORY = 200;
const MAX_NIGHT_LOG = 500;
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
      nightNumber: 0,
      currentNight: null,
      log: [],
      liePolicy: { consistency: 'sticky' },
      impHeirChoice: null,
      virginHasTriggered: false,
      slayerHasUsed: false,
      script: 'trouble-brewing',
      players: new Map(),
      nomination: null,
      resolvedNominationsToday: [],
      evilChatHistory: [],
      openChatHistory: [],
      phaseEndsAt: null,
      questionQueue: [],
      gameResult: null,
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
      registration: { alignment: null, characterType: null },
      drunkCoverCharacterId: null,
      fortuneTellerRedHerringPlayerId: null,
      butlerChoice: null,
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

/**
 * Appends one auditable line to the session night log.
 *
 * Every hidden-state default the server chooses on the Storyteller's behalf
 * goes through here, timestamped. That is deliberate: the community's
 * "gardening" argument is about a Storyteller choosing hidden state late and
 * opportunistically. A server that picks it at a fixed, pre-deal,
 * log-visible moment is more defensible than a human picking it later — so the
 * timing is a feature, and it is made visible in the Storyteller UI.
 */
export function logNightEvent(session: GameSession, kind: string, detail: string): NightLogEntry {
  const entry: NightLogEntry = { night: session.nightNumber, at: Date.now(), kind, detail };
  session.log.push(entry);
  if (session.log.length > MAX_NIGHT_LOG) {
    session.log.splice(0, session.log.length - MAX_NIGHT_LOG);
  }
  return entry;
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
