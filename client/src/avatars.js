// Preset emoji avatars so users get a "profile picture" without uploading.
// An avatar value is either one of these emojis or an http(s) image URL.
export const AVATARS = [
  '🎤', '🎧', '🎸', '🎹', '🥁', '🎺', '🎻', '🎷',
  '🦊', '🐼', '🐸', '🦁', '🐙', '🦄', '👽', '🤖',
  '🌟', '🔥', '🍕', '🚀', '👑', '😎', '🎩', '💀',
];

export function isImageUrl(value) {
  return typeof value === 'string' && /^(https?:|data:image)/i.test(value);
}
