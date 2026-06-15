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

// Audius: free, key-less streaming of FULL tracks. The stream endpoint serves
// the whole MP3 with HTTP range support, so the player can seek to *any* point
// — that's what lets users pick any part of the song. Catalog leans indie /
// electronic / hip-hop, so we pair it with iTunes for mainstream coverage.
const AUDIUS = 'https://api.audius.co/v1';
const APP = 'Musicfy';

async function searchAudius(q) {
  const url = `${AUDIUS}/tracks/search?query=${encodeURIComponent(q)}&app_name=${APP}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Audius ${r.status}`);
  const data = await r.json();
  return (data.data || [])
    .filter((t) => t.is_streamable !== false && t.duration > 0)
    .slice(0, 5)
    .map((t) => ({
      id: `audius:${t.id}`,
      source: 'audius',
      full: true, // whole track — any segment is fair game
      title: t.title,
      artist: t.user?.name || 'Unknown artist',
      artwork: t.artwork?.['480x480'] || t.artwork?.['150x150'] || '',
      audioUrl: `${AUDIUS}/tracks/${t.id}/stream?app_name=${APP}`,
      length: t.duration, // full track length in seconds
    }));
}

async function searchItunes(q) {
  const url =
    'https://itunes.apple.com/search?media=music&entity=song&limit=6&term=' +
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
    }));
}

// Song search proxy. The browser calls this as the player types. We query
// Audius (full songs) and iTunes (mainstream 30s previews) in parallel and
// return a single normalized list; one source failing doesn't break the other.
app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (!q) return res.json({ results: [] });
  const [audius, itunes] = await Promise.allSettled([searchAudius(q), searchItunes(q)]);
  if (audius.status === 'rejected') console.error('Audius search failed:', audius.reason?.message);
  if (itunes.status === 'rejected') console.error('iTunes search failed:', itunes.reason?.message);
  const results = [
    ...(audius.status === 'fulfilled' ? audius.value : []),
    ...(itunes.status === 'fulfilled' ? itunes.value : []),
  ];
  if (!results.length && audius.status === 'rejected' && itunes.status === 'rejected') {
    return res.status(502).json({ results: [], error: 'Search unavailable' });
  }
  res.json({ results });
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
  socket.on('game:start', ({ settings }, cb) => {
    const lobby = manager.get(socket.data.code);
    if (!lobby) return cb?.({ ok: false });
    if (lobby.hostClientId !== socket.data.clientId) {
      return cb?.({ ok: false, error: 'Only the host can start' });
    }
    if (lobby.players.size < 2) {
      return cb?.({ ok: false, error: 'Need at least 2 players' });
    }
    lobby.startGame(settings);
    cb?.({ ok: true });
    broadcast(lobby);
  });

  // A player submits (or changes) their chosen song + which part to play.
  socket.on('song:submit', ({ song }, cb) => {
    const lobby = manager.get(socket.data.code);
    if (!lobby) return cb?.({ ok: false });
    if (lobby.phase !== PHASES.SUBMITTING) {
      return cb?.({ ok: false, error: 'Not accepting songs right now' });
    }
    if (!song?.title || !song?.audioUrl) {
      return cb?.({ ok: false, error: 'Pick a song from the search results' });
    }
    lobby.submitSong(socket.data.clientId, song);
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

  // Host returns everyone to the lobby after the game ends (play again).
  socket.on('game:reset', (_payload, cb) => {
    const lobby = manager.get(socket.data.code);
    if (!lobby) return cb?.({ ok: false });
    if (lobby.hostClientId !== socket.data.clientId) return cb?.({ ok: false });
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

  socket.on('disconnect', () => {
    const lobby = manager.get(socket.data.code);
    if (!lobby) return;
    lobby.markDisconnected(socket.id);
    lobby.reassignHostIfNeeded();
    broadcast(lobby);
    // Clean up fully-empty lobbies after a grace period.
    if (lobby.isEmpty()) {
      setTimeout(() => {
        if (lobby.isEmpty()) manager.remove(lobby.code);
      }, 60 * 1000);
    }
  });
});

server.listen(PORT, () => {
  console.log(`🎵 Musicfy server running on http://localhost:${PORT}`);
});
