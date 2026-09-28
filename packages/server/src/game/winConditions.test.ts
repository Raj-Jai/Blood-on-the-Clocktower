import { describe, expect, it } from 'vitest';
import { SessionStore, type GameSession, type PlayerRecord } from '../session/store.js';
import { checkMayorWin, checkWinCondition, endGame, tryScarletWomanTakeover } from './winConditions.js';

function makeSession(count: number): { session: GameSession; players: PlayerRecord[] } {
  const store = new SessionStore();
  const session = store.createSession('tok');
  const players: PlayerRecord[] = [];
  for (let i = 0; i < count; i++) {
    players.push(store.addPlayer(session, `p${i}`, `Player${i}`));
  }
  return { session, players };
}

function setCharacter(player: PlayerRecord, characterType: PlayerRecord['characterType'], character = 'imp') {
  player.characterType = characterType;
  player.character = characterType ? character : null;
  player.alignment = characterType === 'demon' || characterType === 'minion' ? 'evil' : 'good';
}

describe('checkWinCondition', () => {
  it('returns null while the Demon lives and more than 2 players remain', () => {
    const { session, players } = makeSession(5);
    setCharacter(players[0]!, 'demon');
    setCharacter(players[1]!, 'minion');
    setCharacter(players[2]!, 'townsfolk', 'chef');
    setCharacter(players[3]!, 'townsfolk', 'chef');
    setCharacter(players[4]!, 'outsider', 'recluse');

    expect(checkWinCondition(session, 'executed')).toBeNull();
  });

  it('declares Good the winner when the Demon has been executed and no one inherited', () => {
    const { session, players } = makeSession(5);
    setCharacter(players[0]!, 'demon');
    setCharacter(players[1]!, 'minion');
    setCharacter(players[2]!, 'townsfolk', 'chef');
    setCharacter(players[3]!, 'townsfolk', 'chef');
    setCharacter(players[4]!, 'outsider', 'recluse');
    players[0]!.alive = false; // Demon executed

    const result = checkWinCondition(session, 'executed');
    expect(result).toEqual({ winner: 'good', reason: 'demon-executed' });
  });

  it('declares Good the winner with reason demon-self-killed when the Demon self-killed with no heir', () => {
    const { session, players } = makeSession(4);
    setCharacter(players[0]!, 'demon');
    setCharacter(players[1]!, 'townsfolk', 'chef');
    setCharacter(players[2]!, 'townsfolk', 'chef');
    setCharacter(players[3]!, 'outsider', 'recluse');
    players[0]!.alive = false;

    const result = checkWinCondition(session, 'self-killed');
    expect(result).toEqual({ winner: 'good', reason: 'demon-self-killed' });
  });

  it('declares Evil the winner once only 2 players remain, even if the Demon is alive', () => {
    const { session, players } = makeSession(5);
    setCharacter(players[0]!, 'demon');
    setCharacter(players[1]!, 'minion');
    setCharacter(players[2]!, 'townsfolk', 'chef');
    setCharacter(players[3]!, 'townsfolk', 'chef');
    setCharacter(players[4]!, 'outsider', 'recluse');
    players[2]!.alive = false;
    players[3]!.alive = false;
    players[4]!.alive = false;

    const result = checkWinCondition(session, 'executed');
    expect(result).toEqual({ winner: 'evil', reason: 'two-players-left' });
  });

  it('awards GOOD the tie when the Demon dies and only 2 players are left', () => {
    /*
     * "If both teams would win at the same time, good wins. For example, if the Demon
     * dies but that leaves only two players left, the good team wins." — rulebook.
     *
     * This test was named "prioritizes the two-players-left Evil win over a simultaneous
     * no-Demon Good win" and asserted Evil. A test whose NAME asserts the opposite of the
     * rulebook is how the bug survived: it read as a deliberate decision, and the comment
     * above it called it an "edge case" rather than a wrong answer. Found by playing a
     * 6-player game down to three alive and executing the Imp.
     */
    const { session, players } = makeSession(3);
    setCharacter(players[0]!, 'demon');
    setCharacter(players[1]!, 'townsfolk', 'chef');
    setCharacter(players[2]!, 'townsfolk', 'chef');
    players[0]!.alive = false;

    const result = checkWinCondition(session, 'executed');
    expect(result).toEqual({ winner: 'good', reason: 'demon-executed' });
  });

  it('still awards Evil when 2 remain AND a Demon has inherited the role', () => {
    // The 2-alive test is not dead code: this is the ordinary Evil win. A Scarlet
    // Woman who has become the Imp is a living Demon, so Good does not win the tie.
    const { session, players } = makeSession(5);
    setCharacter(players[0]!, 'demon', 'imp');
    setCharacter(players[1]!, 'minion', 'scarlet-woman');
    setCharacter(players[2]!, 'townsfolk', 'chef');
    setCharacter(players[3]!, 'townsfolk', 'chef');
    setCharacter(players[4]!, 'townsfolk', 'chef');
    // The Scarlet Woman has inherited: she is now the Demon.
    players[1]!.character = 'imp';
    players[1]!.characterType = 'demon';
    players[0]!.alive = false; // the old Demon is gone, 4 left

    expect(checkWinCondition(session, 'executed')).toBeNull();
    // Two alive, still a Demon: Evil genuinely wins. Good does NOT get the tie here,
    // because Good has not won anything — the Demon is still out there.
    players[3]!.alive = false;
    players[4]!.alive = false;
    expect(checkWinCondition(session, 'executed')).toEqual({ winner: 'evil', reason: 'two-players-left' });
  });
});

describe('tryScarletWomanTakeover', () => {
  it('hands the Demon role over when exactly 5 were alive before the Demon died', () => {
    /*
     * THE BOUNDARY, and the case the card is actually written around.
     *
     * 5 players alive, the Demon is executed, 4 are left alive afterwards. The
     * almanac: "five or more players alive just before the Demon dies — that is,
     * four or more players left alive after". So this MUST trigger.
     *
     * It did not. The guard was `livingPlayerCount(session) < 5`, evaluated with the
     * Demon already dead, so it demanded FIVE survivors — six alive before the death —
     * and skipped the trigger here. The fall-through then found no living Demon and
     * announced "Good wins! The Demon was executed." at a table with a Scarlet Woman
     * still sitting in it.
     *
     * Reproduced by playing: 5-player table, host marks the Imp dead, game ends
     * "Good wins" with the Scarlet Woman untouched.
     */
    const { session, players } = makeSession(5);
    const demon = players[0]!;
    const scarletWoman = players[1]!;
    setCharacter(demon, 'demon', 'imp');
    setCharacter(scarletWoman, 'minion', 'scarlet-woman');
    setCharacter(players[2]!, 'townsfolk', 'chef');
    setCharacter(players[3]!, 'townsfolk', 'chef');
    setCharacter(players[4]!, 'outsider', 'recluse');
    demon.alive = false; // 4 left alive

    const result = tryScarletWomanTakeover(session, demon.playerId);

    expect(result).not.toBeNull();
    expect(result!.newDemonPlayerId).toBe(scarletWoman.playerId);
    expect(scarletWoman.character).toBe('imp');
    expect(scarletWoman.characterType).toBe('demon');
    // And therefore the game continues rather than being a Good win.
    expect(checkWinCondition(session, 'executed')).toBeNull();
  });

  it('hands the Demon role to a living Scarlet Woman when 5+ players remain', () => {
    // 6 total so that AFTER the Demon's death, 5 players are still alive
    // (tryScarletWomanTakeover checks the living count post-death, per its docs).
    const { session, players } = makeSession(6);
    const demon = players[0]!;
    const scarletWoman = players[1]!;
    setCharacter(demon, 'demon', 'imp');
    setCharacter(scarletWoman, 'minion', 'scarlet-woman');
    setCharacter(players[2]!, 'townsfolk', 'chef');
    setCharacter(players[3]!, 'townsfolk', 'chef');
    setCharacter(players[4]!, 'outsider', 'recluse');
    setCharacter(players[5]!, 'townsfolk', 'chef');
    demon.alive = false;

    const result = tryScarletWomanTakeover(session, demon.playerId);

    expect(result).toEqual({
      previousDemonPlayerId: demon.playerId,
      newDemonPlayerId: scarletWoman.playerId,
      newDemonCharacterId: 'imp',
    });
    expect(scarletWoman.characterType).toBe('demon');
    expect(scarletWoman.character).toBe('imp');
    // Her alignment was already evil as a Minion, so it must stay evil.
    expect(scarletWoman.alignment).toBe('evil');
  });

  it('does nothing when fewer than 4 players are left alive after the Demon dies', () => {
    // 4 total, Demon dead, 3 left. The card needs four or more AFTER the death, so
    // this must not trigger — and the game is over, with Good the winners.
    //
    // The name used to say "fewer than 5 players remain alive" while the test actually
    // set up 3, which is the boundary this function had wrong. The name is now what
    // the test does.
    const { session, players } = makeSession(4);
    const demon = players[0]!;
    const scarletWoman = players[1]!;
    setCharacter(demon, 'demon', 'imp');
    setCharacter(scarletWoman, 'minion', 'scarlet-woman');
    setCharacter(players[2]!, 'townsfolk', 'chef');
    setCharacter(players[3]!, 'outsider', 'recluse');
    demon.alive = false;

    const result = tryScarletWomanTakeover(session, demon.playerId);

    expect(result).toBeNull();
    expect(scarletWoman.characterType).toBe('minion');
    // With no takeover and no Demon, Good has genuinely won.
    expect(checkWinCondition(session, 'executed')).toEqual({ winner: 'good', reason: 'demon-executed' });
  });

  it('does nothing when there is no living Scarlet Woman', () => {
    const { session, players } = makeSession(5);
    const demon = players[0]!;
    setCharacter(demon, 'demon', 'imp');
    setCharacter(players[1]!, 'minion', 'poisoner');
    setCharacter(players[2]!, 'townsfolk', 'chef');
    setCharacter(players[3]!, 'townsfolk', 'chef');
    setCharacter(players[4]!, 'outsider', 'recluse');
    demon.alive = false;

    expect(tryScarletWomanTakeover(session, demon.playerId)).toBeNull();
  });

  it('ignores a dead Scarlet Woman', () => {
    const { session, players } = makeSession(5);
    const demon = players[0]!;
    const scarletWoman = players[1]!;
    setCharacter(demon, 'demon', 'imp');
    setCharacter(scarletWoman, 'minion', 'scarlet-woman');
    setCharacter(players[2]!, 'townsfolk', 'chef');
    setCharacter(players[3]!, 'townsfolk', 'chef');
    setCharacter(players[4]!, 'outsider', 'recluse');
    demon.alive = false;
    scarletWoman.alive = false;

    expect(tryScarletWomanTakeover(session, demon.playerId)).toBeNull();
  });
});

describe('checkMayorWin', () => {
  /**
   * 6 players, thinned to exactly 3 alive, with a living Mayor — the shape the clause is
   * written for: "At dusk, if exactly three players are alive and no player was executed
   * today, declare that the game ends and good wins."
   */
  function threeLeftWithMayor() {
    const { session, players } = makeSession(6);
    setCharacter(players[0]!, 'townsfolk', 'mayor');
    setCharacter(players[1]!, 'townsfolk', 'chef');
    setCharacter(players[2]!, 'demon', 'imp');
    setCharacter(players[3]!, 'townsfolk', 'chef');
    setCharacter(players[4]!, 'minion', 'poisoner');
    setCharacter(players[5]!, 'townsfolk', 'chef');
    players[3]!.alive = false;
    players[4]!.alive = false;
    players[5]!.alive = false;
    return { session, players };
  }

  it('wins for good when 3 are left and nobody was executed', () => {
    const { session } = threeLeftWithMayor();
    expect(checkMayorWin(session)).toEqual({ winner: 'good', reason: 'mayor-three-left' });
  });

  it('does NOT win after an execution has happened today', () => {
    /*
     * The clause the function exists for, and the one the old implementation could
     * never enforce. It guarded on `resolvedNominationsToday.length > 0`, but
     * `confirmExecution` DELETED the record at the moment it executed — so by the time
     * anything checked, the evidence was always gone and the Mayor won anyway. Found
     * by a runtime harness: 4 alive, one executed on day 1, then at the transition the
     * Mayor check returned a win on a day that had an execution in it.
     */
    const { session } = threeLeftWithMayor();
    session.executionHappenedToday = true;
    expect(checkMayorWin(session)).toBeNull();
  });

  it('does not win while a nomination is still in play', () => {
    const { session } = threeLeftWithMayor();
    session.nomination = {
      id: 'n1',
      nominatorId: 'p1',
      targetId: 'p0',
      votes: new Map(),
      openedAt: 0,
      closed: false,
      pendingExecution: false,
      executed: false,
      resolvedTally: null,
    };
    expect(checkMayorWin(session)).toBeNull();
  });

  it('does not win with a drunk or poisoned Mayor', () => {
    const { session, players } = threeLeftWithMayor();
    players[0]!.statusEffects.poisoned = true;
    expect(checkMayorWin(session)).toBeNull();
  });

  it('does not win with no living Mayor, or at any other player count', () => {
    const { session, players } = threeLeftWithMayor();
    players[0]!.alive = false; // 2 left, and no Mayor
    expect(checkMayorWin(session)).toBeNull();
  });
});

describe('endGame', () => {
  it('sets phase to ended and stores the game result', () => {
    const { session } = makeSession(3);
    endGame(session, 'good', 'demon-executed');

    expect(session.phase).toBe('ended');
    expect(session.gameResult).toEqual({ winner: 'good', reason: 'demon-executed' });
  });
});
