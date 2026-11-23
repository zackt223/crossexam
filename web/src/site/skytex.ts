// One procedural sky in the brand's blues: deep → signal → haze, with soft
// white cloud. Panels, banners and mosaic tiles all cut from the same picture.
const hash = (x: number, y: number) => {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
};
const fade = (t: number) => t * t * (3 - 2 * t);
const noise = (x: number, y: number) => {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = fade(x - xi);
  const yf = fade(y - yi);
  const a = hash(xi, yi) + (hash(xi + 1, yi) - hash(xi, yi)) * xf;
  const b = hash(xi, yi + 1) + (hash(xi + 1, yi + 1) - hash(xi, yi + 1)) * xf;
  return a + (b - a) * yf;
};
const fbm = (x: number, y: number) => {
  let v = 0;
  let a = 0.5;
  let f = 1;
  for (let i = 0; i < 5; i++) {
    v += a * noise(x * f, y * f);
    f *= 2;
    a *= 0.5;
  }
  return v / 0.96875;
};

let cached: string | null = null;

export function skyTexture() {
  if (cached) return cached;
  if (typeof document === 'undefined') return '';
  const W = 480;
  const H = 360;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  if (!ctx) return '';
  const img = ctx.createImageData(W, H);
  const stops = [
    [0, 92, 210],
    [0, 150, 236],
    [96, 196, 255],
    [214, 238, 255],
  ];
  const ramp = (t: number) => {
    const k = Math.max(0, Math.min(stops.length - 1.001, t * (stops.length - 1)));
    const i = Math.floor(k);
    const f = k - i;
    return stops[i].map((v, j) => v + (stops[i + 1][j] - v) * f);
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = x / W;
      const v = y / H;
      // light comes from the lower right, like the reference's sky
      const base = 0.15 + 0.55 * Math.hypot(u * 0.7, v) * 0.85 + 0.1 * fbm(u * 3, v * 3);
      const col = ramp(Math.min(1, base));
      // cloud: brighter toward the bottom and the edges
      const cl = fbm(u * 4.2 + 1.3, v * 3.1) + v * 0.45 + Math.max(0, u - 0.7) * 0.6 - 0.62;
      const k = Math.max(0, Math.min(1, cl * 2.4));
      const i = (y * W + x) * 4;
      img.data[i] = col[0] + (250 - col[0]) * k;
      img.data[i + 1] = col[1] + (252 - col[1]) * k;
      img.data[i + 2] = col[2] + (255 - col[2]) * k;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  cached = c.toDataURL('image/jpeg', 0.9);
  return cached;
}
