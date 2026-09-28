import { useEffect, useState } from 'react';
import { Navigate, Route, HashRouter, Routes, useParams, useNavigate } from 'react-router-dom';
import { HomePage } from './routes/HomePage.js';
import { LobbyPage } from './routes/LobbyPage.js';
import { StorytellerGamePage } from './routes/StorytellerGamePage.js';
import { PlayerGamePage } from './routes/PlayerGamePage.js';
import { useGameSocket } from './hooks/useGameSocket.js';
import { useSession } from './hooks/useSession.js';
import { ErrorToast } from './components/shared/ErrorToast.js';
import { ConnectionBanner } from './components/shared/ConnectionBanner.js';
import { OnboardingModal } from './components/onboarding/OnboardingModal.js';
import { clearStoredSession, getStoredSession, hasSeenOnboarding, markOnboardingSeen } from './api/storage.js';

function StorytellerRoute() {
  const { code } = useParams();
  const navigate = useNavigate();
  const stored = code ? getStoredSession(code) : null;
  const token = stored?.role === 'storyteller' ? stored.token : null;
  const { socket, status } = useGameSocket(token);
  const session = useSession(socket);

  if (!token) return <Navigate to="/" replace />;

  function leaveGame() {
    if (code) clearStoredSession(code);
    socket?.disconnect();
    navigate('/');
  }

  return (
    <>
      <ConnectionBanner status={status} />
      {session.phase === 'lobby' ? (
        <LobbyPage code={code ?? ''} socket={socket} session={session} isStoryteller />
      ) : (
        <StorytellerGamePage socket={socket} session={session} code={code ?? ''} onLeaveGame={leaveGame} />
      )}
      <ErrorToast error={session.lastError} />
    </>
  );
}

function PlayerRoute() {
  const { code } = useParams();
  const navigate = useNavigate();
  const stored = code ? getStoredSession(code) : null;
  const validToken = stored?.role === 'player' ? stored.token : null;
  const { socket, status } = useGameSocket(validToken);
  const session = useSession(socket);
  const [showOnboarding, setShowOnboarding] = useState(!hasSeenOnboarding());

  useEffect(() => {
    if (showOnboarding) return;
    markOnboardingSeen();
  }, [showOnboarding]);

  if (!validToken) return <Navigate to="/" replace />;

  const selfPlayerId = stored?.playerId ?? '';
  const alignment = session.distribution?.role === 'player' ? session.distribution.alignment : null;

  function leaveGame() {
    if (code) clearStoredSession(code);
    socket?.disconnect();
    navigate('/');
  }

  return (
    <>
      <ConnectionBanner status={status} />
      {session.phase === 'lobby' ? (
        <LobbyPage code={code ?? ''} socket={socket} session={session} isStoryteller={false} />
      ) : (
        <PlayerGamePage socket={socket} session={session} selfPlayerId={selfPlayerId} code={code ?? ''} onLeaveGame={leaveGame} />
      )}
      {showOnboarding && (
        <OnboardingModal
          alignment={alignment}
          onClose={() => {
            markOnboardingSeen();
            setShowOnboarding(false);
          }}
        />
      )}
      <ErrorToast error={session.lastError} />
    </>
  );
}

export function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/storyteller/:code" element={<StorytellerRoute />} />
        <Route path="/play/:code" element={<PlayerRoute />} />
      </Routes>
    </HashRouter>
  );
}
