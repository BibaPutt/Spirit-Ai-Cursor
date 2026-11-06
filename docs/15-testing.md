# 15 — Testing (`tests/*`)

Vitest. Run with `npm test` from `spirit/`. Focus is **unit tests on pure
logic** — parsers, scoring, prompting, voice commands, and memory — not
end-to-end UI.

## Test files

| File | Covers |
| --- | --- |
| `contextMemory.test.ts` | The memory engine (37 tests): `getBm25Params`, `normalizeBm25`, `scoreMemory`, `recallMemories`, `splitRememberSection`, `rememberTakeaways` (add / update / delete / link / dedupe), `parseExtractionReply`, `withMemoryBlock` / `stripMemoryBlock`, `compressOldMemories`, load/save store round-trips. **The most important suite** — any change to `electron/memory/contextMemory.ts` must keep it green. |
| `chips.test.ts` | Suggestion-chip parsing/validation: `parseChipSuggestions`, `normalizeIconName`, `parseNextActionsFromAnswer`, `SAFETY_MARKER` rejection, `cacheKeyFor`. |
| `split.test.ts` | `splitGoal` tokenization (used by the scene goal scoring). |
| `voiceCommands.test.ts` | `matchVoiceCommand`, `isStopUtterance`, `effectiveVoiceLang` across the supported languages. |
| `tts.test.ts` | `synthesizeSpeech` result shape / error handling. |
| `textToolCalls.test.ts` | Tool-call text parsing (text-protocol tool calls in chat-completion mode). |
| `routerInteraction.test.ts` | Router/provider interaction (chain resolution, stream handlers, retry/error behavior). |
| `richPaste.test.ts` | `read_table` / `paste_table` (HTML/RTF table → CSV round-trips). |
| `sceneMenu.test.ts` | `buildClickTargetsMenu` / `goalTokens` / `goalScoreFor` ranking. |
| `sanitize.test.ts` | `sanitizeSchemas` output. |
| `activeTab.test.ts` | `reconcileActiveTab` / `isHostLikeLabel` tab-title logic. |

## Running

| Command | Purpose |
| --- | --- |
| `npm test` | Run the whole suite once. |
| `npm test -- <file>` | Run a single suite. |
| `npx vitest run tests/contextMemory.test.ts` | Run just the memory suite. |

## Conventions
- New pure logic → add a Vitest file under `tests/`.
- Test the **contract**, not the internals: e.g. memory tests assert on
  parsed takeaways / BM25 ordering, not on implementation constants.
- Keep `contextMemory.test.ts` in lockstep with `contextMemory.ts` — it is
  the regression net for the mem0-style port.
- `npm run typecheck` must stay clean alongside tests.

Full suite status: **140/140 passing** (as of the docs snapshot).

## Evaluation harness (`tests/eval-*.test.ts`, `tests/latency-probe.test.ts`)

Component-level paper evaluation. All suites call real production functions
(no mocks of the unit under test) and print result tables to stdout.
Run: `npx vitest run tests/eval-ocr-real.test.ts tests/eval-memory-real.test.ts tests/latency-probe.test.ts tests/eval-grounding-real.test.ts tests/eval-e2e-real.test.ts tests/eval-perception-real.test.ts tests/eval-input-real.test.ts tests/eval-memory-verifier-real.test.ts tests/eval-provider-real.test.ts`.

| File | Measures (EXP) | Headline result (env-dependent, re-run to refresh) |
| --- | --- | --- |
| `eval-ocr-real.test.ts` | EXP-8 OCR WER/CER, real tesseract via `getTesseractPath()` | 6/6 CER/WER 0.000, mean ~136ms (clean renders, best-case) |
| `eval-grounding-real.test.ts` | EXP-1 grounding hit% (61 targets, real nearSnap/anchorSnap/refine) | raw 67.2% → pipe 83.6%, 10 named misses |
| `eval-memory-real.test.ts` | EXP-9 memory P@k/R@k (50 facts + 10 distractors, 30 queries) | P@1 0.633 / R@3 0.733 |
| `eval-e2e-real.test.ts` | EXP-2 task harness (40 tasks as data, 36 headless-runnable) | 33/36 = 91.7%, 4 honest skips (live-OS) |
| `eval-perception-real.test.ts` | EXP-3 uia-only vs ocr-only vs both | both 85.4% vs 61.5% vs 44.8% |
| `eval-input-real.test.ts` | EXP-4 input planning, no physical input | 15/20 planned, 25% fallback, 20% fg-escalation |
| `eval-memory-verifier-real.test.ts` | EXP-5+6 memory/verifier ON-OFF + loop guards | mem Δ +0.538 P@1; verifier P 1.000/R 0.750; loops 8/8, wasted 96→66 |
| `eval-provider-real.test.ts` | EXP-7+10 fallback chain + token/cost model, no paid calls | 8×4096 = 32768 max; cloud formula-only |
| `latency-probe.test.ts` | EXP-7 pure-stage wall-clock (N=100) | stages <1ms except menu ~0.6-0.9ms |

Honestly unmeasured (needs live OS / display / keys / paid APIs): GDI
screenshot capture, UIA tree walk on real apps, physical click/type,
live LLM rounds, cloud model runs. State these in paper Threats.
