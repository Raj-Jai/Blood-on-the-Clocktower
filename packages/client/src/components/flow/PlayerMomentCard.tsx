import type { ReactNode } from 'react';
import { derivePlayerMoment, type FlowState, type PlayerFlowContext, type PlayerMoment } from '@clocktower/shared';

interface PlayerMomentCardProps {
  flow: FlowState;
  context: PlayerFlowContext;
  /**
   * The one control for this moment, rendered directly beneath the instruction.
   *
   * This is the whole point: the app used to say "open a nomination from the Town
   * Square tab", which meant the control could be anywhere at all. Whatever the
   * player has to do next is passed in here and shown in view.
   */
  action?: ReactNode;
  speechEnabled: boolean;
  onToggleSpeech: (enabled: boolean) => void;
  speechSupported: boolean;
  hostIsAnnouncing: boolean;
}

const TONE_STYLE: Record<PlayerMoment['tone'], { border: string; background: string; emoji: string }> = {
  action: { border: 'var(--accent-gold-bright)', background: 'rgba(201, 162, 75, 0.14)', emoji: '👁' },
  sleep: { border: 'var(--border-subtle)', background: 'var(--bg-panel-raised)', emoji: '🌙' },
  wait: { border: 'var(--border-subtle)', background: 'var(--bg-panel-raised)', emoji: '⏳' },
  talk: { border: 'var(--good-blue)', background: 'var(--good-blue-bg)', emoji: '💬' },
  over: { border: 'var(--accent-gold)', background: 'var(--bg-panel-raised)', emoji: '🏆' },
};

/**
 * THE ONE THING.
 *
 * Sits at the top of every player's screen, always, and answers exactly one
 * question: what do I do now? It replaced a turn guide that also had to be
 * navigated to, and a set of tabs that meant the control for whatever you were
 * told to do was rarely on the tab you were looking at.
 *
 * Deliberately NOT a live region. Night content is spoken by design through the
 * host's announcer, and a live region would double-announce it on every device.
 */
export function PlayerMomentCard({
  flow,
  context,
  action,
  speechEnabled,
  onToggleSpeech,
  speechSupported,
  hostIsAnnouncing,
}: PlayerMomentCardProps) {
  const moment = derivePlayerMoment(flow, context);
  const tone = TONE_STYLE[moment.tone];

  return (
    <div
      className="panel"
      style={{ borderColor: tone.border, background: tone.background, borderWidth: 2 }}
      data-testid="player-moment"
      data-moment={moment.kind}
      data-action={moment.action}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <h2 style={{ margin: 0, fontSize: '1.35rem', lineHeight: 1.3 }}>
          <span aria-hidden="true" style={{ marginRight: 8 }}>
            {tone.emoji}
          </span>
          {moment.title}
        </h2>
        {flow.stage !== 'setup' && (
          <span className="muted" style={{ fontWeight: 700 }}>
            {moment.phaseLabel}
          </span>
        )}
      </div>

      <p style={{ margin: '10px 0 0', fontSize: '1.05rem', lineHeight: 1.5 }}>{moment.detail}</p>

      {action && <div style={{ marginTop: 16 }}>{action}</div>}

      {(speechSupported || hostIsAnnouncing) && (
        <div
          style={{
            marginTop: 16,
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
              <input type="checkbox" checked={speechEnabled} onChange={(e) => onToggleSpeech(e.target.checked)} />
              Read my own information aloud
              <span className="faint">(never the table&apos;s)</span>
            </label>
          )}
        </div>
      )}
    </div>
  );
}
