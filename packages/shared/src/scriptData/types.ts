export type CharacterType = 'townsfolk' | 'outsider' | 'minion' | 'demon';
export type Alignment = 'good' | 'evil';

/**
 * How much of this character's night action can be resolved without a
 * human Storyteller making a judgment call, per the automation research in
 * GitHub issue #2:
 *   - 'auto': a pure function of game state. No prompt, no player choice --
 *     the engine computes and delivers the result (e.g. Chef, Empath).
 *   - 'assisted': the player makes a real choice (a target), but everything
 *     after that choice is mechanical (e.g. Monk sets `protected`, Imp
 *     resolves via resolveDemonKill). Needs a night prompt + target picker.
 *   - 'policy': automatable ONLY behind a declared, auditable default the
 *     Storyteller can override (e.g. Fortune Teller's red herring, Drunk's
 *     cover character). Needs a Storyteller discretion-panel entry.
 *   - 'manual': the rules explicitly require ongoing human judgment that
 *     must vary and be inconsistent by design (Drunk's false information,
 *     Recluse's registration "whatever is most interesting"). No amount of
 *     automation is faithful to the character here -- always routed to the
 *     Storyteller's free-text ability-result box.
 */
export type AutomationClass = 'auto' | 'assisted' | 'policy' | 'manual';

export type NightInfoType = 'character' | 'count' | 'yes-no' | 'alignment' | 'custom';

/** Legality constraints for a night-action target picker. Combined with AND semantics. */
export type TargetRestriction = 'other' | 'self' | 'townsfolk' | 'outsider' | 'minion' | 'demon' | 'alive' | 'dead';

export interface CharacterDefinition {
  id: string;
  name: string;
  type: CharacterType;
  alignment: Alignment;
  ability: string;
  firstNightOrder: number | null;
  otherNightOrder: number | null;
  /** How this character's night action is handled by the engine. Absent (undefined) for characters with no night action at all. */
  automationClass?: AutomationClass;
  /** Shown to the player when they wake, above their target picker (if any). */
  nightPrompt?: string;
  /** Number of players this character's night action targets. 0 or absent = no target (e.g. a pure-info role like Chef). */
  targetCount?: number;
  /** Legality constraints applied to the target picker's candidate list. */
  targetRestrictions?: TargetRestriction[];
  /** The shape of information this character's action produces, for 'auto' and 'assisted' roles that deliver info. */
  infoType?: NightInfoType;
  /** True if this character should wake on the first night even though their FIRST resolved action is later (the Imp: wakes Night 1 to learn Minions, first kill is Night 2+). */
  wakesOnFirstNight?: boolean;
}

export interface DistributionCounts {
  townsfolk: number;
  outsider: number;
  minion: number;
  demon: number;
}
