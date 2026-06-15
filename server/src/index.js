import express from 'express';
import http from 'http';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';
import { LobbyManager, PHASES } from './lobby.js';

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
// chooser their private answer view.
function broadcast(lobby) {
  io.to(lobby.code).emit('lobby:state', lobby.publicState());
  if (lobby.song && lobby.phase === PHASES.PLAYING) {
    const chooser = lobby.players.get(lobby.chooserClientId);
    if (chooser?.socketId) {
      io.to(chooser.socketId).emit('round:answer', { title: lobby.song.title });
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
      lobby.endRound();
      broadcast(lobby);
    }
  }, ms);
}

function maybeEndRoundEarly(lobby) {
  if (lobby.phase === PHASES.PLAYING && lobby.allGuessed()) {
    clearTimeout(lobby.timer);
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

  // Host starts the game.
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

  // The current chooser locks in a song; the round goes live.
  socket.on('round:choose', ({ song }, cb) => {
    const lobby = manager.get(socket.data.code);
    if (!lobby) return cb?.({ ok: false });
    if (lobby.chooserClientId !== socket.data.clientId) {
      return cb?.({ ok: false, error: 'Only the chooser can pick the song' });
    }
    if (!song?.title || !song?.audioUrl) {
      return cb?.({ ok: false, error: 'Song needs a title and an audio URL' });
    }
    lobby.startRound(song);
    cb?.({ ok: true });
    broadcast(lobby);
    scheduleRoundTimer(lobby);
  });

  // A guesser submits a guess.
  socket.on('round:guess', ({ guess }, cb) => {
    const lobby = manager.get(socket.data.code);
    if (!lobby) return cb?.({ ok: false });
    const result = lobby.submitGuess(socket.data.clientId, guess);
    cb?.({ ok: true, ...result });
    if (result.correct) {
      const ended = maybeEndRoundEarly(lobby);
      broadcast(lobby);
      if (ended) clearTimeout(lobby.timer);
    }
  });

  // Reveal one more letter as a clue (shared for the round).
  socket.on('round:clue', (_payload, cb) => {
    const lobby = manager.get(socket.data.code);
    if (!lobby) return cb?.({ ok: false });
    const revealed = lobby.revealClue();
    cb?.({ ok: true, revealed });
    if (revealed) broadcast(lobby);
  });

  // Advance from round-end to the next round (or finish the game).
  socket.on('round:next', (_payload, cb) => {
    const lobby = manager.get(socket.data.code);
    if (!lobby) return cb?.({ ok: false });
    if (lobby.hostClientId !== socket.data.clientId) {
      return cb?.({ ok: false, error: 'Only the host can advance' });
    }
    if (lobby.isLastRound()) {
      lobby.endGame();
    } else {
      lobby.nextChooser();
    }
    cb?.({ ok: true });
    broadcast(lobby);
  });

  // Host returns everyone to the lobby after the game ends (play again).
  socket.on('game:reset', (_payload, cb) => {
    const lobby = manager.get(socket.data.code);
    if (!lobby) return cb?.({ ok: false });
    if (lobby.hostClientId !== socket.data.clientId) return cb?.({ ok: false });
    lobby.phase = PHASES.LOBBY;
    lobby.roundNumber = 0;
    lobby.song = null;
    for (const p of lobby.players.values()) p.score = 0;
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
