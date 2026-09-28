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
  type DistributionPayload,
} from '@clocktower/shared';
import type { GameSession, PlayerRecord } from '../session/store.js';
import { Errors } from '../errors.js';

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
 * Randomly assigns exactly one Trouble Brewing character to each joined player,
 * using the official player-count distribution table. Mutates the session's
 * PlayerRecords in place.
 */
export function distributeRoles(session: GameSession): void {
  const n = session.players.size;
  if (!isValidPlayerCount(n)) {
    throw Errors.distributionRange(MIN_PLAYERS, MAX_PLAYERS);
  }

  const counts = getDistributionCounts(n);

  // Minions are selected FIRST: the Baron's setup modifier ("[+2 Outsiders]")
  // only applies when the Baron happens to be among the selected Minions,
  // so whether it applies can't be known until after this draw.
  const selectedMinions = sampleCharacters('minion', counts.minion);
  const hasBaron = selectedMinions.some((c) => c.id === 'baron');

  let townsfolkCount = counts.townsfolk;
  let outsiderCount = counts.outsider;
  if (hasBaron) {
    // Capped at the actual size of each pool: at most 2 more Outsiders than
    // the table calls for, and never more Townsfolk removed than the table
    // has to give (both are non-issues at every real Trouble Brewing player
    // count, but this keeps sampleCharacters from ever being asked for more
    // than exists).
    const bump = Math.min(2, townsfolkCount, charactersByType('outsider').length - outsiderCount);
    townsfolkCount -= bump;
    outsiderCount += bump;
  }

  const selected: CharacterDefinition[] = [
    ...sampleCharacters('townsfolk', townsfolkCount),
    ...sampleCharacters('outsider', outsiderCount),
    ...selectedMinions,
    ...sampleCharacters('demon', counts.demon),
  ];

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
  assignFortuneTellerRedHerring(session);
}

/**
 * Gives the Drunk a default cover character so they can be shown a real
 * character name/ability instead of the literal string "Drunk". Prefers a
 * Townsfolk not otherwise in play or already used as a bluff, but that's
 * just a nicer default -- the real game has no problem with the Drunk's
 * fake claim coinciding with a character someone else is genuinely
 * playing, so at high player counts (few/no unused Townsfolk left) this
 * correctly falls back to reusing one. This is a discretionary DEFAULT,
 * not a fixed rule; it's logged and overridable via setDiscretionOverride.
 */
function assignDrunkCover(session: GameSession): void {
  const drunkPlayer = [...session.players.values()].find((p) => p.character === 'drunk');
  if (!drunkPlayer) return;

  const inPlayIds = new Set(
    [...session.players.values()].map((p) => p.character).filter((c): c is string => c !== null)
  );
  const bluffIds = new Set(
    [...session.players.values()].map((p) => p.bluffCharacterId).filter((c): c is string => c !== null)
  );
  const candidates = TROUBLE_BREWING_CHARACTERS.filter(
    (c) => c.type === 'townsfolk' && !inPlayIds.has(c.id) && !bluffIds.has(c.id)
  );
  const cover = shuffle(candidates)[0] ?? shuffle(TROUBLE_BREWING_CHARACTERS.filter((c) => c.type === 'townsfolk'))[0];
  if (!cover) return;

  drunkPlayer.drunkCoverCharacterId = cover.id;
  session.discretionLog.push({
    kind: 'drunk-cover',
    playerId: drunkPlayer.playerId,
    value: cover.id,
    isOverride: false,
    at: Date.now(),
  });
}

/**
 * Gives the Fortune Teller a default red herring: one good, non-Fortune-
 * Teller player who will always register as the Demon to them. Per the
 * wiki's own advice this should stay consistent for the whole game once
 * set, which is why it's assigned once here rather than recomputed live.
 */
function assignFortuneTellerRedHerring(session: GameSession): void {
  const fortuneTeller = [...session.players.values()].find((p) => p.character === 'fortune-teller');
  if (!fortuneTeller) return;

  const candidates = [...session.players.values()].filter(
    (p) => p.playerId !== fortuneTeller.playerId && p.alignment === 'good'
  );
  const herring = shuffle(candidates)[0];
  if (!herring) return;

  fortuneTeller.fortuneTellerRedHerringId = herring.playerId;
  session.discretionLog.push({
    kind: 'fortune-teller-red-herring',
    playerId: fortuneTeller.playerId,
    value: herring.playerId,
    isOverride: false,
    at: Date.now(),
  });
}

/**
 * Lets the Storyteller override a previously-assigned discretionary
 * default. Always appends a new, timestamped, isOverride:true entry to the
 * log rather than mutating history, so every choice remains auditable.
 */
/** Resolves the raw discretionLog into Storyteller-facing display labels (character/player names instead of bare ids). */
export function buildDiscretionLogView(session: GameSession) {
  return session.discretionLog.map((entry) => {
    const player = session.players.get(entry.playerId);
    let valueLabel: string;
    if (entry.kind === 'fortune-teller-red-herring') {
      valueLabel = session.players.get(entry.value)?.displayName ?? 'Unknown';
    } else {
      valueLabel = getCharacterById(entry.value)?.name ?? entry.value;
    }
    return {
      kind: entry.kind,
      playerId: entry.playerId,
      playerDisplayName: player?.displayName ?? 'Unknown',
      valueLabel,
      isOverride: entry.isOverride,
      at: entry.at,
    };
  });
}

export function setDiscretionOverride(
  session: GameSession,
  kind: 'drunk-cover' | 'fortune-teller-red-herring',
  playerId: string,
  value: string
): void {
  const player = session.players.get(playerId);
  if (!player) throw Errors.playerNotFound();

  if (kind === 'drunk-cover') {
    player.drunkCoverCharacterId = value;
  } else {
    player.fortuneTellerRedHerringId = value;
  }

  session.discretionLog.push({ kind, playerId, value, isOverride: true, at: Date.now() });
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
    player.fortuneTellerRedHerringId = null;
    player.drunkCoverCharacterId = null;
    player.diedAtNightPending = false;
  }
  session.discretionLog = [];
}

function evilTeammatesOf(session: GameSession, selfId: string) {
  return [...session.players.values()]
    .filter((p) => p.playerId !== selfId && p.alignment === 'evil')
    .map((p) => ({
      playerId: p.playerId,
      displayName: p.displayName,
      character: p.character ?? '',
      characterName: p.character ? getCharacterById(p.character)?.name ?? '' : '',
    }));
}

/** Builds the per-recipient distribution payload for a single player. Never includes other Good players' data. */
export function buildPlayerDistributionPayload(session: GameSession, player: PlayerRecord): DistributionPayload {
  const def = player.character ? getCharacterById(player.character) : undefined;
  if (!def || !player.characterType || !player.alignment) {
    throw new Error(`Player ${player.playerId} has no character assigned yet`);
  }
  // The Drunk must not know they're the Drunk -- show them their assigned
  // cover character's name/ability instead of the literal string "Drunk"
  // (their characterType/alignment/id stay the true Outsider/good values
  // for every OTHER purpose -- Chef/Empath counts, win conditions, etc.
  // are computed off the real character, never the cover).
  const coverDef =
    def.id === 'drunk' && player.drunkCoverCharacterId ? getCharacterById(player.drunkCoverCharacterId) : undefined;
  const displayDef = coverDef ?? def;
  const base = {
    role: 'player' as const,
    playerId: player.playerId,
    character: def.id,
    characterName: displayDef.name,
    characterType: player.characterType,
    alignment: player.alignment,
    ability: displayDef.ability,
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
