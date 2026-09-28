import type { ActiveNominationView } from '@clocktower/shared';
import type { LobbyPlayer } from '../../hooks/useSession.js';

interface VoteTallyProps {
  nomination: ActiveNominationView;
  players: LobbyPlayer[];
  selfPlayerId: string;
  canVote: boolean;
  /** Whether the current player is alive. Dead players get exactly one vote for the whole game, spent the instant they vote yes. */
  selfAlive: boolean;
  onVote: (voting: boolean) => void;
}

function nameFor(players: LobbyPlayer[], id: string): string {
  return players.find((p) => p.playerId === id)?.displayName ?? 'Unknown';
}

export function VoteTally({ nomination, players, selfPlayerId, canVote, selfAlive, onVote }: VoteTallyProps) {
  const myVote = nomination.votes.find((v) => v.playerId === selfPlayerId);

  return (
    <div className="panel">
      <h3 style={{ marginTop: 0 }}>
        Nomination: <span className="alignment-evil">{nameFor(players, nomination.targetId)}</span>
      </h3>
      <p className="faint">Nominated by {nameFor(players, nomination.nominatorId)}</p>
      <p>
        Votes for execution: <strong>{nomination.votesFor}</strong> / {nomination.threshold} needed
      </p>
      {myVote && (
        <p className="faint" style={{ margin: '0 0 8px' }}>
          Your vote is currently counting as <strong>{myVote.voting ? 'yes' : 'no'}</strong>.
        </p>
      )}
      {nomination.closed ? (
        <p className={nomination.pendingExecution ? 'alignment-evil' : 'muted'}>
          {nomination.executed
            ? `${nameFor(players, nomination.targetId)} has been executed.`
            : nomination.pendingExecution
              ? 'This nomination met the threshold — awaiting the Storyteller.'
              : 'This nomination did not pass.'}
        </p>
      ) : (
        <div>
          {!selfAlive && myVote === undefined && (
            <p className="faint" style={{ margin: '0 0 8px' }}>
              You're dead — this is your one vote for the entire game. Once you vote yes, it's spent for good, even
              if you change your mind afterward.
            </p>
          )}
          <div className="mobile-stack" style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn btn-primary"
              disabled={!canVote || myVote?.voting === true}
              onClick={() => onVote(true)}
            >
              Vote to Execute
            </button>
            <button className="btn" disabled={!canVote || myVote?.voting === false} onClick={() => onVote(false)}>
              {!selfAlive && myVote?.voting ? "Change display to No (vote still spent)" : 'No'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
