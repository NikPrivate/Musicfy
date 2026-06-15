import { useEffect, useRef, useState } from 'react';
import { emit } from '../socket.js';
import SnippetPlayer from './SnippetPlayer.jsx';

// Every player uses this during the submission phase: type a song name, pick
// from live suggestions (iTunes), then choose *which part* of the ~30s preview
// to play. The twist of the game lives here — you control the snippet.
export default function SongSearch({ defaultDuration = 15, alreadySubmitted = false }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState(null); // a search result
  const [startTime, setStartTime] = useState(0);
  const [duration, setDuration] = useState(defaultDuration);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // What we last locked in (for the confirmation card). Null after a reconnect
  // since the choice isn't persisted client-side — we fall back to a generic
  // "locked in" card using the server's hasSubmitted flag.
  const [mySong, setMySong] = useState(null);
  const [editing, setEditing] = useState(!alreadySubmitted);

  const debounce = useRef(null);
  const previewLength = selected?.previewLength || 30;
  const maxStart = Math.max(0, previewLength - duration);

  // Debounced live search as the player types.
  useEffect(() => {
    clearTimeout(debounce.current);
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    debounce.current = setTimeout(async () => {
      try {
        const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        const data = await r.json();
        setResults(data.results || []);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(debounce.current);
  }, [query]);

  function pick(result) {
    setSelected(result);
    setResults([]);
    setQuery(`${result.title} — ${result.artist}`);
    setStartTime(0);
    setDuration(Math.min(defaultDuration, result.previewLength || 30));
    setError('');
  }

  async function submit() {
    if (!selected) return setError('Pick a song from the suggestions first.');
    setBusy(true);
    setError('');
    const res = await emit('song:submit', {
      song: {
        title: selected.title,
        artist: selected.artist,
        audioUrl: selected.previewUrl,
        artwork: selected.artwork,
        startTime: Math.min(startTime, maxStart),
        duration,
      },
    });
    setBusy(false);
    if (res.ok) {
      setMySong({
        title: selected.title,
        artist: selected.artist,
        artwork: selected.artwork,
        startTime: Math.min(startTime, maxStart),
        duration,
      });
      setEditing(false);
    } else {
      setError(res.error || 'Could not submit your song.');
    }
  }

  // Already submitted and not editing → compact confirmation card.
  if ((mySong || alreadySubmitted) && !editing) {
    return (
      <div className="card song-search">
        <h2>✅ Song locked in</h2>
        {mySong ? (
          <div className="picked-song">
            {mySong.artwork && <img src={mySong.artwork} alt="" className="art" />}
            <div>
              <strong>{mySong.title}</strong>
              <div className="muted">{mySong.artist}</div>
              <div className="muted">
                Plays {mySong.duration}s from {formatTime(mySong.startTime)}
              </div>
            </div>
          </div>
        ) : (
          <p className="muted">You've already picked a song for this game.</p>
        )}
        <p className="muted">Waiting for everyone else to pick…</p>
        <button className="btn" onClick={() => setEditing(true)}>Change my song</button>
      </div>
    );
  }

  return (
    <div className="card song-search">
      <h2>🎶 Pick your song</h2>
      <p className="muted">
        Search for a track, choose it, then drag to pick the exact part everyone
        will have to guess. No one sees your choice.
      </p>

      <label className="field">
        <span>Search for a song</span>
        <input
          autoFocus
          placeholder="e.g. Bohemian Rhapsody"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(null);
          }}
        />
      </label>

      {searching && <p className="muted">Searching…</p>}

      {results.length > 0 && (
        <ul className="suggestions">
          {results.map((r) => (
            <li key={r.id} className="suggestion" onClick={() => pick(r)}>
              {r.artwork && <img src={r.artwork} alt="" className="art-sm" />}
              <span className="suggestion-text">
                <strong>{r.title}</strong>
                <span className="muted"> · {r.artist}</span>
              </span>
            </li>
          ))}
        </ul>
      )}

      {selected && (
        <div className="chosen">
          <div className="picked-song">
            {selected.artwork && <img src={selected.artwork} alt="" className="art" />}
            <div>
              <strong>{selected.title}</strong>
              <div className="muted">{selected.artist}</div>
            </div>
          </div>

          <p className="muted">Preview the part you'll make them guess:</p>
          <SnippetPlayer
            url={selected.previewUrl}
            startTime={Math.min(startTime, maxStart)}
            duration={duration}
          />

          <label className="field">
            <span>Start at: {formatTime(Math.min(startTime, maxStart))}</span>
            <input
              type="range"
              min="0"
              max={maxStart}
              step="1"
              value={Math.min(startTime, maxStart)}
              onChange={(e) => setStartTime(Number(e.target.value))}
            />
          </label>

          <label className="field">
            <span>Snippet length: {duration}s</span>
            <input
              type="range"
              min="3"
              max={previewLength}
              step="1"
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
            />
          </label>

          {error && <p className="error">{error}</p>}
          <button className="btn btn--primary" onClick={submit} disabled={busy}>
            {busy ? 'Submitting…' : submitted ? 'Update my song ✓' : 'Lock in my song ✓'}
          </button>
        </div>
      )}

      {!selected && error && <p className="error">{error}</p>}
    </div>
  );
}

function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}
