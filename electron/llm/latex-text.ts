// LaTeX → Unicode plain-text rendering. Pure module (no Electron, no provider
// IO) shared by BOTH the main process (annotation labels broadcast to the
// overlay) and the renderer (mermaid diagrams, via mermaid-clean).
//
// Why: the KaTeX pipeline renders LaTeX beautifully in the main answer panel,
// but mermaid and the annotation chips have no math engine — a label like
// `\text{C=O}`, `\beta_1^2` or a node `A["$\alpha \neq 0$"]` would otherwise
// show its raw commands. This converter trades perfect typesetting for
// readable, compact Unicode so every surface "speaks math". It only touches
// REAL LaTeX escapes (`\command`, `_{..}`, `^{..}`, `{...}` groups) and leaves
// all surrounding prose untouched.
//
// Supported: Greek, common operators, \frac/tfrac/dfrac → Unicode vulgar
// fractions (or a/b), \sqrt, \text/\mathrm/\operatorname nests, \left/right
// delimiters, \bar/\vec/\hat combining marks, sub- and superscripts, and
// simple single-letter command sequences. Anything unknown degrades gracefully
// (the backslash is dropped, the word kept).

const GREEK: Record<string, string> = {
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  epsilon: 'ε',
  varepsilon: 'ϵ',
  zeta: 'ζ',
  eta: 'η',
  theta: 'θ',
  vartheta: 'ϑ',
  iota: 'ι',
  kappa: 'κ',
  lambda: 'λ',
  mu: 'μ',
  nu: 'ν',
  xi: 'ξ',
  omicron: 'ο',
  pi: 'π',
  varpi: 'ϖ',
  rho: 'ρ',
  varrho: 'ϱ',
  sigma: 'σ',
  tau: 'τ',
  upsilon: 'υ',
  phi: 'φ',
  varphi: 'ϕ',
  chi: 'χ',
  psi: 'ψ',
  omega: 'ω',
  Gamma: 'Γ',
  Delta: 'Δ',
  Theta: 'Θ',
  Lambda: 'Λ',
  Xi: 'Ξ',
  Pi: 'Π',
  Sigma: 'Σ',
  Upsilon: 'Υ',
  Phi: 'Φ',
  Psi: 'Ψ',
  Omega: 'Ω',
};

const OPERATORS: Record<string, string> = {
  neq: '≠',
  leq: '≤',
  le: '≤',
  geq: '≥',
  ge: '≥',
  ll: '≪',
  gg: '≫',
  times: '×',
  div: '÷',
  pm: '±',
  mp: '∓',
  cdot: '·',
  bull: '•',
  approx: '≈',
  cong: '≅',
  equiv: '≡',
  sim: '∼',
  propto: '∝',
  in: '∈',
  notin: '∉',
  ni: '∋',
  subset: '⊂',
  subseteq: '⊆',
  nsubseteq: '⊈',
  supset: '⊃',
  supseteq: '⊇',
  nsupseteq: '⊉',
  cup: '∪',
  cap: '∩',
  bigcup: '⋃',
  bigcap: '⋂',
  vee: '∨',
  wedge: '∧',
  oplus: '⊕',
  ominus: '⊖',
  otimes: '⊗',
  odiv: '⊘',
  oslash: '⊘',
  infty: '∞',
  infinity: '∞',
  rightarrow: '→',
  to: '→',
  leftarrow: '←',
  Rightarrow: '⇒',
  Leftarrow: '⇐',
  leftrightarrow: '↔',
  Leftrightarrow: '⇔',
  uparrow: '↑',
  downarrow: '↓',
  Uparrow: '⇑',
  Downarrow: '⇓',
  rightmapsto: '↦',
  mapsto: '↦',
  hookrightarrow: '↪',
  hookleftarrow: '↩',
  rightleftharpoons: '⇌',
  sum: '∑',
  prod: '∏',
  int: '∫',
  iint: '∬',
  iiint: '∭',
  oint: '∮',
  nabla: '∇',
  partial: '∂',
  prime: '′',
  dprime: '″',
  forall: '∀',
  exists: '∃',
  nexists: '∄',
  neg: '¬',
  lnot: '¬',
  angle: '∠',
  perp: '⊥',
  parallel: '∥',
  mid: '|',
  degree: '°',
  circ: '°',
  ell: 'ℓ',
  emptyset: '∅',
  varnothing: '∅',
  aleph: 'ℵ',
  therefore: '∴',
  because: '∵',
  dots: '…',
  ldots: '…',
  cdots: '⋯',
  vdots: '⋮',
  ddots: '⋱',
  checkmark: '✓',
  dagger: '†',
  ddagger: '‡',
  hbar: 'ℏ',
  square: '□',
  leadsto: '↝',
};

// Unicode subscripts only exist for a handful of letters/numbers — anything
// else falls back to the wrapped `_(x)` form.
const SUB_SCRIPTS: Record<string, string> = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄',
  '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
  a: 'ₐ', e: 'ₑ', h: 'ₕ', i: 'ᵢ', j: 'ⱼ', k: 'ₖ', l: 'ₗ',
  m: 'ₘ', n: 'ₙ', o: 'ₒ', p: 'ₚ', r: 'ᵣ', s: 'ₛ', t: 'ₜ',
  u: 'ᵤ', v: 'ᵥ', x: 'ₓ',
  '-': '₋', '+': '₊', '(': '₍', ')': '₎',
};

const SUPER_SCRIPTS: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
  '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
  a: 'ᵃ', b: 'ᵇ', c: 'ᶜ', d: 'ᵈ', e: 'ᵉ', f: 'ᶠ', g: 'ᵍ',
  h: 'ʰ', i: 'ⁱ', j: 'ʲ', k: 'ᵏ', l: 'ˡ', m: 'ᵐ', n: 'ⁿ',
  o: 'ᵒ', p: 'ᵖ', r: 'ʳ', s: 'ˢ', t: 'ᵗ', u: 'ᵘ', v: 'ᵛ',
  w: 'ʷ', x: 'ˣ', y: 'ʸ', z: 'ᶻ',
  '-': '⁻', '+': '⁺', '(': '⁽', ')': '⁾', '=': '⁼',
};

// Vulgar unicode fractions for the common single-digit pairs; anything larger
// falls back to the readable `a/b`.
const VULGAR: Record<string, string> = {
  '1/2': '½', '1/3': '⅓', '2/3': '⅔', '1/4': '¼', '3/4': '¾',
  '1/5': '⅕', '2/5': '⅖', '3/5': '⅗', '4/5': '⅘',
  '1/6': '⅙', '5/6': '⅚',
  '1/7': '⅐', '1/8': '⅛', '3/8': '⅜', '5/8': '⅝', '7/8': '⅞',
  '1/9': '⅑', '1/10': '⅒',
};

const COMMAND_RE = /^[a-zA-Z]+/;

// Read one braced `{...}` group or a single token (char or `\cmd`) starting at
// `idx`. Returns the raw inner text and the index just past the group.
function readGroup(s: string, idx: number): { content: string; next: number } {
  if (s[idx] === '{') {
    let depth = 1;
    let j = idx + 1;
    while (j < s.length && depth > 0) {
      if (s[j] === '{') depth += 1;
      else if (s[j] === '}') depth -= 1;
      if (depth > 0) j += 1;
    }
    return { content: s.slice(idx + 1, j), next: j + 1 };
  }
  if (s[idx] === '\\') {
    const m = COMMAND_RE.exec(s.slice(idx + 1));
    if (m) return { content: `\\${m[0]}`, next: idx + 1 + m[0].length };
    return { content: s.slice(idx, idx + 2), next: idx + 2 };
  }
  return { content: s[idx] ?? '', next: idx + 1 };
}

function subText(s: string): string {
  if (s.length === 0) return '';
  if ([...s].every((c) => SUB_SCRIPTS[c])) return [...s].map((c) => SUB_SCRIPTS[c]).join('');
  return `_(${s})`;
}

function superText(s: string): string {
  if (s.length === 0) return '';
  if ([...s].every((c) => SUPER_SCRIPTS[c])) return [...s].map((c) => SUPER_SCRIPTS[c]).join('');
  return `^(${s})`;
}

function fraction(num: string, den: string): string {
  const n = num.trim();
  const d = den.trim();
  if (VULGAR[`${n}/${d}`]) return VULGAR[`${n}/${d}`];
  return `${n}/${d}`;
}

// Render the CONTENTS of one group (no braces) into plain text. This is the
// recursive entry point used for `\text{...}`, `\sqrt{...}`, sup/sub groups …
function renderGroup(s: string): string {
  return latexToUnicodeText(s);
}

export function latexToUnicodeText(input: string): string {
  let out = '';
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === '\\') {
      const m = COMMAND_RE.exec(input.slice(i + 1));
      if (!m) {
        // Symbol escapes: \, \; \: \! \quad \qquad + literal \{ \} \( \) \\.
        const two = input.slice(i, i + 2);
        if (two === '\\ ' || two === '\\,' || two === '\\;' || two === '\\:' || two === '\\!') {
          out += ' ';
          i += 2;
          continue;
        }
        if (two === '\\{') { out += '{'; i += 2; continue; }
        if (two === '\\}') { out += '}'; i += 2; continue; }
        if (two === '\\(') { out += '('; i += 2; continue; }
        if (two === '\\)') { out += ')'; i += 2; continue; }
        if (two === '\\%') { out += '%'; i += 2; continue; }
        if (two === '\\&') { out += '&'; i += 2; continue; }
        if (two === '\\$') { out += '$'; i += 2; continue; }
        if (two === '\\#') { out += '#'; i += 2; continue; }
        if (two === '\\_') { out += '_'; i += 2; continue; }
        if (two === '\\\\' || two === '\\\n') { i += 2; continue; }
        // Unknown symbol escape (e.g. `\@`): keep it verbatim.
        out += two;
        i += 2;
        continue;
      }
      const name = m[0];
      const after = i + 1 + name.length;
      if (name === 'frac' || name === 'dfrac' || name === 'tfrac' || name === 'cfrac') {
        const num = readGroup(input, after);
        const den = readGroup(input, num.next);
        out += fraction(renderGroup(num.content), renderGroup(den.content));
        i = den.next;
      } else if (name === 'sqrt') {
        let root = '';
        let next = after;
        if (input[next] === '[') {
          const close = input.indexOf(']', next);
          if (close >= 0) {
            root = input.slice(next + 1, close);
            next = close + 1;
          }
        }
        const body = readGroup(input, next);
        out += superText(renderGroup(root)) + '√' + renderGroup(body.content);
        i = body.next;
      } else if (
        name === 'text' || name === 'mathrm' || name === 'operatorname' ||
        name === 'textit' || name === 'textbf' || name === 'mbox' ||
        name === 'emph' || name === 'ensuremath' || name === 'textrm' ||
        name === 'textup' || name === 'textsf' || name === 'texttt' ||
        name === 'mathbf' || name === 'mathit' || name === 'mathtt' ||
        name === 'mathcal' || name === 'mathbb' || name === 'boldsymbol' ||
        name === 'textbfmath'
      ) {
        const body = readGroup(input, after);
        out += renderGroup(body.content);
        i = body.next;
      } else if (name === 'left' || name === 'right') {
        // `\left(` → "(", `\left\{` → "{", `\left.` → (nothing). Same for right.
        // Drop the spaces models sprinkle around delimiters ("\left( \frac …")
        // so the wrapping reads "(½)" not "( ½ )".
        const rest = input.slice(after);
        let delim = rest[0] ?? '';
        let step = 1;
        if (rest[0] === '\\' && (rest[1] === '{' || rest[1] === '}')) {
          delim = rest[1];
          step = 2;
        } else if (rest[0] === '\\' && rest[1]) {
          delim = rest[1];
          step = 2;
        }
        if (delim === '.') {
          i = after + step;
        } else if (name === 'left') {
          out += delim;
          i = after + step;
          while (input[i] === ' ' || input[i] === '\t') i += 1;
        } else {
          out = out.replace(/\s+$/, '');
          out += delim;
          i = after + step;
        }
        continue;
      } else if (name === 'bar' || name === 'overline') {
        const body = readGroup(input, after);
        const inner = renderGroup(body.content);
        out += inner ? inner.slice(0, -1) + inner.slice(-1) + '\u0304' : '';
        i = body.next;
      } else if (name === 'vec' || name === 'overrightarrow') {
        const body = readGroup(input, after);
        const inner = renderGroup(body.content);
        out += inner ? inner.slice(0, -1) + inner.slice(-1) + '\u20D7' : '';
        i = body.next;
      } else if (name === 'hat' || name === 'widehat') {
        const body = readGroup(input, after);
        const inner = renderGroup(body.content);
        out += inner ? inner.slice(0, -1) + inner.slice(-1) + '\u0302' : '';
        i = body.next;
      } else if (name === 'dot' || name === 'ddot') {
        const body = readGroup(input, after);
        const inner = renderGroup(body.content);
        const mark = name === 'dot' ? '\u0307' : '\u0308';
        out += inner ? inner.slice(0, -1) + inner.slice(-1) + mark : '';
        i = body.next;
      } else if (name === 'underline') {
        const body = readGroup(input, after);
        const inner = renderGroup(body.content);
        out += inner ? inner.slice(0, -1) + inner.slice(-1) + '\u0332' : '';
        i = body.next;
      } else if (name === 'quad' || name === 'qquad') {
        out += name === 'quad' ? '  ' : '    ';
        i = after;
      } else if (name === 'begin' || name === 'end') {
        // Slash `\begin{pmatrix}` environments: swallow the env name, keep going.
        const env = readGroup(input, after);
        i = env.next;
      } else {
        out += GREEK[name] ?? OPERATORS[name] ?? name;
        i = after;
      }
      continue;
    }
    if (ch === '^' || ch === '_') {
      const exp = readGroup(input, i + 1);
      const content = renderGroup(exp.content);
      out += ch === '^' ? superText(content) : subText(content);
      i = exp.next;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}