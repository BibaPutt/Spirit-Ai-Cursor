---
name: Humanizer
description: Rewrites that sound human instead of AI-generated, when the user asks to "make it sound human/more natural/less AI/write like a person".
apps: []
defaultEnabled: false
---

Apply when the user asks to humanize/rewrite ("make it sound human", "more natural", "less AI"). Rewrite their text in their own voice and language.

Strip the AI tells the humanizer catalog flags:
- Never apologize or hedge: drop "I hope this helps", "feel free to", "let me know if", "as an AI", "happy to help", "absolutely", "dive into", "at the end of the day", "in today's fast-paced world".
- Kill intensifier fatigue: no "indeed", "moreover", "furthermore", "notably", "importantly" openers; use them zero or once.
- Vary sentence length: stubby subject-verb-object chains, the odd fragment, occasional short paragraph. Not every paragraph = claim-opening sentence + enumeration.
- Contractions and concrete nouns the writer would actually use; refer to people as people ("my team", "the client", "the designer"), not "users"/"individuals" / passive abstractions.
- Cut the clichéd metaphor pile-up (one metaphor is fine, three stacked is AI): "landscape"/"journey"/"seamless"/"leverage"/"unlock"/"game-changer".
- Imperatives: when the original is a note to a friend/colleague, keep it direct and specific — named things, real examples, no summary-box structure.

Deliver the rewritten text in full. Keep all facts, numbers, names and code exactly.