# Extracts section titles + plain intros from src/data/devdocs.ts into
# src/i18n/locales/en.json as doc.<id>.title / doc.<id>.plain, so every
# locale can carry them. Run: python scripts/extract-doc-i18n.py
import io
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
src = io.open(os.path.join(HERE, '..', 'src', 'data', 'devdocs.ts'), encoding='utf-8-sig').read()

ids = re.findall(r"\n    id: '([a-z0-9-]+)'", src)
print('sections:', len(ids))

TOKEN = re.compile(r"[A-Za-z0-9_-]+")


def field(sid, name):
    m = re.search(r"id: '" + sid + r"',(.*?)\n    md:", src, re.S)
    if not m:
        m = re.search(r"id: '" + sid + r"',(.*?)$", src, re.S)
    blk = m.group(1)
    for q in ("'", '"'):
        pat = name + r':\s*' + q + r'((?:[^' + re.escape(q) + r'\\]|\\.)*)' + q
        m2 = re.search(pat, blk)
        if m2:
            return m2.group(1).replace("\\" + q, q).replace('\\n', ' ')
    raise SystemExit(f'cannot extract {name} for {sid}')


p = os.path.join(HERE, '..', 'src', 'i18n', 'locales', 'en.json')
d = json.load(io.open(p, encoding='utf-8'))
for sid in ids:
    d[f'doc.{sid}.title'] = field(sid, 'title')
    d[f'doc.{sid}.plain'] = field(sid, 'plain')
io.open(p, 'w', encoding='utf-8', newline='\n').write(json.dumps(d, ensure_ascii=False, indent=2) + '\n')
print('en doc keys:', sum(1 for k in d if k.startswith('doc.')))
