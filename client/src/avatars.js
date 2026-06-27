export function dicebearUrl(seed) {
  return `https://api.dicebear.com/9.x/fun-emoji/svg?seed=${encodeURIComponent(seed)}`;
}

export function randomSeeds(count = 8) {
  return Array.from({ length: count }, () => Math.random().toString(36).slice(2, 10));
}

export function isImageUrl(value) {
  return typeof value === 'string' && /^(https?:|data:image)/i.test(value);
}
