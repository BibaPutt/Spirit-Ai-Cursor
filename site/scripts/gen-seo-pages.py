# Generates faq.html / terms.html / privacy.html heads + noscript bodies.
# The React chrome comes from src/*-main.tsx entries; this script only owns
# the static SEO surface (title/description/OG/JSON-LD/noscript), so the
# schema stays in lockstep with the en.json FAQ copy. Re-run after editing
# faq.* keys: python scripts/gen-seo-pages.py
import io
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
d = json.load(io.open(os.path.join(HERE, '..', 'src', 'i18n', 'locales', 'en.json'), encoding='utf-8'))


def head_block(rel, title, desc, og_desc, schema):
    return f'''<!DOCTYPE html>
<html lang="en" data-theme="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>{title}</title>
    <meta name="description" content="{desc}" />
    <meta name="application-name" content="Spirit" />
    <meta name="author" content="Spirit" />
    <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1" />
    <meta name="color-scheme" content="dark light" />
    <meta name="theme-color" content="#08090C" media="(prefers-color-scheme: dark)" />
    <meta name="theme-color" content="#f5f4f2" media="(prefers-color-scheme: light)" />
    <meta name="format-detection" content="telephone=no" />

    <link rel="canonical" href="__SITE_URL__/{rel}" />
    <link rel="alternate" hreflang="x-default" href="__SITE_URL__/{rel}" />
    <link rel="icon" type="image/svg+xml" href="/assets/icon.svg" />
    <link rel="icon" type="image/png" sizes="64x64" href="/assets/favicon.png" />
    <link rel="apple-touch-icon" href="/assets/apple-touch-icon.png" />
    <link rel="manifest" href="/site.webmanifest" />

    <meta property="og:type" content="article" />
    <meta property="og:site_name" content="Spirit" />
    <meta property="og:title" content="{title}" />
    <meta property="og:description" content="{og_desc}" />
    <meta property="og:url" content="__SITE_URL__/{rel}" />
    <meta property="og:image" content="__SITE_URL__/assets/icon.png" />
    <meta property="og:image:width" content="1024" />
    <meta property="og:image:height" content="1024" />
    <meta property="og:image:alt" content="Spirit app icon" />
    <meta property="og:locale" content="en_US" />

    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="{title}" />
    <meta name="twitter:description" content="{og_desc}" />
    <meta name="twitter:image" content="__SITE_URL__/assets/icon.png" />

    <script type="application/ld+json">
      {json.dumps(schema, ensure_ascii=False, indent=6)}
    </script>
  </head>
  <body>
    <div id="root"></div>
    <noscript>
      <main>'''


def tail_block(entry):
    return f'''      </main>
    </noscript>
    <script type="module" src="/src/{entry}"></script>
  </body>
</html>
'''


def org(page_name, rel):
    return {
        "author": {"@type": "Organization", "name": "Spirit", "url": "__SITE_URL__/"},
        "publisher": {
            "@type": "Organization",
            "name": "Spirit",
            "logo": {"@type": "ImageObject", "url": "__SITE_URL__/assets/icon.png"},
        },
        "mainEntityOfPage": f"__SITE_URL__/{rel}",
        "about": {"@id": "__SITE_URL__/#app"},
        "inLanguage": "en",
        "dateModified": "2026-11-06",
        "_page": page_name,
        "_rel": rel,
    }


def strip_meta(org_dict):
    return {k: v for k, v in org_dict.items() if not k.startswith('_')}


def write(name, content):
    io.open(os.path.join(HERE, '..', name), 'w', encoding='utf-8', newline='\n').write(content)
    print('wrote', name)


# ── FAQ ────────────────────────────────────────────────────────────────────
qa = [
    {
        "@type": "Question",
        "name": d[f"faq.{i}.title"],
        "acceptedAnswer": {"@type": "Answer", "text": d[f"faq.{i}.body"]},
    }
    for i in range(14)
    if f"faq.{i}.title" in d
]
faq_org = org("FAQ", "faq.html")
faq_schema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "@id": "__SITE_URL__/faq.html#faq",
    "headline": "Spirit — Frequently Asked Questions",
    **strip_meta(faq_org),
    "mainEntity": qa,
}
faq_nos = "\n" + "".join(
    f"\n        <h2>{d[f'faq.{i}.title']}</h2>\n        <p>{d[f'faq.{i}.body']}</p>\n"
    for i in range(14)
    if f"faq.{i}.title" in d
) + "      "
write('faq.html',
      head_block('faq.html', 'Spirit — Frequently Asked Questions',
                 'Does Spirit send my screen anywhere? Which models can it use? Does it work offline? System requirements, hotkeys, pricing — the common questions about Spirit, answered.',
                 'The common questions about Spirit answered: screen data, models, offline use, requirements, hotkeys and pricing.',
                 faq_schema) + faq_nos + tail_block('faq-main.tsx'))

# ── Terms ──────────────────────────────────────────────────────────────────
terms_org = org("Terms of Service", "terms.html")
terms_schema = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    "@id": "__SITE_URL__/terms.html#page",
    "headline": "Spirit — Terms of Service",
    "description": "Spirit's Terms of Service: license, acceptable use, tool-approval responsibility, AI-output disclaimers and liability.",
    **strip_meta(terms_org),
    "breadcrumb": {
        "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "Spirit", "item": "__SITE_URL__/"},
            {"@type": "ListItem", "position": 2, "name": "Terms of Service", "item": "__SITE_URL__/terms.html"},
        ],
    },
}
terms_nos = '''
        <h1>Spirit — Terms of Service</h1>
        <p>
          Effective November 5, 2026. Spirit is licensed under the Business Source License 1.1;
          a few portions of the code are separately MIT-licensed. You authorize every tool action
          you approve — Spirit can click, type and run commands only with your explicit approval,
          and shell/system actions always prompt. AI-generated answers can be wrong; do not use
          Spirit for medical, legal, financial or safety decisions. The full terms render with
          JavaScript enabled, or read TERMS.md in the repository.
        </p>
      '''
write('terms.html',
      head_block('terms.html', 'Spirit — Terms of Service',
                 "Spirit's Terms of Service: the BUSL-1.1 license, acceptable use, your responsibility for approved tool actions, AI-output disclaimers and liability limits.",
                 'License, acceptable use, tool-approval responsibility, disclaimers and liability.',
                 terms_schema) + terms_nos + tail_block('terms-main.tsx'))

# ── Privacy ────────────────────────────────────────────────────────────────
priv_org = org("Privacy Policy", "privacy.html")
priv_schema = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    "@id": "__SITE_URL__/privacy.html#page",
    "headline": "Spirit — Privacy Policy",
    "description": "Spirit's Privacy Policy: no telemetry, no analytics, no cloud storage. What stays on your machine, what leaves it, and exactly where it goes.",
    **strip_meta(priv_org),
    "breadcrumb": {
        "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "Spirit", "item": "__SITE_URL__/"},
            {"@type": "ListItem", "position": 2, "name": "Privacy Policy", "item": "__SITE_URL__/privacy.html"},
        ],
    },
}
priv_nos = '''
        <h1>Spirit — Privacy Policy</h1>
        <p>
          Effective November 5, 2026. No telemetry, no analytics, no cloud storage. Settings,
          sessions and memory stay in local files on your machine; API keys are encrypted with
          your operating system keychain. Data leaves your computer only when you ask a question
          (prompt + screen context go to the model provider you configured), when you use cloud
          voice transcription, or when a feature fetches a web resource at your direction. There
          is no Spirit server and no account. The full policy renders with JavaScript enabled,
          or read PRIVACY.md in the repository.
        </p>
      '''
write('privacy.html',
      head_block('privacy.html', 'Spirit — Privacy Policy',
                 "Spirit's Privacy Policy in full: no telemetry, no analytics, no cloud. What stays on your machine, what leaves it and where it goes.",
                 'No telemetry, no analytics, no cloud. What stays local, what leaves and where it goes.',
                 priv_schema) + priv_nos + tail_block('privacy-main.tsx'))
