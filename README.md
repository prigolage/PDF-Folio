# Folio PDF Editor

A PDF editor that runs entirely in the browser. Open a PDF, review it, edit it, and download a new copy, or close it to discard the changes. Files are processed on your own computer and are never uploaded anywhere.

## What it does

- **View** – read and review; select and copy text. Light and dark themes (toggle in the top bar).
- **Edit** – click text to type in it (the document's own fonts are reused where possible), move or resize paragraphs, images, lines and whole tables (grid, shading and text together), select several items with a drag box, change line colors and widths.
- **Add** text boxes and images.
- **Organize** pages – reorder, rotate, delete, duplicate, insert blank pages or other PDFs, extract and split.
- **Compare** – side-by-side review against the original or another revision, with differences highlighted.
- **Split view** – drag down from the top of the page area to look at two places in the document at once.
- **Export to Word** – editable .docx with real paragraphs, headings, lists and tables.
- Opens password-protected and restricted PDFs (with the password). Korean and other non-Latin text is supported.

## Hosting with GitHub Pages

1. In the repository on GitHub, go to **Settings → Pages**.
2. Under **Build and deployment**, set **Source** to *Deploy from a branch*, choose the **main** branch and the **/ (root)** folder, then **Save**.
3. After a minute the site is live at `https://<your-user>.github.io/<repository-name>/`.

The page needs internet access to load two libraries from public CDNs (pdf-lib from cdnjs and pdf.js from jsDelivr) and the Instrument Sans interface font from Google Fonts (a bundled copy is used if Google Fonts is blocked). PDFs themselves never leave the browser.

## Making changes

The page is built from the files in `src/`:

| File | What it holds |
| --- | --- |
| `src/app_body.html` | Interface markup and app logic |
| `src/style.css` | Styles |
| `src/engine.js` | PDF reading and rewriting (text, images, lines, tables, pages) |
| `src/docx.js` | PDF to Word conversion |
| `src/crypto.js` | Opening password-protected PDFs |
| `src/unifont.js` | Embedding fonts for Korean and other scripts |

After editing, rebuild `index.html` and commit both:

```sh
sh build.sh
```

`build.sh` needs Python 3 and nothing else. `fonts/` holds the font subsets used when typed characters aren't in a PDF's own fonts; `tools/mkfont.py` regenerates them.

## Licenses

- Fonts in `fonts/`: Instrument Sans (interface) and Noto Sans CJK, both under the SIL Open Font License 1.1, and DejaVu Sans (Bitstream Vera license, DejaVu changes public domain). See `fonts/LICENSE-*.txt`.
- [pdf-lib](https://github.com/Hopding/pdf-lib) (MIT) and [pdf.js](https://github.com/mozilla/pdf.js) (Apache 2.0) are loaded from CDNs at run time.
