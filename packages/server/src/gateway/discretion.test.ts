import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Server as SocketIOServer } from 'socket.io';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { ClientEvents, ServerEvents } from '@clocktower/shared';
import { SessionStore, type PlayerRecord } from '../session/store.js';
import { registerGatewayHandlers } from './index.js';
import { createApp } from '../http/app.js';

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

describe('Storyteller discretion overrides', () => {
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

  it("overrides the Drunk's cover character, updates their own client, and appends an auditable log entry", async () => {
    const createRes = await fetch(`${baseUrl}/api/sessions`, { method: 'POST' });
    const { code, storytellerToken } = (await createRes.json()) as { code: string; storytellerToken: string };

    const joinRes = await fetch(`${baseUrl}/api/sessions/${code}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'DrunkPlayer' }),
    });
    const { playerId, playerToken } = (await joinRes.json()) as { playerId: string; playerToken: string };

    const stSocket = ioClient(baseUrl, { transports: ['websocket'] });
    await waitFor(stSocket, 'connect');
    stSocket.emit(ClientEvents.Auth, { token: storytellerToken });
    await waitFor(stSocket, ServerEvents.AuthOk);

    const drunkSocket = ioClient(baseUrl, { transports: ['websocket'] });
    await waitFor(drunkSocket, 'connect');
    drunkSocket.emit(ClientEvents.Auth, { token: playerToken });
    await waitFor(drunkSocket, ServerEvents.AuthOk);

    const session = store.getSession(code)!;
    const drunk = session.players.get(playerId)!;
    setCharacter(drunk, 'drunk', 'outsider');
    drunk.drunkCoverCharacterId = 'chef';

    const logPromise = waitFor<any>(stSocket, ServerEvents.DiscretionLogUpdate);
    const distributedPromise = waitFor<any>(drunkSocket, ServerEvents.GameDistributed);
    stSocket.emit(ClientEvents.StorytellerSetDiscretionOverride, {
      kind: 'drunk-cover',
      playerId,
      value: 'empath',
    });

    const log = await logPromise;
    expect(log.entries.some((e: any) => e.kind === 'drunk-cover' && e.isOverride === true)).toBe(true);

    const distributed = await distributedPromise;
    expect(distributed.characterName).toBe('Empath');
    expect(distributed.character).toBe('drunk'); // true character id is unchanged internally

    stSocket.disconnect();
    drunkSocket.disconnect();
  }, 20000);

  it("overrides the Fortune Teller's red herring to a different player", async () => {
    const createRes = await fetch(`${baseUrl}/api/sessions`, { method: 'POST' });
    const { code, storytellerToken } = (await createRes.json()) as { code: string; storytellerToken: string };

    const playerIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const joinRes = await fetch(`${baseUrl}/api/sessions/${code}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: `Player${i}` }),
      });
      const { playerId } = (await joinRes.json()) as { playerId: string };
      playerIds.push(playerId);
    }

    const stSocket = ioClient(baseUrl, { transports: ['websocket'] });
    await waitFor(stSocket, 'connect');
    stSocket.emit(ClientEvents.Auth, { token: storytellerToken });
    await waitFor(stSocket, ServerEvents.AuthOk);

    const session = store.getSession(code)!;
    const ft = session.players.get(playerIds[0]!)!;
    setCharacter(ft, 'fortune-teller', 'townsfolk');
    ft.fortuneTellerRedHerringId = playerIds[1]!;

    const logPromise = waitFor<any>(stSocket, ServerEvents.DiscretionLogUpdate);
    stSocket.emit(ClientEvents.StorytellerSetDiscretionOverride, {
      kind: 'fortune-teller-red-herring',
      playerId: playerIds[0]!,
      value: playerIds[2]!,
    });
    await logPromise;

    expect(session.players.get(playerIds[0]!)!.fortuneTellerRedHerringId).toBe(playerIds[2]);

    stSocket.disconnect();
  }, 20000);

  it('only the Storyteller can set a discretion override', async () => {
    const createRes = await fetch(`${baseUrl}/api/sessions`, { method: 'POST' });
    const { code } = (await createRes.json()) as { code: string };

    const joinRes = await fetch(`${baseUrl}/api/sessions/${code}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'RegularPlayer' }),
    });
    const { playerId, playerToken } = (await joinRes.json()) as { playerId: string; playerToken: string };

    const playerSocket = ioClient(baseUrl, { transports: ['websocket'] });
    await waitFor(playerSocket, 'connect');
    playerSocket.emit(ClientEvents.Auth, { token: playerToken });
    await waitFor(playerSocket, ServerEvents.AuthOk);

    const errorPromise = waitFor<any>(playerSocket, ServerEvents.Error);
    playerSocket.emit(ClientEvents.StorytellerSetDiscretionOverride, {
      kind: 'drunk-cover',
      playerId,
      value: 'chef',
    });
    const error = await errorPromise;
    expect(error.code).toBe('NOT_STORYTELLER');

    playerSocket.disconnect();
  }, 20000);
});
