import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Server as SocketIOServer } from 'socket.io';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { ClientEvents, ServerEvents } from '@clocktower/shared';
import { SessionStore, type PlayerRecord } from '../session/store.js';
import { registerGatewayHandlers } from './index.js';
import { createApp } from '../http/app.js';
import { broadcastGrimoire } from '../game/broadcast.js';

async function waitFor<T = unknown>(socket: ClientSocket, event: string): Promise<T> {
  return new Promise((resolve) => {
    socket.once(event, (payload: T) => resolve(payload));
  });
}

function setCharacter(player: PlayerRecord, character: string, characterType: PlayerRecord['characterType']) {
  player.character = character;
  player.characterType = characterType;
  player.alignment = characterType === 'demon' || characterType === 'minion' ? 'evil' : 'good';
}

describe("Spy's Grimoire access", () => {
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

  it('a living Spy receives the same GrimoireUpdate the Storyteller gets; other players do not', async () => {
    const createRes = await fetch(`${baseUrl}/api/sessions`, { method: 'POST' });
    const { code, storytellerToken } = (await createRes.json()) as { code: string; storytellerToken: string };

    const playerTokens: { playerId: string; playerToken: string }[] = [];
    for (let i = 0; i < 4; i++) {
      const joinRes = await fetch(`${baseUrl}/api/sessions/${code}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: `Player${i}` }),
      });
      playerTokens.push((await joinRes.json()) as { playerId: string; playerToken: string });
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
    const players = [...session.players.values()];
    setCharacter(players[0]!, 'spy', 'minion');
    setCharacter(players[1]!, 'chef', 'townsfolk');
    setCharacter(players[2]!, 'empath', 'townsfolk');
    setCharacter(players[3]!, 'imp', 'demon');

    const spySocket = playerSockets[0]!;
    const nonSpySocket = playerSockets[1]!;

    let nonSpyReceived = false;
    nonSpySocket.once(ServerEvents.GrimoireUpdate, () => {
      nonSpyReceived = true;
    });

    const spyGrimoirePromise = waitFor<any>(spySocket, ServerEvents.GrimoireUpdate);
    const stGrimoirePromise = waitFor<any>(stSocket, ServerEvents.GrimoireUpdate);
    broadcastGrimoire(io, session);

    const [spyGrimoire, stGrimoire] = await Promise.all([spyGrimoirePromise, stGrimoirePromise]);
    expect(spyGrimoire.grimoire).toEqual(stGrimoire.grimoire);
    // Sanity: the Grimoire genuinely reveals secret info (true characters),
    // proving this isn't an accidentally-empty/public-safe payload.
    expect(spyGrimoire.grimoire.some((g: any) => g.character === 'imp')).toBe(true);

    await new Promise((r) => setTimeout(r, 50));
    expect(nonSpyReceived).toBe(false);

    stSocket.disconnect();
    for (const s of playerSockets) s.disconnect();
  }, 20000);

  it('a dead Spy no longer receives the Grimoire', async () => {
    const createRes = await fetch(`${baseUrl}/api/sessions`, { method: 'POST' });
    const { code, storytellerToken } = (await createRes.json()) as { code: string; storytellerToken: string };

    const joinRes = await fetch(`${baseUrl}/api/sessions/${code}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'SpyPlayer' }),
    });
    const { playerId, playerToken } = (await joinRes.json()) as { playerId: string; playerToken: string };

    const stSocket = ioClient(baseUrl, { transports: ['websocket'] });
    await waitFor(stSocket, 'connect');
    stSocket.emit(ClientEvents.Auth, { token: storytellerToken });
    await waitFor(stSocket, ServerEvents.AuthOk);

    const spySocket = ioClient(baseUrl, { transports: ['websocket'] });
    await waitFor(spySocket, 'connect');
    spySocket.emit(ClientEvents.Auth, { token: playerToken });
    await waitFor(spySocket, ServerEvents.AuthOk);

    const session = store.getSession(code)!;
    const spy = session.players.get(playerId)!;
    setCharacter(spy, 'spy', 'minion');
    spy.alive = false;

    let received = false;
    spySocket.once(ServerEvents.GrimoireUpdate, () => {
      received = true;
    });
    broadcastGrimoire(io, session);
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toBe(false);

    stSocket.disconnect();
    spySocket.disconnect();
  }, 20000);
});
