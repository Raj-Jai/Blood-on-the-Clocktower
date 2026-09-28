import { useState } from 'react';
import type { NightPromptPayload } from '@clocktower/shared';
import type { LobbyPlayer } from '../../hooks/useSession.js';

interface NightActionPromptProps {
  prompt: NightPromptPayload;
  players: LobbyPlayer[];
  selfPlayerId: string;
  onSubmit: (targetPlayerIds: string[]) => void;
}

function nameFor(players: LobbyPlayer[], id: string): string {
  return players.find((p) => p.playerId === id)?.displayName ?? 'Unknown';
}

/**
 * Replaces the verbal "wake up, choose a player" ritual with an in-app
 * prompt + target picker for 'assisted'-class night actions (Monk,
 * Ravenkeeper, Butler, Poisoner, Imp). Shown as a full-screen modal so it
 * can't be missed, same rationale as the execution/game-ended banners.
 */
export function NightActionPrompt({ prompt, players, selfPlayerId, onSubmit }: NightActionPromptProps) {
  const [selected, setSelected] = useState<string[]>([]);
  const [submitted, setSubmitted] = useState(false);
  const candidates = players.filter((p) => prompt.eligibleTargetIds.includes(p.playerId));

  function toggle(playerId: string) {
    if (selected.includes(playerId)) {
      setSelected(selected.filter((id) => id !== playerId));
    } else if (selected.length < prompt.targetCount) {
      setSelected([...selected, playerId]);
    }
  }

  function submit() {
    setSubmitted(true);
    onSubmit(selected);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(5,5,8,0.92)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 600,
        padding: 16,
      }}
    >
      <div className="panel modal-panel" style={{ maxWidth: 400, borderColor: 'var(--accent-gold-bright)' }}>
        <h2 style={{ marginTop: 0, textAlign: 'center' }}>🌙 {prompt.characterName}</h2>
        <p style={{ textAlign: 'center' }}>{prompt.prompt}</p>

        {submitted ? (
          <p className="faint" style={{ textAlign: 'center' }}>
            Choice submitted. Waiting for the Storyteller…
          </p>
        ) : prompt.targetCount === 0 ? (
          <button className="btn btn-primary" style={{ width: '100%' }} onClick={submit}>
            Acknowledge
          </button>
        ) : (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
              {candidates.map((p) => (
                <label
                  key={p.playerId}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '8px 12px',
                    borderRadius: 8,
                    background: selected.includes(p.playerId) ? 'var(--good-blue-bg)' : 'transparent',
                    border: '1px solid var(--border-subtle)',
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type={prompt.targetCount === 1 ? 'radio' : 'checkbox'}
                    checked={selected.includes(p.playerId)}
                    onChange={() => toggle(p.playerId)}
                  />
                  {p.displayName} {p.playerId === selfPlayerId && <span className="faint">(you)</span>}
                </label>
              ))}
            </div>
            <button
              className="btn btn-primary"
              style={{ width: '100%' }}
              disabled={selected.length !== prompt.targetCount}
              onClick={submit}
            >
              Confirm {selected.map((id) => nameFor(players, id)).join(' & ') || `Choose ${prompt.targetCount}`}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
