// Text cleaning for text-to-speech: strip markdown AND convert LaTeX math into
// natural spoken phrasing. Both TTS paths (provider Edge TTS + the Web Speech
// fallback) run this before synthesizing, so `$E = mc^2$` reads as
// "E equals m c squared" instead of "dollar E equals m c caret 2 dollar".
// Pure module — no React, no ipc — so it unit-tests directly.

const LATEX_SPOKEN: Record<string, string> = {
  int: 'integral',
  oint: 'integral',
  iint: 'integral',
  iiint: 'integral',
  sum: 'sum',
  prod: 'product',
  coprod: 'coproduct',
  infty: 'infinity',
  pm: 'plus or minus',
  mp: 'minus or plus',
  times: 'times',
  cdot: 'times',
  div: 'divided by',
  approx: 'approximately',
  approxeq: 'approximately equal to',
  sim: 'approximately',
  neq: 'not equal to',
  equiv: 'equivalent to',
  le: 'less than or equal to',
  leq: 'less than or equal to',
  ge: 'greater than or equal to',
  geq: 'greater than or equal to',
  lt: 'less than',
  gt: 'greater than',
  to: 'to',
  rightarrow: 'right arrow',
  leftarrow: 'left arrow',
  Rightarrow: 'implies',
  Leftarrow: 'is implied by',
  implies: 'implies',
  in: 'in',
  notin: 'not in',
  subset: 'subset of',
  supset: 'superset of',
  subseteq: 'subset of',
  supseteq: 'superset of',
  cap: 'intersection',
  cup: 'union',
  alpha: 'alpha',
  beta: 'beta',
  gamma: 'gamma',
  delta: 'delta',
  epsilon: 'epsilon',
  varepsilon: 'epsilon',
  zeta: 'zeta',
  eta: 'eta',
  theta: 'theta',
  vartheta: 'theta',
  iota: 'iota',
  kappa: 'kappa',
  lambda: 'lambda',
  mu: 'mu',
  nu: 'nu',
  xi: 'xi',
  pi: 'pi',
  rho: 'rho',
  sigma: 'sigma',
  tau: 'tau',
  phi: 'phi',
  varphi: 'phi',
  chi: 'chi',
  psi: 'psi',
  omega: 'omega',
  partial: 'partial',
  nabla: 'nabla',
  exists: 'there exists',
  forall: 'for all',
  ldots: 'dot dot dot',
  cdots: 'dot dot dot',
  sdots: 'dot dot dot',
  prime: 'prime',
  circ: 'degrees',
  degree: 'degrees',
  colon: 'colon',
  mid: 'such that',
  quad: ' ',
  qquad: ' ',
  hspace: ' ',
  vspace: ' ',
  smallskip: ' ',
  medskip: ' ',
  bigskip: ' ',
  left: '',
  right: '',
  big: '',
  Big: '',
  bigg: '',
  Bigg: '',
  bigl: '',
  bigr: '',
  text: '',
};

// Convert LaTeX math source to spoken phrasing. Structural commands
// (\frac, \sqrt, \text, bounds, super/subscripts) are handled first so the
// generic `\word` table only sees the leftovers.
export function latexToSpeech(s: string): string {
  let t = s;
  // \begin{env} / \end{env} tags: strip the tags, keep the inner text.
  t = t.replace(/\\begin\{[^}]*\}/g, ' ');
  t = t.replace(/\\end\{[^}]*\}/g, ' ');
  // \text{...}, \mathrm{...}, ... → inner content.
  t = t.replace(/\\(?:text|mathrm|operatorname|textrm|mathbf|mathit|mathsf)\{([^}]*)\}/g, '$1');
  // \frac/\dfrac/\tfrac{a}{b} → "a over b"; \binom{n}{k} → "n choose k".
  t = t.replace(/\\(?:frac|dfrac|tfrac)\{([^}]*)\}\{([^}]*)\}/g, '$1 over $2');
  t = t.replace(/\\binom\{([^}]*)\}\{([^}]*)\}/g, '$1 choose $2');
  // \sqrt[n]{x} / \sqrt{x} → "square root of x".
  t = t.replace(/\\sqrt(?:\[[^\]]*\])?\{([^}]*)\}/g, 'square root of $1');
  // Accent decorations: \bar{x} → "x bar", \hat{x} → "x hat".
  t = t.replace(/\\(bar|overline|hat|widehat|vec|tilde|dot)\{([^}]*)\}/g, '$2 $1');
  // Bounded operators: \int_{a}^{b} → "integral from a to b".
  t = t.replace(
    /\\(int|oint|iint|iiint|sum|prod)\s*_\s*\{([^}]*)\}\s*\^\s*\{([^}]*)\}/g,
    (_m, cmd: string, lo: string, hi: string) => {
      const name = cmd === 'sum' ? 'sum' : cmd === 'prod' ? 'product' : 'integral';
      return `${name} from ${lo} to ${hi}`;
    },
  );
  // Lower bound only: \sum_{i=1} → "sum from i equals 1".
  t = t.replace(/\\(int|oint|sum|prod)\s*_\s*\{([^}]*)\}/g, (_m, cmd: string, lo: string) => {
    const name = cmd === 'sum' ? 'sum' : cmd === 'prod' ? 'product' : 'integral';
    return `${name} from ${lo}`;
  });
  // Superscripts: ^2 → squared, ^3 → cubed, ^{...} → "to the power of ...".
  t = t.replace(/\^\{?([0-9]+)\}?/g, (_m, n: string) =>
    n === '2' ? ' squared' : n === '3' ? ' cubed' : ` to the power of ${n}`,
  );
  t = t.replace(/\^\{([^}]*)\}/g, ' to the power of $1');
  // Subscripts: _{x} / _x → "sub x".
  t = t.replace(/_\{([^}]*)\}/g, ' sub $1');
  t = t.replace(/_([A-Za-z0-9]+)/g, ' sub $1');
  // Named commands → spoken words (unknown ones keep their bare name).
  t = t.replace(/\\([a-zA-Z]+)/g, (_m, w: string) => {
    const spoken = LATEX_SPOKEN[w];
    return spoken === undefined ? ` ${w}` : ` ${spoken}`;
  });
  // Plain math operators.
  t = t.replace(/%/g, ' percent ');
  t = t.replace(/=/g, ' equals ');
  // Strip math delimiters and layout characters.
  t = t.replace(/[${}\\[\]&_^~]/g, ' ');
  return t.replace(/\s+/g, ' ').trim();
}

export function stripMarkdownForTTS(s: string): string {
  return latexToSpeech(
    s
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/_([^_]+)_/g, '$1')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/^[-*+]\s+/gm, '')
      .replace(/^\d+\.\s+/gm, '')
      .replace(/>/g, ''),
  );
}
