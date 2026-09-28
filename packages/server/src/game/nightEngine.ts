import {
  TROUBLE_BREWING_CHARACTERS,
  getCharacterById,
  type AutomationClass,
  type NightRosterPayload,
  type NightStepView,
} from '@clocktower/shared';
import type { GameSession, NightState, PlayerRecord } from '../session/store.js';
import { livingNeighborsOf, livingPlayerCount, playersBySeat } from '../session/store.js';
import { Errors } from '../errors.js';

/**
 * Computes tonight's wake order: every living player whose character wakes
 * on this night (per firstNightOrder/otherNightOrder), sorted by that
 * order. Matches NightOrderPanel's existing client-side logic, but this is
 * now the server-authoritative version the engine actually steps through.
 */
export function computeWakeOrder(session: GameSession, isFirstNight: boolean): string[] {
  const orderKey = isFirstNight ? 'firstNightOrder' : 'otherNightOrder';
  // The Ravenkeeper only wakes "if you die at night" -- unlike every other
  // role here, being alive is NOT the wake condition; having just died at
  // night is. Every other character in this table requires being alive.
  const players = [...session.players.values()].filter((p) => {
    if (!p.character) return false;
    if (p.character === 'ravenkeeper') return p.diedAtNightPending;
    return p.alive;
  });

  const withOrder = players
    .map((p) => ({ player: p, def: getCharacterById(p.character!) }))
    .filter((entry): entry is { player: PlayerRecord; def: NonNullable<ReturnType<typeof getCharacterById>> } => {
      if (!entry.def) return false;
      return entry.def[orderKey] !== null;
    })
    .sort((a, b) => (a.def[orderKey] as number) - (b.def[orderKey] as number));

  return withOrder.map((entry) => entry.player.playerId);
}

/**
 * Starts a fresh NightState for the night the session is now transitioning
 * into. Also clears `protected` and `poisoned` from every player -- both
 * are single-cycle effects (Monk's protection lasts only the night it was
 * granted; the Poisoner's poison lasts that night plus the following day)
 * so by the time a NEW night starts, any protection/poison from the
 * previous cycle has already run its course and must not carry over.
 * Called from the StorytellerSetPhase handler.
 */
export function startNight(session: GameSession, isFirstNight: boolean): NightState {
  const wakeOrder = computeWakeOrder(session, isFirstNight);

  // Clear single-cycle status effects and the Ravenkeeper's conditional-wake
  // marker AFTER computing the wake order (so a Ravenkeeper who died last
  // night is correctly included in THIS wake order), but before returning,
  // so the flag doesn't linger into the following night.
  for (const player of session.players.values()) {
    player.statusEffects.protected = false;
    player.statusEffects.poisoned = false;
    player.diedAtNightPending = false;
  }
  const nightState: NightState = {
    isFirstNight,
    wakeOrder,
    currentStepIndex: 0,
    submissions: new Map(),
    results: new Map(),
  };
  session.nightState = nightState;
  return nightState;
}

function automationClassFor(playerId: string, session: GameSession): AutomationClass | null {
  const player = session.players.get(playerId);
  if (!player?.character) return null;
  return getCharacterById(player.character)?.automationClass ?? null;
}

/** Builds the Storyteller-facing live roster view: who's woken, who's pending, who's currently active. */
export function buildNightRoster(session: GameSession): NightRosterPayload | null {
  const nightState = session.nightState;
  if (!nightState) return null;

  const steps: NightStepView[] = nightState.wakeOrder.map((playerId, index) => {
    const player = session.players.get(playerId);
    const def = player?.character ? getCharacterById(player.character) : undefined;
    return {
      playerId,
      characterId: def?.id ?? '',
      characterName: def?.name ?? 'Unknown',
      automationClass: def?.automationClass ?? 'manual',
      done: nightState.results.has(playerId) || nightState.submissions.has(playerId),
      current: index === nightState.currentStepIndex,
    };
  });

  return { isFirstNight: nightState.isFirstNight, steps };
}

/** Advances to the next step in tonight's wake order, if any remain. Idempotent past the end. */
export function advanceNightStep(session: GameSession): void {
  const nightState = session.nightState;
  if (!nightState) return;
  if (nightState.currentStepIndex < nightState.wakeOrder.length) {
    nightState.currentStepIndex += 1;
  }
}

// ---------------------------------------------------------------------------
// Fully-automatic ('auto') role resolvers -- pure functions of game state,
// no player choice or Storyteller judgment involved.
// ---------------------------------------------------------------------------

/** Chef: how many pairs of adjacent-seated evil players there are, counting around the whole circle (not just living neighbours). */
export function resolveChef(session: GameSession): string {
  const seated = playersBySeat(session);
  const n = seated.length;
  if (n < 2) return 'There are 0 pairs of evil players sitting next to each other.';
  let pairs = 0;
  for (let i = 0; i < n; i++) {
    const a = seated[i]!;
    const b = seated[(i + 1) % n]!;
    if (a.alignment === 'evil' && b.alignment === 'evil') pairs++;
  }
  return `There ${pairs === 1 ? 'is' : 'are'} ${pairs} pair${pairs === 1 ? '' : 's'} of evil players sitting next to each other.`;
}

/** Empath: how many of a specific player's 2 alive neighbours are evil. */
export function resolveEmpath(session: GameSession, empathPlayerId: string): string {
  const { left, right } = livingNeighborsOf(session, empathPlayerId);
  const evilCount = [left, right].filter((n) => n?.alignment === 'evil').length;
  return `${evilCount} of your 2 alive neighbours ${evilCount === 1 ? 'is' : 'are'} evil.`;
}

/** Undertaker: which character died by execution TODAY (not a night kill, and not on a day with no execution). */
export function resolveUndertaker(session: GameSession, executedTodayCharacterId: string | null): string {
  if (!executedTodayCharacterId) {
    return 'Nobody was executed today.';
  }
  const def = getCharacterById(executedTodayCharacterId);
  return `The player who was executed today was the ${def?.name ?? 'Unknown'}.`;
}

/**
 * Whether the game currently has a living Scarlet Woman eligible to take
 * over -- surfaced here only for the Storyteller's night-roster context;
 * the actual takeover logic already lives in winConditions.ts and runs at
 * the moment the Demon dies, not as its own night step.
 */
export function scarletWomanEligible(session: GameSession): boolean {
  if (livingPlayerCount(session) < 5) return false;
  return [...session.players.values()].some((p) => p.alive && p.character === 'scarlet-woman');
}

// ---------------------------------------------------------------------------
// Target legality (used by both the eligible-target list sent to the
// waking player, and server-side validation of their actual submission).
// ---------------------------------------------------------------------------

export interface NightActionSubmitResult {
  /** Composed result text to deliver back to the acting player, if their action produces info (e.g. Ravenkeeper). Null for actions with no info (Monk, Butler). */
  resultText: string | null;
}

/**
 * Records and mechanically resolves an 'assisted'-class night action. The
 * kill (Imp) is intentionally NOT handled here -- it goes through the
 * existing resolveDemonKill/gateway path instead, since it has its own
 * broadcast/win-check/inheritance side effects that don't belong in a pure
 * per-role resolver. This covers Monk, Ravenkeeper, Butler, and Poisoner.
 */
export function submitAssistedNightAction(
  session: GameSession,
  actingPlayerId: string,
  targetPlayerIds: string[]
): NightActionSubmitResult {
  const actor = session.players.get(actingPlayerId);
  if (!actor?.character) throw Errors.playerNotFound();
  const def = getCharacterById(actor.character);
  if (!def) throw Errors.playerNotFound();

  const expectedCount = def.targetCount ?? 0;
  if (targetPlayerIds.length !== expectedCount) throw Errors.wrongTargetCount(expectedCount);

  const legalTargets = new Set(eligibleNightTargets(session, actingPlayerId));
  for (const id of targetPlayerIds) {
    if (!legalTargets.has(id)) throw Errors.invalidNightTarget();
  }

  const targets = targetPlayerIds.map((id) => session.players.get(id)!);

  switch (actor.character) {
    case 'monk': {
      targets[0]!.statusEffects.protected = true;
      return { resultText: null };
    }
    case 'poisoner': {
      targets[0]!.statusEffects.poisoned = true;
      return { resultText: null };
    }
    case 'butler': {
      // Recorded for reference only -- per the official rules the
      // Storyteller does not enforce Butler vote-gating.
      return { resultText: null };
    }
    case 'ravenkeeper': {
      const targetDef = getCharacterById(targets[0]!.character ?? '');
      return { resultText: `Their character is the ${targetDef?.name ?? 'Unknown'}.` };
    }
    default:
      // Imp and anything else with automationClass 'assisted' that isn't
      // wired here yet -- callers should route those through their own
      // dedicated handler instead of this generic one.
      throw Errors.notYourNightAction();
  }
}

/** Computes the legal target playerIds for `actingPlayerId`'s character, applying its declared targetRestrictions. */
export function eligibleNightTargets(session: GameSession, actingPlayerId: string): string[] {
  const actor = session.players.get(actingPlayerId);
  if (!actor?.character) return [];
  const def = getCharacterById(actor.character);
  if (!def) return [];
  const restrictions = def.targetRestrictions ?? [];

  return [...session.players.values()]
    .filter((p) => {
      if (restrictions.includes('other') && p.playerId === actingPlayerId) return false;
      if (restrictions.includes('self') && p.playerId !== actingPlayerId) return false;
      if (restrictions.includes('alive') && !p.alive) return false;
      if (restrictions.includes('dead') && p.alive) return false;
      if (restrictions.includes('townsfolk') && p.characterType !== 'townsfolk') return false;
      if (restrictions.includes('outsider') && p.characterType !== 'outsider') return false;
      if (restrictions.includes('minion') && p.characterType !== 'minion') return false;
      if (restrictions.includes('demon') && p.characterType !== 'demon') return false;
      return true;
    })
    .map((p) => p.playerId);
}
