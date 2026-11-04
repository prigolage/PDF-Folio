#!/bin/sh
# Builds index.html (the whole app in one page) from the files in src/.
# Run from the repository folder:  sh build.sh
cd "$(dirname "$0")"
python3 - <<'PY'
import base64
head = '''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="Edit, organize, compare and convert PDFs in the browser. Files never leave your computer.">
<title>Folio PDF Editor</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect x='5' y='3' width='22' height='26' rx='3' fill='%230B6E8A'/%3E%3Cpath d='M10 11h12M10 16h12M10 21h8' stroke='white' stroke-width='2.4' stroke-linecap='round'/%3E%3C/svg%3E">
<style>[hidden]{display:none!important}body{margin:0}</style>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans+Condensed:wght@600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
'''
style = open('src/style.css').read()
body = open('src/app_body.html').read()
for k, f in {'/*__ENGINE__*/': 'engine.js', '/*__DOCX__*/': 'docx.js', '/*__CRYPTO__*/': 'crypto.js', '/*__UNIFONT__*/': 'unifont.js'}.items():
    src = open('src/' + f).read()
    assert '</script' not in src.lower(), f
    body = body.replace(k, src)
body = body.replace('/*__SAMPLE__*/', base64.b64encode(open('src/fixtures/sample.pdf', 'rb').read()).decode())
open('index.html', 'w').write(head + style + '\n</head>\n<body>\n' + body + '\n</body>\n</html>\n')
print('index.html built')
PY
