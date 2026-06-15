import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { socket, emit } from '../socket.js';
import { getClientId, getProfile, saveProfile, hasProfile } from '../identity.js';
import ProfileSetup from '../components/ProfileSetup.jsx';
import PlayerList from '../components/PlayerList.jsx';
import SongPicker from '../components/SongPicker.jsx';
import SnippetPlayer from '../components/SnippetPlayer.jsx';

export default function Room() {
  const { code } = useParams();
  const clientId = getClientId();

  const [state, setState] = useState(null); // public lobby state
  const [joined, setJoined] = useState(false);
  const [notFound, setNotFound] = useState(false);
  // needProfile drives whether we show the setup screen. If the user already
  // has a saved profile we skip it and auto-join — so re-clicking the share
  // link never spawns a duplicate player.
  const [needProfile, setNeedProfile] = useState(!hasProfile());

  // Keep a ref so socket reconnect handlers always have the latest values.
  const joinRef = useRef({ code, clientId });
  joinRef.current = { code, clientId };

  // Join (or rejoin) the lobby with the current profile.
  async function doJoin(profile) {
    const res = await emit('lobby:join', { code, clientId, profile });
    if (!res.ok) {
      setNotFound(true);
      return;
    }
    setState(res.state);
    setJoined(true);
    setNeedProfile(false);
  }

  // Auto-join on mount if we already have a profile.
  useEffect(() => {
    if (!socket.connected) socket.connect();

    function onState(s) {
      setState(s);
    }
    socket.on('lobby:state', onState);

    // On (re)connect, transparently rejoin using our stable clientId so a
    // dropped connection never turns into a second player.
    function onConnect() {
      const p = getProfile();
      if (p && p.username) doJoin(p);
    }
    socket.on('connect', onConnect);

    if (hasProfile()) {
      doJoin(getProfile());
    } else {
      // Verify the lobby exists before showing the profile form.
      fetch(`/api/lobby/${code}`).then((r) => {
        if (!r.ok) setNotFound(true);
      });
    }

    return () => {
      socket.off('lobby:state', onState);
      socket.off('connect', onConnect);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  function handleProfileSubmit(profile) {
    saveProfile(profile);
    doJoin(profile);
  }

  if (notFound) {
    return (
      <div className="card centered">
        <h2>Lobby not found 😕</h2>
        <p className="muted">The code “{code}” doesn’t match an active lobby.</p>
        <a className="btn" href="/">← Back home</a>
      </div>
    );
  }

  if (needProfile && !joined) {
    return (
      <div className="room">
        <ShareBar code={code} />
        <ProfileSetup initial={getProfile()} onSubmit={handleProfileSubmit} />
      </div>
    );
  }

  if (!state) {
    return <div className="card centered">Connecting to lobby…</div>;
  }

  const you = state.players.find((p) => p.clientId === clientId);
  const isHost = state.hostClientId === clientId;
  const isChooser = state.chooserClientId === clientId;

  return (
    <div className="room">
      <ShareBar code={code} />

      <div className="room-grid">
        <aside className="card sidebar">
          <h3>
            Players <span className="muted">({state.players.length})</span>
          </h3>
          <PlayerList players={state.players} youId={clientId} />
          {state.phase !== 'lobby' && (
            <p className="round-indicator">
              Round {state.roundNumber} / {state.totalRounds}
            </p>
          )}
        </aside>

        <main className="stage">
          <Stage
            state={state}
            you={you}
            isHost={isHost}
            isChooser={isChooser}
            clientId={clientId}
          />
        </main>
      </div>
    </div>
  );
}

// ---- Share bar -----------------------------------------------------------

function ShareBar({ code }) {
  const [copied, setCopied] = useState(false);
  const link = `${window.location.origin}/lobby/${code}`;

  async function share() {
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Join my Musicfy game!', url: link });
        return;
      }
    } catch {
      /* user cancelled native share */
    }
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      window.prompt('Copy this link:', link);
    }
  }

  return (
    <div className="share-bar card">
      <div>
        <span className="muted">Lobby code</span>
        <strong className="code">{code}</strong>
      </div>
      <button className="btn btn--primary" onClick={share}>
        {copied ? '✓ Link copied!' : '🔗 Share invite link'}
      </button>
    </div>
  );
}

// ---- Stage (phase router) ------------------------------------------------

function Stage({ state, you, isHost, isChooser, clientId }) {
  switch (state.phase) {
    case 'lobby':
      return <LobbyStage state={state} isHost={isHost} />;
    case 'selecting':
      return <SelectingStage state={state} isChooser={isChooser} />;
    case 'playing':
      return <PlayingStage state={state} isChooser={isChooser} you={you} />;
    case 'roundEnd':
      return <RoundEndStage state={state} isHost={isHost} />;
    case 'gameEnd':
      return <GameEndStage state={state} isHost={isHost} clientId={clientId} />;
    default:
      return null;
  }
}

// ---- Lobby (waiting room + settings) -------------------------------------

function LobbyStage({ state, isHost }) {
  const [settings, setSettings] = useState(state.settings);
  const [error, setError] = useState('');

  async function start() {
    setError('');
    const res = await emit('game:start', { settings });
    if (!res.ok) setError(res.error || 'Could not start the game.');
  }

  return (
    <div className="card">
      <h2>Waiting room</h2>
      <p className="muted">
        Share the invite link above. Once everyone’s in, the host starts the game.
      </p>

      <div className="settings">
        <label className="field">
          <span>Rounds</span>
          <input
            type="number"
            min="1"
            max="20"
            disabled={!isHost}
            value={settings.totalRounds}
            onChange={(e) => setSettings({ ...settings, totalRounds: +e.target.value })}
          />
        </label>
        <label className="field">
          <span>Guess timer (sec)</span>
          <input
            type="number"
            min="10"
            max="300"
            disabled={!isHost}
            value={settings.roundTimer}
            onChange={(e) => setSettings({ ...settings, roundTimer: +e.target.value })}
          />
        </label>
        <label className="field">
          <span>Default snippet (sec)</span>
          <input
            type="number"
            min="3"
            max="60"
            disabled={!isHost}
            value={settings.snippetDuration}
            onChange={(e) => setSettings({ ...settings, snippetDuration: +e.target.value })}
          />
        </label>
      </div>

      {error && <p className="error">{error}</p>}

      {isHost ? (
        <button
          className="btn btn--primary btn--big"
          onClick={start}
          disabled={state.players.length < 2}
        >
          {state.players.length < 2 ? 'Need at least 2 players…' : 'Start game 🎉'}
        </button>
      ) : (
        <p className="muted">Waiting for the host to start…</p>
      )}
    </div>
  );
}

// ---- Selecting -----------------------------------------------------------

function SelectingStage({ state, isChooser }) {
  if (isChooser) {
    return <SongPicker defaultDuration={state.settings.snippetDuration} />;
  }
  const chooser = state.players.find((p) => p.clientId === state.chooserClientId);
  return (
    <div className="card centered">
      <h2>🎶 {chooser?.username || 'Someone'} is picking a song…</h2>
      <p className="muted">Get ready to guess!</p>
      <div className="pulse">🎧</div>
    </div>
  );
}

// ---- Playing -------------------------------------------------------------

function PlayingStage({ state, isChooser, you }) {
  const round = state.round;
  const remaining = useCountdown(state.roundEndsAt);
  const [guess, setGuess] = useState('');
  const [feedback, setFeedback] = useState('');
  const alreadyGuessed = you?.hasGuessed;

  async function submitGuess(e) {
    e.preventDefault();
    if (!guess.trim()) return;
    const res = await emit('round:guess', { guess });
    if (res.correct) {
      setFeedback(`✅ Correct! +${res.points} points`);
      setGuess('');
    } else {
      setFeedback('❌ Not quite — try again!');
      setTimeout(() => setFeedback(''), 1500);
    }
  }

  async function getClue() {
    const res = await emit('round:clue');
    if (!res.revealed) setFeedback('No more letters to reveal.');
  }

  return (
    <div className="card playing">
      <div className="timer-bar">
        <span className={`timer ${remaining <= 10 ? 'urgent' : ''}`}>⏱ {remaining}s</span>
        {round?.artistHint && <span className="muted">Artist: {round.artistHint}</span>}
      </div>

      <SnippetPlayer
        url={round.audio.url}
        startTime={round.audio.startTime}
        duration={round.audio.duration}
        autoPlay={!isChooser}
      />

      <div className="masked">{round.masked.split('').map((c, i) => (
        <span key={i} className={c === '_' ? 'mask-blank' : 'mask-char'}>{c === ' ' ? '  ' : c}</span>
      ))}</div>
      <p className="muted clue-count">Clues used: {round.cluesUsed}</p>

      {isChooser ? (
        <ChooserView />
      ) : alreadyGuessed ? (
        <p className="success">🎉 You got it! Waiting for the round to end…</p>
      ) : (
        <form className="guess-form" onSubmit={submitGuess}>
          <input
            autoFocus
            placeholder="Type your guess…"
            value={guess}
            onChange={(e) => setGuess(e.target.value)}
          />
          <button className="btn btn--primary" type="submit">Guess</button>
          <button className="btn" type="button" onClick={getClue} title="Reveal a letter (costs points)">
            💡 Clue
          </button>
        </form>
      )}
      {feedback && <p className="feedback">{feedback}</p>}
    </div>
  );
}

// The chooser knows the answer — show it privately so they can confirm the
// snippet is right; they can't guess.
function ChooserView() {
  const [answer, setAnswer] = useState('');
  useEffect(() => {
    function onAnswer({ title }) {
      setAnswer(title);
    }
    socket.on('round:answer', onAnswer);
    return () => socket.off('round:answer', onAnswer);
  }, []);
  return (
    <div className="chooser-view">
      <p className="muted">You picked this round — sit back and watch the guesses roll in.</p>
      {answer && <p className="answer-reveal">Answer: <strong>{answer}</strong></p>}
    </div>
  );
}

// ---- Round end -----------------------------------------------------------

function RoundEndStage({ state, isHost }) {
  const answer = state.round?.answer;
  async function next() {
    await emit('round:next');
  }
  return (
    <div className="card centered">
      <h2>Round {state.roundNumber} over!</h2>
      <p className="answer-reveal">The song was: <strong>{answer}</strong></p>
      <h3>Scoreboard</h3>
      <PlayerList players={state.players} youId={null} />
      {isHost ? (
        <button className="btn btn--primary btn--big" onClick={next}>
          {state.roundNumber >= state.totalRounds ? 'See final results →' : 'Next round →'}
        </button>
      ) : (
        <p className="muted">Waiting for the host to continue…</p>
      )}
    </div>
  );
}

// ---- Game end ------------------------------------------------------------

function GameEndStage({ state, isHost }) {
  const winner = state.players[0];
  async function again() {
    await emit('game:reset');
  }
  return (
    <div className="card centered">
      <h2>🏆 Game over!</h2>
      {winner && (
        <p className="winner">
          Winner: <strong>{winner.username}</strong> with {winner.score} points!
        </p>
      )}
      <h3>Final scoreboard</h3>
      <PlayerList players={state.players} youId={null} />
      {isHost ? (
        <button className="btn btn--primary btn--big" onClick={again}>Play again 🔁</button>
      ) : (
        <p className="muted">Waiting for the host to start a new game…</p>
      )}
    </div>
  );
}

// ---- helpers -------------------------------------------------------------

function useCountdown(endsAt) {
  const [remaining, setRemaining] = useState(() => calc(endsAt));
  useEffect(() => {
    setRemaining(calc(endsAt));
    const id = setInterval(() => setRemaining(calc(endsAt)), 250);
    return () => clearInterval(id);
  }, [endsAt]);
  return remaining;
}

function calc(endsAt) {
  if (!endsAt) return 0;
  return Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
}
