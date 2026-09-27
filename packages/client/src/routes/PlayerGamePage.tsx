import { useState } from 'react';
import { ClientEvents, derivePlayerMoment, type PlayerFlowContext } from '@clocktower/shared';
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
import { PlayerMomentCard } from '../components/flow/PlayerMomentCard.js';

interface PlayerGamePageProps {
  socket: Socket | null;
  session: SessionState;
  selfPlayerId: string;
}

/**
 * The player's whole game, in one column.
 *
 * This used to be five tabs rendered twice — once along the top and once along the
 * bottom, with different labels for the same destinations ("My Character" / "You",
 * "Town Square" / "Town", "Questions" / "Q&A", "Open Discussion" / "Talk") — plus
 * three more buttons in a header, one of which opened a Seating view that also
 * existed inside a tab. Nothing was ever in the right place: the night prompt sat
 * above the tabs while the instruction said "your prompt is below", and the
 * day-time instruction told people to go and find the nomination control on
 * another tab.
 *
 * So there are no tabs now. There is:
 *
 *   1. the one thing to do now, with its control directly beneath it;
 *   2. the quiet things — your character, the seating, the reference, the
 *      questions, the chats — behind a single "More" button.
 *
 * Nothing has been removed. It has been demoted, which is the difference: a player
 * who needs their character can still have it in two taps, and a player who does
 * not is never asked to look at it.
 */
export function PlayerGamePage({ socket, session, selfPlayerId }: PlayerGamePageProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const [showRules, setShowRules] = useState(false);
  const [showRoles, setShowRoles] = useState(false);
  // The Storyteller's free-text result is dismissible, because it is private
  // information that must not be left sitting on a passed-around screen.
  const [dismissedResult, setDismissedResult] = useState<string | null>(null);
  const speech = useSpeech();

  const distribution = session.distribution;
  const isEvil = distribution?.role === 'player' && distribution.alignment === 'evil';
  const gameEnded = session.phase === 'ended';
  // A CLOSED nomination does not block a new one — the server only refuses while a
  // vote is open (rules.ts). It used to be `!session.nomination`, so after a failed
  // execution vote every player was left staring at "This nomination did not pass"
  // with no way to nominate anybody else for the rest of the day. Found by playing a
  // game where the vote did not reach the threshold.
  const voteOpen = Boolean(session.nomination && !session.nomination.closed);
  const nominatedToday = session.lobbyPlayers.find((p) => p.playerId === selfPlayerId)?.hasNominatedToday ?? false;
  const canNominate = session.phase === 'day' && session.alive && !voteOpen && !nominatedToday;
  const canVote = session.phase === 'day' && !session.nomination?.closed && !gameEnded;
  const showAbilityResult = Boolean(session.abilityResult) && session.abilityResult !== dismissedResult;

  const context: PlayerFlowContext = {
    playerId: selfPlayerId,
    alive: session.alive,
    hasOpenNightPrompt: Boolean(session.nightPrompt),
    hasSubmittedNightChoice: Boolean(session.nightResult),
    // Whether THIS player's own step is unmakeable. It used to be "the night has
    // any unmakeable step at all", which told every player their own character had
    // nobody to choose.
    stepIsUnmakeable:
      distribution?.role === 'player' &&
      session.flow.unmakeableSteps.some((u) => u.characterName === distribution.characterName),
    isEvil,
  };
  const moment = derivePlayerMoment(session.flow, context);

  function nominate(targetPlayerId: string) {
    socket?.emit(ClientEvents.PlayerNominate, { targetPlayerId });
  }

  function vote(voting: boolean) {
    if (session.nomination) {
      socket?.emit(ClientEvents.PlayerVote, { nominationId: session.nomination.nominationId, voting });
    }
  }

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

  /**
   * The single control for this moment, in view. Everything a player is ever asked
   * to do is reachable from here without navigating anywhere.
   */
  function actionForThisMoment() {
    if (moment.showNightPrompt) {
      return (
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
        />
      );
    }

    if (moment.action === 'nominate') {
      // Only an OPEN vote displaces the nomination control. A closed one, whether it
      // passed or not, is history.
      return voteOpen && session.nomination ? (
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
      );
    }

    // Awake with nothing to choose: there is no control, so show the one thing that
    // makes "just listen to the Storyteller" meaningful — the ability they are about
    // to be told about. An empty screen with that instruction is not an answer.
    if (moment.kind === 'awake-listen' && distribution?.role === 'player') {
      return (
        <CharacterCard
          characterName={distribution.characterName}
          characterType={distribution.characterType}
          alignment={distribution.alignment}
          ability={distribution.ability}
        />
      );
    }

    if (moment.action === 'vote' && session.nomination) {
      return (
        <VoteTally
          nomination={session.nomination}
          players={session.lobbyPlayers}
          selfPlayerId={selfPlayerId}
          canVote={canVote}
          onVote={vote}
        />
      );
    }

    return null;
  }

  return (
    <div className="app-shell">
      <ExecutionBanner
        playerId={session.lastExecutedPlayerId}
        eventId={session.executionEventId}
        displayName={executedName}
      />
      {session.gameResult && <GameEndedBanner result={session.gameResult} />}

      <PlayerMomentCard
        flow={session.flow}
        context={context}
        action={actionForThisMoment()}
        speechEnabled={speech.enabled}
        onToggleSpeech={speech.setEnabled}
        speechSupported={speech.supported}
        hostIsAnnouncing={false}
      />

      <PhaseTimer phaseEndsAt={session.phaseEndsAt} phase={session.phase} />

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button className="btn btn-inline" onClick={() => setMoreOpen(true)} data-testid="more-button">
          More
        </button>
      </div>

      {moreOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Everything else"
          data-testid="more-sheet"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(5,5,8,0.85)',
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'center',
            zIndex: 500,
            padding: 0,
          }}
        >
          <div
            className="panel modal-panel"
            style={{
              maxWidth: 720,
              width: '100%',
              maxHeight: '88vh',
              overflowY: 'auto',
              margin: 0,
              borderBottomLeftRadius: 0,
              borderBottomRightRadius: 0,
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 12,
                position: 'sticky',
                top: 0,
                background: 'var(--bg-panel)',
                padding: '4px 0 12px',
                marginBottom: 4,
                borderBottom: '1px solid var(--border-subtle)',
              }}
            >
              <h2 style={{ margin: 0, whiteSpace: 'nowrap' }}>Everything else</h2>
              <button className="btn btn-inline" onClick={() => setMoreOpen(false)} data-testid="more-close">
                Close
              </button>
            </div>

            {distribution?.role === 'player' && (
              <section style={{ marginTop: 16 }}>
                <h3 style={{ marginTop: 0 }}>Your character</h3>
                <CharacterCard
                  characterName={distribution.characterName}
                  characterType={distribution.characterType}
                  alignment={distribution.alignment}
                  ability={distribution.ability}
                />
                {showAbilityResult && (
                  <div className="panel">
                    <div
                      style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}
                    >
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
              </section>
            )}

            <section style={{ marginTop: 20 }}>
              <h3 style={{ marginTop: 0 }}>Who is sitting where</h3>
              <SeatingCircle players={session.lobbyPlayers} selfPlayerId={selfPlayerId} />
              <Graveyard players={session.lobbyPlayers} />
            </section>

            {!gameEnded && (
              <section style={{ marginTop: 20 }}>
                <h3 style={{ marginTop: 0 }}>Talk</h3>
                <OpenChatPanel
                  messages={session.openChatMessages}
                  selfPlayerId={selfPlayerId}
                  onSend={sendOpenChat}
                />
                {isEvil && (
                  <div style={{ marginTop: 12 }}>
                    <h3 style={{ marginTop: 0 }} className="alignment-evil">
                      Evil Chat (only your team can see this)
                    </h3>
                    <EvilChatPanel
                      messages={session.chatMessages}
                      selfPlayerId={selfPlayerId}
                      onSend={sendChat}
                    />
                  </div>
                )}
              </section>
            )}

            <section style={{ marginTop: 20 }}>
              <QuestionQueuePanel
                questions={session.questionQueue}
                canAsk={session.phase === 'day'}
                onAsk={askQuestion}
              />
            </section>

            <section style={{ marginTop: 20, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                className="btn btn-inline"
                onClick={() => {
                  setMoreOpen(false);
                  setShowRoles(true);
                }}
              >
                All characters
              </button>
              <button
                className="btn btn-inline"
                onClick={() => {
                  setMoreOpen(false);
                  setShowRules(true);
                }}
              >
                How this works
              </button>
            </section>
          </div>
        </div>
      )}

      {showRules && (
        <RulesReferencePanel
          onClose={() => setShowRules(false)}
          characterName={distribution?.role === 'player' ? distribution.characterName : undefined}
          ability={distribution?.role === 'player' ? distribution.ability : undefined}
        />
      )}

      {showRoles && <RoleReferenceSection onClose={() => setShowRoles(false)} />}
    </div>
  );
}
