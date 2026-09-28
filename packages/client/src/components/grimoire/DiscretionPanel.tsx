import { useState } from 'react';
import { TROUBLE_BREWING_CHARACTERS, type DiscretionLogEntryView, type GrimoirePlayerEntry } from '@clocktower/shared';

interface DiscretionPanelProps {
  log: DiscretionLogEntryView[];
  grimoire: GrimoirePlayerEntry[];
  onOverride: (kind: 'drunk-cover' | 'fortune-teller-red-herring', playerId: string, value: string) => void;
}

const TOWNSFOLK = TROUBLE_BREWING_CHARACTERS.filter((c) => c.type === 'townsfolk');

/**
 * Surfaces the choices the rules deliberately leave to human judgment
 * (Drunk's cover character, Fortune Teller's red herring) as visible,
 * auditable defaults the Storyteller can override -- rather than a black
 * box. Every default and override appears in the log below, timestamped.
 */
export function DiscretionPanel({ log, grimoire, onOverride }: DiscretionPanelProps) {
  const drunkPlayer = grimoire.find((g) => g.character === 'drunk');
  const fortuneTellerPlayer = grimoire.find((g) => g.character === 'fortune-teller');
  const [drunkCoverChoice, setDrunkCoverChoice] = useState('');
  const [redHerringChoice, setRedHerringChoice] = useState('');

  if (!drunkPlayer && !fortuneTellerPlayer && log.length === 0) {
    return null;
  }

  return (
    <div className="panel">
      <h3 style={{ marginTop: 0 }}>Storyteller Discretion</h3>
      <p className="faint" style={{ marginTop: -8, marginBottom: 12 }}>
        The rules deliberately leave these to your judgment. A default was chosen automatically -- override it
        whenever you want.
      </p>

      {drunkPlayer && (
        <div style={{ marginBottom: 12 }}>
          <p style={{ margin: '0 0 6px' }}>
            <strong>{drunkPlayer.displayName}</strong> is the Drunk, currently shown as{' '}
            <strong>
              {log
                .filter((e) => e.kind === 'drunk-cover' && e.playerId === drunkPlayer.playerId)
                .slice(-1)[0]?.valueLabel ?? '—'}
            </strong>
            .
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <select className="input" value={drunkCoverChoice} onChange={(e) => setDrunkCoverChoice(e.target.value)}>
              <option value="">Change their cover character…</option>
              {TOWNSFOLK.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <button
              className="btn btn-inline"
              disabled={!drunkCoverChoice}
              onClick={() => {
                onOverride('drunk-cover', drunkPlayer.playerId, drunkCoverChoice);
                setDrunkCoverChoice('');
              }}
            >
              Set
            </button>
          </div>
        </div>
      )}

      {fortuneTellerPlayer && (
        <div style={{ marginBottom: 12 }}>
          <p style={{ margin: '0 0 6px' }}>
            <strong>{fortuneTellerPlayer.displayName}</strong> is the Fortune Teller. Their red herring is set once
            and should stay consistent for the game.
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <select className="input" value={redHerringChoice} onChange={(e) => setRedHerringChoice(e.target.value)}>
              <option value="">Change their red herring…</option>
              {grimoire
                .filter((g) => g.alignment === 'good' && g.playerId !== fortuneTellerPlayer.playerId)
                .map((g) => (
                  <option key={g.playerId} value={g.playerId}>
                    {g.displayName}
                  </option>
                ))}
            </select>
            <button
              className="btn btn-inline"
              disabled={!redHerringChoice}
              onClick={() => {
                onOverride('fortune-teller-red-herring', fortuneTellerPlayer.playerId, redHerringChoice);
                setRedHerringChoice('');
              }}
            >
              Set
            </button>
          </div>
        </div>
      )}

      {log.length > 0 && (
        <details>
          <summary className="faint" style={{ cursor: 'pointer' }}>
            Audit log ({log.length})
          </summary>
          <ul style={{ paddingLeft: 20, fontSize: 13 }}>
            {log
              .slice()
              .reverse()
              .map((entry, i) => (
                <li key={i} className="faint">
                  {new Date(entry.at).toLocaleTimeString()} — {entry.playerDisplayName}:{' '}
                  {entry.kind === 'drunk-cover' ? 'Drunk cover' : 'Red herring'} → {entry.valueLabel}
                  {entry.isOverride ? ' (override)' : ' (default)'}
                </li>
              ))}
          </ul>
        </details>
      )}
    </div>
  );
}
