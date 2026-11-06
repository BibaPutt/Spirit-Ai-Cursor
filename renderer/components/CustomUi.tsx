// Renders an AI-generated `[UI]` JSON component tree as real React
// components, themed with the current accent + dark/light mode. All nodes are
// loose (every field optional) so sloppy model output still renders. Form
// control values are collected by `name` and button actions interpolate
// `{name}` placeholders from them before sending/copying.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { UiNode } from '../../electron/types';
import { ipc } from '../lib/ipc';
import { MermaidDiagram } from './MermaidDiagram';
import { LatexInline } from './LatexInline';

export function stringifyValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map(stringifyValue).join(', ');
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return String(v);
}

export function interpolate(template: string, values: Record<string, unknown>): string {
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_-]*)\}/g, (m, name) =>
    name in values && values[name] !== undefined && values[name] !== null
      ? stringifyValue(values[name])
      : m,
  );
}

type UiCtx = {
  values: Record<string, unknown>;
  setValue: (name: string, v: unknown) => void;
  defaults: Record<string, unknown>;
  reset: () => void;
  submit: (prompt: string) => void;
  copy: (text: string) => void;
};

const Ctx = createContext<UiCtx | null>(null);

const useCtx = (): UiCtx => {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('CustomUi node rendered outside a CustomUi root');
  return ctx;
};

const getValue = (ctx: UiCtx, name: string): unknown => {
  const v = ctx.values[name];
  return v === undefined ? ctx.defaults[name] : v;
};

function collectDefaults(node: UiNode, out: Record<string, unknown>): void {
  if (node.name && node.default !== undefined && node.default !== null) {
    out[node.name] = node.default;
  }
  if (node.children) {
    for (const c of node.children) {
      if (typeof c !== 'string') collectDefaults(c, out);
    }
  }
}

type Props = {
  block: UiNode;
  onSubmit: (prompt: string) => void;
  onCopy: (text: string) => void;
};

export function CustomUi({ block, onSubmit, onCopy }: Props) {
  const defaults = useMemo(() => {
    const out: Record<string, unknown> = {};
    collectDefaults(block, out);
    return out;
  }, [block]);
  const defaultsRef = useRef(defaults);
  defaultsRef.current = defaults;
  const [values, setValues] = useState<Record<string, unknown>>({});
  // Fresh block (new answer, same slot) must never show previous inputs —
  // clear entered values when `block` changes.
  useEffect(() => {
    setValues({});
  }, [block]);

  const setValue = useCallback((name: string, v: unknown) => {
    setValues((prev) => ({ ...prev, [name]: v }));
  }, []);

  const reset = useCallback(() => {
    setValues({});
  }, []);

  const ctx: UiCtx = { values, setValue, defaults, reset, submit: onSubmit, copy: onCopy };

  return (
    <div className="my-1.5 w-full min-w-0">
      <Ctx.Provider value={ctx}>
        <Node node={block} />
      </Ctx.Provider>
    </div>
  );
}

// shared style tokens (match the overlay glass)

const TEXT = 'text-white/85 dark:text-neutral-900/85';
const MUTED = 'text-white/50 dark:text-neutral-900/50';
const INPUT =
  'w-full min-w-0 rounded-md border border-white/12 bg-white/8 px-2 py-1 text-[12.5px] text-white/90 outline-none transition placeholder:text-white/30 focus:border-accent/60 dark:border-neutral-900/15 dark:bg-neutral-900/8 dark:text-neutral-900/90 dark:placeholder:text-neutral-900/30';
const CARD =
  'rounded-lg border border-white/10 bg-white/5 dark:border-neutral-900/10 dark:bg-neutral-900/5';

const BTN_STYLES: Record<string, string> = {
  strong: 'bg-accent text-white shadow-sm hover:brightness-110 dark:text-neutral-900',
  accent: 'bg-accent/15 text-accent border border-accent/30 hover:bg-accent/25',
  soft: 'bg-accent/10 text-accent border border-accent/20 hover:bg-accent/15',
  ghost:
    'border border-white/12 text-white/85 hover:bg-white/10 dark:border-neutral-900/15 dark:text-neutral-900/85 dark:hover:bg-neutral-900/10',
  neutral:
    'bg-white/8 text-white/85 border border-white/12 hover:bg-white/14 dark:bg-neutral-900/8 dark:text-neutral-900/85 dark:border-neutral-900/12 dark:hover:bg-neutral-900/14',
  success: 'bg-emerald-500/15 text-emerald-500 border border-emerald-500/25 hover:bg-emerald-500/25 dark:text-emerald-700 dark:border-emerald-600/30',
  warning: 'bg-amber-500/15 text-amber-500 border border-amber-500/25 hover:bg-amber-500/25 dark:text-amber-700 dark:border-amber-600/30',
  danger: 'bg-rose-500/15 text-rose-400 border border-rose-500/25 hover:bg-rose-500/25 dark:text-rose-700 dark:border-rose-600/30',
};

const BADGE_STYLES: Record<string, string> = {
  strong: 'bg-accent text-white dark:text-neutral-900',
  accent: 'bg-accent/15 text-accent',
  soft: 'bg-white/10 text-white/85 dark:bg-neutral-900/10 dark:text-neutral-900/85',
  ghost: 'text-white/60 dark:text-neutral-900/60',
  neutral: 'bg-white/10 text-white/85 dark:bg-neutral-900/10 dark:text-neutral-900/85',
  success: 'bg-emerald-500/15 text-emerald-500 dark:text-emerald-700',
  warning: 'bg-amber-500/15 text-amber-500 dark:text-amber-700',
  danger: 'bg-rose-500/15 text-rose-400 dark:text-rose-700',
};

const TONE_STYLES: Record<string, string> = {
  strong: 'text-accent',
  accent: 'text-accent',
  soft: 'text-accent',
  ghost: 'text-white/85 dark:text-neutral-900/85',
  neutral: 'text-white/85 dark:text-neutral-900/85',
  success: 'text-emerald-500 dark:text-emerald-700',
  warning: 'text-amber-500 dark:text-amber-700',
  danger: 'text-rose-400 dark:text-rose-700',
};

const shade = (s: string | undefined, map: Record<string, string>, fallback: string): string =>
  (s && map[s]) || fallback;

// node renderer

function Node({ node }: { node: UiNode }) {
  const t = (node.t || 'text').toLowerCase();
  switch (t) {
    case 'card':
      return <Card node={node} />;
    case 'section':
      return <Section node={node} />;
    case 'row':
      return <Row node={node} />;
    case 'grid':
      return <Grid node={node} />;
    case 'tabs':
      return <Tabs node={node} />;
    case 'heading':
      return <Heading node={node} />;
    case 'text':
    case 'label':
      return <TextNode node={node} />;
    case 'badge':
      return <Badge node={node} />;
    case 'code':
      return <Code node={node} />;
    case 'list':
      return <ListNode node={node} />;
    case 'quote':
      return <Quote node={node} />;
    case 'link':
      return <LinkNode node={node} />;
    case 'kv':
      return <Kv node={node} />;
    case 'table':
      return <Table node={node} />;
    case 'stat':
      return <Stat node={node} />;
    case 'steps':
      return <Steps node={node} />;
    case 'timeline':
      return <Timeline node={node} />;
    case 'divider':
      return <Divider node={node} />;
    case 'progress':
      return <Progress node={node} />;
    case 'button':
      return <Button node={node} />;
    case 'toggle':
      return <Toggle node={node} />;
    case 'slider':
      return <Slider node={node} />;
    case 'select':
      return <Select node={node} />;
    case 'radio':
      return <Radio node={node} />;
    case 'checkbox':
      return <Checkbox node={node} />;
    case 'multiselect':
      return <Multiselect node={node} />;
    case 'text-input':
      return <TextInput node={node} />;
    case 'textarea':
      return <TextArea node={node} />;
    case 'password':
      return <Password node={node} />;
    case 'number':
      return <NumberInput node={node} />;
    case 'date':
      return <DateInput node={node} />;
    case 'mermaid':
      return <MermaidInline node={node} />;
    default:
      return (
        <p className={`${TEXT} text-[12.5px] leading-relaxed`}>
          <LatexInline text={node.text ?? node.label ?? ''} />
        </p>
      );
  }
}

const renderChildren = (children: UiNode['children'], label: string | undefined): ReactNode => {
  if (!children || children.length === 0) {
    return label ? <p className={`${MUTED} text-[11px]`}>{label}</p> : null;
  }
  return children.map((c, i) =>
    typeof c === 'string' ? (
      <p key={i} className={`${TEXT} whitespace-pre-line text-[12.5px] leading-relaxed`}>
        <LatexInline text={c} />
      </p>
    ) : (
      <Node key={i} node={c} />
    ),
  );
};

const meta = (node: UiNode): ReactNode => {
  if (!node.label && !node.title) return null;
  return (
    <div className="mb-1.5">
      {node.title && (
        <p className="text-[11px] font-semibold uppercase tracking-wide text-white/65 dark:text-neutral-900/65">
          <LatexInline text={node.title} />
        </p>
      )}
      {node.label && (
        <p className={`${MUTED} text-[11px]`}>
          <LatexInline text={node.label} />
        </p>
      )}
    </div>
  );
};

function Card({ node }: { node: UiNode }) {
  return (
    <div className={`${CARD} w-full min-w-0 p-2.5`}>
      {meta(node)}
      {renderChildren(node.children, node.label)}
    </div>
  );
}

function Section({ node }: { node: UiNode }) {
  return (
    <div className="w-full min-w-0 py-0.5">
      {meta(node)}
      {renderChildren(node.children, node.label)}
    </div>
  );
}

function Row({ node }: { node: UiNode }) {
  return (
    <div className="flex w-full min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1.5">
      {renderChildren(node.children, node.label)}
    </div>
  );
}

function Grid({ node }: { node: UiNode }) {
  const cols = Math.min(6, Math.max(1, node.cols ?? 2));
  const colClass =
    cols === 1
      ? 'grid-cols-1'
      : cols === 2
        ? 'grid-cols-1 sm:grid-cols-2'
        : cols === 3
          ? 'grid-cols-1 sm:grid-cols-2 md:grid-cols-3'
          : cols === 4
            ? 'grid-cols-2 md:grid-cols-4'
            : cols === 5
              ? 'grid-cols-2 md:grid-cols-5'
              : 'grid-cols-2 md:grid-cols-6';
  return (
    <div className={`grid w-full min-w-0 gap-2 ${colClass}`}>
      {renderChildren(node.children, node.label)}
    </div>
  );
}

function Tabs({ node }: { node: UiNode }) {
  const children = (node.children ?? []).filter((c): c is UiNode => typeof c !== 'string');
  const start =
    typeof node.active === 'number'
      ? Math.min(node.active, Math.max(0, children.length - 1))
      : typeof node.active === 'string'
        ? node.active
        : 0;
  const [tab, setTab] = useState<string | number>(start);
  const current = children[typeof tab === 'number' ? tab : children.findIndex((c) => (c.label ?? c.title) === tab)];
  return (
    <div className="w-full min-w-0">
      {children.length > 1 && (
        <div className="mb-1.5 flex flex-wrap gap-1">
          {children.map((c, i) => {
            const label = c.label ?? c.title ?? `Tab ${i + 1}`;
            const isActive = typeof tab === 'number' ? tab === i : (c.label ?? c.title) === tab;
            return (
              <button
                key={i}
                type="button"
                onClick={() => setTab(typeof tab === 'number' ? i : ((c.label ?? c.title) ?? i))}
                className={[
                  'rounded-full px-2.5 py-0.5 text-[11px] font-medium transition',
                  isActive
                    ? 'bg-accent/15 text-accent'
                    : 'bg-white/8 text-white/60 hover:bg-white/14 hover:text-white/90 dark:bg-neutral-900/8 dark:text-neutral-900/60 dark:hover:bg-neutral-900/14 dark:hover:text-neutral-900/90',
                ].join(' ')}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}
      {current ? <Node node={current} /> : renderChildren(node.children, node.label)}
    </div>
  );
}

function Heading({ node }: { node: UiNode }) {
  return (
    <h3 className={`${TEXT} text-[13px] font-semibold leading-snug`}>
      {node.icon && <span className="mr-1">{node.icon}</span>}
      <LatexInline text={node.text ?? node.label ?? ''} />
    </h3>
  );
}

function TextNode({ node }: { node: UiNode }) {
  return (
    <p className={`${TEXT} whitespace-pre-line text-[12.5px] leading-relaxed`}>
      {node.icon && <span className="mr-1">{node.icon}</span>}
      <LatexInline text={node.text ?? node.label ?? ''} />
    </p>
  );
}

function Badge({ node }: { node: UiNode }) {
  return (
    <span
      className={[
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium',
        shade(node.variant, BADGE_STYLES, BADGE_STYLES.soft),
      ].join(' ')}
    >
      {node.icon && <span>{node.icon}</span>}
      <LatexInline text={node.text ?? node.label ?? ''} />
    </span>
  );
}

function Code({ node }: { node: UiNode }) {
  return (
    <pre
      className={`${CARD} overflow-x-auto p-2 font-mono text-[11.5px] leading-relaxed ${TEXT}`}
    >
      {node.text ?? node.label ?? ''}
    </pre>
  );
}

function ListNode({ node }: { node: UiNode }) {
  const items = (node.items as unknown[])?.length
    ? (node.items as unknown[])
    : (node.children ?? []).map((c) =>
        typeof c === 'string' ? c : (c.text ?? c.label ?? ''),
      );
  const ordered = node.t?.toLowerCase() === 'ol';
  const Wrapper = ordered ? 'ol' : 'ul';
  return (
    <Wrapper className={`${TEXT} ml-3 list-disc space-y-0.5 text-[12.5px] leading-relaxed`}>
      {items.map((it, i) => (
        <li key={i} className="leading-relaxed">
          {typeof it === 'object' && it !== null && 'label' in it && it.label
            ? <LatexInline text={String(it.label)} />
            : <LatexInline text={String(it)} />}
        </li>
      ))}
    </Wrapper>
  );
}

function Quote({ node }: { node: UiNode }) {
  return (
    <blockquote
      className={`border-l-2 border-accent/50 py-0.5 pl-2.5 text-[12.5px] italic leading-relaxed ${TEXT}`}
    >
      <LatexInline text={node.text ?? node.label ?? ''} />
    </blockquote>
  );
}

function LinkNode({ node }: { node: UiNode }) {
  return (
    <a
      className="cursor-pointer text-[12.5px] font-medium text-accent underline underline-offset-2 hover:brightness-110"
      onClick={(e) => {
        e.stopPropagation();
        if (node.href) void ipc.openExternal(node.href);
      }}
      title={node.href}
    >
      {node.text ?? node.label ?? node.href ?? ''}
    </a>
  );
}

function Kv({ node }: { node: UiNode }) {
  const pairs = (node.items as unknown[] | undefined) ?? [];
  const entries =
    pairs.length > 0
      ? pairs
      : (node.children ?? [])
          .filter((c): c is UiNode => typeof c !== 'string' && !!c.label)
          .map((c) => ({ label: c.label, value: c.text ?? '' }));
  return (
    <dl className={`${CARD} w-full min-w-0 divide-y divide-white/8 dark:divide-neutral-900/8`}>
      {entries.map((e, i) => (
        <div key={i} className="flex gap-3 px-2.5 py-1">
          <dt className="w-2/5 shrink-0 text-[11.5px] font-medium text-white/50 dark:text-neutral-900/50">
            {typeof e === 'object' && e !== null && 'label' in e ? <LatexInline text={String(e.label)} /> : ''}
          </dt>
          <dd className={`min-w-0 flex-1 text-[12px] ${TEXT}`}>
            {typeof e === 'object' && e !== null && 'value' in e ? <LatexInline text={String(e.value)} /> : ''}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Table({ node }: { node: UiNode }) {
  const headers = node.headers ?? [];
  const rows = (node.rows as Array<Array<string | number>> | undefined) ?? [];
  return (
    <div className={`${CARD} w-full min-w-0 overflow-x-auto`}>
      <table className="w-full border-collapse text-[11.5px]">
        {headers.length > 0 && (
          <thead>
            <tr>
              {headers.map((h, i) => (
                <th
                  key={i}
                  className="border-b border-white/10 px-2 py-1 text-left font-semibold text-white/55 dark:border-neutral-900/10 dark:text-neutral-900/55"
                >
                  <LatexInline text={String(h)} />
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="odd:bg-white/3 dark:odd:bg-neutral-900/3">
              {r.map((c, j) => (
                <td key={j} className={`px-2 py-1 align-top ${TEXT}`}>
                  <LatexInline text={String(c)} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Stat({ node }: { node: UiNode }) {
  const tone = shade(node.variant, TONE_STYLES, 'text-accent');
  return (
    <div className={`${CARD} w-full min-w-0 px-2.5 py-2`}>
      {node.label && <p className={`${MUTED} text-[10px] font-medium uppercase tracking-wide`}><LatexInline text={node.label} /></p>}
      <p className={`text-[19px] font-bold leading-tight ${tone}`}><LatexInline text={node.text ?? ''} /></p>
      {node.delta && (
        <p className={`mt-0.5 text-[11px] font-medium ${shade(node.variant, TONE_STYLES, 'text-accent')}`}>
          <LatexInline text={node.delta} />
        </p>
      )}
    </div>
  );
}

function Steps({ node }: { node: UiNode }) {
  const children = (node.children ?? []).filter((c): c is UiNode => typeof c !== 'string');
  return (
    <div className="w-full min-w-0 space-y-1.5">
      {children.map((c, i) => (
        <div key={i} className="flex gap-2">
          <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-accent/15 text-[10px] font-bold text-accent">
            {i + 1}
          </span>
          <div className="min-w-0">
            <p className={`${TEXT} text-[12px] font-medium`}><LatexInline text={c.label ?? ''} /></p>
            {c.text && <p className={`${MUTED} text-[11.5px] leading-relaxed`}><LatexInline text={c.text} /></p>}
          </div>
        </div>
      ))}
    </div>
  );
}

function Timeline({ node }: { node: UiNode }) {
  const items = (node.items as unknown[] | undefined) ?? [];
  const entries = items.length
    ? items
    : (node.children ?? []).map((c) => (typeof c === 'string' ? c : (c.text ?? c.label ?? '')));
  return (
    <div className="w-full min-w-0 space-y-1">
      {entries.map((it, i) => {
        const label =
          typeof it === 'object' && it !== null && 'label' in it ? String(it.label) : String(it);
        const detail =
          typeof it === 'object' && it !== null && 'text' in it ? String(it.text) : undefined;
        return (
          <div key={i} className="flex gap-2">
            <span className="mt-[5px] h-[7px] w-[7px] shrink-0 rounded-full bg-accent/70" />
            <div className="min-w-0">
              <p className={`${TEXT} text-[12px] leading-relaxed`}><LatexInline text={label} /></p>
              {detail && <p className={`${MUTED} text-[11.5px] leading-relaxed`}><LatexInline text={detail} /></p>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Divider({ node }: { node: UiNode }) {
  return (
    <div className="flex w-full min-w-0 items-center gap-2 py-0.5">
      <div className="h-px flex-1 bg-white/10 dark:bg-neutral-900/10" />
      {node.label && <span className={`${MUTED} text-[10px]`}>{node.label}</span>}
      {node.label && <div className="h-px flex-1 bg-white/10 dark:bg-neutral-900/10" />}
    </div>
  );
}

function Progress({ node }: { node: UiNode }) {
  const num = Math.max(0, Math.min(100, Number(node.text ?? node.default ?? 0) || 0));
  return (
    <div className="w-full min-w-0">
      {node.label && (
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className={`${MUTED} text-[11px]`}>{node.label}</span>
          <span className={`text-[11px] font-semibold ${TONE_STYLES.accent}`}>{num}%</span>
        </div>
      )}
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10 dark:bg-neutral-900/10">
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-300"
          style={{ width: `${num}%` }}
        />
      </div>
    </div>
  );
}

function MermaidInline({ node }: { node: UiNode }) {
  return <MermaidDiagram code={node.text ?? node.label ?? ''} />;
}

// form controls

function ControlShell({
  node,
  children,
  hint,
  error,
}: {
  node: UiNode;
  children: ReactNode;
  hint?: string;
  error?: string;
}) {
  return (
    <div className="w-full min-w-0">
      {node.label && (
        <label className={`mb-1 block text-[11.5px] font-medium ${TEXT}`}>
          <LatexInline text={node.label} />
          {node.required && <span className="ml-0.5 text-accent">*</span>}
        </label>
      )}
      {children}
      {error && <p className="mt-0.5 text-[10.5px] text-rose-400 dark:text-rose-700">{error}</p>}
      {!error && hint && (
        <p className={`${MUTED} mt-0.5 text-[10.5px]`}>
          <LatexInline text={hint} />
        </p>
      )}
    </div>
  );
}

function TextInput({ node }: { node: UiNode }) {
  const ctx = useCtx();
  const name = node.name;
  if (!name) return <TextNode node={node} />;
  const value = String(getValue(ctx, name) ?? '');
  return (
    <ControlShell node={node} hint={node.text}>
      <input
        type="text"
        className={INPUT}
        value={value}
        placeholder={node.placeholder}
        disabled={node.disabled}
        onChange={(e) => ctx.setValue(name, e.target.value)}
      />
    </ControlShell>
  );
}

function Password({ node }: { node: UiNode }) {
  const ctx = useCtx();
  const name = node.name;
  if (!name) return <TextNode node={node} />;
  const value = String(getValue(ctx, name) ?? '');
  return (
    <ControlShell node={node} hint={node.text}>
      <input
        type="password"
        className={INPUT}
        value={value}
        placeholder={node.placeholder}
        disabled={node.disabled}
        onChange={(e) => ctx.setValue(name, e.target.value)}
      />
    </ControlShell>
  );
}

function NumberInput({ node }: { node: UiNode }) {
  const ctx = useCtx();
  const name = node.name;
  if (!name) return <TextNode node={node} />;
  const value = String(getValue(ctx, name) ?? '');
  return (
    <ControlShell node={node} hint={node.text}>
      <input
        type="number"
        className={INPUT}
        value={value}
        placeholder={node.placeholder}
        disabled={node.disabled}
        min={node.min}
        max={node.max}
        step={node.step}
        onChange={(e) => ctx.setValue(name, e.target.value)}
      />
    </ControlShell>
  );
}

function DateInput({ node }: { node: UiNode }) {
  const ctx = useCtx();
  const name = node.name;
  if (!name) return <TextNode node={node} />;
  const value = String(getValue(ctx, name) ?? '');
  return (
    <ControlShell node={node} hint={node.text}>
      <input
        type="date"
        className={INPUT}
        value={value}
        disabled={node.disabled}
        onChange={(e) => ctx.setValue(name, e.target.value)}
      />
    </ControlShell>
  );
}

function TextArea({ node }: { node: UiNode }) {
  const ctx = useCtx();
  const name = node.name;
  if (!name) return <TextNode node={node} />;
  const value = String(getValue(ctx, name) ?? '');
  return (
    <ControlShell node={node} hint={node.text}>
      <textarea
        className={`${INPUT} min-h-[54px] resize-y`}
        value={value}
        placeholder={node.placeholder}
        disabled={node.disabled}
        onChange={(e) => ctx.setValue(name, e.target.value)}
      />
    </ControlShell>
  );
}

function Toggle({ node }: { node: UiNode }) {
  const ctx = useCtx();
  const name = node.name;
  if (!name) return <TextNode node={node} />;
  const on = Boolean(getValue(ctx, name));
  return (
    <ControlShell node={node} hint={node.text}>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        disabled={node.disabled}
        onClick={() => ctx.setValue(name, !on)}
        className={[
          'flex h-[18px] w-[32px] items-center rounded-full p-[2px] transition disabled:opacity-50',
          on ? 'bg-accent' : 'bg-white/15 dark:bg-neutral-900/15',
        ].join(' ')}
      >
        <span
          className={[
            'h-[14px] w-[14px] rounded-full bg-white shadow transition-transform',
            on ? 'translate-x-[14px]' : 'translate-x-0',
          ].join(' ')}
        />
      </button>
    </ControlShell>
  );
}

function Slider({ node }: { node: UiNode }) {
  const ctx = useCtx();
  const name = node.name;
  if (!name) return <TextNode node={node} />;
  const value = Number(getValue(ctx, name) ?? node.default ?? 0);
  const min = node.min ?? 0;
  const max = node.max ?? 100;
  return (
    <ControlShell node={node} hint={node.text}>
      <div className="flex items-center gap-2">
        <input
          type="range"
          className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-white/15 dark:bg-neutral-900/15"
          style={{ accentColor: 'rgb(var(--spirit-accent-rgb))' }}
          min={min}
          max={max}
          step={node.step ?? 1}
          value={value}
          disabled={node.disabled}
          onChange={(e) => ctx.setValue(name, Number(e.target.value))}
        />
        <span className={`w-8 shrink-0 text-right text-[11.5px] font-semibold tabular-nums ${TONE_STYLES.accent}`}>
          {value}
        </span>
      </div>
    </ControlShell>
  );
}

const optionEntries = (node: UiNode): Array<{ label: string; value: unknown }> =>
  (node.options ?? []).map((o, i) =>
    typeof o === 'string'
      ? { label: o, value: i }
      : { label: o?.label ?? '', value: o?.value !== undefined ? o.value : i },
  );

function Select({ node }: { node: UiNode }) {
  const ctx = useCtx();
  const name = node.name;
  if (!name) return <TextNode node={node} />;
  const value = String(getValue(ctx, name) ?? '');
  return (
    <ControlShell node={node} hint={node.text}>
      <select
        className={`${INPUT} appearance-none`}
        value={value}
        disabled={node.disabled}
        onChange={(e) => ctx.setValue(name, e.target.value)}
      >
        {!node.required && <option value="" />}
        {optionEntries(node).map((o, i) => (
          <option key={i} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
    </ControlShell>
  );
}

function Radio({ node }: { node: UiNode }) {
  const ctx = useCtx();
  const name = node.name;
  if (!name) return <TextNode node={node} />;
  const value = String(getValue(ctx, name) ?? '');
  return (
    <ControlShell node={node} hint={node.text}>
      <div className="space-y-1">
        {optionEntries(node).map((o, i) => (
          <label key={i} className="flex cursor-pointer items-center gap-1.5">
            <input
              type="radio"
              className="h-3.5 w-3.5 accent-accent"
              name={name}
              checked={value === String(o.value)}
              disabled={node.disabled}
              onChange={() => ctx.setValue(name, o.value)}
            />
            <span className={`${TEXT} text-[12px]`}><LatexInline text={o.label} /></span>
          </label>
        ))}
      </div>
    </ControlShell>
  );
}

function Checkbox({ node }: { node: UiNode }) {
  const ctx = useCtx();
  const name = node.name;
  if (!name) return <TextNode node={node} />;
  const on = Boolean(getValue(ctx, name));
  return (
    <ControlShell node={node} hint={node.text}>
      <label className="flex cursor-pointer items-center gap-1.5">
        <input
          type="checkbox"
          className="h-3.5 w-3.5 accent-accent"
          checked={on}
          disabled={node.disabled}
          onChange={(e) => ctx.setValue(name, e.target.checked)}
        />
        <span className={`${TEXT} text-[12px]`}><LatexInline text={node.label ?? node.text ?? ''} /></span>
      </label>
    </ControlShell>
  );
}

function Multiselect({ node }: { node: UiNode }) {
  const ctx = useCtx();
  const name = node.name;
  if (!name) return <TextNode node={node} />;
  const current = (getValue(ctx, name) ?? []) as unknown[];
  const toggle = (v: unknown) => {
    const set = new Set(current.map((c) => String(c)));
    const key = String(v);
    if (set.has(key)) set.delete(key);
    else set.add(key);
    ctx.setValue(name, [...set]);
  };
  return (
    <ControlShell node={node} hint={node.text}>
      <div className="space-y-1">
        {optionEntries(node).map((o, i) => (
          <label key={i} className="flex cursor-pointer items-center gap-1.5">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-accent"
              checked={current.map((c) => String(c)).includes(String(o.value))}
              disabled={node.disabled}
              onChange={() => toggle(o.value)}
            />
            <span className={`${TEXT} text-[12px]`}><LatexInline text={o.label} /></span>
          </label>
        ))}
      </div>
    </ControlShell>
  );
}

function Button({ node }: { node: UiNode }) {
  const ctx = useCtx();
  const action = node.action || 'send';
  const label = node.label ?? node.text ?? 'OK';
  const onClick = () => {
    if (action === 'reset') {
      ctx.reset();
      return;
    }
    const payload = interpolate(node.prompt ?? node.text ?? label, ctx.values);
    if (action === 'copy') {
      ctx.copy(payload);
      return;
    }
    ctx.submit(payload);
  };
  return (
    <button
      type="button"
      disabled={node.disabled}
      onClick={onClick}
      className={[
        'inline-flex items-center gap-1 rounded-full px-3 py-1 text-[12px] font-medium transition disabled:opacity-50',
        shade(node.variant, BTN_STYLES, BTN_STYLES.neutral),
      ].join(' ')}
    >
      {node.icon && <span>{node.icon}</span>}
      <LatexInline text={label} />
    </button>
  );
}
