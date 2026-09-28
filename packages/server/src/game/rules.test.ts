import { describe, expect, it } from 'vitest';
import { SessionStore } from '../session/store.js';
import { castVote, closeVote, confirmExecution, executionThreshold, nominate, resetForNewDay } from './rules.js';

function makeSession(n: number) {
  const store = new SessionStore();
  const session = store.createSession('tok');
  for (let i = 0; i < n; i++) {
    store.addPlayer(session, `p${i}`, `Player${i}`);
  }
  return session;
}

describe('nominate', () => {
  it('opens a nomination for a living target by a living nominator', () => {
    const session = makeSession(5);
    const nomination = nominate(session, 'p0', 'p1')!;
    expect(nomination.nominatorId).toBe('p0');
    expect(nomination.targetId).toBe('p1');
    expect(session.players.get('p0')!.hasNominatedToday).toBe(true);
  });

  it('rejects a second nomination by the same player on the same day', () => {
    const session = makeSession(5);
    nominate(session, 'p0', 'p1');
    closeVote(session, session.nomination!.id);
    expect(() => nominate(session, 'p0', 'p2')).toThrow();
  });

  it('rejects nomination by a dead player', () => {
    const session = makeSession(5);
    session.players.get('p0')!.alive = false;
    expect(() => nominate(session, 'p0', 'p1')).toThrow();
  });

  it('rejects nomination of a dead target', () => {
    const session = makeSession(5);
    session.players.get('p1')!.alive = false;
    expect(() => nominate(session, 'p0', 'p1')).toThrow();
  });

  it('rejects a second concurrent open nomination', () => {
    const session = makeSession(5);
    nominate(session, 'p0', 'p1');
    expect(() => nominate(session, 'p2', 'p3')).toThrow();
  });

  it('rejects nominating the SAME player a second time in one day', () => {
    // "Each player may nominate only once per day, and each player may be nominated
    // only once per day." Only the first half was ever checked, so a failed vote could
    // be re-run on one person for the rest of the day. Confirmed by playing: the same
    // player was nominated three times in succession and the app allowed all three.
    const session = makeSession(6);
    nominate(session, 'p0', 'p1');
    closeVote(session, session.nomination!.id);
    expect(() => nominate(session, 'p2', 'p1')).toThrow();
    expect(session.players.get('p1')!.hasBeenNominatedToday).toBe(true);
  });

  it('allows a different player to be nominated in the same day', () => {
    const session = makeSession(6);
    nominate(session, 'p0', 'p1');
    closeVote(session, session.nomination!.id);
    expect(() => nominate(session, 'p2', 'p3')).not.toThrow();
  });

  it('clears both nomination limits at the day transition', () => {
    const session = makeSession(6);
    nominate(session, 'p0', 'p1');
    closeVote(session, session.nomination!.id);
    resetForNewDay(session);
    expect(session.players.get('p0')!.hasNominatedToday).toBe(false);
    expect(session.players.get('p1')!.hasBeenNominatedToday).toBe(false);
  });
});

describe('the execution threshold and the day best', () => {
  it('needs strictly more votes than the best tally earlier in the day', () => {
    /*
     * "The vote succeeds if the nominated player got MORE VOTES THAN ANY OTHER NOMINATED
     * PLAYER TODAY, and the number of votes equals or exceeds half the number of alive
     * players."
     *
     * A real day is a descending ladder: the first nomination takes five hands, the
     * second takes the bare minimum. This only ever tested for an exact TIE, so both
     * were flagged as qualifying and the player with FEWER votes was the one the app
     * offered to execute.
     */
    const session = makeSession(7); // threshold ceil(7/2) = 4
    nominate(session, 'p5', 'p6');
    for (const p of ['p0', 'p1', 'p2', 'p3', 'p4']) castVote(session, session.nomination!.id, p, true);
    const first = closeVote(session, session.nomination!.id);
    expect(first.pendingExecution).toBe(true);
    expect(first.resolvedTally).toBe(5);

    // A second nomination that clears the threshold but beats nothing.
    nominate(session, 'p1', 'p2');
    for (const p of ['p0', 'p1', 'p3', 'p4']) castVote(session, session.nomination!.id, p, true);
    const second = closeVote(session, session.nomination!.id);
    expect(second.resolvedTally).toBe(4);
    expect(second.resolvedTally! >= executionThreshold(session)).toBe(true);
    // It met the threshold, and it still does not qualify.
    expect(second.pendingExecution).toBe(false);
  });

  it('keeps a tied number as the floor for the rest of the day', () => {
    /*
     * "If the vote ties with a player nominated earlier today, then neither nominated
     * player will be executed… A nominated player must EXCEED THIS TIED NUMBER of votes
     * to become 'about to die' by execution."
     *
     * The old code DELETED the earlier record on a tie, throwing away the floor. Two
     * players tied at four and both walked — and then a third nomination with the same
     * four executed, which is the most natural thing a table could possibly do next.
     */
    const session = makeSession(7); // threshold 4
    nominate(session, 'p0', 'p1');
    for (const p of ['p0', 'p1', 'p2', 'p3']) castVote(session, session.nomination!.id, p, true);
    const a = closeVote(session, session.nomination!.id);
    expect(a.pendingExecution).toBe(true);

    nominate(session, 'p1', 'p2');
    for (const p of ['p0', 'p1', 'p2', 'p3']) castVote(session, session.nomination!.id, p, true);
    const b = closeVote(session, session.nomination!.id);
    expect(b.resolvedTally).toBe(4);
    expect(b.pendingExecution).toBe(false); // a tie: neither is executed

    // The floor survives, so the same tally again still does not carry.
    nominate(session, 'p2', 'p3');
    for (const p of ['p0', 'p1', 'p2', 'p3']) castVote(session, session.nomination!.id, p, true);
    const c = closeVote(session, session.nomination!.id);
    expect(c.resolvedTally).toBe(4);
    expect(c.pendingExecution).toBe(false);

    // And beating the tied number does carry.
    nominate(session, 'p3', 'p4');
    for (const p of ['p0', 'p1', 'p2', 'p3', 'p4']) castVote(session, session.nomination!.id, p, true);
    const d = closeVote(session, session.nomination!.id);
    expect(d.resolvedTally).toBe(5);
    expect(d.pendingExecution).toBe(true);
  });
});

describe('one execution per day', () => {
  it('records the execution so the Mayor clause can see it', () => {
    const session = makeSession(6); // threshold 3
    nominate(session, 'p0', 'p1');
    for (const p of ['p0', 'p2', 'p3']) castVote(session, session.nomination!.id, p, true);
    closeVote(session, session.nomination!.id);
    expect(session.executionHappenedToday).toBe(false);
    confirmExecution(session, session.nomination!.id);
    expect(session.executionHappenedToday).toBe(true);
  });

  it('refuses a new nomination once somebody has been executed', () => {
    // "There is a maximum of one execution per day. After an execution, the day phase
    // is effectively over." Unreachable while the Execute button did not exist, and
    // live the moment it is restored — so it is enforced in the engine, not the UI.
    const session = makeSession(7); // threshold 4
    nominate(session, 'p0', 'p1');
    for (const p of ['p0', 'p2', 'p3', 'p4']) castVote(session, session.nomination!.id, p, true);
    expect(closeVote(session, session.nomination!.id).pendingExecution).toBe(true);
    confirmExecution(session, session.nomination!.id);
    expect(() => nominate(session, 'p2', 'p3')).toThrow();
  });

  it('refuses a second execution even if a nomination somehow qualifies', () => {
    // Defence in depth for the same rule. The nomination guard above stops the
    // realistic path — a day with an execution in it accepts no more nominations — and
    // this stops the direct one, so a future refactor that loosens the first does not
    // silently re-open a second execution in a day. The flag is set directly because
    // the honest path to this state is deliberately blocked.
    const session = makeSession(7); // threshold 4
    nominate(session, 'p0', 'p1');
    for (const p of ['p0', 'p2', 'p3', 'p4']) castVote(session, session.nomination!.id, p, true);
    closeVote(session, session.nomination!.id);
    confirmExecution(session, session.nomination!.id);

    // Pretend the day guard did not fire and a second nomination qualifies anyway.
    session.executionHappenedToday = false;
    const second = nominate(session, 'p2', 'p3')!;
    for (const p of ['p0', 'p2', 'p4', 'p5']) castVote(session, second.id, p, true);
    closeVote(session, second.id);
    session.executionHappenedToday = true;
    expect(() => confirmExecution(session, second.id)).toThrow();
  });

  it('records the executed player for the Undertaker, as the registered character', () => {
    // The Undertaker used to read `resolvedNominationsToday[0]`, which `confirmExecution`
    // deleted at the moment it executed — so they were told "nobody died by execution
    // today" after every single execution.
    const session = makeSession(6);
    const target = session.players.get('p1')!;
    target.registration = { alignment: 'good', characterType: 'outsider' };
    nominate(session, 'p0', 'p1');
    for (const p of ['p0', 'p2', 'p3']) castVote(session, session.nomination!.id, p, true);
    closeVote(session, session.nomination!.id);
    confirmExecution(session, session.nomination!.id);
    expect(session.executedToday?.playerId).toBe('p1');
    // The registered type, not the true character.
    expect(session.executedToday?.registeredCharacterName).toBe('outsider');
  });

  it('clears the day fact at the day transition', () => {
    const session = makeSession(6);
    session.executionHappenedToday = true;
    session.executedToday = { playerId: 'p1', registeredCharacterName: 'mayor' };
    resetForNewDay(session);
    expect(session.executionHappenedToday).toBe(false);
    expect(session.executedToday).toBeNull();
  });
});

describe('castVote and dead-vote consumption', () => {
  it('allows a living player to vote freely', () => {
    const session = makeSession(5);
    const nomination = nominate(session, 'p0', 'p1')!;
    castVote(session, nomination.id, 'p2', true);
    expect(nomination.votes.get('p2')).toBe(true);
  });

  it('consumes a dead players single vote on first yes-vote and blocks a second use', () => {
    const session = makeSession(5);
    session.players.get('p2')!.alive = false;
    const nomination = nominate(session, 'p0', 'p1')!;
    castVote(session, nomination.id, 'p2', true);
    expect(session.players.get('p2')!.usedDeadVote).toBe(true);
    closeVote(session, nomination.id);
    resetForNewDay(session);
    const nomination2 = nominate(session, 'p3', 'p4')!;
    expect(() => castVote(session, nomination2.id, 'p2', true)).toThrow();
  });

  it('rejects voting on a closed nomination', () => {
    const session = makeSession(5);
    const nomination = nominate(session, 'p0', 'p1')!;
    closeVote(session, nomination.id);
    expect(() => castVote(session, nomination.id, 'p2', true)).toThrow();
  });
});

describe('executionThreshold and closeVote', () => {
  it('computes ceil(living/2) as the threshold', () => {
    const session = makeSession(5);
    expect(executionThreshold(session)).toBe(3);
    const session6 = makeSession(6);
    expect(executionThreshold(session6)).toBe(3);
    const session7 = makeSession(7);
    expect(executionThreshold(session7)).toBe(4);
  });

  it('flags pendingExecution when votes meet the threshold', () => {
    const session = makeSession(5);
    const nomination = nominate(session, 'p0', 'p1')!;
    castVote(session, nomination.id, 'p0', true);
    castVote(session, nomination.id, 'p2', true);
    castVote(session, nomination.id, 'p3', true);
    const closed = closeVote(session, nomination.id);
    expect(closed.pendingExecution).toBe(true);
  });

  it('does not flag pendingExecution when votes are below the threshold', () => {
    const session = makeSession(5);
    const nomination = nominate(session, 'p0', 'p1')!;
    castVote(session, nomination.id, 'p0', true);
    const closed = closeVote(session, nomination.id);
    expect(closed.pendingExecution).toBe(false);
  });

  it('does not execute either nominee on a tie, and keeps the tied number as the floor', () => {
    /*
     * "If the vote ties with a player nominated earlier today, then neither nominated
     * player will be executed… A nominated player must EXCEED THIS TIED NUMBER of votes
     * to become 'about to die' by execution."
     *
     * This test asserted `resolvedNominationsToday` was EMPTIED on a tie, which is how
     * the floor was destroyed: two players tied at four, both walked, and then a third
     * nomination with the same four executed. The record now stays.
     */
    const session = makeSession(7); // threshold = 4
    const nom1 = nominate(session, 'p0', 'p1')!;
    castVote(session, nom1.id, 'p0', true);
    castVote(session, nom1.id, 'p2', true);
    castVote(session, nom1.id, 'p3', true);
    castVote(session, nom1.id, 'p4', true);
    const closed1 = closeVote(session, nom1.id);
    expect(closed1.pendingExecution).toBe(true);

    const nom2 = nominate(session, 'p5', 'p6')!;
    castVote(session, nom2.id, 'p0', true);
    castVote(session, nom2.id, 'p2', true);
    castVote(session, nom2.id, 'p3', true);
    castVote(session, nom2.id, 'p4', true);
    const closed2 = closeVote(session, nom2.id);

    // Neither is executed.
    expect(closed2.pendingExecution).toBe(false);
    // The tied number SURVIVES as the floor, rather than being deleted.
    expect(session.resolvedNominationsToday.map((r) => r.tally)).toEqual([4]);
  });
});

describe('confirmExecution', () => {
  it('marks the target dead when pendingExecution is true', () => {
    const session = makeSession(5);
    const nomination = nominate(session, 'p0', 'p1')!;
    castVote(session, nomination.id, 'p0', true);
    castVote(session, nomination.id, 'p2', true);
    castVote(session, nomination.id, 'p3', true);
    closeVote(session, nomination.id);
    confirmExecution(session, nomination.id);
    expect(session.players.get('p1')!.alive).toBe(false);
  });

  it('executes once and only once', () => {
    // REGRESSION, found by a driver that kept clicking an "Execute" button which never
    // went away. `pendingExecution` used to stay true for the rest of the day — it was
    // only cleared when a LATER nomination tied that one out — so the existing guard
    // stayed satisfied and the same player could be executed repeatedly, each time
    // re-broadcasting the execution and re-running the post-death sweep.
    //
    // The fix is no longer an extra check bolted on: the pending execution is a
    // day-scoped session fact, and carrying it out CLEARS it, so the second attempt
    // finds nothing pending and is refused by the same code path as the first.
    const session = makeSession(5);
    const nomination = nominate(session, 'p0', 'p1')!;
    castVote(session, nomination.id, 'p0', true);
    castVote(session, nomination.id, 'p2', true);
    castVote(session, nomination.id, 'p3', true);
    closeVote(session, nomination.id);

    expect(nomination.pendingExecution).toBe(true);
    expect(session.pendingExecution).not.toBeNull();
    confirmExecution(session, nomination.id);
    expect(nomination.executed).toBe(true);
    expect(session.players.get('p1')!.alive).toBe(false);
    expect(session.executionHappenedToday).toBe(true);

    // Nothing is pending any more, so a second confirmation is refused.
    expect(session.pendingExecution).toBeNull();
    expect(nomination.pendingExecution).toBe(false);
    expect(() => confirmExecution(session, nomination.id)).toThrow();
  });

  it('a later nomination does not destroy a pending execution', () => {
    /*
     * The other half of the same story, and the reason the pending execution is a session
     * fact rather than a field on the current nomination. A second nomination is legal
     * the whole time — the rules compare the day's tallies, and the tie rule says to
     * "call again for nominations" — so `session.nomination` is replaced. Before, that
     * took the pending execution with it and the execution silently disappeared.
     */
    const session = makeSession(7); // threshold 4
    const first = nominate(session, 'p0', 'p1')!;
    for (const p of ['p0', 'p2', 'p3', 'p4']) castVote(session, first.id, p, true);
    closeVote(session, first.id);
    expect(session.pendingExecution?.nominationId).toBe(first.id);

    // A different player, a lower tally: the day's best stands and is still pending.
    const second = nominate(session, 'p2', 'p3')!;
    for (const p of ['p0', 'p2', 'p3']) castVote(session, second.id, p, true);
    expect(closeVote(session, second.id).pendingExecution).toBe(false);
    expect(session.pendingExecution?.nominationId).toBe(first.id);

    // And it can still be carried out, even though it is not the current nomination.
    confirmExecution(session, first.id);
    expect(session.players.get('p1')!.alive).toBe(false);
    expect(session.players.get('p3')!.alive).toBe(true);
  });

  it('a tie takes a pending execution off the block', () => {
    // "If the vote ties with a player nominated earlier today, then neither nominated
    // player will be executed."
    const session = makeSession(7); // threshold 4
    const first = nominate(session, 'p0', 'p1')!;
    for (const p of ['p0', 'p2', 'p3', 'p4']) castVote(session, first.id, p, true);
    closeVote(session, first.id);
    expect(session.pendingExecution).not.toBeNull();

    const second = nominate(session, 'p2', 'p3')!;
    for (const p of ['p0', 'p2', 'p3', 'p4']) castVote(session, second.id, p, true);
    closeVote(session, second.id);
    expect(session.pendingExecution).toBeNull();
  });

  it('refuses to execute a player who is already dead', () => {
    // Even with a fresh, qualifying nomination: you cannot execute a corpse.
    const session = makeSession(5);
    session.players.get('p1')!.alive = false;
    const nomination = nominate(session, 'p0', 'p2')!;
    castVote(session, nomination.id, 'p0', true);
    castVote(session, nomination.id, 'p1', true);
    castVote(session, nomination.id, 'p3', true);
    closeVote(session, nomination.id);
    session.players.get('p2')!.alive = false;
    expect(() => confirmExecution(session, nomination.id)).toThrow();
  });

  it('rejects execution when the nomination did not qualify', () => {
    const session = makeSession(5);
    const nomination = nominate(session, 'p0', 'p1')!;
    castVote(session, nomination.id, 'p0', true);
    closeVote(session, nomination.id);
    expect(() => confirmExecution(session, nomination.id)).toThrow();
  });
});

describe('resetForNewDay', () => {
  it('clears hasNominatedToday and the active nomination but preserves usedDeadVote', () => {
    const session = makeSession(5);
    session.players.get('p2')!.alive = false;
    const nomination = nominate(session, 'p0', 'p1')!;
    castVote(session, nomination.id, 'p2', true);
    closeVote(session, nomination.id);
    resetForNewDay(session);
    expect(session.players.get('p0')!.hasNominatedToday).toBe(false);
    expect(session.nomination).toBeNull();
    expect(session.players.get('p2')!.usedDeadVote).toBe(true);
  });
});

// ---------------------------------------------------------------------------

/**
 * The Virgin and the Slayer.
 *
 * Both predicates — `virginTriggersExecution` and `slayerWouldKill` — existed, were
 * exported from `abilities.ts`, and were called by NOTHING. `virginTrigger` and
 * `slayerTarget` were re-exported from `rules.ts` and also called by nothing. Two
 * Townsfolk, one of them in almost every Trouble Brewing script, had no behaviour at all:
 * nominating the Virgin did nothing, and Slaying the Demon did nothing.
 *
 * These tests go through `nominate` and `closeVote`, because that is where the abilities
 * now live. Calling the predicates directly would have passed before the fix, which is
 * exactly the mistake AGENTS.md warns about.
 */
describe('the Virgin', () => {
  function virginSession() {
    const session = makeSession(5);
    const virgin = session.players.get('p1')!;
    virgin.character = 'virgin';
    virgin.characterType = 'townsfolk';
    const nominator = session.players.get('p0')!;
    nominator.character = 'washerwoman';
    nominator.characterType = 'townsfolk';
    session.phase = 'day';
    session.dayNumber = 1;
    return { session, virgin, nominator };
  }

  it('executes a Townsfolk nominator the moment they nominate the Virgin', () => {
    const { session, virgin, nominator } = virginSession();
    // No nomination is created at all: the ability resolves before any vote.
    const nomination = nominate(session, nominator.playerId, virgin.playerId)!;
    expect(nomination).toBeNull();
    expect(nominator.alive).toBe(false);
    expect(virgin.alive).toBe(true);
    expect(session.immediateExecution).toMatchObject({
      playerId: nominator.playerId,
      cause: 'virgin',
    });
  });

  it('spends the day one execution, so the Undertaker and the Mayor both see it', () => {
    // "they are EXECUTED immediately" — a real execution, not just a death. If this were
    // not recorded, the Undertaker would be told nobody died and the Mayor would think the
    // day passed without an execution, which is the two-things-agree bug in `applyExecution`.
    const { session, virgin, nominator } = virginSession();
    nominate(session, nominator.playerId, virgin.playerId);
    expect(session.executionHappenedToday).toBe(true);
    expect(session.executedToday?.playerId).toBe(nominator.playerId);
  });

  it('only fires the first time the Virgin is nominated', () => {
    // "The 1st time you are nominated" is for the whole game, not the day. And a player
    // may only be nominated once per day, so proving the ability is spent has to happen
    // on a later day — otherwise this would pass for the wrong reason.
    const { session, virgin } = virginSession();
    const first = session.players.get('p0')!;
    nominate(session, first.playerId, virgin.playerId);
    expect(first.alive).toBe(false);
    expect(session.immediateExecution?.cause).toBe('virgin');

    session.dayNumber = 2;
    resetForNewDay(session);
    const second = session.players.get('p2')!;
    second.character = 'chef';
    second.characterType = 'townsfolk';
    const nomination = nominate(session, second.playerId, virgin.playerId)!;
    expect(nomination).not.toBeNull();
    expect(second.alive).toBe(true);
    expect(session.immediateExecution).toBeNull();
  });

  it('does not fire against a nominator who is not a Townsfolk', () => {
    // "if the nominator is a Townsfolk" — an Evil nominator is safe, which is the whole
    // reason a Demon walks the Virgin on day one.
    const { session, virgin } = virginSession();
    const demon = session.players.get('p0')!;
    demon.character = 'imp';
    demon.characterType = 'demon';
    const nomination = nominate(session, demon.playerId, virgin.playerId)!;
    expect(nomination).not.toBeNull();
    expect(demon.alive).toBe(true);
    expect(virgin.alive).toBe(true);
  });

  it('does not fire when the Virgin is already dead', () => {
    const { session, virgin, nominator } = virginSession();
    virgin.alive = false;
    expect(() => nominate(session, nominator.playerId, virgin.playerId)).toThrow();
  });
});

describe('the Slayer', () => {
  function slayerSession() {
    const session = makeSession(5);
    const slayer = session.players.get('p0')!;
    slayer.character = 'slayer';
    slayer.characterType = 'townsfolk';
    const demon = session.players.get('p1')!;
    demon.character = 'imp';
    demon.characterType = 'demon';
    session.phase = 'day';
    session.dayNumber = 1;
    return { session, slayer, demon };
  }

  it('kills a Demon the Slayer successfully nominates, with no vote to confirm', () => {
    const { session, slayer, demon } = slayerSession();
    const nomination = nominate(session, slayer.playerId, demon.playerId)!;
    // Threshold is ceil(5/2) = 3, so the Slayer's own vote is needed to make it qualify.
    for (const id of [slayer.playerId, 'p2', 'p3', 'p4']) castVote(session, nomination.id, id, true);
    closeVote(session, nomination.id);

    expect(demon.alive).toBe(false);
    expect(session.immediateExecution).toMatchObject({ playerId: demon.playerId, cause: 'slayer' });
    // "immediately" — so there is nothing for the Storyteller to confirm, and a
    // Stale Execute button here is the bug this whole tier exists to prevent.
    expect(session.pendingExecution).toBeNull();
  });

  it('does NOT spend the day execution, because a character ability is not an execution', () => {
    // The contrast with the Virgin, and it is not a detail: if the Slayer's kill were
    // recorded as an execution, the Undertaker would learn a character death, and a Saint
    // Slain by mistake would lose the game for Good.
    const { session, slayer, demon } = slayerSession();
    const nomination = nominate(session, slayer.playerId, demon.playerId)!;
    // Threshold is ceil(5/2) = 3, so the Slayer's own vote is needed to make it qualify.
    for (const id of [slayer.playerId, 'p2', 'p3', 'p4']) castVote(session, nomination.id, id, true);
    closeVote(session, nomination.id);
    expect(session.executionHappenedToday).toBe(false);
    expect(session.executedToday).toBeNull();
  });

  it('only fires once per game', () => {
    const { session, slayer } = slayerSession();
    const demon = session.players.get('p1')!;
    const nomination = nominate(session, slayer.playerId, demon.playerId)!;
    // Threshold is ceil(5/2) = 3, so the Slayer's own vote is needed to make it qualify.
    for (const id of [slayer.playerId, 'p2', 'p3', 'p4']) castVote(session, nomination.id, id, true);
    closeVote(session, nomination.id);
    expect(demon.alive).toBe(false);

    // A fresh Demon, and the Slayer's shot is gone.
    session.players.get('p3')!.character = 'imp';
    session.players.get('p3')!.characterType = 'demon';
    session.dayNumber = 2;
    slayer.hasNominatedToday = false;
    const second = nominate(session, slayer.playerId, 'p3')!;
    for (const id of ['p2', 'p4']) castVote(session, second.id, id, true);
    closeVote(session, second.id);
    expect(session.players.get('p3')!.alive).toBe(true);
    expect(session.pendingExecution).not.toBeNull();
  });

  it('can Slay a Recluse who registers as the Demon, and that is not a Demon death', () => {
    // Perception is honoured, so this is a legal play — and because the Recluse is truly
    // Good, the game must not treat it as killing the Demon.
    const { session, slayer } = slayerSession();
    const recluse = session.players.get('p2')!;
    recluse.character = 'recluse';
    recluse.characterType = 'townsfolk';
    recluse.registration = { alignment: 'evil', characterType: 'demon' };
    const nomination = nominate(session, slayer.playerId, recluse.playerId)!;
    for (const id of [slayer.playerId, 'p3', 'p4']) castVote(session, nomination.id, id, true);
    closeVote(session, nomination.id);
    expect(recluse.alive).toBe(false);
    expect(session.immediateExecution?.cause).toBe('slayer');
    expect(session.executionHappenedToday).toBe(false);
  });

  it('does NOT fire for anybody else who successfully nominates the Demon', () => {
    /*
     * The regression this whole tier nearly shipped.
     *
     * `slayerWouldKill` checked that the "Slayer" was alive, that the ability was
     * unused, and that the target registered as the Demon — and never that the player
     * doing the nominating WAS the Slayer. It was dead code, so nobody noticed. The
     * moment it was wired into `closeVote`, every player who successfully nominated the
     * Demon killed them instead of executing them: the game's central day mechanic
     * silently stopped working, and the existing `winFlow` tests caught it.
     *
     * A Minion nominating the Demon must get an ordinary execution.
     */
    const session = makeSession(5);
    const minion = session.players.get('p0')!;
    minion.character = 'poisoner';
    minion.characterType = 'minion';
    const demon = session.players.get('p1')!;
    demon.character = 'imp';
    demon.characterType = 'demon';
    session.phase = 'day';
    session.dayNumber = 1;

    const nomination = nominate(session, minion.playerId, demon.playerId)!;
    for (const id of [minion.playerId, 'p2', 'p3', 'p4']) castVote(session, nomination.id, id, true);
    closeVote(session, nomination.id);

    // A normal execution is pending, and the Slayer's shot is untouched.
    expect(session.immediateExecution).toBeNull();
    expect(session.slayerHasUsed).toBe(false);
    expect(session.pendingExecution).not.toBeNull();

    confirmExecution(session, nomination.id);
    expect(demon.alive).toBe(false);
  });

  it('does nothing when the Slayer nominates someone who is not the Demon', () => {
    const { session, slayer } = slayerSession();
    const chef = session.players.get('p2')!;
    chef.character = 'chef';
    chef.characterType = 'townsfolk';
    const nomination = nominate(session, slayer.playerId, chef.playerId)!;
    for (const id of [slayer.playerId, 'p3', 'p4']) castVote(session, nomination.id, id, true);
    closeVote(session, nomination.id);
    expect(chef.alive).toBe(true);
    expect(session.immediateExecution).toBeNull();
    expect(session.pendingExecution).not.toBeNull();
  });
});
