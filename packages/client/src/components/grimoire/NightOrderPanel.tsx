import { useState } from 'react';
import { ClientEvents, type NightLogEntryView, type NightOrderUpdatePayload } from '@clocktower/shared';
import type { Socket } from 'socket.io-client';

interface NightOrderPanelProps {
  socket: Socket | null;
  /** Live night state from the server, or null when no night is open. */
  nightOrder: NightOrderUpdatePayload | null;
  /** The auditable log of every generated default and override. */
  nightLog: NightLogEntryView[];
}

function formatLogTime(at: number): string {
  const d = new Date(at);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d
    .getSeconds()
    .toString()
    .padStart(2, '0')}`;
}

/** Log lines that describe a hidden-state decision, highlighted in the audit trail. */
const DECISION_KINDS = new Set([
  'setup-default',
  'discretion',
  'override',
  'heir-random',
  'heir-fallback',
  'info-generated',
  'poison-expired',
  'poison-carries',
  'poisoned',
  'poisoned-demon',
  'protected',
  'kill-blocked',
  'protection-saved',
  'night-kill',
  'demon-inherited',
  'bluff-reassigned',
  'outstanding-choice',
  'night-warning',
  'ability-failed',
  'mayor-death',
  'unimplemented',
]);

/**
 * The Storyteller's night console: a steppable wake order, a wake roster, and the
 * auditable log.
 *
 * Replaces a static read-only `<ol>` of character names. Every row shows the
 * waker, whether their choice is in, the legal targets for a picking step, and
 * whether the step produced a result — so the whole night can be run from this
 * panel without a single spoken instruction to a player.
 *
 * "Next" only moves the stepper cursor: it does not resolve anything, because the
 * engine resolves the whole night in one pass in official order (see
 * nightEngine.ts for why that order is load-bearing).
 */
export function NightOrderPanel({ socket, nightOrder, nightLog }: NightOrderPanelProps) {
  const [showLog, setShowLog] = useState(false);

  if (!nightOrder) {
    return (
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Night Order</h3>
        <p className="faint">
          No night is open. Switch the game to the night phase and the wake order appears here.
        </p>
      </div>
    );
  }

  const { steps, activeIndex, resolvedCount, totalCount, outstandingCharacterIds, resolved, isFirstNight } = nightOrder;
  const outstanding = outstandingCharacterIds.length;
  const wakers = steps.filter((s) => s.wakerPlayerId);

  function advance(action: 'next' | 'previous' | 'resolve') {
    socket?.emit(ClientEvents.StorytellerAdvanceNight, { action });
  }

  return (
    <div className="panel">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0 }}>
          {isFirstNight ? 'First Night Order' : `Night ${nightOrder.nightNumber} Order`}
        </h3>
        <span className="muted">
          {resolvedCount}/{totalCount} steps in
        </span>
      </div>

      {steps.length === 0 ? (
        <p className="faint">Nobody wakes tonight.</p>
      ) : (
        <ol style={{ paddingLeft: 20, lineHeight: 1.6 }}>
          {steps.map((step, index) => {
            const isActive = index === activeIndex;
            return (
              <li
                key={`${step.characterId}-${step.wakerPlayerId}`}
                style={{
                  fontWeight: isActive ? 700 : undefined,
                  color: step.resolved ? 'var(--muted, inherit)' : undefined,
                }}
              >
                <span aria-hidden="true" style={{ marginRight: 6 }}>
                  {step.resolved ? '✅' : '⬜'}
                </span>
                {step.order}. {step.characterName}
                <span className="muted"> — {step.wakerName}</span>
                {step.isDrunkCover && (
                  <span className="badge badge-outsider" style={{ marginLeft: 6 }}>
                    Drunk
                  </span>
                )}
                {step.targetCount > 0 && (
                  <div className="faint" style={{ fontSize: '0.85rem' }}>
                    {step.resolved
                      ? `Chose: ${step.targetNames.join(' and ') || 'nothing'}`
                      : `Waiting on a choice from ${step.wakerName} (${step.targetCount} to pick from ${step.legalTargetNames.length} legal)`}
                  </div>
                )}
                {step.overrideText && <div className="faint">Override queued: “{step.overrideText}”</div>}
              </li>
            );
          })}
        </ol>
      )}

      {outstanding > 0 && !resolved && (
        <p className="alignment-evil" style={{ fontWeight: 600, marginTop: 8 }}>
          Outstanding choices: {outstandingCharacterIds.join(', ')}. Resolving now means those abilities do nothing.
        </p>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <button className="btn btn-inline" onClick={() => advance('previous')} disabled={activeIndex <= 0}>
          ← Previous
        </button>
        <button
          className="btn btn-inline"
          onClick={() => advance('next')}
          disabled={activeIndex >= steps.length - 1 || resolved}
        >
          Next →
        </button>
        <button className="btn btn-primary" onClick={() => advance('resolve')} disabled={resolved}>
          {resolved ? 'Night resolved' : 'Resolve night'}
        </button>
      </div>
      <p className="faint" style={{ marginTop: 8 }}>
        “Next” moves the cursor. “Resolve night” applies every step in official order and sends each player their
        own result — the Poisoner acts before the Imp, so poisoning the Demon really does stop the kill.
      </p>

      <div style={{ marginTop: 16, borderTop: '1px solid var(--border-subtle)', paddingTop: 12 }}>
        <h4 style={{ margin: '0 0 6px' }}>Who wakes tonight</h4>
        {wakers.length === 0 ? (
          <p className="faint">Nobody.</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.5 }}>
            {wakers.map((step) => (
              <li key={`roster-${step.wakerPlayerId}`}>
                {step.wakerName} <span className="muted">as {step.characterName}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div style={{ marginTop: 16, borderTop: '1px solid var(--border-subtle)', paddingTop: 12 }}>
        <button className="btn btn-inline" onClick={() => setShowLog((v) => !v)} aria-expanded={showLog}>
          {showLog ? 'Hide' : 'Show'} night log ({nightLog.length})
        </button>
        <p className="faint" style={{ marginTop: 6 }}>
          Every hidden-state default and every override is written here with a timestamp, before it is used. A server
          that decides at a fixed, logged moment is easier to audit than a Storyteller deciding later.
        </p>
        {showLog && (
          <div style={{ maxHeight: 260, overflowY: 'auto', marginTop: 8 }}>
            {nightLog.length === 0 ? (
              <p className="faint">Nothing logged yet.</p>
            ) : (
              [...nightLog].reverse().map((entry, index) => (
                <div
                  key={`${entry.at}-${index}`}
                  style={{
                    fontSize: '0.85rem',
                    padding: '4px 0',
                    borderBottom: '1px solid var(--border-subtle)',
                    color: DECISION_KINDS.has(entry.kind) ? undefined : 'var(--muted, inherit)',
                  }}
                >
                  <span className="muted">
                    N{entry.night} {formatLogTime(entry.at)}{' '}
                  </span>
                  <strong>{entry.kind}</strong> {entry.detail}
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
