import { useRef, useState } from 'react';
import { useAnnouncer } from '../hooks/useAnnouncer.js';
import { ClientEvents } from '@clocktower/shared';
import type { Socket } from 'socket.io-client';
import type { SessionState } from '../hooks/useSession.js';
import { GrimoireTable } from '../components/grimoire/GrimoireTable.js';
import { NightOrderPanel } from '../components/grimoire/NightOrderPanel.js';
import { NightDiscretionPanel } from '../components/grimoire/NightDiscretionPanel.js';
import { StorytellerScript } from '../components/flow/StorytellerScript.js';
import { EvilChatPanel } from '../components/chat/EvilChatPanel.js';
import { OpenChatPanel } from '../components/chat/OpenChatPanel.js';
import { ExecutionBanner } from '../components/shared/ExecutionBanner.js';
import { GameEndedBanner } from '../components/shared/GameEndedBanner.js';
import { SeatingCircle } from '../components/seating/SeatingCircle.js';
import { Graveyard } from '../components/seating/Graveyard.js';
import { PhaseTimer } from '../components/shared/PhaseTimer.js';
import { StorytellerQuestionPanel } from '../components/questions/StorytellerQuestionPanel.js';
import { RoleReferenceSection } from '../components/reference/RoleReferenceSection.js';
import { useDialogBehaviour, backdropClick } from '../hooks/useDialogBehaviour.js';

interface StorytellerGamePageProps {
  socket: Socket | null;
  session: SessionState;
}

const DEFAULT_TIMER_MINUTES = 5;

export function StorytellerGamePage({ socket, session }: StorytellerGamePageProps) {
  const [abilityTarget, setAbilityTarget] = useState('');
  const [abilityText, setAbilityText] = useState('');
  const [timerMinutes, setTimerMinutes] = useState(DEFAULT_TIMER_MINUTES);
  const [showRoles, setShowRoles] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [demonKillTarget, setDemonKillTarget] = useState('');
  const [confirmingEndGame, setConfirmingEndGame] = useState(false);
  const [dismissedInheritance, setDismissedInheritance] = useState(false);
  // The host device doubles as the table's PA system for PUBLIC flow lines only.
  const announcer = useAnnouncer();
  // Escape, backdrop tap and focus handling for the tools sheet.
  const stSheetRef = useRef<HTMLDivElement | null>(null);
  useDialogBehaviour(moreOpen, () => setMoreOpen(false), stSheetRef);

  const grimoire = session.grimoire ?? [];

  function togglePhase() {
    socket?.emit(ClientEvents.StorytellerSetPhase, {
      phase: session.phase === 'day' ? 'night' : 'day',
      timerSeconds: timerMinutes > 0 ? timerMinutes * 60 : undefined,
    });
  }

  function startTimer() {
    socket?.emit(ClientEvents.StorytellerSetTimer, { timerSeconds: timerMinutes * 60 });
  }

  function clearTimer() {
    socket?.emit(ClientEvents.StorytellerSetTimer, { timerSeconds: null });
  }

  function toggleStatus(playerId: string, key: 'poisoned' | 'drunk' | 'protected') {
    const entry = grimoire.find((g) => g.playerId === playerId);
    if (!entry) return;
    socket?.emit(ClientEvents.StorytellerSetPlayerStatus, {
      playerId,
      statusEffects: { [key]: !entry.statusEffects[key] },
    });
  }

  function markDead(playerId: string) {
    socket?.emit(ClientEvents.StorytellerMarkDead, { playerId });
  }

  function sendAbilityResult() {
    if (!abilityTarget || !abilityText.trim()) return;
    socket?.emit(ClientEvents.StorytellerShareAbilityResult, { playerId: abilityTarget, text: abilityText.trim() });
    setAbilityText('');
  }

  function answerQuestion(questionId: string, answer: string) {
    socket?.emit(ClientEvents.StorytellerAnswerQuestion, { questionId, answer });
  }

  function sendOpenChat(text: string) {
    socket?.emit(ClientEvents.ChatOpenSend, { text });
  }

  function demonKill() {
    if (!demonKillTarget) return;
    socket?.emit(ClientEvents.StorytellerDemonKill, { targetPlayerId: demonKillTarget });
    setDemonKillTarget('');
  }

  function endGame(winner: 'good' | 'evil') {
    socket?.emit(ClientEvents.StorytellerEndGame, { winner });
    setConfirmingEndGame(false);
  }

  function moveSeat(playerId: string, direction: 'left' | 'right') {
    const seated = [...grimoire].sort((a, b) => a.seatIndex - b.seatIndex);
    const index = seated.findIndex((p) => p.playerId === playerId);
    if (index === -1) return;
    const swapWith = direction === 'right' ? index + 1 : index - 1;
    const wrapped = (swapWith + seated.length) % seated.length;
    const reordered = [...seated];
    [reordered[index], reordered[wrapped]] = [reordered[wrapped]!, reordered[index]!];
    socket?.emit(ClientEvents.StorytellerReorderSeats, { orderedPlayerIds: reordered.map((p) => p.playerId) });
  }

  const executedName = session.lastExecutedPlayerId
    ? grimoire.find((g) => g.playerId === session.lastExecutedPlayerId)?.displayName
    : undefined;

  const gameEnded = session.phase === 'ended';
  const livingDemon = grimoire.find((g) => g.alive && g.characterType === 'demon');
  const inheritanceNotice =
    session.demonInherited && !dismissedInheritance ? session.demonInherited : null;
  const inheritedName = inheritanceNotice
    ? grimoire.find((g) => g.playerId === inheritanceNotice.newDemonPlayerId)?.displayName
    : undefined;

  return (
    <div className="app-shell">
      <ExecutionBanner playerId={session.lastExecutedPlayerId} eventId={session.executionEventId} displayName={executedName} />
      {session.gameResult && <GameEndedBanner result={session.gameResult} />}
      {inheritanceNotice && (
        <div className="panel" style={{ borderColor: 'var(--evil-red)', textAlign: 'center' }}>
          <p className="alignment-evil" style={{ margin: 0, fontWeight: 600 }}>
            🎭 {inheritedName ?? 'A Minion'} has secretly become the new Demon. To everyone else, they're still their
            original character — only you know the truth.
          </p>
          <button className="btn btn-inline" style={{ marginTop: 8 }} onClick={() => setDismissedInheritance(true)}>
            Got it
          </button>
        </div>
      )}

      <StorytellerScript
        socket={socket}
        flow={session.flow}
        announcer={announcer}
        nightResolved={Boolean(session.nightOrder?.resolved)}
        readyToResolve={Boolean(session.nightOrder) && session.nightOrder!.outstandingCharacterIds.length === 0}
        outstanding={session.nightOrder?.outstandingCharacterIds ?? []}
      />

      {/*
        The nomination is the Storyteller's job while it is open, so it sits directly
        under the script rather than in a panel of its own further down the page. It
        used to appear twice: here, and as "Close the vote" / "Execute X" inside the
        script. One place, one button.
      */}
      {session.nomination && !gameEnded && (
        <div className="panel" data-testid="active-nomination">
          <h2 style={{ marginTop: 0 }}>On the block</h2>
          <p style={{ margin: '0 0 8px' }}>
            <strong>{grimoire.find((g) => g.playerId === session.nomination!.targetId)?.displayName}</strong> was
            nominated by {grimoire.find((g) => g.playerId === session.nomination!.nominatorId)?.displayName}.{' '}
            <strong>{session.nomination.votes.filter((v) => v.voting).length}</strong> vote
            {session.nomination.votes.filter((v) => v.voting).length === 1 ? '' : 's'} for execution
            {session.nomination.executionThreshold > 0 && (
              <>
                , and <strong>{session.nomination.executionThreshold}</strong> is enough
              </>
            )}
            .
          </p>
          {/* Information only. The controls live in the script above, which is the
              panel whose entire job is "what to do now" — and having "Close the
              vote" in both meant two identical primary buttons one screen apart,
              which is the same mistake the player's duplicate tab bars were. */}
          {session.nomination.executed ? (
            <p style={{ margin: 0 }}>
              <strong>{grimoire.find((g) => g.playerId === session.nomination!.targetId)?.displayName}</strong> was
              executed.
            </p>
          ) : session.nomination.pendingExecution ? (
            <p className="alignment-evil" style={{ margin: 0, fontWeight: 600 }}>
              This nomination met the threshold. Execute them when the table is ready.
            </p>
          ) : session.nomination.closed ? (
            <p className="faint" style={{ margin: 0 }}>
              This nomination did not pass. Nothing happens — a player who has not yet nominated can try again.
            </p>
          ) : (
            <p className="faint" style={{ margin: 0 }}>
              Voting is open. Everyone may change their vote until you close it.
            </p>
          )}
        </div>
      )}

      <PhaseTimer phaseEndsAt={session.phaseEndsAt} phase={session.phase} />

      {/*
        Grimoire and seating stay in view: a Storyteller needs the roles and the
        neighbour order in front of them all night, and those are not "options" the
        way a timer or a chat log is. Everything that IS an option — the manual
        overrides, the timer, the night order and its log, the discretion queue, the
        free-text result sender, the questions and the chats — is behind one button.
      */}
      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Grimoire</h2>
        <GrimoireTable grimoire={grimoire} onToggleStatus={toggleStatus} onMarkDead={markDead} />
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0, textAlign: 'center' }}>Seating Circle</h2>
        <p className="faint" style={{ textAlign: 'center', marginTop: -8 }}>
          Use the arrows to swap a player with their neighbor.
        </p>
        <SeatingCircle players={grimoire} onMoveSeat={moveSeat} />
        <Graveyard players={grimoire} />
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button className="btn btn-inline" onClick={() => setMoreOpen(true)} data-testid="st-more-button">
          More
        </button>
      </div>

      {moreOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Storyteller tools"
          data-testid="st-more-sheet"
          ref={(el) => {
            stSheetRef.current = el;
          }}
          onClick={backdropClick(stSheetRef, () => setMoreOpen(false))}
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
              maxWidth: 760,
              width: '100%',
              maxHeight: '88vh',
              overflowY: 'auto',
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
              <h2 style={{ margin: 0, whiteSpace: 'nowrap' }}>Storyteller tools</h2>
              <button className="btn btn-inline" onClick={() => setMoreOpen(false)} data-testid="st-more-close">
                Close
              </button>
            </div>

            <section style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                className="btn btn-inline"
                onClick={() => {
                  setMoreOpen(false);
                  setShowRoles(true);
                }}
              >
                All characters
              </button>
              <button className="btn btn-primary" onClick={togglePhase} disabled={gameEnded}>
                Switch to {session.phase === 'day' ? 'Night' : 'Day'}
              </button>
            </section>

      {!gameEnded && (
        <div className="panel" style={{ borderColor: 'var(--evil-red)' }}>
          <h2 style={{ marginTop: 0 }}>Game Control</h2>
          <div className="mobile-stack" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <select
              className="input"
              style={{ minWidth: 200 }}
              value={demonKillTarget}
              onChange={(e) => setDemonKillTarget(e.target.value)}
            >
              <option value="">Demon kills a player…</option>
              {grimoire
                .filter((g) => g.alive)
                .map((g) => (
                  <option key={g.playerId} value={g.playerId}>
                    {g.displayName}
                    {g.playerId === livingDemon?.playerId ? ' (Demon)' : ''}
                  </option>
                ))}
            </select>
            <button
              className="btn btn-inline btn-danger"
              onClick={demonKill}
              disabled={!demonKillTarget || !livingDemon || session.phase !== 'night'}
            >
              Kill
            </button>
          </div>
          <p className="faint" style={{ marginTop: 8 }}>
            {session.phase !== 'night'
              ? 'The Demon can only kill at night — switch the phase to night first.'
              : livingDemon
                ? 'Manual override for the night kill. The night engine normally applies the Imp’s own choice; use this when you are intervening. A self-kill hands the role to the Minion you picked in Discretion, or to a random one if you did not.'
                : 'No living Demon — the kill action is unavailable.'}
          </p>

          <div style={{ marginTop: 16, borderTop: '1px solid var(--border-color, rgba(255,255,255,0.1))', paddingTop: 16 }}>
            {!confirmingEndGame ? (
              <button className="btn btn-inline btn-danger" onClick={() => setConfirmingEndGame(true)}>
                End Game…
              </button>
            ) : (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span className="muted">Declare a winner:</span>
                <button className="btn btn-inline" onClick={() => endGame('good')}>
                  Good wins
                </button>
                <button className="btn btn-inline btn-danger" onClick={() => endGame('evil')}>
                  Evil wins
                </button>
                <button className="btn btn-inline" onClick={() => setConfirmingEndGame(false)}>
                  Cancel
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Phase Timer</h2>
        <div className="mobile-stack" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              className="input"
              type="number"
              min={1}
              max={60}
              style={{ width: 70 }}
              value={timerMinutes}
              onChange={(e) => setTimerMinutes(Math.max(1, Number(e.target.value) || 1))}
            />
            minutes
          </label>
          <button className="btn btn-inline" onClick={startTimer}>
            Start Timer
          </button>
          <button className="btn btn-inline" onClick={clearTimer} disabled={!session.phaseEndsAt}>
            Clear Timer
          </button>
        </div>
        <p className="faint" style={{ marginTop: 8 }}>
          The duration above is also used automatically when you switch phases with "Switch to Day/Night".
        </p>
      </div>

      <NightOrderPanel socket={socket} nightOrder={session.nightOrder} nightLog={session.nightLog} />

      <NightDiscretionPanel socket={socket} grimoire={grimoire} nightNumber={session.nightNumber} />

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Share an Ability Result</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 420 }}>
          <select className="input" value={abilityTarget} onChange={(e) => setAbilityTarget(e.target.value)}>
            <option value="">Choose a player…</option>
            {grimoire.map((g) => (
              <option key={g.playerId} value={g.playerId}>
                {g.displayName}
              </option>
            ))}
          </select>
          <input
            className="input"
            placeholder="Result text to share with them"
            value={abilityText}
            onChange={(e) => setAbilityText(e.target.value)}
          />
          <button className="btn btn-primary" onClick={sendAbilityResult} disabled={!abilityTarget || !abilityText.trim()}>
            Send
          </button>
        </div>
      </div>

      <StorytellerQuestionPanel questions={session.questionQueue} onAnswer={answerQuestion} />

      <OpenChatPanel messages={session.openChatMessages} onSend={sendOpenChat} />

      <EvilChatPanel messages={session.chatMessages} onSend={() => {}} readOnly />

          </div>
        </div>
      )}

      {showRoles && <RoleReferenceSection onClose={() => setShowRoles(false)} />}
    </div>
  );
}
