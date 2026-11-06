import { defaultSchema } from 'rehype-sanitize';

// rehype-sanitize is the safety net for any HTML the LLM emits. Single
// schema for the baseline experience. The schema is evaluated by the
// same rehype plugin as a plain object.

// Allow common HTML primitives Gemini may emit for richer answers, but
// SANITISE everything: drop scripts, event handlers, foreign attrs.
export const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    'div',
    'section',
    'article',
    'aside',
    'figure',
    'figcaption',
    'span',
    'kbd',
    'mark',
    'small',
    'sup',
    'sub',
    'details',
    'summary',
    'svg',
    'path',
    'circle',
    'rect',
    'line',
    'polygon',
    'polyline',
    'g',
    'text',
  ],
  attributes: {
    ...defaultSchema.attributes,
    '*': [
      ...((defaultSchema.attributes && defaultSchema.attributes['*']) ?? []),
      'className',
      'class',
      // 'style' is intentionally NOT in this allowlist. Inline styles open up
      // background-image: url(...) data-exfil patterns even when CSP blocks
      // arbitrary connect-src, because img-src needs to allow data: for
      // legitimate inline images. Markdown doesn't need inline styles in this
      // app; layout is driven by component classNames above.
      'id',
      'role',
      'aria-label',
      'aria-hidden',
      'data-variant',
      'data-icon',
    ],
    svg: ['xmlns', 'viewBox', 'width', 'height', 'fill', 'stroke', 'strokeWidth'],
    path: ['d', 'fill', 'stroke', 'strokeWidth', 'strokeLinecap', 'strokeLinejoin'],
    rect: ['x', 'y', 'width', 'height', 'rx', 'ry', 'fill', 'stroke'],
    circle: ['cx', 'cy', 'r', 'fill', 'stroke'],
    line: ['x1', 'y1', 'x2', 'y2', 'stroke', 'strokeWidth'],
    a: ['href', 'title', 'target', 'rel'],
  },
};
