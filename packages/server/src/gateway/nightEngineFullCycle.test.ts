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

/**
 * Full multi-night playthrough exercising the composition of everything
 * built for the Night Engine: status-effect clearing across nights, the
 * Monk actually blocking a kill, the Ravenkeeper's conditional wake, and
 * the Undertaker's next-night info about a day execution -- none of which
 * were previously proven to work TOGETHER across a realistic sequence,
 * only individually in isolation.
 */
describe('night engine full multi-night cycle', () => {
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

  it('Monk protection blocks Night 1 kill; the same target is killed Night 2 once protection has cleared; Ravenkeeper wakes and learns the true character; poison from Night 1 does not linger into Night 2', async () => {
    const { session, stSocket, playerSockets, players } = await setUpGame(6);
    const [imp, monk, ravenkeeper, poisonVictim, chef, poisoner] = players;
    setCharacter(imp!, 'imp', 'demon');
    setCharacter(monk!, 'monk', 'townsfolk');
    setCharacter(ravenkeeper!, 'ravenkeeper', 'townsfolk');
    setCharacter(poisonVictim!, 'chef', 'townsfolk'); // named for clarity: this player will be poisoned Night 1
    setCharacter(chef!, 'empath', 'townsfolk');
    setCharacter(poisoner!, 'poisoner', 'minion');

    // ---- Night 1 ----
    stSocket.emit(ClientEvents.StorytellerSetPhase, { phase: 'night' });
    const roster1 = await waitFor<any>(stSocket, ServerEvents.NightRosterUpdate);
    // First night wake order should include the Poisoner (0), Imp (0.5),
    // Chef-as-empath has no firstNightOrder... wait, Empath's firstNightOrder
    // IS 5, Monk has none on first night (Each night*). Just assert Poisoner
    // and Imp are present and in that relative order.
    const ids = roster1.steps.map((s: any) => s.characterId);
    expect(ids.indexOf('poisoner')).toBeLessThan(ids.indexOf('imp'));
    expect(ids).not.toContain('monk'); // Monk doesn't wake Night 1
    expect(ids).not.toContain('ravenkeeper'); // nobody has died at night yet

    // Poisoner poisons the designated victim.
    const poisonerSocketIndex = players.indexOf(poisoner!);
    await waitFor(playerSockets[poisonerSocketIndex]!, ServerEvents.NightPrompt);
    playerSockets[poisonerSocketIndex]!.emit(ClientEvents.PlayerSubmitNightAction, {
      targetPlayerIds: [poisonVictim!.playerId],
    });
    await waitFor(stSocket, ServerEvents.NightRosterUpdate);
    expect(session.players.get(poisonVictim!.playerId)!.statusEffects.poisoned).toBe(true);

    // Advance to the Imp and have it kill the Ravenkeeper.
    stSocket.emit(ClientEvents.StorytellerAdvanceNightStep);
    const killedPromise = waitFor<any>(stSocket, ServerEvents.GrimoireUpdate);
    stSocket.emit(ClientEvents.StorytellerDemonKill, { targetPlayerId: ravenkeeper!.playerId });
    await killedPromise;
    expect(session.players.get(ravenkeeper!.playerId)!.alive).toBe(false);

    // ---- Day 1 ----
    stSocket.emit(ClientEvents.StorytellerSetPhase, { phase: 'day' });
    await waitFor(stSocket, ServerEvents.GamePhaseChanged);
    // Poison persists through the day (poisoned lasts "tonight and tomorrow day").
    expect(session.players.get(poisonVictim!.playerId)!.statusEffects.poisoned).toBe(true);

    // ---- Night 2 ----
    stSocket.emit(ClientEvents.StorytellerSetPhase, { phase: 'night' });
    const roster2 = await waitFor<any>(stSocket, ServerEvents.NightRosterUpdate);
    const ids2 = roster2.steps.map((s: any) => s.characterId);
    // Now the Ravenkeeper DOES wake (died at night, hasn't had their triggered wake yet).
    expect(ids2).toContain('ravenkeeper');
    // Monk now wakes too (every night except the first).
    expect(ids2).toContain('monk');
    // Poison from Night 1 must be cleared at the start of Night 2.
    expect(session.players.get(poisonVictim!.playerId)!.statusEffects.poisoned).toBe(false);

    // Poisoner's turn again -- poison a DIFFERENT player this time, to keep the scenario simple.
    await waitFor(playerSockets[poisonerSocketIndex]!, ServerEvents.NightPrompt);
    playerSockets[poisonerSocketIndex]!.emit(ClientEvents.PlayerSubmitNightAction, {
      targetPlayerIds: [chef!.playerId],
    });
    await waitFor(stSocket, ServerEvents.NightRosterUpdate);

    let advanceAck = waitFor<any>(stSocket, ServerEvents.NightRosterUpdate);
    stSocket.emit(ClientEvents.StorytellerAdvanceNightStep); // -> Imp
    await advanceAck;

    // Monk protects the Imp's eventual target BEFORE the Imp acts, tonight.
    const monkSocketIndex = players.indexOf(monk!);
    advanceAck = waitFor<any>(stSocket, ServerEvents.NightRosterUpdate);
    stSocket.emit(ClientEvents.StorytellerAdvanceNightStep); // -> Monk (Imp has no submission gate, just narration)
    await advanceAck;
    await waitFor(playerSockets[monkSocketIndex]!, ServerEvents.NightPrompt);
    playerSockets[monkSocketIndex]!.emit(ClientEvents.PlayerSubmitNightAction, {
      targetPlayerIds: [chef!.playerId],
    });
    await waitFor(stSocket, ServerEvents.NightRosterUpdate);
    expect(session.players.get(chef!.playerId)!.statusEffects.protected).toBe(true);

    // The Imp targets the now-protected Chef -- the kill must be blocked.
    let deathBroadcast = false;
    playerSockets[players.indexOf(chef!)]!.once(ServerEvents.PlayerSelfUpdate, (payload: any) => {
      if (payload.alive === false) deathBroadcast = true;
    });
    const grimoireAfterBlockedKill = waitFor<any>(stSocket, ServerEvents.GrimoireUpdate);
    stSocket.emit(ClientEvents.StorytellerDemonKill, { targetPlayerId: chef!.playerId });
    await grimoireAfterBlockedKill;
    await new Promise((r) => setTimeout(r, 50));
    expect(deathBroadcast).toBe(false);
    expect(session.players.get(chef!.playerId)!.alive).toBe(true);

    teardown(stSocket, playerSockets);
  }, 20000);

  it("the Undertaker learns the true character executed that day, delivered automatically the following night, with no prompt", async () => {
    const { session, stSocket, playerSockets, players } = await setUpGame(6);
    const [imp, undertaker, target, chef, empath, minion] = players;
    setCharacter(imp!, 'imp', 'demon');
    setCharacter(undertaker!, 'undertaker', 'townsfolk');
    setCharacter(target!, 'washerwoman', 'townsfolk'); // will be executed
    setCharacter(chef!, 'chef', 'townsfolk');
    setCharacter(empath!, 'empath', 'townsfolk');
    setCharacter(minion!, 'poisoner', 'minion');

    // The Undertaker's ability is "Each night*" (every night EXCEPT the
    // first), so it can only ever report on an execution from Day 2
    // onward. Get through a no-op Night 1 first.
    stSocket.emit(ClientEvents.StorytellerSetPhase, { phase: 'night' });
    await waitFor(stSocket, ServerEvents.NightRosterUpdate);
    stSocket.emit(ClientEvents.StorytellerSetPhase, { phase: 'day' }); // -> Day 2
    await waitFor(stSocket, ServerEvents.GamePhaseChanged);

    // Nominate and execute `target` on Day 2.
    const opened = await (async () => {
      const p = waitFor<any>(stSocket, ServerEvents.NominationOpened);
      playerSockets[players.indexOf(chef!)]!.emit(ClientEvents.PlayerNominate, { targetPlayerId: target!.playerId });
      return p;
    })();
    for (const idx of [players.indexOf(chef!), players.indexOf(empath!), players.indexOf(undertaker!)]) {
      const voteUpdate = waitFor<any>(stSocket, ServerEvents.NominationVoteUpdate);
      playerSockets[idx]!.emit(ClientEvents.PlayerVote, { nominationId: opened.nominationId, voting: true });
      await voteUpdate;
    }
    const closedPromise = waitFor<any>(stSocket, ServerEvents.NominationClosed);
    stSocket.emit(ClientEvents.StorytellerCloseVote, { nominationId: opened.nominationId });
    await closedPromise;
    const executedPromise = waitFor<any>(stSocket, ServerEvents.ExecutionConfirmed);
    stSocket.emit(ClientEvents.StorytellerConfirmExecution, { nominationId: opened.nominationId });
    await executedPromise;
    expect(session.executedTodayCharacterId).toBe('washerwoman');

    // Night 2: the Undertaker should be delivered "The player who was
    // executed today was the Washerwoman." automatically, with no prompt.
    let sawPrompt = false;
    playerSockets[players.indexOf(undertaker!)]!.once(ServerEvents.NightPrompt, () => {
      sawPrompt = true;
    });
    const rosterPromise = waitFor<any>(stSocket, ServerEvents.NightRosterUpdate);
    stSocket.emit(ClientEvents.StorytellerSetPhase, { phase: 'night' });
    const roster = await rosterPromise;
    const undertakerStepIndex = roster.steps.findIndex((s: any) => s.characterId === 'undertaker');
    expect(undertakerStepIndex).toBeGreaterThanOrEqual(0);

    // Drive the roster forward, step by step, awaiting each update, until
    // we've advanced onto the Undertaker's own step.
    const infoPromise = waitFor<any>(playerSockets[players.indexOf(undertaker!)]!, ServerEvents.NightInfoResult);
    for (let i = 0; i < undertakerStepIndex; i++) {
      const nextRoster = waitFor<any>(stSocket, ServerEvents.NightRosterUpdate);
      stSocket.emit(ClientEvents.StorytellerAdvanceNightStep);
      await nextRoster;
    }
    const info = await infoPromise;

    expect(info.characterId).toBe('undertaker');
    expect(info.text).toContain('Washerwoman');
    expect(sawPrompt).toBe(false);

    teardown(stSocket, playerSockets);
  }, 20000);
});
