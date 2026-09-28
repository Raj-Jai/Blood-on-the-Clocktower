import type { AutomationClass } from '../scriptData/types.js';

/** One entry in tonight's wake order, as seen by the Storyteller's live steppable roster. */
export interface NightStepView {
  playerId: string;
  characterId: string;
  characterName: string;
  automationClass: AutomationClass;
  /** True once this player's action (if any) has been submitted/resolved for tonight. */
  done: boolean;
  /** True if this is the currently active step the Storyteller/player should act on. */
  current: boolean;
}

/** Sent to the Storyteller: the full night roster with live per-step completion state. */
export interface NightRosterPayload {
  isFirstNight: boolean;
  steps: NightStepView[];
}

/** Sent privately to a waking player: their prompt and, if applicable, a target picker. */
export interface NightPromptPayload {
  characterId: string;
  characterName: string;
  prompt: string;
  targetCount: number;
  /** Eligible target playerIds, already filtered by the character's targetRestrictions server-side. */
  eligibleTargetIds: string[];
}

/** Sent privately to a player once their night info is ready (auto/assisted info-delivering roles). */
export interface NightInfoResultPayload {
  characterId: string;
  /** Human-readable result text, already composed server-side (e.g. "2 of your alive neighbours are evil."). */
  text: string;
}

/** Storyteller-only: one entry in the auditable discretion log (Drunk cover, Fortune Teller red herring, and future registration overrides). */
export interface DiscretionLogEntryView {
  kind: 'drunk-cover' | 'fortune-teller-red-herring' | 'registration-override';
  playerId: string;
  playerDisplayName: string;
  /** Human-readable resolved value: a character name for drunk-cover, a player display name for red-herring. */
  valueLabel: string;
  isOverride: boolean;
  at: number;
}
