import { useEffect, useId, useRef, useState } from 'react';

/**
 * The witness, big: a glossy app icon whose ghost watches your cursor.
 * Eyes follow the pointer, the icon tilts toward it, a click makes it blink.
 */
export function Ghost({ size = 132 }: { size?: number }) {
  const id = useId().replace(/:/g, '');
  const ref = useRef<HTMLButtonElement>(null);
  const [look, setLook] = useState({ x: 0, y: 0 });
  const [tilt, setTilt] = useState({ x: 0, y: 0 });
  const [blink, setBlink] = useState(false);
  const [boop, setBoop] = useState(0);

  useEffect(() => {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    let target = { x: 0, y: 0, tx: 0, ty: 0 };
    const onMove = (e: PointerEvent) => {
      const r = ref.current?.getBoundingClientRect();
      if (!r) return;
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height * 0.52);
      const dist = Math.hypot(dx, dy) || 1;
      const pull = Math.min(1, dist / 240);
      target = { x: (dx / dist) * pull * 1.5, y: (dy / dist) * pull * 1.5, tx: reduce ? 0 : Math.max(-1, Math.min(1, dx / 500)) * 12, ty: reduce ? 0 : Math.max(-1, Math.min(1, dy / 500)) * -12 };
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        setLook({ x: target.x, y: target.y });
        setTilt({ x: target.ty, y: target.tx });
      });
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    // A blink every few seconds, so it feels alive when nobody's moving.
    let t: ReturnType<typeof setTimeout>;
    const schedule = () => {
      t = setTimeout(() => {
        setBlink(true);
        setTimeout(() => setBlink(false), 140);
        schedule();
      }, 2600 + Math.random() * 3200);
    };
    if (!reduce) schedule();
    return () => {
      window.removeEventListener('pointermove', onMove);
      cancelAnimationFrame(raf);
      clearTimeout(t);
    };
  }, []);

  const poke = () => {
    setBlink(true);
    setBoop((b) => b + 1);
    setTimeout(() => setBlink(false), 160);
  };

  const eye = (cx: number, cy: number) => (
    <g>
      <ellipse cx={cx} cy={cy} rx="3.3" ry={blink ? 0.35 : 3.9} fill="#fff" style={{ transition: 'ry .08s' }} />
      {!blink && <ellipse cx={cx + 0.9 + look.x} cy={cy + 0.3 + look.y} rx="2" ry="2.6" fill="#0b1220" />}
    </g>
  );

  return (
    <button
      ref={ref}
      className="witness"
      onClick={poke}
      aria-label="crossexam mascot. Click to make it blink."
      style={{ width: size, height: size, transform: `perspective(600px) rotateX(${tilt.x}deg) rotateY(${tilt.y}deg)` }}
    >
      <span key={boop} className={`ghost-in${boop ? ' boop' : ''}`}>
        <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
          <defs>
            <linearGradient id={`gb${id}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#6fd0ff" />
              <stop offset="1" stopColor="#0a84ff" />
            </linearGradient>
            <radialGradient id={`gg${id}`} cx="0.5" cy="0.45" r="0.55">
              <stop offset="0" stopColor="#fff" stopOpacity="0.4" />
              <stop offset="1" stopColor="#fff" stopOpacity="0" />
            </radialGradient>
            <linearGradient id={`gh${id}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#effaff" />
              <stop offset="1" stopColor="#bfe6ff" />
            </linearGradient>
          </defs>
          <path d="M32 2c17.6 0 30 5.4 30 30S49.6 62 32 62 2 56.6 2 32 14.4 2 32 2Z" fill={`url(#gb${id})`} />
          <path d="M32 2c17.6 0 30 5.4 30 30S49.6 62 32 62 2 56.6 2 32 14.4 2 32 2Z" fill={`url(#gg${id})`} />
          <g className="ghost-halo">
            <ellipse cx="32" cy="15.2" rx="10.5" ry="3" fill="none" stroke="#ffc53d" strokeWidth="2.4" transform="rotate(-6 32 15.2)" />
          </g>
          <g transform={`translate(${look.x * 0.5} ${look.y * 0.35})`}>
            <path
              d="M19.5 33.5c0-8.1 5.6-13.4 12.7-13.4 7.2 0 12.6 5.3 12.6 13.2l-.4 14.3c-.1 2.4-2 3.9-4 3.2-1.6-.6-2.7-2-4.3-2-1.7 0-2.6 1.9-4.2 1.9-1.8 0-2.6-1.8-4.3-1.8-1.5 0-2.4 1.5-3.9 1.9-2.2.5-3.6-1.1-3.7-3.4Z"
              fill={`url(#gh${id})`}
            />
            {eye(29.6, 33)}
            {eye(37.6, 32.6)}
          </g>
          {[
            [12, 14],
            [52, 12],
            [9, 46],
            [55, 44],
            [47, 54],
          ].map(([x, y], i) => (
            <circle key={i} className="ghost-star" cx={x} cy={y} r="0.7" fill="#fff" style={{ animationDelay: `${i * 0.7}s` }} />
          ))}
        </svg>
      </span>
    </button>
  );
}
