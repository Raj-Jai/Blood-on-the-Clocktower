export type CharacterType = 'townsfolk' | 'outsider' | 'minion' | 'demon';
export type Alignment = 'good' | 'evil';

/** Shape of the information a character receives back from their night ability. Drives prompt + result rendering. */
export type InfoType = 'character' | 'count' | 'yes-no' | 'alignment' | 'pair' | 'grimoire' | 'none';

/**
 * Predicates used to build the legal-target set for a night choice. Multiple
 * entries are ANDed together. `registeredAs` variants ('evil'/'good') are
 * evaluated against the subject's REGISTRATION, not their true alignment —
 * that is the whole point of a Recluse/Spy.
 */
export type TargetRestriction =
  | 'other' // not the waker themself
  | 'alive'
  | 'dead'
  | 'townsfolk'
  | 'outsider'
  | 'minion'
  | 'demon'
  | 'evil'
  | 'good';

export interface CharacterDefinition {
  id: string;
  name: string;
  type: CharacterType;
  alignment: Alignment;
  ability: string;
  firstNightOrder: number | null;
  otherNightOrder: number | null;

  /**
   * Shown to the waker when their turn comes. Absent = no night action.
   * Kept optional so older/partial definitions stay valid.
   */
  nightPrompt?: string;
  /** How many players the waker must select. Omit or 0 = no selection. */
  targetCount?: number;
  /** Predicates the selected players must satisfy. Empty/absent = anyone legal. */
  targetRestrictions?: TargetRestriction[];
  /** Shape of the information the waker receives back. */
  infoType?: InfoType;
  /**
   * Set when this character is allowed to deliberately register as something
   * other than the truth to *detection* abilities. The Storyteller chooses the
   * value; the engine only enforces the permission.
   */
  registerAs?: {
    alignments?: Alignment[];
    types?: CharacterType[];
  };
}

export interface DistributionCounts {
  townsfolk: number;
  outsider: number;
  minion: number;
  demon: number;
}
