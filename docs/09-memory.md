# 09 — Memory & Sessions (`electron/memory/*`)

Two systems:
- **`contextMemory.ts`** — the long-term **context memory** (a mem0-style
  "add a memory" + BM25 recall engine, fully self-contained, no external
  packages). This is the piece most recently ported/rewritten.
- **`sessions.ts`** — per-conversation **session persistence** (JSON +
  rendered HTML transcripts).

---

## Context memory — `contextMemory.ts`

### Philosophy
Instead of a vector database, Spirit uses a compact, local, dependency-free
scheme inspired by mem0's core loop:

1. After each answer, the assistant emits a `Key takeaways:` section
   (`splitRememberSection`). The app parses it into `ExtractedMemory` items —
   **zero extra LLM calls** for remembering.
2. Memories are stored with a **BM25 text score** so recall is possible
   without embeddings.
3. On a new query, `recallMemories` scores all memories against the query and
   injects the top matches into the system prompt as a RAG block
   (`withMemoryBlock`).
4. The model may emit `[update <id>]` / `[delete <id>]` markers to edit or
   delete memories (`parseExtractionReply`).

### Data model
```ts
type ContextMemoryItem = {
  id: string;
  text: string;
  score: number;          // BM25 text score of the source (persisted)
  createdAt: string;      // ISO timestamp
  updatedAt: string;
  lastAccessAt: string;   // LRU-ish recency signal
  accessCount: number;
  deleted?: boolean;
  source: MemorySource;   // 'ocr' | 'clipboard' | 'selection' | 'paint' | 'app'
  linkedMemoryIds?: string[];  // explicit links from the model
  userId?: string;        // default 'user'
};

type ExtractedMemory = { id?: string; text: string; action: 'add' | 'update' | 'delete'; source: MemorySource; attributedTo?: string };
```

### Key functions

| Function | Purpose |
| --- | --- |
| `isContextMemoryEnabled()` | reads the `contextMemoryEnabled` setting |
| `hashText(text)` | stable SHA-256 hex used for dedupe + ids |
| `getBm25Params(query)` | returns `[k1, b]` tuned per query length |
| `normalizeBm25(raw, max, min)` | scale raw BM25 to 0..1 |
| `scoreMemory(query, memory)` | BM25 similarity of a memory vs the query |
| `recallMemories(query, { limit, minScore })` | top-N memories for RAG |
| `memoryRememberInstruction()` | system-prompt text teaching the format |
| `memoryContextBlock(memories)` | render recalled memories as the RAG block |
| `stripMemoryBlock(content)` | remove the `<!--SPIRIT-MEMORY-->` fenced block |
| `withMemoryBlock(messages, prompt, screenContext)` | inject recall block into the system message |
| `splitRememberSection(text)` | pull out `Key takeaways:` from the answer |
| `parseExtractionReply(raw)` | parse update/delete markers |
| `rememberTakeaways(takeaways, sources)` | apply add/update/delete/link/dedupe |
| `compressOldMemories()` | when over the cap, merge/trim oldest |
| `getAllMemories()` / `clearMemories()` | inspection / reset |

### Flow 1 — Recall (on query)
`handlers.runQuery` calls `withMemoryBlock(messages, prompt, screenContext)`:

```
recallMemories(prompt, { limit, minScore })
  → score every memory with scoreMemory(prompt, m)
  → keep score ≥ minScore, sort by score
  → memoryContextBlock(top) renders:

    <!--SPIRIT-MEMORY-->
    <context_memories> … recalled items … </context_memories>
    <instructions> …use them if relevant; the marker says "nothing recalled"
    if empty; instructions to emit update/delete markers… </instructions>

  → prepended to the system message (with <this is the latest system message>).
```

- Cap: `MAX_MEMORIES = 200`, `COMPRESS_THRESHOLD = 150`, `KEEP_RECENT = 60`,
  default `DEFAULT_RECALL_LIMIT = 4`.
- `stripMemoryBlock` removes the block from the committed system message so
  the persisted session history stays clean of RAG scaffolding.

### Flow 2 — Remember (after each answer)
`handlers` on done/final calls `rememberTakeaways(turnTakeaways, turnSources)`:

1. `splitRememberSection(answer)` finds the trailing `Key takeaways:` section;
   each takeaway line becomes an `add` extraction (default
   `attributedTo: 'user'` — an undefined value would otherwise be dropped by
   JSON serialization, which broke strict parsing).
2. Each takeaway is checked for a `[update <id>]` / `[delete <id>]` marker
   via `parseExtractionReply` (the model can replace or remove old memories).
3. `rememberTakeaways` applies:
   - **add**: hash-dedupe (exact duplicate text within a similarity threshold
     updates the existing record instead of inserting a new one),
   - **update**: find by id, merge text, bump `updatedAt`,
   - **delete**: mark `deleted: true` (soft delete),
   - **linking**: `linkedMemoryIds` — when a takeaway references prior memory
     ids, both sides get linked (mirrors mem0's `linked_memory_ids`).
4. Persist to `<workspace>/context-memory.json`; if count exceeds
   `COMPRESS_THRESHOLD`, run `compressOldMemories` (trim oldest/lowest-scored,
   keep `KEEP_RECENT` recent ones).

### Storage
- Single JSON file `<workspace>/context-memory.json`:
  `{ memories: ContextMemoryItem[], version: 1 }`.
- Writes are atomic (temp file + rename); a strict loader filters out items
  with missing fields so corrupt/legacy rows never crash the app.
- Source tagging: each memory records where it came from
  (`ocr/clipboard/selection/paint/app`), mirroring mem0's `memory_source`.

### Why BM25 (and why no vector DB)
- Zero dependencies, pure TS, instant on a 200-item store.
- Deterministic and testable — the whole engine is unit-tested in
  `tests/contextMemory.test.ts` (37 tests): BM25 params, recall ordering,
  splitRememberSection, update/delete/link/dedupe, withMemoryBlock /
  stripMemoryBlock, parseExtractionReply, compressOldMemories.

### Self-knowledge: `[personal]` tag + profile auto-fill
- The remember instruction tells the model to prefix identity facts
  (name, role, language, city) with `[personal]` — only genuinely useful
  ones, never repeats of listed memories (changed value = single
  `[update <id>] [personal]` bullet).
- `parseTakeawayBullet` strips the tag into `ExtractedMemory.personal`;
  personal bullets bypass the worth gate (dedup still applies).
- `extractProfileUpdates` reads tagged-first takeaways into
  `{ name, role, preferredLanguage }`; `settings.applyLearnedProfile`
  fills only EMPTY profile fields, never overwrites typed values.
- `prompt.buildUserProfileLine` renders `About the user: ...`, refreshed
  every turn by `withUserProfileLine` (gated on `personalizePrompts`) —
  same system message drives the LLM answer and every CUA tool call.
- Learning surfaces in the UI as a quiet box-bottom line via the
  `learned:hint` channel (`Noted your name`, `Saved 2 memories`).

---

## App lessons — `app-lessons.ts`

Per-app quirk memory (`<userData>/app-lessons.json`): tools record short
facts when something notable happens (false-failing launcher, missed focus);
the submit path injects the CURRENT app's lessons into the system message.
- Reuse weight: each injection bumps `hits`/`lastUsed` (`touchAppLessons`,
  disk write throttled to 1/min); recall orders hits-first.
- Retention: `pruneStaleLessons` drops 0-hit lessons older than 60 days.
- Closed loop: `ui_click` driver failures carrying a verdict `[code]`
  auto-record a `cua:<code>` lesson for the foreground window.

---

## Sessions — `sessions.ts`

Per-conversation state and durable transcripts.

### `ActiveSession`
```ts
type ActiveSession = {
  id: string;                    // newSessionId()
  startedAt: number;
  systemPrompt: string;
  messages: Message[];
  screenshotOcr?: string;
  clipboard?: string;
  selection?: string;
  paintTexts?: string[];
  appContext?: string;
  lastActivityAt: number;
};
```
The in-memory "current conversation" lives in `handlers.ts`; messages get
appended per turn and truncated to the token budget.

### Functions
- `ensureSessionsDir()` — create `<workspace>/sessions/`.
- `newSessionId()` — timestamped id.
- `truncateForBudget(messages, maxTokens)` — keep system + latest user/assistant
  turns within the budget (drops oldest middle messages).
- `persistSession(active)` — write `sessions/<id>.json` (machine-readable) and
  `<id>.html` (rendered via `save/template.ts`, see 11-save) when
  `memorySaveEnabled` is on. Returns a `SessionSummary`.
- `loadLatestSessionMarkdown()` — read the newest session back as Markdown
  (the `/lastsession` command).
- `listSessions()` — summaries for the `/history` command.
- `resolveSessionRelativePath(rel)` — safe path resolution (no traversal).
- `clearAllSessions()` — remove all transcripts.
- `shouldPersist()` — settings gate.
- `getMaxContextTokens()` — the context budget used by truncation.

### Flow
- Box opens → `newSessionId()`; context fields populate as captures land.
- Each submit appends the user message; each done appends the assistant answer.
- Box closes / session window expires (`extendSessionWindow`, ~2 min TTL) →
  the session is finalized; if persistence is on, JSON + HTML land in
  `<workspace>/sessions/`.
- `/lastsession` restores the newest transcript into the pill;
  `/history` lists them; Settings → Memory has a "Save session transcripts"
  toggle and a "Clear all" action.

See also [11-save.md](11-save.md) (HTML rendering), [10-store.md](10-store.md)
(settings toggles), [15-testing.md](15-testing.md) (the 37-test memory suite).
