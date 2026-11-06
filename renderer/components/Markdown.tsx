import { isValidElement, useMemo, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { IconCheck, IconCopy } from '@tabler/icons-react';
import { fuzzyResolveIcon } from '../lib/iconMatch';
import { ipc } from '../lib/ipc';
import { sanitizeSchema } from './sanitizeSchemas';
import { remarkLatex } from '../lib/remark-latex';

// Normalize the math delimiter styles models actually emit into the $ / $$
// forms remark-math understands. Handles:
//   \[ ... \] and \\[...\\]  → $$ ... $$   (display)
//   \( ... \) and \\(...\\)  → $ ... $     (inline)
//   bare \begin{env}...\end{env} blocks (no $ delimiters at all) → wrapped in $$
// Also rewrites the \begin{align}* envs models love for sums into katex's
// \begin{aligned}, which is the closest supported equivalent.
function trimLines(s: string): string {
  return s
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join('\n');
}

// Bare direct image links the model pasted as text (against the [IMAGE]
// rule) render as real pictures instead of raw URLs. Only standalone-line
// URLs with image extensions convert — [IMAGE] subject lines, markdown links
// and code blocks are left alone.
const BARE_IMAGE_URL_RE = /^(https?:\/\/\S+\.(?:png|jpe?g|webp|gif|bmp|svg)(?:\?\S*)?)$/gim;

export function linkifyImageUrls(text: string): string {
  return String(text ?? '').replace(BARE_IMAGE_URL_RE, '![]($1)');
}

export function normalizeLatexDelimiters(text: string): string {  // `\\[` = literal backslash-backslash-paren; `\[` = single backslash-paren.
  let out = text
    .replace(/\\\\\[([\s\S]*?)\\\\\]/g, (_m, inner: string) => `\n$$\n${trimLines(inner)}\n$$\n`)
    .replace(/\\\[([\s\S]*?)\\\]/g, (_m, inner: string) => `\n$$\n${trimLines(inner)}\n$$\n`)
    .replace(/\\\\\(([\s\S]*?)\\\\\)/g, (_m, inner: string) => `$${trimLines(inner)}$`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_m, inner: string) => `$${trimLines(inner)}$`);

  // Bare LaTeX environments (the "$$ not used at all" case): only wrap when
  // NO $ or backslash-paren delimiters appear anywhere, so we never double-
  // wrap math that already has delimiters.
  const hasDelimitedMath = /[\\]?[\$]|\\\(|\\\[|\\\\\(|\\\\\[/.test(out);
  if (!hasDelimitedMath) {
    out = out.replace(
      /\\begin\{([^}]+)\}([\s\S]*?)\\end\{\1\}/g,
      (_m, env: string, inner: string) => `$$\n\\begin{${env}}\n${inner}\n\\end{${env}}\n$$`,
    );
  }

  // align* / align → aligned so KaTeX can render multi-line sums.
  return out
    .replace(/\\begin\{align\*\}/g, '\\begin{aligned}')
    .replace(/\\end\{align\*\}/g, '\\end{aligned}')
    .replace(/\\begin\{align\}/g, '\\begin{aligned}')
    .replace(/\\end\{align\}/g, '\\end{aligned}');
}

// Pull the raw code text out of a <pre>'s <code> children (react-markdown can
// pass a string, an array of strings, or nested elements).
function textFromChildren(children: ReactNode): string {
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(textFromChildren).join('');
  if (isValidElement(children)) return textFromChildren(children.props.children);
  return '';
}

// Small floating copy button on every code block: icon-only, sits in the
// block's top-right corner, copies ONLY this block's code.
function CodeBlock({ text, children }: { text: string; children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      } catch {
        /* give up */
      }
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="relative">
      {text.length > 0 && (
        <button
          type="button"
          title={copied ? 'Copied' : 'Copy code'}
          aria-label={copied ? 'Copied' : 'Copy code'}
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            void copy();
          }}
          className="absolute right-1.5 top-1.5 z-10 flex h-6 w-6 items-center justify-center rounded-md border border-white/10 bg-white/12 text-white/75 shadow-sm backdrop-blur transition-colors hover:bg-white/25 hover:text-white focus:outline-none dark:border-neutral-900/15 dark:bg-neutral-900/12 dark:text-neutral-900/60 dark:hover:bg-neutral-900/25 dark:hover:text-neutral-900"
        >
          {copied ? <IconCheck size={14} stroke={2} /> : <IconCopy size={14} stroke={2} />}
        </button>
      )}
      {children}
    </div>
  );
}

// Convert :icon-name: shortcodes to <span class="spirit-icon" data-icon="name">
// so the span component can resolve them to tabler SVG icons.
const ICON_SHORTCODE_RE = /:([a-z][a-z0-9_-]*):/g;
function resolveIconShortcodes(text: string): string {
  return text.replace(ICON_SHORTCODE_RE, (_m, name: string) =>
    `<span class="spirit-icon" data-icon="${name}"></span>`,
  );
}
// rich-text copy). Quoted cells get CSV-style escaping so a tab/quote inside a
// cell does not break the columns when pasted into a spreadsheet.
function tableToTsv(table: HTMLTableElement): string {
  return Array.from(table.querySelectorAll('tr'))
    .map((row) =>
      Array.from(row.querySelectorAll('th, td'))
        .map((cell) => {
          const text = (cell.textContent ?? '').replace(/\s+/g, ' ').trim();
          return /[\t\n"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
        })
        .join('\t'),
    )
    .filter((line) => line.length > 0)
    .join('\n');
}

// Copy button on every table, mirroring CodeBlock. Writes BOTH the rich HTML
// <table> and a plain-text TSV to the clipboard so pasting into Word / Excel /
// email keeps real columns instead of one long line.
function TableBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const copy = async () => {
    const table = ref.current?.querySelector('table');
    if (!table) return;
    const html = table.outerHTML;
    const tsv = tableToTsv(table);
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([tsv], { type: 'text/plain' }),
        }),
      ]);
    } catch {
      try {
        await navigator.clipboard.writeText(tsv);
      } catch {
        /* give up */
      }
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        title={copied ? 'Copied' : 'Copy table'}
        aria-label={copied ? 'Copied' : 'Copy table'}
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          void copy();
        }}
        className="absolute right-1.5 top-1.5 z-10 flex h-6 w-6 items-center justify-center rounded-md border border-white/10 bg-white/12 text-white/75 shadow-sm backdrop-blur transition-colors hover:bg-white/25 hover:text-white focus:outline-none dark:border-neutral-900/15 dark:bg-neutral-900/12 dark:text-neutral-900/60 dark:hover:bg-neutral-900/25 dark:hover:text-neutral-900"
      >
        {copied ? <IconCheck size={14} stroke={2} /> : <IconCopy size={14} stroke={2} />}
      </button>
      {children}
    </div>
  );
}

// Renders one math expression with KaTeX. The raw LaTeX comes from the
// escaped placeholder span produced by remarkLatex, so it is never treated as
// markup anywhere in the markdown pipeline. Rendered via renderToString +
// dangerouslySetInnerHTML (KaTeX escapes its input and emits its own spans);
// if KaTeX chokes on something, fall back to showing the raw LaTeX.
function Latex({ math, display }: { math: string; display: boolean }) {
  const html = useMemo(() => {
    try {
      return katex.renderToString(math, {
        throwOnError: false,
        displayMode: display,
        strict: false,
      });
    } catch {
      return '';
    }
  }, [math, display]);
  if (!html) {
    return (
      <code className="rounded bg-white/12 px-1 py-[1px] font-mono text-[12px] text-white/92 dark:bg-neutral-900/12 dark:text-neutral-900/92">
        {math}
      </code>
    );
  }
  if (display) {
    return (
      <div className="spirit-latex-block-wrap">
        <span className="spirit-latex spirit-latex-block" dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    );
  }
  return <span className="spirit-latex spirit-latex-inline" dangerouslySetInnerHTML={{ __html: html }} />;
}

const components: Components = {
  span: ({ className, children, ...rest }) => {
    const cls = className ?? '';
    if (cls.includes('spirit-latex')) {
      return <Latex math={textFromChildren(children)} display={cls.includes('spirit-latex-block')} />;
    }
    if (cls.includes('spirit-icon')) {
      const iconName = (rest as Record<string, unknown>)['data-icon'] as string | undefined;
      if (iconName) {
        const Icon = fuzzyResolveIcon(iconName);
        return <Icon size={14} stroke={2} className="mx-0.5 inline-block align-[-0.15em]" />;
      }
    }
    return (
      <span className={className} {...rest}>
        {children}
      </span>
    );
  },
  h1: (p) => (
    <h1
      className="mt-2 mb-1 text-[15px] font-semibold leading-snug text-white dark:text-neutral-900"
      {...p}
    />
  ),
  h2: (p) => (
    <h2
      className="mt-2 mb-1 border-b border-white/8 pb-1 text-[14px] font-semibold leading-snug text-white dark:border-neutral-900/10 dark:text-neutral-900"
      {...p}
    />
  ),
  h3: (p) => (
    <h3
      className="mt-1.5 mb-0.5 text-[13.5px] font-semibold leading-snug text-white/90 dark:text-neutral-900/90"
      {...p}
    />
  ),
  p: (p) => (
    <p
      className="my-1 text-[13.5px] leading-[1.55] text-white/92 dark:text-neutral-900/92"
      {...p}
    />
  ),
  strong: (p) => (
    <strong className="font-semibold text-white dark:text-neutral-900" {...p} />
  ),
  em: (p) => <em className="italic" {...p} />,
  ul: (p) => (
    <ul
      className="my-1.5 ml-4 list-disc space-y-0.5 text-white/92 marker:text-accent dark:text-neutral-900/92"
      {...p}
    />
  ),
  ol: (p) => (
    <ol
      className="my-1.5 ml-5 list-decimal space-y-0.5 text-white/92 marker:text-accent dark:text-neutral-900/92"
      {...p}
    />
  ),
  li: (p) => <li className="text-[13.5px] leading-[1.55]" {...p} />,
  a: ({ href, children, ...rest }) => (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        if (!href) return;
        if (href.startsWith('session://')) {
          const path = decodeURIComponent(href.slice('session://'.length));
          void ipc.revealSession(path);
          return;
        }
        void ipc.openExternal(href);
      }}
      className="text-accent underline decoration-accent/40 decoration-[1.5px] underline-offset-2 hover:decoration-accent"
      {...rest}
    >
      {children}
    </a>
  ),
  code: ({ className, children, ...rest }) => {
    const isBlock = (className ?? '').includes('language-');
    if (isBlock) {
      return (
        <code className={className} {...rest}>
          {children}
        </code>
      );
    }
    return (
      <code
        className="rounded bg-white/12 px-1 py-[1px] font-mono text-[12px] text-white/92 dark:bg-neutral-900/12 dark:text-neutral-900/92"
        {...rest}
      >
        {children}
      </code>
    );
  },
  pre: ({ children, ...rest }) => {
    const text = textFromChildren(children);
    return (
      <CodeBlock text={text}>
        <pre
          className="my-1.5 overflow-x-auto rounded-md border border-white/8 bg-white/6 p-2 font-mono text-[12px] leading-snug text-white/92 dark:border-neutral-900/10 dark:bg-neutral-900/8 dark:text-neutral-900/92"
          {...rest}
        >
          {children}
        </pre>
      </CodeBlock>
    );
  },
  blockquote: (p) => (
    <blockquote
      className="my-1.5 rounded-r-md border-l-2 border-accent/60 bg-accent/8 py-1.5 pl-3 text-[13px] italic text-white/88 dark:text-neutral-900/85"
      {...p}
    />
  ),
  hr: () => <hr className="my-2 border-white/10 dark:border-neutral-900/10" />,
  img: ({ src, alt }: { src?: string; alt?: string }) => (
    <img
      src={src}
      alt={alt ?? 'image'}
      loading="lazy"
      referrerPolicy="no-referrer"
      className="my-1.5 max-h-64 w-auto max-w-full rounded-md border border-white/10 dark:border-neutral-900/10"
      onError={(e) => {
        // Dead link: collapse to nothing instead of a broken-image icon.
        (e.target as HTMLImageElement).style.display = 'none';
      }}
    />
  ),
  table: (p) => (
    <TableBlock>
      <div className="my-2 overflow-x-auto rounded-md border border-white/8 dark:border-neutral-900/10">
        <table
          className="w-full border-collapse text-[12.5px] text-white/92 dark:text-neutral-900/92"
          {...p}
        />
      </div>
    </TableBlock>
  ),
  th: (p) => (
    <th
      className="border-b border-white/12 bg-white/5 px-2 py-1.5 text-left font-semibold text-white dark:border-neutral-900/12 dark:bg-neutral-900/5 dark:text-neutral-900"
      {...p}
    />
  ),
  td: (p) => (
    <td
      className="border-b border-white/8 px-2 py-1.5 last:border-b-0 dark:border-neutral-900/8"
      {...p}
    />
  ),
};

export function Markdown({ text }: { text: string }) {
  return (
    <div className="ai-md">
      <ReactMarkdown
        remarkPlugins={[remarkMath, remarkLatex, remarkGfm]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema]]}
        components={components}
      >
        {resolveIconShortcodes(normalizeLatexDelimiters(linkifyImageUrls(text)))}
      </ReactMarkdown>
    </div>
  );
}
