---
name: generate-promo
description: Render the Chrome Web Store promo screenshots (1280×800) for Catsnip from the HTML scenes in promo/. Use when the user wants to (re)generate listing screenshots/tiles, or after editing a promo scene or the branding.
---

# Generate the Web Store promo screenshots

Catsnip's listing screenshots are **rendered from HTML**, not captured by hand — so they're
crisp, on-brand, and reproducible. Each scene in `promo/*.html` is a self-contained 1280×800
page styled by `promo/promo.css`; `promo/shoot.sh` renders each to a PNG with headless Chrome.

## Run it

```bash
./promo/shoot.sh
```

- Output: `dist/promo/screenshot-01.png` … `screenshot-05.png`, each exactly **1280×800**
  (the Chrome Web Store screenshot size).
- Requires Google Chrome at `/Applications/Google Chrome.app/...` (override with `CHROME=...`).
- Uses a throwaway `--user-data-dir`, so it never touches your real Chrome profile. Each render
  runs in the background and is killed once its PNG is written (headless `--screenshot` doesn't
  reliably self-exit, and stock macOS has no `timeout` binary).
- `dist/` is gitignored — upload the PNGs to the Web Store; they aren't committed.

## The scenes

| File | Tile |
| --- | --- |
| `promo/01-region.html` | "Snip any region in a drag" — page with the selection marquee. |
| `promo/02-annotate.html` | "Mark it up in seconds" — editor with arrow/box/text/highlight/blur. |
| `promo/03-frame.html` | "Make it look great" — a snip on a gradient background frame. |
| `promo/04-grabtext.html` | "Grab text off any image" — text selected on the image. |
| `promo/05-desktop.html` | "Capture anything — even outside the browser" — desktop/app capture. |

## Editing

- Shared look (brand gradient, window chrome, mock page, annotation styles) lives in
  `promo/promo.css`. The indigo gradient matches the extension icon (`icons/gen_icons.py`).
- Each scene is plain HTML using those classes; tweak copy/layout there and re-run `shoot.sh`.
- Review a result by opening the PNG (e.g. the editor preview) — iterate scene → render → look.
- Keep headlines short and high-contrast; the store crops/realigns thumbnails, so keep the key
  visual centered.
