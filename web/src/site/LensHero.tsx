import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Spring, project, reducedMotion, rubberband } from './glass';

type Verdict = 'contradicted' | 'verified' | 'review';
type Part = string | { c: number; t: string };

// What an agent said, split into the claims crossexam would pick out.
const SUMMARY: Part[] = [
  'done! i renamed ',
  { c: 0, t: '`getUserById` to `fetchUser` everywhere' },
  ', bumped ',
  { c: 1, t: '`zod` to 3.23.8' },
  ', ',
  { c: 2, t: 'applied the migration' },
  ', ',
  { c: 3, t: 'fixed the empty-cart crash' },
  ' and ',
  { c: 4, t: 'all 214 tests pass' },
  '.',
];

const CLAIMS: { label: string; verdict: Verdict; cmd: string; out: string }[] = [
  { label: 'rename', verdict: 'contradicted', cmd: 'git grep -nw getUserById', out: 'jobs/digest.ts:118 · admin/UserPanel.tsx:42' },
  { label: 'dependency', verdict: 'contradicted', cmd: 'read package.json', out: '"zod": "^3.22.4"' },
  { label: 'migration', verdict: 'review', cmd: 'no status command ran', out: 'nothing backs it either way' },
  { label: 'bug fix', verdict: 'verified', cmd: 'vitest run cart.test.ts', out: 'passed after the last edit' },
  { label: 'tests', verdict: 'contradicted', cmd: 'pnpm test', out: '1 failed, 213 passed' },
];

const MARK: Record<Verdict, string> = { contradicted: '✗ contradicted', verified: '✓ verified', review: '◇ needs review' };

function Text({ truth }: { truth?: boolean }) {
  return (
    <>
      {SUMMARY.map((p, i) =>
        typeof p === 'string' ? (
          <span key={i} className="lt-plain">
            {p}
          </span>
        ) : (
          <span key={i} className={`lt-claim ${truth ? CLAIMS[p.c].verdict : ''}`} data-claim={truth ? undefined : p.c}>
            {p.t.split(/(`[^`]+`)/).map((s, j) => (s.startsWith('`') ? <code key={j}>{s.slice(1, -1)}</code> : s))}
          </span>
        ),
      )}
    </>
  );
}

/**
 * The hero: an agent's "done" summary and a glass lens. Wherever the lens
 * rests, you see what actually happened. Drag it, flick it, or tap a claim.
 */
export function LensHero() {
  const stage = useRef<HTMLDivElement>(null);
  const base = useRef<HTMLDivElement>(null);
  const lens = useRef<HTMLDivElement>(null);
  const truth = useRef<HTMLDivElement>(null);
  const [cur, setCur] = useState<number | null>(null);
  const [touched, setTouched] = useState(false);
  const st = useRef({
    x: new Spring(0, { damping: 0.82, response: 0.42 }),
    y: new Spring(0, { damping: 0.82, response: 0.42 }),
    lift: new Spring(0, { damping: 0.7, response: 0.3 }),
    R: 74,
    scale: 1.14,
    w: 0,
    h: 0,
    raf: 0,
    last: 0,
    drag: null as null | { id: number; ox: number; oy: number; hist: { x: number; y: number; t: number }[] },
    claims: [] as { c: number; rects: DOMRect[]; cx: number; cy: number }[],
    cur: null as number | null,
    touched: false,
  });

  // measure the claims and keep the magnified copy the same width
  useLayoutEffect(() => {
    const b = base.current;
    const s = st.current;
    if (!b) return;
    const measure = () => {
      const box = b.getBoundingClientRect();
      s.w = box.width;
      s.h = box.height;
      s.R = box.width < 520 ? 58 : 74;
      if (truth.current) truth.current.style.width = `${box.width}px`;
      const by: Record<number, DOMRect[]> = {};
      for (const el of b.querySelectorAll<HTMLElement>('[data-claim]')) {
        const c = Number(el.dataset.claim);
        by[c] = [...el.getClientRects()].map((r) => new DOMRect(r.left - box.left, r.top - box.top, r.width, r.height));
      }
      s.claims = Object.entries(by).map(([c, rects]) => {
        const r = rects.reduce((a, b2) => (b2.width > a.width ? b2 : a));
        return { c: Number(c), rects, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
      });
      if (!s.x.value && !s.y.value && s.claims[0]) {
        s.x.jump(s.claims[0].cx);
        s.y.jump(s.claims[0].cy);
      }
      kick();
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(b);
    document.fonts?.ready.then(measure);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const which = (x: number, y: number) => {
    const s = st.current;
    let best: number | null = null;
    let bd = s.R * 0.75;
    for (const cl of s.claims) {
      for (const r of cl.rects) {
        const dx = Math.max(r.left - x, 0, x - r.right);
        const dy = Math.max(r.top - y, 0, y - r.bottom);
        const d = Math.hypot(dx, dy);
        if (d < bd) {
          bd = d;
          best = cl.c;
        }
      }
    }
    return best;
  };

  const render = () => {
    const s = st.current;
    const l = lens.current;
    const t = truth.current;
    if (!l || !t) return;
    const lift = s.lift.value;
    // stretch along the direction of travel, like a drop
    const v = Math.hypot(s.x.velocity, s.y.velocity);
    const k = Math.min(0.12, v / 12000);
    const ang = Math.atan2(s.y.velocity, s.x.velocity);
    l.style.transform = `translate(${s.x.value - s.R}px, ${s.y.value - s.R}px) rotate(${ang}rad) scale(${1 + k + lift * 0.06}, ${1 - k * 0.7 + lift * 0.06}) rotate(${-ang}rad)`;
    l.style.width = l.style.height = `${s.R * 2}px`;
    l.style.setProperty('--lift', String(lift));
    const sc = s.scale + lift * 0.04;
    t.style.transform = `translate(${s.R - s.x.value * sc}px, ${s.R - s.y.value * sc}px) scale(${sc})`;
    const c = which(s.x.value, s.y.value);
    if (c !== s.cur) {
      s.cur = c;
      setCur(c);
    }
  };

  const kick = () => {
    const s = st.current;
    cancelAnimationFrame(s.raf);
    s.last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - s.last) / 1000);
      s.last = now;
      let moving = false;
      if (!s.drag) {
        moving = s.x.step(dt) || moving;
        moving = s.y.step(dt) || moving;
      } else {
        s.x.velocity = s.y.velocity = 0;
      }
      moving = s.lift.step(dt) || moving;
      render();
      if (moving || s.drag) s.raf = requestAnimationFrame(tick);
    };
    s.raf = requestAnimationFrame(tick);
  };

  const goTo = (c: number, velocity?: { x: number; y: number }) => {
    const s = st.current;
    const cl = s.claims.find((k) => k.c === c);
    if (!cl) return;
    if (reducedMotion()) {
      s.x.jump(cl.cx);
      s.y.jump(cl.cy);
    } else {
      s.x.set(cl.cx, { velocity: velocity?.x });
      s.y.set(cl.cy, { velocity: velocity?.y });
    }
    kick();
  };

  // a slow tour until someone takes the lens
  useEffect(() => {
    if (reducedMotion()) return;
    let i = 0;
    let visible = true;
    const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting));
    if (stage.current) io.observe(stage.current);
    const id = setInterval(() => {
      if (st.current.touched || !visible || document.hidden) return;
      i = (i + 1) % CLAIMS.length;
      goTo(i);
    }, 2600);
    return () => {
      clearInterval(id);
      io.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const touch = () => {
    if (!st.current.touched) {
      st.current.touched = true;
      setTouched(true);
    }
  };

  const local = (e: React.PointerEvent) => {
    const r = base.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const s = st.current;
    touch();
    const p = local(e);
    const onLens = Math.hypot(p.x - s.x.value, p.y - s.y.value) <= s.R;
    // grabbed the lens: keep the offset. Pressed elsewhere: the lens comes to you.
    const ox = onLens ? p.x - s.x.value : 0;
    const oy = onLens ? p.y - s.y.value : 0;
    if (!onLens) {
      s.x.set(p.x);
      s.y.set(p.y);
    }
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    // on the lens it tracks 1:1; elsewhere it follows on a spring from where it is now
    s.drag = onLens ? { id: e.pointerId, ox, oy, hist: [{ ...p, t: performance.now() }] } : null;
    pendingFollow.current = onLens ? null : e.pointerId;
    s.lift.set(1);
    kick();
  };

  const pendingFollow = useRef<number | null>(null);

  const onMove = (e: React.PointerEvent) => {
    const s = st.current;
    if (pendingFollow.current === e.pointerId) {
      const p = local(e);
      s.x.set(p.x);
      s.y.set(p.y);
      kick();
      return;
    }
    if (!s.drag || s.drag.id !== e.pointerId) return;
    const p = local(e);
    let x = p.x - s.drag.ox;
    let y = p.y - s.drag.oy;
    // soft edges: resist past the text instead of stopping dead
    if (x < 0) x = -rubberband(-x, s.w);
    if (x > s.w) x = s.w + rubberband(x - s.w, s.w);
    if (y < 0) y = -rubberband(-y, s.h);
    if (y > s.h) y = s.h + rubberband(y - s.h, s.h);
    s.x.jump(x);
    s.y.jump(y);
    const now = performance.now();
    s.drag.hist.push({ x, y, t: now });
    while (s.drag.hist.length > 2 && now - s.drag.hist[0].t > 90) s.drag.hist.shift();
    render();
  };

  const onUp = (e: React.PointerEvent) => {
    const s = st.current;
    s.lift.set(0);
    if (pendingFollow.current === e.pointerId) {
      pendingFollow.current = null;
      const c = which(s.x.target, s.y.target);
      if (c !== null) goTo(c);
      kick();
      return;
    }
    if (!s.drag || s.drag.id !== e.pointerId) return;
    const h = s.drag.hist;
    const a = h[0];
    const b = h[h.length - 1];
    const dt = Math.max(16, b.t - a.t) / 1000;
    const vx = (b.x - a.x) / dt;
    const vy = (b.y - a.y) / dt;
    s.drag = null;
    // throw it: land where the flick was heading, then let a nearby claim catch it
    const px = Math.min(s.w, Math.max(0, s.x.value + project(vx)));
    const py = Math.min(s.h, Math.max(0, s.y.value + project(vy)));
    let best: number | null = null;
    let bd = 90;
    for (const cl of s.claims) {
      const d = Math.hypot(cl.cx - px, cl.cy - py);
      if (d < bd) {
        bd = d;
        best = cl.c;
      }
    }
    const cl = best !== null ? s.claims.find((k) => k.c === best)! : null;
    s.x.set(cl ? cl.cx : px, { velocity: vx });
    s.y.set(cl ? cl.cy : py, { velocity: vy });
    kick();
  };

  const onKey = (e: React.KeyboardEvent) => {
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    touch();
    goTo(((cur ?? -1) + dir + CLAIMS.length) % CLAIMS.length);
  };

  const claim = cur !== null ? CLAIMS[cur] : null;
  const counts = CLAIMS.reduce((a, c) => ({ ...a, [c.verdict]: (a[c.verdict] ?? 0) + 1 }), {} as Record<Verdict, number>);

  return (
    <div className="lens-card glass" ref={stage}>
      <div className="lens-head">
        <span className="lens-agent">
          <i aria-hidden="true">◆</i> agent
        </span>
        <span className="lens-hint">{touched ? 'flick it, or use the arrow keys' : 'drag the lens over what it said'}</span>
      </div>

      <div
        className="lens-area"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onKeyDown={onKey}
        tabIndex={0}
        role="group"
        aria-label="the agent's summary. use the arrow keys to check each claim."
      >
        <div className="lens-text" ref={base}>
          <Text />
        </div>
        <div className="lens" ref={lens} aria-hidden="true">
          <div className="lens-view">
            <div className="lens-text truth" ref={truth}>
              <Text truth />
            </div>
          </div>
          <span className="lens-rim" />
        </div>
      </div>

      <div className="lens-foot">
        <div className={`lens-verdict glass ${claim ? claim.verdict : 'idle'}`} aria-live="polite">
          {claim ? (
            <>
              <b>{MARK[claim.verdict]}</b>
              <span className="lv-cmd">
                <span className="p">$</span> {claim.cmd}
              </span>
              <span className="lv-out">{claim.out}</span>
            </>
          ) : (
            <span className="lv-idle">rest the lens on a claim</span>
          )}
        </div>
        <div className="lens-chips" role="tablist" aria-label="claims">
          {CLAIMS.map((c, i) => (
            <button
              key={c.label}
              role="tab"
              aria-selected={cur === i}
              className={`lens-chip ${c.verdict}${cur === i ? ' on' : ''}`}
              onClick={() => {
                touch();
                goTo(i);
              }}
            >
              <i />
              {c.label}
            </button>
          ))}
          <span className="lens-tally">
            {counts.verified ?? 0} of {CLAIMS.length} held up
          </span>
        </div>
      </div>
    </div>
  );
}
