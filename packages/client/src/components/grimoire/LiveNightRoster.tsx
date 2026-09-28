import type { NightRosterPayload } from '@clocktower/shared';
import type { GrimoirePlayerEntry } from '@clocktower/shared';

interface LiveNightRosterProps {
  roster: NightRosterPayload | null;
  grimoire: GrimoirePlayerEntry[];
  onAdvance: () => void;
}

const CLASS_LABEL: Record<string, string> = {
  auto: 'Automatic',
  assisted: 'Awaiting player',
  policy: 'Storyteller default',
  manual: 'Storyteller discretion',
};

/**
 * Replaces the old static night-order list with a live, steppable roster:
 * shows who's woken, who's pending, and who's currently up, with a Next
 * button to advance. Automatic/assisted roles resolve themselves (or wait
 * for the player's own submission); policy/manual roles still rely on the
 * Storyteller's judgment, same as before, just with a clear place in the
 * sequence.
 */
export function LiveNightRoster({ roster, grimoire, onAdvance }: LiveNightRosterProps) {
  if (!roster) {
    return (
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Night Order</h3>
        <p className="faint">Not currently night.</p>
      </div>
    );
  }

  function nameFor(playerId: string): string {
    return grimoire.find((g) => g.playerId === playerId)?.displayName ?? 'Unknown';
  }

  const allDone = roster.steps.length === 0 || roster.steps.every((s) => s.done);
  const currentIndex = roster.steps.findIndex((s) => s.current);

  return (
    <div className="panel">
      <h3 style={{ marginTop: 0 }}>{roster.isFirstNight ? 'First Night Order' : 'Night Order'}</h3>
      {roster.steps.length === 0 ? (
        <p className="faint">No characters wake tonight.</p>
      ) : (
        <>
          <ol style={{ paddingLeft: 20, lineHeight: 1.8, margin: 0 }}>
            {roster.steps.map((step) => (
              <li
                key={step.playerId}
                style={{
                  fontWeight: step.current ? 700 : 400,
                  opacity: step.done && !step.current ? 0.55 : 1,
                }}
              >
                {step.characterName} — {nameFor(step.playerId)}{' '}
                <span className="faint" style={{ fontSize: 12 }}>
                  ({step.done ? 'done' : CLASS_LABEL[step.automationClass] ?? step.automationClass})
                </span>
                {step.current && <span style={{ marginLeft: 6 }}>👈</span>}
              </li>
            ))}
          </ol>
          <button
            className="btn btn-inline btn-primary"
            style={{ marginTop: 12 }}
            onClick={onAdvance}
            disabled={allDone || currentIndex === -1}
          >
            {allDone ? 'All done' : 'Next ▶'}
          </button>
        </>
      )}
    </div>
  );
}
