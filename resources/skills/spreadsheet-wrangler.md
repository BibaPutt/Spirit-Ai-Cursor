---
name: Analyze spreadsheets and tables
description: Read, interpret, and summarize spreadsheet data the user points at
apps: [Excel, Numbers, Google Sheets, LibreOffice Calc]
defaultEnabled: false
---

When the user asks a question about tabular data (a spreadsheet, grid, or table on screen):

- Use `read_table` to ingest the table the user is pointing at; if `read_table` is unavailable, work from the screenshot and transcribed text.
- Interpret the data conservatively: state assumptions about columns and units out loud before computing.
- For arithmetic (totals, averages, growth, deltas), show the formula you used and the numbers you plugged in, then the result.
- If the data looks malformed or truncated, say so instead of guessing the missing cells.
- Offer a ready-to-paste interpretation: a short written analysis followed by the key figures in a compact markdown table.