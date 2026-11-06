// Deterministic relevance gate for prompt engineering. Answers one question —
// "is the incoming question actually about what the model can see (the
// screen)?" — with zero LLM calls. Used only for the FIRST turn of a session.
//
// Why deterministic: the local model (e.g. gemma-4-E2B-it) does not reliably
// follow a "the screen is only context" instruction written into the system
// prompt. So Spirit computes relevance itself and emits an explicit, position-
// aware directive at the question level, where the model is far more likely to
// obey it.
//
// Follow-up turns intentionally send the user's prompt verbatim (no per-turn
// topic/scene notes) so the conversation keeps its natural flow.

import {
  tokenizeSignificant,
  expandSynonyms,
  fuzzyTokenOverlap,
} from './text-tokens';

export type ScreenRelevance = 'related' | 'unrelated' | 'uncertain';

// Deictic words/phrases that unambiguously point at the screen. When present,
// the question is ABOUT the attached context regardless of word overlap
// ("what is this?", "summarize the screenshot", "that highlighted part").
const DEICTIC_RE = /\b(?:this|that|these|those|it)\b|on\s*screen|screenshot|the\s*(?:image|picture|screen)|(?:selected|highlighted|painted|shown|visible|listed|above|below)\b/i;

// Phrasing that explicitly asks for ON-SCREEN annotation or that names the
// thing on screen as the subject ("explain this reaction step by step with
// pointer boxes and arrows"). Present → the screenshot is the subject even if
// no deictic anchor appears, so the relevance gate must not drop it (a blind
// model hallucinates the screen and produces garbage annotations).
export const SCREEN_ANNOTATION_ASK_RE =
  /\b(?:pointer|box|boxes|arrow|arrows|annotate|annotation|annotations|highlighted?|circled?|marked?)\b|(?:this|the)\s+(?:reaction|diagram|figure|image|screenshot|page|equation|mechanism|scheme|structure|chart|graph)\b/i;

export function classifyScreenRelevance(
  prompt: string,
  screenContext: string,
): ScreenRelevance {
  const p = prompt.trim();
  if (!p || !screenContext.trim()) return 'uncertain';
  if (DEICTIC_RE.test(p)) return 'related';

  const q = tokenizeSignificant(p);
  // Too short to judge — keep the context attached (harmless). Two significant
  // tokens is enough to call something unrelated ("capital france" vs a cow
  // farm screen), while single-word prompts stay "uncertain".
  if (q.length < 2) return 'uncertain';

  const docTokens = tokenizeSignificant(screenContext);
  if (docTokens.length === 0) return 'uncertain';
  const docExpanded = new Set(expandSynonyms(docTokens));

  const qExpanded = expandSynonyms(q);
  let shared = 0;
  for (const t of qExpanded) if (docExpanded.has(t)) shared++;
  shared += fuzzyTokenOverlap(q, docTokens);

  return shared > 0 ? 'related' : 'unrelated';
}

// Follow-up topic pivot detector. Answers "is the current question a NEW topic
// compared to what this session is about?" — zero LLM calls, same deterministic
// machinery as classifyScreenRelevance (tokenizeSignificant + synonyms + fuzzy).
//
// Why: small local models (gemma-4-E4B) are primacy/repetition-anchored. After
// a long turn-1 about cows, an unrelated follow-up ("what is a widget") still
// answers cows because the stale first-turn OCR text rides in every request and
// nothing signals that the CURRENT question wins. When a pivot is detected the
// caller masks the stale first-turn context and pins the active question to the
// end of the messages (recency exploit).
//
// Safety defaults: deictic references point at the screen/history, so they are
// always 'same' ("the cows again", "back to that page"). Single-token prompts
// ("ok", "yes") are 'uncertain' — never mask, keep history flowing naturally.
export type TopicPivot = 'same' | 'pivot' | 'uncertain';

export function classifyTopicPivot(
  currentPrompt: string,
  priorTopic: string,
): TopicPivot {
  const p = currentPrompt.trim();
  const prior = priorTopic.trim();
  if (!p || !prior) return 'uncertain';
  // Deictic words point at what was on screen or named earlier — the user
  // WANTS the prior context, so this is never a pivot.
  if (DEICTIC_RE.test(p)) return 'same';

  const q = tokenizeSignificant(p);
  const hasQuestionWord = /\b(?:what|why|how|where|which|who|when)\b/i.test(p);
  // Single-token prompts are normally too ambiguous to call a pivot ("ok",
  // "yes", "continue") — but a question-word probe whose one content token
  // shares nothing with the prior topic ("what is a widget" after a cow
  // session) IS a genuine new topic: mask stale context and pin the question.
  // Everything else stays 'uncertain' — the safe never-mask default.
  if (q.length < 2 && !hasQuestionWord) return 'uncertain';

  const priorTokens = tokenizeSignificant(prior);
  if (priorTokens.length === 0) return 'uncertain';
  const priorExpanded = new Set(expandSynonyms(priorTokens));

  const qExpanded = expandSynonyms(q);
  let shared = 0;
  for (const t of qExpanded) if (priorExpanded.has(t)) shared++;
  shared += fuzzyTokenOverlap(q, priorTokens);

  return shared > 0 ? 'same' : 'pivot';
}
