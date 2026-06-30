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

// Fixed game rules (not configurable per-lobby).
const DEFAULTS = {
  roundTimer: 30, // seconds to guess (the song plays for the whole window)
  snippetDuration: 30, // fixed snippet length; players pick the start point only
  clueInterval: 8, // reveal one more letter every N seconds, automatically
  ownerBonus: 15, // points the song's owner earns for each player who guesses it
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

// Levenshtein edit distance — used to tell a guesser when they're *almost*
// right ("imagin" vs "imagine") without revealing the answer.
function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let curr = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[b.length];
}

// Monotonic id for chat/feed messages so the client can key them stably.
let msgSeq = 0;

// The part of a title players actually have to guess. Anything inside brackets
// or parentheses — "(feat. Bruno Mars)", "[Remastered 2011]", "{Live}" — is
// stripped along with the brackets themselves: it isn't the core title and just
// makes the blanks longer and the guess harder (and often leaks the artist).
// So "Lighters (feat. Bruno Mars)" becomes "Lighters".
function guessableTitle(title) {
  const stripped = (title || '')
    .replace(/[([{][^)\]}]*[)\]}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // If the title was *all* brackets (e.g. "(Instrumental)"), keep the original
  // so there's still something to guess.
  return stripped || (title || '').trim();
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
    this.revealed = new Set(); // revealed title character indices for clues
    this.revealedArtist = new Set(); // revealed artist character indices for clues
    this.roundEndsAt = null;
    this.guessedThisRound = new Set(); // clientIds who guessed the TITLE
    this.guessedArtist = new Set(); // clientIds who guessed the ARTIST
    this.timer = null; // round-end timeout
    this.clueTimer = null; // auto-clue interval

    // Skribbl-style live chat / guess feed. During a round the chat box doubles
    // as the guess box: correct guesses are announced (without leaking the
    // title), wrong guesses show as normal messages. Capped so it never grows
    // unbounded.
    this.messages = [];
  }

  // ---- chat / guess feed -------------------------------------------------

  pushMessage(msg) {
    this.messages.push({ id: ++msgSeq, ts: Date.now(), ...msg });
    if (this.messages.length > 80) this.messages.shift();
  }

  // A normal player chat line.
  addChat(player, text) {
    this.pushMessage({
      type: 'chat',
      clientId: player.clientId,
      username: player.username || 'Player',
      avatar: player.avatar || null,
      text,
    });
  }

  // A system line (round transitions, "X guessed it!", reveals).
  addSystem(text, kind = 'system', clientId = null) {
    this.pushMessage({ type: kind, text, clientId });
  }

  // True when the song has a guessable artist (iTunes always provides one, but
  // guard against blanks so the round can still end if it doesn't).
  artistRequired() {
    return !!(this.song && normalize(guessableTitle(this.song.artist)));
  }

  // The accepted answers for one target ('title' | 'artist'): both the core
  // (bracket-stripped) form and the full original.
  answersFor(target) {
    if (!this.song) return [];
    const raw = target === 'artist' ? this.song.artist : this.song.title;
    return [normalize(guessableTitle(raw)), normalize(raw)].filter(Boolean);
  }

  // Does this text match the song's title OR artist? Used to block the owner /
  // already-correct players from spoiling either answer in chat.
  isAnswer(text) {
    if (!this.song) return false;
    const g = normalize(text);
    return [...this.answersFor('title'), ...this.answersFor('artist')].includes(g);
  }

  // Is a wrong guess *almost* right (small edit distance to the title or
  // artist)? Lets us privately nudge the guesser without revealing anything.
  isCloseGuess(guess) {
    if (!this.song) return false;
    const g = normalize(guess);
    if (g.length < 3) return false;
    const targets = [...this.answersFor('title'), ...this.answersFor('artist')];
    return targets.some((t) => {
      if (!t || g === t) return false;
      const d = editDistance(g, t);
      return d > 0 && d <= Math.min(3, Math.max(1, Math.floor(t.length * 0.25)));
    });
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
  startGame() {
    this.settings = { ...DEFAULTS }; // fixed rules, no per-lobby configuration
    for (const p of this.players.values()) {
      p.score = 0;
      p.song = null;
    }
    this.roundNumber = 0;
    this.playOrder = [];
    this.playIndex = -1;
    this.ownerClientId = null;
    this.song = null;
    this.messages = [];
    this.addSystem('🎶 Game starting — everyone, pick your song!');
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
    this.revealedArtist = new Set();
    this.guessedThisRound = new Set();
    this.guessedArtist = new Set();
    this.roundEndsAt = Date.now() + this.settings.roundTimer * 1000;
    this.addSystem(`🎵 Round ${this.roundNumber}: guess ${owner?.username || 'someone'}'s song & artist!`);
    return this.song;
  }

  // Reveal one more random letter in BOTH the title and the artist as a clue.
  // Returns true if any new letter was revealed. Driven automatically by a timer
  // (every clueInterval seconds); never reveals the final hidden letter of each.
  revealClue() {
    if (!this.song) return false;
    const revealOne = (text, set) => {
      const candidates = maskableIndices(guessableTitle(text)).filter((i) => !set.has(i));
      if (candidates.length <= 1) return false; // never fully reveal via clues
      set.add(candidates[Math.floor(Math.random() * candidates.length)]);
      return true;
    };
    const t = revealOne(this.song.title, this.revealed);
    const a = revealOne(this.song.artist, this.revealedArtist);
    return t || a;
  }

  // Check a player's guess against the title AND the artist (each guessed
  // independently). Accepts either the core form ("Lighters") or the full one
  // ("Lighters (feat. Bruno Mars)"). Returns { correct, target, points } and
  // updates score. A single message resolves at most one target per call.
  submitGuess(clientId, guess) {
    if (this.phase !== PHASES.PLAYING || !this.song) return { correct: false };
    if (clientId === this.ownerClientId) return { correct: false, reason: 'owner' };

    const g = normalize(guess);
    if (!g) return { correct: false };

    // Which still-open target does this guess match? Title takes priority.
    let target = null;
    if (!this.guessedThisRound.has(clientId) && this.answersFor('title').includes(g)) {
      target = 'title';
    } else if (!this.guessedArtist.has(clientId) && this.answersFor('artist').includes(g)) {
      target = 'artist';
    }
    if (!target) return { correct: false };

    const player = this.players.get(clientId);
    const secondsLeft = Math.max(0, Math.round((this.roundEndsAt - Date.now()) / 1000));
    // Faster guesses score higher; clues are automatic & shared so there's no
    // per-player clue penalty.
    const points = Math.max(20, Math.round(20 + 80 * (secondsLeft / this.settings.roundTimer)));
    player.score += points;
    if (target === 'title') this.guessedThisRound.add(clientId);
    else this.guessedArtist.add(clientId);

    // Reward the song's owner too: a fixed bonus for each correct guess (title
    // or artist), so hosting a round isn't a scoring dead-zone.
    const owner = this.players.get(this.ownerClientId);
    let ownerPoints = 0;
    if (owner) {
      ownerPoints = this.settings.ownerBonus;
      owner.score += ownerPoints;
    }
    // 'song' reads better than 'title' in the chat announcement.
    const label = target === 'title' ? 'song' : 'artist';
    return { correct: true, target: label, points, ownerClientId: this.ownerClientId, ownerPoints };
  }

  // Has this player guessed everything there is to guess this round (title, and
  // the artist when there is one)?
  hasGuessedAll(clientId) {
    return (
      this.guessedThisRound.has(clientId) &&
      (!this.artistRequired() || this.guessedArtist.has(clientId))
    );
  }

  // Everyone (except the song's owner) guessed it all? Then the round can end early.
  allGuessed() {
    const guessers = [...this.players.values()].filter(
      (p) => p.connected && p.clientId !== this.ownerClientId
    );
    if (guessers.length === 0) return false;
    return guessers.every((p) => this.hasGuessedAll(p.clientId));
  }

  endRound() {
    this.phase = PHASES.ROUND_END;
    this.roundEndsAt = null;
    if (this.song) {
      const by = this.song.artist ? ` by ${this.song.artist}` : '';
      this.addSystem(`The song was “${this.song.title}”${by}.`, 'reveal');
    }
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
        hasGuessedSong: this.guessedThisRound.has(p.clientId),
        hasGuessedArtist: this.guessedArtist.has(p.clientId),
        hasGuessed: this.hasGuessedAll(p.clientId), // guessed everything this round
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
      messages: this.messages,
    };

    if ((this.phase === PHASES.PLAYING || this.phase === PHASES.ROUND_END) && this.song) {
      const owner = this.players.get(this.ownerClientId);
      const guessTitle = guessableTitle(this.song.title);
      const guessArtist = guessableTitle(this.song.artist);
      state.round = {
        masked: maskAnswer(guessTitle, this.revealed),
        maskedArtist: maskAnswer(guessArtist, this.revealedArtist),
        titleLength: guessTitle.length,
        artistLength: guessArtist.length,
        hasArtist: this.artistRequired(),
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
        state.round.artist = this.song.artist || null;
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
