import { useEffect, useRef } from 'react';
import type { Theme } from '../theme';

interface HalftoneWordmarkProps {
  theme: Theme;
  wordmark?: string;
  crop?: number;
  tone?: 'ink' | 'accent';
}

function hex(value: string): [number, number, number] | null {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return null;
  const raw =
    match[1].length === 3
      ? match[1]
          .split('')
          .map((char) => char + char)
          .join('')
      : match[1];
  return [
    parseInt(raw.slice(0, 2), 16),
    parseInt(raw.slice(2, 4), 16),
    parseInt(raw.slice(4, 6), 16),
  ];
}

function dotRadius(coverage: number, gap: number): number {
  const c = Math.max(0, Math.min(1, coverage));
  return Math.sqrt(c) * gap * 0.56;
}

function springStep(
  x: number,
  y: number,
  vx: number,
  vy: number,
  hx: number,
  hy: number,
  px: number,
  py: number,
  reach: number,
): [number, number, number, number] {
  const dx = x - px;
  const dy = y - py;
  const distanceSq = dx * dx + dy * dy;
  if (reach > 0 && distanceSq < reach * reach) {
    const distance = Math.sqrt(distanceSq) + 0.001;
    const force = (1 - distance / reach) * 2.6;
    vx += (dx / distance) * force;
    vy += (dy / distance) * force;
  }
  vx = (vx + (hx - x) * 0.05) * 0.84;
  vy = (vy + (hy - y) * 0.05) * 0.84;
  return [x + vx, y + vy, vx, vy];
}

function warmth(x: number, y: number, hx: number, hy: number, span: number): number {
  const distance = Math.hypot(x - hx, y - hy);
  return span > 0 ? Math.min(1, distance / span) : 0;
}

export default function HalftoneWordmark({
  theme,
  wordmark = 'Spirit',
  crop = 0,
  tone = 'ink',
}: HalftoneWordmarkProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    if (!root || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const styles = getComputedStyle(document.documentElement);
    const inkColor =
      (tone === 'accent' ? styles.getPropertyValue('--accent') : styles.getPropertyValue('--ink')).trim() ||
      (theme === 'light' ? '#151513' : '#eef0f4');
    const warmColor =
      (tone === 'accent'
        ? styles.getPropertyValue('--accent-ink')
        : styles.getPropertyValue('--accent')
      ).trim() || (theme === 'light' ? '#1f5fe0' : '#4c9bff');
    const ink = hex(inkColor) ?? (theme === 'light' ? [21, 21, 19] : [238, 240, 244]);
    const warm = hex(warmColor) ?? (theme === 'light' ? [31, 95, 224] : [76, 155, 255]);
    const inkCss = `rgb(${ink[0]}, ${ink[1]}, ${ink[2]})`;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const fontFamily = '"Syne Variable", Syne, sans-serif';
    const fontWeight = 700;
    const dotGap = 6;
    const reach = 84;

    let width = 0;
    let height = 0;
    let dpr = 1;
    let pointerX = -1e5;
    let pointerY = -1e5;
    let frame = 0;
    let visible = true;
    let awake = true;
    let alive = true;
    let ring = { x: 0, y: 0, at: -1 };
    let dots = new Float32Array(0);
    let count = 0;

    const layout = () => {
      const rect = root.getBoundingClientRect();
      width = Math.max(1, Math.round(rect.width));
      height = Math.max(1, Math.round(rect.height));
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);

      const mask = document.createElement('canvas');
      mask.width = width;
      mask.height = height;
      const context = mask.getContext('2d', { willReadFrequently: true });
      if (!context) return;
      context.font = `${fontWeight} 100px ${fontFamily}`;
      const word = wordmark || ' ';
      const measured = context.measureText(word).width;
      const fit = measured > 0 ? ((width * 0.98) / measured) * 100 : 0;
      context.font = `${fontWeight} ${fit}px ${fontFamily}`;
      const box = context.measureText(word);
      const cap = box.actualBoundingBoxAscent || fit * 0.72;
      const descent = Math.max(0, box.actualBoundingBoxDescent || fit * 0.21);
      context.fillStyle = '#000';
      context.textBaseline = 'alphabetic';
      context.fillText(word, (width - box.width) / 2, height - descent + cap * (0.04 + crop));
      const image = context.getImageData(0, 0, width, height).data;

      const cols = Math.ceil(width / dotGap);
      const rows = Math.ceil(height / dotGap);
      const values: number[] = [];
      for (let gy = 0; gy < rows; gy++) {
        for (let gx = 0; gx < cols; gx++) {
          let sum = 0;
          for (let sy = 0; sy < 3; sy++) {
            for (let sx = 0; sx < 3; sx++) {
              const x = Math.min(width - 1, Math.floor(gx * dotGap + ((sx + 0.5) * dotGap) / 3));
              const y = Math.min(height - 1, Math.floor(gy * dotGap + ((sy + 0.5) * dotGap) / 3));
              sum += image[(y * width + x) * 4 + 3];
            }
          }
          const coverage = sum / (9 * 255);
          if (coverage < 0.06) continue;
          const hx = gx * dotGap + dotGap / 2;
          const hy = gy * dotGap + dotGap / 2;
          values.push(hx, hy, 0, 0, hx, hy, dotRadius(coverage, dotGap));
        }
      }
      dots = new Float32Array(values);
      count = values.length / 7;
      awake = true;
    };

    const draw = (now: number) => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      const pointerReach = reduced ? 0 : reach;
      const age = ring.at < 0 ? 1e9 : now - ring.at;
      const ringRadius = age * 0.9;
      let moving = false;

      for (let i = 0; i < count; i++) {
        const j = i * 7;
        let x = dots[j];
        let y = dots[j + 1];
        let vx = dots[j + 2];
        let vy = dots[j + 3];
        const hx = dots[j + 4];
        const hy = dots[j + 5];

        if (!reduced) {
          if (age < 900) {
            const dx = hx - ring.x;
            const dy = hy - ring.y;
            const distance = Math.sqrt(dx * dx + dy * dy) + 0.001;
            const band = 1 - Math.min(1, Math.abs(distance - ringRadius) / 26);
            if (band > 0) {
              const force = band * 3.2 * (1 - age / 900);
              vx += (dx / distance) * force;
              vy += (dy / distance) * force;
            }
          }
          const next = springStep(x, y, vx, vy, hx, hy, pointerX, pointerY, pointerReach);
          x = next[0];
          y = next[1];
          vx = next[2];
          vy = next[3];
          if (Math.abs(vx) + Math.abs(vy) > 0.02 || Math.abs(x - hx) + Math.abs(y - hy) > 0.05) {
            moving = true;
          } else {
            x = hx;
            y = hy;
            vx = 0;
            vy = 0;
          }
          dots[j] = x;
          dots[j + 1] = y;
          dots[j + 2] = vx;
          dots[j + 3] = vy;
        }

        const k = warmth(x, y, hx, hy, 28);
        if (k > 0.02) {
          ctx.fillStyle = `rgb(${Math.round(ink[0] + (warm[0] - ink[0]) * k)},${Math.round(
            ink[1] + (warm[1] - ink[1]) * k,
          )},${Math.round(ink[2] + (warm[2] - ink[2]) * k)})`;
        } else {
          ctx.fillStyle = inkCss;
        }
        ctx.beginPath();
        ctx.arc(x, y, dots[j + 6], 0, Math.PI * 2);
        ctx.fill();
      }

      awake = moving || age < 900;
    };

    const loop = (now: number) => {
      frame = 0;
      if (!visible) return;
      draw(now);
      if (awake) frame = requestAnimationFrame(loop);
    };

    const wake = () => {
      awake = true;
      if (!frame && visible) frame = requestAnimationFrame(loop);
    };

    const localPoint = (event: PointerEvent): [number, number] => {
      const box = canvas.getBoundingClientRect();
      return [event.clientX - box.left, event.clientY - box.top];
    };

    const onMove = (event: PointerEvent) => {
      const point = localPoint(event);
      pointerX = point[0];
      pointerY = point[1];
      wake();
    };

    const onLeave = () => {
      pointerX = -1e5;
      pointerY = -1e5;
      wake();
    };

    const onDown = (event: PointerEvent) => {
      if (reduced) return;
      const point = localPoint(event);
      ring = { x: point[0], y: point[1], at: performance.now() };
      wake();
    };

    layout();
    draw(performance.now());
    wake();

    root.addEventListener('pointermove', onMove);
    root.addEventListener('pointerleave', onLeave);
    root.addEventListener('pointerdown', onDown);
    const resize = new ResizeObserver(() => {
      layout();
      wake();
    });
    resize.observe(root);
    const observer = new IntersectionObserver(
      (entries) => {
        visible = entries[0] ? entries[0].isIntersecting : true;
        if (visible) wake();
      },
      { rootMargin: '120px' },
    );
    observer.observe(root);

    if (document.fonts?.ready) {
      document.fonts.ready
        .then(() => {
          if (!alive) return;
          layout();
          wake();
        })
        .catch(() => undefined);
    }

    return () => {
      alive = false;
      cancelAnimationFrame(frame);
      resize.disconnect();
      observer.disconnect();
      root.removeEventListener('pointermove', onMove);
      root.removeEventListener('pointerleave', onLeave);
      root.removeEventListener('pointerdown', onDown);
    };
  }, [theme, wordmark, crop, tone]);

  return (
    <div className="footer-halftone" ref={rootRef} aria-hidden="true">
      <canvas ref={canvasRef} />
    </div>
  );
}
