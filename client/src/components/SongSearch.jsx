import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Music2, CheckCircle2, X, Search, Loader2, RefreshCw, Play, Pause } from 'lucide-react';
import { emit } from '../socket.js';
import SnippetPlayer from './SnippetPlayer.jsx';
import VolumeControl from './VolumeControl.jsx';
import { useVolume } from '../volume.js';

export default function SongSearch({ defaultDuration = 15, alreadySubmitted = false }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [mySong, setMySong] = useState(null);
  const [editing, setEditing] = useState(!alreadySubmitted);

  const duration = Math.min(defaultDuration, 30);

  function pick(result) {
    setSelected(result);
    setPickerOpen(false);
    setStartTime(0);
    setError('');
  }

  async function submit() {
    if (!selected) return setError('Pick a song first.');
    setBusy(true);
    setError('');
    const res = await emit('song:submit', {
      song: {
        title: selected.title,
        artist: selected.artist,
        audioUrl: selected.audioUrl,
        artwork: selected.artwork,
        startTime: 0,
        duration,
      },
    });
    setBusy(false);
    if (res.ok) {
      setMySong({
        title: selected.title,
        artist: selected.artist,
        artwork: selected.artwork,
        startTime: 0,
        duration,
      });
      setEditing(false);
    } else {
      setError(res.error || 'Could not submit your song.');
    }
  }

  if ((mySong || alreadySubmitted) && !editing) {
    return (
      <div className="card song-search">
        <h2 className="song-search-title">
          <CheckCircle2 size={22} className="icon-green" />
          Song locked in
        </h2>
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
        <button className="btn" onClick={() => setEditing(true)}>
          <RefreshCw size={15} style={{ verticalAlign: '-3px', marginRight: 6 }} />
          Change my song
        </button>
      </div>
    );
  }

  return (
    <div className="card song-search">
      <h2 className="song-search-title">
        <Music2 size={22} className="icon-primary" />
        Pick your song
      </h2>
      <p className="muted">
        Search for a track, choose it, then drag to pick the exact part everyone will have to guess. No one sees your choice.
      </p>

      {selected ? (
        <button className="btn song-trigger song-trigger--selected" onClick={() => setPickerOpen(true)}>
          {selected.artwork && <img src={selected.artwork} alt="" className="art-sm" />}
          <span className="song-trigger-text">
            <strong>{selected.title}</strong>
            <span className="muted"> · {selected.artist}</span>
          </span>
          <Search size={15} className="song-trigger-icon" />
        </button>
      ) : (
        <button className="btn song-trigger" onClick={() => setPickerOpen(true)}>
          <Search size={15} className="song-trigger-icon-left" />
          Search for a song…
        </button>
      )}

      {selected && (
        <div className="chosen">
          <p className="muted">Preview the {duration}s clip your friends will have to guess:</p>
          <SnippetPlayer
            url={selected.audioUrl}
            startTime={0}
            duration={duration}
          />

          {error && <p className="error">{error}</p>}
          <button className="btn btn--primary" onClick={submit} disabled={busy}>
            {busy ? 'Submitting…' : mySong || alreadySubmitted ? 'Update my song' : 'Lock in my song'}
          </button>
        </div>
      )}

      {!selected && error && <p className="error">{error}</p>}

      {pickerOpen && createPortal(
        <SongPicker onPick={pick} onClose={() => setPickerOpen(false)} />,
        document.body
      )}
    </div>
  );
}

// ---- Song picker popup -------------------------------------------------------

function SongPicker({ onPick, onClose }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const debounce = useRef(null);
  const inputRef = useRef(null);

  // Shared preview audio: only one result plays at a time, at the app-wide
  // master volume.
  const audioRef = useRef(null);
  const [previewId, setPreviewId] = useState(null);
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const volume = useVolume();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Keep the audio element's volume in sync without restarting playback.
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);

  // Stop any preview when the picker unmounts.
  useEffect(() => () => audioRef.current?.pause(), []);

  // Stop a preview if its song scrolls out of the (re-fetched) results.
  useEffect(() => {
    if (previewId && !results.some((r) => r.id === previewId)) {
      audioRef.current?.pause();
    }
  }, [results, previewId]);

  function togglePreview(e, r) {
    e.stopPropagation(); // don't pick the song — just preview it
    const audio = audioRef.current;
    if (!audio || !r.audioUrl) return;
    if (previewId === r.id) {
      if (audio.paused) audio.play().catch(() => {});
      else audio.pause();
      return;
    }
    audio.src = r.audioUrl;
    audio.volume = volume;
    audio.currentTime = 0;
    setPreviewId(r.id);
    audio.play().catch(() => {});
  }

  useEffect(() => {
    clearTimeout(debounce.current);
    const q = query.trim();
    if (q.length < 2) { setResults([]); setSearching(false); return; }
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

  function handleKey(e) {
    if (e.key === 'Escape') onClose();
  }

  return (
    <div className="song-picker-overlay" onClick={onClose}>
      <div className="song-picker" onClick={(e) => e.stopPropagation()} onKeyDown={handleKey}>
        <audio
          ref={audioRef}
          onPlay={() => setPreviewPlaying(true)}
          onPause={() => setPreviewPlaying(false)}
          onEnded={() => setPreviewPlaying(false)}
        />
        <div className="song-picker-header">
          <div className="search-input-wrap" style={{ flex: 1 }}>
            <Search size={16} className="search-icon" />
            <input
              ref={inputRef}
              className="search-input"
              placeholder="Search for a song…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {searching && <Loader2 size={16} className="search-spinner spin" />}
          </div>
          <VolumeControl className="song-picker-volume" title="Preview volume" label="Preview volume" />
          <button className="song-picker-close" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        {results.length > 0 ? (
          <ul className="song-picker-list">
            {results.map((r) => {
              const isCurrent = previewId === r.id;
              const isPlaying = isCurrent && previewPlaying;
              return (
                <li key={r.id} className="suggestion" onClick={() => onPick(r)}>
                  <button
                    type="button"
                    className={`suggestion-preview ${isCurrent ? 'is-active' : ''}`}
                    onClick={(e) => togglePreview(e, r)}
                    disabled={!r.audioUrl}
                    aria-label={isPlaying ? 'Pause preview' : 'Play preview'}
                    title={r.audioUrl ? (isPlaying ? 'Pause preview' : 'Play preview') : 'No preview available'}
                  >
                    {isPlaying ? <Pause size={16} /> : <Play size={16} />}
                  </button>
                  {r.artwork
                    ? <img src={r.artwork} alt="" className="art-sm" />
                    : <div className="art-sm art-placeholder"><Music2 size={18} /></div>
                  }
                  <span className="suggestion-text">
                    <strong>{r.title}</strong>
                    <span className="muted"> · {r.artist}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="song-picker-empty">
            {query.length < 2
              ? <><Search size={32} className="empty-icon" /><p>Start typing to search…</p></>
              : searching
                ? null
                : <><Music2 size={32} className="empty-icon" /><p>No results for "{query}"</p></>
            }
          </div>
        )}
      </div>
    </div>
  );
}

function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}
