#!/usr/bin/env bash
#
# Vendor the Tesseract.js OCR engine into lib/tesseract/ for offline, on-device OCR.
#
# This is a ONE-TIME DEV STEP, not a runtime dependency: it downloads the engine + the
# English language model so they can be served locally from the extension package. At
# runtime the editor loads them from lib/tesseract/ only — no CDN, nothing leaves the
# device (the privacy invariant). The files are .gitignored; re-run this on a fresh clone.
#
set -euo pipefail
cd "$(dirname "$0")"

DEST="lib/tesseract"
TESSERACT_VER="5"          # tesseract.js (engine + worker)
CORE_VER="5"               # tesseract.js-core (wasm)
# Language model: tessdata "fast" keeps the download small (~2MB) and is plenty for screen text.
LANG_URL="https://tessdata.projectnaptha.com/4.0.0_fast/eng.traineddata.gz"

mkdir -p "$DEST"
fetch() { echo "  ↓ $2"; curl -fsSL "$1" -o "$DEST/$2"; }

echo "Fetching Tesseract.js into $DEST/ …"
fetch "https://unpkg.com/tesseract.js@${TESSERACT_VER}/dist/tesseract.min.js" "tesseract.min.js"
fetch "https://unpkg.com/tesseract.js@${TESSERACT_VER}/dist/worker.min.js"    "worker.min.js"
# The editor runs OEM 1 (LSTM-only), so Tesseract loads the "-lstm" core — "-simd-lstm" on
# SIMD-capable machines, "-lstm" otherwise. We vendor BOTH so any machine works; the non-LSTM
# cores are intentionally NOT fetched (they'd be ~9MB of dead weight). If you change the OEM
# in editor.js (runOCR → createWorker), vendor the matching core variants here.
fetch "https://unpkg.com/tesseract.js-core@${CORE_VER}/tesseract-core-lstm.wasm.js"      "tesseract-core-lstm.wasm.js"
fetch "https://unpkg.com/tesseract.js-core@${CORE_VER}/tesseract-core-simd-lstm.wasm.js" "tesseract-core-simd-lstm.wasm.js"
fetch "$LANG_URL"                                                                         "eng.traineddata.gz"

echo
echo "Done. Vendored:"
ls -lh "$DEST"
echo
echo "Reload the unpacked extension — the editor's “Extract text” button now runs OCR offline."
