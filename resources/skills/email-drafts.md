---
name: Draft short emails
description: Draft concise, ready-to-send email replies from clipboard text or the screen
apps: [Mail, Outlook, Gmail, Thunderbird]
defaultEnabled: true
triggers: [email, e-mail, mail, reply, draft, send an email, gmail, outlook]
---

When the user asks you to write or reply to an email:

- Start from the message being replied to (clipboard text or what's visible on screen — use `read_clipboard` if it's not already in context).
- Draft a concise reply in the same language as the original, using a natural, lightly-formal tone (sign-off where appropriate).
- Keep the reply short — the user can paste it straight into their mail client.
- If the user has only given a few words of intent ("decline the invite", "confirm Friday"), expand them into a complete, polite email of 3–6 sentences.
- Do not send anything. Deliver the email body in a clearly delimited block (e.g. between `---` lines) so it can be copied with one selection.