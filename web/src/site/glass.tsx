import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { LogoMark, Wordmark } from '../components/Logo';

/* ------------------------------------------------------------------ springs */

/**
 * A spring in Apple's terms: damping ratio (1 = no overshoot) and response
 * (seconds to reach the target, roughly). It always animates from the value
 * on screen, keeps its velocity when retargeted, and never locks out input.
 */
export class Spring {
  value: number;
  velocity = 0;
  target: number;
  private k: number;
  private c: number;
  constructor(value: number, { damping = 1, response = 0.4 } = {}) {
    this.value = this.target = value;
    this.k = (2 * Math.PI / response) ** 2;
    this.c = (4 * Math.PI * damping) / response;
  }
  set(target: number, { damping, response, velocity }: { damping?: number; response?: number; velocity?: number } = {}) {
    this.target = target;
    if (response !== undefined || damping !== undefined) {
      const r = response ?? 2 * Math.PI / Math.sqrt(this.k);
      const d = damping ?? (this.c * r) / (4 * Math.PI);
      this.k = (2 * Math.PI / r) ** 2;
      this.c = (4 * Math.PI * d) / r;
    }
    if (velocity !== undefined) this.velocity = velocity;
  }
  jump(v: number) {
    this.value = this.target = v;
    this.velocity = 0;
  }
  /** Advance by dt seconds; returns true while still moving. */
  step(dt: number) {
    const steps = Math.ceil(dt / (1 / 240));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const a = -this.k * (this.value - this.target) - this.c * this.velocity;
      this.velocity += a * h;
      this.value += this.velocity * h;
    }
    const moving = Math.abs(this.velocity) > 0.01 || Math.abs(this.value - this.target) > 0.01;
    if (!moving) this.jump(this.target);
    return moving;
  }
}

/** Apple's momentum projection: where a flick would come to rest. */
export function project(velocity: number, rate = 0.99) {
  return ((velocity / 1000) * rate) / (1 - rate);
}

/** Resistance past an edge that grows the further you pull. */
export function rubberband(over: number, dim: number, c = 0.55) {
  return (over * dim * c) / (dim + c * Math.abs(over));
}

export const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/* -------------------------------------------------------------- refraction */

// Real refraction of what's behind a surface needs an SVG filter in
// backdrop-filter, which only Chromium renders. Everyone else gets the frosted
// material from CSS, which is also what reduced transparency asks for.
const canRefract = () => {
  if (typeof navigator === 'undefined' || reducedMotion()) return false;
  if (window.matchMedia?.('(prefers-reduced-transparency: reduce)').matches) return false;
  const brands = (navigator as Navigator & { userAgentData?: { brands: { brand: string }[] } }).userAgentData?.brands;
  return !!brands?.some((b) => /Chromium/.test(b.brand));
};

/** A displacement map for a rounded rectangle: the bezel bends light inward, the middle stays flat. */
function displacementMap(w: number, h: number, radius: number, bezel: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) return '';
  const img = ctx.createImageData(w, h);
  const r = Math.min(radius, w / 2, h / 2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // signed distance to the rounded-rect edge (positive inside)
      const px = x + 0.5 - w / 2;
      const py = y + 0.5 - h / 2;
      const qx = Math.abs(px) - (w / 2 - r);
      const qy = Math.abs(py) - (h / 2 - r);
      const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
      const d = r - (outside + Math.min(Math.max(qx, qy), 0));
      let dx = 0;
      let dy = 0;
      if (d < bezel && d >= 0) {
        // normal points outward; sample from further inside near the rim
        let nx = qx > 0 ? Math.sign(px) * Math.max(qx, 0) : 0;
        let ny = qy > 0 ? Math.sign(py) * Math.max(qy, 0) : 0;
        if (!nx && !ny) {
          if (qx > qy) nx = Math.sign(px);
          else ny = Math.sign(py);
        }
        const len = Math.hypot(nx, ny) || 1;
        const t = 1 - d / bezel;
        const m = t * t * (3 - 2 * t); // smooth, strongest at the very edge
        dx = (nx / len) * m;
        dy = (ny / len) * m;
      }
      const i = (y * w + x) * 4;
      img.data[i] = 128 + dx * 127;
      img.data[i + 1] = 128 + dy * 127;
      img.data[i + 2] = 128;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL();
}

/**
 * Bend the backdrop of an element like a thick glass lens (Chromium), sized
 * to the element and rebuilt when it resizes.
 */
export function useRefraction(ref: RefObject<HTMLElement>, { radius = 999, bezel = 18, strength = 34, blur = 1.2 } = {}) {
  const id = `lg${useId().replace(/:/g, '')}`;
  const [svg, setSvg] = useState<{ w: number; h: number; map: string } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !canRefract()) return;
    let last = '';
    const build = () => {
      const w = Math.round(el.offsetWidth);
      const h = Math.round(el.offsetHeight);
      const key = `${w}x${h}`;
      if (!w || !h || key === last) return;
      last = key;
      setSvg({ w, h, map: displacementMap(w, h, radius, bezel) });
    };
    build();
    const ro = new ResizeObserver(build);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, radius, bezel]);
  useEffect(() => {
    const el = ref.current;
    if (!el || !svg) return;
    el.classList.add('refract');
    el.style.setProperty('--refract', `url(#${id})`);
    return () => {
      el.classList.remove('refract');
      el.style.removeProperty('--refract');
    };
  }, [ref, svg, id]);
  if (!svg) return null;
  return (
    <svg className="lg-defs" width="0" height="0" aria-hidden="true" focusable="false">
      <filter id={id} x="0" y="0" width={svg.w} height={svg.h} filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
        <feImage href={svg.map} x="0" y="0" width={svg.w} height={svg.h} result="map" preserveAspectRatio="none" />
        <feGaussianBlur in="SourceGraphic" stdDeviation={blur} result="soft" />
        <feDisplacementMap in="soft" in2="map" scale={strength} xChannelSelector="R" yChannelSelector="G" result="bent" />
        <feColorMatrix in="bent" type="saturate" values="1.7" />
      </filter>
    </svg>
  );
}

/* --------------------------------------------------------- pointer light */

/** Specular light that follows the pointer across `.glass` surfaces. */
export function useGlassLight(root: RefObject<HTMLElement>) {
  useEffect(() => {
    const el = root.current;
    if (!el || window.matchMedia?.('(hover: none)').matches) return;
    let raf = 0;
    const onMove = (e: PointerEvent) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        for (const g of el.querySelectorAll<HTMLElement>('.glass, .spot')) {
          const r = g.getBoundingClientRect();
          if (r.bottom < -100 || r.top > window.innerHeight + 100) continue;
          g.style.setProperty('--mx', `${e.clientX - r.left}px`);
          g.style.setProperty('--my', `${e.clientY - r.top}px`);
        }
      });
    };
    el.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      el.removeEventListener('pointermove', onMove);
      cancelAnimationFrame(raf);
    };
  }, [root]);
}

/* -------------------------------------------------------------------- nav */

export const NAV = [
  { id: 'try', label: 'Try it' },
  { id: 'strength', label: 'Test strength' },
  { id: 'agents', label: 'Any agent' },
  { id: 'checks', label: 'Checks' },
  { id: 'teams', label: 'For teams' },
  { id: 'open-source', label: 'Open source' },
];

/**
 * A floating glass capsule. A lens slides under whichever section you're
 * reading, on a spring, so it follows scroll without ever jumping.
 */
export function LiquidNav({ repo }: { repo: string }) {
  const bar = useRef<HTMLElement>(null);
  const links = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLSpanElement>(null);
  const [active, setActive] = useState<string | null>(null);
  const [compact, setCompact] = useState(false);
  const defs = useRefraction(bar, { radius: 999, bezel: 16, strength: 30, blur: 3 });

  // which section is under the reading line
  useEffect(() => {
    const on = () => {
      setCompact(window.scrollY > 40);
      const line = window.innerHeight * 0.35;
      let cur: string | null = null;
      for (const n of NAV) {
        const s = document.getElementById(n.id);
        if (s && s.getBoundingClientRect().top <= line) cur = n.id;
      }
      const first = document.getElementById(NAV[0].id);
      if (first && first.getBoundingClientRect().top > line) cur = null;
      setActive(cur);
    };
    on();
    window.addEventListener('scroll', on, { passive: true });
    window.addEventListener('resize', on);
    return () => {
      window.removeEventListener('scroll', on);
      window.removeEventListener('resize', on);
    };
  }, []);

  // the sliding lens: x and width on independent springs
  const springs = useRef({ x: new Spring(0, { damping: 0.86, response: 0.38 }), w: new Spring(0, { damping: 0.86, response: 0.38 }), o: new Spring(0, { damping: 1, response: 0.25 }) });
  useEffect(() => {
    const host = links.current;
    const p = pill.current;
    if (!host || !p) return;
    const a = active ? host.querySelector<HTMLElement>(`[data-id="${active}"]`) : null;
    const s = springs.current;
    if (a) {
      const fresh = s.o.value < 0.05;
      if (fresh) {
        s.x.jump(a.offsetLeft);
        s.w.jump(a.offsetWidth);
      } else {
        s.x.set(a.offsetLeft);
        s.w.set(a.offsetWidth);
      }
      s.o.set(1);
    } else s.o.set(0);
    if (reducedMotion()) {
      s.x.jump(s.x.target);
      s.w.jump(s.w.target);
      s.o.jump(s.o.target);
    }
    let raf = 0;
    let t = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - t) / 1000);
      t = now;
      const m = [s.x.step(dt), s.w.step(dt), s.o.step(dt)].some(Boolean);
      // stretch slightly along the direction of travel, like a drop of liquid
      const stretch = Math.min(0.18, Math.abs(s.x.velocity) / 9000);
      p.style.transform = `translateX(${s.x.value}px) scale(${1 + stretch}, ${1 - stretch * 0.6})`;
      p.style.width = `${s.w.value}px`;
      p.style.opacity = String(Math.max(0, Math.min(1, s.o.value)));
      if (m) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active]);

  return (
    <div className={`lnav-wrap${compact ? ' compact' : ''}`}>
      {defs}
      <nav ref={bar} className="lnav glass" aria-label="sections">
        <a href="#top" className="brand lnav-brand" aria-label="crossexam, back to top">
          <LogoMark size={26} />
          <Wordmark />
        </a>
        <div className="lnav-links" ref={links}>
          <span className="lnav-pill" ref={pill} aria-hidden="true" />
          {NAV.map((n) => (
            <a key={n.id} data-id={n.id} href={`#${n.id}`} className={active === n.id ? 'on' : ''} aria-current={active === n.id ? 'location' : undefined}>
              {n.label}
            </a>
          ))}
        </div>
        <div className="lnav-cta">
          <a className="pill-btn glass-btn hide-sm" href={repo} target="_blank" rel="noreferrer">
            <GitHubMark /> Star
          </a>
          <a className="pill-btn blue" href="#try">
            Try it
          </a>
        </div>
      </nav>
    </div>
  );
}

export function GitHubMark() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.38-5.26 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z" />
    </svg>
  );
}
