import { useState } from 'react';
import { emit } from '../socket.js';

// The current chooser uses this to pick the song, the audio source, which part
// of the track to play, and how long the snippet lasts.
export default function SongPicker({ defaultDuration = 15 }) {
  const [form, setForm] = useState({
    title: '',
    artist: '',
    audioUrl: '',
    startMin: 0,
    startSec: 0,
    duration: defaultDuration,
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function update(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function start(e) {
    e.preventDefault();
    setError('');
    if (!form.title.trim()) return setError('Enter the song title (the answer).');
    if (!form.audioUrl.trim()) return setError('Paste a direct link to an audio file.');

    const startTime = Number(form.startMin) * 60 + Number(form.startSec);
    setBusy(true);
    const res = await emit('round:choose', {
      song: {
        title: form.title.trim(),
        artist: form.artist.trim(),
        audioUrl: form.audioUrl.trim(),
        startTime,
        duration: Number(form.duration),
      },
    });
    setBusy(false);
    if (!res.ok) setError(res.error || 'Could not start the round.');
  }

  return (
    <div className="card song-picker">
      <h2>🎶 Your turn to pick a song</h2>
      <p className="muted">
        Your friends will hear the snippet and guess the title. They won’t see what
        you type here.
      </p>
      <form onSubmit={start}>
        <label className="field">
          <span>Song title (the answer)</span>
          <input
            placeholder="e.g. Bohemian Rhapsody"
            value={form.title}
            onChange={(e) => update('title', e.target.value)}
          />
        </label>

        <label className="field">
          <span>Artist (optional hint shown to guessers)</span>
          <input
            placeholder="e.g. Queen"
            value={form.artist}
            onChange={(e) => update('artist', e.target.value)}
          />
        </label>

        <label className="field">
          <span>Audio URL (direct link to an .mp3 / .ogg / .m4a file)</span>
          <input
            placeholder="https://…/song.mp3"
            value={form.audioUrl}
            onChange={(e) => update('audioUrl', e.target.value)}
          />
        </label>

        <div className="row">
          <label className="field">
            <span>Start at (min)</span>
            <input
              type="number"
              min="0"
              value={form.startMin}
              onChange={(e) => update('startMin', e.target.value)}
            />
          </label>
          <label className="field">
            <span>Start at (sec)</span>
            <input
              type="number"
              min="0"
              max="59"
              value={form.startSec}
              onChange={(e) => update('startSec', e.target.value)}
            />
          </label>
          <label className="field">
            <span>Snippet length (sec)</span>
            <input
              type="number"
              min="3"
              max="60"
              value={form.duration}
              onChange={(e) => update('duration', e.target.value)}
            />
          </label>
        </div>

        {error && <p className="error">{error}</p>}
        <button className="btn btn--primary" type="submit" disabled={busy}>
          {busy ? 'Starting…' : 'Start the round →'}
        </button>
      </form>
    </div>
  );
}
