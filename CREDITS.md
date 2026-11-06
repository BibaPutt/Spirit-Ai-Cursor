# Spirit — Credits & Acknowledgments

Spirit is built on the shoulders of a lot of people. This page thanks them.
For the legally-complete attribution (full license texts), see
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md), [`LICENSE`](LICENSE) and
[`cursors/LICENSE`](cursors/LICENSE).

---

## Core team

- **Siddhesh Gadekar** — co-creator; core engineering and product.
- **Vansh Jindam** — co-creator; core engineering and product.
- **Arshdeep Singh Bimbh — "Bibaputt"** — co-creator; design, product, and the
  whole Spirit idea: an AI that lives where your cursor is.

## Base project

- **aipointer** by **Mario Simic** — the MIT-licensed base Spirit grew
  from. The MIT text for these portions is preserved in `LICENSE`, Section 2.

## Cursor artwork

- **Bibata** cursor set by **Abdulkaiz Khatri**
  ([ful1e5/bibata](https://github.com/ful1e5/bibata)) — MIT.
  Spirit's cursors are the "Bibata Modern Amber" preset, and the vector
  cursor shapes in the renderer are traced from it.

## Open-source foundations

### Desktop shell

| Project | Authors | License |
|---------|---------|---------|
| Electron | OpenJS Foundation & contributors | MIT |
| electron-builder | Stéphane Goetz & contributors | MIT |
| Tauri (2.x shell experiments) | The Tauri Programme within The Commons Conservancy | MIT/Apache-2.0 |

### UI & rendering

| Project | Authors | License |
|---------|---------|---------|
| React, React DOM | Meta & contributors | MIT |
| Vite | Evan You & Vite contributors | MIT |
| TypeScript | Microsoft | Apache-2.0 |
| Tailwind CSS | Tailwind Labs | MIT |
| framer-motion | Matt Perry & Framer | MIT |
| Radix UI primitives | WorkOS & contributors | MIT |
| Base UI | Base UI contributors | MIT |
| shadcn/ui patterns | shadcn & contributors | MIT |
| lucide-react | Lucide contributors | ISC |
| Tabler Icons | Paweł Kuna & contributors | MIT |
| Geist font (variable) | Vercel | SIL OFL 1.1 |
| tw-animate-css, clsx, tailwind-merge, class-variance-authority | their authors | MIT |

### Answer rendering

| Project | Authors | License |
|---------|---------|---------|
| react-markdown, unified, rehype-* , remark-* | Titus Wormer & contributors | MIT |
| marked | Marked contributors | MIT |
| KaTeX | Khan Academy & contributors | MIT |
| Mermaid | Mermaid contributors | MIT |
| zod | Colin McDonnell | MIT |
| zustand | Poimandres | MIT |
| i18next, react-i18next | i18next contributors | MIT |

### Seeing & acting

| Project | Authors | License |
|---------|---------|---------|
| uiohook-napi | Willy Lam (and libuiohook authors) | MIT |
| sharp | Lovell Fuller & contributors | Apache-2.0 |
| Tesseract OCR | Tesseract contributors | Apache-2.0 |
| faster-whisper (local STT sidecar) | SYSTRAN & contributors | MIT |
| Whisper models | OpenAI | MIT |
| msedge-tts | Contributors (unofficial Microsoft Edge Read Aloud client) | MIT |
| cua-driver (vendored input daemon) | Vendored from its upstream project | see `resources/bin` notice |

### Storage & ideas

| Project | Authors | License |
|---------|---------|---------|
| electron-store | Sindre Sorhus | MIT |
| mem0 | Mem0 contributors — the BM25 context-memory design is a zero-dependency port of its idea | Apache-2.0 |
| franc-min (language detection) | Titus Wormer | MIT |

## Special thanks

- The **Bibata** community for the friendliest cursors on any OS.
- Everyone whose issues, prompts and bug reports shaped the overlay, the
  trigger flow and the tool-approval model.
- The mem0 team — the local context memory is a love letter to the BM25
  "takeaways" idea.
- The Model Context Protocol community — the vendored input daemon speaks
  MCP over stdio.

## Using Spirit's code

Spirit's own code is BUSL-1.1, with the aipointer-derived portions under
MIT — see `LICENSE` for the exact split. Third-party components keep their
own licenses; nothing here overrides them. If we missed an attribution,
tell us through the project repository and we will fix it in the next
release.
