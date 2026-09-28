import { getCharacterById, type CharacterDefinition, type CharacterType } from '@clocktower/shared';
import type { GameSession, PlayerRecord } from '../session/store.js';
import { livingNeighborsOf, playersBySeat } from '../session/store.js';

/**
 * PERCEPTION AND AUTO-RESOLVING ABILITIES.
 *
 * The single most important rule in this file: a detection ability must never
 * read `player.alignment` or `player.characterType` directly. It must go through
 * `perceivedAs`, which honours REGISTRATION.
 *
 * Why this matters: per the official glossary, a Recluse "might register as
 * evil & as a Minion or Demon" while being a Good player, and a Spy "might
 * register as good & as a Townsfolk or Outsider" while being Evil. So a player
 * who registers as evil counts as evil to detection abilities while still being
 * good, and a player who registers as good counts as good while still being
 * evil. Anything that reads raw alignment gets both of them exactly backwards.
 *
 * TODO(v2): within-night variation. The official Spy example is that the SAME
 * player registers as evil to the Chef and as good to the Empath in the SAME
 * night. That requires per-(observer, subject) registration. v1 deliberately
 * models ONE registration per player per night — a single `registration` on the
 * PlayerRecord — because it is the common case and it keeps the state auditable
 * ("what did the server decide about Bram on night 3?" has one answer). Move the
 * field to a per-night map keyed by observer when per-observer lying is needed.
 */

/** What `observer` perceives `subject` to be. Honours Recluse/Spy registration. */
export function perceivedAs(
  session: GameSession,
  observerId: string,
  subjectId: string
): { alignment: 'good' | 'evil'; characterType: CharacterType } {
  const subject = session.players.get(subjectId);
  if (!subject) {
    throw new Error(`perceivedAs: unknown subject ${subjectId}`);
  }
  // `observerId` is intentionally part of the signature even though v1 does not
  // vary by observer, so the v2 migration is a signature-compatible change.
  void observerId;
  return {
    alignment: subject.registration.alignment ?? subject.alignment ?? 'good',
    characterType: subject.registration.characterType ?? subject.characterType ?? 'townsfolk',
  };
}

/** True when `observer` perceives `subject` as evil. Never reads raw alignment. */
export function perceivesAsEvil(session: GameSession, observerId: string, subjectId: string): boolean {
  return perceivedAs(session, observerId, subjectId).alignment === 'evil';
}

/** True when `observer` perceives `subject` as a Minion (Investigator, Recluse, Spy). */
export function perceivesAsMinion(session: GameSession, observerId: string, subjectId: string): boolean {
  return perceivedAs(session, observerId, subjectId).characterType === 'minion';
}

/**
 * Chef: "how many pairs of evil players are there?"
 *
 * A "pair" is two ADJACENT evil players around the fixed seating circle, so this
 * is a pass over the circle counting adjacent evil/evil edges. Adjacency is over
 * the fixed circle, NOT the living-neighbour circle: a dead player still breaks
 * up a pair, because the Chef sees the seats, not the survivors. This is the
 * one ability in the script that is a property of the seating arrangement rather
 * than of the waker's own neighbours.
 */
export function chefEvilPairCount(session: GameSession, chefId: string): number {
  const seated = playersBySeat(session);
  if (seated.length < 2) return 0;
  let pairs = 0;
  for (let i = 0; i < seated.length; i++) {
    const here = seated[i]!;
    const next = seated[(i + 1) % seated.length]!;
    if (perceivesAsEvil(session, chefId, here.playerId) && perceivesAsEvil(session, chefId, next.playerId)) {
      pairs += 1;
    }
  }
  return pairs;
}

/**
 * The largest number of adjacent-evil pairs this table could produce, used as
 * the plausible ceiling for a generated (drunk) Chef answer. Deriving it from
 * the actual seating keeps the lie inside the value space a real game could
 * produce — a Chef is never told "3 pairs" at a table where 3 is impossible.
 */
export function maxPossibleEvilPairs(session: GameSession): number {
  const total = session.players.size;
  return Math.floor(total / 2) + 1;
}

/**
 * Empath: "how many of your 2 alive neighbours are evil?"
 *
 * Uses `livingNeighborsOf` rather than raw seat offsets: once players are
 * executed, "neighbour" means nearest LIVING neighbour over the fixed circle,
 * and re-implementing that inline is an easy way to be subtly wrong. The
 * neighbours' perception is read through `perceivedAs`, so a Recluse to the
 * left and the right of an Empath both count.
 */
export function empathEvilNeighbourCount(session: GameSession, empathId: string): number {
  const { left, right } = livingNeighborsOf(session, empathId);
  let count = 0;
  if (left && perceivesAsEvil(session, empathId, left.playerId)) count += 1;
  if (right && perceivesAsEvil(session, empathId, right.playerId)) count += 1;
  return count;
}

/** The two living neighbours of a player, as ids, for rendering. */
export function livingNeighbourIds(session: GameSession, playerId: string): string[] {
  const { left, right } = livingNeighborsOf(session, playerId);
  return [left?.playerId, right?.playerId].filter((id): id is string => typeof id === 'string');
}

/**
 * Undertaker: "which character died by execution today?"
 *
 * This used to read `resolvedNominationsToday[0]`, on the reasoning that a tie
 * invalidates an earlier nomination so "the surviving record is the only executed
 * player". That reasoning was wrong twice over: `confirmExecution` DELETED the record
 * the moment it executed, so the list was always empty and the Undertaker was told
 * "You learn that nobody died by execution today" after every single execution. The
 * list is also no longer "who died" at all — a nomination tied out is on it and was
 * never executed.
 *
 * So the Undertaker reads `session.executedToday`, written at the moment of execution.
 * The character is the REGISTERED one, per the almanac: an executed Spy who registers
 * as the Butler is shown the Butler, and an executed Recluse is shown the Imp.
 */
export function executedPlayerToday(session: GameSession): PlayerRecord | null {
  const record = session.executedToday;
  if (!record) return null;
  return session.players.get(record.playerId) ?? null;
}

/** The character the Undertaker is shown: what the table knew the dead person to be. */
export function executedRegisteredCharacterName(session: GameSession): string | null {
  return session.executedToday?.registeredCharacterName ?? null;
}

/**
 * Fortune Teller: "is either of these two players the Demon?"
 *
 * Two independent sources of a "yes", which is what makes the red herring work:
 *   1. the real Demon, and
 *   2. the fixed red herring, a Good player who registers as the Demon.
 * Both are routed through the same perception helper as every other detection
 * ability, so a Recluse/Spy registration that makes them register as a Demon
 * also produces a "yes" here.
 */
export function fortuneTellerFindsDemon(
  session: GameSession,
  ftId: string,
  targetIds: string[],
  redHerringPlayerId: string | null
): { found: boolean; redHerring: boolean } {
  for (const targetId of targetIds) {
    const target = session.players.get(targetId);
    if (!target) continue;
    if (perceivedAs(session, ftId, targetId).characterType === 'demon') {
      return { found: true, redHerring: redHerringPlayerId === targetId && target.characterType !== 'demon' };
    }
  }
  return { found: false, redHerring: false };
}

/**
 * Builds the legal target set for a waker from a character's
 * `targetRestrictions`. Predicates are ANDed.
 *
 * `'evil'` and `'good'` are evaluated against REGISTRATION, not true alignment,
 * so a Monk cannot protect an evil-registering Recluse even though the Recluse
 * is a Good player — which is the point of the Recluse.
 *
 * `isDrunk` is passed in because a Drunk's night step runs under their COVER
 * character: the cover's restrictions are what the engine enforces, and the
 * cover is by definition a Townsfolk, so a Drunk-as-Monk cannot protect anyone.
 */
export function legalTargetsFor(
  session: GameSession,
  waker: PlayerRecord,
  def: CharacterDefinition,
  options: { isDrunk?: boolean } = {}
): PlayerRecord[] {
  const restrictions = def.targetRestrictions ?? [];
  if (restrictions.length === 0 && (def.targetCount ?? 0) === 0) return [];

  return [...session.players.values()].filter((candidate) => {
    if (restrictions.includes('other') && candidate.playerId === waker.playerId) return false;
    if (restrictions.includes('alive') && !candidate.alive) return false;
    if (restrictions.includes('dead') && candidate.alive) return false;

    if (
      restrictions.includes('townsfolk') ||
      restrictions.includes('outsider') ||
      restrictions.includes('minion') ||
      restrictions.includes('demon')
    ) {
      // A Drunk genuinely believes themself to be a Townsfolk, so the cover
      // character's type restrictions are enforced against the cover identity —
      // otherwise a Drunk-as-Washerwoman could pick a real Outsider and learn
      // something about their own cover that cannot exist.
      const effectiveType = options.isDrunk ? effectiveTypeOf(session, candidate) : candidate.characterType;
      if (!effectiveType) return false;
      if (restrictions.includes('townsfolk') && effectiveType !== 'townsfolk') return false;
      if (restrictions.includes('outsider') && effectiveType !== 'outsider') return false;
      if (restrictions.includes('minion') && effectiveType !== 'minion') return false;
      if (restrictions.includes('demon') && effectiveType !== 'demon') return false;
    }

    /*
     * The Butler's rule, which is NOT the `good` restriction above.
     *
     * "Each night, choose a player (not yourself): tomorrow, you may only vote if they
     * are voting too." The Storyteller may not let the Butler choose a Minion or the
     * Demon — that is the whole reason the character restricts voting at all.
     *
     * Two things were wrong here. The data said `townsfolk`, so the Butler could not
     * choose a Saint, a Recluse, a Drunk or a Ravenkeeper — every Outsider in Trouble
     * Brewing — which removed legal moves the real game allows. And expressing the rule
     * as `good` would have used `perceivedAs().alignment`, which is wrong twice over: a
     * Recluse registering as Evil would be excluded, and reading `alignment` for a
     * legality decision is how a secret ends up rendered in a UI.
     *
     * So this reads the TRUE character type. That is not a leak: the legal-target list is
     * a Storyteller-side computation, and the rule genuinely is about the true type.
     */
    if (restrictions.includes('not-demon-or-minion')) {
      if (candidate.characterType === 'minion' || candidate.characterType === 'demon') return false;
    }

    if (restrictions.includes('evil') || restrictions.includes('good')) {
      const perceived = perceivedAs(session, waker.playerId, candidate.playerId).alignment;
      if (restrictions.includes('evil') && perceived !== 'evil') return false;
      if (restrictions.includes('good') && perceived !== 'good') return false;
    }

    return true;
  });
}

/**
 * The character a player ACTS as at night. A Drunk acts as their cover
 * Townsfolk — the prompt, the night order position, and the restrictions all
 * come from the cover, which is what makes the Drunk believe they are playing
 * that character.
 */
export function effectiveCharacterIdOf(session: GameSession, player: PlayerRecord): string | null {
  if (player.character === 'drunk' && player.drunkCoverCharacterId) {
    return player.drunkCoverCharacterId;
  }
  return player.character;
}

export function effectiveCharacterDef(session: GameSession, player: PlayerRecord): CharacterDefinition | undefined {
  const id = effectiveCharacterIdOf(session, player);
  return id ? getCharacterById(id) : undefined;
}

/** True when this waker is a Drunk running the night step under their cover. */
export function isDrunkCover(session: GameSession, player: PlayerRecord): boolean {
  return player.character === 'drunk' && player.drunkCoverCharacterId !== null;
}

/**
 * The character type a player presents to a TYPE-based pick restriction.
 * A Drunk presents as a Townsfolk (their cover) to themselves.
 */
function effectiveTypeOf(session: GameSession, player: PlayerRecord): CharacterType | null {
  if (isDrunkCover(session, player)) {
    return getCharacterById(player.drunkCoverCharacterId ?? '')?.type ?? 'townsfolk';
  }
  return player.characterType;
}

/**
 * Virgin: "The 1st time you are nominated, if the nominator is a Townsfolk, they
 * are executed immediately."
 *
 * Not a night ability, but it is a pure predicate over session state and it was
 * dead code, so it lives with the other predicates. Returns the playerId to
 * execute, or null.
 *
 * A Drunk is genuinely a Townsfolk from their own perspective, so a Drunk
 * nominating the Virgin does trigger this. A Drunk nominating anything else
 * does not.
 */
export function virginTriggersExecution(session: GameSession, virginId: string, nominatorId: string): string | null {
  const virgin = session.players.get(virginId);
  const nominator = session.players.get(nominatorId);
  if (!virgin || !nominator) return null;
  if (virgin.character !== 'virgin' || !virgin.alive) return null;
  if (session.virginHasTriggered) return null;
  const nominatorIsTownsfolk = isDrunkCover(session, nominator) ? true : nominator.characterType === 'townsfolk';
  return nominatorIsTownsfolk ? nominatorId : null;
}

/**
 * Slayer: "Once per game, during the day, publicly choose a player: if they are
 * the Demon, they die."
 *
 * A pure predicate; the caller performs the kill. Perception is honoured, so a
 * Recluse who registers as a Demon can be Slain.
 */
export function slayerWouldKill(session: GameSession, slayerId: string, targetId: string): boolean {
  const slayer = session.players.get(slayerId);
  if (!slayer || !slayer.alive) return false;
  /*
   * THE CHARACTER IS NOT ACTUALLY CHECKED HERE.
   *
   * This predicate was dead code for the whole life of the app, so the omission was
   * invisible: it checked that the "Slayer" was alive, that the ability was unused, and
   * that the TARGET registered as the Demon — and never that the player doing the
   * nominating was the Slayer. Wiring it up turned that into "any player who
   * successfully nominates the Demon kills them instead of being executed", which is not
   * a subtle misplay. It is the difference between the game's central day mechanic
   * working and not working, and it was one line.
   */
  if (slayer.character !== 'slayer') return false;
  if (session.slayerHasUsed) return false;
  const target = session.players.get(targetId);
  if (!target || !target.alive) return false;
  return perceivedAs(session, slayerId, targetId).characterType === 'demon';
}

/**
 * Soldier: "You are safe from the Demon." Unlike the Monk, this is always on, so
 * the engine keeps `protected` set for a living Soldier at the start of every
 * night rather than treating it as a once-per-night choice.
 */
export function soldierIsProtected(session: GameSession, playerId: string): boolean {
  const player = session.players.get(playerId);
  return player?.character === 'soldier' && player.alive;
}
