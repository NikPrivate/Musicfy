import Avatar from './Avatar.jsx';

export default function PlayerList({ players, youId, showScores = true }) {
  return (
    <ul className="player-list">
      {players.map((p) => (
        <li key={p.clientId} className={`player ${!p.connected ? 'offline' : ''}`}>
          <Avatar value={p.avatar} size={36} />
          <span className="player-name">
            {p.username}
            {p.clientId === youId && <em className="you-tag"> (you)</em>}
          </span>
          <span className="player-badges">
            {p.isHost && <span className="badge badge--host" title="Host">👑</span>}
            {p.isChooser && <span className="badge badge--chooser" title="Their song is playing">🎶</span>}
            {p.hasGuessed && <span className="badge badge--correct" title="Guessed it!">✅</span>}
            {!p.connected && <span className="badge" title="Disconnected">💤</span>}
          </span>
          {showScores && <span className="player-score">{p.score}</span>}
        </li>
      ))}
    </ul>
  );
}
