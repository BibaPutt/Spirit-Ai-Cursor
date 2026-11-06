# Spirit — Terms of Service

**Effective date:** November 5, 2026
**Applies to:** Spirit AI Cursor Companion ("Spirit", "the App") version 2.0.0-alpha.0 and all subsequent releases, on macOS, Windows and Linux.

These Terms of Service ("Terms") are a binding agreement between you and the
licensor of Spirit ("Licensor", "we", "us") governing your use of the App.
By installing, copying or using Spirit you accept these Terms. If you do not
accept them, do not install or use the App.

---

## 1. What Spirit Is

Spirit is an AI-aware cursor companion for the desktop. You hold a hotkey
(the trigger), ask a question, and Spirit answers with awareness of the
context around your cursor: a small screenshot of the region under your
cursor, your clipboard or text selection, the foreground application and, on
request, results of web searches. Spirit can also **act on your computer
through tools** — clicking, typing, scrolling, launching apps, saving
documents, opening URLs and running shell commands — every one of which is
gated behind an explicit approval prompt unless you have configured
otherwise.

Spirit is provided for personal, productivity and assistive use. It is not a
safety-critical product and must not be used where failure could cause
physical harm or significant material damage.

## 2. Eligibility

You must be at least 13 years old (or the minimum digital-consent age in your
jurisdiction, whichever is higher) to use Spirit. If you use Spirit on a
device owned or managed by an employer or school, you are responsible for
ensuring that its use complies with that organisation's policies.

## 3. License

### 3.1 The software license

Spirit is licensed under the **Business Source License 1.1** (BUSL-1.1);
a few portions of the code are separately MIT-licensed. The complete license
text is in the `LICENSE` file that ships with the App and the source
repository. Nothing in these Terms overrides that license; where the license
and these Terms conflict, the license controls for matters of copying,
modification and redistribution.

### 3.2 What you may do

Subject to the license and these Terms you may:

- install and use Spirit on any machine you own or control;
- study, modify and build derivative versions as permitted by the applicable
  license;
- use Spirit privately or commercially as permitted by the Additional Use
  Grant in the license.

### 3.3 What you may not do

You may not:

- use Spirit to violate any applicable law or the rights of any person;
- use Spirit to access, probe or interfere with computer systems you are not
  authorized to access;
- remove, obscure or alter any license, attribution or third-party notice
  included in the App;
- present Spirit or a modified build of it as certified or endorsed by the
  Licensor where it is not;
- use Spirit to develop a product that competes with Spirit, except as the
  license's Change Date and Additional Use Grant expressly allow.

## 4. AI providers, your accounts and your keys

Spirit does not include AI inference. It talks to **AI providers you choose
and configure** — for example OpenRouter, Anthropic, OpenAI, Google Gemini or
any local OpenAI-compatible server — using API keys that belong to you.

- You are responsible for obtaining your own provider accounts and keys, for
  keeping those keys confidential, and for all fees those providers charge
  you.
- Prompts, screenshots and other context that Spirit sends in order to answer
  you are processed by those providers under **their** terms and privacy
  policies, not ours. We do not operate or control them.
- When you use a local/self-hosted provider, inference happens on your own
  hardware and no prompt data leaves your machine through that provider.
- Provider model behaviour, availability, rate limits and pricing can change
  at any time without notice, and answers may stop, degrade or change
  accordingly. That is outside our control.

## 5. Computer control and tool execution — you are the authorizer

This section is important. Spirit can operate your computer.

- Every mutating tool action (clicking, typing, dragging, pressing keys,
  scrolling, launching apps, opening URLs, saving files, running shell
  commands, changing system volume) requires your **explicit approval** in an
  approval prompt before it runs, except actions you have explicitly
  configured to run without per-action approval in Spirit's settings.
- Two tools — `run_command` (shell) and `system_action` — are classified
  **high-impact** and always require approval, even when blanket approvals
  are enabled.
- Read-only actions (reading the screen, OCR, reading the clipboard,
  observing the cursor) may run without prompts; they are what makes Spirit
  able to answer contextually.

**You are solely responsible for the tool actions you approve.** When you
approve an action, you authorize Spirit to perform it on your behalf, on your
machine, with your privileges. Do not approve actions you do not understand.
If Spirit proposes an action that would delete, modify, send or publish
anything, treat it exactly as you would treat the same action performed by a
human assistant sitting at your keyboard.

Spirit is designed never to require you to disable approvals, and we strongly
discourage doing so. You disable or loosen approval gating entirely at your
own risk.

## 6. Acceptable use

You agree not to use Spirit:

- to infringe intellectual property, privacy, publicity or other rights of
  others;
- to create, distribute or act on malicious content — malware, phishing,
  credential theft, spam, harassment, or content that exploits or harms
  minors;
- to automate abuse of any service (rate-limit circumvention, bulk
  unauthorized scraping, account fraud);
- to circumvent security controls, licensing or access restrictions of any
  software or system you do not own or administer;
- in vehicles, medical devices, aviation, emergency services, legal,
  financial or medical decision-making, or any other context where failure
  could endanger people;
- to violate the terms of the AI providers, search engines or websites that
  Spirit interacts with at your direction.

## 7. AI-generated content

Answers produced by Spirit are generated by statistical models. They can be
wrong, incomplete, outdated or misleading, even when they sound confident.
Annotations (points, boxes, arrows) that models draw on your screen can
mis-target. **Do not rely on Spirit for advice where an error could cause
damage** — medical, legal, financial or safety decisions always need a
qualified human. Nothing in Spirit is professional advice.

## 8. Privacy

Spirit's data practices — what stays on your machine, what leaves it and
where it goes — are described in the [Privacy Policy](PRIVACY.md), which is
part of these Terms. In one sentence: **Spirit has no telemetry, no
analytics and no cloud storage; your data lives on your machine and only
goes to AI providers and web services you intentionally involve.**

## 9. Intellectual property

Spirit, its branding, code and documentation are owned by the Licensor and
protected by copyright and other laws, except for the third-party components
listed in `THIRD-PARTY-NOTICES.md` and `CREDITS.md`, which remain the
property of their authors under their own licenses. You keep all rights to
your own content: your prompts, your files and the documents Spirit saves
for you belong to you.

## 10. Disclaimers

Spirit is provided **"as is" and "as available"**, without warranties of any
kind, express or implied, including merchantability, fitness for a particular
purpose and non-infringement, to the maximum extent permitted by law. We do
not warrant that Spirit will be uninterrupted, error-free, that answers will
be accurate, or that the App will be compatible with every application,
display or environment. The full legal disclaimer is in the BUSL-1.1 license
text shipped with the App.

## 11. Limitation of liability

To the maximum extent permitted by law, the Licensor will not be liable for
any indirect, incidental, special, consequential or punitive damages, or any
loss of data, profits, goodwill or business interruption arising from your
use of (or inability to use) Spirit — including damage caused by tool
actions you approved, by AI-generated content you acted on, or by
third-party providers — even if advised of the possibility. The aggregate
liability of the Licensor for all claims is limited to the amount you paid
for Spirit, which is **zero** for the free release. Some jurisdictions do
not allow certain limitations; in those jurisdictions the limitations apply
to the fullest extent the law allows.

## 12. Indemnification

You agree to indemnify and hold harmless the Licensor from claims, damages
and expenses (including reasonable legal fees) arising from your use of
Spirit, your approval of tool actions, your breach of these Terms, or your
violation of any law or third-party right.

## 13. Termination

These Terms apply for as long as you use Spirit. You may terminate at any
time by uninstalling the App. We may restrict or end your access to Spirit —
for example, in a future release that phones home for licenses — if you
materially breach these Terms. Sections that should survive termination
(license conditions, disclaimers, liability limits, indemnity) do survive.

## 14. Changes to these Terms and to Spirit

We may update these Terms as Spirit evolves. The effective date at the top
changes when we do, and material updates are announced in the release notes
or in-app. Continuing to use Spirit after an update means you accept the
updated Terms. Spirit is young software: features, tools, providers and
defaults may change between versions, including in breaking ways during
alpha releases.

## 15. Governing law

These Terms are governed by the laws of the Licensor's principal place of
business, without regard to conflict-of-law rules. The BUSL-1.1 license
governs any dispute about the software license itself.

## 16. Severability and entire agreement

If any provision of these Terms is unenforceable, the rest stay in force.
These Terms, the Privacy Policy and the software license together are the
entire agreement between you and the Licensor about Spirit, replacing any
prior understanding about it.

## 17. Contact

Questions about these Terms can be raised through the channel where you
obtained Spirit (the project repository or the distributor's contact
address).
