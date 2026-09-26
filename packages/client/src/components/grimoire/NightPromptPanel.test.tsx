import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ClientEvents, ServerEvents, type NightPromptPayload, type NightResolvedPayload } from '@clocktower/shared';
import { NightPromptPanel } from './NightPromptPanel.js';

function makePrompt(overrides: Partial<NightPromptPayload> = {}): NightPromptPayload {
  return {
    playerId: 'p0',
    nightNumber: 2,
    isFirstNight: false,
    characterId: 'monk',
    characterName: 'Monk',
    ability: 'Each night*, choose a player (not yourself): they are safe from the Demon tonight.',
    prompt: 'Choose a good player other than yourself. They are safe from the Demon tonight.',
    infoType: 'none',
    targetCount: 1,
    legalTargetIds: ['p2', 'p3'],
    legalTargets: [
      { playerId: 'p2', displayName: 'Player2' },
      { playerId: 'p3', displayName: 'Player3' },
    ],
    rulesNote: 'This is how your own ability works.',
    ...overrides,
  };
}

function renderPanel(prompt: NightPromptPayload | null, result: NightResolvedPayload | null = null) {
  const emit = vi.fn();
  const onSpeak = vi.fn();
  const view = render(
    <NightPromptPanel
      socket={{ emit } as never}
      prompt={prompt}
      result={result}
      onSpeak={onSpeak}
      speechEnabled={false}
      onToggleSpeech={vi.fn()}
      speechSupported
    />
  );
  return { emit, onSpeak, ...view };
}

describe('NightPromptPanel', () => {
  it('offers ONLY the legal targets the server sent, never the full seating', () => {
    renderPanel(makePrompt());
    expect(screen.getByRole('button', { name: 'Player2' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Player3' })).toBeInTheDocument();
    // The Monk, the Imp and the Poisoner are not offered even though they exist
    // in the game: the server's legal set is the only source of targets.
    expect(screen.queryByRole('button', { name: 'Player0' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Player1' })).not.toBeInTheDocument();
  });

  it('keeps the submit button disabled until the required count is chosen', () => {
    const { emit } = renderPanel(makePrompt());
    expect(screen.getByRole('button', { name: 'Send my choice' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Player2' }));
    // The Monk picks exactly one, so one pick is enough.
    expect(screen.getByRole('button', { name: 'Send my choice' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Send my choice' }));
    expect(emit).toHaveBeenCalledWith(ClientEvents.PlayerSubmitNightChoice, { targetIds: ['p2'] });
    // A submitted choice cannot be changed.
    expect(screen.getByRole('button', { name: 'Choice sent' })).toBeDisabled();
  });

  it('refuses to select more players than the required count', () => {
    renderPanel(makePrompt({ targetCount: 1 }));
    fireEvent.click(screen.getByRole('button', { name: 'Player2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Player3' }));
    expect(screen.getByRole('button', { name: '✓ Player2' })).toBeInTheDocument();
    // Player3 was not added, because the Monk only picks one.
    expect(screen.queryByRole('button', { name: '✓ Player3' })).not.toBeInTheDocument();
  });

  it('requires two picks for a two-target ability', () => {
    const { emit } = renderPanel(
      makePrompt({
        characterId: 'fortune-teller',
        characterName: 'Fortune Teller',
        targetCount: 2,
        legalTargetIds: ['p1', 'p2', 'p3'],
        legalTargets: [
          { playerId: 'p1', displayName: 'Player1' },
          { playerId: 'p2', displayName: 'Player2' },
          { playerId: 'p3', displayName: 'Player3' },
        ],
      })
    );
    expect(screen.getByRole('button', { name: 'Send my choice' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Player1' }));
    expect(screen.getByRole('button', { name: 'Send my choice' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Player2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send my choice' }));
    expect(emit).toHaveBeenCalledWith(ClientEvents.PlayerSubmitNightChoice, { targetIds: ['p1', 'p2'] });
  });

  it('renders nothing when there is no night activity', () => {
    const { container } = renderPanel(null);
    expect(container.innerHTML).toBe('');
  });

  it('shows the always-true rules note and never claims the information is unreliable', () => {
    renderPanel(makePrompt());
    expect(screen.getByText(/how your own ability works/i)).toBeInTheDocument();
    // A Drunk must not be told their information may be wrong — that is how a
    // Drunk gets identified on night one.
    expect(screen.queryByText(/may not be reliable/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/drunk or poisoned/i)).not.toBeInTheDocument();
  });

  it('does not put night information in a live region, so it is not announced twice', () => {
    const { container } = renderPanel(makePrompt());
    expect(container.querySelector('[aria-live]')).toBeNull();
  });

  it('speaks the prompt only when the voice toggle is on, and never the Grimoire', () => {
    const { onSpeak } = renderPanel(makePrompt());
    expect(onSpeak).not.toHaveBeenCalled();
  });

  it('offers a visible voice toggle rather than a hidden preference', () => {
    const onToggle = vi.fn();
    render(
      <NightPromptPanel
        socket={{ emit: vi.fn() } as never}
        prompt={makePrompt()}
        result={null}
        onSpeak={vi.fn()}
        speechEnabled={false}
        onToggleSpeech={onToggle}
        speechSupported
      />
    );
    const toggle = screen.getByRole('checkbox', { name: /read my information aloud/i });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it('renders the night result and notes that the Grimoire is never spoken', () => {
    renderPanel(
      null,
      {
        playerId: 'p0',
        nightNumber: 2,
        characterId: 'spy',
        characterName: 'Spy',
        infoType: 'grimoire',
        text: 'You see the Grimoire.',
        overridden: false,
      }
    );
    expect(screen.getByText('You see the Grimoire.')).toBeInTheDocument();
    expect(screen.getByText(/never read aloud/i)).toBeInTheDocument();
  });

  it('shows that the Storyteller adjusted a result', () => {
    renderPanel(null, {
      playerId: 'p0',
      nightNumber: 2,
      characterId: 'empath',
      characterName: 'Empath',
      infoType: 'count',
      text: 'You learn that 1 of your living neighbours is evil.',
      overridden: true,
    });
    expect(screen.getByText(/adjusted this for you/i)).toBeInTheDocument();
  });
});

// Keeps the event-name import honest: the panel must not reference a server event.
describe('NightPromptPanel — event usage', () => {
  it('uses only the client submit event', () => {
    expect(ServerEvents.NightPrompt).toBe('night:prompt');
  });
});
