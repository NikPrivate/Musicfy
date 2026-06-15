import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { emit, socket } from '../socket.js';

export default function Home() {
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function createLobby() {
    setBusy(true);
    setError('');
    if (!socket.connected) socket.connect();
    const res = await emit('lobby:create');
    setBusy(false);
    if (res.ok) navigate(`/lobby/${res.code}`);
    else setError('Could not create lobby. Try again.');
  }

  async function joinLobby(e) {
    e.preventDefault();
    const c = code.trim().toUpperCase();
    if (!c) return;
    setError('');
    try {
      const r = await fetch(`/api/lobby/${c}`);
      if (!r.ok) return setError('No lobby with that code.');
      navigate(`/lobby/${c}`);
    } catch {
      setError('Network error. Is the server running?');
    }
  }

  return (
    <div className="home">
      <header className="hero">
        <h1>🎵 Musicfy</h1>
        <p className="tagline">The multiplayer “guess the song” party game.</p>
      </header>

      <div className="card home-actions">
        <button className="btn btn--primary btn--big" onClick={createLobby} disabled={busy}>
          {busy ? 'Creating…' : 'Create a lobby'}
        </button>

        <div className="divider"><span>or</span></div>

        <form onSubmit={joinLobby} className="join-form">
          <input
            placeholder="Enter lobby code"
            value={code}
            maxLength={5}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
          />
          <button className="btn" type="submit">Join</button>
        </form>

        {error && <p className="error">{error}</p>}
      </div>

      <ol className="how-to card">
        <li>Create a lobby and share the link with friends.</li>
        <li>Each round, one player picks a song &amp; the snippet to play.</li>
        <li>Everyone races to guess the title before the timer runs out.</li>
        <li>Stuck? Spend a clue to reveal a letter — but it costs points!</li>
      </ol>
    </div>
  );
}
