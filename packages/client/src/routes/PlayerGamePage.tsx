import { useEffect, useState } from 'react';
import { ClientEvents } from '@clocktower/shared';
import type { Socket } from 'socket.io-client';
import type { SessionState } from '../hooks/useSession.js';
import { useSpeech } from '../hooks/useSpeech.js';
import { CharacterCard } from '../components/character/CharacterCard.js';
import { NominationBar } from '../components/voting/NominationBar.js';
import { VoteTally } from '../components/voting/VoteTally.js';
import { EvilChatPanel } from '../components/chat/EvilChatPanel.js';
import { OpenChatPanel } from '../components/chat/OpenChatPanel.js';
import { RulesReferencePanel } from '../components/onboarding/RulesReferencePanel.js';
import { ExecutionBanner } from '../components/shared/ExecutionBanner.js';
import { GameEndedBanner } from '../components/shared/GameEndedBanner.js';
import { SeatingCircle } from '../components/seating/SeatingCircle.js';
import { Graveyard } from '../components/seating/Graveyard.js';
import { PhaseTimer } from '../components/shared/PhaseTimer.js';
import { QuestionQueuePanel } from '../components/questions/QuestionQueuePanel.js';
import { RoleReferenceSection } from '../components/reference/RoleReferenceSection.js';
import { NightPromptPanel } from '../components/grimoire/NightPromptPanel.js';
import { TurnGuide } from '../components/flow/TurnGuide.js';
import type { LobbyPlayer } from '../hooks/useSession.js';

function SeatingCirclePanel({ players, selfPlayerId }: { players: LobbyPlayer[]; selfPlayerId: string }) {
  return (
    <div className="panel">
      <h3 style={{ marginTop: 0, textAlign: 'center' }}>Seating Circle</h3>
      <SeatingCircle players={players} selfPlayerId={selfPlayerId} />
      <Graveyard players={players} />
    </div>
  );
}

interface PlayerGamePageProps {
  socket: Socket | null;
  session: SessionState;
  selfPlayerId: string;
}

type Tab = 'character' | 'town' | 'questions' | 'discussion' | 'chat';

export function PlayerGamePage({ socket, session, selfPlayerId }: PlayerGamePageProps) {
  const [tab, setTab] = useState<Tab>('character');
  const [showRules, setShowRules] = useState(false);
  const [showSeating, setShowSeating] = useState(false);
  const [showRoles, setShowRoles] = useState(false);
  // The Storyteller's free-text result is dismissible, because it is private
  // information that must not be left sitting on a passed-around screen.
  const [dismissedResult, setDismissedResult] = useState<string | null>(null);
  const speech = useSpeech();

  const distribution = session.distribution;
  const isEvil = distribution?.role === 'player' && distribution.alignment === 'evil';
  const gameEnded = session.phase === 'ended';
  const canNominate = session.phase === 'day' && session.alive && !session.nomination;
  const canVote = session.phase === 'day' && !session.nomination?.closed && !gameEnded;
  const showAbilityResult = Boolean(session.abilityResult) && session.abilityResult !== dismissedResult;
  const hasNightActivity = Boolean(session.nightPrompt) || Boolean(session.nightResult);
  // A step with no legal target is never prompted, so this is normally false; the
  // flag keeps the guide from telling someone to go pick when there is nobody to pick.
  const stepIsUnmakeable = session.flow.unmakeableSteps.length > 0;

  function nominate(targetPlayerId: string) {
    socket?.emit(ClientEvents.PlayerNominate, { targetPlayerId });
  }

  function vote(voting: boolean) {
    if (session.nomination) {
      socket?.emit(ClientEvents.PlayerVote, { nominationId: session.nomination.nominationId, voting });
    }
  }

  // The TurnGuide's buttons point at a tab without owning the tab state.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail;
      if (detail === 'character' || detail === 'town' || detail === 'questions' || detail === 'discussion' || detail === 'chat') {
        setTab(detail);
      }
    };
    window.addEventListener('botc:goto-tab', handler);
    return () => window.removeEventListener('botc:goto-tab', handler);
  }, []);

  function sendChat(text: string) {
    socket?.emit(ClientEvents.ChatEvilSend, { text });
  }

  function sendOpenChat(text: string) {
    socket?.emit(ClientEvents.ChatOpenSend, { text });
  }

  function askQuestion(text: string) {
    socket?.emit(ClientEvents.PlayerAskQuestion, { text });
  }

  const executedName = session.lastExecutedPlayerId
    ? session.lobbyPlayers.find((p) => p.playerId === session.lastExecutedPlayerId)?.displayName
    : undefined;

  return (
    <div className="app-shell">
      <ExecutionBanner playerId={session.lastExecutedPlayerId} eventId={session.executionEventId} displayName={executedName} />
      {session.gameResult && <GameEndedBanner result={session.gameResult} />}

      <TurnGuide
        socket={socket}
        flow={session.flow}
        context={{
          playerId: selfPlayerId,
          alive: session.alive,
          hasOpenNightPrompt: Boolean(session.nightPrompt),
          hasSubmittedNightChoice: Boolean(session.nightResult),
          isEvil,
          stepIsUnmakeable:
            distribution?.role === 'player' &&
            session.flow.unmakeableSteps.some((u) => u.characterName === distribution.characterName),
        }}
        hasOpenNightPrompt={Boolean(session.nightPrompt)}
        speechEnabled={speech.enabled}
        onToggleSpeech={speech.setEnabled}
        speechSupported={speech.supported}
        hostIsAnnouncing={false}
      />

      <div className="panel" style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0 }}>
            {gameEnded ? 'Game Over' : session.phase === 'day' ? `Day ${session.dayNumber}` : `Night ${session.dayNumber}`}
          </h1>
          {!session.alive && <p className="alignment-evil" style={{ margin: 0 }}>You are dead. You may still vote once.</p>}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-inline" onClick={() => setShowSeating(true)}>
            🪑 Seating
          </button>
          <button className="btn btn-inline" onClick={() => setShowRoles(true)}>
            📜 Roles
          </button>
          <button className="btn btn-inline" onClick={() => setShowRules(true)}>
            Rules
          </button>
        </div>
      </div>

      <PhaseTimer phaseEndsAt={session.phaseEndsAt} phase={session.phase} />

      {hasNightActivity && tab === 'character' && (
        <NightPromptPanel
          socket={socket}
          prompt={session.nightPrompt}
          result={session.nightResult}
          // Only this player's own server-projected text is ever passed to the
          // voice. Nothing is read from the Grimoire, another player's entry, or
          // any Storyteller-only state, and the Spy's Grimoire is filtered out
          // inside the panel as well.
          onSpeak={speech.speak}
          speechEnabled={speech.enabled}
          onToggleSpeech={speech.setEnabled}
          speechSupported={speech.supported}
        />
      )}

      <div className="tab-bar">
        <button className={tab === 'character' ? 'active' : ''} onClick={() => setTab('character')}>
          My Character
        </button>
        <button className={tab === 'town' ? 'active' : ''} onClick={() => setTab('town')}>
          Town Square
        </button>
        <button className={tab === 'questions' ? 'active' : ''} onClick={() => setTab('questions')}>
          Questions
        </button>
        <button className={tab === 'discussion' ? 'active' : ''} onClick={() => setTab('discussion')}>
          Open Discussion
        </button>
        {isEvil && (
          <button className={tab === 'chat' ? 'active' : ''} onClick={() => setTab('chat')}>
            Evil Chat
          </button>
        )}
      </div>

      {tab === 'character' && distribution?.role === 'player' && (
        <div>
          <CharacterCard
            characterName={distribution.characterName}
            characterType={distribution.characterType}
            alignment={distribution.alignment}
            ability={distribution.ability}
          />
          {showAbilityResult && (
            <div className="panel">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                <h3 style={{ marginTop: 0 }}>Storyteller Update</h3>
                <button
                  className="btn btn-inline"
                  onClick={() => setDismissedResult(session.abilityResult)}
                  aria-label="Dismiss this update"
                >
                  Dismiss
                </button>
              </div>
              <p style={{ marginBottom: 0 }}>{session.abilityResult}</p>
            </div>
          )}
          {isEvil && distribution.teammates && distribution.teammates.length > 0 && (
            <div className="panel" style={{ borderColor: 'var(--evil-red)' }}>
              <h3 style={{ marginTop: 0 }} className="alignment-evil">
                Your Fellow Evil Players
              </h3>
              <ul>
                {distribution.teammates.map((t) => (
                  <li key={t.playerId}>
                    {t.displayName} — {t.characterName}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {isEvil && distribution.bluff && (
            <div className="panel">
              <h3 style={{ marginTop: 0 }}>Your Bluff (Not In Play)</h3>
              <p className="muted" style={{ margin: 0 }}>
                If asked, you may claim to be the <strong>{distribution.bluff.name}</strong>.
              </p>
            </div>
          )}
        </div>
      )}

      {tab === 'town' && (
        <div>
          <SeatingCirclePanel players={session.lobbyPlayers} selfPlayerId={selfPlayerId} />
          {session.nomination ? (
            <VoteTally
              nomination={session.nomination}
              players={session.lobbyPlayers}
              selfPlayerId={selfPlayerId}
              canVote={canVote}
              onVote={vote}
            />
          ) : (
            <NominationBar
              players={session.lobbyPlayers}
              selfPlayerId={selfPlayerId}
              canNominate={canNominate}
              onNominate={nominate}
            />
          )}
        </div>
      )}

      {tab === 'questions' && (
        <QuestionQueuePanel
          questions={session.questionQueue}
          canAsk={session.phase === 'day'}
          onAsk={askQuestion}
        />
      )}

      {tab === 'discussion' && (
        <OpenChatPanel messages={session.openChatMessages} selfPlayerId={selfPlayerId} onSend={sendOpenChat} />
      )}

      {tab === 'chat' && isEvil && (
        <EvilChatPanel messages={session.chatMessages} selfPlayerId={selfPlayerId} onSend={sendChat} />
      )}

      <div className="bottom-tab-bar">
        <button className={tab === 'character' ? 'active' : ''} onClick={() => setTab('character')}>
          You
        </button>
        <button className={tab === 'town' ? 'active' : ''} onClick={() => setTab('town')}>
          Town
        </button>
        <button className={tab === 'questions' ? 'active' : ''} onClick={() => setTab('questions')}>
          Q&A
        </button>
        <button className={tab === 'discussion' ? 'active' : ''} onClick={() => setTab('discussion')}>
          Talk
        </button>
        {isEvil && (
          <button className={tab === 'chat' ? 'active' : ''} onClick={() => setTab('chat')}>
            Chat
          </button>
        )}
      </div>

      {showRules && (
        <RulesReferencePanel
          onClose={() => setShowRules(false)}
          characterName={distribution?.role === 'player' ? distribution.characterName : undefined}
          ability={distribution?.role === 'player' ? distribution.ability : undefined}
        />
      )}

      {showSeating && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(5,5,8,0.82)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 500,
            padding: 16,
          }}
        >
          <div className="panel modal-panel" style={{ maxWidth: 360 }}>
            <h2 style={{ textAlign: 'center', marginTop: 0 }}>Seating Circle</h2>
            <SeatingCircle players={session.lobbyPlayers} selfPlayerId={selfPlayerId} />
            <Graveyard players={session.lobbyPlayers} />
            <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={() => setShowSeating(false)}>
              Close
            </button>
          </div>
        </div>
      )}

      {showRoles && <RoleReferenceSection onClose={() => setShowRoles(false)} />}
    </div>
  );
}
