# 31 — Spirit Mind (memory architecture)

High-quality memory = SPIRIT's existing local memory (contextMemory.ts: mem0-style
takeaways + BM25 recall) plus session compaction, per-context working notes,
dismissal memory, and prewarm.

## Layers

| Layer | What | Storage | Source module |
|---|---|---|---|
| **L0 Turns** | raw session transcripts | `~/Spirit/mind/sessions/*.json` + HTML render | existing `sessions.ts` |
| **L1 Facts** | takeaways extracted per answer ("Key takeaways:") | `~/Spirit/mind/facts.jsonl` | existing `contextMemory.ts` (BM25, dedupe by sha256, recency) — **kept as-is** |
| **L2 Briefs** | rolling per-session summaries; raw turns beyond K compacted into a brief | `~/Spirit/mind/briefs/<sessionId>.md` | new `memory/compaction.ts` |
| **L3 Journal** | dated per-domain notes the spirit keeps about recurring contexts (per project folder, per app, per binding) | `~/Spirit/mind/journal/<domain>/<date>.md` | new `memory/journal.ts` |
| **L4 Social** | dismissal memory ("never whisper about X"), habits (apps/hours used), taste | `~/Spirit/mind/social.json` | new `memory/social.ts` |

## Prompt assembly (the part that makes it feel smart)

For every turn, context block =
1. **Brief** of this session (L2, if exists) — "so far in this conversation…"
2. **Top-K facts** (L1 BM25 vs current query, min score)
3. **Journal notes** for the detected domain (foreground app / bound project folder) — max 5, most recent first, decayed
4. **Social signals** (L4): suppressed topics, preferred styles — as soft instructions ("the user has dismissed invoice whispers 3 times; do not mention invoices")

Token budget: brief ≤300, facts ≤600, journal ≤500, social ≤100. Overflow → brief wins, then facts by score.

## Compaction policy (L2)

- Trigger: session turns > 12 or estimated tokens > 3000.
- Method: one LLM call summarizes turns [0..N-K] into a standing brief (bulleted, factual, no dialogue).
- Brief is **append-merged**: new compaction summarizes (old brief + turns since last compaction) — the session never loses its thread.
- Raw turns are never deleted (L0 stays on disk); compaction only changes what enters the prompt.
- Frequency cap: at most 1 compaction per 6 turns; skipped when provider is mid-stream.

## Journal (L3) — the working-notes pattern

- Domains detected automatically: foreground app (e.g. `app/vscode`), project folder (if an Errand is running → its `NOTES.md` is the journal), bound app (e.g. `binding/gmail`).
- Write rule: after notable turns, the model may append a dated one-liner via a `[journal]` marker (same zero-extra-call trick as L1 takeaways).
- Decay: entries lose rank with age unless re-accessed (access bumps rank); consolidation pass weekly merges same-domain notes >30 days old into one summary entry.
- Errand folders keep their own `NOTES.md` — the journal NEVER duplicates what a folder already remembers; it links to it.

## Social memory (L4) — the anti-nag brain

- Record: every whisper dismissal with topic vector (app + content tags), every "never about this".
- Rules: 2 dismissals of a topic → halve whisper priority; explicit "never" → hard suppress; morning greeting suppressed if dismissed twice in a row.
- Also learns positives: which whisper types got acted on → priority boost.
- Exposed in Mind panel as "What the spirit believes about you" — editable, deletable, exportable.

## Mind panel (UI)

Settings tab "Mind": four columns — Facts (searchable), Journal (by domain/date), Briefs (per session), Social (beliefs + suppressions). Every item: view / edit / forget. "Forget everything about <domain>" one-click. All storage plain JSON/MD under `~/Spirit/mind/` — nothing hidden.

## Sequencing

1. L2 compaction + prompt assembly (pure TS, port with llm chain) — biggest perceived-intelligence win
2. Mind panel read-only view
3. L4 social memory (needed by Whispers)
4. L3 journal + consolidation pass
