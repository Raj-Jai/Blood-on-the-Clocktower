import { describe, expect, it } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { Socket } from 'socket.io-client';
import { ServerEvents, type ActiveNominationView } from '@clocktower/shared';
import { useSession } from './useSession.js';

/**
 * Minimal fake Socket.IO client socket: just enough event emitter surface
 * (on/off/emit) for useSession's subscriptions, without a real connection.
 */
function createFakeSocket() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const socket = {
    on(event: string, handler: (...args: unknown[]) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
      return socket;
    },
    off(event: string, handler: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(handler);
      return socket;
    },
    fire(event: string, payload?: unknown) {
      for (const handler of listeners.get(event) ?? []) {
        handler(payload);
      }
    },
  };
  return socket as unknown as Socket & { fire: (event: string, payload?: unknown) => void };
}

function nomination(overrides: Partial<ActiveNominationView>): ActiveNominationView {
  return {
    nominationId: 'nom-1',
    nominatorId: 'p0',
    targetId: 'p1',
    votes: [],
    closed: false,
    pendingExecution: false,
    executed: false,
    votesFor: 0,
    threshold: 3,
    ...overrides,
  };
}

describe('useSession nomination state', () => {
  it('sets the nomination on NominationOpened', () => {
    const socket = createFakeSocket();
    const { result } = renderHook(() => useSession(socket));

    act(() => socket.fire(ServerEvents.NominationOpened, nomination({})));

    expect(result.current.nomination?.nominationId).toBe('nom-1');
    expect(result.current.nomination?.closed).toBe(false);
  });

  it('keeps the resolved nomination visible (closed) after NominationClosed, rather than nulling it', () => {
    const socket = createFakeSocket();
    const { result } = renderHook(() => useSession(socket));

    act(() => socket.fire(ServerEvents.NominationOpened, nomination({})));
    act(() =>
      socket.fire(
        ServerEvents.NominationClosed,
        nomination({ closed: true, pendingExecution: false, votesFor: 1, threshold: 3 })
      )
    );

    // This is the crux of the P0 bug: the nomination must be visible as a
    // resolved outcome (closed: true), not simply gone/null -- the client's
    // job is to interpret "closed" to know a NEW nomination can now open,
    // not to lose track of the old one.
    expect(result.current.nomination?.closed).toBe(true);
    expect(result.current.nomination?.pendingExecution).toBe(false);
  });

  it('clears the nomination on a phase change (new day/night)', () => {
    const socket = createFakeSocket();
    const { result } = renderHook(() => useSession(socket));

    act(() => socket.fire(ServerEvents.NominationOpened, nomination({})));
    act(() =>
      socket.fire(ServerEvents.GamePhaseChanged, { phase: 'night', dayNumber: 1, phaseEndsAt: null })
    );

    expect(result.current.nomination).toBeNull();
  });

  it('supports opening a second nomination after the first closes without a phase change', () => {
    const socket = createFakeSocket();
    const { result } = renderHook(() => useSession(socket));

    act(() => socket.fire(ServerEvents.NominationOpened, nomination({ nominationId: 'nom-1' })));
    act(() =>
      socket.fire(ServerEvents.NominationClosed, nomination({ nominationId: 'nom-1', closed: true, votesFor: 1 }))
    );
    act(() =>
      socket.fire(
        ServerEvents.NominationOpened,
        nomination({ nominationId: 'nom-2', nominatorId: 'p2', targetId: 'p3' })
      )
    );

    expect(result.current.nomination?.nominationId).toBe('nom-2');
    expect(result.current.nomination?.closed).toBe(false);
  });

  it('reflects hasNominatedToday per player from LobbyUpdate', () => {
    const socket = createFakeSocket();
    const { result } = renderHook(() => useSession(socket));

    act(() =>
      socket.fire(ServerEvents.LobbyUpdate, {
        players: [
          { playerId: 'p0', displayName: 'Alice', connected: true, alive: true, seatIndex: 0, hasNominatedToday: true },
          { playerId: 'p1', displayName: 'Bob', connected: true, alive: true, seatIndex: 1, hasNominatedToday: false },
        ],
      })
    );

    expect(result.current.lobbyPlayers.find((p) => p.playerId === 'p0')?.hasNominatedToday).toBe(true);
    expect(result.current.lobbyPlayers.find((p) => p.playerId === 'p1')?.hasNominatedToday).toBe(false);
  });
});

describe('useSession night engine state', () => {
  it('sets nightRoster from NightRosterUpdate', () => {
    const socket = createFakeSocket();
    const { result } = renderHook(() => useSession(socket));

    act(() =>
      socket.fire(ServerEvents.NightRosterUpdate, {
        isFirstNight: true,
        steps: [{ playerId: 'p0', characterId: 'poisoner', characterName: 'Poisoner', automationClass: 'assisted', done: false, current: true }],
      })
    );

    expect(result.current.nightRoster?.isFirstNight).toBe(true);
    expect(result.current.nightRoster?.steps).toHaveLength(1);
  });

  it('sets nightPrompt from NightPrompt, and clears it once NightInfoResult arrives', () => {
    const socket = createFakeSocket();
    const { result } = renderHook(() => useSession(socket));

    act(() =>
      socket.fire(ServerEvents.NightPrompt, {
        characterId: 'monk',
        characterName: 'Monk',
        prompt: 'Choose a player to protect.',
        targetCount: 1,
        eligibleTargetIds: ['p1', 'p2'],
      })
    );
    expect(result.current.nightPrompt?.characterId).toBe('monk');

    act(() => socket.fire(ServerEvents.NightInfoResult, { characterId: 'empath', text: '1 of your 2 neighbours is evil.' }));
    expect(result.current.nightPrompt).toBeNull();
    expect(result.current.nightInfoResult?.text).toBe('1 of your 2 neighbours is evil.');
  });

  it('clears nightRoster and nightPrompt when leaving the night phase, but not when staying in it', () => {
    const socket = createFakeSocket();
    const { result } = renderHook(() => useSession(socket));

    act(() =>
      socket.fire(ServerEvents.NightRosterUpdate, { isFirstNight: true, steps: [] })
    );
    act(() =>
      socket.fire(ServerEvents.NightPrompt, {
        characterId: 'monk',
        characterName: 'Monk',
        prompt: 'Choose a player.',
        targetCount: 1,
        eligibleTargetIds: [],
      })
    );

    // Staying in night (e.g. a redundant phase-changed emit) must not wipe it.
    act(() => socket.fire(ServerEvents.GamePhaseChanged, { phase: 'night', dayNumber: 1, phaseEndsAt: null }));
    expect(result.current.nightRoster).not.toBeNull();
    expect(result.current.nightPrompt).not.toBeNull();

    act(() => socket.fire(ServerEvents.GamePhaseChanged, { phase: 'day', dayNumber: 2, phaseEndsAt: null }));
    expect(result.current.nightRoster).toBeNull();
    expect(result.current.nightPrompt).toBeNull();
  });

  it('sets discretionLog from DiscretionLogUpdate', () => {
    const socket = createFakeSocket();
    const { result } = renderHook(() => useSession(socket));

    act(() =>
      socket.fire(ServerEvents.DiscretionLogUpdate, {
        entries: [
          { kind: 'drunk-cover', playerId: 'p0', playerDisplayName: 'Alice', valueLabel: 'Chef', isOverride: false, at: 123 },
        ],
      })
    );

    expect(result.current.discretionLog).toHaveLength(1);
    expect(result.current.discretionLog[0]?.valueLabel).toBe('Chef');
  });
});
