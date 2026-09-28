import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { FlowState, PlayerFlowContext } from '@clocktower/shared';
import { PlayerMomentCard } from './PlayerMomentCard';

const ADA = 'p-ada';

function flow(over: Partial<FlowState> = {}): FlowState {
  return {
    dayNumber: 0,
    nightNumber: 2,
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
    announcement: '',
    activePlayerId: null,
    activePlayerName: null,
    needsChoiceFromPlayerId: null,
    needsChoiceFromName: null,
    stepNumber: null,
    totalSteps: 4,
    resolvedCount: 0,
    readyToResolve: false,
    executedPlayerName: null,
    ...over,
  } as FlowState;
}

function ctx(over: Partial<PlayerFlowContext> = {}): PlayerFlowContext {
  return {
    playerId: ADA,
    displayName: 'Ada',
    alive: true,
    hasOpenNightPrompt: false,
    hasSubmittedNightChoice: false,
    stepIsUnmakeable: false,
    isEvil: false,
    hasNightResult: false,
    hasVoteToken: true,
    ...over,
  };
}

const speech = { speechEnabled: false, onToggleSpeech: vi.fn(), speechSupported: true, hostIsAnnouncing: false };

describe('PlayerMomentCard', () => {
  it('shows the one instruction and whatever control it was given', () => {
    render(
      <PlayerMomentCard
        flow={flow({ activePlayerId: ADA, needsChoiceFromPlayerId: ADA, needsChoiceFromName: 'Ada' })}
        context={ctx({ hasOpenNightPrompt: true })}
        action={<button>Send my choice</button>}
        {...speech}
      />
    );
    expect(screen.getByRole('heading', { name: /you're awake/i })).toBeTruthy();
    // The control is in view, not behind anything.
    expect(screen.getByRole('button', { name: 'Send my choice' })).toBeTruthy();
  });

  it('offers a visible voice toggle rather than a hidden preference', () => {
    // This moved here from NightPromptPanel, which used to render an identical
    // checkbox directly beneath this one.
    const onToggleSpeech = vi.fn();
    render(
      <PlayerMomentCard flow={flow()} context={ctx()} {...speech} onToggleSpeech={onToggleSpeech} />
    );
    const toggle = screen.getByRole('checkbox', { name: /read my own information aloud/i });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    expect(onToggleSpeech).toHaveBeenCalledWith(true);
  });

  it('states the privacy rule next to the voice toggle', () => {
    // The voice reads only your own information, never the table's. Saying so is the
    // difference between a feature and a leak waiting to happen.
    render(<PlayerMomentCard flow={flow()} context={ctx()} {...speech} />);
    expect(screen.getByText(/never the table/i)).toBeTruthy();
  });

  it('exposes the moment so a test can assert on it without reading prose', () => {
    const { container } = render(
      <PlayerMomentCard flow={flow({ stage: 'day-discussion', phase: 'day', dayNumber: 3 })} context={ctx()} {...speech} />
    );
    const card = container.querySelector('[data-testid="player-moment"]');
    expect(card?.getAttribute('data-moment')).toBe('discuss');
    expect(card?.getAttribute('data-action')).toBe('nominate');
  });

  it('hides the phase label before the game starts', () => {
    // "Night 0" is not a thing anybody needs to read.
    const { container } = render(
      <PlayerMomentCard flow={flow({ stage: 'setup', phase: 'lobby' })} context={ctx()} {...speech} />
    );
    expect(container.textContent).not.toMatch(/Night 0|Day 0/);
  });
});
