import type { ActiveNominationView } from '@clocktower/shared';
import type { LobbyPlayer } from '../../hooks/useSession.js';

interface LastNominationOutcomeProps {
  nomination: ActiveNominationView;
  players: LobbyPlayer[];
}

function nameFor(players: LobbyPlayer[], id: string): string {
  return players.find((p) => p.playerId === id)?.displayName ?? 'Unknown';
}

/**
 * A small, persistent summary of the most recently resolved nomination,
 * shown alongside the NominationBar so the table has continuity (and can
 * see exactly how close a vote was) without it blocking a new nomination.
 */
export function LastNominationOutcome({ nomination, players }: LastNominationOutcomeProps) {
  const targetName = nameFor(players, nomination.targetId);

  let statusText: string;
  if (nomination.executed) {
    statusText = `${targetName} was executed`;
  } else if (nomination.pendingExecution) {
    statusText = `${targetName} met the threshold — awaiting the Storyteller's decision`;
  } else {
    statusText = `${targetName} was not executed`;
  }

  return (
    <div className="panel" style={{ padding: '10px 16px' }}>
      <p className="faint" style={{ margin: 0 }}>
        Last nomination: {statusText} ({nomination.votesFor}/{nomination.threshold} needed)
      </p>
    </div>
  );
}
