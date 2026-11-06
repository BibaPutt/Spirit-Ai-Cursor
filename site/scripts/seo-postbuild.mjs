import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const siteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.resolve(siteDir, '..', 'website');

const vercelUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL;
const rawBase =
  process.env.SITE_URL ||
  (vercelUrl ? (vercelUrl.startsWith('http') ? vercelUrl : `https://${vercelUrl}`) : '');
const base = rawBase.replace(/\/+$/, '');
const url = (pathname) => `${base}${pathname}`;
const today = new Date().toISOString().slice(0, 10);

for (const file of ['index.html', 'docs.html', 'legal.html', 'dev-docs.html', 'faq.html', 'terms.html', 'privacy.html']) {
  const target = path.join(outDir, file);
  if (!fs.existsSync(target)) continue;
  const html = fs.readFileSync(target, 'utf8').replaceAll('__SITE_URL__', base);
  fs.writeFileSync(target, html);
}

const robots = `User-agent: *
Allow: /

# Answer engines and AI crawlers are welcome.
User-agent: GPTBot
Allow: /

User-agent: OAI-SearchBot
Allow: /

User-agent: ChatGPT-User
Allow: /

User-agent: ClaudeBot
Allow: /

User-agent: anthropic-ai
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: Google-Extended
Allow: /

User-agent: Applebot-Extended
Allow: /

User-agent: CCBot
Allow: /

User-agent: Bytespider
Allow: /

User-agent: cohere-ai
Allow: /
${base ? `\nSitemap: ${url('/sitemap.xml')}\n` : ''}`;
fs.writeFileSync(path.join(outDir, 'robots.txt'), robots);

const sitemapPath = path.join(outDir, 'sitemap.xml');
if (base) {
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${url('/')}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>${url('/docs.html')}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${url('/legal.html')}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>yearly</changefreq>
    <priority>0.5</priority>
  </url>
  <url>
    <loc>${url('/dev-docs.html')}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>
  <url>
    <loc>${url('/faq.html')}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>
  <url>
    <loc>${url('/terms.html')}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>yearly</changefreq>
    <priority>0.4</priority>
  </url>
  <url>
    <loc>${url('/privacy.html')}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>yearly</changefreq>
    <priority>0.4</priority>
  </url>
</urlset>
`;
  fs.writeFileSync(sitemapPath, sitemap);
} else if (fs.existsSync(sitemapPath)) {
  fs.rmSync(sitemapPath);
}

const llms = `# Spirit

> Spirit is a desktop AI companion that answers questions about whatever your cursor is pointing at. Hold a key, ask, and the answer arrives in place.

Spirit is a source-available Electron app under the Business Source License 1.1, free for personal, educational, and internal business use, for Windows, macOS and Linux. It combines screenshot capture, OCR, the accessibility tree, local Whisper voice input and your own model key (OpenAI, Anthropic, Google, OpenRouter or a local OpenAI-compatible endpoint) into one hold-to-ask gesture. Screen reading, OCR and transcription run locally; keys live in an encrypted local store.

## Core pages

- [Home](${url('/')}): Product overview, feature demos, FAQ and download.
- [Manual](${url('/docs.html')}): Install, shortcuts, ghost mode, privacy and license.
- [Terms, Privacy & Credits](${url('/legal.html')}): Full Terms of Service, Privacy Policy, credits and license.
- [Developer documentation](${url('/dev-docs.html')}): How every subsystem works, plain language + code level.
- [FAQ](${url('/faq.html')}): The common questions, answered.
- [Terms of Service](${url('/terms.html')}) and [Privacy Policy](${url('/privacy.html')}): the full legal documents.

## Product facts

- Platforms: Windows 10/11, macOS 13+, Linux (AppImage).
- Price: free for personal, educational, and internal business use. License: BSL-1.1.
- Bring your own model key. Keys stay in the encrypted store.
- Screen reading, OCR and Whisper transcription run locally.
- Answers can click, type, scroll, drag and press keys through the input driver.
- Source: https://github.com/BibaPutt/Spirit-AI-Cursor

## Common questions

- What is Spirit? A desktop AI companion that reads what is under the cursor and answers beside it.
- Does it send my screen anywhere? Only to the model you configure. Nothing is stored on Spirit's side.
- Which models can I use? OpenAI, Anthropic, Google, OpenRouter or a local OpenAI-compatible endpoint.
- Does it work offline? Screen reading, OCR and transcription do. Answers need a model; a local model keeps the whole loop offline.
- What are the system requirements? Windows 10/11, macOS 13+ or a modern Linux desktop, with 4 GB RAM for the app.
- Is it free? Yes, for personal, educational, and internal business use under BSL-1.1. You pay only for the model you choose.

## Optional

- [Source code](https://github.com/BibaPutt/Spirit-AI-Cursor): GitHub repository.
- [Releases](https://github.com/BibaPutt/Spirit-AI-Cursor/releases): Download builds.
`;
fs.writeFileSync(path.join(outDir, 'llms.txt'), llms);

const llmsFull = `# Spirit — full context

Spirit is a desktop AI companion. The product is one gesture: hold a hotkey, ask about whatever is under the cursor, and read the answer in place.

## How it works

1. Spirit captures the region around the pointer.
2. It combines the screenshot, OCR text and the accessibility tree into one scene.
3. The model receives only the context needed for the question.
4. The answer opens beside the cursor, with actions that follow from it.
5. Spirit can click, type, scroll, drag and press keys through the same input driver the app exposes.

## Install

${url('/docs.html#install')}

- Download the build for Windows 10/11, macOS 13+ or Linux.
- On macOS, grant screen-capture permission the first time Spirit reads the cursor area.
- Open Settings and add a model key, or point Spirit at a local OpenAI-compatible endpoint.
- Hold Alt + Space, ask, and release.

Source install:

\`\`\`
git clone https://github.com/BibaPutt/Spirit-AI-Cursor.git
cd Spirit-AI-Cursor
npm install
npm run build
\`\`\`

## Shortcuts

- Alt + Space: open the prompt at the cursor.
- Shift + Alt + Space: open with voice recording armed.
- Esc: close the capsule or cancel a request.
- Ctrl + Enter: send without releasing the hotkey.

## Privacy

API keys live in an encrypted store. Session history and long-term memory stay in local app data. Nothing is uploaded except the capture and prompt sent to the model provider you choose. A local model keeps the entire loop on the machine.

## License

Business Source License 1.1 (BSL-1.1). Free for personal, educational, and internal business use; you may read and modify the source. Commercial redistribution, white-labeling, and hosted/SaaS use require a separate written license. Converts to Apache 2.0 on 2030-11-01. The Bibata cursor artwork is MIT-licensed.

## Links

- Home: ${url('/')}
- Manual: ${url('/docs.html')}
- Terms: ${url('/terms.html')}
- Privacy: ${url('/privacy.html')}
- FAQ: ${url('/faq.html')}
- Developer documentation: ${url('/dev-docs.html')}
- Source: https://github.com/BibaPutt/Spirit-AI-Cursor
- Releases: https://github.com/BibaPutt/Spirit-AI-Cursor/releases
`;
fs.writeFileSync(path.join(outDir, 'llms-full.txt'), llmsFull);
