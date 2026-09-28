import { useState } from 'react';
import { ClientEvents, MAX_PLAYERS, MIN_PLAYERS } from '@clocktower/shared';
import type { Socket } from 'socket.io-client';
import type { SessionState } from '../hooks/useSession.js';

interface LobbyPageProps {
  code: string;
  socket: Socket | null;
  session: SessionState;
  isStoryteller: boolean;
}

export function LobbyPage({ code, socket, session, isStoryteller }: LobbyPageProps) {
  const count = session.lobbyPlayers.length;
  const belowMin = count < MIN_PLAYERS;
  const atMax = count >= MAX_PLAYERS;
  const [copied, setCopied] = useState(false);

  /**
   * The host reads this code out loud across a noisy table, so it gets a copy button
   * and characters spaced far enough apart not to be misread as one digit.
   */
  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be refused; the code is on screen to read out regardless.
    }
  }

  return (
    <div className="app-shell">
      <div className="panel">
        <h1 style={{ marginTop: 0 }}>Lobby</h1>
        <p className="faint" style={{ margin: '0 0 4px' }}>
          Join code
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <strong
            aria-label={`Join code ${code.split('').join(' ')}`}
            style={{
              fontSize: 34,
              letterSpacing: '0.22em',
              lineHeight: 1.2,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {code}
          </strong>
          <button className="btn btn-inline" onClick={copyCode}>
            {copied ? 'Copied' : 'Copy code'}
          </button>
        </div>
        <p className="faint" style={{ marginBottom: 0 }}>
          Share this code with your group so they can join before the game starts.
        </p>
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>
          Players ({count})
        </h2>
        {/* This read "Players (5/15)", which implies 15 is the target. It is not: any
            number from 5 to 15 plays, and 5 is the minimum, so a host with seven
            friends was being told they needed eight more. */}
        <p className="faint" style={{ margin: '-4px 0 8px' }}>
          {belowMin
            ? `Anywhere from ${MIN_PLAYERS} to ${MAX_PLAYERS} players works. You need ${MIN_PLAYERS - count} more to start.`
            : `Anywhere from ${MIN_PLAYERS} to ${MAX_PLAYERS} players works. You're ready to start.`}
        </p>
        {count === 0 && <p className="faint">Waiting for players to join…</p>}
        <ul style={{ paddingLeft: 20, lineHeight: 1.8 }}>
          {session.lobbyPlayers.map((p) => (
            <li key={p.playerId}>
              {p.displayName} {!p.connected && <span className="faint">(disconnected)</span>}
            </li>
          ))}
        </ul>

        {isStoryteller && (
          <div style={{ marginTop: 16, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button
              className="btn btn-primary"
              disabled={belowMin}
              onClick={() => socket?.emit(ClientEvents.StorytellerStartDistribution)}
            >
              Start Distribution
            </button>
            {atMax && <span className="faint">This lobby is full at {MAX_PLAYERS} players.</span>}
          </div>
        )}
      </div>
    </div>
  );
}
