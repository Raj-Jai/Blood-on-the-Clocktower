import { getCharacterById, type GrimoirePlayerEntry } from '@clocktower/shared';
import { sortGrimoire } from '../grimoire/GrimoireTable.js';

interface SpyGrimoirePanelProps {
  grimoire: GrimoirePlayerEntry[];
}

function characterName(id: string | null): string {
  if (!id) return '—';
  return getCharacterById(id)?.name ?? id;
}

/**
 * Read-only view of the full Grimoire for the Spy ("Each night, you see
 * the Grimoire"). Deliberately has none of GrimoireTable's Storyteller
 * controls (status toggles, Mark Dead) -- the Spy only ever looks.
 */
export function SpyGrimoirePanel({ grimoire }: SpyGrimoirePanelProps) {
  const sorted = sortGrimoire(grimoire);

  return (
    <div className="panel" style={{ borderColor: 'var(--evil-red)' }}>
      <h3 style={{ marginTop: 0 }} className="alignment-evil">
        🔎 The Grimoire
      </h3>
      <p className="faint" style={{ marginTop: -8, marginBottom: 12 }}>
        Your Spy ability shows you everyone's true character and status, same as the Storyteller sees it.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {sorted.map((entry) => (
          <div
            key={entry.playerId}
            className="panel"
            style={{ padding: '8px 12px', opacity: entry.alive ? 1 : 0.5, margin: 0 }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <strong>{entry.displayName}</strong>
              <span className={entry.alignment === 'evil' ? 'alignment-evil' : 'alignment-good'} style={{ fontSize: 12 }}>
                {entry.alignment ?? '—'}
              </span>
            </div>
            <p className="muted" style={{ margin: '2px 0 0', fontSize: 14 }}>
              {characterName(entry.character)} — {entry.alive ? 'Alive' : 'Dead'}
              {entry.statusEffects.poisoned && ' · poisoned'}
              {entry.statusEffects.protected && ' · protected'}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
