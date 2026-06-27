import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { dicebearUrl, randomSeeds, isImageUrl } from '../avatars.js';
import Avatar from './Avatar.jsx';

export default function ProfileSetup({
  initial,
  onSubmit,
  title = 'Pick your identity',
  subtitle = 'This is how your friends will see you in the lobby.',
  submitLabel = 'Join the lobby →',
}) {
  const [username, setUsername] = useState(initial?.username || '');

  const [seeds, setSeeds] = useState(() => randomSeeds(8));
  const [avatar, setAvatar] = useState(() => {
    if (initial?.avatar && isImageUrl(initial.avatar)) return initial.avatar;
    const s = randomSeeds(8);
    return dicebearUrl(s[0]);
  });

  function shuffle() {
    const next = randomSeeds(8);
    setSeeds(next);
  }

  function submit(e) {
    e.preventDefault();
    const name = username.trim();
    if (!name) return;
    onSubmit({ username: name, avatar });
  }

  return (
    <div className="card profile-setup">
      <h2>{title}</h2>
      <p className="muted">{subtitle}</p>
      <form onSubmit={submit}>
        <label className="field">
          <span>Username</span>
          <input
            autoFocus
            maxLength={24}
            placeholder="e.g. DJ Sparkles"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>

        <div className="field">
          <span>Profile picture</span>
          <div className="avatar-grid">
            {seeds.map((seed) => {
              const url = dicebearUrl(seed);
              return (
                <button
                  type="button"
                  key={seed}
                  className={`avatar-pick ${avatar === url ? 'selected' : ''}`}
                  onClick={() => setAvatar(url)}
                >
                  <img src={url} alt="avatar" width={52} height={52} />
                </button>
              );
            })}
          </div>
          <button type="button" className="btn btn--ghost avatar-shuffle" onClick={shuffle}>
            <RefreshCw size={13} style={{ verticalAlign: '-2px', marginRight: 5 }} />
            Shuffle
          </button>
        </div>

        <div className="preview">
          <Avatar value={avatar} size={56} />
          <strong>{username.trim() || 'Your name'}</strong>
        </div>

        <button className="btn btn--primary" type="submit" disabled={!username.trim()}>
          {submitLabel}
        </button>
      </form>
    </div>
  );
}
