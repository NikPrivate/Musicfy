import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useParams, useNavigate } from "react-router-dom";
import {
  Share2,
  Pencil,
  LogOut,
  Music,
  Timer,
  Headphones,
  Lightbulb,
  Check,
  CheckCircle2,
  Play,
  MessageSquare,
  Sparkles,
  Trophy,
  RotateCcw,
  Star,
} from "lucide-react";
import { socket, emit } from "../socket.js";
import {
  getClientId,
  getProfile,
  saveProfile,
  hasProfile,
  clearIdentity,
} from "../identity.js";
import ProfileSetup from "../components/ProfileSetup.jsx";
import PlayerList from "../components/PlayerList.jsx";
import SongSearch from "../components/SongSearch.jsx";
import SnippetPlayer from "../components/SnippetPlayer.jsx";
import Avatar from "../components/Avatar.jsx";
import Chat from "../components/Chat.jsx";
import VolumeControl from "../components/VolumeControl.jsx";

export default function Room() {
  const { code } = useParams();
  const navigate = useNavigate();
  const clientId = getClientId();

  const [state, setState] = useState(null); // public lobby state
  const [joined, setJoined] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [joinError, setJoinError] = useState(""); // e.g. "Lobby is full"
  const [showLeave, setShowLeave] = useState(false); // leave-confirmation modal
  const [showEdit, setShowEdit] = useState(false); // edit name/avatar modal
  // needProfile drives whether we show the setup screen. If the user already
  // has a saved profile we skip it and auto-join — so re-clicking the share
  // link never spawns a duplicate player.
  const [needProfile, setNeedProfile] = useState(!hasProfile());

  // Keep a ref so socket reconnect handlers always have the latest values.
  const joinRef = useRef({ code, clientId });
  joinRef.current = { code, clientId };

  // Join (or rejoin) the lobby with the current profile.
  async function doJoin(profile) {
    const res = await emit("lobby:join", { code, clientId, profile });
    if (!res.ok) {
      if (res.full) setJoinError(res.error || "This lobby is full.");
      else setNotFound(true);
      return;
    }
    setJoinError("");
    setState(res.state);
    setJoined(true);
    setNeedProfile(false);
  }

  // Auto-join on mount if we already have a profile.
  useEffect(() => {
    if (!socket.connected) socket.connect();

    function onState(s) {
      setState(s);
    }
    socket.on("lobby:state", onState);

    // On (re)connect, transparently rejoin using our stable clientId so a
    // dropped connection never turns into a second player.
    function onConnect() {
      const p = getProfile();
      if (p && p.username) doJoin(p);
    }
    socket.on("connect", onConnect);

    if (hasProfile()) {
      doJoin(getProfile());
    } else {
      // Verify the lobby exists before showing the profile form.
      fetch(`/api/lobby/${code}`).then((r) => {
        if (!r.ok) setNotFound(true);
      });
    }

    return () => {
      socket.off("lobby:state", onState);
      socket.off("connect", onConnect);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  function handleProfileSubmit(profile) {
    saveProfile(profile);
    doJoin(profile);
  }

  // Block the browser Back button while in a lobby: re-push our entry so the
  // navigation is cancelled, and instead prompt the player to leave explicitly.
  // They can only exit via the "Leave lobby" button.
  useEffect(() => {
    if (!joined) return;
    window.history.pushState(null, "", window.location.href);
    function onPopState() {
      window.history.pushState(null, "", window.location.href);
      setShowLeave(true);
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [joined]);

  // Actually leave: tell the server to drop us, then go home.
  function leaveLobby() {
    emit("lobby:leave");
    setShowLeave(false);
    navigate("/");
  }

  // Save edited name/avatar: persist locally and push the change to everyone.
  function handleEditSubmit(profile) {
    saveProfile(profile);
    emit("profile:update", { profile });
    setShowEdit(false);
  }

  // Start over as a brand-new user: leave, wipe identity, reload home.
  async function resetIdentity() {
    await emit("lobby:leave");
    clearIdentity();
    window.location.href = "/";
  }

  if (notFound) {
    return (
      <div className="card centered">
        <h2>Lobby not found</h2>
        <p className="muted">
          The code “{code}” doesn’t match an active lobby.
        </p>
        <a className="btn" href="/">
          ← Back home
        </a>
      </div>
    );
  }

  if (joinError) {
    return (
      <div className="card centered">
        <h2>Lobby is full</h2>
        <p className="muted">{joinError}</p>
        <a className="btn" href="/">
          ← Back home
        </a>
      </div>
    );
  }

  if (needProfile && !joined) {
    return (
      <div className="room">
        <ShareBar code={code} />
        <ProfileSetup initial={getProfile()} onSubmit={handleProfileSubmit} />
      </div>
    );
  }

  if (!state) {
    return <div className="card centered">Connecting to lobby…</div>;
  }

  const you = state.players.find((p) => p.clientId === clientId);
  const isHost = state.hostClientId === clientId;
  const isChooser = state.chooserClientId === clientId;

  return (
    <div className="room">
      <ShareBar
        code={code}
        onEdit={() => setShowEdit(true)}
        onLeave={() => setShowLeave(true)}
      />

      {showEdit && (
        <div className="modal-overlay" onClick={() => setShowEdit(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <ProfileSetup
              initial={getProfile()}
              title="Edit your profile"
              subtitle="Change how everyone sees you. Updates instantly for the whole lobby."
              submitLabel="Save changes"
              onSubmit={handleEditSubmit}
            />
            <div className="modal-secondary">
              <button className="link-btn" onClick={() => setShowEdit(false)}>
                Cancel
              </button>
              <button
                className="link-btn link-btn--danger"
                onClick={resetIdentity}
              >
                Reset identity & start fresh
              </button>
            </div>
          </div>
        </div>
      )}

      {showLeave && (
        <div className="modal-overlay" onClick={() => setShowLeave(false)}>
          <div className="modal card" onClick={(e) => e.stopPropagation()}>
            <h3>Leave the lobby?</h3>
            <p className="muted">
              You'll exit the game
              {isHost ? " (the host role passes to someone else)" : ""}. You can
              rejoin from the invite link later.
            </p>
            <div className="modal-actions">
              <button className="btn" onClick={() => setShowLeave(false)}>
                Stay
              </button>
              <button className="btn btn--primary" onClick={leaveLobby}>
                Leave
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="room-grid">
        <aside className="card sidebar">
          <h3>
            {state.phase === "submitting" ? (
              <>
                Who's ready?{" "}
                <span className="muted">
                  ({state.players.filter((p) => p.hasSubmitted).length}/
                  {state.players.filter((p) => p.connected).length})
                </span>
              </>
            ) : (
              <>
                Players{" "}
                <span className="muted">
                  ({state.players.length} / {state.maxPlayers})
                </span>
              </>
            )}
          </h3>
          <PlayerList
            players={state.players}
            youId={clientId}
            submitting={state.phase === "submitting"}
          />
          {(state.phase === "playing" || state.phase === "roundEnd") && (
            <p className="round-indicator">
              Song {state.roundNumber} / {state.totalRounds}
            </p>
          )}
        </aside>

        <main className="stage">
          <Stage
            state={state}
            you={you}
            isHost={isHost}
            isChooser={isChooser}
            clientId={clientId}
            onLeave={leaveLobby}
          />
        </main>

        <Chat
          messages={state.messages}
          you={you}
          isChooser={isChooser}
          phase={state.phase}
        />
      </div>
    </div>
  );
}

// ---- Share bar -----------------------------------------------------------

function ShareBar({ code, onLeave, onEdit }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="share-bar card">
      <div>
        <span className="muted">Lobby code</span>
        <strong className="code">{code}</strong>
      </div>
      <div className="share-bar-actions">
        <VolumeControl className="share-volume" title="Master volume" label="Master volume" />
        <button className="btn btn--primary" onClick={() => setOpen(true)}>
          <Share2 size={15} style={{ verticalAlign: "-2px", marginRight: 6 }} />
          Share invite link
        </button>
        {onEdit && (
          <button className="btn btn--ghost" onClick={onEdit}>
            <Pencil
              size={15}
              style={{ verticalAlign: "-2px", marginRight: 6 }}
            />
            Edit profile
          </button>
        )}
        {onLeave && (
          <button className="btn btn--ghost" onClick={onLeave}>
            <LogOut
              size={15}
              style={{ verticalAlign: "-2px", marginRight: 6 }}
            />
            Leave lobby
          </button>
        )}
      </div>
      {open && <ShareModal code={code} onClose={() => setOpen(false)} />}
    </div>
  );
}

// A friendly invite popup: big lobby code + one-tap copy link.
function ShareModal({ code, onClose }) {
  const [copied, setCopied] = useState(false);
  const link = `${window.location.origin}/lobby/${code}`;

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      window.prompt("Copy this link:", link);
    }
  }

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal card share-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <h3>
          <Sparkles
            size={18}
            className="icon-primary"
            style={{ verticalAlign: "-3px", marginRight: 7 }}
          />
          Invite friends
        </h3>
        <p className="muted">
          Send the link — it drops them straight into this lobby.
        </p>

        <div className="share-code-big">
          <span className="muted">Lobby code</span>
          <strong>{code}</strong>
        </div>

        <div className="link-row">
          <input
            readOnly
            value={link}
            onFocus={(e) => e.target.select()}
            aria-label="Invite link"
          />
          <button className="btn btn--primary" onClick={copyLink}>
            {copied ? (
              <>
                <Check
                  size={14}
                  style={{ verticalAlign: "-2px", marginRight: 4 }}
                />
                Copied
              </>
            ) : (
              "Copy"
            )}
          </button>
        </div>

        <div className="share-modal-actions">
          <button className="btn btn--ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ---- Stage (phase router) ------------------------------------------------

function Stage({ state, you, isHost, isChooser, clientId, onLeave }) {
  switch (state.phase) {
    case "lobby":
      return <LobbyStage state={state} isHost={isHost} />;
    case "submitting":
      return <SubmittingStage state={state} isHost={isHost} you={you} />;
    case "playing":
      return <PlayingStage state={state} isChooser={isChooser} you={you} />;
    case "roundEnd":
      return <RoundEndStage state={state} isHost={isHost} />;
    case "gameEnd":
      return (
        <GameEndStage
          state={state}
          clientId={clientId}
          isHost={isHost}
          onLeave={onLeave}
        />
      );
    default:
      return null;
  }
}

// ---- Lobby (waiting room + settings) -------------------------------------

function LobbyStage({ state, isHost }) {
  const [error, setError] = useState("");
  const s = state.settings;

  async function start() {
    setError("");
    const res = await emit("game:start");
    if (!res.ok) setError(res.error || "Could not start the game.");
  }

  return (
    <div className="card">
      <h2>Waiting room</h2>
      <p className="muted">
        Share the invite link above. Once everyone’s in, the host starts the
        game.
      </p>

      <ul className="rules">
        <li>
          <Timer size={15} className="rule-icon" />
          <span>
            <strong>{s.roundTimer}s</strong> to guess each song
          </span>
        </li>
        <li>
          <Headphones size={15} className="rule-icon" />
          <span>
            <strong>{s.snippetDuration}s</strong> preview clip to guess from
          </span>
        </li>
        <li>
          <Lightbulb size={15} className="rule-icon" />
          <span>
            A new letter revealed every <strong>{s.clueInterval}s</strong>
          </span>
        </li>
        <li>
          <Music size={15} className="rule-icon" />
          <span>
            One round per player — <strong>{state.players.length}</strong> songs
            this game
          </span>
        </li>
      </ul>

      {error && <p className="error">{error}</p>}

      {isHost ? (
        <button
          className="btn btn--primary btn--big"
          onClick={start}
          disabled={state.players.length < 2}
        >
          {state.players.length < 2 ? (
            "Need at least 2 players…"
          ) : (
            <>
              <Sparkles
                size={15}
                style={{ verticalAlign: "-2px", marginRight: 6 }}
              />
              Start — everyone picks
            </>
          )}
        </button>
      ) : (
        <p className="muted">Waiting for the host to start…</p>
      )}
    </div>
  );
}

// ---- Submitting (everyone picks their song at once) ----------------------

function SubmittingStage({ state, isHost, you }) {
  const [error, setError] = useState("");
  const connected = state.players.filter((p) => p.connected);
  const submittedCount = connected.filter((p) => p.hasSubmitted).length;
  const allReady = submittedCount === connected.length;

  async function begin() {
    setError("");
    const res = await emit("game:begin");
    if (!res.ok) setError(res.error || "Could not begin the game.");
  }

  return (
    <div className="submitting">
      <SongSearch
        defaultDuration={state.settings.snippetDuration}
        alreadySubmitted={!!you?.hasSubmitted}
      />

      {error && <p className="error">{error}</p>}

      {isHost ? (
        <button
          className="btn btn--primary btn--big"
          onClick={begin}
          disabled={submittedCount < 2}
        >
          {submittedCount < 2 ? (
            "Waiting for players to pick…"
          ) : allReady ? (
            <>
              <Play
                size={14}
                style={{ verticalAlign: "-2px", marginRight: 5 }}
              />
              Begin — play the songs!
            </>
          ) : (
            <>
              <Play
                size={14}
                style={{ verticalAlign: "-2px", marginRight: 5 }}
              />
              Begin anyway ({submittedCount} ready)
            </>
          )}
        </button>
      ) : (
        <p className="muted">The host starts once everyone has picked.</p>
      )}
    </div>
  );
}

// ---- Playing -------------------------------------------------------------

function PlayingStage({ state, isChooser, you }) {
  const round = state.round;
  const remaining = useCountdown(state.roundEndsAt);
  const [answer, setAnswer] = useState(null); // { title, artist } — owner only
  const guessedSong = !!you?.hasGuessedSong;
  const guessedArtist = !!you?.hasGuessedArtist;
  const hasArtist = round?.hasArtist;
  const guessedAll = !!you?.hasGuessed;

  useEffect(() => {
    function onAnswer({ title, artist }) {
      setAnswer({ title, artist });
    }
    socket.on("round:answer", onAnswer);
    return () => socket.off("round:answer", onAnswer);
  }, []);

  return (
    <div className="card playing">
      <div className="timer-bar">
        <span className={`timer ${remaining <= 10 ? "urgent" : ""}`}>
          <Timer size={18} style={{ verticalAlign: "-3px", marginRight: 4 }} />
          {remaining}s
        </span>
      </div>

      <p className="muted centered">
        <Music
          size={15}
          style={{
            verticalAlign: "-2px",
            marginRight: 5,
            color: "var(--primary)",
          }}
        />
        {round.ownerName}'s song
      </p>

      {/* Album art stays blurred while guessing so it sets the mood without
          giving the answer away; it's revealed sharp at round end. */}
      {round.audio.artwork && (
        <img
          src={round.audio.artwork}
          alt=""
          className="album-art album-art--blurred"
        />
      )}

      <SnippetPlayer
        url={round.audio.url}
        startTime={round.audio.startTime}
        duration={round.audio.duration}
        autoPlay
        loop
        minimal
      />

      {isChooser ? (
        <p className="answer-reveal centered">
          {answer && (
            <>
              <strong>{answer.title}</strong>
              {answer.artist && (
                <>
                  {" "}
                  by <strong>{answer.artist}</strong>
                </>
              )}
            </>
          )}
        </p>
      ) : (
        <>
          <GuessTarget label="Song" masked={round.masked} done={guessedSong} />
          {hasArtist && (
            <GuessTarget
              label="Artist"
              masked={round.maskedArtist}
              done={guessedArtist}
            />
          )}
          <p className="muted clue-count">
            Guess the {hasArtist ? "song & artist" : "song"} · a new letter every{" "}
            {state.settings.clueInterval}s
          </p>
        </>
      )}

      {isChooser ? (
        <OwnerView />
      ) : guessedAll ? (
        <p className="success centered">
          <CheckCircle2
            size={15}
            style={{ verticalAlign: "-3px", marginRight: 5 }}
          />
          You got it all! Waiting for the round to end…
        </p>
      ) : (
        <p className="muted centered guess-hint">
          <MessageSquare
            size={15}
            style={{ verticalAlign: "-3px", marginRight: 5 }}
            className="icon-primary"
          />
          Type the {hasArtist ? "song or artist" : "song"} in the chat to guess →
        </p>
      )}
    </div>
  );
}

// The owner picked this song, so they already know the answer — they sit the
// round out and watch the guesses roll in.
function OwnerView() {
  return (
    <div className="chooser-view">
      <p className="muted">
        This is your song — sit back and watch. You earn points for every player
        who guesses it.
      </p>
    </div>
  );
}

// ---- Round end -----------------------------------------------------------

function RoundEndStage({ state, isHost }) {
  const answer = state.round?.answer;
  const artist = state.round?.artist;
  const ownerName = state.round?.ownerName;
  const isLast = state.roundNumber >= state.totalRounds;
  async function next() {
    await emit("round:next");
  }
  return (
    <div className="card centered">
      <h2>
        Song {state.roundNumber} of {state.totalRounds} over!
      </h2>
      {state.round?.audio?.artwork && (
        <img
          src={state.round.audio.artwork}
          alt="album cover"
          className="album-art"
        />
      )}
      <p className="answer-reveal">
        {ownerName ? `${ownerName}'s song was: ` : "The song was: "}
        <strong>{answer}</strong>
        {artist && (
          <>
            {" "}
            by <strong>{artist}</strong>
          </>
        )}
      </p>
      <h3>Scoreboard</h3>
      <PlayerList players={state.players} youId={null} />
      {isHost ? (
        <button className="btn btn--primary btn--big" onClick={next}>
          {isLast ? "See final results →" : "Next song →"}
        </button>
      ) : (
        <p className="muted">Waiting for the host to continue…</p>
      )}
    </div>
  );
}

// ---- Game end ------------------------------------------------------------

function GameEndStage({ state, clientId, isHost, onLeave }) {
  const players = state.players; // already sorted high → low
  const winner = players[0];
  const top3 = players.slice(0, 3);
  const yourRank = players.findIndex((p) => p.clientId === clientId) + 1;
  const [showScores, setShowScores] = useState(false);

  async function again() {
    await emit("game:reset");
  }

  return (
    <div className="gameover-overlay">
      <Confetti />
      <div className="gameover card">
        <div className="trophy">
          <Trophy size={64} style={{ color: "#FFD700" }} />
        </div>
        <h2 className="gameover-title">Game over!</h2>
        {winner && (
          <p className="winner-line">
            <Avatar value={winner.avatar} size={26} />
            <strong>{winner.username}</strong> wins with {winner.score} pts!
          </p>
        )}

        <Podium top3={top3} youId={clientId} />

        {yourRank > 0 && (
          <p className="your-rank">
            You finished <strong>#{yourRank}</strong> of {players.length}
          </p>
        )}

        <button className="link-btn" onClick={() => setShowScores((s) => !s)}>
          {showScores ? "Hide full scoreboard" : "Show full scoreboard"}
        </button>
        {showScores && (
          <div className="gameover-scores">
            <PlayerList players={players} youId={clientId} />
          </div>
        )}

        {isHost ? (
          <button className="btn btn--primary btn--big" onClick={again}>
            <RotateCcw
              size={16}
              style={{ verticalAlign: "-2px", marginRight: 6 }}
            />
            Play again
          </button>
        ) : (
          <p className="muted">Waiting for the host to start a new game…</p>
        )}
        <button
          className="btn btn--ghost btn--big"
          onClick={onLeave}
          style={{ marginTop: 8 }}
        >
          <LogOut size={16} style={{ verticalAlign: "-2px", marginRight: 6 }} />
          Leave lobby
        </button>
      </div>
    </div>
  );
}

// Top-3 podium: 2nd on the left, 1st (tallest) in the middle, 3rd on the right.
function Podium({ top3, youId }) {
  const medals = {
    1: <Trophy size={22} style={{ color: "#FFD700" }} />,
    2: <Star size={22} style={{ color: "#C0C0C0", fill: "#C0C0C0" }} />,
    3: <Star size={22} style={{ color: "#CD7F32", fill: "#CD7F32" }} />,
  };
  const rankClass = { 1: "first", 2: "second", 3: "third" };
  // Display order puts the winner centre-stage.
  const display = [top3[1], top3[0], top3[2]]
    .map((p) => (p ? { p, rank: top3.indexOf(p) + 1 } : null))
    .filter(Boolean);

  return (
    <div className="podium">
      {display.map(({ p, rank }) => (
        <div key={p.clientId} className={`podium-spot ${rankClass[rank]}`}>
          <span className="podium-medal">{medals[rank]}</span>
          <Avatar value={p.avatar} size={44} />
          <span className="podium-name" title={p.username}>{p.username}</span>
          {p.clientId === youId && <span className="you-tag">you</span>}
          <span className="podium-score">{p.score} pts</span>
          <div className="podium-bar">{rank}</div>
        </div>
      ))}
    </div>
  );
}

// Lightweight CSS-only confetti burst (no dependencies).
function Confetti() {
  const pieces = useMemo(() => {
    const colors = [
      "#8b5cff",
      "#ff5fa2",
      "#ffc24b",
      "#46e0a0",
      "#3fdfd4",
      "#ffffff",
    ];
    return Array.from({ length: 70 }, (_, i) => ({
      left: Math.random() * 100,
      delay: Math.random() * 2.5,
      duration: 2.6 + Math.random() * 2.4,
      bg: colors[i % colors.length],
      size: 6 + Math.random() * 7,
      rot: Math.random() * 360,
    }));
  }, []);
  return (
    <div className="confetti" aria-hidden="true">
      {pieces.map((p, i) => (
        <span
          key={i}
          className="confetti-piece"
          style={{
            left: `${p.left}%`,
            width: p.size,
            height: p.size,
            background: p.bg,
            animationDelay: `${p.delay}s`,
            animationDuration: `${p.duration}s`,
            transform: `rotate(${p.rot}deg)`,
          }}
        />
      ))}
    </div>
  );
}

// One labelled thing to guess (the song, or the artist) with its blanks. Shows
// a green check once the player has guessed this particular target.
function GuessTarget({ label, masked, done }) {
  return (
    <div className={`guess-target ${done ? "is-done" : ""}`}>
      <span className="guess-label">
        {label}
        {done && (
          <CheckCircle2
            size={14}
            className="icon-green"
            style={{ verticalAlign: "-2px", marginLeft: 5 }}
          />
        )}
      </span>
      <MaskedTitle masked={masked} />
    </div>
  );
}

// Renders the masked title grouped by WORDS. Each word is one non-breaking
// block, so the blanks show each word's length and a word never splits across
// rows — only whole words wrap. Punctuation is dropped for a clean look, so
// "I Don't Care" reads as "_ ____ ____".
function MaskedTitle({ masked }) {
  const words = masked
    .split(" ")
    .map((w) => w.split("").filter((c) => c === "_" || /[a-z0-9]/i.test(c)))
    .filter((chars) => chars.length > 0);
  return (
    <div className="masked">
      {words.map((chars, wi) => (
        <span className="mask-word" key={wi}>
          {chars.map((c, ci) => (
            <span
              key={ci}
              className={`mask-slot ${c === "_" ? "is-blank" : "is-filled"}`}
            >
              {c === "_" ? "" : c}
            </span>
          ))}
        </span>
      ))}
    </div>
  );
}

// ---- helpers -------------------------------------------------------------

function useCountdown(endsAt) {
  const [remaining, setRemaining] = useState(() => calc(endsAt));
  useEffect(() => {
    setRemaining(calc(endsAt));
    const id = setInterval(() => setRemaining(calc(endsAt)), 250);
    return () => clearInterval(id);
  }, [endsAt]);
  return remaining;
}

function calc(endsAt) {
  if (!endsAt) return 0;
  return Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
}
