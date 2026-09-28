import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from './app.js';
import { SessionStore } from '../session/store.js';

interface ErrorBody {
  error: { code: string; message: string };
}

interface CreateSessionBody {
  code: string;
  storytellerToken: string;
}

interface JoinBody {
  playerId: string;
  playerToken: string;
  code: string;
}

async function withServer<T>(fn: (baseUrl: string, store: SessionStore) => Promise<T>): Promise<T> {
  const store = new SessionStore();
  const app = createApp(store);
  const httpServer = createServer(app);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const address = httpServer.address() as AddressInfo;
  try {
    return await fn(`http://localhost:${address.port}`, store);
  } finally {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }
}

async function createGameWithPlayer(
  baseUrl: string,
  store: SessionStore,
  displayName = 'Alice'
): Promise<{ code: string; playerId: string; playerToken: string }> {
  const createRes = await fetch(`${baseUrl}/api/sessions`, { method: 'POST' });
  const { code } = (await createRes.json()) as CreateSessionBody;
  const joinRes = await fetch(`${baseUrl}/api/sessions/${code}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName }),
  });
  const { playerId, playerToken } = (await joinRes.json()) as JoinBody;
  // Simulate the game having started -- reclaim is only for mid-game.
  const session = store.getSession(code)!;
  session.phase = 'day';
  return { code, playerId, playerToken };
}

describe('POST /api/sessions/:code/reclaim', () => {
  it('rejects reclaim while the game is still in the lobby', async () => {
    await withServer(async (baseUrl) => {
      const createRes = await fetch(`${baseUrl}/api/sessions`, { method: 'POST' });
      const { code } = (await createRes.json()) as CreateSessionBody;
      await fetch(`${baseUrl}/api/sessions/${code}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'Alice' }),
      });

      const res = await fetch(`${baseUrl}/api/sessions/${code}/reclaim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'Alice' }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.code).toBe('RECLAIM_NOT_IN_PROGRESS');
    });
  });

  it('rejects reclaim for a name that has no matching seat', async () => {
    await withServer(async (baseUrl, store) => {
      const { code } = await createGameWithPlayer(baseUrl, store, 'Alice');

      const res = await fetch(`${baseUrl}/api/sessions/${code}/reclaim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'NobodyByThisName' }),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.code).toBe('RECLAIM_NO_MATCH');
    });
  });

  it('rejects reclaim while the seat is still actively connected', async () => {
    await withServer(async (baseUrl, store) => {
      const { code, playerId } = await createGameWithPlayer(baseUrl, store, 'Alice');
      // Simulate an active connection (never disconnected).
      store.getSession(code)!.players.get(playerId)!.connectionId = 'some-socket-id';

      const res = await fetch(`${baseUrl}/api/sessions/${code}/reclaim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'Alice' }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.code).toBe('RECLAIM_STILL_CONNECTED');
    });
  });

  it('rejects reclaim within the grace period after disconnecting', async () => {
    await withServer(async (baseUrl, store) => {
      const { code, playerId } = await createGameWithPlayer(baseUrl, store, 'Alice');
      const player = store.getSession(code)!.players.get(playerId)!;
      player.connectionId = null;
      player.disconnectedAt = Date.now(); // just now -- well within the grace period

      const res = await fetch(`${baseUrl}/api/sessions/${code}/reclaim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'Alice' }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.code).toBe('RECLAIM_TOO_SOON');
    });
  });

  it('allows reclaim once the grace period has elapsed, re-issuing a token for the SAME playerId', async () => {
    await withServer(async (baseUrl, store) => {
      const { code, playerId } = await createGameWithPlayer(baseUrl, store, 'Alice');
      const session = store.getSession(code)!;
      const player = session.players.get(playerId)!;
      player.connectionId = null;
      player.disconnectedAt = Date.now() - 61_000; // just past the 60s grace period
      // Give the seat some mid-game state that must survive the reclaim.
      player.character = 'imp';
      player.characterType = 'demon';
      player.alignment = 'evil';
      player.alive = true;

      const res = await fetch(`${baseUrl}/api/sessions/${code}/reclaim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'alice' }), // case-insensitive match
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as JoinBody;
      expect(body.playerId).toBe(playerId);
      expect(typeof body.playerToken).toBe('string');

      // Reclaiming must not create a second PlayerRecord / consume a second seat.
      expect(session.players.size).toBe(1);
      expect(session.players.get(playerId)!.character).toBe('imp');
      expect(session.players.get(playerId)!.characterType).toBe('demon');
    });
  });

  it('allows reclaim immediately when disconnectedAt was never set to a recent time (e.g. server restart scenario)', async () => {
    await withServer(async (baseUrl, store) => {
      const { code, playerId } = await createGameWithPlayer(baseUrl, store, 'Alice');
      const session = store.getSession(code)!;
      const player = session.players.get(playerId)!;
      player.connectionId = null;
      player.disconnectedAt = null;

      const res = await fetch(`${baseUrl}/api/sessions/${code}/reclaim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'Alice' }),
      });
      expect(res.status).toBe(200);
    });
  });
});
