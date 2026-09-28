import type { Server as SocketIOServer } from 'socket.io';
import {
  ServerEvents,
  getCharacterById,
  type CharacterDefinition,
  type InfoTruth,
  type InfoType,
  type NightLogPayload,
  type NightOrderStepView,
  type NightOrderUpdatePayload,
  type NightPromptPayload,
  type NightResolvedPayload,
} from '@clocktower/shared';
import type { GameSession, NightStepState, NightState, PlayerRecord } from '../session/store.js';
import { logNightEvent } from '../session/store.js';
import { buildGrimoire, sendToPlayer, sendToStoryteller } from './broadcast.js';
import { Errors } from '../errors.js';
import {
  chefEvilPairCount,
  empathEvilNeighbourCount,
  executedPlayerToday,
  executedRegisteredCharacterName,
  effectiveCharacterDef,
  fortuneTellerFindsDemon,
  isDrunkCover,
  legalTargetsFor,
  maxPossibleEvilPairs,
  soldierIsProtected,
} from './abilities.js';
import { resolveDemonKill } from './demonKill.js';
import {
  deliverNightInfo,
  generateCharacterInfo,
  generateCountInfo,
  generatePairInfo,
  generateYesNoInfo,
  lieContext,
  renderCharacterInfo,
  renderCountInfo,
  renderPairInfo,
  renderYesNoInfo,
  wakerIsUnreliable,
  type GeneratedInfo,
} from './liePolicy.js';

/**
 * THE NIGHT ENGINE.
 *
 * Turns the Storyteller's verbal night ritual into a state machine. The
 * Storyteller opens the night, each waker gets a private prompt and submits a
 * choice in-app, and the engine resolves every step in the official order,
 * applying mechanical effects and delivering each waker only their own
 * information.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ----------------------------------
 * It does not choose what is most interesting. The rulebook asks the
 * Storyteller to "help the weaker team as much as possible", so a
 * worse-than-optimal Storyteller is the correct one and automating optimal play
 * produces a worse game. Lie content, the red herring, Recluse/Spy registration
 * and game-feel interventions all stay human decisions, mediated by the
 * discretion panel — which can override every value generated here, and every
 * default is written to the auditable night log with a timestamp.
 *
 * ORDER IS LOAD-BEARING
 * ---------------------
 * Steps resolve strictly in official order, because the order is what makes the
 * interactions correct: the Poisoner (7) acts before the Imp (9), so poisoning
 * the Demon stops the kill; the Monk (4) acts before the Imp, so protection is
 * in place; the Fortune Teller (6) acts before the Poisoner, so a poisoned
 * Fortune Teller still spends their picks before their information is ruined.
 *
 * The one documented exception is the Ravenkeeper, who wakes AFTER the death
 * that woke them, so their step is appended at resolve time rather than sitting
 * in the order list.
 */

export interface NightStep {
  characterId: string;
  order: number;
  /** The player whose character wakes. */
  wakerPlayerId: string;
  isFirstNight: boolean;
  /** Has this waker already submitted their choice for this night? */
  resolved: boolean;
  /** Populated for auto-resolving steps (Chef, Empath, Undertaker, …) once resolved. */
  autoResult?: string;
  /** Legal targets for a picking step, precomputed. */
  legalTargetIds?: string[];
  targetCount: number;
  /** False when there are too few legal targets for the choice to be made at all. */
  isPossible: boolean;
  unavailableReason: string | null;
  prompt?: string;
  infoType: InfoType;
}

const RULES_NOTE =
  'This is how your own ability works — that part is always accurate, even if you are drunk or poisoned. What you are told about other players may not be.';

/** Night one is the first night the engine opens, which happens before Day 1. */
function isFirstNightOf(session: GameSession): boolean {
  return session.nightNumber <= 1;
}

function orderFor(def: CharacterDefinition, isFirstNight: boolean): number | null {
  return isFirstNight ? def.firstNightOrder : def.otherNightOrder;
}

function nameOfPlayer(session: GameSession, playerId: string): string {
  return session.players.get(playerId)?.displayName ?? 'an unknown player';
}

function playersInSeatOrder(session: GameSession): PlayerRecord[] {
  return [...session.players.values()].sort((a, b) => a.seatIndex - b.seatIndex);
}

// ---------------------------------------------------------------------------
// The wake order.
// ---------------------------------------------------------------------------

/** The character definition a player runs their night step under (their cover, for a Drunk). */
export function stepCharacterDef(session: GameSession, player: PlayerRecord): CharacterDefinition | undefined {
  return effectiveCharacterDef(session, player);
}

/**
 * Ordered wake list for the current phase. Respects first-night vs other-night.
 *
 * Dead players never wake — with one exception: a Ravenkeeper who is ALREADY dead
 * wakes precisely because they died at night, so they are added explicitly below
 * rather than filtered out with the rest of the dead. A living Ravenkeeper is not
 * in this list; their ability is conditional on death, so their step is appended
 * when tonight's kill lands.
 */
export function buildNightOrder(session: GameSession): NightStep[] {
  const isFirstNight = isFirstNightOf(session);
  const steps: NightStep[] = [];

  for (const player of playersInSeatOrder(session)) {
    if (!player.alive) continue;
    // A LIVING Ravenkeeper is never in the order. Their ability is conditional on
    // death ("If you die at night, you are woken…"), so they do not wake while
    // alive even though the data gives them an `otherNightOrder` slot. This also
    // has to be consistent with what `openNight` persisted, or a step that exists
    // at resolve time has no stored state and is silently reported as outstanding.
    if (player.character === 'ravenkeeper') continue;
    const def = stepCharacterDef(session, player);
    if (!def) continue;
    const order = orderFor(def, isFirstNight);
    if (order === null) continue;
    steps.push(buildStep(session, player, def, order, isFirstNight));
  }

  /*
   * A Ravenkeeper who is owed their one wake, and only those.
   *
   * "If you die at night, you are woken to choose a player." This loop used to add every
   * dead Ravenkeeper to every night with no condition at all, so one who died at night was
   * woken again every night afterwards AND one who was executed was woken too, which never
   * happens in the real game. A Ravenkeeper executed on day 1 got a free look at a
   * character every night for the rest of the game.
   *
   * The step has to be visible HERE and not only in `appendRavenkeeperWake`, because
   * `isNightFinished` and the Storyteller's outstanding list both enumerate this function.
   * A deferred step the order cannot see is a night that never finishes. So the wake is
   * owed while `ravenkeeperWakePending` is set, and that flag — not `alive` — is what
   * distinguishes died-at-night-and-unwoken from executed and from already-woken.
   */
  for (const player of playersInSeatOrder(session)) {
    if (player.alive) continue;
    if (player.character !== 'ravenkeeper') continue;
    if (!player.ravenkeeperWakePending) continue;
    const def = getCharacterById('ravenkeeper');
    if (!def) continue;
    const order = orderFor(def, isFirstNight) ?? Number.MAX_SAFE_INTEGER;
    steps.push(buildStep(session, player, def, order, isFirstNight));
  }

  return steps.sort(
    (a, b) => a.order - b.order || (session.players.get(a.wakerPlayerId)?.seatIndex ?? 0) - (session.players.get(b.wakerPlayerId)?.seatIndex ?? 0)
  );
}

/**
 * Can this waker actually make their choice tonight?
 *
 * A picking ability can be satisfied by nobody. The Librarian needs an Outsider
 * to look at, and Trouble Brewing deals ZERO Outsiders at 5 and 7 players — so a
 * table that somehow has a Librarian in play has a step that can never be
 * submitted. A Washerwoman who is the only Townsfolk (5 players with the Baron's
 * +2 Outsiders) is the same shape.
 *
 * Left unhandled this is a hard deadlock: the picker renders with no buttons, the
 * Send button never enables, the step is never "outstanding", and the night can
 * never reach "ready to resolve" — so the table sits there forever.
 *
 * So an unmakeable step is a distinct state, not a missing one. It still wakes
 * and is still announced by name, because "the Librarian woke" is information the
 * table is entitled to. It just resolves as the rules say it does.
 */
export function stepAvailability(
  session: GameSession,
  waker: PlayerRecord,
  def: CharacterDefinition
): { isPossible: boolean; reason: string | null; legalTargetIds: string[] } {
  const targetCount = def.targetCount ?? 0;
  if (targetCount === 0) {
    return { isPossible: true, reason: null, legalTargetIds: [] };
  }
  const legal = legalTargetsFor(session, waker, def, { isDrunk: isDrunkCover(session, waker) }).map((p) => p.playerId);
  if (legal.length >= targetCount) {
    return { isPossible: true, reason: null, legalTargetIds: legal };
  }
  return { isPossible: false, reason: unmakeableReason(def, legal.length, targetCount), legalTargetIds: legal };
}

function unmakeableReason(def: CharacterDefinition, have: number, need: number): string {
  if (def.id === 'librarian') {
    return 'There are no Outsiders in play, so there is nobody to choose. The Librarian learns that instead.';
  }
  if (def.id === 'investigator') {
    return 'There are no Minions in play, so there is nobody to choose.';
  }
  if (def.id === 'washerwoman') {
    return 'There is no other Townsfolk in play, so there is nobody to choose.';
  }
  if (def.id === 'butler') {
    return 'There is no other Townsfolk in play, so there is nobody to choose.';
  }
  if (def.id === 'monk') {
    return 'There is no other Good player to protect, so the ability does nothing.';
  }
  return `Only ${have} legal target${have === 1 ? '' : 's'} for a choice of ${need}, so the ability cannot be used.`;
}

/**
 * What an unmakeable step actually resolves to.
 *
 * The Librarian is the special case because it is written into their own ability
 * text: "You start knowing that 1 of 2 players is a particular Outsider. (Or that
 * zero are in play.)" Zero Outsiders is a legitimate ANSWER, not a failure, and a
 * real Storyteller simply tells them so. Everything else that cannot be chosen
 * simply does nothing, which is what happens at a real table when an ability has
 * no valid target.
 */
function unmakeableResult(def: CharacterDefinition): { text: string; truth: InfoTruth } {
  if (def.id === 'librarian') {
    return { text: 'You learn that there are no Outsiders in play.', truth: 'TRUE' };
  }
  return { text: 'Your ability does nothing tonight — there was nobody to choose.', truth: 'TRUE' };
}

function buildStep(
  session: GameSession,
  player: PlayerRecord,
  def: CharacterDefinition,
  order: number,
  isFirstNight: boolean
): NightStep {
  const targetCount = def.targetCount ?? 0;
  const availability = stepAvailability(session, player, def);
  return {
    characterId: def.id,
    order,
    wakerPlayerId: player.playerId,
    isFirstNight,
    resolved: false,
    targetCount,
    legalTargetIds: targetCount > 0 ? availability.legalTargetIds : undefined,
    isPossible: availability.isPossible,
    unavailableReason: availability.reason,
    prompt: def.nightPrompt,
    infoType: def.infoType ?? 'none',
  };
}

/**
 * The stored record for a step in the current night, CREATING it if it is missing.
 *
 * The record is where a submitted choice and a "dealt with" flag live, so a step
 * without one is a step the engine cannot remember anything about. That is not a
 * theoretical state: `buildNightOrder` is recomputed from live game state on every
 * call, so if the roster changes shape after the night opened — a character gaining
 * or losing a night action, a death, the Storyteller changing an alignment — the
 * order can contain a step that `openNight` never created a record for.
 *
 * Every reader used to treat that as "already dealt with", and the four call sites
 * disagreed about it. The result was a hard, silent deadlock: the flow said a
 * player owed a choice, so the Storyteller's "move on" control was withheld, while
 * the prompt sender skipped the very step it needed to prompt, because it read the
 * missing record as finished. The player was never woken and the Storyteller had
 * nothing to click.
 *
 * Repairing on read makes the state impossible to be stuck in and is idempotent, so
 * the hot path costs one array scan it was already paying.
 */
export function findStoredStep(night: NightState | null, step: NightStep): NightStepState | undefined {
  if (!night) return undefined;
  const found = night.steps.find((s) => s.wakerPlayerId === step.wakerPlayerId && s.characterId === step.characterId);
  if (found) return found;
  const created: NightStepState = {
    characterId: step.characterId,
    wakerPlayerId: step.wakerPlayerId,
    targetIds: [],
    resolved: false,
    overrideText: null,
  };
  night.steps.push(created);
  return created;
}

/** Night order a player must still act on, in order. Drives the private prompt UI. */
export function pendingStepsForPlayer(session: GameSession, playerId: string): NightStep[] {
  const night = session.currentNight;
  if (!night) return [];
  return buildNightOrder(session).filter((step) => {
    if (step.wakerPlayerId !== playerId) return false;
    const stored = findStoredStep(night, step);
    return stored ? !stored.resolved : false;
  });
}

// ---------------------------------------------------------------------------
// Night lifecycle.
// ---------------------------------------------------------------------------

/**
 * Opens a night: increments the night number, expires yesterday's poison,
 * re-arms passive protection, builds the wake order, and prompts every waker.
 *
 * POISON BOUNDARY. The Poisoner poisons "tonight and tomorrow day", so poison is
 * NOT cleared at dawn — `endNight` deliberately leaves it running. It expires
 * here, at the start of the night that follows the day it covered, which is
 * exactly where the official wording puts it. Clearing it at dawn instead would
 * mean a poisoned player speaks and votes normally all day, which is the single
 * most common rules bug in BOTC tooling.
 */
export function openNight(session: GameSession): NightState {
  if (session.currentNight) return session.currentNight;

  session.nightNumber += 1;
  const isFirstNight = isFirstNightOf(session);

  for (const player of session.players.values()) {
    if (player.statusEffects.poisoned) {
      player.statusEffects.poisoned = false;
      logNightEvent(
        session,
        'poison-expired',
        `${player.displayName}'s poison has expired as Night ${session.nightNumber} began (poison covers the night it was cast plus the following day).`
      );
    }
    // The Soldier is "safe from the Demon" at all times, so protection is
    // re-armed at the start of every night rather than treated as a choice.
    if (soldierIsProtected(session, player.playerId)) {
      player.statusEffects.protected = true;
    }
  }

  const steps: NightStepState[] = buildNightOrder(session).map((step) => ({
    characterId: step.characterId,
    wakerPlayerId: step.wakerPlayerId,
    targetIds: [],
    resolved: false,
    overrideText: null,
  }));

  session.currentNight = {
    steps,
    openedAt: Date.now(),
    activeIndex: 0,
    wakeIndex: 0,
    resolved: false,
    passComplete: false,
    briefed: false,
    // Read from the previous night when the Storyteller set it, so the pause
    // length is a table preference rather than something reset every night.
    delaySeconds: session.lastNightDelaySeconds,
    wakeGate: null,
  };
  logNightEvent(
    session,
    'night-opened',
    isFirstNight
      ? 'First Night opened. Minion info (Poisoner, Spy) is taken before Townsfolk info, and the Demon wakes last.'
      : `Night ${session.nightNumber} opened with ${steps.length} waker(s).`
  );
  return session.currentNight;
}

/**
 * Called on the day transition. Clears protection and logs the night.
 *
 * Protection expires at dawn because "safe from the Demon" is a statement about
 * tonight. Poison deliberately survives — see `openNight`.
 */
export function endNight(session: GameSession): void {
  const night = session.currentNight;
  if (!night) return;

  const protectedNames: string[] = [];
  for (const player of session.players.values()) {
    if (player.statusEffects.protected) protectedNames.push(player.displayName);
    player.statusEffects.protected = false;
  }

  const dead = playersInSeatOrder(session).filter((p) => !p.alive);
  logNightEvent(
    session,
    'night-ended',
    `Night ${session.nightNumber} resolved. Dead: ${
      dead.length > 0 ? dead.map((p) => p.displayName).join(', ') : 'nobody'
    }. Protection expired for: ${protectedNames.length > 0 ? protectedNames.join(', ') : 'nobody'}.`
  );
  for (const player of session.players.values()) {
    if (player.statusEffects.poisoned) {
      logNightEvent(
        session,
        'poison-carries',
        `${player.displayName} remains poisoned through Day ${session.dayNumber + 1}.`
      );
    }
  }
  session.currentNight = null;
}

// ---------------------------------------------------------------------------
// Choices.
// ---------------------------------------------------------------------------

/**
 * Validate + record a waker's target selection. Enforces targetCount and the
 * character's target restrictions.
 *
 * Waker identity is read from the step, not taken on trust, so a player cannot
 * submit a choice on someone else's behalf.
 */
export function submitNightChoice(
  session: GameSession,
  playerId: string,
  targetIds: string[],
  /** Required only to deliver a deferred (Ravenkeeper) result; omitted by pure callers. */
  io?: SocketIOServer
): void {
  const night = session.currentNight;
  if (!night) throw Errors.noOpenNight();

  const step = night.steps.find((s) => s.wakerPlayerId === playerId);
  if (!step) throw Errors.notYourNightStep();
  if (step.resolved) throw Errors.nightChoiceAlreadySubmitted();

  // A Ravenkeeper woken by tonight's kill picks AFTER the night has resolved —
  // they cannot be woken before the death that woke them. That single step is
  // therefore still open after `resolveNight`, and blocking it would silently
  // delete the character's whole ability. Every other step stays closed.
  if (night.passComplete && step.characterId !== 'ravenkeeper') throw Errors.nightAlreadyResolved();

  const waker = session.players.get(playerId);
  if (!waker) throw Errors.playerNotFound();

  const def = getCharacterById(step.characterId);
  if (!def) throw Errors.playerNotFound();
  const targetCount = def.targetCount ?? 0;
  if (targetCount === 0) throw Errors.nothingToChoose();

  const availability = stepAvailability(session, waker, def);
  if (!availability.isPossible) {
    throw Errors.nothingToChooseForCharacter(def.name, availability.reason ?? 'there is nobody to choose');
  }

  if (targetIds.length !== targetCount) {
    throw Errors.wrongTargetCount(targetCount, targetIds.length);
  }
  if (new Set(targetIds).size !== targetIds.length) throw Errors.duplicateTarget();

  const legal = new Set(legalTargetIdsFor(session, step.characterId, waker));
  for (const id of targetIds) {
    if (!session.players.has(id)) throw Errors.playerNotFound();
    if (!legal.has(id)) throw Errors.illegalTarget(nameOfPlayer(session, id));
  }

  step.targetIds = targetIds;
  step.resolved = true;
  logNightEvent(
    session,
    'choice-submitted',
    `${waker.displayName} (${def.name}) chose ${targetIds.map((id) => nameOfPlayer(session, id)).join(' and ')}.`
  );

  /*
   * The Ravenkeeper's wake is spent. Until this, `ravenkeeperWakePending` keeps the step
   * in `buildNightOrder` so the night cannot be declared finished over an open pick — but
   * if it stayed set, EVERY later night would list the step again with no stored record,
   * and the night would be permanently unfinished and unfinishable. It is a one-shot.
   */
  if (def.id === 'ravenkeeper' && !waker.alive) {
    waker.ravenkeeperWakePending = false;
  }

  // Outside the `io` guard on purpose: whether a night is finished is a fact about
  // the steps, not about who is connected, and a late pick (the Ravenkeeper woken by
  // the night kill) is the thing that usually finishes it.
  recomputeNightResolved(session);

  if (night.passComplete && io) {
    resolveDeferredStep(session, io, waker, def, step);
  }
}

/**
 * Resolves a step that arrives after the night was resolved — currently only the
 * Ravenkeeper's. Kept separate from `resolveNight` because the whole rest of the
 * night is already done and must not be re-run.
 */
function resolveDeferredStep(
  session: GameSession,
  io: SocketIOServer,
  waker: PlayerRecord,
  def: CharacterDefinition,
  stored: NightStepState
): void {
  if (def.id !== 'ravenkeeper') return;
  const target = session.players.get(stored.targetIds[0] ?? '');
  const info = generateCharacterInfo(lieContext(session, waker, def.id), target?.character ?? null);
  deliverInfo(session, io, waker, def, stored, info, renderCharacterInfo(info, '???'));
}

function legalTargetIdsFor(session: GameSession, characterId: string, waker: PlayerRecord): string[] {
  const def = getCharacterById(characterId);
  if (!def) return [];
  return legalTargetsFor(session, waker, def, { isDrunk: isDrunkCover(session, waker) }).map((p) => p.playerId);
}

// ---------------------------------------------------------------------------
// Resolution.
// ---------------------------------------------------------------------------

export interface NightResolutionReport {
  /** Steps whose choice was never submitted, so their effect was dropped. */
  outstanding: string[];
  /** Player ids who died tonight. Ids, not names: the caller needs to look the players up. */
  killedPlayerIds: string[];
  /** Result of the Imp self-kill hand-off, if one happened. */
  inheritance: { previousDemonPlayerId: string; newDemonPlayerId: string; newDemonCharacterId: string } | null;
}

/**
 * Resolve all auto-steps and every submitted choice, in official order, pushing
 * each waker their own result.
 *
 * An unsubmitted pick is NOT fatal: a live game has to be able to end a night
 * when somebody walks away, so the step resolves as "no choice" and a loud
 * warning is written to the night log. For the Monk that means nobody is
 * protected, which is a real risk — the Storyteller's night panel lists every
 * outstanding step so it cannot pass unnoticed.
 */
export function resolveNight(session: GameSession, io: SocketIOServer): NightResolutionReport {
  const night = session.currentNight;
  if (!night) throw Errors.noOpenNight();
  if (night.passComplete) throw Errors.nightAlreadyResolved();
  if (session.phase !== 'night') throw Errors.notNightPhase();

  const report: NightResolutionReport = { outstanding: [], killedPlayerIds: [], inheritance: null };

  for (const step of buildNightOrder(session)) {
    const stored = findStoredStep(night, step);
    if (!stored) continue;

    const waker = session.players.get(step.wakerPlayerId);
    if (!waker) continue;
    const def = getCharacterById(step.characterId);
    if (!def) continue;

    // An unmakeable step is not "outstanding": it can never be satisfied, and
    // treating it as outstanding is what deadlocked the table. The Librarian's own
    // text covers the zero-Outsider case, so it resolves as a real answer.
    if ((def.targetCount ?? 0) > 0 && !step.isPossible) {
      const outcome = unmakeableResult(def);
      logNightEvent(
        session,
        'unmakeable-choice',
        `${def.name} (${waker.displayName}): ${step.unavailableReason}`
      );
      // Log what they were actually TOLD as well as why. The night log is meant to
      // be a complete record of every piece of information delivered, and an entry
      // that records the reason but not the answer would be a gap in that record.
      logNightEvent(
        session,
        'info-generated',
        `${def.name} (${waker.displayName}) told: ${outcome.text} [truth=${outcome.truth}] Ability had no legal target, so this is the rules-correct outcome rather than a generated answer.`
      );
      stored.resolved = true;
      sendResolved(session, io, waker, def, stored, outcome.text, undefined);
      continue;
    }

    if ((def.targetCount ?? 0) > 0 && stored.targetIds.length === 0) {
      report.outstanding.push(def.name);
      logNightEvent(
        session,
        'outstanding-choice',
        `${def.name} (${waker.displayName}) submitted no choice; their ability resolves as doing nothing.`
      );
      stored.resolved = true;
      sendResolved(session, io, waker, def, stored, 'The Storyteller had no choice from you tonight.', undefined);
      continue;
    }

    // A drunk or poisoned player has no functioning ability. Picking steps still
    // record the choice — so the player is not left waiting on a submit button —
    // but apply no effect.
    const abilityWorks = !wakerIsUnreliable(waker);

    switch (def.id) {
      case 'chef': {
        const truth = chefEvilPairCount(session, waker.playerId);
        const info = generateCountInfo(lieContext(session, waker, def.id), truth, maxPossibleEvilPairs(session));
        deliverInfo(
          session,
          io,
          waker,
          def,
          stored,
          info,
          renderCountInfo(info, {
            zero: 'You learn that there are no pairs of adjacent evil players.',
            one: 'You learn that there is one pair of adjacent evil players.',
            many: (n) => `You learn that there are ${n} pairs of adjacent evil players.`,
          })
        );
        break;
      }
      case 'empath': {
        const truth = empathEvilNeighbourCount(session, waker.playerId);
        // The Empath only ever sees 0, 1 or 2, so that is the entire plausible
        // space: a lie outside it would be instantly disprovable.
        const info = generateCountInfo(lieContext(session, waker, def.id), truth, 2);
        deliverInfo(
          session,
          io,
          waker,
          def,
          stored,
          info,
          renderCountInfo(info, {
            zero: 'You learn that none of your living neighbors is evil.',
            one: 'You learn that one of your living neighbors is evil.',
            many: (n) => `You learn that ${n} of your living neighbors are evil.`,
          })
        );
        break;
      }
      case 'undertaker': {
        // The REGISTERED character, not the true one: an executed Spy who registers as
        // the Butler is shown the Butler.
        const registered = executedRegisteredCharacterName(session);
        const info = generateCharacterInfo(lieContext(session, waker, def.id), registered);
        const text = info.value ? renderCharacterInfo(info, '???') : 'You learn that nobody died by execution today.';
        deliverInfo(session, io, waker, def, stored, info, text);
        break;
      }
      case 'fortune-teller': {
        const redHerring = fortuneTellerRedHerringOf(session);
        const { found, redHerring: hitRedHerring } = fortuneTellerFindsDemon(session, waker.playerId, stored.targetIds, redHerring);
        // The red herring is a FALSE answer by construction — it is the whole
        // point of the character — so it bypasses the lie policy entirely.
        const info: GeneratedInfo = hitRedHerring
          ? {
              value: true,
              truth: 'FALSE',
              rationale: `The Fortune Teller selected the red herring (${redHerring}), who registers as the Demon to them by design. This is the character's own text, not a generated lie.`,
            }
          : generateYesNoInfo(lieContext(session, waker, def.id), found);
        const subject = hitRedHerring && redHerring ? nameOfPlayer(session, redHerring) : 'one of your two players';
        deliverInfo(session, io, waker, def, stored, info, renderYesNoInfo(info, subject));
        break;
      }
      case 'washerwoman':
      case 'librarian':
      case 'investigator': {
        const targetId = stored.targetIds[0] ?? '';
        const trueCharacterId = trueCharacterForPairRole(session, def, targetId);
        const info = generatePairInfo(lieContext(session, waker, def.id), trueCharacterId);
        const otherId = decoyPlayerForPairRole(session, waker, def, targetId);
        deliverInfo(session, io, waker, def, stored, info, renderPairInfo(info, nameOfPlayer(session, targetId), nameOfPlayer(session, otherId)));
        break;
      }
      case 'ravenkeeper': {
        const target = session.players.get(stored.targetIds[0] ?? '');
        const info = generateCharacterInfo(lieContext(session, waker, def.id), target?.character ?? null);
        deliverInfo(session, io, waker, def, stored, info, renderCharacterInfo(info, '???'));
        break;
      }
      case 'spy': {
        // A poisoned or drunk Spy has no functioning ability, so they see no Grimoire.
        // This case never consulted `abilityWorks`, unlike every other ability, so a
        // poisoned Spy was handed the entire table every single night — the single
        // largest information leak in the game, and reachable as soon as the Poisoner
        // picks the Spy, which is the obvious first move at that seat.
        if (!abilityWorks) {
          logNightEvent(session, 'ability-failed', `Spy ${waker.displayName} is drunk/poisoned; they saw no Grimoire.`);
          sendResolved(session, io, waker, def, stored, 'You are drunk/poisoned. You did not see the Grimoire tonight.', undefined);
          break;
        }
        // The Grimoire goes to the Spy and to nobody else, on the Spy's own
        // socket — never to the session room. This is the one place a player is
        // given the whole Grimoire, and it is correct: the Spy's character text
        // says so.
        const grimoire = buildGrimoire(session);
        sendToPlayer(io, waker, ServerEvents.GrimoireUpdate, { grimoire });
        const info: GeneratedInfo = {
          value: 'grimoire',
          truth: 'TRUE',
          rationale: "The Spy always receives the true Grimoire. It is their own information, not a generated one, so there is nothing to lie about.",
        };
        deliverInfo(session, io, waker, def, stored, info, 'You see the Grimoire.', grimoire);
        break;
      }
      case 'monk': {
        if (!abilityWorks) {
          logNightEvent(session, 'ability-failed', `Monk ${waker.displayName} is drunk/poisoned; nobody was protected.`);
          sendResolved(session, io, waker, def, stored, 'You are drunk/poisoned. Your protection did not work.', undefined);
          break;
        }
        const targetId = stored.targetIds[0]!;
        const target = session.players.get(targetId);
        if (target) {
          target.statusEffects.protected = true;
          logNightEvent(session, 'protected', `Monk ${waker.displayName} protected ${target.displayName} from the Demon tonight.`);
        }
        sendResolved(session, io, waker, def, stored, `${nameOfPlayer(session, targetId)} is safe from the Demon tonight.`, undefined);
        break;
      }
      case 'poisoner': {
        if (!abilityWorks) {
          logNightEvent(session, 'ability-failed', `Poisoner ${waker.displayName} is drunk/poisoned; nobody was poisoned.`);
          sendResolved(session, io, waker, def, stored, 'You are drunk/poisoned. Your poison did not work.', undefined);
          break;
        }
        const targetId = stored.targetIds[0]!;
        const target = session.players.get(targetId);
        if (target) {
          target.statusEffects.poisoned = true;
          logNightEvent(
            session,
            'poisoned',
            `Poisoner ${waker.displayName} poisoned ${target.displayName} (through the end of Day ${session.dayNumber + 1}).`
          );
          if (target.characterType === 'demon') {
            logNightEvent(session, 'poisoned-demon', `${target.displayName} is the Demon and is poisoned, so they do not kill tonight.`);
          }
        }
        sendResolved(session, io, waker, def, stored, `${nameOfPlayer(session, targetId)} is poisoned.`, undefined);
        break;
      }
      case 'butler': {
        if (!abilityWorks) {
          logNightEvent(session, 'ability-failed', `Butler ${waker.displayName} is drunk/poisoned; no vote restriction applies.`);
          sendResolved(session, io, waker, def, stored, 'You are drunk/poisoned. Your choice had no effect.', undefined);
          break;
        }
        const targetId = stored.targetIds[0]!;
        const target = session.players.get(targetId);
        if (target) {
          waker.butlerChoice = { masterPlayerId: targetId, forDayNumber: session.dayNumber + 1 };
        }
        logNightEvent(
          session,
          'butler-choice',
          `Butler ${waker.displayName} may only vote on Day ${session.dayNumber + 1} if ${nameOfPlayer(session, targetId)} votes.`
        );
        sendResolved(session, io, waker, def, stored, 'Your choice is noted. Remember it for tomorrow.', undefined);
        break;
      }
      case 'imp': {
        if (!abilityWorks) {
          logNightEvent(session, 'ability-failed', `The Demon ${waker.displayName} is drunk/poisoned, so nobody dies tonight.`);
          sendResolved(session, io, waker, def, stored, 'You are drunk/poisoned. The Demon does not kill tonight.', undefined);
          break;
        }
        const targetId = stored.targetIds[0]!;
        const target = session.players.get(targetId);
        if (!target) break;
        if (targetId === waker.playerId) {
          const result = resolveDemonKill(session, waker.playerId, targetId, chosenHeirFor(session));
          report.inheritance = result.inheritance;
          report.killedPlayerIds.push(waker.playerId);
          if (result.inheritance) {
            logNightEvent(
              session,
              'demon-inherited',
              `The Imp killed themself; ${nameOfPlayer(session, result.inheritance.newDemonPlayerId)} is the new Demon.`
            );
            const heir = session.players.get(result.inheritance.newDemonPlayerId);
            if (heir) {
              // The heir's own client learns their new character. Their teammates
              // and bluff are unchanged: only the Storyteller and the heir ever
              // see this, which is the whole point of the hand-off.
              const inheritedDef = getCharacterById(result.inheritance.newDemonCharacterId);
              sendToPlayer(io, heir, ServerEvents.GameDistributed, {
                role: 'player',
                playerId: heir.playerId,
                character: result.inheritance.newDemonCharacterId,
                characterName: inheritedDef?.name ?? result.inheritance.newDemonCharacterId,
                characterType: 'demon',
                alignment: 'evil',
                ability: inheritedDef?.ability ?? '',
                teammates: [...session.players.values()]
                  .filter((p) => p.playerId !== heir.playerId && p.alignment === 'evil')
                  .map((p) => ({
                    playerId: p.playerId,
                    displayName: p.displayName,
                    character: p.character ?? '',
                    characterName: getCharacterById(p.character ?? '')?.name ?? '',
                  })),
              });
            }
          }
        } else {
          const result = resolveDemonKill(session, waker.playerId, targetId);
          if (result.killed) {
            report.killedPlayerIds.push(target.playerId);
            logNightEvent(session, 'night-kill', `The Imp killed ${target.displayName}.`);
            // Arm the one wake. Cleared when they spend it, so it cannot fire twice.
            if (target.character === 'ravenkeeper') {
              target.ravenkeeperWakePending = true;
            }
            if (target.character === 'mayor') {
              logNightEvent(
                session,
                'mayor-death',
                `${target.displayName} is the Mayor and died at night. The Storyteller may choose for another player to die instead.`
              );
            }
          }
          // A blocked kill is NOT logged here. `resolveDemonKill` already wrote
          // `kill-blocked` naming the reason, and this used to add a second,
          // differently-worded `protection-saved` for the very same event — so one
          // save produced two lines in the audit log, and a Storyteller reading it
          // could reasonably think two separate protections had come into play.
        }
        sendResolved(session, io, waker, def, stored, 'The night passes.', undefined);
        break;
      }
      default: {
        // Defensive: a character may gain a night order before its effect lands.
        logNightEvent(
          session,
          'unimplemented',
          `${def.name} has a night order but no automated effect; the Storyteller must resolve it manually.`
        );
        sendResolved(session, io, waker, def, stored, 'The Storyteller will resolve this manually.', undefined);
        break;
      }
    }

    stored.resolved = true;
  }

  appendRavenkeeperWake(session, io, report);
  // Derived from the order, never assumed. Resolving one ability can reveal or add
  // another (a Ravenkeeper waking, a chain reaction), so asserting the night is
  // finished here is how the engine ended up reporting `resolved: true` next to an
  // order that still had a step outstanding.
  night.passComplete = true;
  recomputeNightResolved(session);

  logNightEvent(session, 'night-resolved', `Night ${session.nightNumber} resolution complete.`);
  if (report.outstanding.length > 0) {
    logNightEvent(
      session,
      'night-warning',
      `Outstanding choices: ${report.outstanding.join(', ')}. Those abilities resolved as doing nothing.`
    );
  }
  return report;
}

/**
 * A Ravenkeeper woken by tonight's kill gets their step appended after the
 * death, and is prompted immediately. This is the only out-of-order step in the
 * game, and it matches how the real wake-up works: you cannot know who has died
 * at night until the Demon has acted.
 */
function appendRavenkeeperWake(session: GameSession, io: SocketIOServer, report: NightResolutionReport): void {
  const night = session.currentNight!;
  for (const player of session.players.values()) {
    if (player.alive) continue;
    if (player.character !== 'ravenkeeper') continue;
    if (!report.killedPlayerIds.includes(player.playerId)) continue;
    if (night.steps.some((s) => s.wakerPlayerId === player.playerId)) continue;

    const def = getCharacterById('ravenkeeper');
    if (!def) continue;
    night.steps.push({
      characterId: 'ravenkeeper',
      wakerPlayerId: player.playerId,
      targetIds: [],
      resolved: false,
      overrideText: null,
    });
    logNightEvent(session, 'ravenkeeper-wake', `${player.displayName} died at night and is woken as the Ravenkeeper.`);
    sendToPlayer(
      io,
      player,
      ServerEvents.NightPrompt,
      buildNightPrompt(session, {
        characterId: def.id,
        order: 0,
        wakerPlayerId: player.playerId,
        isFirstNight: isFirstNightOf(session),
        resolved: false,
        targetCount: def.targetCount ?? 1,
        isPossible: true,
        unavailableReason: null,
        legalTargetIds: legalTargetsFor(session, player, def).map((p) => p.playerId),
        prompt: def.nightPrompt,
        infoType: def.infoType ?? 'character',
      })
    );
  }
}

/** Sends one waker their own generated information, honouring any override. */
function deliverInfo(
  session: GameSession,
  io: SocketIOServer,
  waker: PlayerRecord,
  def: CharacterDefinition,
  stored: NightStepState,
  info: GeneratedInfo,
  text: string,
  grimoire?: NightResolvedPayload['grimoire']
): void {
  // The two channels are assembled together and never merged. The rules channel
  // is always true — the rulebook is explicit that a drunk or poisoned player
  // still gets correct information about the RULES — and the ability channel is
  // the only thing the lie policy is ever allowed to touch.
  const delivery = deliverNightInfo({ rulesText: `${def.name}: ${def.ability}`, ability: info });
  const finalText = stored.overrideText ?? text;
  if (stored.overrideText) {
    logNightEvent(
      session,
      'override',
      `${def.name} (${waker.displayName}): Storyteller overrode the generated answer "${text}" with "${stored.overrideText}".`
    );
  }
  // The truth value and the rationale go to the LOG, never to the player. Sending
  // `truth: 'FALSE'` to a Drunk would tell them, with certainty, that they are
  // being lied to, which is the one thing that must never happen.
  logNightEvent(
    session,
    'info-generated',
    `${def.name} (${waker.displayName}) told: ${finalText} [truth=${delivery.abilityChannel.truth}] ${delivery.abilityChannel.rationale}`
  );
  sendResolved(session, io, waker, def, stored, finalText, grimoire);
}

function sendResolved(
  session: GameSession,
  io: SocketIOServer,
  waker: PlayerRecord,
  def: CharacterDefinition,
  stored: NightStepState,
  text: string,
  grimoire: NightResolvedPayload['grimoire']
): void {
  sendToPlayer(io, waker, ServerEvents.NightResolved, {
    playerId: waker.playerId,
    nightNumber: session.nightNumber,
    characterId: def.id,
    characterName: def.name,
    infoType: def.infoType ?? 'none',
    text,
    grimoire,
    overridden: stored.overrideText !== null,
  } satisfies NightResolvedPayload);
}

/**
 * The character a 1-of-2 role's answer is anchored on. The waker chose a player
 * of the matching type, so that player's real character is the truth. If it does
 * not match — data drift, or a Drunk cover — fall back to any in-play character
 * of the right type, so the answer is never impossible.
 */
function trueCharacterForPairRole(session: GameSession, def: CharacterDefinition, targetId: string): string {
  const chosen = session.players.get(targetId);
  if (chosen?.character && getCharacterById(chosen.character)?.type === def.type) return chosen.character;
  const inPlay = playersInSeatOrder(session).find((p) => p.characterType === def.type);
  return inPlay?.character ?? def.id;
}

function decoyPlayerForPairRole(session: GameSession, waker: PlayerRecord, def: CharacterDefinition, excludeId: string): string {
  const candidate = playersInSeatOrder(session).find(
    (p) => p.playerId !== excludeId && p.playerId !== waker.playerId && p.characterType === def.type
  );
  return candidate?.playerId ?? excludeId;
}

function fortuneTellerRedHerringOf(session: GameSession): string | null {
  for (const player of session.players.values()) {
    if (player.fortuneTellerRedHerringPlayerId) return player.fortuneTellerRedHerringPlayerId;
  }
  return null;
}

/**
 * The Imp's self-kill heir, when the Storyteller chose one for this night.
 * Returns undefined when the Storyteller has not chosen, in which case
 * `resolveDemonKill` falls back to a random living Minion and logs that it did.
 */
function chosenHeirFor(session: GameSession): string | undefined {
  const choice = session.impHeirChoice;
  if (choice && choice.nightNumber === session.nightNumber) return choice.playerId;
  return undefined;
}

// ---------------------------------------------------------------------------
// Outbound projections. Everything here is scoped to exactly one recipient.
// ---------------------------------------------------------------------------

/** Private: the "you are awake, do this" prompt. Sent to the waker only. */
export function buildNightPrompt(session: GameSession, step: NightStep): NightPromptPayload {
  const waker = session.players.get(step.wakerPlayerId)!;
  const def = getCharacterById(step.characterId)!;
  const legal = step.legalTargetIds ?? [];
  return {
    playerId: waker.playerId,
    nightNumber: session.nightNumber,
    isFirstNight: step.isFirstNight,
    characterId: def.id,
    characterName: def.name,
    ability: def.ability,
    prompt: step.prompt ?? def.ability,
    infoType: step.infoType,
    targetCount: step.targetCount,
    legalTargetIds: legal,
    legalTargets: legal.map((id) => ({ playerId: id, displayName: nameOfPlayer(session, id) })),
    rulesNote: RULES_NOTE,
    // NOTE: the payload carries NO "your information may be unreliable" flag, and
    // that is load-bearing rather than an omission. A Drunk does not know they are
    // the Drunk and a poisoned player does not know they are poisoned — that is
    // the whole design of both characters. Telling a waker that their answer might
    // be false would identify the Drunk on the very first night and destroy the
    // "usually wrong, sometimes true" rule that makes a Drunk undetectable. The
    // unreliability is enforced server-side in liePolicy.ts and is, by design,
    // invisible to the waker.
  };
}

/**
 * Prompts the ONE player the flow says is awake.
 *
 * This used to prompt every waker the moment the night opened, which is wrong for
 * a game that runs on waking people one at a time: three players were looking at
 * their roles simultaneously, before the Storyteller had even said "close your
 * eyes". A player only learns anything once the table says their name, and the
 * flow names exactly one person, so exactly one person gets a prompt.
 *
 * It is re-evaluated on every flow change, which is also why the app never
 * stalls: if the Storyteller forgets to click through, the next person in the
 * order is prompted as soon as the previous one submits.
 *
 * Never a room broadcast — this is a private payload.
 */
export function sendActiveNightPrompt(io: SocketIOServer, session: GameSession): void {
  const night = session.currentNight;
  if (!night || night.passComplete) return;
  // During the briefing nobody is awake yet.
  if (!night.briefed) return;
  // While the pause between wakers is running, nobody may be woken. This is the
  // line that makes the pause real: without it the next prompt goes out the
  // instant the previous player submitted and the table can time the order
  // perfectly, which is the thing the pause exists to prevent.
  if (wakeGateIsPending(session)) return;

  for (const step of buildNightOrder(session)) {
    // findStoredStep repairs a missing record, so "no record" can no longer mean
    // "already dealt with" here. That mismatch is what deadlocked the night.
    const stored = findStoredStep(night, step);
    if (!stored || stored.resolved) continue;
    if ((step.targetCount ?? 0) === 0) continue;
    // Never hand a player a picker they cannot fill in. An unmakeable step still
    // wakes and is still announced by name; it just gets no prompt, and its result
    // is the rules-correct "there is nobody to choose".
    if (!step.isPossible) continue;
    const owed = firstPlayerOwingAChoice(session);
    if (!owed || owed.playerId !== step.wakerPlayerId) continue;
    sendToPlayer(io, owed, ServerEvents.NightPrompt, buildNightPrompt(session, step));
    return;
  }
}

/**
 * Announces every remaining waker, in official order, and returns how many were
 * announced. Used by the wake walk so an auto-resolving character is still called
 * by name even though they are never prompted.
 */
export function pendingWakerNames(session: GameSession): string[] {
  const night = session.currentNight;
  if (!night) return [];
  const names: string[] = [];
  for (const step of buildNightOrder(session)) {
    // findStoredStep repairs a missing record, so "no record" can no longer mean
    // "already dealt with" here. That mismatch is what deadlocked the night.
    const stored = findStoredStep(night, step);
    if (!stored || stored.resolved) continue;
    const player = session.players.get(step.wakerPlayerId);
    if (player) names.push(player.displayName);
  }
  return names;
}

/**
 * The waker currently being dealt with, or null when the night is done.
 *
 * THE SINGLE SOURCE OF TRUTH FOR THE WAKE WALK. It used to be derived from the
 * Storyteller's stepper cursor, and that was the bug: clicking "next" quickly
 * marked every auto-resolving waker before the cursor as dealt with in a single
 * sweep, so the Empath and the Chef were skipped without ever being announced —
 * and each click overwrote the pause, so the table heard "Win1, close your eyes"
 * immediately followed by "Phone, close your eyes". One cursor, advanced one waker
 * at a time, cannot do that.
 */
export function currentWakeStep(session: GameSession): NightStep | null {
  const night = session.currentNight;
  if (!night || night.passComplete) return null;
  const order = buildNightOrder(session);
  if (order.length === 0) return null;
  const index = Math.max(0, Math.min(night.wakeIndex, order.length - 1));
  const step = order[index]!;
  const stored = findStoredStep(night, step);
  if (stored?.resolved) {
    // Everything at or before the cursor is dealt with; the next unresolved step
    // is the one who is awake. This keeps the walk self-healing after a
    // Storyteller jump, rather than stalling on an already-resolved step. A step
    // with no stored record is treated as unresolved for the same reason as in
    // advanceWakeCursor: skipping it would drop a waker without ever being told.
    const next = order.find((s) => !findStoredStep(night, s)?.resolved);
    return next ?? null;
  }
  return step;
}

/** The player who is awake right now, or null. */
export function currentWaker(session: GameSession): PlayerRecord | null {
  const step = currentWakeStep(session);
  if (!step) return null;
  return session.players.get(step.wakerPlayerId) ?? null;
}

/**
 * Records that a waker has finished, and opens the pause before the next one.
 *
 * THE PAUSE IS A RULE, NOT A POLISH DETAIL. The rulebook says of dawn: "The
 * small wait at dawn prevents players from knowing for sure whether they were the
 * last to act at night." That reasoning applies to every gap in the night, not
 * just the last one. Announce "X, wake up" the instant X's turn ends and the table
 * learns the exact timing of every wake — and timing is how players work out who
 * acted before the Demon did.
 *
 * While the gate is open the flow says "X, close your eyes" and no new prompt is
 * sent, so the next person is not announced until the pause has elapsed.
 *
 * Idempotent for the same player: pressing "next" twice while the pause is running
 * must not re-open the gate on somebody else, which is what made two "close your
 * eyes" announcements fire back to back.
 */
export function finishWake(session: GameSession, playerId: string): void {
  const night = session.currentNight;
  if (!night || night.passComplete) return;

  // Mark this waker dealt with, so the walk moves on past them.
  const step = buildNightOrder(session).find((s) => s.wakerPlayerId === playerId);
  if (step) {
    const stored = findStoredStep(night, step);
    if (stored && !stored.resolved) {
      if ((step.targetCount ?? 0) > 0 && step.isPossible && stored.targetIds.length === 0) {
        // The Storyteller is moving on before this player submitted. Allowed — a
        // table has to be able to continue when somebody walks away — but logged,
        // because the ability will resolve as doing nothing.
        logNightEvent(
          session,
          'advanced-without-choice',
          `The Storyteller moved past ${step.characterId} (${session.players.get(playerId)?.displayName ?? playerId}) before they submitted.`
        );
      }
      stored.resolved = true;
    }
  }

  if (night.delaySeconds <= 0) {
    night.wakeGate = null;
    advanceWakeCursor(session);
    return;
  }
  // A pause is ALREADY running, so leave its original deadline alone. Re-opening it
  // on a different person is what made the table hear "Win1, close your eyes"
  // immediately followed by "Phone, close your eyes" — two different people
  // closing their eyes at once, with the walk jumping ahead of the pause.
  if (night.wakeGate) return;
  night.wakeGate = { closesPlayerId: playerId, opensAt: Date.now() + night.delaySeconds * 1000 };
}

/** Moves the wake cursor to the first waker who has not been dealt with yet. */
export function advanceWakeCursor(session: GameSession): void {
  const night = session.currentNight;
  if (!night) return;
  // The walk must not move while a pause is running: the pause is the gap that
  // stops the table timing the order, and jumping the cursor during it would put
  // the next name on the wire before the gap had elapsed.
  if (wakeGateIsPending(session)) return;
  const order = buildNightOrder(session);
  // A step with NO stored record counts as not-yet-dealt-with, not as dealt with.
  // The old `stored && !stored.resolved` read a missing record as "resolved" and
  // walked straight past it, which would put the cursor at the far end of the
  // night and drop whoever was in the middle. openNight and appendRavenkeeperWake
  // both create the record, so this is hardening rather than a live bug — but a
  // silent skip is the worst possible failure mode here, so it fails safe.
  const next = order.findIndex((s) => !findStoredStep(night, s)?.resolved);
  night.wakeIndex = next === -1 ? order.length : next;
}

/** Closes the pause immediately. The Storyteller's "skip the wait" control. */
export function skipWakeGate(session: GameSession): void {
  const night = session.currentNight;
  if (!night?.wakeGate) return;
  night.wakeGate = null;
  advanceWakeCursor(session);
}

/**
 * Closes the pause if it has elapsed, and moves the walk on to the next waker.
 * Returns true when the flow changed and the caller should re-prompt and
 * re-broadcast.
 *
 * `now` is a parameter so tests can drive the clock instead of sleeping.
 */
export function tickNightGate(session: GameSession, now: number = Date.now()): boolean {
  const night = session.currentNight;
  if (!night?.wakeGate) return false;
  if (now < night.wakeGate.opensAt) return false;
  night.wakeGate = null;
  advanceWakeCursor(session);
  return true;
}

/** True while the pause before the next waker is still running. */
export function wakeGateIsPending(session: GameSession, now: number = Date.now()): boolean {
  const night = session.currentNight;
  if (!night?.wakeGate) return false;
  return now < night.wakeGate.opensAt;
}

export function firstPlayerOwingAChoice(session: GameSession): PlayerRecord | null {
  const step = currentWakeStep(session);
  if (!step) return null;
  if ((step.targetCount ?? 0) === 0) return null;
  if (!step.isPossible) return null;
  return session.players.get(step.wakerPlayerId) ?? null;
}

/**
 * A step that is still waiting on somebody.
 *
 * A step is outstanding only if it was not submitted AND it can actually be
 * completed. Two kinds are excluded, and both exclusions are the whole reason the
 * night can finish at all:
 *
 * - an auto-resolving character (Empath, Chef): `targetCount` is 0, so there is no
 *   picker to wait for;
 * - an unmakeable step (`isPossible: false`): its player has nothing to choose and
 *   the Storyteller has nothing to wait for.
 *
 * Everything that decides "is this night done" — the night-level flag, the stepper
 * counter, the outstanding list — must go through this one function. Two separate
 * definitions is how the night ends up flagged resolved while its own order view
 * still shows outstanding work.
 */
export function stepCountsAsOutstanding(session: GameSession, step: NightStep): boolean {
  const stored = findStoredStep(session.currentNight, step);
  if (stored?.resolved) return false;
  if (!step.isPossible) return false;
  return (step.targetCount ?? 0) > 0;
}

/**
 * Recomputes the night-level "finished" flag from the outstanding steps.
 *
 * Called whenever a step is submitted, resolved, or added, because the flag is a
 * cache of a derived fact. It is also the same rule the Storyteller's order view
 * and its stepper counter use, so the flag, the counter and the outstanding list
 * can never disagree about whether the night is done.
 */
export function isNightFinished(session: GameSession): boolean {
  const night = session.currentNight;
  if (!night) return false;
  // Both halves are needed. "The pass has run" alone would ignore a Ravenkeeper
  // still owing a pick; "nobody owes a choice" alone would fire the moment the
  // last picker submits, before the Chef and Empath have been passed and long
  // before dawn.
  return night.passComplete && buildNightOrder(session).every((step) => !stepCountsAsOutstanding(session, step));
}

export function recomputeNightResolved(session: GameSession): boolean {
  const night = session.currentNight;
  if (!night) return false;
  night.resolved = isNightFinished(session);
  return night.resolved;
}

/**
 * True when the Storyteller may move the wake walk past this player.
 *
 * "May move past" is the same statement as "nothing is waiting on this player", so
 * it goes through stepCountsAsOutstanding rather than being spelled out again at
 * the call site. When the two were written separately the walk deadlocked: the
 * guard read "targetCount is 0 or they already picked", which is false for an
 * UNMAKEABLE step that has a target count — a Librarian with no Outsiders in play,
 * an Investigator with no Minions. Nothing was waiting on that player, nobody was
 * prompted, and the night sat announcing their name at somebody who could not act
 * with no button that would move it on.
 */
export function wakerIsFinished(session: GameSession, playerId: string): boolean {
  const step = buildNightOrder(session).find((s) => s.wakerPlayerId === playerId);
  if (!step) return true;
  return !stepCountsAsOutstanding(session, step);
}

export function toNightOrderStepView(session: GameSession, step: NightStep): NightOrderStepView {
  const waker = session.players.get(step.wakerPlayerId);
  const def = getCharacterById(step.characterId);
  const stored = findStoredStep(session.currentNight, step);
  const legal = step.legalTargetIds ?? [];
  return {
    characterId: step.characterId,
    characterName: def?.name ?? step.characterId,
    wakerPlayerId: step.wakerPlayerId,
    wakerName: waker?.displayName ?? 'unknown',
    order: step.order,
    isFirstNight: step.isFirstNight,
    // An unmakeable step is shown as dealt with, because it is: there is nothing
    // for its player to do and nothing for the Storyteller to wait for.
    resolved: !stepCountsAsOutstanding(session, step),
    targetCount: step.targetCount,
    targetIds: stored?.targetIds ?? [],
    targetNames: (stored?.targetIds ?? []).map((id) => nameOfPlayer(session, id)),
    legalTargetIds: legal,
    legalTargetNames: legal.map((id) => nameOfPlayer(session, id)),
    autoResult: null,
    prompt: step.prompt ?? null,
    infoType: step.infoType,
    isDrunkCover: waker ? isDrunkCover(session, waker) : false,
    isPossible: step.isPossible,
    unavailableReason: step.unavailableReason,
    overrideText: stored?.overrideText ?? null,
  };
}

/** Storyteller-only projection of the whole night order, including the stepper cursor. */
export function toNightOrderUpdate(session: GameSession): NightOrderUpdatePayload {
  const steps = buildNightOrder(session).map((step) => toNightOrderStepView(session, step));
  const night = session.currentNight;
  return {
    nightNumber: session.nightNumber,
    isFirstNight: isFirstNightOf(session),
    phase: session.phase,
    steps,
    activeIndex: Math.max(0, Math.min(night?.activeIndex ?? 0, Math.max(0, steps.length - 1))),
    resolvedCount: steps.filter((s) => s.resolved).length,
    totalCount: steps.length,
    openedAt: night?.openedAt ?? null,
    // Excludes unmakeable steps. Listing one as outstanding is what makes the
    // night look like it is waiting on a player who can never act.
    outstandingCharacterIds: buildNightOrder(session)
      .filter((s) => stepCountsAsOutstanding(session, s))
      .map((s) => getCharacterById(s.characterId)?.name ?? s.characterId),
    resolved: isNightFinished(session),
  };
}

export function sendNightOrder(io: SocketIOServer, session: GameSession): void {
  sendToStoryteller(io, session, ServerEvents.NightOrderUpdate, toNightOrderUpdate(session));
}

export function toNightLog(session: GameSession): NightLogPayload {
  return { entries: session.log.map((e) => ({ night: e.night, at: e.at, kind: e.kind, detail: e.detail })) };
}

export function sendNightLog(io: SocketIOServer, session: GameSession): void {
  sendToStoryteller(io, session, ServerEvents.NightLog, toNightLog(session));
}
