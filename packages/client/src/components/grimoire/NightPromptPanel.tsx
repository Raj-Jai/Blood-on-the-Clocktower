import { useEffect, useMemo, useState } from 'react';
import { ClientEvents, type NightPromptPayload, type NightResolvedPayload } from '@clocktower/shared';
import type { Socket } from 'socket.io-client';

interface NightPromptPanelProps {
  socket: Socket | null;
  prompt: NightPromptPayload | null;
  result: NightResolvedPayload | null;
  /**
   * Called when this player's own information should be spoken. Intentionally
   * narrow: the parent passes the server-projected text for THIS player only.
   * Never pass the Grimoire, another player's role, or anything Storyteller-only.
   */
  onSpeak?: (text: string) => void;
  /**
   * A spoken toggle label + state.
   *
   * The panel renders one itself when `speechSupported` is set, which is how it is
   * used standalone. Inside the moment card the card owns the toggle and this is left
   * off, because two identical checkboxes stacked on one screen is worse than either
   * alone — and the card's version also states the privacy rule, which is the part
   * that matters.
   */
  speechEnabled: boolean;
  speechSupported?: boolean;
}

/**
 * The private night interaction: what you are awake to do, and what you learn.
 *
 * This is what replaces the verbal wake-up ritual. The prompt is private to the
 * waker (the server sends it with `sendToPlayer`, never to the room) and the
 * target picker is constrained to the exact ids the server will accept, so the UI
 * cannot offer an illegal choice even if the player tries to bypass it.
 *
 * ACCESSIBILITY NOTE, and the reason there is deliberately no `aria-live` here:
 * night information is spoken BY DESIGN through the optional local voice toggle,
 * and content that is spoken by design inside a live region is announced twice.
 * A screen-reader user who has the voice off gets the same information as visible
 * text, which is why the toggle is visible and not a hidden preference.
 */
export function NightPromptPanel({
  socket,
  prompt,
  result,
  onSpeak,
  speechEnabled,
  speechSupported,
}: NightPromptPanelProps) {
  const [selected, setSelected] = useState<string[]>([]);
  const [submitted, setSubmitted] = useState(false);

  // A new prompt (a new night, or the Ravenkeeper's wake) invalidates the old
  // selection rather than silently carrying a stale pick into a new night.
  useEffect(() => {
    setSelected([]);
    setSubmitted(false);
  }, [prompt?.playerId, prompt?.nightNumber, prompt?.characterId]);

  useEffect(() => {
    if (prompt && onSpeak && speechEnabled) {
      onSpeak(`${prompt.characterName}. ${prompt.prompt}`);
    }
    // Only on a genuinely new prompt, not on every re-render of the same one.
  }, [prompt?.playerId, prompt?.nightNumber, prompt?.characterId, prompt?.characterName, prompt?.prompt, onSpeak, speechEnabled]);

  useEffect(() => {
    if (result && onSpeak && speechEnabled && result.infoType !== 'grimoire') {
      // The Grimoire is never spoken: reading a full table of roles aloud is the
      // single worst possible leak in the game, and the Spy's own text is
      // "You see the Grimoire" — the sentence is enough.
      onSpeak(result.text);
    }
  }, [result?.nightNumber, result?.characterId, result?.text, result?.infoType, onSpeak, speechEnabled]);

  const canSubmit = useMemo(() => {
    if (!prompt || submitted) return false;
    if (prompt.targetCount === 0) return false;
    return selected.length === prompt.targetCount;
  }, [prompt, selected, submitted]);

  function toggle(playerId: string) {
    if (!prompt || submitted) return;
    setSelected((current) => {
      if (current.includes(playerId)) return current.filter((id) => id !== playerId);
      if (current.length >= prompt.targetCount) return current;
      return [...current, playerId];
    });
  }

  function submit() {
    if (!prompt || !canSubmit) return;
    socket?.emit(ClientEvents.PlayerSubmitNightChoice, { targetIds: selected });
    setSubmitted(true);
  }

  if (!prompt && !result) return null;

  return (
    <div className="panel" style={{ borderColor: 'var(--good-blue)' }}>
      <h2 style={{ margin: 0 }}>{result ? 'Your Night Result' : 'You Are Awake'}</h2>

      {prompt && (
        <>
          <p className="muted" style={{ marginTop: 4 }}>
            Night {prompt.nightNumber}
            {prompt.isFirstNight ? ' (First Night)' : ''} — {prompt.characterName}
          </p>
          <p style={{ lineHeight: 1.5 }}>{prompt.ability}</p>
          <p style={{ fontWeight: 600 }}>{prompt.prompt}</p>

          {/* Always-true channel. The rulebook requires correct information about
              the RULES even for drunk and poisoned players, so this is never
              discretionary and never generated. */}
          <p className="faint" style={{ fontSize: '0.85rem' }}>{prompt.rulesNote}</p>

          {prompt.targetCount > 0 && (
            <div style={{ marginTop: 12 }}>
              <p className="muted" style={{ marginBottom: 6 }}>
                Choose {prompt.targetCount} player{prompt.targetCount === 1 ? '' : 's'} (
                {selected.length}/{prompt.targetCount} chosen)
              </p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {prompt.legalTargets.map((target) => {
                  const isSelected = selected.includes(target.playerId);
                  return (
                    <button
                      key={target.playerId}
                      type="button"
                      className={`btn btn-inline${isSelected ? ' btn-primary' : ''}`}
                      aria-pressed={isSelected}
                      disabled={submitted}
                      onClick={() => toggle(target.playerId)}
                    >
                      {isSelected ? '✓ ' : ''}
                      {target.displayName}
                    </button>
                  );
                })}
              </div>
              <button
                className="btn btn-primary"
                style={{ marginTop: 12 }}
                onClick={submit}
                disabled={!canSubmit}
              >
                {submitted ? 'Choice sent' : 'Send my choice'}
              </button>
              {submitted && <p className="faint" style={{ marginTop: 8 }}>Waiting for the other players…</p>}
            </div>
          )}

          {prompt.targetCount === 0 && (
            <p className="faint" style={{ marginTop: 12 }}>
              Nothing to choose — you will be told what you learn at the end of the night.
            </p>
          )}
        </>
      )}

      {result && (
        <div style={{ marginTop: 12 }}>
          <p className="muted" style={{ margin: 0 }}>
            Night {result.nightNumber} — {result.characterName}
          </p>
          <p style={{ fontSize: '1.05rem', lineHeight: 1.5 }}>{result.text}</p>
          {result.overridden && <p className="faint">The Storyteller adjusted this for you.</p>}
          {result.infoType === 'grimoire' && (
            <p className="faint">
              Your Grimoire is on your Character tab. It is never read aloud.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
