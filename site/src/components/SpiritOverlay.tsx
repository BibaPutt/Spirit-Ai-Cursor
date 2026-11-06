import { useCallback, useEffect, useRef, useState } from 'react';
import CursorLayer from './CursorLayer';
import SpiritBox from './spirit/SpiritBox';
import { PREVIEW_QUESTIONS, resolvePreviewDemo } from '../data/demo';
import { useI18n } from '../i18n';
import {
  SPIRIT_PREVIEW_CLOSE_EVENT,
  SPIRIT_PREVIEW_EVENT,
  SPIRIT_PREVIEW_TOGGLE_EVENT,
  useSpiritSequence,
  type SpiritDemo,
} from '../lib/spirit';

const GAP = 28;
const PILL_H_APPROX = 80;
const PAD = 12;
const HALO = 8;
const FLOATING_H = 32;
const K = 70;
const C = 38;
const M = 1;
const INITIAL: SpiritDemo = PREVIEW_QUESTIONS[0]!;

// Shake-to-summon, mirroring the desktop app's mouse-wiggle detector
// (`electron/input/trigger.ts`), but tuned well past the app's "low"
// preset so only a deliberate shake opens it.
const WIGGLE_WINDOW_MS = 850;
const WIGGLE_AMPLITUDE_PX = 130;
const WIGGLE_REVERSALS = 6;
const WIGGLE_TTL_MS = 1500;
const WIGGLE_MAX_SAMPLES = 240;

function isShake(samples: Array<{ x: number; t: number }>): boolean {
  if (samples.length < 4) return false;
  const extremes: Array<{ x: number; t: number }> = [{ x: samples[0]!.x, t: samples[0]!.t }];
  let dir: 1 | -1 | 0 = 0;
  let lastX = samples[0]!.x;
  for (let i = 1; i < samples.length; i++) {
    const dx = samples[i]!.x - lastX;
    if (Math.abs(dx) < WIGGLE_AMPLITUDE_PX) continue;
    const nd: 1 | -1 = dx > 0 ? 1 : -1;
    if (dir !== nd) extremes.push({ x: samples[i]!.x, t: samples[i]!.t });
    dir = nd;
    lastX = samples[i]!.x;
  }
  const reversals = Math.max(0, extremes.length - 2);
  if (reversals < WIGGLE_REVERSALS) return false;
  const start = extremes[extremes.length - 1 - WIGGLE_REVERSALS]!;
  const end = extremes[extremes.length - 1]!;
  return end.t - start.t <= WIGGLE_WINDOW_MS;
}

function computeTarget(x: number, y: number, w: number) {
  const sw = window.innerWidth;
  const sh = window.innerHeight;
  const overflowRight = x + GAP + w > sw - PAD;
  const tx = overflowRight ? Math.max(PAD, x - GAP - w) : Math.min(sw - w - PAD, x + GAP);
  const ty = Math.max(PAD, Math.min(sh - PILL_H_APPROX - PAD, y - PILL_H_APPROX / 2 - FLOATING_H));
  return { x: tx, y: ty };
}

export default function SpiritOverlay() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [closing, setClosing] = useState(false);
  const [questionsOpen, setQuestionsOpen] = useState(false);
  const [demo, setDemo] = useState<SpiritDemo>(INITIAL);
  const [initial] = useState(() =>
    computeTarget(window.innerWidth / 2, window.innerHeight / 2, 380),
  );
  const boxRef = useRef<HTMLDivElement>(null);
  const mouseRef = useRef({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  const targetRef = useRef(initial);
  const springRef = useRef({ x: initial.x, y: initial.y, vx: 0, vy: 0 });
  const refreshRef = useRef<() => void>(() => {});
  const runRef = useRef<(d: SpiritDemo) => void>(() => {});
  const resetRef = useRef<() => void>(() => {});

  const seq = useSpiritSequence(demo, { start: false });
  runRef.current = seq.run;
  resetRef.current = seq.reset;

  useEffect(() => {
    const onOpen = () => setOpen(true);
    const onClose = () => setOpen(false);
    const onToggle = () => setOpen((value) => !value);
    window.addEventListener(SPIRIT_PREVIEW_EVENT, onOpen);
    window.addEventListener(SPIRIT_PREVIEW_CLOSE_EVENT, onClose);
    window.addEventListener(SPIRIT_PREVIEW_TOGGLE_EVENT, onToggle);
    return () => {
      window.removeEventListener(SPIRIT_PREVIEW_EVENT, onOpen);
      window.removeEventListener(SPIRIT_PREVIEW_CLOSE_EVENT, onClose);
      window.removeEventListener(SPIRIT_PREVIEW_TOGGLE_EVENT, onToggle);
    };
  }, []);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      mouseRef.current = { x: event.clientX, y: event.clientY };
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, []);

  // Shake the mouse side to side while the overlay is closed to summon it,
  // like the desktop app.
  useEffect(() => {
    if (open) return;
    const samples: Array<{ x: number; t: number }> = [];
    const onMove = (event: PointerEvent) => {
      const now = performance.now();
      samples.push({ x: event.clientX, t: now });
      while (samples.length && now - samples[0]!.t > WIGGLE_TTL_MS) samples.shift();
      if (samples.length > WIGGLE_MAX_SAMPLES) {
        samples.splice(0, samples.length - WIGGLE_MAX_SAMPLES);
      }
      if (isShake(samples)) {
        samples.length = 0;
        setOpen(true);
      }
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDoubleClick = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (boxRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest('[data-spirit-preview-trigger]')) return;
      setOpen(false);
    };
    window.addEventListener('dblclick', onDoubleClick);
    return () => window.removeEventListener('dblclick', onDoubleClick);
  }, [open]);

  const onRail = useCallback((label: string) => {
    setDemo((current) => ({ ...resolvePreviewDemo(label, current) }));
    setQuestionsOpen(false);
  }, []);

  const onQuestion = useCallback((index: number) => {
    const next = PREVIEW_QUESTIONS[index];
    if (!next) return;
    setDemo(next);
    setQuestionsOpen(false);
  }, []);

  useEffect(() => {
    if (open) {
      const w = boxRef.current?.offsetWidth || 380;
      const target = computeTarget(mouseRef.current.x, mouseRef.current.y, w);
      targetRef.current = target;
      springRef.current = { x: target.x, y: target.y, vx: 0, vy: 0 };
      if (boxRef.current) {
        boxRef.current.style.transform = `translate3d(${target.x}px, ${target.y}px, 0)`;
      }
      setMounted(true);
      setClosing(false);
      return;
    }
    if (!mounted) return;
    setClosing(true);
    const timer = window.setTimeout(() => {
      setMounted(false);
      setClosing(false);
      resetRef.current();
    }, 220);
    return () => window.clearTimeout(timer);
  }, [open, mounted]);

  useEffect(() => {
    if (!open) setQuestionsOpen(false);
  }, [open]);

  useEffect(() => {
    if (!mounted) return;
    document.documentElement.classList.add('spirit-preview-open');
    return () => document.documentElement.classList.remove('spirit-preview-open');
  }, [mounted]);

  useEffect(() => {
    if (!mounted || closing) return;
    runRef.current(demo);
  }, [mounted, demo, closing]);

  useEffect(() => {
    if (!open) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (questionsOpen) {
          setQuestionsOpen(false);
          return;
        }
        setOpen(false);
        return;
      }
      if (e.key === 'r' || e.key === 'R') {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        const el = e.target as HTMLElement | null;
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable))
          return;
        e.preventDefault();
        setQuestionsOpen((v) => !v);
        return;
      }
      if (questionsOpen && e.key >= '1' && e.key <= String(PREVIEW_QUESTIONS.length)) {
        const idx = Number(e.key) - 1;
        const next = PREVIEW_QUESTIONS[idx];
        if (next) {
          e.preventDefault();
          setDemo(next);
          setQuestionsOpen(false);
        }
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, questionsOpen]);

  useEffect(() => {
    if (!mounted) return;

    let raf = 0;
    let last = performance.now();

    const refresh = () => {
      const r = boxRef.current?.getBoundingClientRect();
      const { x, y } = mouseRef.current;
      if (
        r &&
        x >= r.left - HALO &&
        x <= r.right + HALO &&
        y >= r.top - HALO &&
        y <= r.bottom + HALO
      ) {
        return;
      }
      const w = boxRef.current?.offsetWidth || 380;
      targetRef.current = computeTarget(x, y, w);
    };
    refreshRef.current = refresh;

    const onMove = (e: PointerEvent) => {
      mouseRef.current = { x: e.clientX, y: e.clientY };
      refresh();
    };

    const tick = (now: number) => {
      const dt = Math.min(0.032, Math.max(0.001, (now - last) / 1000));
      last = now;
      const s = springRef.current;
      const t = targetRef.current;
      const ax = (-K * (s.x - t.x) - C * s.vx) / M;
      const ay = (-K * (s.y - t.y) - C * s.vy) / M;
      s.vx += ax * dt;
      s.vy += ay * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      if (boxRef.current) {
        boxRef.current.style.transform = `translate3d(${s.x}px, ${s.y}px, 0)`;
      }
      raf = requestAnimationFrame(tick);
    };

    window.addEventListener('pointermove', onMove, { passive: true });
    raf = requestAnimationFrame(tick);

    let ro: ResizeObserver | null = null;
    if (boxRef.current && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => refresh());
      ro.observe(boxRef.current);
    }

    return () => {
      window.removeEventListener('pointermove', onMove);
      cancelAnimationFrame(raf);
      ro?.disconnect();
    };
  }, [mounted]);

  useEffect(() => {
    if (mounted) refreshRef.current();
  }, [mounted, seq.phase]);

  if (!mounted) return null;

  return (
    <div className={`spreview${closing ? ' is-closing' : ''}`} data-ui>
      <div
        className="spreview__box"
        ref={boxRef}
        style={{ transform: `translate3d(${initial.x}px, ${initial.y}px, 0)` }}
      >
        <SpiritBox
          seq={seq}
          demo={demo}
          phase={seq.phase}
          ctxChips={demo.file ? [demo.file] : undefined}
          className="sbox--preview"
          onRail={onRail}
          questions={PREVIEW_QUESTIONS}
          questionsOpen={questionsOpen}
          activeQuestionId={demo.id}
          onQuestion={onQuestion}
          onQuestionsClose={() => setQuestionsOpen(false)}
        />
      </div>

      {!questionsOpen && (
        <div className="spreview__hint" role="status">
          <span>
            <b>Esc</b> {t('spirit.dismiss')}
          </span>
          <span>
            <b>R</b> {t('spirit.questionsKey')}
          </span>
        </div>
      )}

      <CursorLayer initial={mouseRef.current} />
    </div>
  );
}
