import { isImageUrl } from '../avatars.js';

export default function Avatar({ value, size = 40 }) {
  const style = { width: size, height: size, fontSize: size * 0.55 };
  if (isImageUrl(value)) {
    return <img className="avatar" style={style} src={value} alt="avatar" />;
  }
  return (
    <span className="avatar avatar--emoji" style={style}>
      {value || '🎵'}
    </span>
  );
}
