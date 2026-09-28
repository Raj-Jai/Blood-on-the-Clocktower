import { Fragment, useState } from 'react';
import type { CharacterType, GrimoirePlayerEntry } from '@clocktower/shared';
import { getCharacterById } from '@clocktower/shared';

interface GrimoireTableProps {
  grimoire: GrimoirePlayerEntry[];
  onToggleStatus: (playerId: string, key: 'poisoned' | 'drunk' | 'protected') => void;
  onMarkDead: (playerId: string) => void;
}

function characterName(id: string | null): string {
  if (!id) return '—';
  return getCharacterById(id)?.name ?? id;
}

function nameOf(grimoire: GrimoirePlayerEntry[], playerId: string | null): string {
  if (!playerId) return '—';
  return grimoire.find((g) => g.playerId === playerId)?.displayName ?? '—';
}

// Evil roles surfaced first (Demon, then Minion), then Good roles (Townsfolk, then
// Outsider), so the Storyteller can scan the threat before the town. Unassigned
// characters (pre-distribution) sort last.
const TYPE_ORDER: Record<CharacterType, number> = {
  demon: 0,
  minion: 1,
  townsfolk: 2,
  outsider: 3,
};

export function sortGrimoire(grimoire: GrimoirePlayerEntry[]): GrimoirePlayerEntry[] {
  return [...grimoire].sort((a, b) => {
    const aOrder = a.characterType ? TYPE_ORDER[a.characterType] : 99;
    const bOrder = b.characterType ? TYPE_ORDER[b.characterType] : 99;
    if (aOrder !== bOrder) return aOrder - bOrder;
    if (a.alive !== b.alive) return a.alive ? -1 : 1;
    return a.displayName.localeCompare(b.displayName);
  });
}

function groupLabel(entry: GrimoirePlayerEntry): 'Evil' | 'Good' | null {
  if (!entry.alignment) return null;
  return entry.alignment === 'evil' ? 'Evil' : 'Good';
}

/** True if `entry` is the first row of a new alignment group in `sorted`. */
function isGroupStart(sorted: GrimoirePlayerEntry[], index: number): boolean {
  if (index === 0) return true;
  return groupLabel(sorted[index]!) !== groupLabel(sorted[index - 1]!);
}

export function GrimoireTable({ grimoire, onToggleStatus, onMarkDead }: GrimoireTableProps) {
  const sorted = sortGrimoire(grimoire);
  // "Mark Dead" is a single unconfirmed, irreversible click that removes a player from
  // the game, and it is one of the very first things a new Storyteller will press by
  // accident next to a checkbox. Arming it takes one extra tap and removes a whole
  // class of "how did that player just die" moments.
  const [armedFor, setArmedFor] = useState<string | null>(null);

  const markDeadButton = (playerId: string, name: string) =>
    armedFor === playerId ? (
      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
        <button className="btn btn-danger" onClick={() => {
          setArmedFor(null);
          onMarkDead(playerId);
        }}>
          Kill {name}?
        </button>
        <button className="btn" onClick={() => setArmedFor(null)}>
          Cancel
        </button>
      </span>
    ) : (
      <button className="btn" onClick={() => setArmedFor(playerId)}>
        Mark Dead
      </button>
    );

  return (
    <>
      <table className="grimoire-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border-subtle)' }}>
            <th style={{ padding: 8 }}>Player</th>
            <th style={{ padding: 8 }}>Character</th>
            <th style={{ padding: 8 }}>Alignment</th>
            <th style={{ padding: 8 }}>Living Neighbors</th>
            <th style={{ padding: 8 }}>Status</th>
            <th style={{ padding: 8 }}>Alive</th>
            <th style={{ padding: 8 }}></th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((entry, index) => {
            const label = groupLabel(entry);
            // Keyed Fragment, not a bare <>. A key on an inner <tr> does not key the
            // element React actually sees as the list child, so every grimoire render
            // logged "Each child in a list should have a unique key prop" and React
            // reconciled the rows by position. The card layout below already keyed
            // its wrapper; this is the same fix.
            return (
              <Fragment key={entry.playerId}>
                {isGroupStart(sorted, index) && label && (
                  <tr>
                    <td
                      colSpan={6}
                      className={label === 'Evil' ? 'alignment-evil' : 'alignment-good'}
                      style={{ padding: '10px 8px 4px', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}
                    >
                      {label}
                    </td>
                  </tr>
                )}
                <tr key={entry.playerId} style={{ borderBottom: '1px solid var(--border-subtle)', opacity: entry.alive ? 1 : 0.5 }}>
                  <td style={{ padding: 8 }}>
                    <ConnectionDot connected={entry.connected} /> {entry.displayName}
                  </td>
                  <td style={{ padding: 8 }}>{characterName(entry.character)}</td>
                  <td style={{ padding: 8 }}>
                    <span className={entry.alignment === 'evil' ? 'alignment-evil' : 'alignment-good'}>
                      {entry.alignment ?? '—'}
                    </span>
                  </td>
                  <td style={{ padding: 8, fontSize: 13 }} className="faint">
                    {nameOf(grimoire, entry.livingLeftNeighborId)} / {nameOf(grimoire, entry.livingRightNeighborId)}
                  </td>
                  <td style={{ padding: 8 }}>
                    <StatusToggles entry={entry} onToggleStatus={onToggleStatus} />
                  </td>
                  <td style={{ padding: 8 }}>{entry.alive ? 'Alive' : 'Dead'}</td>
                  <td style={{ padding: 8 }}>
                    {entry.alive && markDeadButton(entry.playerId, entry.displayName)}
                  </td>
                </tr>
              </Fragment>
            );
          })}
        </tbody>
      </table>

      <div className="grimoire-cards" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {sorted.map((entry, index) => {
          const label = groupLabel(entry);
          return (
            <div key={entry.playerId}>
              {isGroupStart(sorted, index) && label && (
                <p
                  className={label === 'Evil' ? 'alignment-evil' : 'alignment-good'}
                  style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '12px 0 6px' }}
                >
                  {label}
                </p>
              )}
              <div className="panel" style={{ opacity: entry.alive ? 1 : 0.5 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <strong>
                    <ConnectionDot connected={entry.connected} /> {entry.displayName}
                  </strong>
                  <span className={entry.alignment === 'evil' ? 'alignment-evil' : 'alignment-good'}>{entry.alignment}</span>
                </div>
                <p className="muted" style={{ margin: '4px 0' }}>
                  {characterName(entry.character)} — {entry.alive ? 'Alive' : 'Dead'}
                </p>
                <p className="faint" style={{ margin: '0 0 8px' }}>
                  Neighbors: {nameOf(grimoire, entry.livingLeftNeighborId)} / {nameOf(grimoire, entry.livingRightNeighborId)}
                </p>
                <StatusToggles entry={entry} onToggleStatus={onToggleStatus} />
                {entry.alive && <div style={{ marginTop: 8 }}>{markDeadButton(entry.playerId, entry.displayName)}</div>}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function ConnectionDot({ connected }: { connected: boolean }) {
  return (
    <span
      title={connected ? 'Connected' : 'Disconnected'}
      aria-label={connected ? 'Connected' : 'Disconnected'}
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: connected ? 'var(--success)' : 'var(--danger)',
      }}
    />
  );
}

function StatusToggles({
  entry,
  onToggleStatus,
}: {
  entry: GrimoirePlayerEntry;
  onToggleStatus: (playerId: string, key: 'poisoned' | 'drunk' | 'protected') => void;
}) {
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {(['poisoned', 'drunk', 'protected'] as const).map((key) => (
        <label key={key} style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
          <input
            type="checkbox"
            checked={entry.statusEffects[key]}
            onChange={() => onToggleStatus(entry.playerId, key)}
          />
          {key}
        </label>
      ))}
    </div>
  );
}
