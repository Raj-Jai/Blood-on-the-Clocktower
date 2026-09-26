import { useEffect } from 'react';
import { ClientEvents, deriveStorytellerLine, type FlowState } from '@clocktower/shared';
import type { Socket } from 'socket.io-client';

interface StorytellerScriptProps {
  socket: Socket | null;
  flow: FlowState;
  announcer: {
    enabled: boolean;
    setEnabled: (v: boolean) => void;
    announce: (text: string) => void;
    repeat: (text: string) => void;
    supported: boolean;
  };
  /** True when the engine has applied the night and is waiting to move to the day. */
  nightResolved: boolean;
  /** True when every night choice is in. */
  readyToResolve: boolean;
  /** Steps still missing a choice, by character name, for the warning line. */
  outstanding: string[];
}

/**
 * THE STORYTELLER'S SCRIPT.
 *
 * The real game runs on the Storyteller saying the right sentence at the right
 * moment, and the app had no memory of those sentences — so the whole job
 * depended on remembering them. This is that memory, derived from the server's
 * public flow state rather than stored, so it cannot drift.
 *
 * The "say this" line is public information by construction: naming somebody to
 * wake them is something the real table does out loud. The host device can read
 * it aloud through the announcer, which turns this device into the table's PA
 * system — the thing the issue asked for. It is OFF-able, because a room may
 * prefer a human voice.
 */
export function StorytellerScript({
  socket,
  flow,
  announcer,
  nightResolved,
  readyToResolve,
  outstanding,
}: StorytellerScriptProps) {
  const line = deriveStorytellerLine(flow);

  // Read the public line aloud as it changes. Only ever `line.say`, which comes
  // from the server's `FlowState.announcement` and is guaranteed leak-free.
  const announce = announcer.announce;
  useEffect(() => {
    if (line.say.length === 0) return;
    announce(line.say);
  }, [line.say, announce]);

  function advance() {
    socket?.emit(ClientEvents.StorytellerFlowAdvance);
  }

  function resolveNight() {
    socket?.emit(ClientEvents.StorytellerAdvanceNight, { action: 'resolve' });
  }

  return (
    <div className="panel" style={{ borderColor: 'var(--accent-gold)' }} data-testid="storyteller-script">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>What to do now</h2>
        {line.progress && <span className="muted">{line.progress}</span>}
      </div>

      <div
        style={{
          marginTop: 12,
          padding: 16,
          borderRadius: 'var(--radius-md)',
          background: 'var(--bg-void)',
          border: '1px solid var(--border-subtle)',
          textAlign: 'center',
        }}
      >
        <p className="muted" style={{ margin: '0 0 6px', fontSize: '0.8rem', letterSpacing: 1, textTransform: 'uppercase' }}>
          Say
        </p>
        <p style={{ margin: 0, fontSize: '1.4rem', lineHeight: 1.35, fontFamily: 'var(--font-display)' }}>
          {line.say || '—'}
        </p>
      </div>

      <p style={{ marginTop: 12, marginBottom: 0 }}>{line.action}</p>

      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        {line.say && announcer.supported && (
          <>
            <button className="btn btn-inline" onClick={() => announcer.repeat(line.say)}>
              🔊 Say it again
            </button>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.9rem' }}>
              <input
                type="checkbox"
                checked={announcer.enabled}
                onChange={(e) => announcer.setEnabled(e.target.checked)}
              />
              Read the table instructions aloud
            </label>
          </>
        )}
        {flow.stage === 'night-briefing' && (
          <button className="btn btn-primary" onClick={advance}>
            Eyes are closed — start waking people
          </button>
        )}
        {flow.stage === 'night-step' && readyToResolve && !nightResolved && (
          <button className="btn btn-primary" onClick={resolveNight}>
            Resolve the night
          </button>
        )}
        {flow.stage === 'night-step' && !readyToResolve && outstanding.length > 0 && (
          <span className="alignment-evil" style={{ fontWeight: 600 }}>
            Waiting on: {outstanding.join(', ')}
          </span>
        )}
        {flow.stage === 'night-resolving' && (
          <button className="btn btn-primary" onClick={() => socket?.emit(ClientEvents.StorytellerSetPhase, { phase: 'day' })}>
            Move to the day
          </button>
        )}
        {flow.stage === 'day-reveal' && (
          <button className="btn btn-primary" onClick={advance}>
            They have read the dead — start the day
          </button>
        )}
        {flow.stage === 'day-voting' && flow.executionPending && (
          <button
            className="btn btn-danger"
            onClick={() => {
              if (flow.nominationId) {
                socket?.emit(ClientEvents.StorytellerConfirmExecution, { nominationId: flow.nominationId });
              }
            }}
          >
            Execute {flow.executedPlayerName ?? 'the nominated player'}
          </button>
        )}
        {flow.stage === 'day-voting' && !flow.executionPending && (
          <button
            className="btn btn-inline"
            onClick={() => {
              if (flow.nominationId) {
                socket?.emit(ClientEvents.StorytellerCloseVote, { nominationId: flow.nominationId });
              }
            }}
          >
            Close the vote
          </button>
        )}
      </div>
    </div>
  );
}
