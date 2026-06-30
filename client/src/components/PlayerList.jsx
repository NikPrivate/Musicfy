import { Crown, Music2, CheckCircle2, WifiOff, Clock } from 'lucide-react';
import Avatar from './Avatar.jsx';

export default function PlayerList({ players, youId, showScores = true, submitting = false }) {
  return (
    <ul className="player-list">
      {players.map((p) => {
        const isYou = p.clientId === youId;
        const hasBadge = p.isHost || p.isChooser || p.hasGuessed || !p.connected;
        return (
          <li key={p.clientId} className={`player ${!p.connected ? 'offline' : ''}`}>
            <Avatar value={p.avatar} size={36} />
            <div className="player-info">
              <span className="player-username" title={p.username}>{p.username}</span>
              {/* Only render the meta line when it has content, so a plain
                  player stays a single row centred against the avatar. */}
              {(isYou || hasBadge) && (
                <span className="player-meta">
                  {isYou && <span className="you-tag">you</span>}
                  <span className="player-badges">
                    {p.isHost && <span className="badge badge--host" title="Host"><Crown size={13} /></span>}
                    {p.isChooser && <span className="badge badge--chooser" title="Their song is playing"><Music2 size={13} /></span>}
                    {p.hasGuessed && <span className="badge badge--correct" title="Guessed it!"><CheckCircle2 size={13} /></span>}
                    {!p.connected && <span className="badge" title="Disconnected"><WifiOff size={13} /></span>}
                  </span>
                </span>
              )}
            </div>
            {/* Score / ready-status sits outside player-info so it's always
                vertically centred with the avatar, regardless of meta height. */}
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
        );
      })}
    </ul>
  );
}
