import { useEffect, type RefObject } from 'react';

/** Fade sections up as they scroll in. Everything is visible without JS or with reduced motion. */
export function useReveal(root: RefObject<HTMLElement>) {
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const items = [...el.querySelectorAll<HTMLElement>('.reveal')];
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) {
      items.forEach((i) => i.classList.add('in'));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add('in');
            io.unobserve(e.target);
          }
        }
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
    );
    items.forEach((i) => io.observe(i));
    // Safety net: if the observer never reports (a background tab, a screenshot
    // bot), don't leave what's already on screen invisible.
    const t = setTimeout(() => {
      for (const i of items) if (i.getBoundingClientRect().top < window.innerHeight) i.classList.add('in');
    }, 1500);
    return () => {
      io.disconnect();
      clearTimeout(t);
    };
  }, [root]);
}

/** A soft light that follows the pointer across every `.spot` card. */
export function useSpotlight(root: RefObject<HTMLElement>) {
  useEffect(() => {
    const el = root.current;
    if (!el || window.matchMedia?.('(hover: none)').matches) return;
    let raf = 0;
    const onMove = (e: PointerEvent) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        for (const card of el.querySelectorAll<HTMLElement>('.spot')) {
          const r = card.getBoundingClientRect();
          if (r.bottom < -200 || r.top > window.innerHeight + 200) continue;
          card.style.setProperty('--mx', `${e.clientX - r.left}px`);
          card.style.setProperty('--my', `${e.clientY - r.top}px`);
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

/** Calls back once when the element first scrolls into view. */
export function onFirstView(el: Element | null, cb: () => void) {
  if (!el) return () => {};
  if (!('IntersectionObserver' in window)) {
    cb();
    return () => {};
  }
  const io = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        cb();
        io.disconnect();
      }
    },
    { threshold: 0.35 },
  );
  io.observe(el);
  const t = setTimeout(() => {
    if (el.getBoundingClientRect().top < window.innerHeight) {
      cb();
      io.disconnect();
    }
  }, 1500);
  return () => {
    io.disconnect();
    clearTimeout(t);
  };
}
