import { useState } from 'react';
import type { LobbyPlayer } from '../../hooks/useSession.js';

interface NominationBarProps {
  players: LobbyPlayer[];
  selfPlayerId: string;
  canNominate: boolean;
  onNominate: (targetPlayerId: string) => void;
}

export function NominationBar({ players, selfPlayerId, canNominate, onNominate }: NominationBarProps) {
  const [targetId, setTargetId] = useState('');
  const [confirming, setConfirming] = useState(false);
  const candidates = players.filter((p) => p.playerId !== selfPlayerId && p.alive);
  const targetName = candidates.find((p) => p.playerId === targetId)?.displayName;
  // A player gets one nomination a day, and the server refuses a second. Saying so
  // here is better than letting someone press the button and be rejected.
  const alreadyNominated = players.find((p) => p.playerId === selfPlayerId)?.hasNominatedToday ?? false;
  /*
   * "Each player may nominate only once per day, and each player may be nominated only
   * once per day." The nominee's half used to go entirely unenforced — the server
   * accepted a second nomination of the same person all day — so a failed vote could be
   * re-run on one player repeatedly. Now the server refuses it, which means the client
   * has to stop offering them, or we have replaced one bug with an error toast.
   */
  const alreadyBeenNominated = players.find((p) => p.playerId === targetId)?.hasBeenNominatedToday ?? false;
  // A day with an execution in it is over, so nothing more can be put to a vote.
  const blocked = alreadyNominated || !canNominate || (Boolean(targetId) && alreadyBeenNominated);

  function reset() {
    setTargetId('');
    setConfirming(false);
  }

  return (
    <div className="panel">
      <h3 style={{ marginTop: 0 }}>Nominate</h3>
      {alreadyNominated && !canNominate && (
        <p className="faint">You have already nominated today. You get one nomination a day.</p>
      )}
      {alreadyBeenNominated && (
        <p className="faint">
          {targetName} has already been nominated today, so they cannot be nominated again.
        </p>
      )}
      {!canNominate && !alreadyNominated && !alreadyBeenNominated && (
        <p className="faint">You can't nominate right now.</p>
      )}

      {confirming && targetId ? (
        <div>
          <p>
            Nominate <strong className="alignment-evil">{targetName}</strong> for execution? This is public and
            can't be undone.
          </p>
          <div className="mobile-stack" style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn btn-danger"
              onClick={() => {
                onNominate(targetId);
                reset();
              }}
            >
              Confirm Nomination
            </button>
            <button className="btn" onClick={reset}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="mobile-stack" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <select
            className="input"
            data-testid="nominate-select"
            style={{ flex: 1 }}
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
            disabled={blocked}
          >
            <option value="">Choose a player…</option>
            {candidates.map((p) => (
              <option key={p.playerId} value={p.playerId}>
                {p.displayName}
              </option>
            ))}
          </select>
          <button
            className="btn btn-primary"
            disabled={blocked || !targetId}
            onClick={() => setConfirming(true)}
          >
            Nominate
          </button>
        </div>
      )}
    </div>
  );
}
