import { useState } from 'react';
import { AVATARS, isImageUrl } from '../avatars.js';
import Avatar from './Avatar.jsx';

// Shown only when a returning visitor has NO saved profile yet. Once they set
// one it's persisted, so clicking the share link again skips this entirely
// (preventing duplicate players for the same person).
export default function ProfileSetup({ initial, onSubmit }) {
  const [username, setUsername] = useState(initial?.username || '');
  const [avatar, setAvatar] = useState(initial?.avatar || AVATARS[0]);
  const [imageUrl, setImageUrl] = useState(isImageUrl(initial?.avatar) ? initial.avatar : '');

  function submit(e) {
    e.preventDefault();
    const name = username.trim();
    if (!name) return;
    onSubmit({ username: name, avatar: imageUrl.trim() || avatar });
  }

  return (
    <div className="card profile-setup">
      <h2>Pick your identity</h2>
      <p className="muted">This is how your friends will see you in the lobby.</p>
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
            {AVATARS.map((a) => (
              <button
                type="button"
                key={a}
                className={`avatar-pick ${avatar === a && !imageUrl ? 'selected' : ''}`}
                onClick={() => {
                  setAvatar(a);
                  setImageUrl('');
                }}
              >
                {a}
              </button>
            ))}
          </div>
        </div>

        <label className="field">
          <span>…or paste an image URL (optional)</span>
          <input
            placeholder="https://example.com/me.png"
            value={imageUrl}
            onChange={(e) => setImageUrl(e.target.value)}
          />
        </label>

        <div className="preview">
          <Avatar value={imageUrl.trim() || avatar} size={56} />
          <strong>{username.trim() || 'Your name'}</strong>
        </div>

        <button className="btn btn--primary" type="submit" disabled={!username.trim()}>
          Join the lobby →
        </button>
      </form>
    </div>
  );
}
