import { useEffect, useRef, useState } from 'react';
import { Play, Pause } from 'lucide-react';
import { useVolume } from '../volume.js';
import { useAudioUnlocked } from '../audioUnlock.js';

// Plays a chosen segment of an audio source: the window [startTime,
// startTime + duration]. Controls are a play/pause toggle that RESUMES from
// where it left off (it doesn't restart) plus a seek slider to scrub anywhere
// in the snippet. When `loop` is set, the window repeats so the song keeps
// going for the whole guessing round.
export default function SnippetPlayer({ url, startTime = 0, duration = 15, autoPlay = false, loop = false, minimal = false }) {
  const audioRef = useRef(null);
  const tick = useRef(null);
  // A ref (not state) so starting/stopping a drag never re-runs the playback
  // effect — re-running it would pause the audio mid-drag.
  const seeking = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0); // seconds into the snippet window
  const [error, setError] = useState('');
  // Mobile browsers (iOS Safari, Chrome Android) block audio until a user
  // gesture. When autoplay is refused we show a "Tap to play" button instead of
  // an error so the player can start the clip with one tap.
  const [blocked, setBlocked] = useState(false);
  const volume = useVolume(); // shared master volume (controlled from the share bar)
  const audioUnlocked = useAudioUnlocked(); // flips true after the first page gesture

  function clearTick() {
    clearInterval(tick.current);
    tick.current = null;
  }

  function play(userGesture = false) {
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
    if (started && started.then) {
      started
        .then(() => setBlocked(false))
        .catch((err) => {
          // Autoplay refused (no user gesture yet) → offer a tap-to-play button
          // rather than a scary error. A real failure on a user tap is a genuine
          // playback problem, so surface the error then.
          if (!userGesture || err?.name === 'NotAllowedError') {
            setBlocked(true);
          } else {
            setError('Could not play audio. Check the URL / autoplay settings.');
          }
        });
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
        if (!a || seeking.current) return;
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
      setBlocked(false);
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
  }, [startTime, duration, loop]);

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

  // Autoplay (for guessers); browsers may block it until a gesture, in which
  // case play() flips on the "Tap to play" button.
  useEffect(() => {
    if (autoPlay) {
      const t = setTimeout(() => play(false), 300);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, autoPlay]);

  // Apply the master volume directly to the element so it never restarts
  // playback. Persistence + syncing live in the shared volume store.
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);

  // Once the user's first gesture unlocks audio, auto-start a clip that's meant
  // to be playing — so guessers don't have to tap "play" on every round.
  useEffect(() => {
    if (audioUnlocked && autoPlay && audioRef.current?.paused) {
      play(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioUnlocked]);

  return (
    <div className="snippet-player">
      <audio ref={audioRef} src={url} preload="auto" playsInline />

      {blocked && (
        <button
          className="btn btn--primary snippet-tap"
          onClick={() => play(true)}
        >
          <Play size={16} style={{ verticalAlign: '-3px', marginRight: 7 }} />
          Tap to play
        </button>
      )}

      {!minimal && !blocked && (
        <>
          <button
            className="btn btn--primary snippet-toggle"
            onClick={playing ? pause : () => play(true)}
            aria-label={playing ? 'Pause' : 'Play'}
          >
            {playing ? <Pause size={18} /> : <Play size={18} />}
          </button>

          <input
            className="seek"
            type="range"
            min="0"
            max={duration}
            step="0.1"
            value={Math.min(Math.max(position, 0), duration)}
            style={{ '--pct': `${(Math.min(Math.max(position, 0), duration) / duration * 100).toFixed(1)}%` }}
            onMouseDown={() => (seeking.current = true)}
            onTouchStart={() => (seeking.current = true)}
            onMouseUp={() => (seeking.current = false)}
            onTouchEnd={() => (seeking.current = false)}
            onChange={(e) => seek(Number(e.target.value))}
            aria-label="Seek"
          />
          <span className="muted snippet-time">
            {formatTime(position)} / {formatTime(duration)}
          </span>
        </>
      )}

      {error && <p className="error">{error}</p>}
    </div>
  );
}

function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}
