---
name: regenerate-icons
description: Regenerate the Snip extension icons (16/32/48/128 px indigo selection marquee). Use when the icon design changed, the icons are missing, or after editing icons/gen_icons.py.
---

# Regenerate the Snip icons

The icons are drawn **procedurally** (no image editor, no dependencies) by a small Python
script using only the standard library.

## Run it

```bash
python3 icons/gen_icons.py
```

- No third-party dependencies (pure `struct`/`zlib`).
- Writes `icons/icon16.png`, `icon32.png`, `icon48.png`, `icon128.png` — the exact sizes
  referenced by `manifest.json` (`action.default_icon` and `icons`).

## Changing the design

Everything is in `icons/gen_icons.py`:
- **Colors** — the constants at the top (`INDIGO`/`INDIGO_DK` background gradient, `WHITE` for
  the marquee + corner handles).
- **Shape** — `snip_pixel(nx, ny)` returns the color for normalized coords (0–1): a solid
  selection rectangle (`m0`/`m1` bounds, `t` thickness) with solid corner handles (`hs`).
- `make(n)` rasterizes at size `n` onto the rounded-square indigo background; `png()` encodes.

After editing, re-run the command and reload the unpacked extension to see the new icons.
Keep the 128px icon recognizable when scaled to 16px (the toolbar size) — that's why the
marquee is solid rather than dashed.
