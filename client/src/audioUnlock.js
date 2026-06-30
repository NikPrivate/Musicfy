// One-time audio unlock for mobile.
//
// Mobile browsers block audio playback until the user interacts with the page.
// After that first gesture, most browsers (Chrome Android, modern iOS) allow
// programmatic playback for the rest of the page session. We listen once for
// that first gesture anywhere in the app, prime a silent audio element to
// register media activation, then flip a shared flag so any waiting player can
// start on its own. The per-round "Tap to play" button stays as a fallback for
// the strictest cases.
import { useSyncExternalStore } from 'react';

let unlocked = false;
const listeners = new Set();

export function isAudioUnlocked() {
  return unlocked;
}

function notify() {
  listeners.forEach((fn) => fn());
}

// Re-renders subscribers (players) the moment audio becomes unlocked.
export function useAudioUnlocked() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    isAudioUnlocked,
    isAudioUnlocked,
  );
}

const GESTURES = ['pointerdown', 'touchend', 'mousedown', 'keydown'];

// A tiny silent WAV so the priming play() has a valid, instantly-ready source.
const SILENT_WAV =
  'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';

// Attach the first-gesture listeners. Safe to call multiple times.
export function installAudioUnlock() {
  if (typeof window === 'undefined' || unlocked) return;

  function unlock() {
    if (unlocked) return;
    unlocked = true;
    try {
      const primer = new Audio(SILENT_WAV);
      primer.volume = 0;
      const p = primer.play();
      if (p && p.then) p.then(() => primer.pause()).catch(() => {});
    } catch {
      /* ignore — the gesture itself usually suffices */
    }
    notify();
    GESTURES.forEach((ev) => window.removeEventListener(ev, unlock));
  }

  GESTURES.forEach((ev) => window.addEventListener(ev, unlock, { passive: true }));
}
