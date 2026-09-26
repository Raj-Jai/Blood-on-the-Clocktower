import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { EMPTY_FLOW_STATE, ServerEvents, type FlowState } from '@clocktower/shared';
import { TurnGuide } from './TurnGuide.js';

function flow(overrides: Partial<FlowState> = {}): FlowState {
  return { ...EMPTY_FLOW_STATE, ...overrides };
}

function renderGuide(flowState: FlowState, ctx: Record<string, unknown> = {}, hasOpenNightPrompt = false) {
  const onToggleSpeech = vi.fn();
  const view = render(
    <TurnGuide
      socket={null}
      flow={flowState}
      context={{
        playerId: 'p0',
        alive: true,
        hasOpenNightPrompt,
        hasSubmittedNightChoice: false,
        isEvil: false,
        ...ctx,
      }}
      hasOpenNightPrompt={hasOpenNightPrompt}
      speechEnabled={false}
      onToggleSpeech={onToggleSpeech}
      speechSupported={false}
      hostIsAnnouncing={false}
    />
  );
  return { onToggleSpeech, ...view };
}

describe('TurnGuide', () => {
  it('tells a woken player what to do, with a jump to their prompt', () => {
    const state = flow({
      stage: 'night-step',
      phase: 'night',
      nightNumber: 2,
      activePlayerId: 'p0',
      activePlayerName: 'Player0',
      needsChoiceFromPlayerId: 'p0',
      needsChoiceFromName: 'Player0',
    });
    renderGuide(state, {}, true);
    expect(screen.getByRole('heading', { name: /you're awake/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /go to my prompt/i })).toBeInTheDocument();
    expect(screen.getByTestId('turn-guide')).toHaveAttribute('data-action', 'submit-night-choice');
  });

  it('tells everyone else to close their eyes and who they are waiting for', () => {
    const state = flow({
      stage: 'night-step',
      phase: 'night',
      nightNumber: 2,
      activePlayerId: 'p2',
      activePlayerName: 'Player2',
      needsChoiceFromPlayerId: 'p2',
      needsChoiceFromName: 'Player2',
    });
    renderGuide(state, { playerId: 'p0' });
    expect(screen.getByRole('heading', { name: /close your eyes/i })).toBeInTheDocument();
    expect(screen.getByText(/waiting for Player2/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /go to my prompt/i })).not.toBeInTheDocument();
  });

  it('shows the night number while asleep and the day number while talking', () => {
    const { unmount } = renderGuide(flow({ stage: 'night-briefing', phase: 'night', nightNumber: 3 }));
    expect(screen.getByText('Night 3')).toBeInTheDocument();
    unmount();
    renderGuide(flow({ stage: 'day-discussion', phase: 'day', dayNumber: 4, nightNumber: 3 }));
    expect(screen.getByText('Day 4')).toBeInTheDocument();
  });

  it('sends the table to the Grimoire at dawn', () => {
    renderGuide(flow({ stage: 'day-reveal', phase: 'day', dayNumber: 1 }));
    expect(screen.getByRole('heading', { name: /open your eyes/i })).toBeInTheDocument();
    expect(screen.getByText(/grimoire/i)).toBeInTheDocument();
  });

  it('sends living players to discuss and dead players to listen', () => {
    const { unmount } = renderGuide(flow({ stage: 'day-discussion', phase: 'day', dayNumber: 2 }));
    expect(screen.getByRole('button', { name: /town square/i })).toBeInTheDocument();
    unmount();
    renderGuide(flow({ stage: 'day-discussion', phase: 'day', dayNumber: 2 }), { alive: false });
    expect(screen.getByRole('heading', { name: /you are dead/i })).toBeInTheDocument();
  });

  it('points an Evil player at their private chat without saying who is Evil', () => {
    renderGuide(flow({ stage: 'day-discussion', phase: 'day', dayNumber: 2 }), { isEvil: true });
    expect(screen.getByText(/evil chat/i)).toBeInTheDocument();
  });

  it('sends players to vote when a vote is open', () => {
    renderGuide(flow({ stage: 'day-voting', phase: 'day', dayNumber: 2, votingOpen: true }));
    expect(screen.getByRole('heading', { name: /vote/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /go and vote/i })).toBeInTheDocument();
  });

  it('tells a player to wait before the game starts', () => {
    renderGuide(EMPTY_FLOW_STATE);
    expect(screen.getByRole('heading', { name: /wait for the storyteller/i })).toBeInTheDocument();
  });

  it('tells the table the game is over', () => {
    renderGuide(flow({ stage: 'ended', phase: 'ended' }));
    expect(screen.getByRole('heading', { name: /game is over/i })).toBeInTheDocument();
  });

  it('emits a tab hint rather than owning the tab, so the page stays in charge', () => {
    const handler = vi.fn();
    window.addEventListener('botc:goto-tab', handler);
    renderGuide(flow({ stage: 'day-voting', phase: 'day', dayNumber: 2, votingOpen: true }));
    fireEvent.click(screen.getByRole('button', { name: /go and vote/i }));
    expect(handler).toHaveBeenCalled();
    const event = handler.mock.calls[0]![0] as CustomEvent<string>;
    expect(event.detail).toBe('town');
    window.removeEventListener('botc:goto-tab', handler);
  });

  it('is NOT a live region, so nothing is double-announced on every device', () => {
    const { container } = renderGuide(flow({ stage: 'night-step', phase: 'night', nightNumber: 1 }));
    expect(container.querySelector('[aria-live]')).toBeNull();
  });

  it('mentions the host announcer without enabling anything itself', () => {
    render(
      <TurnGuide
        socket={null}
        flow={flow({ stage: 'night-step', phase: 'night', nightNumber: 1 })}
        context={{
          playerId: 'p1',
          alive: true,
          hasOpenNightPrompt: false,
          hasSubmittedNightChoice: false,
          isEvil: false,
        }}
        hasOpenNightPrompt={false}
        speechEnabled={false}
        onToggleSpeech={vi.fn()}
        speechSupported={false}
        hostIsAnnouncing
      />
    );
    expect(screen.getByText(/reading the table instructions aloud/i)).toBeInTheDocument();
  });

  it('offers private-information speech as a separate, explicit opt-in', () => {
    const onToggleSpeech = vi.fn();
    render(
      <TurnGuide
        socket={null}
        flow={flow({ stage: 'day-reveal', phase: 'day', dayNumber: 1 })}
        context={{
          playerId: 'p0',
          alive: true,
          hasOpenNightPrompt: false,
          hasSubmittedNightChoice: false,
          isEvil: false,
        }}
        hasOpenNightPrompt={false}
        speechEnabled={false}
        onToggleSpeech={onToggleSpeech}
        speechSupported
        hostIsAnnouncing={false}
      />
    );
    const toggle = screen.getByRole('checkbox', { name: /read my own information aloud/i });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    expect(onToggleSpeech).toHaveBeenCalledWith(true);
  });

  it('exposes the stage as data for styling and for tests', () => {
    renderGuide(flow({ stage: 'night-briefing', phase: 'night', nightNumber: 1 }));
    expect(screen.getByTestId('turn-guide')).toHaveAttribute('data-stage', 'night-briefing');
    expect(ServerEvents.FlowUpdate).toBe('flow:update');
  });
});
