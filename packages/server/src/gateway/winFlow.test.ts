import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Server as SocketIOServer } from 'socket.io';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { ClientEvents, ServerEvents } from '@clocktower/shared';
import { SessionStore, type GameSession, type PlayerRecord } from '../session/store.js';
import { registerGatewayHandlers } from './index.js';
import { createApp } from '../http/app.js';

async function waitFor<T = unknown>(socket: ClientSocket, event: string): Promise<T> {
  return new Promise((resolve) => {
    socket.once(event, (payload: T) => resolve(payload));
  });
}

function setCharacter(player: PlayerRecord, characterType: PlayerRecord['characterType'], character: string) {
  player.characterType = characterType;
  player.character = character;
  player.alignment = characterType === 'demon' || characterType === 'minion' ? 'evil' : 'good';
}

describe('win/end-game gateway flow', () => {
  let httpServer: ReturnType<typeof createServer>;
  let io: SocketIOServer;
  let baseUrl: string;
  let store: SessionStore;

  beforeAll(async () => {
    store = new SessionStore();
    const app = createApp(store);
    httpServer = createServer(app);
    io = new SocketIOServer(httpServer, { cors: { origin: '*' } });
    registerGatewayHandlers(io, store);
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const address = httpServer.address() as AddressInfo;
    baseUrl = `http://localhost:${address.port}`;
  });

  afterAll(async () => {
    io.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  /** Creates a session with `count` players, connects/authenticates the Storyteller + all player sockets. */
  async function setUpGame(count: number): Promise<{
    session: GameSession;
    stSocket: ClientSocket;
    playerSockets: ClientSocket[];
    players: PlayerRecord[];
  }> {
    const createRes = await fetch(`${baseUrl}/api/sessions`, { method: 'POST' });
    const { code, storytellerToken } = (await createRes.json()) as { code: string; storytellerToken: string };

    const playerTokens: { playerId: string; playerToken: string }[] = [];
    for (let i = 0; i < count; i++) {
      const joinRes = await fetch(`${baseUrl}/api/sessions/${code}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: `Player${i}` }),
      });
      const body = (await joinRes.json()) as { playerId: string; playerToken: string };
      playerTokens.push(body);
    }

    const stSocket = ioClient(baseUrl, { transports: ['websocket'] });
    await waitFor(stSocket, 'connect');
    stSocket.emit(ClientEvents.Auth, { token: storytellerToken });
    await waitFor(stSocket, ServerEvents.AuthOk);

    const playerSockets: ClientSocket[] = [];
    for (const { playerToken } of playerTokens) {
      const s = ioClient(baseUrl, { transports: ['websocket'] });
      await waitFor(s, 'connect');
      s.emit(ClientEvents.Auth, { token: playerToken });
      await waitFor(s, ServerEvents.AuthOk);
      playerSockets.push(s);
    }

    const session = store.getSession(code)!;
    // Bypass random distribution: give the session a deterministic, day-phase
    // roster so tests can control exactly who the Demon/Minions are.
    session.phase = 'day';
    session.dayNumber = 1;
    const players = [...session.players.values()];

    return { session, stSocket, playerSockets, players };
  }

  function teardown(stSocket: ClientSocket, playerSockets: ClientSocket[]) {
    stSocket.disconnect();
    for (const s of playerSockets) s.disconnect();
  }

  it('StorytellerConfirmExecution of the Demon (5 players, no Scarlet Woman) ends the game with Good winning', async () => {
    const { stSocket, playerSockets, players } = await setUpGame(5);
    const [demon, minion, t1, t2, outsider] = players;
    setCharacter(demon!, 'demon', 'imp');
    setCharacter(minion!, 'minion', 'poisoner');
    setCharacter(t1!, 'townsfolk', 'chef');
    setCharacter(t2!, 'townsfolk', 'chef');
    setCharacter(outsider!, 'outsider', 'recluse');

    const nomination = await (async () => {
      const openedPromise = waitFor<any>(stSocket, ServerEvents.NominationOpened);
      playerSockets[1]!.emit(ClientEvents.PlayerNominate, { targetPlayerId: demon!.playerId });
      return openedPromise;
    })();

    for (let i = 0; i < 3; i++) {
      const voteUpdatePromise = waitFor<any>(stSocket, ServerEvents.NominationVoteUpdate);
      playerSockets[i]!.emit(ClientEvents.PlayerVote, { nominationId: nomination.nominationId, voting: true });
      await voteUpdatePromise;
    }

    const closedPromise = waitFor<any>(stSocket, ServerEvents.NominationClosed);
    stSocket.emit(ClientEvents.StorytellerCloseVote, { nominationId: nomination.nominationId });
    await closedPromise;

    const gameEndedPromises = [stSocket, ...playerSockets].map((s) => waitFor<any>(s, ServerEvents.GameEnded));
    stSocket.emit(ClientEvents.StorytellerConfirmExecution, { nominationId: nomination.nominationId });

    const results = await Promise.all(gameEndedPromises);
    for (const r of results) {
      expect(r).toEqual({ winner: 'good', reason: 'demon-executed' });
    }

    teardown(stSocket, playerSockets);
  }, 20000);

  it('the Slayer nominating the Demon kills them and ENDS the game, with no Execute button', async () => {
    /*
     * The real-browser probe of this character left the game running at `day-discussion`
     * after the Imp was Slain, which reads as "the Demon died and nothing happened".
     *
     * The rules layer was verified separately and does end the game, so this is the path
     * that decides it, and it is the one worth pinning: `announceImmediateExecution` is a
     * new function with no test of its own, and its job is exactly this — kill the Demon,
     * then run the normal post-death sweep.
     */
    const { stSocket, playerSockets, players } = await setUpGame(5);
    const [slayer, demon, t1, t2, t3] = players;
    setCharacter(slayer!, 'townsfolk', 'slayer');
    setCharacter(demon!, 'demon', 'imp');
    setCharacter(t1!, 'townsfolk', 'chef');
    setCharacter(t2!, 'townsfolk', 'empath');
    setCharacter(t3!, 'townsfolk', 'washerwoman');

    const opened = waitFor<any>(stSocket, ServerEvents.NominationOpened);
    playerSockets[0]!.emit(ClientEvents.PlayerNominate, { targetPlayerId: demon!.playerId });
    const nomination = await opened;

    for (let i = 0; i < 3; i++) {
      const p = waitFor<any>(stSocket, ServerEvents.NominationVoteUpdate);
      playerSockets[i]!.emit(ClientEvents.PlayerVote, { nominationId: nomination.nominationId, voting: true });
      await p;
    }

    // The game must end from the vote CLOSE. There is no Execute step, so nothing else
    // is sent before the assertion — if this passes, the Slayer is what ended it.
    // Both listeners are attached BEFORE the emit. `broadcastGameEnded` sends FlowUpdate
    // immediately after GameEnded, so a listener added after `await ended` never sees it —
    // which reads exactly like "the game did not end".
    const endedP = waitFor<any>(stSocket, ServerEvents.GameEnded);
    const flowP = waitFor<any>(stSocket, ServerEvents.FlowUpdate);
    stSocket.emit(ClientEvents.StorytellerCloseVote, { nominationId: nomination.nominationId });
    const [result, flow] = await Promise.all([endedP, flowP]);

    expect(result.winner).toBe('good');
    // Its OWN reason. Reusing `demon-self-killed` announced to the whole table that the
    // Demon killed themself, which is a different event and something the table would not
    // believe.
    expect(result.reason).toBe('demon-slain');
    expect(demon!.alive).toBe(false);
    // No execution is left waiting to be confirmed, which is what "immediately" means.
    expect(flow.stage).toBe('ended');
    expect(flow.executionPending).toBe(false);

    teardown(stSocket, playerSockets);
  }, 20000);

  it('hand-killing the Saint with Mark Dead loses the game for Good, as an execution would', async () => {
    /*
     * "If you die by execution, your team loses."
     *
     * This path went straight to `handlePostDeath`, which knows about the Demon's death and
     * Evil's 2-alive condition but nothing about the Saint — so a Storyteller could hand-kill
     * the Saint and Evil simply carried on, while the same death reached by nomination ended
     * the game. Same event, two answers, decided by which button was pressed.
     */
    const { session, stSocket, playerSockets, players } = await setUpGame(5);
    const [saint, demon, minion, t1, t2] = players;
    setCharacter(saint!, 'outsider', 'saint');
    setCharacter(demon!, 'demon', 'imp');
    setCharacter(minion!, 'minion', 'poisoner');
    setCharacter(t1!, 'townsfolk', 'chef');
    setCharacter(t2!, 'townsfolk', 'empath');
    session.phase = 'day';
    session.dayNumber = 1;

    const ended = waitFor<any>(stSocket, ServerEvents.GameEnded);
    stSocket.emit(ClientEvents.StorytellerMarkDead, { playerId: saint!.playerId });
    const result = await ended;

    expect(result).toEqual({ winner: 'evil', reason: 'saint-executed' });
    expect(session.phase).toBe('ended');
    expect(saint!.alive).toBe(false);

    teardown(stSocket, playerSockets);
  }, 20000);

  it('hand-killing a POISONED Saint does not lose the game, because their ability is not working', async () => {
    // The other half of the Saint's ruling, and the reason the check cannot simply be
    // "was the executed player the Saint". A poisoned player has no ability, and poison
    // covers the day it was cast, so a Saint poisoned before being executed really does not
    // take their team down with them. This is a well-known ruling and getting it wrong hands
    // Evil an instant, unearned win.
    const { session, stSocket, playerSockets, players } = await setUpGame(5);
    const [saint, demon, minion, t1, t2] = players;
    setCharacter(saint!, 'outsider', 'saint');
    setCharacter(demon!, 'demon', 'imp');
    setCharacter(minion!, 'minion', 'poisoner');
    setCharacter(t1!, 'townsfolk', 'chef');
    setCharacter(t2!, 'townsfolk', 'empath');
    session.phase = 'day';
    session.dayNumber = 1;
    saint!.statusEffects.poisoned = true;

    const died = waitFor<any>(stSocket, ServerEvents.GrimoireUpdate);
    stSocket.emit(ClientEvents.StorytellerMarkDead, { playerId: saint!.playerId });
    await died;
    await new Promise((r) => setTimeout(r, 150));

    expect(saint!.alive).toBe(false);
    expect(session.phase).toBe('day');
    expect(session.gameResult).toBeNull();

    teardown(stSocket, playerSockets);
  }, 20000);

  it('StorytellerDemonKill self-kill with a living Minion causes inheritance, notifies the Storyteller, and does not end the game', async () => {
    const { session, stSocket, playerSockets, players } = await setUpGame(5);
    // A night kill now requires the night phase (the kill button used to be live
    // during discussion, which is both a rules violation and a dead giveaway).
    session.phase = 'night';
    const [demon, minion, t1, t2, outsider] = players;
    setCharacter(demon!, 'demon', 'imp');
    setCharacter(minion!, 'minion', 'poisoner');
    setCharacter(t1!, 'townsfolk', 'chef');
    setCharacter(t2!, 'townsfolk', 'chef');
    setCharacter(outsider!, 'outsider', 'recluse');

    const inheritedPromise = waitFor<any>(stSocket, ServerEvents.DemonInherited);
    let gameEnded = false;
    stSocket.once(ServerEvents.GameEnded, () => {
      gameEnded = true;
    });

    stSocket.emit(ClientEvents.StorytellerDemonKill, { targetPlayerId: demon!.playerId });

    const inherited = await inheritedPromise;
    expect(inherited).toEqual({
      previousDemonPlayerId: demon!.playerId,
      newDemonPlayerId: minion!.playerId,
      newDemonCharacterId: 'imp',
    });

    // Give any (incorrect) GameEnded emission a moment to arrive before asserting it never did.
    await new Promise((r) => setTimeout(r, 50));
    expect(gameEnded).toBe(false);
    expect(session.players.get(demon!.playerId)!.alive).toBe(false);
    expect(session.players.get(minion!.playerId)!.characterType).toBe('demon');
    expect(session.phase).not.toBe('ended');

    teardown(stSocket, playerSockets);
  }, 20000);

  it('StorytellerDemonKill self-kill with no living Minion ends the game with Good winning', async () => {
    const { session, stSocket, playerSockets, players } = await setUpGame(5);
    session.phase = 'night';
    const [demon, t1, t2, t3, outsider] = players;
    setCharacter(demon!, 'demon', 'imp');
    setCharacter(t1!, 'townsfolk', 'chef');
    setCharacter(t2!, 'townsfolk', 'chef');
    setCharacter(t3!, 'townsfolk', 'chef');
    setCharacter(outsider!, 'outsider', 'recluse');

    const gameEndedPromise = waitFor<any>(stSocket, ServerEvents.GameEnded);
    stSocket.emit(ClientEvents.StorytellerDemonKill, { targetPlayerId: demon!.playerId });

    const result = await gameEndedPromise;
    expect(result).toEqual({ winner: 'good', reason: 'demon-self-killed' });

    teardown(stSocket, playerSockets);
  }, 20000);

  it('executing the Demon with a living Scarlet Woman and 5+ players remaining triggers takeover instead of ending the game', async () => {
    const { session, stSocket, playerSockets, players } = await setUpGame(6);
    const [demon, scarletWoman, t1, t2, t3, outsider] = players;
    setCharacter(demon!, 'demon', 'imp');
    setCharacter(scarletWoman!, 'minion', 'scarlet-woman');
    setCharacter(t1!, 'townsfolk', 'chef');
    setCharacter(t2!, 'townsfolk', 'chef');
    setCharacter(t3!, 'townsfolk', 'chef');
    setCharacter(outsider!, 'outsider', 'recluse');

    const nomination = await (async () => {
      const openedPromise = waitFor<any>(stSocket, ServerEvents.NominationOpened);
      playerSockets[1]!.emit(ClientEvents.PlayerNominate, { targetPlayerId: demon!.playerId });
      return openedPromise;
    })();

    for (let i = 0; i < 4; i++) {
      const voteUpdatePromise = waitFor<any>(stSocket, ServerEvents.NominationVoteUpdate);
      playerSockets[i]!.emit(ClientEvents.PlayerVote, { nominationId: nomination.nominationId, voting: true });
      await voteUpdatePromise;
    }

    const closedPromise = waitFor<any>(stSocket, ServerEvents.NominationClosed);
    stSocket.emit(ClientEvents.StorytellerCloseVote, { nominationId: nomination.nominationId });
    await closedPromise;

    let gameEnded = false;
    stSocket.once(ServerEvents.GameEnded, () => {
      gameEnded = true;
    });
    const executedPromise = waitFor<any>(stSocket, ServerEvents.ExecutionConfirmed);
    stSocket.emit(ClientEvents.StorytellerConfirmExecution, { nominationId: nomination.nominationId });
    await executedPromise;

    await new Promise((r) => setTimeout(r, 50));
    expect(gameEnded).toBe(false);
    expect(session.players.get(scarletWoman!.playerId)!.characterType).toBe('demon');
    expect(session.players.get(scarletWoman!.playerId)!.character).toBe('imp');
    expect(session.phase).not.toBe('ended');

    teardown(stSocket, playerSockets);
  }, 20000);

  it('StorytellerEndGame immediately ends the game with the declared winner, bypassing normal conditions', async () => {
    const { session, stSocket, playerSockets, players } = await setUpGame(5);
    const [demon, minion, t1, t2, outsider] = players;
    setCharacter(demon!, 'demon', 'imp');
    setCharacter(minion!, 'minion', 'poisoner');
    setCharacter(t1!, 'townsfolk', 'chef');
    setCharacter(t2!, 'townsfolk', 'chef');
    setCharacter(outsider!, 'outsider', 'recluse');

    const gameEndedPromises = [stSocket, ...playerSockets].map((s) => waitFor<any>(s, ServerEvents.GameEnded));
    stSocket.emit(ClientEvents.StorytellerEndGame, { winner: 'evil' });

    const results = await Promise.all(gameEndedPromises);
    for (const r of results) {
      expect(r).toEqual({ winner: 'evil', reason: 'storyteller-ended' });
    }
    expect(session.gameResult).toEqual({ winner: 'evil', reason: 'storyteller-ended' });
    // The Demon is still alive -- this was a pure manual override, not a natural win.
    expect(session.players.get(demon!.playerId)!.alive).toBe(true);

    teardown(stSocket, playerSockets);
  }, 20000);

  it('rejects nominations, votes, and further Storyteller actions once the game has ended', async () => {
    const { stSocket, playerSockets, players } = await setUpGame(5);
    const [demon, minion, t1, t2, outsider] = players;
    setCharacter(demon!, 'demon', 'imp');
    setCharacter(minion!, 'minion', 'poisoner');
    setCharacter(t1!, 'townsfolk', 'chef');
    setCharacter(t2!, 'townsfolk', 'chef');
    setCharacter(outsider!, 'outsider', 'recluse');

    const gameEndedPromise = waitFor<any>(stSocket, ServerEvents.GameEnded);
    stSocket.emit(ClientEvents.StorytellerEndGame, { winner: 'good' });
    await gameEndedPromise;

    const errorPromise = waitFor<any>(playerSockets[0]!, ServerEvents.Error);
    playerSockets[0]!.emit(ClientEvents.PlayerNominate, { targetPlayerId: t1!.playerId });
    const error = await errorPromise;
    expect(error.code).toBeDefined();

    const stErrorPromise = waitFor<any>(stSocket, ServerEvents.Error);
    stSocket.emit(ClientEvents.StorytellerEndGame, { winner: 'evil' });
    const stError = await stErrorPromise;
    expect(stError.code).toBeDefined();

    teardown(stSocket, playerSockets);
  }, 20000);
});
