import type { Server as SocketIOServer } from 'socket.io';
import {
  ServerEvents,
  getCharacterById,
  type CharacterDefinition,
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

  for (const player of playersInSeatOrder(session)) {
    if (player.alive) continue;
    if (player.character !== 'ravenkeeper') continue;
    const def = getCharacterById('ravenkeeper');
    if (!def) continue;
    const order = orderFor(def, isFirstNight) ?? Number.MAX_SAFE_INTEGER;
    steps.push(buildStep(session, player, def, order, isFirstNight));
  }

  return steps.sort(
    (a, b) => a.order - b.order || (session.players.get(a.wakerPlayerId)?.seatIndex ?? 0) - (session.players.get(b.wakerPlayerId)?.seatIndex ?? 0)
  );
}

function buildStep(
  session: GameSession,
  player: PlayerRecord,
  def: CharacterDefinition,
  order: number,
  isFirstNight: boolean
): NightStep {
  const targetCount = def.targetCount ?? 0;
  const legalTargets =
    targetCount > 0 ? legalTargetsFor(session, player, def, { isDrunk: isDrunkCover(session, player) }) : [];
  return {
    characterId: def.id,
    order,
    wakerPlayerId: player.playerId,
    isFirstNight,
    resolved: false,
    targetCount,
    legalTargetIds: targetCount > 0 ? legalTargets.map((p) => p.playerId) : undefined,
    prompt: def.nightPrompt,
    infoType: def.infoType ?? 'none',
  };
}

function findStoredStep(night: NightState | null, step: NightStep): NightStepState | undefined {
  return night?.steps.find((s) => s.wakerPlayerId === step.wakerPlayerId && s.characterId === step.characterId);
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

  session.currentNight = { steps, openedAt: Date.now(), activeIndex: 0, resolved: false, briefed: false };
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
  if (night.resolved && step.characterId !== 'ravenkeeper') throw Errors.nightAlreadyResolved();

  const waker = session.players.get(playerId);
  if (!waker) throw Errors.playerNotFound();

  const def = getCharacterById(step.characterId);
  if (!def) throw Errors.playerNotFound();
  const targetCount = def.targetCount ?? 0;
  if (targetCount === 0) throw Errors.nothingToChoose();

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

  if (night.resolved && io) {
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
  if (night.resolved) throw Errors.nightAlreadyResolved();
  if (session.phase !== 'night') throw Errors.notNightPhase();

  const report: NightResolutionReport = { outstanding: [], killedPlayerIds: [], inheritance: null };

  for (const step of buildNightOrder(session)) {
    const stored = findStoredStep(night, step);
    if (!stored) continue;

    const waker = session.players.get(step.wakerPlayerId);
    if (!waker) continue;
    const def = getCharacterById(step.characterId);
    if (!def) continue;

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
            zero: 'You learn that none of your living neighbours is evil.',
            one: 'You learn that one of your living neighbours is evil.',
            many: (n) => `You learn that ${n} of your living neighbours are evil.`,
          })
        );
        break;
      }
      case 'undertaker': {
        const executed = executedPlayerToday(session);
        const info = generateCharacterInfo(lieContext(session, waker, def.id), executed?.character ?? null);
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
            if (target.character === 'mayor') {
              logNightEvent(
                session,
                'mayor-death',
                `${target.displayName} is the Mayor and died at night. The Storyteller may choose for another player to die instead.`
              );
            }
          } else {
            logNightEvent(session, 'protection-saved', `${target.displayName} was protected (Monk or Soldier) and survived.`);
          }
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
  night.resolved = true;

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
  if (!night || night.resolved) return;
  // During the briefing nobody is awake yet.
  if (!night.briefed) return;

  for (const step of buildNightOrder(session)) {
    const stored = findStoredStep(night, step);
    if (!stored || stored.resolved) continue;
    if ((step.targetCount ?? 0) === 0) continue;
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
    const stored = findStoredStep(night, step);
    if (!stored || stored.resolved) continue;
    const player = session.players.get(step.wakerPlayerId);
    if (player) names.push(player.displayName);
  }
  return names;
}

/**
 * Marks auto-resolving steps the Storyteller's cursor has walked past as dealt
 * with.
 *
 * A character with no night pick — the Chef, the Empath, the Undertaker, the Spy —
 * still wakes: their name is called, they are given their information, and they
 * go back to sleep. There is nothing for them to submit, so the step stays open
 * forever and the wake walk can never reach the people after them. Marking them
 * as the cursor passes is what lets the flow announce EVERY waker in the official
 * order rather than only the ones who make a choice.
 *
 * Their actual information is still delivered by `resolveNight` at dawn, which is
 * when the engine applies the night. This only records that the wake-up happened.
 */
export function markPassedAutoSteps(session: GameSession): void {
  const night = session.currentNight;
  if (!night) return;
  const order = buildNightOrder(session);
  for (let i = 0; i < night.activeIndex && i < order.length; i++) {
    const step = order[i]!;
    if ((step.targetCount ?? 0) > 0) continue;
    const stored = findStoredStep(night, step);
    if (stored && !stored.resolved) stored.resolved = true;
  }
}

/**
 * The first player, in official order, who still owes a choice. This is the same
 * computation the flow uses to decide who the Storyteller should wake, so the
 * prompt and the spoken line can never disagree about who is up.
 */
export function firstPlayerOwingAChoice(session: GameSession): PlayerRecord | null {
  const night = session.currentNight;
  if (!night || night.resolved) return null;
  for (const step of buildNightOrder(session)) {
    if ((step.targetCount ?? 0) === 0) continue;
    const stored = findStoredStep(night, step);
    if (!stored || stored.resolved) continue;
    return session.players.get(step.wakerPlayerId) ?? null;
  }
  return null;
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
    resolved: stored?.resolved ?? false,
    targetCount: step.targetCount,
    targetIds: stored?.targetIds ?? [],
    targetNames: (stored?.targetIds ?? []).map((id) => nameOfPlayer(session, id)),
    legalTargetIds: legal,
    legalTargetNames: legal.map((id) => nameOfPlayer(session, id)),
    autoResult: null,
    prompt: step.prompt ?? null,
    infoType: step.infoType,
    isDrunkCover: waker ? isDrunkCover(session, waker) : false,
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
    outstandingCharacterIds: steps.filter((s) => s.targetCount > 0 && !s.resolved).map((s) => s.characterName),
    resolved: night?.resolved ?? false,
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
