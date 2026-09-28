import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Server as SocketIOServer } from 'socket.io';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { ClientEvents, ServerEvents } from '@clocktower/shared';
import { SessionStore } from '../session/store.js';
import { registerGatewayHandlers } from './index.js';
import { createApp } from '../http/app.js';

async function waitFor<T = unknown>(socket: ClientSocket, event: string): Promise<T> {
  return new Promise((resolve) => {
    socket.once(event, (payload: T) => resolve(payload));
  });
}

/** Waits for the first occurrence of `event` on `socket` whose payload satisfies `predicate`, ignoring earlier (stale) emissions of the same event that may still be in flight from unrelated setup broadcasts. */
async function waitForMatching<T = unknown>(socket: ClientSocket, event: string, predicate: (payload: T) => boolean): Promise<T> {
  return new Promise((resolve) => {
    const handler = (payload: T) => {
      if (predicate(payload)) {
        socket.off(event, handler);
        resolve(payload);
      }
    };
    socket.on(event, handler);
  });
}

describe('nomination flow: multiple nominations per day (regression for #4)', () => {
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

  async function setUpGame(count: number) {
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
    session.phase = 'day';
    session.dayNumber = 1;
    const players = [...session.players.values()];

    return { session, stSocket, playerSockets, players };
  }

  function teardown(stSocket: ClientSocket, playerSockets: ClientSocket[]) {
    stSocket.disconnect();
    for (const s of playerSockets) s.disconnect();
  }

  it('allows a second nomination by a different player on the same day after the first fails', async () => {
    const { stSocket, playerSockets, players } = await setUpGame(5);

    const opened1 = await (async () => {
      const p = waitFor<any>(stSocket, ServerEvents.NominationOpened);
      playerSockets[0]!.emit(ClientEvents.PlayerNominate, { targetPlayerId: players[1]!.playerId });
      return p;
    })();

    // Only 1 yes-vote, threshold is 3 -- this nomination fails.
    const voteUpdate = waitFor<any>(stSocket, ServerEvents.NominationVoteUpdate);
    playerSockets[0]!.emit(ClientEvents.PlayerVote, { nominationId: opened1.nominationId, voting: true });
    await voteUpdate;

    const closed1Promise = waitFor<any>(stSocket, ServerEvents.NominationClosed);
    stSocket.emit(ClientEvents.StorytellerCloseVote, { nominationId: opened1.nominationId });
    const closed1 = await closed1Promise;
    expect(closed1.pendingExecution).toBe(false);
    expect(closed1.votesFor).toBe(1);
    expect(closed1.threshold).toBe(3);

    // A DIFFERENT player (who hasn't nominated yet) must be able to open a
    // second nomination immediately, in the same day, with no phase change.
    // This is the actual bug: previously the server allowed this but every
    // client's local nomination-open gating was based on a stale check.
    const opened2Promise = waitFor<any>(stSocket, ServerEvents.NominationOpened);
    playerSockets[2]!.emit(ClientEvents.PlayerNominate, { targetPlayerId: players[3]!.playerId });
    const opened2 = await opened2Promise;
    expect(opened2.nominatorId).toBe(players[2]!.playerId);
    expect(opened2.targetId).toBe(players[3]!.playerId);
    expect(opened2.closed).toBe(false);

    teardown(stSocket, playerSockets);
  }, 20000);

  it('rejects a second nomination attempt by the SAME player on the same day, with a specific error', async () => {
    const { stSocket, playerSockets, players } = await setUpGame(5);

    const opened = await (async () => {
      const p = waitFor<any>(stSocket, ServerEvents.NominationOpened);
      playerSockets[0]!.emit(ClientEvents.PlayerNominate, { targetPlayerId: players[1]!.playerId });
      return p;
    })();

    const closedPromise = waitFor<any>(stSocket, ServerEvents.NominationClosed);
    stSocket.emit(ClientEvents.StorytellerCloseVote, { nominationId: opened.nominationId });
    await closedPromise;

    const errorPromise = waitFor<any>(playerSockets[0]!, ServerEvents.Error);
    playerSockets[0]!.emit(ClientEvents.PlayerNominate, { targetPlayerId: players[3]!.playerId });
    const error = await errorPromise;
    expect(error.code).toBe('ALREADY_NOMINATED_TODAY');

    teardown(stSocket, playerSockets);
  }, 20000);

  it('broadcasts hasNominatedToday via the lobby so clients can show a specific reason', async () => {
    const { stSocket, playerSockets, players } = await setUpGame(5);

    // Setup itself triggers earlier LobbyUpdate broadcasts (one per player
    // joining/authenticating); wait specifically for the one reflecting
    // THIS nomination rather than grabbing whichever LobbyUpdate arrives
    // first, which can be a stale one still in flight from setup.
    const lobbyPromise = waitForMatching<any>(stSocket, ServerEvents.LobbyUpdate, (payload) =>
      payload.players.find((p: any) => p.playerId === players[0]!.playerId)?.hasNominatedToday === true
    );
    playerSockets[0]!.emit(ClientEvents.PlayerNominate, { targetPlayerId: players[1]!.playerId });
    const lobby = await lobbyPromise;

    const nominator = lobby.players.find((p: any) => p.playerId === players[0]!.playerId);
    const other = lobby.players.find((p: any) => p.playerId === players[2]!.playerId);
    expect(nominator.hasNominatedToday).toBe(true);
    expect(other.hasNominatedToday).toBe(false);

    teardown(stSocket, playerSockets);
  }, 20000);

  it('confirmExecution is idempotent: a duplicate emit does not re-run death side effects', async () => {
    const { session, stSocket, playerSockets, players } = await setUpGame(5);
    // Force the execution target to be a non-Demon, and guarantee a Demon
    // survives elsewhere, so the game doesn't end (which would make the
    // second confirm fail with GAME_ALREADY_ENDED instead of the
    // idempotency guard this test is actually checking).
    const target = players[1]!;
    session.players.get(target.playerId)!.characterType = 'townsfolk';
    session.players.get(players[4]!.playerId)!.characterType = 'demon';

    const opened = await (async () => {
      const p = waitFor<any>(stSocket, ServerEvents.NominationOpened);
      playerSockets[0]!.emit(ClientEvents.PlayerNominate, { targetPlayerId: target.playerId });
      return p;
    })();

    for (let i = 0; i < 3; i++) {
      const voteUpdate = waitFor<any>(stSocket, ServerEvents.NominationVoteUpdate);
      playerSockets[i]!.emit(ClientEvents.PlayerVote, { nominationId: opened.nominationId, voting: true });
      await voteUpdate;
    }

    const closedPromise = waitFor<any>(stSocket, ServerEvents.NominationClosed);
    stSocket.emit(ClientEvents.StorytellerCloseVote, { nominationId: opened.nominationId });
    await closedPromise;

    const executedPromise = waitFor<any>(stSocket, ServerEvents.ExecutionConfirmed);
    stSocket.emit(ClientEvents.StorytellerConfirmExecution, { nominationId: opened.nominationId });
    await executedPromise;
    expect(session.players.get(players[1]!.playerId)!.alive).toBe(false);

    // A duplicate confirm (double-click, retried emit) must be rejected, not
    // silently re-run.
    const errorPromise = waitFor<any>(stSocket, ServerEvents.Error);
    stSocket.emit(ClientEvents.StorytellerConfirmExecution, { nominationId: opened.nominationId });
    const error = await errorPromise;
    expect(error.code).toBe('NOMINATION_ALREADY_EXECUTED');

    teardown(stSocket, playerSockets);
  }, 20000);

  it('a redundant StorytellerSetPhase call to the CURRENT phase does not drop a pending execution', async () => {
    const { session, stSocket, playerSockets, players } = await setUpGame(5);

    const opened = await (async () => {
      const p = waitFor<any>(stSocket, ServerEvents.NominationOpened);
      playerSockets[0]!.emit(ClientEvents.PlayerNominate, { targetPlayerId: players[1]!.playerId });
      return p;
    })();

    for (let i = 0; i < 3; i++) {
      const voteUpdate = waitFor<any>(stSocket, ServerEvents.NominationVoteUpdate);
      playerSockets[i]!.emit(ClientEvents.PlayerVote, { nominationId: opened.nominationId, voting: true });
      await voteUpdate;
    }

    const closedPromise = waitFor<any>(stSocket, ServerEvents.NominationClosed);
    stSocket.emit(ClientEvents.StorytellerCloseVote, { nominationId: opened.nominationId });
    await closedPromise;

    expect(session.phase).toBe('day');
    expect(session.nomination?.pendingExecution).toBe(true);

    // Redundant "Switch to Day" while already in day (e.g. a double-click)
    // must be a no-op for game state, not a fresh resetForNewDay().
    const phaseChangedPromise = waitFor<any>(stSocket, ServerEvents.GamePhaseChanged);
    stSocket.emit(ClientEvents.StorytellerSetPhase, { phase: 'day' });
    await phaseChangedPromise;

    expect(session.phase).toBe('day');
    expect(session.nomination?.pendingExecution).toBe(true);
    expect(session.nomination?.id).toBe(opened.nominationId);

    teardown(stSocket, playerSockets);
  }, 20000);
});
