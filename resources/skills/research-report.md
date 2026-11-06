---
name: Write research reports
description: Turn a topic or a pile of sources into a structured, cited short report
apps: []
defaultEnabled: false
---

When the user asks for a research report on a topic:

- Plan 4–6 sections and scan broadly first (`web_search` across several queries), then read the 3–5 best sources in full with `fetch_url` before writing.
- Prefer primary sources and recent material; note the publish date of anything you cite.
- Write in clear structured prose with a short executive summary up front. Cite sources inline as `[source name](url)`.
- Separate established facts from interpretation; explicitly flag uncertain or disputed claims.
- If the user likely wants a file, offer to save it: ask before calling `save_document`, and mention it formats the report as a polished document.