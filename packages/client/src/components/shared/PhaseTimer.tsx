import { useEffect, useState } from 'react';

interface PhaseTimerProps {
  phaseEndsAt: number | null;
  phase: 'day' | 'night' | 'lobby' | 'ended';
}

function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * Live countdown ticking locally from the server-provided end timestamp, so no per-second network traffic is needed.
 *
 * KNOWN ACCESSIBILITY DEFECT (pre-existing, deliberately not fixed here): the
 * element below is `role="timer"` with `aria-live="polite"` and its text changes
 * every second, so a screen reader is interrupted once per second for the entire
 * phase — which makes the timer actively hostile to anyone navigating by screen
 * reader, for the whole phase, in a game where thinking time is the resource
 * under pressure. The fix is a coarser announcement (announce on minute
 * boundaries, or on the last 10 seconds) or no live region at all with a separate
 * polite summary that changes once. It is a separate change from the Night
 * Engine because it affects the day timer too, and mixing an a11y fix into the
 * night work would make both reviews harder.
 */
export function PhaseTimer({ phaseEndsAt, phase }: PhaseTimerProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!phaseEndsAt) return undefined;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [phaseEndsAt]);

  if (!phaseEndsAt || (phase !== 'day' && phase !== 'night')) return null;

  const remainingMs = phaseEndsAt - now;
  const isUp = remainingMs <= 0;
  const label = phase === 'night' ? 'Night ends in' : 'Day ends in';

  return (
    <div
      role="timer"
      aria-live="polite"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        padding: '8px 16px',
        margin: '12px auto',
        borderRadius: 999,
        maxWidth: 280,
        background: isUp ? 'var(--evil-red-bg)' : 'var(--bg-panel-raised)',
        border: `1px solid ${isUp ? 'var(--evil-red)' : 'var(--border-subtle)'}`,
        fontWeight: 700,
      }}
    >
      <span aria-hidden="true">{phase === 'night' ? '🌙' : '☀️'}</span>
      <span className={isUp ? 'alignment-evil' : undefined}>
        {isUp ? "Time's up!" : `${label} ${formatRemaining(remainingMs)}`}
      </span>
    </div>
  );
}
