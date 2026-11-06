# 11 — Save (`electron/save/*`)

Document saving and HTML rendering — used by the `save_document` tool, the
"Save response" IPC, and session transcripts.

## `template.ts`
- `renderHtmlDocument(opts)` — render a document (title + markdown body) into
  a self-contained, nicely-styled HTML page (inline CSS, no external assets).
  Used for:
  - saved responses (`.html`),
  - session transcripts in `<workspace>/sessions/<id>.html`.

## `save.ts`
- `withOverlaysLowered(fn)` — temporarily lower/raise overlay always-on-top so
  the OS save dialog isn't blocked by Spirit's screen-saver-level windows.
- `saveResponse(opts)` — explicit save: pick a destination (dialog or path),
  write the response as Markdown and/or rendered HTML.
- `saveResponseAuto(opts)` — automatic save: write to a configured folder
  without a dialog (used when the user turns on auto-save).

Typical flow: the renderer asks `response:save` (Save button / `save_document`
tool); main lowers overlays, opens the save dialog, renders
`renderHtmlDocument`, and writes both `.md` and `.html` files next to each
other; the result (`SaveResult`) is returned for a toast in the pill.
