# Annotation Cheat-Sheet — POINT / BOX / ARROW screen protocol

Reference for the screen-annotation protocol: how the model marks up UI/points of
interest, how the app resolves and maps them, and the friendly "guided tour"
phrasing used for walkthroughs.

## Tag reference

Emitting model places INLINE tags next to prose that mentions an on-screen element.
Tags are stripped from what the user reads (final answers, TTS, history, live view).

| Tag | Meaning | Example |
| --- | --- | --- |
| `[POINT:x,y:label]` | a spot: dot, pixel, tiny icon | `[POINT:1120,24:settings gear]` |
| `[BOX:x,y,w,h:label]` | a region/panel/formula | `[BOX:240,180,420,120:accounts panel]` |
| `[BOX:el#:label]` | a REAL element frame from ui_read/see_screen (resolved to exact bounds) | `[BOX:el3:Save button]` |
| `[ARROW:x1,y1:x2,y2:label]` | a relation/movement from→to (label optional) | `[ARROW:90,310:290,310:this way]` |

**Tolerances (parsers are lenient on purpose):**
- Labels may contain colons, spaces, most punctuation — parsing reads to the closing `]`.
- The trailing `:screenN` suffix is **optional** (defaults to `screen0`); it only
  matters when multiple screenshots are attached. `screen0` is always the image
  currently attached to the conversation.
- Coordinates are **image pixels** of the attached image (screenshot, pasted UI
  mock, or diagram). The screenshot is a DOWNSCALED copy of a larger screen —
  write IMAGE pixels, never screen pixels. `electron/llm/point.ts` maps to
  absolute screen DIPs via `PointGeo` (negative results clamped to the display
  start); the renderer receives display-*local* coords. `±8px` is fine — the
  cursor flies and a pulsing ring lands the point.
- **Out-of-bounds tags are dropped, not drifted**: a POINT/BOX/ARROW whose
  coordinates fall more than ~5% outside the attached image's pixel bounds is
  logged `[annotate] … OOB` and discarded instead of being guessed onto the
  screen (a screen-pixel number written into a 1280×720 image would otherwise
  land 500px off). Copy the log line from DevTools when a pointer looks wrong.
- **Named tags are SNAPPED to the real element**: if a POINT/BOX label names an
  element from the most recent `ui_read`/`see_screen` scene, the app snaps the
  tag to that element's TRUE center/bounds (`electron/llm/annotation-snap.ts`)
  — a name beats measured pixels. `matchElementByLabel` prefers an exact-normalized
  match, else best substring both directions, min label length 3.
- Tags are auto-numbered in story order (1, 2, 3…) on the overlay so the user and
  the model can refer back ("the box labeled 2").

## Element ids (el#)

`ui_read()`/`see_screen()` produce a numbered element map (ids like `el3f9a2b1c`,
aliases `el0..elN`). `[BOX:el#:label]` and `ui_click("el#")` resolve to the element's
TRUE bounds/center from the last accessibility scene (`electron/llm/scene-cache.ts`;
cleared per submit). Element ids rot when the screen changes — re-read
(ui_read/see_screen) before acting on a stale id, never guess pixels when a
numbered element matches.

## Teacher-style tours: Mode A vs Mode B

The model teaches TWO ways, picked by what the user asked:

- **Mode A — teach the screen, one smooth narration** ("explain this screen",
  "what does this toolbar do", chemistry/mechanism questions, pasted diagrams):
  ONE fact per step, causal order, each step's sentence carrying its own tag —
  "the electron leaves this bond [POINT:…:electron] because the base pulls here
  [POINT:…] — the new line [ARROW:…→…:new bond] is what formed."
- **Mode B — guided hands-on task** ("show me how to X" in Figma/AE/DaVinci/
  Premiere/Photoshop/Blender): ONE action per answer, then STOP and wait for
  "continue". On the next turn Spirit RE-READS the screen fresh before the next
  DISTINCT step, never repeats a covered element, and ends with one short
  handoff sentence. Manual steps (drag/slider/typing) use POINT+POINT+ARROW or
  a BOX plus a "when it looks right, say continue" cue.

Both modes: the numbered chip label is the step's ACTION summary read off the
screen ("1 · Click Add modifier"), while the model's sentence carries the "why",
and every step is backed by a look-for cue so the user can confirm it landed.

## Friendly "guided tour" phrasing

For tours / explanations / tutorials: name things conversationally, tag right
after the mention, and let the chips do the pointing:

- "That little gear right up in the top-right corner [POINT:1120,24:settings gear] opens your preferences."
- "See this blue panel [BOX:240,180,420,120:accounts panel]? That's where your billing lives."
- "Drag from the filename [POINT:80,310:filename] to the folder [POINT:300,310:target folder] — the arrow [ARROW:90,310:290,310:this way] shows the path."

Shape picker: **ONE thing** → POINT · **a region/panel** → BOX · **a move/relation**
between two spots → ARROW. The same tags annotate pasted UI diagrams and mocks.
The playbook ships as the bundled skill `resources/skills/desktop-tours.md` and is
prompted by default.

## Where everything lives

- Parsing / stripping / masking: `electron/llm/point.ts` (`parseAnnotations`,
  `stripAnnotations`, `maskAnnotationTags` for the live stream, OOB guards
  `isOutOfImageBounds` / `isBoxOutOfImageBounds` / `isArrowOutOfImageBounds`,
  caption helper `annotationImageNote`) — unit-tested.
- Name-snapping for POINT/BOX → element frames: `electron/llm/annotation-snap.ts`
  (`matchElementByLabel`).
- Element scene + numbered map: `electron/capture/scene.ts` (`buildScene`,
  `formatScene`, `formatQuickElementMap`, `resolveElementById`).
- Scene stash + `[BOX:el#]` frame resolution: `electron/llm/scene-cache.ts`.
- Overlay rendering: `renderer/components/ScreenAnnotations.tsx` (boxes/arrows/
  numbered chips) + `PointCursor.tsx` (fly-to tour).
- Broadcast: `broadcastAnnotations` in `electron/ipc/handlers.ts` (display-local
  coords after subtracting overlay workarea origin).
- Focus discipline: `focus_window` tool → wait → ui_read/see_screen → act by number
  → verify (see `focus-window.ts`, `actions.ts` `focusWindowByTitle`).

## External references (local, not shipped)

- `ref/trycua-cua/libs/cua-driver/rust/Skills/cua-driver/WINDOWS.md` — numbered
  `[N]` element tokens over snapshot-bound AX/UIA, precise centered clicks, and the
  focus contract ("Never fronts / never changes the user's app" → `delivery_mode`).
  (cua-driver itself is MIT — see `THIRD-PARTY-NOTICES.md`.)
- `ref/diagram-design` — diagram TYPE template library (flow, sequence, swimlane,
  architecture, timeline…) plus the bundled `resources/skills/diagram-design.md`
  for [DIAGRAM] blocks.