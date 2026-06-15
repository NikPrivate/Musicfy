// Stable, per-browser identity. This is the heart of the "don't create
// duplicate players when the same person clicks the link again" fix.
//
// - clientId: generated ONCE and persisted in localStorage. The server keys
//   players by this id, so reconnecting / reopening the link / refreshing
//   re-attaches to the same player instead of spawning a new one.
// - profile: the username + avatar, persisted so a returning user is joined
//   automatically without being asked to set up a profile again.

const CLIENT_ID_KEY = 'musicfy_client_id';
const PROFILE_KEY = 'musicfy_profile';

export function getClientId() {
  let id = localStorage.getItem(CLIENT_ID_KEY);
  if (!id) {
    id =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `c_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(CLIENT_ID_KEY, id);
  }
  return id;
}

export function getProfile() {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveProfile(profile) {
  localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
}

export function hasProfile() {
  const p = getProfile();
  return !!(p && p.username);
}
