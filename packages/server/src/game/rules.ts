import { nanoid } from 'nanoid';
import type { ActiveNominationView } from '@clocktower/shared';
import type { ActiveNomination, GameSession, PlayerRecord } from '../session/store.js';
import { livingPlayerCount } from '../session/store.js';
import { Errors } from '../errors.js';
import { slayerWouldKill, virginTriggersExecution } from './abilities.js';
import { checkSaintExecution } from './winConditions.js';

/**
 * An execution or death that a day character's ability forced, with no vote to confirm.
 *
 * Both the Virgin and the Slayer say "immediately", so neither goes through
 * `pendingExecution` and the Storyteller gets no Execute button: the outcome is already
 * decided by the time the nomination resolves. Read from `session.immediateExecution`
 * after `nominate` or `closeVote`, and it is server-owned — never sent to a client raw.
 */
export interface ImmediateExecution {
  playerId: string;
  cause: 'virgin' | 'slayer';
  /** The nomination that provoked it, so the client can name what happened. */
  nominationId: string | null;
  /** The character whose text forced it — the Virgin, or the Slayer. */
  byCharacterId: string;
}

export function nominate(
  session: GameSession,
  nominatorId: string,
  targetId: string
): ActiveNomination | null {
  const nominator = session.players.get(nominatorId);
  const target = session.players.get(targetId);
  if (!nominator || !target) throw Errors.playerNotFound();
  if (!nominator.alive) throw Errors.nominatorDead();
  if (target.alive === false) throw Errors.targetDead();
  if (nominator.hasNominatedToday) throw Errors.alreadyNominatedToday();
  // "Each player may nominate only once per day, and each player may be nominated
  // only once per day." The second half used to go unchecked, so a failed vote could
  // be re-run on the same person for the rest of the day.
  if (target.hasBeenNominatedToday) throw Errors.alreadyNominatedToday();
  if (session.nomination && !session.nomination.closed) throw Errors.nominationInProgress();
  // A second nomination is legal even while an earlier one is waiting to be executed.
  // The rules require it: "The vote succeeds if the nominated player got more votes than
  // any other nominated player today" and the tie rule tells the table to "call again for
  // nominations and tally the next nominee" — which only makes sense if a day can hold
  // several passed votes for comparison.
  //
  // So the pending execution is NOT protected by refusing nominations. It is protected by
  // living on the SESSION, in `pendingExecution`, instead of on whichever nomination
  // object happens to be current. Before, a new nomination replaced
  // `session.nomination` and took the pending execution with it, which is how an
  // execution could be silently lost.
  //
  // "There is a maximum of one execution per day." Once somebody has been executed the
  // day is over, so nothing more can be put to a vote.
  if (session.executionHappenedToday) throw Errors.alreadyNominatedToday();

  /*
   * THE VIRGIN. "The 1st time you are nominated, if the nominator is a Townsfolk, they
   * are executed immediately."
   *
   * "Immediately" is doing real work: the ability resolves when the nomination is MADE,
   * not when the vote closes, and the nomination does not continue. This is checked here
   * rather than in the gateway so that it cannot be bypassed by any other caller — the
   * predicates existed, were exported, and nothing ever called them, so both characters
   * were inert for the whole life of the app.
   */
  session.immediateExecution = null;
  const virginKills = virginTriggersExecution(session, targetId, nominatorId);
  if (virginKills) {
    session.virginHasTriggered = true;
    const victim = session.players.get(virginKills)!;
    // The Virgin's ability IS an execution, so it consumes the day's one execution and
    // is what the Undertaker learns about tonight — exactly like a passed vote.
    applyExecution(session, victim);
    session.immediateExecution = {
      playerId: victim.playerId,
      cause: 'virgin',
      nominationId: null,
      byCharacterId: 'virgin',
    };
    nominator.hasNominatedToday = true;
    target.hasBeenNominatedToday = true;
    return null;
  }

  const nomination: ActiveNomination = {
    id: nanoid(10),
    nominatorId,
    targetId,
    votes: new Map(),
    openedAt: Date.now(),
    closed: false,
    pendingExecution: false,
    executed: false,
    resolvedTally: null,
  };
  nominator.hasNominatedToday = true;
  target.hasBeenNominatedToday = true;
  session.nomination = nomination;
  return nomination;
}

export function castVote(session: GameSession, nominationId: string, playerId: string, voting: boolean): ActiveNomination {
  const nomination = session.nomination;
  if (!nomination || nomination.id !== nominationId) throw Errors.noActiveNomination();
  if (nomination.closed) throw Errors.nominationClosed();

  const voter = session.players.get(playerId);
  if (!voter) throw Errors.playerNotFound();

  if (!voter.alive) {
    if (voter.usedDeadVote && voting) {
      throw Errors.noDeadVoteRemaining();
    }
    if (voting) {
      // Using the ghost vote is consumed the moment it's cast, regardless of later retraction.
      voter.usedDeadVote = true;
    }
  }

  // Butler: "tomorrow, you may only vote if they are voting too." A poisoned or
  // drunk Butler's ability does not function, so the restriction does not apply.
  if (voting && !voter.statusEffects.poisoned && !voter.statusEffects.drunk) {
    const choice = voter.butlerChoice;
    if (choice && choice.forDayNumber === session.dayNumber) {
      const master = session.players.get(choice.masterPlayerId);
      if (master && nomination.votes.get(choice.masterPlayerId) !== true) {
        throw Errors.butlerMustFollow();
      }
    }
  }

  nomination.votes.set(playerId, voting);
  return nomination;
}

/** ceil(livingPlayers / 2), the standard 50%-or-more execution threshold. */
export function executionThreshold(session: GameSession): number {
  return Math.ceil(livingPlayerCount(session) / 2);
}

/**
 * The highest tally any earlier nomination reached today, or 0.
 *
 * The rulebook: "The vote succeeds if the nominated player got more votes than any
 * other nominated player today, AND the number of votes equals or exceeds half the
 * number of alive players." So a nomination has to beat the day's best, not merely
 * the threshold. Kept as a function so the view, the tally and the resolution all read
 * the same fact.
 */
export function highestQualifyingTallyToday(session: GameSession): number {
  return session.resolvedNominationsToday.reduce((best, r) => Math.max(best, r.tally), 0);
}

export function tally(nomination: ActiveNomination): number {
  let count = 0;
  for (const voting of nomination.votes.values()) {
    if (voting) count++;
  }
  return count;
}

/**
 * Resolves a closed vote.
 *
 * The rules have THREE conditions, and this used to implement two of them:
 *
 *   "The vote succeeds if:
 *    • The nominated player got MORE VOTES THAN ANY OTHER NOMINATED PLAYER TODAY, and
 *    • The number of votes EQUALS OR EXCEEDS HALF the number of alive players."
 *
 *   "If the vote ties with a player nominated earlier today, then neither nominated
 *    player will be executed… A nominated player must EXCEED THIS TIED NUMBER of votes
 *    to become 'about to die' by execution."
 *
 * So a nomination has to clear the threshold AND beat the day's best tally. It only
 * ever tested for an exact TIE, so the descending ladder that a real day produces —
 * 5 hands, then 4 — flagged both as qualifying, and the player with FEWER votes was
 * the one flagged for execution.
 *
 * And the tie used to DELETE the earlier record:
 *
 *   session.resolvedNominationsToday = filter((r) => r.tally !== votesFor)
 *
 * which threw away the floor the rules say must persist. Two players tie at 4, both walk,
 * and then a third nomination with the identical 4 executed — the single most natural
 * thing for a table to do. The record is now kept, so the tied number stays the bar for
 * the rest of the day.
 */
export function closeVote(session: GameSession, nominationId: string): ActiveNomination {
  const nomination = session.nomination;
  if (!nomination || nomination.id !== nominationId) throw Errors.noActiveNomination();
  if (nomination.closed) throw Errors.nominationClosed();

  const votesFor = tally(nomination);
  const threshold = executionThreshold(session);
  const bestSoFar = highestQualifyingTallyToday(session);

  const meetsThreshold = votesFor >= threshold && votesFor > 0;
  const beatsTheDay = votesFor > bestSoFar;
  const qualifies = meetsThreshold && beatsTheDay;

  nomination.closed = true;
  nomination.resolvedTally = votesFor;
  session.immediateExecution = null;

  if (qualifies) {
    /*
     * THE SLAYER. "Once per game, during the day, publicly choose a player: if they are
     * the Demon, they die."
     *
     * A nomination is the public act this app already has, so the Slayer's ability is
     * driven by a successful nomination — which is also how the predicate was written
     * (`slayerWouldKill(session, slayerId, targetId)`, with the caller doing the kill).
     * Perception is honoured inside the predicate, so a Recluse registering as the Demon
     * can be Slain, and the Slayer learns nothing about whether they were right.
     *
     * This dies HERE and not on the Execute button, because the text says "immediately".
     * It is deliberately NOT an execution: it is not the town executing anyone, so it
     * does not spend the day's one execution and the Undertaker is not told about it.
     */
    if (slayerWouldKill(session, nomination.nominatorId, nomination.targetId)) {
      session.slayerHasUsed = true;
      const slain = session.players.get(nomination.targetId)!;
      slain.alive = false;
      session.immediateExecution = {
        playerId: slain.playerId,
        cause: 'slayer',
        nominationId: nomination.id,
        byCharacterId: 'slayer',
      };
      return nomination;
    }
    nomination.pendingExecution = true;
    // Recorded whether or not it is later executed: it is the day's floor, not a list
    // of people about to die.
    session.resolvedNominationsToday.push({ targetId: nomination.targetId, tally: votesFor });
    // The execution now waiting to happen, addressed by nomination id so that a LATER
    // nomination cannot destroy it by replacing `session.nomination`.
    session.pendingExecution = { nominationId: nomination.id, targetId: nomination.targetId };
  } else {
    nomination.pendingExecution = false;
    /*
     * A tie invalidates the earlier nomination as well — "neither nominated player
     * will be executed" — and its tally STAYS on the record as the floor. Nothing is
     * removed here. The point is that a later nomination must beat its number.
     *
     * If the earlier nomination was the one waiting to be executed, it is no longer
     * waiting: a tie takes it off the block.
     */
    if (votesFor > 0 && votesFor === bestSoFar && session.pendingExecution?.nominationId !== nomination.id) {
      const tied = session.resolvedNominationsToday.find((r) => r.tally === votesFor);
      if (tied && session.pendingExecution?.targetId === tied.targetId) {
        session.pendingExecution = null;
      }
    }
  }

  return nomination;
}

export interface ExecutionResult {
  targetPlayerId: string;
  wasDemon: boolean;
  /** True when the executed player is a functioning Saint, so Evil wins immediately. */
  wasSaint: boolean;
}

export function confirmExecution(session: GameSession, nominationId: string): ExecutionResult {
  /*
   * Acts on `session.pendingExecution`, not on `session.nomination`.
   *
   * `session.nomination` is only the most recent nomination, so requiring the id to
   * match it meant an execution stopped being confirmable the moment the table opened
   * another nomination — which the rules invite them to do, since the day's tallies are
   * compared and a tie tells the Storyteller to "call again for nominations". The pending
   * execution is a day-scoped fact addressed by its own id.
   */
  const pending = session.pendingExecution;
  if (!pending || pending.nominationId !== nominationId) throw Errors.invalidPhaseTransition();
  const target = session.players.get(pending.targetId);
  if (!target) throw Errors.playerNotFound();
  // You cannot execute a corpse, whatever the vote said.
  if (!target.alive) throw Errors.targetDead();
  // "There is a maximum of one execution per day." This was unreachable while the
  // Execute button did not exist, and becomes live the moment that is restored, so it
  // is enforced here rather than relying on the UI.
  if (session.executionHappenedToday) throw Errors.alreadyNominatedToday();
  applyExecution(session, target);
  if (session.nomination?.id === pending.nominationId) {
    // Both flags: a stale `pendingExecution` re-arms the Execute button on an execution
    // that has already happened, which is the same class of stale-UI bug as a live
    // control the server would refuse.
    session.nomination.pendingExecution = false;
    session.nomination.executed = true;
  }
  return {
    targetPlayerId: target.playerId,
    wasDemon: target.characterType === 'demon',
    wasSaint: checkSaintExecution(session, target.playerId) !== null,
  };
}

/**
 * Kills a player by execution and records every day-scoped fact that follows from it.
 *
 * Shared by the vote (`confirmExecution`) and by the Virgin, because the Virgin's text is
 * "they are EXECUTED immediately" — a real execution, so it spends the day's one
 * execution and is what the Undertaker is told about. Keeping one function is the point:
 * two copies of this bookkeeping is how the Undertaker and the Mayor end up disagreeing
 * with each other about the same day.
 */
function applyExecution(session: GameSession, target: PlayerRecord): void {
  target.alive = false;
  // The execution is spent. A stale `pendingExecution` would re-arm the Execute button
  // on an execution that has already happened.
  session.pendingExecution = null;
  /*
   * The day's fact is recorded HERE, and deliberately NOT by removing the entry from
   * `resolvedNominationsToday`. The old code deleted the record at this point, which
   * meant the Mayor's "no execution occurred" clause could never be false and the
   * Undertaker — who reads that same list — was always told nobody died.
   */
  session.executionHappenedToday = true;
  // The Undertaker's record. The character is the REGISTERED one, not the true one:
  // the almanac is explicit that an executed Spy is shown the Butler they were
  // registering as, and an executed Recluse is shown the Imp.
  session.executedToday = {
    playerId: target.playerId,
    registeredCharacterName: registeredCharacterNameFor(target),
  };
}

/**
 * The character the table knew a player to be — what the Undertaker, the Spy, and any
 * "registers as" question should be answered with.
 */
function registeredCharacterNameFor(player: PlayerRecord): string {
  if (player.registration.characterType) {
    // Registered as a different TYPE, so a specific Townsfolk is on the token. The
    // app does not model a per-character lie, so the type is the honest ceiling here.
    return player.registration.characterType;
  }
  return player.character ?? 'someone';
}

/** The Saint: "The 1st time you are nominated, if the nominator is a Townsfolk, they are executed immediately." */
export function virginTrigger(session: GameSession, nomination: ActiveNomination): string | null {
  return virginTriggersExecution(session, nomination.targetId, nomination.nominatorId);
}

/** The Slayer: "if they are the Demon, they die." */
export function slayerTarget(session: GameSession, slayerId: string, targetId: string): boolean {
  return slayerWouldKill(session, slayerId, targetId);
}

/**
 * Clears the day-scoped state at the day transition.
 *
 * The Mayor's win is checked at DUSK — the end of the day that just finished — which is
 * before this runs, so `executionHappenedToday` is still true for the day being judged
 * at the moment the Mayor's clause needs it. Clearing it here is what starts the next
 * day's count.
 */
export function resetForNewDay(session: GameSession): void {
  for (const player of session.players.values()) {
    player.hasNominatedToday = false;
    player.hasBeenNominatedToday = false;
  }
  session.nomination = null;
  session.resolvedNominationsToday = [];
  session.executionHappenedToday = false;
  session.executedToday = null;
  session.pendingExecution = null;
  session.immediateExecution = null;
}

export function toNominationView(nomination: ActiveNomination, session: GameSession): ActiveNominationView {
  return {
    nominationId: nomination.id,
    nominatorId: nomination.nominatorId,
    targetId: nomination.targetId,
    votes: [...nomination.votes.entries()].map(([playerId, voting]) => ({ playerId, voting })),
    closed: nomination.closed,
    pendingExecution: nomination.pendingExecution,
    executed: nomination.executed,
    executionThreshold: executionThreshold(session),
    highestTallyToday: highestQualifyingTallyToday(session),
  };
}
