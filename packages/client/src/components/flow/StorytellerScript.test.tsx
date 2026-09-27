import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { FlowState } from '@clocktower/shared';
import { StorytellerScript } from './StorytellerScript';

const silentAnnouncer = {
  enabled: false,
  setEnabled: vi.fn(),
  announce: vi.fn(),
  repeat: vi.fn(),
  supported: false,
};

function flow(over: Partial<FlowState> = {}): FlowState {
  return {
    dayNumber: 0,
    nightNumber: 1,
    now: 0,
    nominationId: null,
    votingOpen: false,
    executionPending: false,
    stage: 'night-step',
    phase: 'night',
    wakeBlockedUntil: null,
    closingPlayerName: null,
    delaySeconds: 5,
    unmakeableSteps: [],
    announcement: 'Ada, wake up.',
    activePlayerId: 'p1',
    activePlayerName: 'Ada',
    needsChoiceFromPlayerId: null,
    needsChoiceFromName: null,
    stepNumber: 1,
    totalSteps: 3,
    resolvedCount: 0,
    readyToResolve: false,
    executedPlayerName: null,
    ...over,
  } as FlowState;
}

function renderScript(f: FlowState) {
  const socket = { emit: vi.fn() } as unknown as Parameters<typeof StorytellerScript>[0]['socket'];
  render(
    <StorytellerScript
      socket={socket}
      flow={f}
      announcer={silentAnnouncer}
      nightResolved={false}
      readyToResolve={f.readyToResolve}
      outstanding={[]}
    />
  );
  return socket;
}

describe('StorytellerScript', () => {
  it('offers a way to move on when the waker has nothing to choose', () => {
    // REGRESSION, found by playing a real game: the Chef, the Empath, the
    // Undertaker and any learn-in character with nobody to learn about never show
    // a picker, so no player window ever submits. The flow just waits on the
    // Storyteller. This panel said nothing at all at that moment — its only forward
    // control was "Resolve the night", which skips the rest of the night — so a
    // table with an auto-resolving character in the middle had no way to continue.
    const socket = renderScript(flow());
    const button = screen.getByTestId('deal-with-waker');
    expect(button).toBeTruthy();
    expect(button.textContent).toContain('Ada');
    fireEvent.click(button);
    expect((socket as unknown as { emit: ReturnType<typeof vi.fn> }).emit).toHaveBeenCalledWith(
      'storyteller:advanceNight',
      { action: 'next' }
    );
  });

  it('does not offer it while the pause between wakers is running', () => {
    // During the pause the next name is not due yet, and offering "next waker"
    // would invite the Storyteller to run the walk early.
    renderScript(flow({ wakeBlockedUntil: 1234 }));
    expect(screen.queryByTestId('deal-with-waker')).toBeNull();
    expect(screen.getByTestId('wake-countdown')).toBeTruthy();
  });

  it('does not offer it while a player still owes a choice', () => {
    // The server would refuse the walk anyway, and a "move on" button sitting next
    // to a "Waiting on: Cleo" warning is a button that does nothing.
    renderScript(flow({ needsChoiceFromName: 'Cleo', needsChoiceFromPlayerId: 'p2' }));
    expect(screen.queryByTestId('deal-with-waker')).toBeNull();
  });

  it('does not offer it once the night is ready to resolve', () => {
    // Resolving is the only meaningful action then, and two competing primary
    // buttons at the same moment is how the wrong one gets clicked.
    renderScript(flow({ readyToResolve: true }));
    expect(screen.queryByTestId('deal-with-waker')).toBeNull();
    expect(screen.getByRole('button', { name: /resolve the night/i })).toBeTruthy();
  });

  it('does not offer it before the briefing line has been said', () => {
    renderScript(flow({ stage: 'night-briefing', activePlayerName: null }));
    expect(screen.queryByTestId('deal-with-waker')).toBeNull();
  });
});
