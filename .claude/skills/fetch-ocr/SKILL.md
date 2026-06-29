---
name: fetch-ocr
description: Vendor the Tesseract.js OCR engine into lib/tesseract/ so the editor's "Extract text" runs fully offline. Use when OCR shows "engine isn't installed", on a fresh clone, or to update the OCR engine/language model.
---

# Vendor the offline OCR engine

Snip's "Extract text" runs Tesseract **locally** — no CDN, nothing leaves the device. The
engine and English language model aren't committed (they're large and gitignored), so they're
fetched once into `lib/tesseract/` by a dev-time script.

## Run it

```bash
./fetch-ocr.sh
```

Downloads into `lib/tesseract/` (via `curl`):
- `tesseract.min.js` — the library loaded by the editor.
- `worker.min.js` — the Web Worker.
- `tesseract-core-lstm.wasm.js` + `tesseract-core-simd-lstm.wasm.js` — the wasm core, **LSTM
  variants** (~3.8MB each, self-contained). The editor uses OEM 1 (LSTM-only), so these are
  the cores Tesseract actually loads (`-simd-lstm` on SIMD machines, `-lstm` otherwise). The
  non-LSTM cores are intentionally not vendored.
- `eng.traineddata.gz` — the English model (`tessdata_fast`, ~2MB).

Then reload the unpacked extension. "Extract text" in the editor will now work.

## How it stays offline

The editor loads all of these from `chrome.runtime.getURL("lib/tesseract/…")` and sets
`workerBlobURL: false` — see `runOCR` in `editor.js`. This is a **runtime invariant**: OCR
must never fall back to a network/CDN path. `fetch-ocr.sh` is the only piece that touches the
network, and only at dev time.

## Notes

- The files are **gitignored** (`lib/tesseract/`) and excluded from `git archive`. Re-run this
  on a fresh clone.
- `build.sh` adds `lib/tesseract/*` to the Web Store zip **only if present** — run this first
  if you want OCR in the packaged build (it adds ~11MB).
- To add another language, fetch its `<lang>.traineddata.gz` from the same tessdata host into
  `lib/tesseract/` and pass that lang code to `Tesseract.createWorker` in `editor.js`.
