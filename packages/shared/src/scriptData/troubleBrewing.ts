import type { CharacterDefinition } from './types.js';

/**
 * The Trouble Brewing script: 13 Townsfolk, 4 Outsider, 4 Minions, 1 Demon.
 * Ability text and night order are sourced from the official Blood on the
 * Clocktower Trouble Brewing character sheet (bloodontheclocktower.com).
 *
 * `nightPrompt` / `targetCount` / `targetRestrictions` / `infoType` are the
 * automation metadata the server-side Night Engine uses to drive a waker's
 * private prompt and validate their choice. `registerAs` marks the two
 * characters that are ALLOWED to register as something other than the truth
 * to detection abilities (Recluse and Spy) — the engine enforces only the
 * permission; choosing the value stays a Storyteller decision.
 *
 * NIGHT ORDER, from the official Trouble Brewing night sheet and the official Script
 * Tool. These are the numbers the engine sorts the wake walk by, and they are also
 * what the Storyteller's "Night Order" panel displays, so getting them wrong tells
 * the table to run the night in the wrong order. They were substantially wrong.
 *
 * FIRST NIGHT: Minion info, Demon info, then POISONER, Washerwoman, Librarian,
 * Investigator, Chef, Empath, Fortune Teller, Butler, Spy. The Imp kills last, and
 * the result is announced at dawn.
 *
 *   The Poisoner is the reason the Minions come first: the Storyteller decides what
 *   may safely be told to a poisoned player BEFORE anyone acts on their ability, so
 *   the Poisoner has to pick first. This app had the Poisoner 8th of 10 — after every
 *   information role had already been told the truth — so poisoning someone that night
 *   did nothing at all. Found by reading the app's own night-order panel during a game.
 *
 * OTHER NIGHTS: Poisoner, Monk, Scarlet Woman, Imp, Ravenkeeper, Empath,
 * Fortune Teller, Butler, Undertaker, Spy. Again the Minion and Demon actions come
 * first, for the same reason.
 *
 *   TPI's own two sources disagree on the last two: the printed night sheet runs
 *   Butler then Undertaker, the Script Tool runs Undertaker then Butler. The printed
 *   sheet is followed here because that is the sheet a Storyteller has in front of
 *   them. The two characters never both have anything to do, so it changes nothing.
 */
export const TROUBLE_BREWING_CHARACTERS: CharacterDefinition[] = [
  // Townsfolk
  {
    id: 'washerwoman',
    name: 'Washerwoman',
    type: 'townsfolk',
    alignment: 'good',
    // "of your choice" matters: without it the engine cannot know which character
    // the player picked, and the official text requires the choice to be theirs.
    ability: 'You start knowing that 1 of 2 players is a particular Townsfolk of your choice.',
    firstNightOrder: 2,
    otherNightOrder: null,
    nightPrompt: 'Choose a player. You will learn which player, and which Townsfolk, 1 of 2 players is.',
    targetCount: 1,
    targetRestrictions: ['other', 'townsfolk'],
    infoType: 'pair',
  },
  {
    id: 'librarian',
    name: 'Librarian',
    type: 'townsfolk',
    alignment: 'good',
    ability: 'You start knowing that 1 of 2 players is a particular Outsider. (Or that zero are in play.)',
    firstNightOrder: 3,
    otherNightOrder: null,
    nightPrompt:
      'Choose a player. You will learn which player, and which Outsider, 1 of 2 players is. (It may be that no Outsider is in play.)',
    targetCount: 1,
    targetRestrictions: ['other', 'outsider'],
    infoType: 'pair',
  },
  {
    id: 'investigator',
    name: 'Investigator',
    type: 'townsfolk',
    alignment: 'good',
    ability: 'You start knowing that 1 of 2 players is a particular Minion.',
    firstNightOrder: 4,
    otherNightOrder: null,
    nightPrompt: 'Choose a player. You will learn which player, and which Minion, 1 of 2 players is.',
    targetCount: 1,
    targetRestrictions: ['other', 'minion'],
    infoType: 'pair',
  },
  {
    id: 'chef',
    name: 'Chef',
    type: 'townsfolk',
    alignment: 'good',
    ability: 'You start knowing how many pairs of evil players there are.',
    firstNightOrder: 5,
    otherNightOrder: null,
    infoType: 'count',
  },
  {
    id: 'empath',
    name: 'Empath',
    type: 'townsfolk',
    alignment: 'good',
    ability: 'Each night, you learn how many of your 2 alive neighbors are evil.',
    firstNightOrder: 6,
    otherNightOrder: 5,
    infoType: 'count',
  },
  {
    id: 'fortune-teller',
    name: 'Fortune Teller',
    type: 'townsfolk',
    alignment: 'good',
    ability:
      'Each night, choose 2 players: you learn if either is a Demon. There is a good player that registers as a Demon to you.',
    firstNightOrder: 7,
    otherNightOrder: 6,
    nightPrompt: 'Choose 2 players. You will learn whether either of them is the Demon.',
    targetCount: 2,
    // 'alive' added on top of the spec's 'other': selecting a corpse would
    // waste one of only two slots. Dead players can never be the Demon.
    targetRestrictions: ['other', 'alive'],
    infoType: 'yes-no',
  },
  {
    id: 'undertaker',
    name: 'Undertaker',
    type: 'townsfolk',
    alignment: 'good',
    ability: 'Each night*, you learn which character died by execution today.',
    firstNightOrder: null,
    otherNightOrder: 8,
    infoType: 'character',
  },
  {
    id: 'monk',
    name: 'Monk',
    type: 'townsfolk',
    alignment: 'good',
    ability: 'Each night*, choose a player (not yourself): they are safe from the Demon tonight.',
    firstNightOrder: null,
    otherNightOrder: 2,
    nightPrompt: 'Choose a good player other than yourself. They are safe from the Demon tonight.',
    targetCount: 1,
    targetRestrictions: ['other', 'alive', 'good'],
    infoType: 'none',
  },
  {
    id: 'ravenkeeper',
    name: 'Ravenkeeper',
    type: 'townsfolk',
    alignment: 'good',
    ability: 'If you die at night, you are woken to choose a player: you learn their character.',
    firstNightOrder: null,
    otherNightOrder: 4,
    nightPrompt: 'Choose a player. You learn their character.',
    targetCount: 1,
    targetRestrictions: ['other'],
    infoType: 'character',
  },
  {
    // Daytime-only ability: no night prompt, and no night order value.
    id: 'virgin',
    name: 'Virgin',
    type: 'townsfolk',
    alignment: 'good',
    ability:
      'The 1st time you are nominated, if the nominator is a Townsfolk, they are executed immediately.',
    firstNightOrder: null,
    otherNightOrder: null,
    infoType: 'none',
  },
  {
    // Daytime-only ability. targetCount documents the pick it performs during
    // the day; it never produces a night step (otherNightOrder is null).
    id: 'slayer',
    name: 'Slayer',
    type: 'townsfolk',
    alignment: 'good',
    ability: 'Once per game, during the day, publicly choose a player: if they are the Demon, they die.',
    firstNightOrder: null,
    otherNightOrder: null,
    targetCount: 1,
    targetRestrictions: ['other', 'alive'],
    infoType: 'none',
  },
  {
    // Passive, always-on protection. Enforced by demonKill.ts reading
    // statusEffects.protected, which the engine keeps set for a living Soldier.
    id: 'soldier',
    name: 'Soldier',
    type: 'townsfolk',
    alignment: 'good',
    ability: 'You are safe from the Demon.',
    firstNightOrder: null,
    otherNightOrder: null,
    infoType: 'none',
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
    infoType: 'none',
  },

  // Outsiders
  {
    id: 'butler',
    name: 'Butler',
    type: 'outsider',
    alignment: 'good',
    ability: 'Each night, choose a player (not yourself): tomorrow, you may only vote if they are voting too.',
    firstNightOrder: 8,
    otherNightOrder: 7,
    // Not "a Townsfolk": the rule is that the choice may not be a Minion or the Demon, so
    // every Outsider is legal. See the `not-demon-or-minion` restriction.
    nightPrompt: 'Choose a player other than yourself. They may not be a Minion or the Demon. Tomorrow you may only vote if they vote too.',
    targetCount: 1,
    targetRestrictions: ['other', 'alive', 'not-demon-or-minion'],
    infoType: 'none',
  },
  {
    // The Drunk is never told they are the Drunk. The engine wakes them using
    // the COVER character's prompt and order (see nightEngine.ts), and their
    // distribution payload shows the cover character, not this one. The fields
    // below therefore only apply to what the Storyteller sees.
    id: 'drunk',
    name: 'Drunk',
    type: 'outsider',
    alignment: 'good',
    ability: 'You do not know you are the Drunk. You think you are a Townsfolk character, but you are not.',
    firstNightOrder: null,
    otherNightOrder: null,
    infoType: 'none',
  },
  {
    id: 'recluse',
    name: 'Recluse',
    type: 'outsider',
    alignment: 'good',
    ability: 'You might register as evil & as a Minion or Demon, even if dead.',
    firstNightOrder: null,
    otherNightOrder: null,
    infoType: 'none',
    registerAs: { alignments: ['good', 'evil'], types: ['outsider', 'minion', 'demon'] },
  },
  {
    id: 'saint',
    name: 'Saint',
    type: 'outsider',
    alignment: 'good',
    ability: 'If you die by execution, your team loses.',
    firstNightOrder: null,
    otherNightOrder: null,
    infoType: 'none',
  },

  // Minions
  {
    id: 'poisoner',
    name: 'Poisoner',
    type: 'minion',
    alignment: 'evil',
    ability: 'Each night, choose a player: they are poisoned tonight and tomorrow day.',
    firstNightOrder: 1,
    otherNightOrder: 1,
    nightPrompt: 'Choose a player. They are poisoned tonight and tomorrow day.',
    targetCount: 1,
    targetRestrictions: ['other', 'alive'],
    infoType: 'none',
  },
  {
    id: 'spy',
    name: 'Spy',
    type: 'minion',
    alignment: 'evil',
    ability:
      'Each night, you see the Grimoire. You might register as good & as a Townsfolk or Outsider, even if dead.',
    firstNightOrder: 9,
    otherNightOrder: 9,
    infoType: 'grimoire',
    registerAs: { alignments: ['good', 'evil'], types: ['townsfolk', 'outsider'] },
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
    infoType: 'none',
  },
  {
    // "[+2 Outsiders]" is applied as a setup modifier in distributeRoles(), not
    // as a night action.
    id: 'baron',
    name: 'Baron',
    type: 'minion',
    alignment: 'evil',
    ability: 'There are extra Outsiders in play. [+2 Outsiders]',
    firstNightOrder: null,
    otherNightOrder: null,
    infoType: 'none',
  },

  // Demon
  {
    id: 'imp',
    name: 'Imp',
    type: 'demon',
    alignment: 'evil',
    ability: 'Each night*, choose a player: they die. If you kill yourself this way, a Minion becomes the Imp.',
    // Was `null`, which removed the Demon from the First Night panel entirely.
    firstNightOrder: 10,
    otherNightOrder: 3,
    nightPrompt: 'Choose a player. They die tonight. (Choosing yourself hands the Demon role to a Minion.)',
    targetCount: 1,
    // Deliberately NOT 'other': "If you kill yourself this way, a Minion becomes
    // the Imp" is the Imp's signature ability, so the Demon must be able to
    // select themself. 'alive' is required so the chosen heir/kill target is a
    // living player. (The spec table lists the Imp as "other"; it is
    // authoritative for targetCount/infoType/registerAs, and taking 'other'
    // literally here would make the self-kill impossible through the engine.)
    targetRestrictions: ['alive'],
    infoType: 'none',
  },
];

export function getCharacterById(id: string): CharacterDefinition | undefined {
  return TROUBLE_BREWING_CHARACTERS.find((c) => c.id === id);
}

export function charactersByType(type: CharacterDefinition['type']): CharacterDefinition[] {
  return TROUBLE_BREWING_CHARACTERS.filter((c) => c.type === type);
}
