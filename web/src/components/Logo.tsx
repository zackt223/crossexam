import { useId } from 'react';

/**
 * The mark: five pixels make an x, the centre left open where the claim is
 * inspected. 12-unit cells on a 64-unit tile; the centre ring is a 3.5u stroke
 * whose outer edge sits flush with its cell. The default form is white pixels
 * on a liquid-glass tile in the three blues (haze → signal → deep).
 */
export function LogoMark({ size = 28, flat = false, bare = false }: { size?: number; flat?: boolean; bare?: boolean }) {
  const id = useId().replace(/:/g, '');
  const ink = bare ? 'currentColor' : '#fff';
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" style={{ flex: 'none', display: 'block' }}>
      {!bare && (
        <>
          <defs>
            <linearGradient id={`t${id}`} x1="0.2" y1="0" x2="0.8" y2="1">
              <stop offset="0" stopColor="#7AD7FF" />
              <stop offset="0.45" stopColor="#00AAEE" />
              <stop offset="1" stopColor="#0078D4" />
            </linearGradient>
            <radialGradient id={`h${id}`} cx="0.3" cy="0.06" r="0.7">
              <stop offset="0" stopColor="#fff" stopOpacity="0.6" />
              <stop offset="0.5" stopColor="#fff" stopOpacity="0" />
            </radialGradient>
          </defs>
          <rect width="64" height="64" rx="15" fill={flat ? '#0078D4' : `url(#t${id})`} />
          {!flat && (
            <>
              <rect width="64" height="64" rx="15" fill={`url(#h${id})`} />
              <rect x="0.75" y="0.75" width="62.5" height="62.5" rx="14.3" fill="none" stroke="#fff" strokeOpacity="0.5" strokeWidth="1.5" />
            </>
          )}
        </>
      )}
      <g fill={ink}>
        <rect x="14" y="14" width="12" height="12" />
        <rect x="38" y="14" width="12" height="12" />
        <rect x="14" y="38" width="12" height="12" />
        <rect x="38" y="38" width="12" height="12" />
      </g>
      <rect x="27.75" y="27.75" width="8.5" height="8.5" fill="none" stroke={ink} strokeWidth="3.5" />
    </svg>
  );
}

/** The wordmark: lowercase, the x drawn with the mark's own pixels in signal blue. */
export function Wordmark({ dim = 'rgba(22,22,26,.4)', size = 15, suffix = '.dev' }: { dim?: string; size?: number; suffix?: string }) {
  return (
    <span className="wordmark" style={{ display: 'inline-flex', alignItems: 'center', fontWeight: 600, letterSpacing: '-0.03em', fontSize: size, whiteSpace: 'nowrap' }}>
      crosse
      <span aria-hidden="true" style={{ display: 'inline-flex', color: '#00AAEE', margin: '0 0.04em', transform: 'translateY(0.06em)' }}>
        <LogoMark bare size={Math.round(size * 0.66)} />
      </span>
      <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>x</span>
      am{suffix && <span style={{ color: dim, fontWeight: 500 }}>{suffix}</span>}
    </span>
  );
}
