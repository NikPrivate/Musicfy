// One global "master" volume for all audio in the app (round playback + search
// previews). Backed by localStorage so the chosen level persists across rounds,
// remounts, and page reloads, and shared via a tiny external store so the
// master control in the share bar and every <audio> element stay in sync.
import { useSyncExternalStore } from 'react';

const VOLUME_KEY = 'musicfy_volume';
const listeners = new Set();

export function getVolume() {
  const v = parseFloat(localStorage.getItem(VOLUME_KEY));
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5;
}

export function setVolume(value) {
  const v = Math.min(1, Math.max(0, value));
  localStorage.setItem(VOLUME_KEY, String(v));
  listeners.forEach((fn) => fn());
}

function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Re-renders any component when the master volume changes.
export function useVolume() {
  return useSyncExternalStore(subscribe, getVolume, getVolume);
}
