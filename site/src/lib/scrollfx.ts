import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { SplitText } from 'gsap/SplitText';
import Lenis from 'lenis';

gsap.registerPlugin(ScrollTrigger, SplitText);

ScrollTrigger.config({ ignoreMobileResize: true });

type SlideFrom = 'up' | 'down' | 'left' | 'right';

const SLIDE_OFFSET: Record<SlideFrom, gsap.TweenVars> = {
  up: { y: 30 },
  down: { y: -30 },
  left: { x: -54 },
  right: { x: 54 },
};

export function initScrollFX(): () => void {
  if (typeof window === 'undefined') return () => undefined;

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  const splits: SplitText[] = [];
  const teardown: Array<() => void> = [];

  let lenis: Lenis | null = null;
  if (!reduce.matches) {
    lenis = new Lenis({
      duration: 1.05,
      smoothWheel: true,
      wheelMultiplier: 1,
      touchMultiplier: 1.4,
    });
    lenis.on('scroll', ScrollTrigger.update);
    const tick = (time: number) => lenis?.raf(time * 1000);
    gsap.ticker.add(tick);
    gsap.ticker.lagSmoothing(0);
    teardown.push(() => {
      gsap.ticker.remove(tick);
      gsap.ticker.lagSmoothing(500, 33);
      lenis?.destroy();
    });
  }

  const media = gsap.matchMedia();

  const ctx = gsap.context(() => {
    media.add('(prefers-reduced-motion: no-preference)', () => {
      gsap.from('.nav__inner', {
        y: -18,
        autoAlpha: 0,
        duration: 0.9,
        delay: 0.1,
        ease: 'power3.out',
      });

      /* ── masked word reveals ─────────────────────────────── */
      gsap.utils.toArray<HTMLElement>('[data-fx="split"]').forEach((el) => {
        const split = SplitText.create(el, {
          type: 'words',
          mask: 'words',
          autoSplit: true,
          onSplit(self) {
            return gsap.from(self.words, {
              yPercent: 120,
              rotate: 1.5,
              opacity: 0,
              duration: 0.95,
              ease: 'power3.out',
              stagger: 0.045,
              scrollTrigger: {
                trigger: el,
                start: 'top 88%',
                once: true,
              },
            });
          },
        });
        splits.push(split);
      });

      /* ── plain fades ─────────────────────────────────────── */
      gsap.utils.toArray<HTMLElement>('[data-fx="fade"]').forEach((el) => {
        gsap.from(el, {
          y: 22,
          autoAlpha: 0,
          duration: 0.85,
          delay: Number(el.dataset.delay ?? 0),
          ease: 'power3.out',
          scrollTrigger: { trigger: el, start: 'top 88%', once: true },
        });
      });

      /* ── staggered groups ────────────────────────────────── */
      gsap.utils.toArray<HTMLElement>('[data-fx="stagger"]').forEach((group) => {
        const items = group.querySelectorAll<HTMLElement>(':scope > *');
        if (!items.length) return;
        gsap.from(items, {
          y: 30,
          autoAlpha: 0,
          duration: 0.85,
          ease: 'power3.out',
          stagger: 0.085,
          scrollTrigger: { trigger: group, start: 'top 86%', once: true },
        });
      });

      /* ── clip-path wipes ─────────────────────────────────── */
      gsap.utils.toArray<HTMLElement>('[data-fx="clip"]').forEach((el) => {
        gsap.fromTo(
          el,
          { clipPath: 'inset(0 0 100% 0)', y: 22 },
          {
            clipPath: 'inset(0 0 0% 0)',
            y: 0,
            duration: 1.1,
            ease: 'power3.inOut',
            scrollTrigger: { trigger: el, start: 'top 84%', once: true },
          },
        );
      });

      /* ── scene panels open from the bottom ───────────────── */
      gsap.utils.toArray<HTMLElement>('[data-fx="scene"]').forEach((el) => {
        gsap.fromTo(
          el,
          { clipPath: 'inset(0 0 100% 0)' },
          {
            clipPath: 'inset(0 0 0% 0)',
            duration: 1.15,
            ease: 'power3.inOut',
            scrollTrigger: { trigger: el, start: 'top 84%', once: true },
          },
        );
      });

      /* ── slide-in overlays ───────────────────────────────── */
      gsap.utils.toArray<HTMLElement>('[data-fx="slide"]').forEach((el) => {
        const from = (el.dataset.from as SlideFrom) || 'up';
        const trigger = el.closest<HTMLElement>('[data-fx="scene"]') ?? el;
        gsap.from(el, {
          ...SLIDE_OFFSET[from],
          autoAlpha: 0,
          duration: 0.95,
          delay: Number(el.dataset.delay ?? 0),
          ease: 'power3.out',
          scrollTrigger: { trigger, start: 'top 80%', once: true },
        });
      });

      /* ── scroll-linked parallax ──────────────────────────── */
      gsap.utils.toArray<HTMLElement>('[data-fx="parallax"]').forEach((el) => {
        const speed = Number(el.dataset.speed ?? 6);
        gsap.fromTo(
          el,
          { yPercent: -speed / 2 },
          {
            yPercent: speed / 2,
            ease: 'none',
            scrollTrigger: {
              trigger: el.parentElement ?? el,
              start: 'top bottom',
              end: 'bottom top',
              scrub: 0.6,
            },
          },
        );
      });

      /* ── marquee ticker, direction follows the scroll ────── */
      gsap.utils.toArray<HTMLElement>('[data-fx="marquee"]').forEach((marquee) => {
        const track = marquee.firstElementChild as HTMLElement | null;
        if (!track) return;
        const tween = gsap.to(track, {
          xPercent: -50,
          duration: 34,
          ease: 'none',
          repeat: -1,
        });
        let target = 1;

        const setSpeed = (next: number) => {
          const clamped = gsap.utils.clamp(-2.4, 2.4, next);
          if (Math.abs(clamped - target) < 0.05) return;
          target = clamped;
          gsap.to(tween, { timeScale: clamped, duration: 0.45, overwrite: true });
        };

        ScrollTrigger.create({
          trigger: marquee,
          start: 'top bottom',
          end: 'bottom top',
          onUpdate: (self) => {
            const velocity = self.getVelocity();
            const boost = gsap.utils.clamp(0.6, 2, 1 + Math.abs(velocity) / 2600);
            setSpeed(velocity < 0 ? -boost : boost);
          },
        });

        const pause = () => gsap.to(tween, { timeScale: 0, duration: 0.4, overwrite: true });
        const resume = () => gsap.to(tween, { timeScale: target || 1, duration: 0.4, overwrite: true });
        marquee.addEventListener('pointerenter', pause);
        marquee.addEventListener('pointerleave', resume);
        teardown.push(() => {
          marquee.removeEventListener('pointerenter', pause);
          marquee.removeEventListener('pointerleave', resume);
        });
      });

      /* ── hero: settle, then drift under the field ────────── */
      gsap
        .timeline({
          scrollTrigger: {
            trigger: '.hero',
            start: 'top top',
            end: 'bottom top',
            scrub: 0.6,
          },
        })
        .to('.hero__title', { y: -46, ease: 'none' }, 0)
        .to('.hero__foot', { y: -20, autoAlpha: 0.35, ease: 'none' }, 0)
        .to('.hero__field', { yPercent: 8, ease: 'none' }, 0);

      /* ── scene choreography ──────────────────────────────── */
      gsap.from('.scene__window', {
        scale: 0.985,
        duration: 1.2,
        ease: 'power3.out',
        scrollTrigger: { trigger: '.scene', start: 'top 82%', once: true },
      });

      /* ── footer wordmark climbs into view ────────────────── */
    });

    /* ── sticky stack + prompt wall (desktop, motion allowed) ─ */
    media.add('(min-width: 981px) and (prefers-reduced-motion: no-preference)', () => {
      gsap.utils.toArray<HTMLElement>('[data-prompt-col]').forEach((col, index) => {
        const down = col.dataset.dir === 'down';
        const tween = gsap.fromTo(
          col,
          { yPercent: down ? -50 : 0 },
          {
            yPercent: down ? 0 : -50,
            duration: 46 + index * 7,
            ease: 'none',
            repeat: -1,
          },
        );
        const pause = () => gsap.to(tween, { timeScale: 0, duration: 0.5, overwrite: true });
        const resume = () => gsap.to(tween, { timeScale: 1, duration: 0.5, overwrite: true });
        col.addEventListener('pointerenter', pause);
        col.addEventListener('pointerleave', resume);
        teardown.push(() => {
          col.removeEventListener('pointerenter', pause);
          col.removeEventListener('pointerleave', resume);
        });
      });
    });
  });

  const refresh = () => ScrollTrigger.refresh();
  const fontsReady = document.fonts?.ready;
  fontsReady?.then(refresh).catch(() => undefined);
  window.addEventListener('load', refresh);

  return () => {
    window.removeEventListener('load', refresh);
    media.revert();
    ctx.revert();
    splits.forEach((split) => split.revert());
    splits.length = 0;
    teardown.forEach((fn) => fn());
    ScrollTrigger.getAll().forEach((trigger) => trigger.kill());
  };
}
