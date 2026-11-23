import { useEffect, useRef, useState } from 'react';
import { reducedMotion } from './glass';
import { skyTexture } from './skytex';

/*
 * The mark as a mosaic: five pieces of one sky make the x, with the centre
 * left open where the claim gets inspected. Loose fragments drift around it
 * and settle into place when it scrolls into view.
 */
type Tile = { x: number; y: number; w: number; h: number; kind: 'mark' | 'ring' | 'frag' | 'ghost'; from: [number, number, number] };

const U = 96; // one mark cell
const TILES: Tile[] = [
  // the x: four corners and the ringed centre, on a 3×3 grid
  { x: 0, y: 0, w: 1, h: 1, kind: 'mark', from: [-140, -90, -12] },
  { x: 2, y: 0, w: 1, h: 1, kind: 'mark', from: [150, -110, 10] },
  { x: 0, y: 2, w: 1, h: 1, kind: 'mark', from: [-160, 120, 9] },
  { x: 2, y: 2, w: 1, h: 1, kind: 'mark', from: [140, 140, -10] },
  { x: 1, y: 1, w: 1, h: 1, kind: 'ring', from: [0, -180, 0] },
  // fragments: the evidence, still loose
  { x: -0.55, y: 1, w: 0.55, h: 0.55, kind: 'ghost', from: [-220, 30, -20] },
  { x: 3, y: 1.1, w: 0.55, h: 0.55, kind: 'ghost', from: [220, -20, 16] },
  { x: 1, y: -0.55, w: 0.5, h: 0.5, kind: 'frag', from: [40, -200, 14] },
  { x: 1.25, y: 3.05, w: 0.5, h: 0.5, kind: 'frag', from: [-30, 210, -18] },
  { x: 3.05, y: 2.45, w: 0.45, h: 0.45, kind: 'ghost', from: [180, 160, 12] },
];

export function Mosaic({ scale = 1 }: { scale?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [on, setOn] = useState(false);
  const tex = skyTexture();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (reducedMotion() || !('IntersectionObserver' in window)) {
      setOn(true);
      return;
    }
    const io = new IntersectionObserver(([e]) => e.isIntersecting && (setOn(true), io.disconnect()), { threshold: 0.3 });
    io.observe(el);
    const t = setTimeout(() => el.getBoundingClientRect().top < innerHeight && setOn(true), 1400);
    return () => {
      io.disconnect();
      clearTimeout(t);
    };
  }, []);
  const s = U * scale;
  return (
    <div ref={ref} className={`mosaic${on ? ' on' : ''}`} style={{ width: s * 3, height: s * 3 }} aria-hidden="true">
      {TILES.map((t, i) => {
        const style: React.CSSProperties = {
          left: t.x * s,
          top: t.y * s,
          width: t.w * s,
          height: t.h * s,
          backgroundImage: t.kind === 'ghost' ? undefined : `url(${tex})`,
          backgroundSize: `${s * 3.6}px ${s * 3.6}px`,
          backgroundPosition: `${-t.x * s - s * 0.3}px ${-t.y * s - s * 0.3}px`,
          transitionDelay: `${i * 70}ms`,
          ['--fx' as string]: `${t.from[0]}px`,
          ['--fy' as string]: `${t.from[1]}px`,
          ['--fr' as string]: `${t.from[2]}deg`,
        };
        return (
          <span key={i} className={`m-tile ${t.kind}`} style={style}>
            {t.kind === 'ring' && <i className="m-hole" />}
            {(i === 1 || i === 3 || t.kind === 'frag') && <i className="m-spark" />}
          </span>
        );
      })}
    </div>
  );
}
