import type { WinningTeam, GameEndReason } from '@clocktower/shared';
import type { GameSession, PlayerRecord } from '../session/store.js';
import { livingPlayerCount } from '../session/store.js';
import { reassignBluffFor } from './demonKill.js';

export interface WinCheckResult {
  winner: WinningTeam;
  reason: GameEndReason;
}

export interface ScarletWomanTakeoverResult {
  previousDemonPlayerId: string;
  newDemonPlayerId: string;
  newDemonCharacterId: string;
}

function livingDemon(session: GameSession): PlayerRecord | null {
  for (const p of session.players.values()) {
    if (p.alive && p.characterType === 'demon') return p;
  }
  return null;
}

/**
 * Scarlet Woman: "If there are 5 or more players alive & the Demon dies,
 * you become the Demon." This must be checked (and resolved) BEFORE
 * checkWinCondition() whenever the Demon is executed, so a legitimate
 * hand-off doesn't get mistaken for "no Demon left -> Good wins." Does
 * nothing (returns null) if no living Scarlet Woman exists, or the living
 * player count (AFTER this death) is below 5.
 */
export function tryScarletWomanTakeover(session: GameSession, deadDemonId: string): ScarletWomanTakeoverResult | null {
  // FIXME(issue #2 follow-up): the official text is "if there are 5 or MORE
  // players alive", which is `livingPlayerCount(session) >= 5`. This reads `< 5`,
  // so a 5-alive game does not trigger the takeover. That off-by-one is tracked
  // separately and deliberately NOT fixed here — mixing it into the Night Engine
  // work would make this review much harder to read.
  if (livingPlayerCount(session) < 5) return null;

  const scarletWoman = [...session.players.values()].find(
    (p) => p.alive && p.character === 'scarlet-woman' && p.playerId !== deadDemonId
  );
  if (!scarletWoman) return null;

  const deadDemon = session.players.get(deadDemonId);
  const inheritedCharacterId = deadDemon?.character ?? null;

  scarletWoman.character = inheritedCharacterId;
  scarletWoman.characterType = 'demon';
  // The takeover invalidates the registration and the bluff the Scarlet Woman
  // was playing on, for the same reason the Imp hand-off does.
  scarletWoman.registration = { alignment: null, characterType: null };
  reassignBluffFor(session, scarletWoman);

  return {
    previousDemonPlayerId: deadDemonId,
    newDemonPlayerId: scarletWoman.playerId,
    newDemonCharacterId: inheritedCharacterId ?? '',
  };
}

/**
 * Checks whether the game has just ended, per the standard Trouble Brewing
 * win conditions:
 *   - Good wins the instant there is no living Demon (it died and nobody
 *     inherited the role — see demonKill.ts for Imp self-kill / Scarlet
 *     Woman inheritance, which must run BEFORE this check so a legitimate
 *     hand-off doesn't falsely end the game).
 *   - Evil wins the instant only 2 players remain alive.
 * Returns null if the game should continue. Callers are expected to run
 * this after any death (execution or night kill) and after any
 * demon-inheritance logic has already resolved.
 */
export function checkWinCondition(session: GameSession, deathReason: 'executed' | 'self-killed'): WinCheckResult | null {
  const living = livingPlayerCount(session);

  if (living <= 2) {
    return { winner: 'evil', reason: 'two-players-left' };
  }

  if (!livingDemon(session)) {
    return {
      winner: 'good',
      reason: deathReason === 'executed' ? 'demon-executed' : 'demon-self-killed',
    };
  }

  return null;
}

export function endGame(session: GameSession, winner: WinningTeam, reason: GameEndReason): void {
  session.phase = 'ended';
  session.gameResult = { winner, reason };
}

/**
 * Saint: "If you die by execution, your team loses."
 *
 * Checked from the execution itself rather than from a generic death sweep,
 * because a night death is explicitly NOT a trigger — only execution is. Returns
 * null when the executed player is not a functioning Saint.
 *
 * A DRUNK OR POISONED SAINT DOES NOT TRIGGER. A poisoned player has no ability,
 * and the Poisoner poisons "tonight and tomorrow day" — so a Saint poisoned
 * before being executed really does not take their team down with them. This is a
 * well-known ruling and getting it wrong hands Evil an instant, unearned win, so
 * it is called out explicitly rather than left implicit.
 */
export function checkSaintExecution(session: GameSession, executedPlayerId: string): WinCheckResult | null {
  const saint = session.players.get(executedPlayerId);
  if (!saint) return null;
  if (saint.character !== 'saint') return null;
  if (saint.statusEffects.poisoned || saint.statusEffects.drunk) return null;
  return { winner: 'evil', reason: 'saint-executed' };
}

/**
 * Mayor: "If only 3 players live & no execution occurs, your team wins."
 *
 * All three clauses are load-bearing and all three are enforced here:
 *   - exactly 3 living (not 2 — that is the generic Evil win),
 *   - a living Mayor,
 *   - and no execution today, which means no QUALIFYING nomination on the record
 *     and no nomination still awaiting a ruling. A day that is still running its
 *     first vote has not yet had "no execution", so the Mayor cannot trigger
 *     while a vote is still open.
 */
export function checkMayorWin(session: GameSession): WinCheckResult | null {
  if (livingPlayerCount(session) !== 3) return null;
  const mayor = [...session.players.values()].find((p) => p.alive && p.character === 'mayor');
  if (!mayor) return null;
  if (session.resolvedNominationsToday.length > 0) return null;
  if (session.nomination && (!session.nomination.closed || session.nomination.pendingExecution)) return null;
  if (mayor.statusEffects.poisoned || mayor.statusEffects.drunk) return null;
  return { winner: 'good', reason: 'mayor-three-left' };
}
