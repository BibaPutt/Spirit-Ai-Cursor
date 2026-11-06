import { useEffect } from 'react';

// Attaches a copy button to every `pre` inside the given root. The docs
// bodies render from markdown via dangerouslySetInnerHTML, so the buttons
// are added post-render; the root should be the container whose `key`/
// content changes re-run the effect.

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard permission unavailable (older browsers, embedded views) —
    // fall back to a temporary textarea + execCommand.
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function useCodeCopy(rootRef: React.RefObject<HTMLElement | null>, dep: unknown) {  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const pres = root.querySelectorAll<HTMLPreElement>('pre:not([data-copyable])');
    for (const pre of pres) {
      pre.setAttribute('data-copyable', '');
      const wrap = document.createElement('div');
      wrap.className = 'codeblock';
      pre.parentNode?.insertBefore(wrap, pre);
      wrap.appendChild(pre);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'codeblock__copy';
      btn.setAttribute('aria-label', 'Copy code');
      btn.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
      const label = document.createElement('span');
      label.className = 'codeblock__label';
      btn.appendChild(label);
      btn.addEventListener('click', async () => {
        const ok = await copyText(pre.innerText);
        if (!ok) return;
        btn.classList.add('is-done');
        label.textContent = 'Copied';
        window.setTimeout(() => {
          btn.classList.remove('is-done');
          label.textContent = '';
        }, 1400);
      });
      wrap.appendChild(btn);
    }
  }, [rootRef, dep]);
}
