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

function setCharacter(player: PlayerRecord, character: string, characterType: PlayerRecord['characterType']) {
  player.character = character;
  player.characterType = characterType;
  player.alignment = characterType === 'demon' || characterType === 'minion' ? 'evil' : 'good';
}

describe('night action submission flow', () => {
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
    session.phase = 'day';
    session.dayNumber = 1;
    const players = [...session.players.values()];

    return { session, stSocket, playerSockets, players };
  }

  function teardown(stSocket: ClientSocket, playerSockets: ClientSocket[]) {
    stSocket.disconnect();
    for (const s of playerSockets) s.disconnect();
  }

  it('starts the night, sends the first waking player their prompt, and lets them submit', async () => {
    const { session, stSocket, playerSockets, players } = await setUpGame(4);
    setCharacter(players[0]!, 'poisoner', 'minion');
    setCharacter(players[1]!, 'monk', 'townsfolk');
    setCharacter(players[2]!, 'chef', 'townsfolk');
    setCharacter(players[3]!, 'imp', 'demon');

    const rosterPromise = waitFor<any>(stSocket, ServerEvents.NightRosterUpdate);
    const promptPromise = waitFor<any>(playerSockets[0]!, ServerEvents.NightPrompt); // poisoner wakes first (order 0)
    stSocket.emit(ClientEvents.StorytellerSetPhase, { phase: 'night' });

    const roster = await rosterPromise;
    expect(roster.isFirstNight).toBe(true);
    // Monk is "Each night*" (every night EXCEPT the first) per the real
    // rules, so it correctly does not appear on Night 1.
    expect(roster.steps.map((s: any) => s.characterId)).toEqual(['poisoner', 'imp', 'chef']);
    expect(roster.steps[0].current).toBe(true);

    const prompt = await promptPromise;
    expect(prompt.characterId).toBe('poisoner');
    expect(prompt.eligibleTargetIds).not.toContain(players[0]!.playerId); // 'other' restriction excludes self

    const updatedRosterPromise = waitFor<any>(stSocket, ServerEvents.NightRosterUpdate);
    playerSockets[0]!.emit(ClientEvents.PlayerSubmitNightAction, { targetPlayerIds: [players[2]!.playerId] });
    await updatedRosterPromise;

    expect(session.players.get(players[2]!.playerId)!.statusEffects.poisoned).toBe(true);
    expect(session.nightState!.submissions.has(players[0]!.playerId)).toBe(true);

    teardown(stSocket, playerSockets);
  }, 20000);

  it('advancing the step sends the next waking player their prompt', async () => {
    const { stSocket, playerSockets, players } = await setUpGame(4);
    setCharacter(players[0]!, 'poisoner', 'minion');
    setCharacter(players[1]!, 'empath', 'townsfolk');
    setCharacter(players[2]!, 'chef', 'townsfolk');
    setCharacter(players[3]!, 'imp', 'demon');

    // First night wake order: poisoner(0) -> imp(0.5) -> chef(4). Empath has
    // no firstNightOrder (it's an "each night" role starting Night 2), so
    // it correctly does not appear at all tonight.
    stSocket.emit(ClientEvents.StorytellerSetPhase, { phase: 'night' });
    await waitFor(playerSockets[0]!, ServerEvents.NightPrompt);
    playerSockets[0]!.emit(ClientEvents.PlayerSubmitNightAction, { targetPlayerIds: [players[2]!.playerId] });
    await waitFor(stSocket, ServerEvents.NightRosterUpdate);

    // Step 1 is the Imp -- has a nightPrompt but no in-app kill submission
    // path (that's the separate StorytellerDemonKill event), so it still
    // gets sent a prompt purely for narration purposes.
    const impPromptPromise = waitFor<any>(playerSockets[3]!, ServerEvents.NightPrompt);
    stSocket.emit(ClientEvents.StorytellerAdvanceNightStep);
    const impPrompt = await impPromptPromise;
    expect(impPrompt.characterId).toBe('imp');

    teardown(stSocket, playerSockets);
  }, 20000);

  it('rejects a submission from a player who is not the current wake-order step', async () => {
    const { stSocket, playerSockets, players } = await setUpGame(4);
    setCharacter(players[0]!, 'poisoner', 'minion');
    setCharacter(players[1]!, 'monk', 'townsfolk');
    setCharacter(players[2]!, 'chef', 'townsfolk');
    setCharacter(players[3]!, 'imp', 'demon');

    stSocket.emit(ClientEvents.StorytellerSetPhase, { phase: 'night' });
    await waitFor(playerSockets[0]!, ServerEvents.NightPrompt);

    // Monk (step index 2) tries to act while the Poisoner (step 0) is current.
    const errorPromise = waitFor<any>(playerSockets[1]!, ServerEvents.Error);
    playerSockets[1]!.emit(ClientEvents.PlayerSubmitNightAction, { targetPlayerIds: [players[2]!.playerId] });
    const error = await errorPromise;
    expect(error.code).toBe('NOT_YOUR_NIGHT_ACTION');

    teardown(stSocket, playerSockets);
  }, 20000);

  it('rejects a target outside the character targetRestrictions', async () => {
    const { stSocket, playerSockets, players } = await setUpGame(4);
    setCharacter(players[0]!, 'poisoner', 'minion');
    setCharacter(players[1]!, 'monk', 'townsfolk');
    setCharacter(players[2]!, 'chef', 'townsfolk');
    setCharacter(players[3]!, 'imp', 'demon');

    stSocket.emit(ClientEvents.StorytellerSetPhase, { phase: 'night' });
    await waitFor(playerSockets[0]!, ServerEvents.NightPrompt);

    // Poisoner's 'other' restriction excludes targeting themself.
    const errorPromise = waitFor<any>(playerSockets[0]!, ServerEvents.Error);
    playerSockets[0]!.emit(ClientEvents.PlayerSubmitNightAction, { targetPlayerIds: [players[0]!.playerId] });
    const error = await errorPromise;
    expect(error.code).toBe('INVALID_NIGHT_TARGET');

    teardown(stSocket, playerSockets);
  }, 20000);

  it('rejects a second submission from the same player for the same night', async () => {
    const { stSocket, playerSockets, players } = await setUpGame(4);
    setCharacter(players[0]!, 'poisoner', 'minion');
    setCharacter(players[1]!, 'monk', 'townsfolk');
    setCharacter(players[2]!, 'chef', 'townsfolk');
    setCharacter(players[3]!, 'imp', 'demon');

    stSocket.emit(ClientEvents.StorytellerSetPhase, { phase: 'night' });
    await waitFor(playerSockets[0]!, ServerEvents.NightPrompt);
    playerSockets[0]!.emit(ClientEvents.PlayerSubmitNightAction, { targetPlayerIds: [players[2]!.playerId] });
    await waitFor(stSocket, ServerEvents.NightRosterUpdate);

    const errorPromise = waitFor<any>(playerSockets[0]!, ServerEvents.Error);
    playerSockets[0]!.emit(ClientEvents.PlayerSubmitNightAction, { targetPlayerIds: [players[2]!.playerId] });
    const error = await errorPromise;
    expect(error.code).toBe('NIGHT_ACTION_ALREADY_SUBMITTED');

    teardown(stSocket, playerSockets);
  }, 20000);

  it("delivers 'auto'-class role info (Chef, Empath) automatically with no prompt, as soon as their step is reached", async () => {
    const { stSocket, playerSockets, players } = await setUpGame(4);
    setCharacter(players[0]!, 'poisoner', 'minion');
    setCharacter(players[1]!, 'chef', 'townsfolk');
    setCharacter(players[2]!, 'empath', 'townsfolk');
    setCharacter(players[3]!, 'imp', 'demon');

    stSocket.emit(ClientEvents.StorytellerSetPhase, { phase: 'night' });
    await waitFor(playerSockets[0]!, ServerEvents.NightPrompt); // poisoner's turn first

    // Advance past the Poisoner (without submitting -- irrelevant to this
    // test) straight to the Chef's step; Chef should get an info result
    // with NO prompt at all, since 'auto' roles need no player choice.
    playerSockets[0]!.emit(ClientEvents.PlayerSubmitNightAction, { targetPlayerIds: [players[1]!.playerId] });
    await waitFor(stSocket, ServerEvents.NightRosterUpdate);

    const chefInfoPromise = waitFor<any>(playerSockets[1]!, ServerEvents.NightInfoResult);
    stSocket.emit(ClientEvents.StorytellerAdvanceNightStep); // -> Imp
    stSocket.emit(ClientEvents.StorytellerAdvanceNightStep); // -> Chef
    const chefInfo = await chefInfoPromise;
    expect(chefInfo.characterId).toBe('chef');
    expect(chefInfo.text).toMatch(/pair/);

    teardown(stSocket, playerSockets);
  }, 20000);

  it('the Ravenkeeper only wakes on the night after a night death, delivering the true character', async () => {
    const { session, stSocket, playerSockets, players } = await setUpGame(5);
    setCharacter(players[0]!, 'imp', 'demon');
    setCharacter(players[1]!, 'ravenkeeper', 'townsfolk');
    setCharacter(players[2]!, 'chef', 'townsfolk');
    setCharacter(players[3]!, 'empath', 'townsfolk');
    setCharacter(players[4]!, 'poisoner', 'minion');

    // Night 1: Ravenkeeper should NOT wake (nobody has died at night yet).
    stSocket.emit(ClientEvents.StorytellerSetPhase, { phase: 'night' });
    const roster1 = await waitFor<any>(stSocket, ServerEvents.NightRosterUpdate);
    expect(roster1.steps.map((s: any) => s.characterId)).not.toContain('ravenkeeper');

    // Still Night 1: the Imp kills the Ravenkeeper.
    const killedPromise = waitFor<any>(stSocket, ServerEvents.GrimoireUpdate);
    stSocket.emit(ClientEvents.StorytellerDemonKill, { targetPlayerId: players[1]!.playerId });
    await killedPromise;
    expect(session.players.get(players[1]!.playerId)!.alive).toBe(false);
    expect(session.players.get(players[1]!.playerId)!.diedAtNightPending).toBe(true);

    // Day 1 -> Night 2: the Ravenkeeper should now wake to learn who died.
    stSocket.emit(ClientEvents.StorytellerSetPhase, { phase: 'day' });
    await waitFor(stSocket, ServerEvents.GamePhaseChanged);
    stSocket.emit(ClientEvents.StorytellerSetPhase, { phase: 'night' });
    const roster2 = await waitFor<any>(stSocket, ServerEvents.NightRosterUpdate);
    expect(roster2.steps.map((s: any) => s.characterId)).toContain('ravenkeeper');

    teardown(stSocket, playerSockets);
  }, 20000);
});
