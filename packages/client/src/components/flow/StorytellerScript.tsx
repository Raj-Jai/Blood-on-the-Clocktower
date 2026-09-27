import { useEffect, useState } from 'react';
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

/** Ticks once a second while a pause is running, so the countdown is live. */
function useCountdown(target: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (target === null) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [target]);
  if (target === null) return 0;
  return Math.max(0, Math.ceil((target - now) / 1000));
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
  const secondsLeft = useCountdown(flow.wakeBlockedUntil);
  const [delaySeconds, setDelaySeconds] = useState(flow.delaySeconds);
  useEffect(() => setDelaySeconds(flow.delaySeconds), [flow.delaySeconds]);

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

  function skipDelay() {
    socket?.emit(ClientEvents.StorytellerAdvanceNight, { action: 'skipDelay' });
  }

  function setDelay(seconds: number) {
    socket?.emit(ClientEvents.StorytellerSetNightDelay, { seconds });
  }

  function resolveNight() {
    socket?.emit(ClientEvents.StorytellerAdvanceNight, { action: 'resolve' });
  }

  /**
   * "I've dealt with the person who is awake."
   *
   * This has to live HERE, in the panel that says what to do, and not only in the
   * night order list. Half the characters in the game — the Chef, the Empath, the
   * Undertaker, and every learn-in character with nobody to learn about — have
   * nothing to submit, so no player window ever shows a picker and the flow is
   * simply waiting on the Storyteller to move the walk along. With this button
   * only in the order list, the panel whose entire job is "what to do now" offered
   * no action at that exact moment, and the only way forward was a control labelled
   * as a cursor move in a different panel.
   */
  function dealWithWaker() {
    socket?.emit(ClientEvents.StorytellerAdvanceNight, { action: 'next' });
  }

  return (
    <div
      className="panel"
      style={{ borderColor: 'var(--accent-gold)' }}
      data-testid="storyteller-script"
      // The flow stage is exposed so a test — or the game simulator — can tell what
      // beat the night is on without parsing the sentence it is supposed to read.
      data-stage={flow.stage}
    >
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
      {flow.unmakeableSteps.length > 0 && (
        <div
          style={{
            marginTop: 12,
            padding: '8px 12px',
            borderRadius: 'var(--radius-md)',
            background: 'var(--bg-void)',
            border: '1px solid var(--border-subtle)',
          }}
        >
          {flow.unmakeableSteps.map((u) => (
            <p key={u.characterName} style={{ margin: 0, fontSize: '0.9rem' }}>
              <strong>{u.characterName}:</strong> {u.reason}
            </p>
          ))}
        </div>
      )}
      {flow.stage === 'night-step' && flow.delaySeconds === 0 && (
        <p className="faint" style={{ marginTop: 8 }}>
          No pause between wakers is set, so the table can time the wake order.
        </p>
      )}

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
        {flow.stage === 'night-step' && flow.wakeBlockedUntil !== null && (
          <>
            <span
              className="muted"
              style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}
              data-testid="wake-countdown"
            >
              {secondsLeft > 0 ? `Next wake in ${secondsLeft}s` : 'Ready'}
            </span>
            <button className="btn btn-inline" onClick={skipDelay}>
              Skip the wait
            </button>
          </>
        )}
        {flow.stage === 'night-step' && flow.wakeBlockedUntil === null && !readyToResolve && !flow.needsChoiceFromName && (
          // Not while somebody owes a choice. The server refuses to move the walk in
          // that case anyway, and offering the button next to a "Waiting on: ..."
          // warning just invites the Storyteller to click something that will not
          // work.
          <button className="btn btn-primary" onClick={dealWithWaker} data-testid="deal-with-waker">
            I&apos;ve dealt with {flow.activePlayerName ?? 'them'} — next waker
          </button>
        )}
        {flow.stage === 'night-step' && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.9rem' }}>
            Pause between wakers
            <input
              className="input"
              type="number"
              min={0}
              max={60}
              style={{ width: 64 }}
              value={delaySeconds}
              onChange={(e) => setDelaySeconds(Math.max(0, Math.min(60, Number(e.target.value) || 0)))}
              onBlur={() => setDelay(delaySeconds)}
            />
            seconds
          </label>
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
