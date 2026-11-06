import { useEffect, useRef } from 'react';
import type { Theme } from '../theme';

const VERT = `#version 300 es
in vec2 aPos;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;

uniform vec2 uRes;
uniform vec2 uMouse;
uniform float uTime;
uniform vec3 uBg;
uniform vec3 uInk;
uniform float uDark;

out vec4 outColor;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
  float value = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 5; i++) {
    value += amp * noise(p);
    p = p * 2.02 + vec2(17.3, 9.2);
    amp *= 0.5;
  }
  return value;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float aspect = uRes.x / max(uRes.y, 1.0);
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
  vec2 m = (uMouse - 0.5) * vec2(aspect, 1.0);

  float t = uTime * 0.045;
  vec2 q = p * 1.15 + vec2(t * 0.8, -t * 0.55);
  float w = fbm(q + fbm(q * 1.9 + t * 0.7) * 0.9);

  vec2 dir = p - m;
  float pull = exp(-dot(dir, dir) * 2.4);
  vec2 warp = vec2(cos(w * 6.0), sin(w * 5.0)) * 0.38 + dir * pull * 0.55;

  float f = fbm(p * 2.0 + warp + vec2(-t * 0.45, t * 0.3));
  float band = smoothstep(0.40, 0.78, f);
  float glow = smoothstep(0.56, 1.0, f) * (1.0 - smoothstep(0.72, 1.15, length(p)));

  float ink = uDark > 0.5 ? 0.62 : 0.30;
  vec3 col = mix(uBg, uInk, band * ink);
  col = mix(col, uInk, glow * (uDark > 0.5 ? 0.16 : 0.08));

  float vfade = smoothstep(0.0, 0.16, uv.y) * (1.0 - smoothstep(0.80, 1.0, uv.y));
  col = mix(uBg, col, vfade);

  float grain = (hash(gl_FragCoord.xy + uTime * 0.7) - 0.5) * 0.022;
  col += grain;

  outColor = vec4(col, 1.0);
}`;

function rgb(hex: string): [number, number, number] {
  const value = parseInt(hex.slice(1), 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

const PALETTE: Record<Theme, { bg: string; ink: string }> = {
  light: { bg: '#f5f4f2', ink: '#1f5fe0' },
  dark: { bg: '#08090b', ink: '#4c9bff' },
};

export default function FieldCanvas({ theme }: { theme: Theme }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      depth: false,
      powerPreference: 'low-power',
    });
    if (!gl) return;

    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        gl.deleteShader(shader);
        return null;
      }
      return shader;
    };

    const vertex = compile(gl.VERTEX_SHADER, VERT);
    const fragment = compile(gl.FRAGMENT_SHADER, FRAG);
    if (!vertex || !fragment) return;

    const program = gl.createProgram();
    if (!program) return;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const position = gl.getAttribLocation(program, 'aPos');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    const uRes = gl.getUniformLocation(program, 'uRes');
    const uMouse = gl.getUniformLocation(program, 'uMouse');
    const uTime = gl.getUniformLocation(program, 'uTime');
    const uBg = gl.getUniformLocation(program, 'uBg');
    const uInk = gl.getUniformLocation(program, 'uInk');
    const uDark = gl.getUniformLocation(program, 'uDark');

    const colors = PALETTE[theme];
    gl.uniform3fv(uBg, rgb(colors.bg));
    gl.uniform3fv(uInk, rgb(colors.ink));
    gl.uniform1f(uDark, theme === 'dark' ? 1 : 0);

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const target = { x: 0.5, y: 0.5 };
    const mouse = { x: 0.5, y: 0.5 };
    let raf = 0;
    let width = 0;
    let height = 0;
    let start = performance.now();

    const resize = () => {
      const parent = canvas.parentElement;
      if (!parent) return;
      const rect = parent.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      width = Math.max(1, Math.round(rect.width * dpr));
      height = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width === width && canvas.height === height) return;
      canvas.width = width;
      canvas.height = height;
      gl.viewport(0, 0, width, height);
      gl.uniform2f(uRes, width, height);
    };

    const draw = (now: number) => {
      mouse.x += (target.x - mouse.x) * 0.045;
      mouse.y += (target.y - mouse.y) * 0.045;
      gl.uniform2f(uMouse, mouse.x, mouse.y);
      gl.uniform1f(uTime, (now - start) / 1000);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };

    const loop = (now: number) => {
      draw(now);
      raf = requestAnimationFrame(loop);
    };

    const onPointer = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      target.x = (event.clientX - rect.left) / Math.max(rect.width, 1);
      target.y = 1 - (event.clientY - rect.top) / Math.max(rect.height, 1);
    };

    const observer = new ResizeObserver(() => {
      resize();
      if (reduce) draw(start);
    });
    if (canvas.parentElement) observer.observe(canvas.parentElement);

    resize();
    if (reduce) {
      draw(start);
    } else {
      start = performance.now();
      raf = requestAnimationFrame(loop);
      window.addEventListener('pointermove', onPointer, { passive: true });
    }

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      window.removeEventListener('pointermove', onPointer);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
    };
  }, [theme]);

  return <canvas ref={canvasRef} className="hero__canvas" aria-hidden="true" />;
}
