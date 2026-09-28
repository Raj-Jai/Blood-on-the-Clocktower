import {
  TROUBLE_BREWING_CHARACTERS,
  charactersByType,
  getDistributionCounts,
  getCharacterById,
  isValidPlayerCount,
  MAX_PLAYERS,
  MIN_PLAYERS,
  type CharacterDefinition,
  type CharacterType,
  type DistributionCounts,
  type OwnCharacterPayload,
} from '@clocktower/shared';
import type { GameSession, PlayerRecord } from '../session/store.js';
import { logNightEvent } from '../session/store.js';
import { Errors } from '../errors.js';
import { chooseRedHerring, chooseStickyRegistration } from './liePolicy.js';

/** Fisher-Yates shuffle, returns a new array (does not mutate input). */
export function shuffle<T>(items: readonly T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j] as T, arr[i] as T];
  }
  return arr;
}

function sampleCharacters(type: CharacterType, count: number): CharacterDefinition[] {
  const pool = charactersByType(type);
  if (count > pool.length) {
    // Should never happen with the Trouble Brewing table + roster sizes, but guard anyway.
    throw new Error(`Not enough ${type} characters (${pool.length}) to select ${count}`);
  }
  return shuffle(pool).slice(0, count);
}

/**
 * The Baron's setup modifier: "[+2 Outsiders]".
 *
 * This was dead text before. The distribution table is static and nothing ever
 * checked for the Baron, so a game containing the Baron played with the normal
 * setup — the Baron's entire effect is the setup change, so the character did
 * literally nothing.
 *
 * The modifier is applied as a setup modifier on the CHARACTER COUNTS, not on
 * the drawn set: +2 Outsiders, -2 Townsfolk, all other counts untouched. Total
 * players is unchanged, which is why this is safe for every supported count
 * (the lowest Townsfolk count in the table is 3, so it can never go negative).
 */
export function applyBaronModifier(counts: DistributionCounts): DistributionCounts {
  const townsfolk = counts.townsfolk - 2;
  if (townsfolk < 0) {
    throw new Error(`Baron setup is not possible at this player count (would need ${townsfolk} Townsfolk)`);
  }
  return { ...counts, townsfolk, outsider: counts.outsider + 2 };
}

/**
 * Randomly assigns exactly one Trouble Brewing character to each joined player,
 * using the official player-count distribution table, honouring setup modifiers.
 * Mutates the session's PlayerRecords in place.
 *
 * Minions are sampled BEFORE the setup modifier is applied, because the modifier
 * depends on whether the Baron was drawn. Sampling the Minions first is the only
 * ordering that can answer "is the Baron in play?" and then adjust the rest of the
 * roster for it.
 */
export function distributeRoles(session: GameSession): void {
  const n = session.players.size;
  if (!isValidPlayerCount(n)) {
    throw Errors.distributionRange(MIN_PLAYERS, MAX_PLAYERS);
  }

  const baseCounts = getDistributionCounts(n);
  const minions = sampleCharacters('minion', baseCounts.minion);
  const demons = sampleCharacters('demon', baseCounts.demon);

  const baronInPlay = minions.some((c) => c.id === 'baron');
  const counts = baronInPlay ? applyBaronModifier(baseCounts) : baseCounts;

  const selected: CharacterDefinition[] = [
    ...sampleCharacters('townsfolk', counts.townsfolk),
    ...sampleCharacters('outsider', counts.outsider),
    ...minions,
    ...demons,
  ];

  if (selected.length !== n) {
    throw new Error(`Distribution mismatch: selected ${selected.length} characters for ${n} players`);
  }

  const shuffledCharacters = shuffle(selected);
  const shuffledPlayers = shuffle([...session.players.values()]);

  shuffledPlayers.forEach((player, index) => {
    const character = shuffledCharacters[index];
    if (!character) {
      throw new Error('Distribution mismatch: fewer characters selected than players');
    }
    player.character = character.id;
    player.characterType = character.type;
    player.alignment = character.alignment;
  });

  assignBluffs(session);
  assignDrunkCover(session);
  assignRedHerring(session);
  assignRegistrations(session);
  markDrunkStatus(session);
}

/**
 * Assigns exactly one fixed bluff character to each Evil player, chosen from
 * Townsfolk not in this game, distinct per player where possible. Computed
 * once at distribution time and stored on the PlayerRecord so it stays
 * stable across reconnects (recomputing it on every read would let it
 * silently change, which it should never do once the game has started).
 */
function assignBluffs(session: GameSession): void {
  const inPlayIds = new Set(
    [...session.players.values()].map((p) => p.character).filter((c): c is string => c !== null)
  );
  const unusedTownsfolk = shuffle(TROUBLE_BREWING_CHARACTERS.filter((c) => c.type === 'townsfolk' && !inPlayIds.has(c.id)));

  const evils = [...session.players.values()].filter((p) => p.alignment === 'evil');
  evils.forEach((player, index) => {
    // Cycle through the shuffled pool if there are more Evil players than
    // unused Townsfolk (rare, but possible at high player counts).
    const bluff = unusedTownsfolk.length > 0 ? unusedTownsfolk[index % unusedTownsfolk.length] : undefined;
    player.bluffCharacterId = bluff?.id ?? null;
  });
}

/**
 * Picks the Townsfolk a Drunk believes themself to be, and LOGS the choice.
 *
 * The Drunk must believe they are a Townsfolk character, so the cover is drawn
 * from Townsfolk that are NOT in play (otherwise they would learn their own
 * ability's answer). If every Townsfolk is in play, the pool falls back to the
 * whole Townsfolk list; that is a data edge case at high player counts, not a
 * real scenario, and it is logged.
 */
function assignDrunkCover(session: GameSession): void {
  const drunk = [...session.players.values()].filter((p) => p.character === 'drunk');
  if (drunk.length === 0) return;

  const inPlayIds = new Set(
    [...session.players.values()].map((p) => p.character).filter((c): c is string => c !== null)
  );
  /*
   * THE COVER MUST BE A CHARACTER WITH AN ABILITY THE DRUNK CAN USE.
   *
   * "You do not know you are the Drunk. You think you are a Townsfolk, and you are told
   * that there is a character whose abilities you think you have."
   *
   * The pool was every unused Townsfolk, which includes Soldier, Virgin and Slayer. All three
   * have abilities that do nothing on their own — the Soldier's is always-on protection, the
   * Virgin's and the Slayer's fire only when nominated — so a Drunk holding one is shown
   * their ability text at night, is prompted in a night order, and can never use any of it.
   * They are told they have a power and hold a rock.
   *
   * Excluded on the character's own terms rather than by a list kept in step by hand, so a
   * future character with the same problem is caught by whoever adds it. Anything with a
   * `firstNightOrder` or `otherNightOrder` is a character that acts at night and is therefore
   * usable; anything with neither cannot be.
   */
  const usableTownsfolk = (c: (typeof TROUBLE_BREWING_CHARACTERS)[number]) =>
    c.type === 'townsfolk' && (c.firstNightOrder !== null || c.otherNightOrder !== null);
  const unusedTownsfolk = TROUBLE_BREWING_CHARACTERS.filter((c) => !inPlayIds.has(c.id) && usableTownsfolk(c));
  // Falling back to the usable set, not to every Townsfolk: the fallback is what runs when
  // the table is small enough that the usable ones are all in play, and reaching for an
  // unusable one there would reintroduce the bug precisely when it is least noticeable.
  const pool = unusedTownsfolk.length > 0 ? unusedTownsfolk : charactersByType('townsfolk').filter(usableTownsfolk);
  const ordered = shuffle(pool);

  drunk.forEach((player, i) => {
    const cover = ordered[i % ordered.length]!;
    player.drunkCoverCharacterId = cover.id;
    logNightEvent(
      session,
      'setup-default',
      `Drunk cover chosen for ${player.displayName}: they believe they are the ${cover.name}. Override in the discretion panel.`
    );
  });
}

/**
 * Picks the Fortune Teller red herring and LOGS it. Fixed for the game unless
 * the Storyteller moves it, because the official text promises a Good player who
 * registers as a Demon to the Fortune Teller. A fixed one is learnable, which is
 * why the discretion panel can move it each night.
 */
function assignRedHerring(session: GameSession): void {
  const chosen = chooseRedHerring(session);
  if (!chosen) return;
  for (const player of session.players.values()) {
    player.fortuneTellerRedHerringPlayerId = chosen.playerId;
  }
  logNightEvent(
    session,
    'setup-default',
    `Fortune Teller red herring chosen: ${chosen.displayName} registers as the Demon to the Fortune Teller. Override in the discretion panel.`
  );
}

/**
 * Applies each eligible character's STICKY registration, and logs it.
 *
 * Default is "no lie" (registration stays null, i.e. the truth) for most
 * eligible players — see `chooseStickyRegistration` for why an engine that
 * always lied would be trivially detectable.
 */
function assignRegistrations(session: GameSession): void {
  for (const player of session.players.values()) {
    const def = player.character ? getCharacterById(player.character) : undefined;
    const registration = chooseStickyRegistration(session, player, def);
    if (!registration) {
      player.registration = { alignment: null, characterType: null };
      logNightEvent(
        session,
        'setup-default',
        `${player.displayName} (${def?.name ?? 'unknown'}) registers as themself — no lie generated. Set a registration in the discretion panel to lie.`
      );
      continue;
    }
    player.registration = registration;
    logNightEvent(
      session,
      'setup-default',
      `${player.displayName} (${def?.name ?? 'unknown'}) registers as ${registration.alignment} ${registration.characterType} to detection abilities. Override in the discretion panel.`
    );
  }
}

/**
 * A Drunk is permanently drunk. This is the flag the lie policy reads, so it is
 * what makes the Drunk receive unreliable rather than simply false information.
 */
function markDrunkStatus(session: GameSession): void {
  for (const player of session.players.values()) {
    if (player.character === 'drunk') {
      player.statusEffects.drunk = true;
      logNightEvent(session, 'setup-default', `${player.displayName} is the Drunk and receives unreliable information all game.`);
    }
  }
}

export function resetDistribution(session: GameSession): void {
  for (const player of session.players.values()) {
    player.character = null;
    player.characterType = null;
    player.alignment = null;
    player.alive = true;
    player.usedDeadVote = false;
    player.statusEffects = { poisoned: false, drunk: false, protected: false };
    player.hasNominatedToday = false;
    player.bluffCharacterId = null;
    player.registration = { alignment: null, characterType: null };
    player.drunkCoverCharacterId = null;
    player.fortuneTellerRedHerringPlayerId = null;
    player.butlerChoice = null;
    player.ravenkeeperWakePending = false;
  }
  session.impHeirChoice = null;
  session.virginHasTriggered = false;
  session.slayerHasUsed = false;
}

/**
 * The other Minions, as identities.
 *
 * "You learn who the other Minions are." — which is a list of NAMES, and is only granted
 * at 7 or more players. Below that there is no Minion information at all: a Minion in a
 * 5- or 6-player game is told they are a Minion, and nothing else.
 *
 * This used to send every other Evil player's TRUE CHARACTER NAME, at every player count.
 * That is the whole script handed to every Evil player in one payload, at the exact moment
 * the game starts, before anyone has said a word. It also told a Minion who the Demon was,
 * which the rules do not grant, and told a Drunk-as-Minion things that cannot be true.
 *
 * Two things are load-bearing and both are easy to undo by accident:
 *
 *  - the CHARACTER is gone from the payload entirely, so there is no second copy of this
 *    rule somewhere else to disagree with; and
 *  - it is filtered on `characterType === 'minion'`, not `alignment === 'evil'`, because
 *    a Minion learns about MINIONS. The Demon is deliberately not included — learning who
 *    the Demon is is a Storyteller decision in BOTC, not an automatic grant.
 */
function evilTeammatesOf(session: GameSession, selfId: string) {
  // "You learn who the other Minions are" is a 7+ grant. Six players is the single most
  // common table size, so this is the case that mattered.
  if (session.players.size < 7) return [];
  return [...session.players.values()]
    .filter((p) => p.playerId !== selfId && p.characterType === 'minion')
    .map((p) => ({
      playerId: p.playerId,
      displayName: p.displayName,
    }));
}

/**
 * Builds the per-recipient distribution payload for a single player. Never
 * includes other Good players' data.
 *
 * Typed as `OwnCharacterPayload` and not the wider `DistributionPayload` union, which also
 * contains the Storyteller's Grimoire. It only ever returns the player variant, and the wide
 * type meant `payload.teammates` did not typecheck at all — so the field carrying the
 * identities was untouchable from the server and from any test without a cast.
 *
 * THE DRUNK CASE IS A LIVE INFORMATION LEAK, AND IS HANDLED HERE. A Drunk was
 * previously sent `characterName: 'Drunk'` and the Outsider ability text "You do
 * not know you are the Drunk" — on a shared screen, or read aloud, or picked up
 * by a screen reader, that tells the whole table exactly who the Drunk is the
 * instant the Drunk opens the app. The payload now reports the COVER character:
 * name, ability, type and id all describe what they believe they are, and
 * `isDrunkCover` lets the client keep the cover stable without ever knowing the
 * truth.
 */
export function buildPlayerDistributionPayload(session: GameSession, player: PlayerRecord): OwnCharacterPayload {
  const trueDef = player.character ? getCharacterById(player.character) : undefined;
  if (!trueDef || !player.characterType || !player.alignment) {
    throw new Error(`Player ${player.playerId} has no character assigned yet`);
  }

  const isDrunk = player.character === 'drunk' && player.drunkCoverCharacterId !== null;
  const def = isDrunk ? getCharacterById(player.drunkCoverCharacterId!) ?? trueDef : trueDef;

  const base = {
    role: 'player' as const,
    playerId: player.playerId,
    character: def.id,
    characterName: def.name,
    // A Drunk believes they are a Townsfolk, so that is the type they see.
    characterType: isDrunk ? def.type : player.characterType,
    alignment: player.alignment,
    ability: def.ability,
  };

  if (player.alignment === 'evil') {
    const bluffDef = player.bluffCharacterId ? getCharacterById(player.bluffCharacterId) : undefined;
    return {
      ...base,
      teammates: evilTeammatesOf(session, player.playerId),
      bluff: bluffDef ? { id: bluffDef.id, name: bluffDef.name } : undefined,
    };
  }
  return base;
}
