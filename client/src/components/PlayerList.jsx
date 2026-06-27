import { Crown, Music2, CheckCircle2, WifiOff, Clock } from 'lucide-react';
import Avatar from './Avatar.jsx';

export default function PlayerList({ players, youId, showScores = true, submitting = false }) {
  return (
    <ul className="player-list">
      {players.map((p) => (
        <li key={p.clientId} className={`player ${!p.connected ? 'offline' : ''}`}>
          <Avatar value={p.avatar} size={36} />
          <span className="player-name">
            {p.username}
            {p.clientId === youId && <span className="you-tag">you</span>}
          </span>
          <span className="player-badges">
            {p.isHost && <span className="badge badge--host" title="Host"><Crown size={13} /></span>}
            {p.isChooser && <span className="badge badge--chooser" title="Their song is playing"><Music2 size={13} /></span>}
            {p.hasGuessed && <span className="badge badge--correct" title="Guessed it!"><CheckCircle2 size={13} /></span>}
            {!p.connected && <span className="badge" title="Disconnected"><WifiOff size={13} /></span>}
          </span>
          {submitting ? (
            <span className="player-status" title={p.hasSubmitted ? 'Ready' : 'Picking…'}>
              {p.hasSubmitted
                ? <CheckCircle2 size={14} className="icon-green" />
                : <Clock size={14} className="icon-muted" />}
            </span>
          ) : (
            showScores && <span className="player-score">{p.score}</span>
          )}
        </li>
      ))}
    </ul>
  );
}
