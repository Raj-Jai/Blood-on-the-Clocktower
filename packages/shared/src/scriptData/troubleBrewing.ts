import type { CharacterDefinition } from './types.js';

/**
 * The Trouble Brewing script: 13 Townsfolk, 4 Outsiders, 4 Minions, 1 Demon.
 * Ability text and night order are sourced from the official Blood on the
 * Clocktower Trouble Brewing character sheet (bloodontheclocktower.com).
 */
export const TROUBLE_BREWING_CHARACTERS: CharacterDefinition[] = [
  // Townsfolk
  {
    id: 'washerwoman',
    name: 'Washerwoman',
    type: 'townsfolk',
    alignment: 'good',
    ability: 'You start knowing that 1 of 2 players is a particular Townsfolk.',
    firstNightOrder: 1,
    otherNightOrder: null,
    // 'policy': which pair and which character to show is a Storyteller pick
    // among the legal candidates (per the wiki, "of your choice" and "in
    // play"), not a pure function of the seed alone.
    automationClass: 'policy',
    infoType: 'character',
  },
  {
    id: 'librarian',
    name: 'Librarian',
    type: 'townsfolk',
    alignment: 'good',
    ability: 'You start knowing that 1 of 2 players is a particular Outsider. (Or that zero are in play.)',
    firstNightOrder: 2,
    otherNightOrder: null,
    automationClass: 'policy',
    infoType: 'character',
  },
  {
    id: 'investigator',
    name: 'Investigator',
    type: 'townsfolk',
    alignment: 'good',
    ability: 'You start knowing that 1 of 2 players is a particular Minion.',
    firstNightOrder: 3,
    otherNightOrder: null,
    automationClass: 'policy',
    infoType: 'character',
  },
  {
    id: 'chef',
    name: 'Chef',
    type: 'townsfolk',
    alignment: 'good',
    ability: 'You start knowing how many pairs of evil players there are.',
    firstNightOrder: 4,
    otherNightOrder: null,
    // Fully automatic: a count of adjacent evil pairs around the seating
    // circle is arithmetic on registration, no judgment involved.
    automationClass: 'auto',
    infoType: 'count',
  },
  {
    id: 'empath',
    name: 'Empath',
    type: 'townsfolk',
    alignment: 'good',
    ability: 'Each night, you learn how many of your 2 alive neighbours are evil.',
    firstNightOrder: 5,
    otherNightOrder: 1,
    automationClass: 'auto',
    infoType: 'count',
  },
  {
    id: 'fortune-teller',
    name: 'Fortune Teller',
    type: 'townsfolk',
    alignment: 'good',
    ability:
      'Each night, choose 2 players: you learn if either is a Demon. There is a good player that registers as a Demon to you.',
    firstNightOrder: 6,
    otherNightOrder: 2,
    // The yes/no answer given the 2 chosen players is mechanical, but the
    // one-time "red herring" (a good player who always registers as the
    // Demon to this Fortune Teller) is a Storyteller setup choice, set once
    // and kept consistent for the whole game per the wiki's own advice.
    automationClass: 'policy',
    nightPrompt: 'Choose 2 players. You will learn whether either of them is the Demon.',
    targetCount: 2,
    targetRestrictions: ['other'],
    infoType: 'yes-no',
  },
  {
    id: 'undertaker',
    name: 'Undertaker',
    type: 'townsfolk',
    alignment: 'good',
    ability: 'Each night*, you learn which character died by execution today.',
    firstNightOrder: null,
    otherNightOrder: 3,
    // Pure lookup of who was executed today -- no target, no judgment.
    automationClass: 'auto',
    infoType: 'character',
  },
  {
    id: 'monk',
    name: 'Monk',
    type: 'townsfolk',
    alignment: 'good',
    ability: 'Each night*, choose a player (not yourself): they are safe from the Demon tonight.',
    firstNightOrder: null,
    otherNightOrder: 4,
    // The target is the player's real choice; setting `protected` and having
    // the kill resolver honour it afterward is entirely mechanical.
    automationClass: 'assisted',
    nightPrompt: 'Choose a player (not yourself) to protect from the Demon tonight.',
    targetCount: 1,
    targetRestrictions: ['other', 'alive'],
  },
  {
    id: 'ravenkeeper',
    name: 'Ravenkeeper',
    type: 'townsfolk',
    alignment: 'good',
    ability:
      'If you die at night, you are woken to choose a player: you learn their character.',
    firstNightOrder: null,
    otherNightOrder: 5,
    // Only triggers on a night death; the pick is the player's, the info
    // returned (that player's true character) is mechanical.
    automationClass: 'assisted',
    nightPrompt: 'You died at night. Choose a player: you will learn their true character.',
    targetCount: 1,
    targetRestrictions: ['other'],
    infoType: 'character',
  },
  {
    id: 'virgin',
    name: 'Virgin',
    type: 'townsfolk',
    alignment: 'good',
    ability:
      'The 1st time you are nominated, if the nominator is a Townsfolk, they are executed immediately.',
    firstNightOrder: null,
    otherNightOrder: null,
    // Day-time nomination trigger, not a night action -- out of scope for
    // the Night Engine. No automationClass: this has no night wake at all.
  },
  {
    id: 'slayer',
    name: 'Slayer',
    type: 'townsfolk',
    alignment: 'good',
    ability: 'Once per game, during the day, publicly choose a player: if they are the Demon, they die.',
    firstNightOrder: null,
    otherNightOrder: null,
    // Day-time public action, not a night action -- out of scope here.
  },
  {
    id: 'soldier',
    name: 'Soldier',
    type: 'townsfolk',
    alignment: 'good',
    ability: 'You are safe from the Demon.',
    firstNightOrder: null,
    otherNightOrder: null,
    // Passive, always-on protection -- no night wake, no target. The kill
    // resolver checks characterType === 'soldier' directly.
  },
  {
    id: 'mayor',
    name: 'Mayor',
    type: 'townsfolk',
    alignment: 'good',
    ability:
      'If only 3 players live & no execution occurs, your team wins. If you die at night, another player might die instead.',
    firstNightOrder: null,
    otherNightOrder: null,
    // Win-condition / death-redirection edge cases, not a night action with
    // a wake or a target -- out of scope for the Night Engine.
  },

  // Outsiders
  {
    id: 'butler',
    name: 'Butler',
    type: 'outsider',
    alignment: 'good',
    ability: 'Each night, choose a player (not yourself): tomorrow, you may only vote if they are voting too.',
    firstNightOrder: 7,
    otherNightOrder: 6,
    // The target is the player's choice; recording it is mechanical. Voting
    // enforcement itself is officially NOT the Storyteller's job to police
    // ("It is not the Storyteller's responsibility to monitor the Butler"),
    // so this only records the choice for reference, it doesn't gate votes.
    automationClass: 'assisted',
    nightPrompt: "Choose a player (not yourself): tomorrow you may only vote if they're voting too.",
    targetCount: 1,
    targetRestrictions: ['other'],
  },
  {
    id: 'drunk',
    name: 'Drunk',
    type: 'outsider',
    alignment: 'good',
    ability:
      'You do not know you are the Drunk. You think you are a Townsfolk character, but you are not.',
    firstNightOrder: null,
    otherNightOrder: null,
    // The single most discretionary mechanic in the game by design: "you may
    // provide false information or ignore their instructions whenever you
    // want." Always routed to the Storyteller's manual ability-result box.
    automationClass: 'manual',
  },
  {
    id: 'recluse',
    name: 'Recluse',
    type: 'outsider',
    alignment: 'good',
    ability: 'You might register as evil & as a Minion or Demon, even if dead.',
    firstNightOrder: null,
    otherNightOrder: null,
    // "The Storyteller chooses whatever is most interesting" -- may register
    // differently within the same night. Never a pure function of state.
    automationClass: 'manual',
  },
  {
    id: 'saint',
    name: 'Saint',
    type: 'outsider',
    alignment: 'good',
    ability: 'If you die by execution, your team loses.',
    firstNightOrder: null,
    otherNightOrder: null,
    // Execution-triggered win condition, not a night action -- out of scope
    // for the Night Engine (belongs with Virgin/Slayer/Mayor day triggers).
  },

  // Minions
  {
    id: 'poisoner',
    name: 'Poisoner',
    type: 'minion',
    alignment: 'evil',
    ability: 'Each night, choose a player: they are poisoned tonight and tomorrow day.',
    firstNightOrder: 0,
    otherNightOrder: 0,
    // The target/poisoned-flag is mechanical; what false information the
    // Storyteller then feeds the poisoned player is Policy/Manual and stays
    // with the discretion panel / free-text box, not this action itself.
    automationClass: 'assisted',
    nightPrompt: 'Choose a player: they are poisoned tonight and tomorrow day.',
    targetCount: 1,
    targetRestrictions: ['other'],
  },
  {
    id: 'spy',
    name: 'Spy',
    type: 'minion',
    alignment: 'evil',
    ability:
      'Each night, you see the Grimoire. You might register as good & as a Townsfolk or Outsider, even if dead.',
    firstNightOrder: 8,
    otherNightOrder: 7,
    // Sending the Grimoire is trivial and fully automatic; registration
    // (the "might register as good" half) is Manual, same as the Recluse.
    automationClass: 'auto',
    infoType: 'custom',
  },
  {
    id: 'scarlet-woman',
    name: 'Scarlet Woman',
    type: 'minion',
    alignment: 'evil',
    ability:
      'If there are 5 or more players alive & the Demon dies, you become the Demon.',
    firstNightOrder: null,
    otherNightOrder: null,
    // Already implemented as a pure predicate over state at execution/kill
    // time (winConditions.ts) -- not a night wake or target of its own.
  },
  {
    id: 'baron',
    name: 'Baron',
    type: 'minion',
    alignment: 'evil',
    ability: 'There are extra Outsiders in play. [+2 Outsiders]',
    firstNightOrder: null,
    otherNightOrder: null,
    // A setup-table transform applied once at distribution, not a night
    // action -- see distribution.ts.
  },

  // Demon
  {
    id: 'imp',
    name: 'Imp',
    type: 'demon',
    alignment: 'evil',
    ability:
      'Each night*, choose a player: they die. If you kill yourself this way, a Minion becomes the Imp.',
    // Wakes Night 1 too, to learn who the Minions are (the official sheet's
    // "Minion Info"/"Demon Info" steps), ordered just after the Poisoner (0)
    // and before Washerwoman (1) -- their first KILL is still gated to
    // otherNightOrder (no first-night kill).
    firstNightOrder: 0.5,
    otherNightOrder: 8,
    // The kill choice is the player's; resolving it (including the
    // self-kill inheritance) is entirely mechanical via resolveDemonKill.
    automationClass: 'assisted',
    nightPrompt: 'Choose a player: they die tonight.',
    targetCount: 1,
    targetRestrictions: [],
    wakesOnFirstNight: true,
  },
];

export function getCharacterById(id: string): CharacterDefinition | undefined {
  return TROUBLE_BREWING_CHARACTERS.find((c) => c.id === id);
}

export function charactersByType(type: CharacterDefinition['type']): CharacterDefinition[] {
  return TROUBLE_BREWING_CHARACTERS.filter((c) => c.type === type);
}
