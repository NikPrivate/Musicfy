import { customAlphabet } from 'nanoid';

// Human-friendly lobby codes (no ambiguous chars like O/0, I/1).
const makeCode = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 5);

export const PHASES = {
  LOBBY: 'lobby', // waiting in the room
  SELECTING: 'selecting', // current chooser is picking a song
  PLAYING: 'playing', // snippet is live, everyone guesses
  ROUND_END: 'roundEnd', // reveal answer + scores
  GAME_END: 'gameEnd', // final scoreboard
};

const DEFAULTS = {
  roundTimer: 60, // seconds to guess
  snippetDuration: 15, // seconds of audio played
  totalRounds: 5,
};

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
// that have been unlocked via clues.
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

export class Lobby {
  constructor(code) {
    this.code = code;
    this.players = new Map(); // clientId -> player
    this.hostClientId = null;
    this.phase = PHASES.LOBBY;
    this.settings = { ...DEFAULTS };

    this.roundNumber = 0;
    this.chooserClientId = null;
    this.chooserOrder = []; // clientIds in the order they take turns choosing
    this.chooserIndex = -1;

    // Active round state
    this.song = null; // { title, artist, audioUrl, startTime, duration }
    this.revealed = new Set(); // revealed character indices for clues
    this.roundEndsAt = null;
    this.guessedThisRound = new Set(); // clientIds who already guessed correctly
    this.timer = null;
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
      };
      this.players.set(clientId, player);
      this.chooserOrder.push(clientId);
    }
    player.socketId = socketId;
    player.connected = true;
    if (profile) {
      if (profile.username) player.username = profile.username.slice(0, 24);
      if (profile.avatar) player.avatar = profile.avatar;
    }
    if (!this.hostClientId) this.hostClientId = clientId;
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

  // If the host left, hand the crown to any remaining connected player.
  reassignHostIfNeeded() {
    const host = this.players.get(this.hostClientId);
    if (host && host.connected) return;
    const next = [...this.players.values()].find((p) => p.connected);
    this.hostClientId = next ? next.clientId : this.hostClientId;
  }

  isEmpty() {
    return [...this.players.values()].every((p) => !p.connected);
  }

  // ---- game flow ---------------------------------------------------------

  startGame(settings = {}) {
    this.settings = {
      roundTimer: clampInt(settings.roundTimer, 10, 300, DEFAULTS.roundTimer),
      snippetDuration: clampInt(settings.snippetDuration, 3, 60, DEFAULTS.snippetDuration),
      totalRounds: clampInt(settings.totalRounds, 1, 20, DEFAULTS.totalRounds),
    };
    for (const p of this.players.values()) p.score = 0;
    this.roundNumber = 0;
    // Lock in turn order from currently-present players.
    this.chooserOrder = [...this.players.keys()];
    this.chooserIndex = -1;
    this.nextChooser();
  }

  nextChooser() {
    this.chooserIndex = (this.chooserIndex + 1) % this.chooserOrder.length;
    this.chooserClientId = this.chooserOrder[this.chooserIndex];
    this.roundNumber += 1;
    this.phase = PHASES.SELECTING;
    this.song = null;
    this.revealed = new Set();
    this.guessedThisRound = new Set();
    this.roundEndsAt = null;
  }

  // Chooser locks in a song and the round goes live.
  startRound(song) {
    this.song = {
      title: String(song.title || '').slice(0, 120),
      artist: String(song.artist || '').slice(0, 120),
      audioUrl: String(song.audioUrl || '').slice(0, 2000),
      startTime: clampInt(song.startTime, 0, 100000, 0),
      duration: clampInt(song.duration, 3, 60, this.settings.snippetDuration),
    };
    this.phase = PHASES.PLAYING;
    this.revealed = new Set();
    this.guessedThisRound = new Set();
    this.roundEndsAt = Date.now() + this.settings.roundTimer * 1000;
  }

  // Reveal one more random letter as a clue. Returns true if a new letter was
  // revealed. Shared across guessers for the round.
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
    if (clientId === this.chooserClientId) return { correct: false, reason: 'chooser' };
    if (this.guessedThisRound.has(clientId)) return { correct: false, reason: 'already' };

    if (normalize(guess) !== normalize(this.song.title)) {
      return { correct: false };
    }

    const player = this.players.get(clientId);
    const secondsLeft = Math.max(0, Math.round((this.roundEndsAt - Date.now()) / 1000));
    const cluePenalty = this.revealed.size * 15;
    const points = Math.max(20, 100 + secondsLeft - cluePenalty);
    player.score += points;
    this.guessedThisRound.add(clientId);
    return { correct: true, points };
  }

  // Everyone (except chooser) guessed? Then the round can end early.
  allGuessed() {
    const guessers = [...this.players.values()].filter(
      (p) => p.connected && p.clientId !== this.chooserClientId
    );
    if (guessers.length === 0) return false;
    return guessers.every((p) => this.guessedThisRound.has(p.clientId));
  }

  endRound() {
    this.phase = PHASES.ROUND_END;
    this.roundEndsAt = null;
  }

  isLastRound() {
    return this.roundNumber >= this.settings.totalRounds;
  }

  endGame() {
    this.phase = PHASES.GAME_END;
  }

  // ---- serialization -----------------------------------------------------

  // What every client is allowed to see. The answer title is hidden during
  // play (only the masked version + audio config is shared); the chooser gets
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
        isChooser: p.clientId === this.chooserClientId,
        hasGuessed: this.guessedThisRound.has(p.clientId),
      }))
      .sort((a, b) => b.score - a.score);

    const state = {
      code: this.code,
      phase: this.phase,
      settings: this.settings,
      roundNumber: this.roundNumber,
      totalRounds: this.settings.totalRounds,
      hostClientId: this.hostClientId,
      chooserClientId: this.chooserClientId,
      players,
      roundEndsAt: this.roundEndsAt,
    };

    if ((this.phase === PHASES.PLAYING || this.phase === PHASES.ROUND_END) && this.song) {
      state.round = {
        masked: maskAnswer(this.song.title, this.revealed),
        cluesUsed: this.revealed.size,
        artistHint: this.song.artist || null,
        audio: {
          url: this.song.audioUrl,
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
