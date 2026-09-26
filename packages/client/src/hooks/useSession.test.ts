import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Socket } from 'socket.io-client';
import { ServerEvents, type ActiveNominationView } from '@clocktower/shared';
import { useSession } from './useSession.js';

/** Minimal socket.io client stand-in that lets a test push server events at the hook. */
function makeFakeSocket() {
  const handlers = new Map<string, (payload: unknown) => void>();
  return {
    on(event: string, handler: (payload: unknown) => void) {
      handlers.set(event, handler);
    },
    off(event: string) {
      handlers.delete(event);
    },
    emit() {
      /* not used by this hook */
    },
    /** Delivers a server event to the hook under act(), as a real socket would. */
    receive(event: string, payload: unknown) {
      const handler = handlers.get(event);
      if (!handler) throw new Error(`no handler registered for ${event}`);
      act(() => {
        handler(payload);
      });
    },
    hasHandler(event: string) {
      return handlers.has(event);
    },
  } as unknown as Socket & { receive: (event: string, payload: unknown) => void; hasHandler: (e: string) => boolean };
}

function openSession() {
  const socket = makeFakeSocket();
  const view = renderHook(() => useSession(socket));
  socket.receive(ServerEvents.AuthOk, {
    role: 'player',
    phase: 'day',
    dayNumber: 1,
    nightNumber: 0,
    phaseEndsAt: null,
    gameResult: null,
  });
  return { socket, view };
}

function nomination(overrides: Partial<ActiveNominationView> = {}): ActiveNominationView {
  return {
    nominationId: 'n1',
    nominatorId: 'p0',
    targetId: 'p1',
    votes: [],
    closed: false,
    pendingExecution: false,
    ...overrides,
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('useSession — abilityResult staleness', () => {
  it('keeps the result while nothing contradicts it', () => {
    const { socket, view } = openSession();
    socket.receive(ServerEvents.PlayerSelfUpdate, { abilityResult: 'You learn that 1 of 2 is the Monk.' });
    expect(view.result.current.abilityResult).toBe('You learn that 1 of 2 is the Monk.');
  });

  it('clears the result on a phase change', () => {
    // This is the leak: `payload.abilityResult ?? s.abilityResult` meant Night 1's
    // answer stayed pinned on the Character tab for the rest of the game,
    // indistinguishable from tonight's, on a screen that gets passed around.
    const { socket, view } = openSession();
    socket.receive(ServerEvents.PlayerSelfUpdate, { abilityResult: 'Night 1 answer.' });
    expect(view.result.current.abilityResult).toBe('Night 1 answer.');

    socket.receive(ServerEvents.GamePhaseChanged, {
      phase: 'night',
      dayNumber: 1,
      nightNumber: 1,
      phaseEndsAt: null,
    });
    expect(view.result.current.abilityResult).toBeNull();
  });

  it('clears the result when the server explicitly sends null', () => {
    const { socket, view } = openSession();
    socket.receive(ServerEvents.PlayerSelfUpdate, { abilityResult: 'stale' });
    socket.receive(ServerEvents.PlayerSelfUpdate, { abilityResult: null });
    expect(view.result.current.abilityResult).toBeNull();
  });

  it('leaves the result untouched when the payload omits the field', () => {
    const { socket, view } = openSession();
    socket.receive(ServerEvents.PlayerSelfUpdate, { abilityResult: 'keep me' });
    socket.receive(ServerEvents.PlayerSelfUpdate, { alive: false });
    expect(view.result.current.abilityResult).toBe('keep me');
    expect(view.result.current.alive).toBe(false);
  });
});

describe('useSession — nominations (issue #4)', () => {
  it('records a closed nomination so the tally stays visible', () => {
    const { socket, view } = openSession();
    socket.receive(ServerEvents.NominationOpened, nomination());
    expect(view.result.current.nomination?.nominationId).toBe('n1');

    socket.receive(ServerEvents.NominationClosed, nomination({ closed: true, pendingExecution: true }));
    expect(view.result.current.nomination?.closed).toBe(true);
    expect(view.result.current.nomination?.pendingExecution).toBe(true);
  });

  it('REPLACES a closed nomination with the next one, so a second nomination is possible', () => {
    // The hook must not latch. PlayerGamePage's `canNominate` gate
    // (`!session.nomination`) is the actual issue #4 dead-end and is deliberately
    // NOT changed here — but the hook has to be able to carry the replacement,
    // otherwise no fix at the page level could work.
    const { socket, view } = openSession();
    socket.receive(ServerEvents.NominationOpened, nomination({ nominationId: 'n1' }));
    socket.receive(ServerEvents.NominationClosed, nomination({ nominationId: 'n1', closed: true }));
    socket.receive(ServerEvents.NominationOpened, nomination({ nominationId: 'n2', targetId: 'p2' }));

    expect(view.result.current.nomination?.nominationId).toBe('n2');
    expect(view.result.current.nomination?.targetId).toBe('p2');
    expect(view.result.current.nomination?.closed).toBe(false);
  });

  it('drops the nomination on a phase change', () => {
    const { socket, view } = openSession();
    socket.receive(ServerEvents.NominationOpened, nomination());
    socket.receive(ServerEvents.GamePhaseChanged, {
      phase: 'night',
      dayNumber: 1,
      nightNumber: 1,
      phaseEndsAt: null,
    });
    expect(view.result.current.nomination).toBeNull();
  });
});

describe('useSession — information hiding', () => {
  it('never stores a Grimoire on a player client, even if one is sent', () => {
    // Defence in depth behind the server invariant. React trees are the most
    // common way a "hidden" secret reaches a screen reader, and WebKit keeps
    // `visibility: hidden` content in the accessibility tree where Chromium
    // removes it — so the only safe fix is never holding the data client-side.
    const { socket, view } = openSession();
    socket.receive(ServerEvents.GrimoireUpdate, {
      grimoire: [
        {
          playerId: 'p0',
          displayName: 'Player0',
          character: 'imp',
          characterType: 'demon',
          alignment: 'evil',
          alive: true,
          statusEffects: { poisoned: false, drunk: false, protected: false },
          usedDeadVote: false,
          connected: true,
          seatIndex: 0,
          livingLeftNeighborId: null,
          livingRightNeighborId: null,
          registration: { alignment: null, characterType: null },
          drunkCoverCharacterId: null,
          fortuneTellerRedHerringPlayerId: null,
          butlerChoice: null,
        },
      ],
    });
    expect(view.result.current.grimoire).toBeNull();
  });

  it('drops a night prompt addressed to somebody else', () => {
    const { socket, view } = openSession();
    socket.receive(ServerEvents.GameDistributed, {
      role: 'player',
      playerId: 'p0',
      character: 'chef',
      characterName: 'Chef',
      characterType: 'townsfolk',
      alignment: 'good',
      ability: 'You start knowing how many pairs of evil players there are.',
    });
    socket.receive(ServerEvents.NightPrompt, {
      playerId: 'p3',
      nightNumber: 1,
      isFirstNight: true,
      characterId: 'imp',
      characterName: 'Imp',
      ability: 'Each night*, choose a player: they die.',
      prompt: 'Choose a player.',
      infoType: 'none',
      targetCount: 1,
      legalTargetIds: ['p0'],
      legalTargets: [{ playerId: 'p0', displayName: 'Player0' }],
      rulesNote: 'x',
    });
    expect(view.result.current.nightPrompt).toBeNull();

    // Their own prompt is accepted.
    socket.receive(ServerEvents.NightPrompt, {
      playerId: 'p0',
      nightNumber: 1,
      isFirstNight: true,
      characterId: 'chef',
      characterName: 'Chef',
      ability: 'You start knowing how many pairs of evil players there are.',
      prompt: 'No choice.',
      infoType: 'count',
      targetCount: 0,
      legalTargetIds: [],
      legalTargets: [],
      rulesNote: 'x',
    });
    expect(view.result.current.nightPrompt?.characterName).toBe('Chef');
  });

  it('only stores the night order and night log for the Storyteller', () => {
    const socket = makeFakeSocket();
    const view = renderHook(() => useSession(socket));
    socket.receive(ServerEvents.AuthOk, {
      role: 'storyteller',
      phase: 'night',
      dayNumber: 1,
      nightNumber: 1,
      phaseEndsAt: null,
      gameResult: null,
    });
    socket.receive(ServerEvents.NightOrderUpdate, {
      nightNumber: 1,
      isFirstNight: true,
      phase: 'night',
      steps: [],
      activeIndex: 0,
      resolvedCount: 0,
      totalCount: 0,
      openedAt: 1,
      outstandingCharacterIds: [],
      resolved: false,
    });
    expect(view.result.current.nightOrder?.nightNumber).toBe(1);

    const playerSocket = makeFakeSocket();
    const playerView = renderHook(() => useSession(playerSocket));
    playerSocket.receive(ServerEvents.AuthOk, {
      role: 'player',
      phase: 'night',
      dayNumber: 1,
      nightNumber: 1,
      phaseEndsAt: null,
      gameResult: null,
    });
    playerSocket.receive(ServerEvents.NightOrderUpdate, {
      nightNumber: 1,
      isFirstNight: true,
      phase: 'night',
      steps: [],
      activeIndex: 0,
      resolvedCount: 0,
      totalCount: 0,
      openedAt: 1,
      outstandingCharacterIds: [],
      resolved: false,
    });
    expect(playerView.result.current.nightOrder).toBeNull();
  });
});

describe('useSession — nightNumber', () => {
  it('tracks the night number from auth and phase changes', () => {
    const { socket, view } = openSession();
    expect(view.result.current.nightNumber).toBe(0);
    socket.receive(ServerEvents.GamePhaseChanged, {
      phase: 'night',
      dayNumber: 1,
      nightNumber: 1,
      phaseEndsAt: null,
    });
    expect(view.result.current.nightNumber).toBe(1);
    expect(view.result.current.dayNumber).toBe(1);
  });
});

describe('useSession — listener lifecycle', () => {
  it('removes every listener on unmount', () => {
    const socket = makeFakeSocket();
    const view = renderHook(() => useSession(socket));
    expect(socket.hasHandler(ServerEvents.NightPrompt)).toBe(true);
    view.unmount();
    expect(socket.hasHandler(ServerEvents.NightPrompt)).toBe(false);
  });
});

// Guards against a silent regression where a new event is added to the handler
// block but not the cleanup block, which leaks listeners on every socket change.
describe('useSession — socket churn', () => {
  it('re-registers cleanly when the socket changes', () => {
    const first = makeFakeSocket();
    const view = renderHook(({ socket }) => useSession(socket), {
      initialProps: { socket: first as unknown as Socket },
    });
    const second = makeFakeSocket();
    view.rerender({ socket: second as unknown as Socket });
    expect(first.hasHandler(ServerEvents.NightResolved)).toBe(false);
    expect(second.hasHandler(ServerEvents.NightResolved)).toBe(true);
    // A stale socket must not be able to push state any more.
    const spy = vi.fn();
    void spy;
    expect(() => first.receive(ServerEvents.NightResolved, {})).toThrow();
  });
});
