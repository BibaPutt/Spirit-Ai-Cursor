import { useEffect, useState } from 'react';

// Trail config. Each cursor position broadcast (every ~33ms during AI mode)
// pushes a point onto the buffer; we draw the buffer as a single smooth
// spline so there are no per-segment artefacts. 500ms total lifetime keeps
// the trail short enough that fast motion doesn't smear the screen while
// still reading as a "comet tail" not a single blob.
const TRAIL_LIFETIME_MS = 500;
const TRAIL_MAX_POINTS = 18;

type TrailPoint = { x: number; y: number; ts: number };

// Build a Catmull-Rom-to-Bezier SVG path through the given points so the
// trail renders as one continuous smooth curve. Two consecutive points get a
// straight `L`; three or more get cubic Beziers whose control points come
// from neighbouring sample positions. Tension 0.5 matches the classic
// "centripetal-ish" feel — natural but not overly springy.
function catmullRomPath(points: TrailPoint[]): string {
  if (points.length < 2) return '';
  if (points.length === 2) {
    return `M${points[0].x},${points[0].y} L${points[1].x},${points[1].y}`;
  }
  const tension = 0.5;
  let d = `M${points[0].x},${points[0].y}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;
    const c1x = p1.x + ((p2.x - p0.x) * tension) / 3;
    const c1y = p1.y + ((p2.y - p0.y) * tension) / 3;
    const c2x = p2.x - ((p3.x - p1.x) * tension) / 3;
    const c2y = p2.y - ((p3.y - p1.y) * tension) / 3;
    d += ` C${c1x},${c1y} ${c2x},${c2y} ${p2.x},${p2.y}`;
  }
  return d;
}

type Props = {
  x: number;
  y: number;
};

// A single fading comet trail behind the cursor. The trail leaves a
// softly-blurred accent thread on every gesture, which makes fast motion
// legible and gives the AI's presence a sense of continuity instead of a
// binary on/off dot.
export function CursorHalo({ x, y }: Props) {
  const [trail, setTrail] = useState<TrailPoint[]>([]);

  // Append the latest cursor position to the trail buffer. We drop points
  // older than TRAIL_LIFETIME_MS here so the buffer stays small. We also
  // cap by point count as a safety net against very chatty cursor streams.
  useEffect(() => {
    const now = Date.now();
    setTrail((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.x === x && last.y === y) return prev;
      const next = [...prev, { x, y, ts: now }]
        .filter((p) => now - p.ts < TRAIL_LIFETIME_MS)
        .slice(-TRAIL_MAX_POINTS);
      return next;
    });
  }, [x, y]);

  // Decay tick: when the cursor stops moving, the effect above stops firing,
  // and stale points never get filtered out. A lightweight 60ms interval
  // sweeps the buffer so the trail dissolves naturally when idle. We only
  // setState when something actually expired (preserving the same array
  // reference otherwise) so this doesn't spam re-renders on a still cursor.
  useEffect(() => {
    const id = window.setInterval(() => {
      setTrail((prev) => {
        if (prev.length === 0) return prev;
        const now = Date.now();
        const next = prev.filter((p) => now - p.ts < TRAIL_LIFETIME_MS);
        return next.length === prev.length ? prev : next;
      });
    }, 60);
    return () => window.clearInterval(id);
  }, []);

  // Comet trail. Earlier versions rendered the trail as a chain of
  // per-segment <line> elements with round line-caps so we could taper
  // width and fade per segment — but every round line-cap drew a small
  // circle at each segment join, leaving a beaded "string of pearls"
  // look along curves. We now build one smooth Catmull-Rom spline
  // through all buffered points and stroke it once. A linearGradient
  // along the chord (oldest → newest) handles the head-bright /
  // tail-faded effect, and a soft SVG blur sells the comet glow. No
  // per-segment joins, no beads.
  //
  // Two overlaid <path>s give the trail body + glow without the
  // variable-width hack: the wider path with high blur paints the soft
  // aura, the narrower crisp path stays at the centre.
  return (
      <svg
        className="pointer-events-none fixed left-0 top-0 h-full w-full"
        style={{ overflow: 'visible' }}
      >
        <defs>
          {/* Wide outer halo. stdDeviation 7 plus a 250% filter region so
              the soft glow doesn't get clipped at the path bounding box. */}
          <filter
            id="spirit-trail-outer"
            x="-75%"
            y="-75%"
            width="250%"
            height="250%"
          >
            <feGaussianBlur stdDeviation="7" />
          </filter>
          {/* Mid blur — bridges between the wide aura and the crisp core so
              the transition reads as "thickening light" rather than a hard
              edge inside a halo. */}
          <filter
            id="spirit-trail-mid"
            x="-40%"
            y="-40%"
            width="180%"
            height="180%"
          >
            <feGaussianBlur stdDeviation="2.2" />
          </filter>
          {trail.length >= 2 && (
            <linearGradient
              id="spirit-trail-gradient"
              gradientUnits="userSpaceOnUse"
              x1={trail[0].x}
              y1={trail[0].y}
              x2={trail[trail.length - 1].x}
              y2={trail[trail.length - 1].y}
            >
              {/* Gradient stops drive their color from the runtime accent
                  CSS var so the user can pick a different brand color
                  (lime / blue / magenta) without a rebuild. A subtle
                  pale→accent ramp (mirroring the cursor's border gradient)
                  fades the tail out, brightening into the accent at the
                  head. */}
              <stop offset="0%" style={{ stopColor: 'var(--spirit-accent)', stopOpacity: 0 }} />
              <stop offset="45%" style={{ stopColor: 'color-mix(in srgb, var(--spirit-accent) 40%, #fff)', stopOpacity: 0.22 }} />
              <stop offset="100%" style={{ stopColor: 'var(--spirit-accent)', stopOpacity: 0.6 }} />
            </linearGradient>
          )}
        </defs>
        {trail.length >= 2 && (() => {
          const d = catmullRomPath(trail);
          return (
            <g>
              {/* Outer aura — widest, blurriest, lowest opacity. */}
              <path
                d={d}
                stroke="url(#spirit-trail-gradient)"
                strokeWidth={26}
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
                opacity={0.32}
                filter="url(#spirit-trail-outer)"
              />
              {/* Mid body — slight blur, softens the core's edge into the
                  aura so the trail reads as one cohesive glow. */}
              <path
                d={d}
                stroke="url(#spirit-trail-gradient)"
                strokeWidth={11}
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
                opacity={0.42}
                filter="url(#spirit-trail-mid)"
              />
              {/* Crisp core — no blur, narrowest, brightest. This is the
                  "comet itself" against the halo. */}
              <path
                d={d}
                stroke="url(#spirit-trail-gradient)"
                strokeWidth={4}
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
                opacity={0.72}
              />
            </g>
          );
        })()}
      </svg>
  );
}
