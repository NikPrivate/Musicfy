import { useEffect, useRef, useState } from 'react';

// Plays a chosen segment of an audio source: the window [startTime,
// startTime + duration]. Controls are a play/pause toggle that RESUMES from
// where it left off (it doesn't restart) plus a seek slider to scrub anywhere
// in the snippet. When `loop` is set, the window repeats so the song keeps
// going for the whole guessing round.
export default function SnippetPlayer({ url, startTime = 0, duration = 15, autoPlay = false, loop = false }) {
  const audioRef = useRef(null);
  const tick = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0); // seconds into the snippet window
  const [seeking, setSeeking] = useState(false);
  const [error, setError] = useState('');
  const [volume, setVolume] = useState(0.8);

  function clearTick() {
    clearInterval(tick.current);
    tick.current = null;
  }

  function play() {
    const audio = audioRef.current;
    if (!audio) return;
    setError('');
    audio.volume = volume;
    // Resume from the current spot; only jump to the start if we're outside the
    // snippet window (e.g. parked at the end after a non-looping play).
    const cur = audio.currentTime;
    if (cur < startTime || cur >= startTime + duration) {
      try {
        audio.currentTime = startTime;
      } catch {
        /* not seekable yet */
      }
    }
    const started = audio.play();
    if (started && started.catch) {
      started.catch(() => setError('Could not play audio. Check the URL / autoplay settings.'));
    }
  }

  function pause() {
    audioRef.current?.pause();
  }

  function seek(value) {
    const audio = audioRef.current;
    const v = Math.min(duration, Math.max(0, value));
    setPosition(v);
    if (audio) {
      try {
        audio.currentTime = startTime + v;
      } catch {
        /* not seekable yet */
      }
    }
  }

  // React to the element's own play/pause and drive the position read-out.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    function startPolling() {
      clearTick();
      tick.current = setInterval(() => {
        const a = audioRef.current;
        if (!a || seeking) return;
        let pos = a.currentTime - startTime;
        if (pos >= duration) {
          if (loop) {
            a.currentTime = startTime;
            pos = 0;
          } else {
            a.pause();
            pos = duration; // park at the end
          }
        }
        setPosition(Math.min(duration, Math.max(0, pos)));
      }, 100);
    }

    function onPlay() {
      setPlaying(true);
      startPolling();
    }
    function onPause() {
      setPlaying(false);
      clearTick();
    }
    function onError() {
      setError('Audio failed to load. Is the URL a direct link to an audio file?');
    }

    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('error', onError);
    return () => {
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('error', onError);
      clearTick();
      audio.pause();
    };
  }, [startTime, duration, loop, seeking]);

  // A new source/segment resets the playhead to the window start.
  useEffect(() => {
    setPosition(0);
    const audio = audioRef.current;
    if (audio) {
      try {
        audio.currentTime = startTime;
      } catch {
        /* not seekable yet */
      }
    }
  }, [url, startTime, duration]);

  // Autoplay (for guessers); browsers may block it until a gesture.
  useEffect(() => {
    if (autoPlay) {
      const t = setTimeout(play, 300);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, autoPlay]);

  // Volume is applied directly to the element so it never restarts playback.
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);

  return (
    <div className="snippet-player">
      {/* Hidden native element drives playback. */}
      <audio ref={audioRef} src={url} preload="auto" />

      <button
        className="btn btn--primary snippet-toggle"
        onClick={playing ? pause : play}
        aria-label={playing ? 'Pause' : 'Play'}
      >
        {playing ? '⏸' : '▶'}
      </button>

      <input
        className="seek"
        type="range"
        min="0"
        max={duration}
        step="0.1"
        value={position}
        onMouseDown={() => setSeeking(true)}
        onTouchStart={() => setSeeking(true)}
        onMouseUp={() => setSeeking(false)}
        onTouchEnd={() => setSeeking(false)}
        onChange={(e) => seek(Number(e.target.value))}
        aria-label="Seek"
      />
      <span className="muted snippet-time">
        {formatTime(position)} / {formatTime(duration)}
      </span>

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

      {error && <p className="error">{error}</p>}
    </div>
  );
}

function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}
