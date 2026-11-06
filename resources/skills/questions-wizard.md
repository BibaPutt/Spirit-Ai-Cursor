---
name: Question wizard
description: When the user asks you a question, a quiz, a test, wants you to choose/decide something, wants a poll or survey, or you need to collect info before acting — ask through a [QUESTIONS] wizard block instead of a bulleted prose list.
defaultEnabled: true
triggers: [question, questions, quiz, test, ask, aske, ask you, ask me, choose, decide, decide for me, poll, survey, options, which one, which option, should i, preference, preferences, questionnaire, rapid fire, Q&A, faq, answer these, gather info, capture, responses]
---

# Question wizard — ask through [QUESTIONS], never prose lists

When the user's intent is to be ASKED things — a quiz, a test, a survey, a poll, a preference capture, a decision prompt, or a form where they answer several questions so you can act — emit ONE `[QUESTIONS]` wizard block as the answer. The app builds the full wizard shell (Next/Back/Skip, "Question 2 of 5", progress bar, confirmation screen, Finish) — you only fill in the questions payload.

- NEVER write questions as a numbered prose list ("1. Budget 2. Usage 3. Team"). NEVER bury the questions in [NEXT_ACTIONS] chips. The wizard is the ONLY correct shape for "ask me things".
- Trigger examples — "ask me a few questions", "quiz me", "questionnaire", "test me", "help me decide", "ask me what I need", "rapid fire", "survey my habits", "which one should I pick".
- One question per item; keep the set tight (1–12). Each `"q"` is a short, clear question IN THE USER'S LANGUAGE. Ask only what you truly need to be able to act.

## Payload format

The `"title"` string must be the VERY FIRST key in the JSON object (the app shows a live tile titled by it while the block streams — it cannot wait for the end of the block):

```
[QUESTIONS]
{"title":"Personality check","questions":[{"q":"…","type":"radio","options":["a","b","c"],"required":true},{"q":"…","type":"text","placeholder":"…"},{"q":"…","type":"slider","min":0,"max":100}]}

[/QUESTIONS]
```

- `"type"` (optional, default text): `radio`, `slider`, `multi` (multi-select checkboxes), `select`, `text`, `textarea`, `number`, `date`, `checkbox`, `toggle`.
- `"options"` (radio/select/multi/checkbox): array of plain strings or `{label, value}` objects.
- `"required": true` marks a must-answer question; `"placeholder"` hints a text/textarea field; `"default"` pre-fills; slider uses `"min"`/`"max"`/`"step"`.
- Use the right control shape for the question: radio for exclusive choice, multi/checkbox for multi-select, slider for a scale/rank, text/textarea for short/long answers, date for dates, number for quantities.

## Continuation contract (critical)

The user answers through the wizard UI and the app submits their answers back to you as a message beginning with "Your answers to the questions you asked:":

- ACT on those answers immediately in THIS response. Never repeat your previous answer and never re-ask the same questions.
- If the questions were a quiz/test/check: grade each answer and present a [UI] scoreboard card — a `stat` for the score (e.g. "Score 3/5") plus a per-question `list`/`kv` showing correct vs incorrect (see the [UI] vocabulary in the data-blocks skill).
- If they were clarifying questions: complete the user's actual request NOW using the collected answers.
- If they were a decision prompt: make the call with the chosen preference.
- Never just acknowledge "Thanks, got it" — the answers exist to finish the job.
- Once answered, do not resurface the wizard for the same question in this conversation.

The `[QUESTIONS]` tags are data and are stripped before the answer is shown — never mention the tags or the payload in prose, never describe what you "put in the wizard", never wrap the block in backticks or extra brackets.