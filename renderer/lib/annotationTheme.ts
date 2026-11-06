// Annotation label-chip theme.
//
// The overlay is an INVERTED Tailwind build: `html.dark` present = LIGHT UI,
// absent = the dark-glass UI. ScreenAnnotations and PointCursor both paint
// their label chips near-black with the raw accent as text — which breaks on a
// light theme when the user chose a dark accent (black chip + black text). To
// survive ANY custom accent in EITHER theme, the text color is the accent
// tinted away from the surface: whitened on the dark chip, blackened on the
// frost chip — via color-mix, so dark-on-dark / light-on-light is impossible.

import type { CSSProperties } from 'react';

export type AnnotationChipTheme = Pick<CSSProperties, 'background' | 'color' | 'border'>;

export function annotationChipTheme(): AnnotationChipTheme {
  const darkUi =
    typeof document === 'undefined' || !document.documentElement.classList.contains('dark');
  return darkUi
    ? {
        background: 'rgba(20,22,18,0.82)',
        color: 'color-mix(in srgb, var(--spirit-accent) 45%, #fff)',
        border: '1px solid color-mix(in srgb, var(--spirit-accent) 40%, #fff)',
      }
    : {
        background: 'rgba(240,239,234,0.94)',
        color: 'color-mix(in srgb, var(--spirit-accent) 55%, #000)',
        border: '1px solid color-mix(in srgb, var(--spirit-accent) 50%, #000)',
      };
}