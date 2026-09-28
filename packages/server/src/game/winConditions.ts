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
 * Scarlet Woman: "If there are 5 or more players alive & the Demon dies, you
 * become the Demon."
 *
 * THE COUNT IS TAKEN JUST BEFORE THE DEMON DIES, which is the detail this function
 * used to get wrong, and the `FIXME` that stood here described the symptom correctly
 * but proposed the wrong fix — it suggested `livingPlayerCount >= 5`, which is what the
 * code already did, so "fixing" it would have baked the off-by-one in permanently.
 *
 * The almanac is explicit about the equivalence:
 *
 *   "If there are five or more players alive just before the Demon dies — that is,
 *    FOUR OR MORE PLAYERS LEFT ALIVE AFTER the Demon dies — then the Scarlet Woman
 *    immediately becomes the Demon, and the game continues as if nothing happened."
 *
 * This function is called with the Demon ALREADY dead (from `handlePostDeath`), so
 * `livingPlayerCount` is the AFTER count and the threshold on it is four.
 *
 * The old `< 5` therefore demanded FIVE survivors, i.e. six alive before the death, and
 * so silently skipped the trigger at exactly the boundary the card names. At five alive
 * the takeover did not fire, the fall-through found no living Demon, and the game
 * announced "Good wins! The Demon was executed." — handing Good a win Evil had not
 * earned, to a table whose Scarlet Woman was sitting right there.
 *
 * Does nothing (returns null) if no living Scarlet Woman exists, or if fewer than four
 * players are left alive after the Demon dies.
 */
export function tryScarletWomanTakeover(session: GameSession, deadDemonId: string): ScarletWomanTakeoverResult | null {
  if (livingPlayerCount(session) < 4) return null;

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
 *   - Evil wins the instant only 2 players remain alive AND a Demon still stands.
 * Returns null if the game should continue. Callers are expected to run
 * this after any death (execution or night kill) and after any
 * demon-inheritance logic has already resolved.
 *
 * THE ORDER OF THOSE TWO CHECKS IS THE WHOLE POINT, and it used to be the other
 * way round, which handed the game to the wrong team:
 *
 *   "If both teams would win at the same time, good wins. For example, if the
 *    Demon dies but that leaves only two players left, the good team wins."
 *    — rulebook, Ending the Game
 *
 * So the no-Demon test has to come FIRST. Testing the living count first meant that
 * executing the Demon on the last three players announced "Evil wins! Only two
 * players remain." at a table that had just correctly executed the Demon. Found by
 * playing a 6-player game down to three and executing the Imp.
 *
 * The 2-alive test is not dead code, and remains the ordinary Evil win: it fires
 * when a Minion has inherited the Imp and the table thins to two with a Demon
 * still standing.
 */
export function checkWinCondition(
  session: GameSession,
  deathReason: 'executed' | 'self-killed' | 'slain'
): WinCheckResult | null {
  const living = livingPlayerCount(session);

  // Good wins ties, so this is checked first and unconditionally.
  if (!livingDemon(session)) {
    // The reason is a sentence the whole table reads, so it has to describe the event that
    // actually happened. Reusing `demon-self-killed` for a Slayer kill announced that the
    // Demon killed themself, which is a different event and is not something the table
    // believes.
    const reason =
      deathReason === 'executed'
        ? 'demon-executed'
        : deathReason === 'slain'
          ? 'demon-slain'
          : 'demon-self-killed';
    return { winner: 'good', reason };
  }

  if (living <= 2) {
    return { winner: 'evil', reason: 'two-players-left' };
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
 * Checked at DUSK — the end of the day — per the almanac: "At dusk, if exactly three
 * players are alive and no player was executed today, declare that the game ends and
 * good wins."
 *
 * It used to be called at DAWN, immediately after `resetForNewDay()` had cleared the
 * record it depended on, so "no execution today" was true BY CONSTRUCTION and the only
 * surviving guards were the living count and a living Mayor. Two consequences, both
 * wrong:
 *
 *   - a 3-alive table ended the game at dawn, before anyone opened their eyes, while
 *     the table still had a decision to make — and that decision (executing somebody)
 *     would drop to 2 alive, which is an EVIL win Evil had not earned;
 *   - after any execution, the Mayor still won, because the evidence had been deleted.
 *
 * The guard is now `session.executionHappenedToday`, which is a stored day-scoped fact
 * rather than something derived from a list that execution used to drain.
 */
export function checkMayorWin(session: GameSession): WinCheckResult | null {
  if (livingPlayerCount(session) !== 3) return null;
  const mayor = [...session.players.values()].find((p) => p.alive && p.character === 'mayor');
  if (!mayor) return null;
  // The clause the whole function exists for.
  if (session.executionHappenedToday) return null;
  // A nomination still in play means the day has not finished deciding.
  if (session.nomination && (!session.nomination.closed || session.nomination.pendingExecution)) return null;
  if (mayor.statusEffects.poisoned || mayor.statusEffects.drunk) return null;
  return { winner: 'good', reason: 'mayor-three-left' };
}
