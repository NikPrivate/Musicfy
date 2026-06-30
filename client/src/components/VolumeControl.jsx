import { Volume2, VolumeX } from 'lucide-react';
import { useVolume, setVolume } from '../volume.js';

// The master volume slider. Reads/writes the shared volume store, so it shows
// (and sets) the single level used everywhere in the app.
export default function VolumeControl({ className = '', title = 'Volume', label = 'Volume' }) {
  const volume = useVolume();
  return (
    <label className={`volume ${className}`} title={title}>
      <span aria-hidden="true">{volume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}</span>
      <input
        type="range"
        min="0"
        max="1"
        step="0.01"
        value={volume}
        style={{ '--pct': `${(volume * 100).toFixed(1)}%` }}
        onChange={(e) => setVolume(Number(e.target.value))}
        aria-label={label}
      />
    </label>
  );
}
