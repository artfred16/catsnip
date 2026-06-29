---
name: package-extension
description: Package the extension into a Chrome Web Store zip (dist/<name>-v<version>.zip). Use when the user wants to build, package, or zip the extension for upload to the Web Store or for a release. Not for cutting a full GitHub release (use cut-release for that).
---

# Package the extension

Builds a clean, upload-ready zip containing only the runtime files, with `manifest.json`
at the zip root.

## Run it

```bash
./build.sh
```

- Requires `node` on PATH (reads `name` + `version` from `manifest.json`).
- Output: `dist/<name>-v<version>.zip`, where `<name>` is the slugified manifest `name`
  (e.g. `dist/catsnip-v1.0.0.zip`).
- The script **whitelists** the shipping files — `manifest.json`, `background.js`,
  `overlay.*`, `popup.*`, `editor.*`, `lib/jszip.min.js`, `icons/icon*.png`. Dev/build files
  (`build.sh`, `fetch-ocr.sh`, `icons/gen_icons.py`, `README.md`, etc.) are excluded.
- The vendored OCR engine (`lib/tesseract/*`) is **optional**: it's added to the zip only if
  present. Run `./fetch-ocr.sh` first if you want OCR to work in the packaged build.
- It fails loudly if any required whitelisted file is missing.

## After building

It prints the zip size and `unzip -l` listing — sanity-check that:
- `manifest.json` is at the **root** (not nested under a folder),
- no dev files leaked in,
- `lib/tesseract/*` is present **only** if you intend to ship OCR (it adds ~11MB).

## Notes

- To release a **new** version, bump `version` in `manifest.json` first (the output filename
  and the manifest must match). For the full release flow, use the `cut-release` skill.
- `dist/` and `*.zip` are gitignored — the zip is uploaded to the Web Store / attached to a
  GitHub release, not committed.
