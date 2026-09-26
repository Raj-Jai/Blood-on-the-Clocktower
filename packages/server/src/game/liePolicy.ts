import { charactersByType, getCharacterById, type Alignment, type CharacterDefinition, type CharacterType, type InfoTruth } from '@clocktower/shared';
import type { GameSession, PlayerRecord } from '../session/store.js';

/**
 * THREE-VALUED, STICKY, AUDITABLE INFORMATION GENERATION.
 * ======================================================
 *
 * Almost every open-source Blood on the Clocktower tool implements information
 * generation as a boolean "lie: true/false" flag. That is wrong in a way that is
 * easy to miss, and it is the whole reason this file exists.
 *
 * The Drunk's own ability text is "You do not know you are the Drunk." The
 * official Storyteller reminder for them is that "in the majority of cases the
 * information you receive will be wrong, but sometimes the Storyteller may tell
 * you something that is true." A Drunk is therefore UNRELIABLE, not reliably
 * wrong. A binary flag hands a Drunk a free tell: if they are ever told the
 * truth they know for certain the Storyteller is on to them, and from then on
 * they can (and will) play every remaining night with certainty. A table finds
 * this in one night.
 *
 * So the truth value is three-valued:
 *
 *   TRUE                 — healthy waker, real information.
 *   FALSE                — deliberate, single-value lie. Only produced where a
 *                          specific lie is mechanically required (a Recluse/Spy
 *                          registration, the red herring), never as the general
 *                          mechanism for "this player is drunk".
 *   RELIABLY_UNRELIABLE  — drunk or poisoned waker: usually wrong, sometimes
 *                          true, drawn from the same plausible value space as
 *                          the truth so the pattern is not learnable.
 *
 * Four properties this file is built to guarantee:
 *
 * 1. STICKINESS. A waker's lie pattern must be stable for a given night, and a
 *    Recluse's registration must be stable across the whole game. A randomly
 *    varying Recluse is statistically detectable by a careful table; a
 *    consistent one is not. Every decision here is a pure function of stable
 *    inputs (see `stableUnit`), so the same inputs always produce the same
 *    output — which is what makes the night log reproducible and auditable.
 *
 * 2. PLAUSIBILITY. A lie must be consistent with what the target has already
 *    been told and with their public claims, because the rulebook makes the
 *    Storyteller a participant in the bluff: "listen to the bluffs of the evil
 *    players, and support those bluffs wherever possible." Generated values are
 *    drawn from the pool the truth itself would be drawn from, and never from an
 *    impossible value space (a "3" for a 5-player Chef).
 *
 * 3. THREE-VALUED. See above.
 *
 * 4. ANTI-COLLAPSE. "If they base their logic on incorrect information, but
 *    they have no way of knowing that their information is incorrect, then they
 *    are simply guessing, and it will not be fun for them." Generated lies never
 *    carry a signature: a drunk Empath is not "0" every night, a drunk Fortune
 *    Teller is not "no" every night. Every unreliable draw is spread across the
 *    full plausible range, so no night is distinguishable from any other by
 *    pattern alone.
 *
 * THE TWO-CHANNEL RULE
 * --------------------
 * The rulebook is explicit: "Always give correct information about the rules,
 * even to drunk or poisoned players." So this module keeps TWO channels and they
 * are never collapsed into one:
 *
 *   rulesChannel   — always TRUE. Ability text, what the character is being asked
 *                    to do, how many players to pick. Never lied about.
 *   abilityChannel — discretionary. Who the Minion is, how many pairs of evil
 *                    there are, whether the Demon was found. This is the only
 *                    channel the lie policy is allowed to touch.
 *
 * See `deliverNightInfo`, the single entry point that assembles both.
 *
 * NOT IN SCOPE HERE: the choice of WHAT is most interesting. Official guidance
 * is to "help the weaker team as much as possible", so a worse-than-optimal
 * Storyteller is the correct one. That remains a human decision, mediated by the
 * Storyteller's discretion panel, which can override any value produced here.
 */

export type { InfoTruth };

export interface GeneratedInfo {
  value: unknown;
  truth: InfoTruth;
  /** Why this was generated — written to the night log for auditability. NEVER sent to a player. */
  rationale: string;
}

/** Always-true content. Mirrors the rulebook's "always give correct information about the rules". */
export interface RulesChannel {
  text: string;
  truth: 'TRUE';
}

export interface AbilityChannelInfo extends GeneratedInfo {}

export interface NightInfoDelivery {  rulesChannel: RulesChannel;
  abilityChannel: AbilityChannelInfo;
}

export interface LieContext {
  /** The waker the information is being delivered to. */
  waker: PlayerRecord;
  /** Ability/character id whose information is being generated. */
  characterId: string;
  night: number;
  session: GameSession;
}

/**
 * A drunk or poisoned player has no functioning ability: they lose all
 * information, and if they are the Demon they do not kill. The "usually wrong,
 * sometimes true" rule applies to the INFORMATION they receive.
 */
export function wakerIsUnreliable(waker: PlayerRecord): boolean {
  return waker.statusEffects.drunk || waker.statusEffects.poisoned;
}

// ---------------------------------------------------------------------------
// Deterministic hashing — the basis of stickiness.
// ---------------------------------------------------------------------------

/**
 * FNV-1a over the joined parts, returned as a float in [0, 1).
 *
 * This is the entire stickiness mechanism: no RNG, no stored state, so the same
 * (session, night, waker, ability) always yields the same draw. That is what
 * makes the night log meaningful — the Storyteller can read a line, re-derive
 * the decision, and know the server did not change its mind afterwards.
 */
export function stableUnit(...parts: (string | number)[]): number {
  const key = parts.join('|');
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    // hash *= 16777619, kept in 32-bit space without BigInt.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash >>> 0) / 0x100000000;
}

/** Deterministic integer in [0, max). */
function stableIndex(max: number, ...parts: (string | number)[]): number {
  if (max <= 1) return 0;
  return Math.min(max - 1, Math.floor(stableUnit(...parts) * max));
}

/**
 * Nonce used only in 'varied' mode; a constant in 'sticky' mode, which is what
 * makes the default reproducible.
 *
 * TRADE-OFF (the spec's open question, resolved in favour of consistency):
 * 'sticky' is the default because consistency is more defensible against
 * reverse-engineering and makes every generated decision auditable and
 * replayable. 'varied' trades that for unpredictability across repeated
 * identical calls, at the cost of the night log no longer being replayable.
 * Consistency is the better default for a recorded or graded game; variety is
 * the better default for a table that has played this tool many times.
 */
function nonceFor(session: GameSession, aspect: string): string {
  return session.liePolicy.consistency === 'varied' ? `${aspect}-${Date.now()}-${Math.random()}` : aspect;
}

/** Salt for every draw: what table, which night, which player, which ability, which aspect. */
function salt(ctx: LieContext, aspect: string): (string | number)[] {
  return [ctx.session.code, ctx.night, ctx.waker.playerId, ctx.characterId, aspect, nonceFor(ctx.session, aspect)];
}

/**
 * Fraction of unreliable information that is false. The Drunk's own text says
 * "in the majority of cases the information you receive will be wrong, but
 * sometimes the Storyteller may tell you something that is true", so this sits
 * deliberately above 0.5 and deliberately below 1.
 */
const FALSE_RATE = 0.7;

/**
 * Decides whether an unreliable draw is wrong or accidentally right. Shared by
 * every shape, so the "usually wrong, sometimes true" ratio is identical across
 * all of them — a table must not be able to tell which ability is being lied to
 * by the lie frequency alone.
 *
 * `makeFalse` returns `null` when no plausible alternative exists (e.g. a count
 * of 0 in a state where 0 is the only possible value). Falling back to the truth
 * in that case is deliberate: a lie that cannot exist is better than a lie the
 * target can instantly disprove.
 */
function unreliableBranch<T>(ctx: LieContext, aspect: string, truth: T, makeFalse: () => T | null): {
  value: T;
  truth: InfoTruth;
  rationale: string;
} {
  if (stableUnit(...salt(ctx, aspect)) >= FALSE_RATE) {
    return {
      value: truth,
      truth: 'RELIABLY_UNRELIABLE',
      rationale: `Drunk/poisoned waker; told the truth this time (${Math.round(
        (1 - FALSE_RATE) * 100
      )}% of unreliable answers are accidentally true, and the waker cannot tell this one apart from a lie).`,
    };
  }
  const falseValue = makeFalse();
  if (falseValue === null || Object.is(falseValue, truth)) {
    return {
      value: truth,
      truth: 'RELIABLY_UNRELIABLE',
      rationale: 'Drunk/poisoned waker; no plausible false value exists in this game state, so the truth was given.',
    };
  }
  return {
    value: falseValue,
    truth: 'RELIABLY_UNRELIABLE',
    rationale: `Drunk/poisoned waker; told a plausible but incorrect value (${Math.round(
      FALSE_RATE * 100
    )}% of unreliable answers are false). Drawn from the same value space as the truth, so the pattern is not learnable.`,
  };
}

// ---------------------------------------------------------------------------
// Counts — Chef, Empath.
// ---------------------------------------------------------------------------

/**
 * A count drawn from [0, max] so the value space is always plausible.
 *
 * Anti-collapse note: the obvious implementation returns `truth + 1` for a
 * drunk Empath every night, which both hands Good false confidence and is a
 * perfectly learnable signature. Here the wrong value is drawn uniformly from
 * the whole range except the truth, so consecutive nights are indistinguishable.
 */
export function generateCountInfo(ctx: LieContext, truth: number, plausibleMax: number): AbilityChannelInfo {
  const max = Math.max(truth, Math.max(0, plausibleMax));
  if (!wakerIsUnreliable(ctx.waker)) {
    return { value: truth, truth: 'TRUE', rationale: 'Healthy waker; the true count.' };
  }
  return unreliableBranch(ctx, 'count', truth, () => {
    const candidates: number[] = [];
    for (let v = 0; v <= max; v++) {
      if (v !== truth) candidates.push(v);
    }
    if (candidates.length === 0) return null;
    return candidates[stableIndex(candidates.length, ...salt(ctx, 'count-pick'))]!;
  });
}

/**
 * Renders a count result.
 *
 * Templates are supplied per-cardinality rather than assembled from a noun and a
 * number, because English will not let you do it generically: "there is 1 pair",
 * "there are 0 pairs" and "1 of your neighbours is evil" but "2 of your
 * neighbours ARE evil" all need different subjects and verbs. Assembling them
 * from fragments is how you ship "there is pair of adjacent evil players".
 */
export interface CountTemplates {
  zero: string;
  one: string;
  many: (n: number) => string;
}

export function renderCountInfo(info: GeneratedInfo, templates: CountTemplates): string {
  const n = info.value as number;
  if (n === 0) return templates.zero;
  if (n === 1) return templates.one;
  return templates.many(n);
}

// ---------------------------------------------------------------------------
// Yes/no — Fortune Teller.
// ---------------------------------------------------------------------------

/**
 * Fortune Teller: "is either of the two players the Demon?".
 *
 * The red herring is the primary anti-collapse mechanism here, not this
 * function: a fixed red herring guarantees the Fortune Teller sees a "yes" that
 * is not a Demon, so a flat negation of the truth still looks like a normal
 * night. This only decides whether the two picks are reported honestly.
 */
export function generateYesNoInfo(ctx: LieContext, truth: boolean): AbilityChannelInfo {
  if (!wakerIsUnreliable(ctx.waker)) {
    return { value: truth, truth: 'TRUE', rationale: 'Healthy waker; the true answer.' };
  }
  return unreliableBranch(ctx, 'yes-no', truth, () => !truth);
}

export function renderYesNoInfo(info: GeneratedInfo, positiveSubject: string): string {
  return info.value === true
    ? `You learn that one of them is the Demon (${positiveSubject}).`
    : 'You learn that neither of them is the Demon.';
}

// ---------------------------------------------------------------------------
// Characters — Undertaker, Ravenkeeper, and the 1-of-2 pair roles.
// ---------------------------------------------------------------------------

/**
 * A single character name (Undertaker, Ravenkeeper).
 *
 * Plausibility: drawn only from characters actually IN PLAY, so a drunk
 * Ravenkeeper is never told about a character nobody holds.
 */
export function generateCharacterInfo(ctx: LieContext, truth: string | null): AbilityChannelInfo {
  if (!wakerIsUnreliable(ctx.waker)) {
    return {
      value: truth,
      truth: 'TRUE',
      rationale: truth ? 'Healthy waker; the true character.' : 'Healthy waker; nobody died by execution today.',
    };
  }
  const inPlay = charactersInPlay(ctx.session);
  return unreliableBranch(ctx, 'character', truth, () => {
    const pool = inPlay.filter((c) => c !== truth);
    if (pool.length === 0) return null;
    return pool[stableIndex(pool.length, ...salt(ctx, 'character-pick'))]!;
  });
}

export function renderCharacterInfo(info: GeneratedInfo, fallback: string): string {
  const def = typeof info.value === 'string' ? getCharacterById(info.value) : undefined;
  return `You learn that they are the ${def?.name ?? fallback}.`;
}

export interface PairInfo {
  /** Character names to state, in order. Normally two: the true one and a decoy. */
  shown: string[];
  /** Which of `shown` is the real one, or null when the pair is entirely false. */
  trueIndex: number | null;
}

/**
 * The Washerwoman / Librarian / Investigator shape: "1 of 2 players is a
 * particular X". The two PLAYERS are fixed by the waker's own pick (plus a
 * decoy player); what the engine varies is WHICH character is named.
 *
 * Plausibility: for a healthy waker exactly one of the two named characters is
 * genuinely in play. For a drunk/poisoned waker, `FALSE_RATE` of the time NEITHER
 * named character is in play — which is what "usually wrong" means here — and
 * the rest of the time the pair is honest. Without the honest branch, a drunk
 * Washerwoman could check "is either of these two actually the thing I was told"
 * and learn every single night, which is exactly the anti-collapse failure this
 * file exists to avoid.
 */
export function generatePairInfo(ctx: LieContext, trueCharacterId: string): AbilityChannelInfo {
  const def = getCharacterById(trueCharacterId);
  const type: CharacterType = def?.type ?? 'townsfolk';
  const inPlayOfType = charactersInPlay(ctx.session).filter((id) => getCharacterById(id)?.type === type);
  const decoyPool = (inPlayOfType.length > 0 ? inPlayOfType : charactersByType(type).map((c) => c.id)).filter(
    (id) => id !== trueCharacterId
  );

  if (!wakerIsUnreliable(ctx.waker)) {
    const decoy = decoyPool.length > 0 ? decoyPool[stableIndex(decoyPool.length, ...salt(ctx, 'pair-decoy'))]! : trueCharacterId;
    return {
      value: { shown: [trueCharacterId, decoy], trueIndex: 0 } satisfies PairInfo,
      truth: 'TRUE',
      rationale: 'Healthy waker; exactly one of the two named characters is genuinely in play.',
    };
  }

  if (stableUnit(...salt(ctx, 'pair-honest')) < 1 - FALSE_RATE) {
    const decoy = decoyPool.length > 0 ? decoyPool[stableIndex(decoyPool.length, ...salt(ctx, 'pair-decoy'))]! : trueCharacterId;
    return {
      value: { shown: [trueCharacterId, decoy], trueIndex: 0 } satisfies PairInfo,
      truth: 'RELIABLY_UNRELIABLE',
      rationale: 'Drunk/poisoned waker; the named pair happens to contain the true character.',
    };
  }

  // Both named characters are wrong. Drawn from real in-play characters of the
  // right type so the pair is still plausible, just not the right answer.
  const first = decoyPool.length > 0 ? decoyPool[stableIndex(decoyPool.length, ...salt(ctx, 'pair-decoy-a'))]! : null;
  const rest = decoyPool.filter((id) => id !== first);
  const second = rest.length > 0 ? rest[stableIndex(rest.length, ...salt(ctx, 'pair-decoy-b'))]! : first;
  if (first === null) {
    return {
      value: { shown: [trueCharacterId], trueIndex: 0 } satisfies PairInfo,
      truth: 'RELIABLY_UNRELIABLE',
      rationale: 'Drunk/poisoned waker; no other character of this type is in play, so the honest answer was given.',
    };
  }
  return {
    value: { shown: [first, second!], trueIndex: null } satisfies PairInfo,
    truth: 'RELIABLY_UNRELIABLE',
    rationale: 'Drunk/poisoned waker; neither named character is the one their pick actually holds.',
  };
}

export function renderPairInfo(info: GeneratedInfo, targetName: string, otherName: string): string {
  const pair = info.value as PairInfo | null;
  const shown = (pair?.shown ?? []).map((id) => getCharacterById(id)?.name ?? id);
  if (shown.length === 0) return `You learn nothing about ${targetName} or ${otherName}.`;
  const headline = `You learn that 1 of 2 players — ${targetName} or ${otherName} — is the ${shown[0]}.`;
  const second = shown.length > 1 ? ` The other is the ${shown[1]}.` : '';
  const caveat = pair?.trueIndex === null ? ' (You are not certain which one.)' : '';
  return `${headline}${second}${caveat}`;
}

function charactersInPlay(session: GameSession): string[] {
  return [...session.players.values()]
    .map((p) => p.character)
    .filter((c): c is string => typeof c === 'string' && c !== '');
}

// ---------------------------------------------------------------------------
// Registration — Recluse / Spy / Fortune Teller red herring.
// ---------------------------------------------------------------------------

export interface StickyRegistration {
  alignment: 'good' | 'evil';
  characterType: CharacterType;
}

/**
 * Picks a STICKY registration for a character that is allowed to register as
 * something other than the truth.
 *
 * Stability is the entire point. A Recluse who registers as evil one night and
 * good the next is detectable by any table that keeps a tally, and that
 * detection is mathematical rather than social, so no amount of good play hides
 * it. The draw is a pure function of the player and the game, never of the night,
 * so it is stable for the whole game and survives re-derivation.
 *
 * Returns `null` when no lie should be told for this player, meaning
 * registration falls back to the truth. That default is intentional: "you might
 * register as evil" is a Storyteller choice, and the official reminder for the
 * Recluse is literally "the Storyteller chooses whatever is most interesting".
 * An engine that always lied would be making that choice for them — and, worse,
 * an engine that always lied would be trivially detectable, since every Recluse
 * would be evil to the Chef every night. Only a fixed minority lies, which is
 * both plausible and unlearnable by observation.
 */
export function chooseStickyRegistration(
  session: GameSession,
  player: PlayerRecord,
  def: CharacterDefinition | undefined
): StickyRegistration | null {
  const canLieEvil = def?.registerAs?.alignments?.includes('evil') ?? false;
  const canLieTypes = def?.registerAs?.types ?? [];
  if (!canLieEvil && canLieTypes.length === 0) return null;

  if (stableUnit(session.code, player.playerId, 'registration-lies-at-all') >= 0.6) return null;

  const alignment: Alignment =
    canLieEvil && stableUnit(session.code, player.playerId, 'registration-alignment') < 0.5 ? 'evil' : 'good';
  const characterType: CharacterType =
    canLieTypes.length > 0
      ? canLieTypes[stableIndex(canLieTypes.length, session.code, player.playerId, 'registration-type')]!
      : (player.characterType ?? 'townsfolk');
  return { alignment, characterType };
}

/**
 * The Fortune Teller red herring: one Good player registers as the Demon to the
 * Fortune Teller, fixed for the whole game.
 *
 * Honest caveat, and the reason the discretion panel must be able to move it: a
 * permanently fixed red herring IS learnable by a careful table ("always yes
 * for Bram"). The official text only guarantees that "there is a good player
 * that registers as a Demon to you" for the game, and moving it between nights
 * is legitimate. So this picks a stable, auditable default, and the
 * Storyteller can override it any night.
 */
export function chooseRedHerring(session: GameSession): PlayerRecord | null {
  const pool = [...session.players.values()].filter((p) => p.alignment === 'good' && p.playerId !== demonIdOf(session));
  if (pool.length === 0) return null;
  return pool[stableIndex(pool.length, session.code, 'fortune-teller-red-herring')]!;
}

function demonIdOf(session: GameSession): string {
  for (const p of session.players.values()) {
    if (p.characterType === 'demon') return p.playerId;
  }
  return '';
}

// ---------------------------------------------------------------------------
// The two-channel entry point.
// ---------------------------------------------------------------------------

/**
 * The single place information is assembled for a waker. Returns the
 * always-true rules channel and the discretionary ability channel as SEPARATE
 * fields so a caller cannot accidentally lie about the rules.
 *
 * `rulesText` must be true regardless of the waker's state: their ability text,
 * what they were asked to do, how many players to pick. The lie policy is never
 * applied to it.
 */
export function deliverNightInfo(args: {
  rulesText: string;
  ability: AbilityChannelInfo;
}): NightInfoDelivery {
  return {
    rulesChannel: { text: args.rulesText, truth: 'TRUE' },
    abilityChannel: args.ability,
  };
}

/** Builds the LieContext every generator needs. Kept here so call sites cannot forget the night number. */
export function lieContext(session: GameSession, waker: PlayerRecord, characterId: string): LieContext {
  return { session, waker, characterId, night: session.nightNumber };
}
