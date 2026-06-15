import { useEffect, useRef, useState } from 'react';

// Plays only a chosen segment of an audio source: from `startTime` for
// `duration` seconds, then auto-stops. A replay button lets players hear it
// again. Browsers block autoplay without a gesture, so playback starts when
// the player taps "Play snippet".
export default function SnippetPlayer({ url, startTime = 0, duration = 15, autoPlay = false, loop = false }) {
  const audioRef = useRef(null);
  const stopTimer = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState('');
  const [remaining, setRemaining] = useState(duration);
  const [volume, setVolume] = useState(0.8);

  function stop() {
    const audio = audioRef.current;
    if (audio) audio.pause();
    clearInterval(stopTimer.current);
    setPlaying(false);
    setRemaining(duration);
  }

  function play() {
    const audio = audioRef.current;
    if (!audio) return;
    setError('');
    audio.volume = volume;
    try {
      audio.currentTime = startTime;
    } catch {
      /* currentTime may not be seekable yet; handled on loadedmetadata */
    }
    const started = audio.play();
    if (started && started.catch) {
      started.catch(() => setError('Could not play audio. Check the URL / autoplay settings.'));
    }
  }

  // Wire up playback lifecycle when the source/segment changes.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    function onPlay() {
      setPlaying(true);
      audio.currentTime = Math.max(startTime, audio.currentTime);
      let endAt = Date.now() + duration * 1000;
      clearInterval(stopTimer.current);
      stopTimer.current = setInterval(() => {
        const left = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
        setRemaining(left);
        if (Date.now() >= endAt) {
          if (loop) {
            // Replay the same segment so the song keeps going for the whole
            // guessing window instead of stopping after one pass.
            audio.currentTime = startTime;
            endAt = Date.now() + duration * 1000;
          } else {
            stop();
          }
        }
      }, 200);
    }
    function onError() {
      setError('Audio failed to load. Is the URL a direct link to an audio file?');
    }

    audio.addEventListener('play', onPlay);
    audio.addEventListener('error', onError);
    return () => {
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('error', onError);
      clearInterval(stopTimer.current);
      audio.pause();
    };
  }, [url, startTime, duration, loop]);

  useEffect(() => {
    if (autoPlay) {
      const t = setTimeout(play, 300);
      return () => clearTimeout(t);
    }
  }, [url, autoPlay]);

  // Adjust the element's volume directly — this never restarts the snippet, so
  // dragging the slider mid-round doesn't reset the audio.
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);

  return (
    <div className="snippet-player">
      {/* Hidden native element drives playback. */}
      <audio ref={audioRef} src={url} preload="auto" />
      <button className="btn btn--primary" onClick={playing ? stop : play}>
        {playing ? `⏸ Stop (${remaining}s)` : '▶ Play snippet'}
      </button>
      <label className="volume" title="Volume">
        <span aria-hidden="true">{volume === 0 ? '🔇' : '🔊'}</span>
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={volume}
          onChange={(e) => setVolume(Number(e.target.value))}
          aria-label="Volume"
        />
      </label>
      <span className="muted snippet-meta">
        {duration}s clip from {formatTime(startTime)}
      </span>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}
