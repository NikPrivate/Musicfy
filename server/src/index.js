import express from 'express';
import http from 'http';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';
import { LobbyManager, PHASES, MAX_PLAYERS } from './lobby.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4000;

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

const manager = new LobbyManager();

// Lightweight REST: check whether a lobby code exists before trying to join,
// so the join page can show a friendly error.
app.get('/api/lobby/:code', (req, res) => {
  const lobby = manager.get(req.params.code);
  if (!lobby) return res.status(404).json({ error: 'Lobby not found' });
  res.json({ code: lobby.code, phase: lobby.phase, players: lobby.players.size });
});

// Normalize for fuzzy comparison: lowercase, strip accents/punctuation,
// collapse whitespace. "Beyoncé - Déjà Vu!" -> "beyonce deja vu".
function normalize(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Levenshtein edit distance, used to catch small typos ("imagin" -> "imagine").
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

// How closely two strings match, 0 (nothing) .. 1 (identical). Combines
// exact/prefix/substring checks with a typo-tolerant edit-distance fallback.
function similarity(query, target) {
  if (!query || !target) return 0;
  if (query === target) return 1;
  if (target.startsWith(query)) return 0.95;
  if (target.includes(query)) return 0.85;
  const dist = editDistance(query, target);
  const longer = Math.max(query.length, target.length);
  return longer ? Math.max(0, 1 - dist / longer) : 0;
}

// Relevance score for a track against the typed query. Looks at the full
// "title artist" string, the title and artist on their own, and matches each
// query word against each target word so partial/out-of-order typing still
// surfaces the obvious song.
function scoreMatch(q, title, artist) {
  const query = normalize(q);
  const nTitle = normalize(title);
  const nArtist = normalize(artist);
  const combined = `${nTitle} ${nArtist}`.trim();

  let score = Math.max(
    similarity(query, nTitle),
    similarity(query, nArtist),
    similarity(query, combined) * 0.9,
  );

  // Per-word matching: every query word should find a close target word.
  const qWords = query.split(' ').filter(Boolean);
  const tWords = combined.split(' ').filter(Boolean);
  if (qWords.length && tWords.length) {
    const wordScore =
      qWords.reduce(
        (sum, qw) => sum + Math.max(...tWords.map((tw) => similarity(qw, tw))),
        0,
      ) / qWords.length;
    score = Math.max(score, wordScore * 0.95);
  }

  return score;
}

async function searchItunes(q) {
  // Pull a wide pool (one call, no extra requests) so re-ranking has enough
  // candidates to surface the right track even from a rough query.
  const url =
    'https://itunes.apple.com/search?media=music&entity=song&limit=50&term=' +
    encodeURIComponent(q);
  const r = await fetch(url, { headers: { 'User-Agent': 'Musicfy/1.0' } });
  if (!r.ok) throw new Error(`iTunes ${r.status}`);
  const data = await r.json();
  return (data.results || [])
    .filter((t) => t.previewUrl) // only songs we can actually play
    .map((t) => ({
      id: `itunes:${t.trackId}`,
      source: 'itunes',
      full: false, // ~30s preview clip only
      title: t.trackName,
      artist: t.artistName,
      artwork: (t.artworkUrl100 || '').replace('100x100', '200x200'),
      audioUrl: t.previewUrl,
      length: 30,
      _score: scoreMatch(q, t.trackName, t.artistName),
    }))
    .sort((a, b) => b._score - a._score) // closest matches first
    .slice(0, 12) // popup scrolls, so show a deeper ranked list
    .map(({ _score, ...rest }) => rest);
}

// Song search proxy. The browser calls this as the player types. We query
// Audius (full songs) and iTunes (mainstream 30s previews) in parallel and
// return a single normalized list; one source failing doesn't break the other.
app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (!q) return res.json({ results: [] });
  try {
    const results = await searchItunes(q);
    res.json({ results });
  } catch (err) {
    console.error('iTunes search failed:', err.message);
    res.status(502).json({ results: [], error: 'Search unavailable' });
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Serve the built client in production.
const clientDist = path.resolve(__dirname, '../../client/dist');
app.use(express.static(clientDist));
app.get(/^(?!\/api|\/socket\.io).*/, (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'), (err) => {
    if (err) res.status(404).send('Client not built. Run `npm run build`.');
  });
});

// Broadcast the public state of a lobby to everyone in its room, and send the
// song's owner their private answer view.
function broadcast(lobby) {
  io.to(lobby.code).emit('lobby:state', lobby.publicState());
  if (lobby.song && lobby.phase === PHASES.PLAYING) {
    const owner = lobby.players.get(lobby.ownerClientId);
    if (owner?.socketId) {
      io.to(owner.socketId).emit('round:answer', { title: lobby.song.title });
    }
  }
}

// Auto-end a round when its timer expires.
function scheduleRoundTimer(lobby) {
  clearTimeout(lobby.timer);
  if (!lobby.roundEndsAt) return;
  const ms = Math.max(0, lobby.roundEndsAt - Date.now());
  lobby.timer = setTimeout(() => {
    if (lobby.phase === PHASES.PLAYING) {
      stopClueTimer(lobby);
      lobby.endRound();
      broadcast(lobby);
    }
  }, ms);
}

// Automatically reveal one more letter every `clueInterval` seconds while a
// round is live, so the title fills in like a hangman clue without anyone
// having to click anything.
function scheduleClueTimer(lobby) {
  stopClueTimer(lobby);
  const everyMs = Math.max(1, lobby.settings.clueInterval) * 1000;
  lobby.clueTimer = setInterval(() => {
    if (lobby.phase !== PHASES.PLAYING) return stopClueTimer(lobby);
    if (lobby.revealClue()) broadcast(lobby);
  }, everyMs);
}

function stopClueTimer(lobby) {
  clearInterval(lobby.clueTimer);
  lobby.clueTimer = null;
}

// Kick off everything a live round needs: round-end timer + auto-clue timer.
function startRound(lobby) {
  broadcast(lobby);
  scheduleRoundTimer(lobby);
  scheduleClueTimer(lobby);
}

function maybeEndRoundEarly(lobby) {
  if (lobby.phase === PHASES.PLAYING && lobby.allGuessed()) {
    clearTimeout(lobby.timer);
    stopClueTimer(lobby);
    lobby.endRound();
    return true;
  }
  return false;
}

// Handle a player departing a lobby, whether via the in-app "Leave lobby"
// button or by closing/losing their browser. While a round is live we only mark
// them disconnected so the play order + scores survive a reconnect; otherwise
// (waiting in the lobby, submitting, game over) we fully remove them so they
// don't linger as a "no connection" ghost in everyone else's player list.
function removePlayer(lobby, socket) {
  const clientId = socket.data.clientId;
  const inGame = lobby.phase === PHASES.PLAYING || lobby.phase === PHASES.ROUND_END;
  if (inGame) {
    lobby.markDisconnected(socket.id);
  } else {
    lobby.players.delete(clientId);
    lobby.playOrder = lobby.playOrder.filter((id) => id !== clientId);
  }
  lobby.reassignHostIfNeeded();
  broadcast(lobby);
  // Clean up fully-empty lobbies after a grace period.
  if (lobby.isEmpty()) {
    setTimeout(() => {
      if (lobby.isEmpty()) manager.remove(lobby.code);
    }, 60 * 1000);
  }
}

io.on('connection', (socket) => {
  // socket.data holds the lobby code + clientId once joined.

  socket.on('lobby:create', (_payload, cb) => {
    const lobby = manager.create();
    cb?.({ ok: true, code: lobby.code });
  });

  // Join (or rejoin) a lobby. clientId is a stable id from the browser's
  // localStorage so the same person reconnecting/clicking-the-link-again does
  // NOT create a duplicate player.
  socket.on('lobby:join', ({ code, clientId, profile }, cb) => {
    const lobby = manager.get(code);
    if (!lobby) return cb?.({ ok: false, error: 'Lobby not found' });
    if (!clientId) return cb?.({ ok: false, error: 'Missing client id' });

    // Enforce the player cap, but never lock out someone already in the lobby
    // who is just reconnecting/refreshing.
    if (!lobby.players.has(clientId) && lobby.isFull()) {
      return cb?.({ ok: false, error: `Lobby is full (max ${MAX_PLAYERS} players)`, full: true });
    }

    const { player, isNew } = lobby.upsertPlayer(clientId, socket.id, profile);

    socket.join(lobby.code);
    socket.data.code = lobby.code;
    socket.data.clientId = clientId;

    cb?.({
      ok: true,
      isNew,
      you: { clientId, isHost: lobby.hostClientId === clientId },
      state: lobby.publicState(),
    });
    broadcast(lobby);
  });

  // Update username / avatar.
  socket.on('profile:update', ({ profile }, cb) => {
    const lobby = manager.get(socket.data.code);
    if (!lobby) return cb?.({ ok: false });
    const player = lobby.players.get(socket.data.clientId);
    if (!player) return cb?.({ ok: false });
    if (profile?.username) player.username = profile.username.slice(0, 24);
    if (profile?.avatar) player.avatar = profile.avatar;
    cb?.({ ok: true });
    broadcast(lobby);
  });

  // Host moves the lobby into the song-submission phase. Now EVERY player
  // searches for and submits their own song at the same time.
  socket.on('game:start', (_payload, cb) => {
    const lobby = manager.get(socket.data.code);
    if (!lobby) return cb?.({ ok: false });
    if (lobby.hostClientId !== socket.data.clientId) {
      return cb?.({ ok: false, error: 'Only the host can start' });
    }
    if (lobby.players.size < 2) {
      return cb?.({ ok: false, error: 'Need at least 2 players' });
    }
    lobby.startGame();
    cb?.({ ok: true });
    broadcast(lobby);
  });

  // A player submits (or changes) their chosen song + which part to play.
  socket.on('song:submit', ({ song }, cb) => {
    const lobby = manager.get(socket.data.code);
    if (!lobby) return cb?.({ ok: false, error: 'Lobby not found' });
    if (!socket.data.clientId) {
      return cb?.({ ok: false, error: 'Not joined yet — refresh and try again.' });
    }
    if (lobby.phase !== PHASES.SUBMITTING) {
      return cb?.({ ok: false, error: 'Not accepting songs right now' });
    }
    if (!song?.title || !song?.audioUrl) {
      return cb?.({ ok: false, error: 'Pick a song from the search results' });
    }
    // submitSong returns false if the player isn't in the lobby (e.g. a stale
    // socket after a reconnect). Surface that instead of falsely confirming —
    // otherwise the player thinks they're in but their song never plays.
    const stored = lobby.submitSong(socket.data.clientId, song);
    if (!stored) {
      return cb?.({ ok: false, error: 'Could not save your song — please rejoin the lobby.' });
    }
    cb?.({ ok: true });
    broadcast(lobby);
  });

  // Host begins playback once enough players have submitted. Each player's
  // song will play in turn.
  socket.on('game:begin', (_payload, cb) => {
    const lobby = manager.get(socket.data.code);
    if (!lobby) return cb?.({ ok: false });
    if (lobby.hostClientId !== socket.data.clientId) {
      return cb?.({ ok: false, error: 'Only the host can begin' });
    }
    if (lobby.phase !== PHASES.SUBMITTING) return cb?.({ ok: false });
    if (lobby.submittedPlayers().length < 2) {
      return cb?.({ ok: false, error: 'Need at least 2 submitted songs' });
    }
    lobby.beginPlayback();
    cb?.({ ok: true });
    startRound(lobby);
  });

  // A guesser submits a guess.
  socket.on('round:guess', ({ guess }, cb) => {
    const lobby = manager.get(socket.data.code);
    if (!lobby) return cb?.({ ok: false });
    const result = lobby.submitGuess(socket.data.clientId, guess);
    cb?.({ ok: true, ...result });
    if (result.correct) {
      maybeEndRoundEarly(lobby);
      broadcast(lobby);
    }
  });

  // Advance from round-end to the next song (or finish the game).
  socket.on('round:next', (_payload, cb) => {
    const lobby = manager.get(socket.data.code);
    if (!lobby) return cb?.({ ok: false });
    if (lobby.hostClientId !== socket.data.clientId) {
      return cb?.({ ok: false, error: 'Only the host can advance' });
    }
    if (lobby.isLastRound()) {
      lobby.endGame();
      cb?.({ ok: true });
      broadcast(lobby);
    } else {
      lobby.nextSong();
      cb?.({ ok: true });
      startRound(lobby);
    }
  });

  // Only the host sends everyone back to the lobby after the game ends (play
  // again) — otherwise one player clicking would yank the game-over screen out
  // from under everyone else. It only does anything once the game has ended.
  socket.on('game:reset', (_payload, cb) => {
    const lobby = manager.get(socket.data.code);
    if (!lobby) return cb?.({ ok: false });
    if (socket.data.clientId !== lobby.hostClientId) return cb?.({ ok: false });
    if (lobby.phase !== PHASES.GAME_END) return cb?.({ ok: false });
    clearTimeout(lobby.timer);
    stopClueTimer(lobby);
    lobby.phase = PHASES.LOBBY;
    lobby.roundNumber = 0;
    lobby.playOrder = [];
    lobby.playIndex = -1;
    lobby.ownerClientId = null;
    lobby.song = null;
    for (const p of lobby.players.values()) {
      p.score = 0;
      p.song = null;
    }
    cb?.({ ok: true });
    broadcast(lobby);
  });

  // Deliberately leave the lobby (via the in-app "Leave lobby" button). Unlike
  // a transient disconnect, this fully removes the player before the game is
  // running; mid-game we just mark them gone so the play order stays intact.
  socket.on('lobby:leave', (_payload, cb) => {
    const lobby = manager.get(socket.data.code);
    if (lobby) {
      removePlayer(lobby, socket);
      socket.leave(lobby.code);
    }
    socket.data.code = null;
    socket.data.clientId = null;
    cb?.({ ok: true });
  });

  socket.on('disconnect', () => {
    const lobby = manager.get(socket.data.code);
    if (!lobby) return;
    // Closing the browser/tab while waiting in the lobby should remove the
    // player outright (they left), not leave them as a "no connection" ghost.
    // Mid-game it still just marks them disconnected so they can reconnect.
    removePlayer(lobby, socket);
  });
});

server.listen(PORT, () => {
  console.log(`🎵 Musicfy server running on http://localhost:${PORT}`);
});
