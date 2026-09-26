import { useEffect, useRef } from 'react';
import {
  ClientEvents,
  derivePlayerInstruction,
  type FlowState,
  type PlayerFlowContext,
  type PlayerInstruction,
} from '@clocktower/shared';
import type { Socket } from 'socket.io-client';

interface TurnGuideProps {
  socket: Socket | null;
  flow: FlowState;
  context: PlayerFlowContext;
  /** The player's own night prompt, if one is open. */
  hasOpenNightPrompt: boolean;
  /** Local opt-in for reading private information aloud. Never used for flow. */
  speechEnabled: boolean;
  onToggleSpeech: (enabled: boolean) => void;
  speechSupported: boolean;
  /** Set when the Storyteller's host device is announcing the table aloud. */
  hostIsAnnouncing: boolean;
}

const TONE_STYLE: Record<PlayerInstruction['tone'], { border: string; background: string; emoji: string }> = {
  action: { border: 'var(--accent-gold-bright)', background: 'rgba(201, 162, 75, 0.14)', emoji: '👁' },
  sleep: { border: 'var(--border-subtle)', background: 'var(--bg-panel-raised)', emoji: '🌙' },
  wait: { border: 'var(--border-subtle)', background: 'var(--bg-panel-raised)', emoji: '⏳' },
  talk: { border: 'var(--good-blue)', background: 'var(--good-blue-bg)', emoji: '💬' },
  over: { border: 'var(--accent-gold)', background: 'var(--bg-panel-raised)', emoji: '🏆' },
};

/**
 * WHAT SHOULD I BE DOING RIGHT NOW?
 *
 * This sits above everything else, always visible, and answers exactly one
 * question. It exists because the app had tabs and no direction: a player
 * opening their phone at 11pm had no way to know whether they were asleep,
 * awake, expected to act, or finished.
 *
 * It is derived from the server's public `FlowState` plus the player's own id,
 * so every device agrees and a reconnecting player is told where they stand.
 * Nothing private is needed to compute it, and nothing private is displayed.
 *
 * NOT a live region. Night content is spoken by design through the host's
 * announcer, and a live region would double-announce it on every player device.
 * The text is always visible to a screen reader on focus/ browse; it just does
 * not interrupt.
 */
export function TurnGuide({
  socket,
  flow,
  context,
  hasOpenNightPrompt,
  speechEnabled,
  onToggleSpeech,
  speechSupported,
  hostIsAnnouncing,
}: TurnGuideProps) {
  const instruction = derivePlayerInstruction(flow, context);
  const tone = TONE_STYLE[instruction.tone];
  const headingRef = useRef<HTMLHeadingElement>(null);
  const lastInstructionRef = useRef<string>('');

  // Move focus to the new instruction so a screen reader user who is already
  // looking at this card is told the stage changed. Deliberately not
  // aria-live: this fires on every phase change and would be noisy.
  useEffect(() => {
    const signature = `${flow.stage}:${instruction.title}`;
    if (lastInstructionRef.current === signature) return;
    lastInstructionRef.current = signature;
    headingRef.current?.focus();
  }, [flow.stage, instruction.title]);

  function goTo(tab: 'character' | 'town' | 'chat') {
    // The parent owns the tab; this is a hint that the action lives there.
    window.dispatchEvent(new CustomEvent('botc:goto-tab', { detail: tab }));
  }

  return (
    <div
      className="panel"
      style={{ borderColor: tone.border, background: tone.background, borderWidth: 2 }}
      data-testid="turn-guide"
      data-stage={flow.stage}
      data-action={instruction.action}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h2 ref={headingRef} tabIndex={-1} style={{ margin: 0, outline: 'none' }}>
          <span aria-hidden="true" style={{ marginRight: 8 }}>
            {tone.emoji}
          </span>
          {instruction.title}
        </h2>
        {flow.stage !== 'setup' && flow.stage !== 'ended' && (
          <span className="muted" style={{ fontWeight: 700 }}>
            {flow.phase === 'night' ? `Night ${flow.nightNumber}` : `Day ${flow.dayNumber}`}
          </span>
        )}
      </div>

      <p style={{ margin: '8px 0 0', lineHeight: 1.5 }}>{instruction.detail}</p>

      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        {instruction.action === 'submit-night-choice' && hasOpenNightPrompt && (
          <button className="btn btn-primary" onClick={() => goTo('character')}>
            Go to my prompt
          </button>
        )}
        {instruction.action === 'nominate' && (
          <button className="btn btn-primary" onClick={() => goTo('town')}>
            Nominate someone
          </button>
        )}
        {instruction.action === 'vote' && (
          <button className="btn btn-primary" onClick={() => goTo('town')}>
            Go and vote
          </button>
        )}
        {instruction.action === 'discuss' && (
          <button className="btn btn-primary" onClick={() => goTo('town')}>
            Town Square
          </button>
        )}
      </div>

      {(speechSupported || hostIsAnnouncing) && (
        <div
          style={{
            marginTop: 12,
            paddingTop: 12,
            borderTop: '1px solid var(--border-subtle)',
            display: 'flex',
            gap: 12,
            flexWrap: 'wrap',
            alignItems: 'center',
            fontSize: '0.85rem',
          }}
        >
          {hostIsAnnouncing && (
            <span className="muted">
              The Storyteller&apos;s device is reading the table instructions aloud — listen for your name.
            </span>
          )}
          {speechSupported && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="checkbox"
                checked={speechEnabled}
                onChange={(e) => onToggleSpeech(e.target.checked)}
              />
              Read my own information aloud
              <span className="faint">(never the table&apos;s)</span>
            </label>
          )}
        </div>
      )}
    </div>
  );
}
