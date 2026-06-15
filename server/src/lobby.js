import { customAlphabet } from 'nanoid';

// Human-friendly lobby codes (no ambiguous chars like O/0, I/1).
const makeCode = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 5);

export const PHASES = {
  LOBBY: 'lobby', // waiting in the room
  SUBMITTING: 'submitting', // every player searches for & submits their own song
  PLAYING: 'playing', // one submitted song is live, everyone else guesses
  ROUND_END: 'roundEnd', // reveal answer + scores
  GAME_END: 'gameEnd', // final scoreboard
};

const DEFAULTS = {
  roundTimer: 30, // seconds to guess (a song plays for the whole window)
  snippetDuration: 30, // seconds of audio played (iTunes previews are ~30s)
  clueInterval: 10, // reveal one more letter every N seconds, automatically
};

// Max players per lobby. Existing players reconnecting are always let back in;
// only brand-new joins are turned away once this many are connected.
export const MAX_PLAYERS = 12;

// Normalize a guess/answer for comparison: lowercase, strip anything that
// isn't a letter or number, collapse whitespace. So "Don't Stop Me Now!" ==
// "dont stop me now".
function normalize(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Build a masked version of the answer where letters/digits become "_" but
// spaces and punctuation stay visible. revealed = set of character indices
// that have been unlocked via clues. This also tells guessers the *length* of
// the title (number of blanks) at a glance.
function maskAnswer(answer, revealed) {
  return answer
    .split('')
    .map((ch, i) => {
      if (/[a-z0-9]/i.test(ch)) {
        return revealed.has(i) ? ch : '_';
      }
      return ch; // spaces, punctuation shown as-is
    })
    .join('');
}

// Indices of characters that are maskable (letters/digits).
function maskableIndices(answer) {
  const out = [];
  for (let i = 0; i < answer.length; i++) {
    if (/[a-z0-9]/i.test(answer[i])) out.push(i);
  }
  return out;
}

// Fisher–Yates shuffle (returns a new array). Used to randomize the order in
// which players' songs are played so it isn't just join order.
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export class Lobby {
  constructor(code) {
    this.code = code;
    this.players = new Map(); // clientId -> player
    this.hostClientId = null;
    // The original lobby creator. Host may be temporarily handed to someone
    // else while the creator is away, but the creator reclaims it when they
    // return (see upsertPlayer).
    this.creatorClientId = null;
    this.phase = PHASES.LOBBY;
    this.settings = { ...DEFAULTS };

    this.roundNumber = 0;
    // Playback order: clientIds whose submitted songs play, one per round.
    this.playOrder = [];
    this.playIndex = -1;
    // The owner of the song that's currently playing. They already know the
    // answer, so they sit the round out (can't guess).
    this.ownerClientId = null;

    // Active round state
    this.song = null; // { title, artist, audioUrl, artwork, startTime, duration }
    this.revealed = new Set(); // revealed character indices for clues
    this.roundEndsAt = null;
    this.guessedThisRound = new Set(); // clientIds who already guessed correctly
    this.timer = null; // round-end timeout
    this.clueTimer = null; // auto-clue interval
  }

  // ---- player management -------------------------------------------------

  // Add or re-attach a player. Keyed by clientId so the SAME browser/person
  // rejoining (e.g. clicking the share link twice, refreshing, reconnecting)
  // updates their existing entry instead of creating a duplicate.
  upsertPlayer(clientId, socketId, profile) {
    let player = this.players.get(clientId);
    const isNew = !player;
    if (isNew) {
      player = {
        clientId,
        score: 0,
        joinedAt: Date.now(),
        song: null, // the song this player submitted for the game
      };
      this.players.set(clientId, player);
    }
    player.socketId = socketId;
    player.connected = true;
    if (profile) {
      if (profile.username) player.username = profile.username.slice(0, 24);
      if (profile.avatar) player.avatar = profile.avatar;
    }
    // First player to ever join is the lobby's creator + initial host.
    if (!this.creatorClientId) this.creatorClientId = clientId;
    if (!this.hostClientId) this.hostClientId = clientId;
    // The creator always reclaims the host crown when they (re)connect, even if
    // it was temporarily handed to someone else while they were away.
    if (clientId === this.creatorClientId) this.hostClientId = clientId;
    return { player, isNew };
  }

  getBySocket(socketId) {
    for (const p of this.players.values()) {
      if (p.socketId === socketId) return p;
    }
    return null;
  }

  markDisconnected(socketId) {
    const p = this.getBySocket(socketId);
    if (p) {
      p.connected = false;
      p.socketId = null;
    }
    return p;
  }

  // If the host left, hand the crown to a remaining connected player — favoring
  // the lobby creator if they're still around (they reclaim it on return too).
  reassignHostIfNeeded() {
    const host = this.players.get(this.hostClientId);
    if (host && host.connected) return;
    const creator = this.players.get(this.creatorClientId);
    if (creator && creator.connected) {
      this.hostClientId = this.creatorClientId;
      return;
    }
    const next = [...this.players.values()].find((p) => p.connected);
    this.hostClientId = next ? next.clientId : this.hostClientId;
  }

  isEmpty() {
    return [...this.players.values()].every((p) => !p.connected);
  }

  // Count of currently-connected players (used for the join cap). Disconnected
  // "ghosts" don't count, so they never lock out new players.
  connectedCount() {
    return [...this.players.values()].filter((p) => p.connected).length;
  }

  isFull() {
    return this.connectedCount() >= MAX_PLAYERS;
  }

  // ---- game flow ---------------------------------------------------------

  // Host kicks things off: everyone now searches for and submits their own
  // song simultaneously. Nothing plays yet.
  startGame(settings = {}) {
    this.settings = {
      roundTimer: clampInt(settings.roundTimer, 10, 300, DEFAULTS.roundTimer),
      snippetDuration: clampInt(settings.snippetDuration, 3, 60, DEFAULTS.snippetDuration),
      clueInterval: clampInt(settings.clueInterval, 3, 60, DEFAULTS.clueInterval),
    };
    for (const p of this.players.values()) {
      p.score = 0;
      p.song = null;
    }
    this.roundNumber = 0;
    this.playOrder = [];
    this.playIndex = -1;
    this.ownerClientId = null;
    this.song = null;
    this.phase = PHASES.SUBMITTING;
  }

  // A player picks their song (from search) and which part of it to play.
  // Stored against the player; they can change it until playback begins.
  submitSong(clientId, song) {
    const player = this.players.get(clientId);
    if (!player) return false;
    player.song = {
      title: String(song.title || '').slice(0, 120),
      artist: String(song.artist || '').slice(0, 120),
      audioUrl: String(song.audioUrl || '').slice(0, 2000),
      artwork: String(song.artwork || '').slice(0, 2000),
      startTime: clampInt(song.startTime, 0, 100000, 0),
      duration: clampInt(song.duration, 3, 60, this.settings.snippetDuration),
    };
    return true;
  }

  // Connected players who have a valid submission ready.
  submittedPlayers() {
    return [...this.players.values()].filter(
      (p) => p.connected && p.song && p.song.title && p.song.audioUrl
    );
  }

  // True once every connected player has submitted a song.
  allSubmitted() {
    const connected = [...this.players.values()].filter((p) => p.connected);
    return connected.length > 0 && connected.every((p) => p.song && p.song.title && p.song.audioUrl);
  }

  // Host begins playback. Lock in the play order from everyone who submitted.
  beginPlayback() {
    const ready = this.submittedPlayers();
    this.playOrder = shuffle(ready.map((p) => p.clientId));
    this.playIndex = -1;
    return this.nextSong();
  }

  // Advance to the next player's song (the next round).
  nextSong() {
    this.playIndex += 1;
    this.ownerClientId = this.playOrder[this.playIndex];
    const owner = this.players.get(this.ownerClientId);
    this.song = owner ? owner.song : null;
    this.roundNumber = this.playIndex + 1;
    this.phase = PHASES.PLAYING;
    this.revealed = new Set();
    this.guessedThisRound = new Set();
    this.roundEndsAt = Date.now() + this.settings.roundTimer * 1000;
    return this.song;
  }

  // Reveal one more random letter as a clue. Returns true if a new letter was
  // revealed. Driven automatically by a timer (every clueInterval seconds);
  // never reveals the final hidden letter.
  revealClue() {
    if (!this.song) return false;
    const candidates = maskableIndices(this.song.title).filter((i) => !this.revealed.has(i));
    if (candidates.length <= 1) return false; // never fully reveal via clues
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    this.revealed.add(pick);
    return true;
  }

  // Check a player's guess. Returns { correct, points } and updates score.
  submitGuess(clientId, guess) {
    if (this.phase !== PHASES.PLAYING || !this.song) return { correct: false };
    if (clientId === this.ownerClientId) return { correct: false, reason: 'owner' };
    if (this.guessedThisRound.has(clientId)) return { correct: false, reason: 'already' };

    if (normalize(guess) !== normalize(this.song.title)) {
      return { correct: false };
    }

    const player = this.players.get(clientId);
    const secondsLeft = Math.max(0, Math.round((this.roundEndsAt - Date.now()) / 1000));
    // Faster guesses score higher; clues are automatic & shared so there's no
    // per-player clue penalty.
    const points = Math.max(20, Math.round(20 + 80 * (secondsLeft / this.settings.roundTimer)));
    player.score += points;
    this.guessedThisRound.add(clientId);
    return { correct: true, points };
  }

  // Everyone (except the song's owner) guessed? Then the round can end early.
  allGuessed() {
    const guessers = [...this.players.values()].filter(
      (p) => p.connected && p.clientId !== this.ownerClientId
    );
    if (guessers.length === 0) return false;
    return guessers.every((p) => this.guessedThisRound.has(p.clientId));
  }

  endRound() {
    this.phase = PHASES.ROUND_END;
    this.roundEndsAt = null;
  }

  // The game ends once every submitted song has been played.
  isLastRound() {
    return this.playIndex >= this.playOrder.length - 1;
  }

  endGame() {
    this.phase = PHASES.GAME_END;
  }

  // ---- serialization -----------------------------------------------------

  // What every client is allowed to see. The answer title is hidden during
  // play (only the masked version + audio config is shared); the owner gets
  // the full answer separately.
  publicState() {
    const players = [...this.players.values()]
      .map((p) => ({
        clientId: p.clientId,
        username: p.username || 'Player',
        avatar: p.avatar || null,
        score: p.score,
        connected: p.connected,
        isHost: p.clientId === this.hostClientId,
        isChooser: p.clientId === this.ownerClientId, // owner of the live song
        hasSubmitted: !!(p.song && p.song.title && p.song.audioUrl),
        hasGuessed: this.guessedThisRound.has(p.clientId),
      }))
      .sort((a, b) => b.score - a.score);

    const state = {
      code: this.code,
      phase: this.phase,
      settings: this.settings,
      roundNumber: this.roundNumber,
      totalRounds: this.phase === PHASES.SUBMITTING
        ? players.filter((p) => p.connected).length
        : this.playOrder.length,
      hostClientId: this.hostClientId,
      chooserClientId: this.ownerClientId,
      players,
      maxPlayers: MAX_PLAYERS,
      roundEndsAt: this.roundEndsAt,
    };

    if ((this.phase === PHASES.PLAYING || this.phase === PHASES.ROUND_END) && this.song) {
      const owner = this.players.get(this.ownerClientId);
      state.round = {
        masked: maskAnswer(this.song.title, this.revealed),
        titleLength: this.song.title.length,
        cluesUsed: this.revealed.size,
        artistHint: this.song.artist || null,
        ownerName: owner?.username || 'Someone',
        audio: {
          url: this.song.audioUrl,
          artwork: this.song.artwork || null,
          startTime: this.song.startTime,
          duration: this.song.duration,
        },
      };
      if (this.phase === PHASES.ROUND_END) {
        state.round.answer = this.song.title;
      }
    }
    return state;
  }
}

function clampInt(val, min, max, fallback) {
  const n = parseInt(val, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export class LobbyManager {
  constructor() {
    this.lobbies = new Map();
  }

  create() {
    let code;
    do {
      code = makeCode();
    } while (this.lobbies.has(code));
    const lobby = new Lobby(code);
    this.lobbies.set(code, lobby);
    return lobby;
  }

  get(code) {
    return this.lobbies.get((code || '').toUpperCase());
  }

  remove(code) {
    this.lobbies.delete(code);
  }
}
