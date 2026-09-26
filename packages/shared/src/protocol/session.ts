import type { Alignment, CharacterType, InfoType } from '../scriptData/types.js';

export type GamePhase = 'lobby' | 'day' | 'night' | 'ended';
export interface StatusEffects {
  poisoned: boolean;
  drunk: boolean;
  protected: boolean;
}

/** Public-safe lobby entry (no secret data). */
export interface LobbyPlayerSummary {
  playerId: string;
  displayName: string;
  connected: boolean;
  /** Position around the seating circle, 0-indexed clockwise. Public info — seating is visible to everyone. */
  seatIndex: number;
}

/** Full Grimoire entry — Storyteller-only. */
export interface GrimoirePlayerEntry {
  playerId: string;
  displayName: string;
  character: string | null;
  characterType: CharacterType | null;
  alignment: Alignment | null;
  alive: boolean;
  statusEffects: StatusEffects;
  usedDeadVote: boolean;
  connected: boolean;
  seatIndex: number;
  /** Nearest living neighbor in each direction around the fixed seating circle (null if none/only player). */
  livingLeftNeighborId: string | null;
  livingRightNeighborId: string | null;
  /**
   * What this player registers as to detection abilities. `null` on either field
   * means "the truth". Distinct from `alignment` above: a Recluse can register as
   * evil while being Good. Storyteller-only, because it is a hidden decision the
   * discretion panel made and the table must not see.
   */
  registration: { alignment: Alignment | null; characterType: CharacterType | null };
  /** The Townsfolk a Drunk believes themself to be. Storyteller-only. */
  drunkCoverCharacterId: string | null;
  /** The Good player who registers as the Demon to the Fortune Teller. Storyteller-only. */
  fortuneTellerRedHerringPlayerId: string | null;
  /** The Butler's current vote restriction, if any. Storyteller-only. */
  butlerChoice: { masterPlayerId: string; forDayNumber: number } | null;
}

/** What a single player's own client receives about themself. */
export interface OwnCharacterPayload {
  role: 'player';
  playerId: string;
  character: string;
  characterName: string;
  characterType: CharacterType;
  alignment: Alignment;
  ability: string;
  teammates?: { playerId: string; displayName: string; character: string; characterName: string }[];
  /** The one fixed bluff character (not in this game) an Evil player can claim to be. Stable for the whole game. */
  bluff?: { id: string; name: string };
  // A Drunk gets the COVER character's name, type, id and ability here, so this
  // payload never contains the string "Drunk" for them. There is deliberately no
  // "isDrunk" flag on the player's own payload: even the field NAME would put the
  // word in front of whoever inspects the socket traffic or reads the screen.
}

export interface StorytellerDistributionPayload {
  role: 'storyteller';
  grimoire: GrimoirePlayerEntry[];
}

export type DistributionPayload = OwnCharacterPayload | StorytellerDistributionPayload;

/** Broadcast to the whole room — contains no secret data. */
export interface GamePhaseChangedPayload {
  phase: GamePhase;
  dayNumber: number;
  /** 0 before the first night is opened, then 1, 2, … */
  nightNumber: number;
  phaseEndsAt: number | null;
}

export interface AuthOkPayload {
  role: 'storyteller' | 'player';
  phase: GamePhase;
  dayNumber: number;
  nightNumber: number;
  phaseEndsAt: number | null;
  gameResult: GameEndedPayload | null;
}

export interface NominationVote {
  playerId: string;
  voting: boolean;
}

export interface ActiveNominationView {
  nominationId: string;
  nominatorId: string;
  targetId: string;
  votes: NominationVote[];
  closed: boolean;
  pendingExecution: boolean;
}

/** A single entry in the post-night question queue (public — who asked and the answer are visible to all). */
export interface QuestionEntryView {
  questionId: string;
  playerId: string;
  playerName: string;
  text: string;
  answer: string | null;
  answered: boolean;
  askedAt: number;
}

export type WinningTeam = 'good' | 'evil';

export type GameEndReason =
  | 'demon-executed'
  | 'demon-self-killed'
  | 'two-players-left'
  | 'saint-executed'
  | 'mayor-three-left'
  | 'storyteller-ended';

/** Broadcast to everyone once the game ends, whether by automatic detection or a Storyteller override. */
export interface GameEndedPayload {
  winner: WinningTeam;
  reason: GameEndReason;
}

/** Sent only to the Storyteller when a Minion secretly inherits the Demon role (Imp self-kill, or a future Scarlet-Woman-style takeover). */
export interface DemonInheritedPayload {
  previousDemonPlayerId: string;
  newDemonPlayerId: string;
  newDemonCharacterId: string;
}

/**
 * How truthful a piece of generated information is. Three-valued, not boolean:
 * the Drunk's own ability text is "in the majority of cases the information you
 * receive will be wrong, but sometimes the Storyteller may tell you something
 * that is true" — a binary true/false flag makes a Drunk trivially detectable.
 *
 * NEVER sent to a player. If a Drunk received `truth: 'FALSE'` they would know
 * for certain their information was false, destroying the entire point. This
 * goes to the Storyteller's night log only.
 */
export type InfoTruth = 'TRUE' | 'FALSE' | 'RELIABLY_UNRELIABLE';

export interface NightChoiceOption {
  playerId: string;
  displayName: string;
}

/**
 * The private "you are awake, do this" payload. What a single player's own
 * client receives about themself — never contains any other player's character,
 * alignment, or role, and never contains the `truth` of anything.
 */
export interface NightPromptPayload {
  playerId: string;
  nightNumber: number;
  isFirstNight: boolean;
  characterId: string;
  characterName: string;
  /** Ability text of the character being played (cover character, for a Drunk). */
  ability: string;
  prompt: string;
  infoType: InfoType;
  targetCount: number;
  /** Exactly the ids the server will accept. The client picker must not offer anything else. */
  legalTargetIds: string[];
  legalTargets: NightChoiceOption[];
  /**
   * Always-true rules-channel text. The rulebook requires correct information
   * about the RULES even for drunk/poisoned players, so this is never part of
   * the discretionary information channel and is never lied about.
   */
  rulesNote: string;
  // NOTE: there is deliberately no "your information may be unreliable" flag here.
  // A Drunk does not know they are the Drunk, and a poisoned player does not know
  // they are poisoned — that is the entire design of both. Telling a waker that
  // their information might be false identifies the Drunk on the first night and
  // defeats the "usually wrong, sometimes true" rule that makes a Drunk
  // undetectable. See liePolicy.ts.
}

/**
 * The private result payload. What a single player's own client receives about
 * themself. `text` is the only field a client should ever read aloud (see
 * useSpeech) — and it is always the server's own projection for THIS player.
 */
export interface NightResolvedPayload {
  playerId: string;
  nightNumber: number;
  characterId: string;
  characterName: string;
  infoType: InfoType;
  text: string;
  /** Set only for the Spy. The Grimoire, which must never be spoken aloud. */
  grimoire?: GrimoirePlayerEntry[];
  /** Set when the Storyteller overrode this step's generated text. */
  overridden: boolean;
}

/** One step of the Storyteller's night order — Storyteller-only. */
export interface NightOrderStepView {
  characterId: string;
  characterName: string;
  wakerPlayerId: string;
  wakerName: string;
  order: number;
  isFirstNight: boolean;
  resolved: boolean;
  targetCount: number;
  targetIds: string[];
  targetNames: string[];
  legalTargetIds: string[];
  legalTargetNames: string[];
  /** Non-null for auto-resolving steps once resolved (Chef, Empath, Undertaker, Imp, …). */
  autoResult: string | null;
  prompt: string | null;
  infoType: InfoType;
  /** True when the waker is a Drunk and this step runs under their cover character. */
  isDrunkCover: boolean;
  /**
   * False when there are not enough legal targets for this character to make
   * their choice at all — a Librarian with no Outsider in play, a Washerwoman who
   * is the only Townsfolk. The step still wakes and is still announced by name;
   * it just cannot be submitted, and it resolves as the rules say it does.
   */
  isPossible: boolean;
  /** Plain-English reason, for the Storyteller and the night log. */
  unavailableReason: string | null;
  /** Free-text result the Storyteller supplied via the discretion panel, if any. */
  overrideText: string | null;
}

/** Live night order state for the Storyteller's stepper — Storyteller-only. */
export interface NightOrderUpdatePayload {
  nightNumber: number;
  isFirstNight: boolean;
  phase: GamePhase;
  steps: NightOrderStepView[];
  /** Step the Storyteller's stepper is currently pointing at. */
  activeIndex: number;
  resolvedCount: number;
  totalCount: number;
  openedAt: number | null;
  /** Steps with an unsubmitted choice. Non-empty means resolving will drop an effect. */
  outstandingCharacterIds: string[];
  /** True once resolveNight has run for this night. */
  resolved: boolean;
}

/** One auditable line of the night log — Storyteller-only. */
export interface NightLogEntryView {
  night: number;
  at: number;
  kind: string;
  detail: string;
}

export interface NightLogPayload {
  entries: NightLogEntryView[];
}
