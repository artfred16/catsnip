# CLAUDE.md

Guidance for working in this repo.

**Snip** is a Manifest V3 Chrome extension that captures a screenshot — a dragged region,
the visible tab, a full scrollable page, or **any screen / app window outside the browser**
— then crops, annotates, OCRs, copies, and saves it. See `README.md` for the user-facing
overview and `GUIDELINES.md` for development conventions.

## Quick facts

- **No build step, no framework, no `npm install`.** Plain ES2020+ JavaScript with
  HTML/CSS. Editing a source file *is* the change — just reload the unpacked extension at
  `chrome://extensions`. There is no transpile/bundle stage.
- **No runtime network access of any kind.** Everything happens locally in the browser,
  including OCR (the Tesseract engine is vendored under `lib/tesseract/`). This is a hard
  invariant — see [Invariants](#invariants--do-not-break).
- `node` is used *only* by `build.sh` (to read `version` from `manifest.json`). `python3`
  powers the icon tooling. `fetch-ocr.sh` (curl) vendors the OCR engine once. None of these
  are runtime dependencies of the extension.
- There is **no test suite** — verify changes manually (see `GUIDELINES.md`).
- Current version: `manifest.json` → `version` (currently `1.0.0`).

## Commands

| Task | Command | Output |
| --- | --- | --- |
| Package the Web Store zip | `./build.sh` | `dist/snip-v<version>.zip` |
| Regenerate icons | `python3 icons/gen_icons.py` | `icons/icon{16,32,48,128}.png` |
| Vendor the OCR engine (one-time) | `./fetch-ocr.sh` | `lib/tesseract/*` |

Each has a matching skill in `.claude/skills/` — see [Skills](#skills). Cutting a release
(bump → build → tag → GitHub release) is the `cut-release` skill.

## Architecture / file map

| File | Role | Key symbols |
| --- | --- | --- |
| `manifest.json` | MV3 manifest: name, permissions, `action` popup, `background` service worker, `snip-region` command, `wasm-unsafe-eval` CSP (for OCR). | — |
| `popup.html/.css/.js` | **Launcher.** Pick a mode (region / visible / full page / screen-or-window); message the worker and close so the overlay or desktop picker can take focus. | `start`, `PAGE_MODES`, `RESTRICTED` |
| `background.js` | **Service worker.** Runs the three in-browser engines and hands a captured snip to the editor as a Blob via IndexedDB. | `startSnip`, `captureFullPage`, `cropToRegion`, `idbPut`/`idbPrune`, `pendingRegion`, `MAX_DIM`/`MAX_AREA` |
| `overlay.js` / `overlay.css` | **Region marquee** (injected content script). Shows the frozen clean shot and reports the dragged rectangle (CSS px + dpr). | `snip-overlay-selected`, `snip-overlay-cancel` |
| `editor.html/.css/.js` | **Editor tab.** Claims the snip (or captures a desktop frame here), then crop / annotate / OCR / gallery / copy / save / ZIP. | `addSnip`, `render`, `flatten`, `drawOp`, `applyCrop`, `runOCR`, `captureDesktop`, history (`pushHistory`/`undo`/`redo`) |
| `lib/jszip.min.js` | **Vendored** ZIP lib for "Save all". No network/CDN. | — |
| `lib/tesseract/*` | **Vendored** OCR engine + English model (via `fetch-ocr.sh`; gitignored). Loaded only from local URLs. | — |
| `icons/gen_icons.py` | Dependency-free generator for the indigo cat-face icon. | `snip_pixel`, `make`, `png` |
| `build.sh` | Packages a whitelisted Web Store zip (manifest at root). | — |

## The four capture modes (the most important behavior)

A snip is captured one of four ways; the result always lands in the **editor tab**.

1. **Region** (`background.js → startSnip("region")`). `captureVisibleTab` grabs a CLEAN
   shot *before* any overlay exists, then `overlay.js` is injected to freeze that image and
   let the user drag a marquee. The worker crops the clean shot to the selected rectangle
   (`cropToRegion`, scaled by `devicePixelRatio`). Capturing before injecting is why the
   overlay never appears in the result.
2. **Visible** — `captureVisibleTab` of the current viewport; no overlay (crop in the editor).
3. **Full page** — `captureFullPage` detects the dominant scroller (the **window or an inner
   container** — `pageMetrics` tags it; SPAs often scroll a div, not the window), scrolls it,
   and stitches tiles cropped to the scroller's on-screen rect into one tall image. Capped by
   `MAX_DIM` (16384) **and** `MAX_AREA` (memory budget); stays under `captureVisibleTab`'s rate
   limit (`CAPTURE_GAP_MS`); stops if scrolling stalls and trims the blank tail; restores scroll.
4. **Desktop** ("outside the browser") — captured **in the editor tab**, not the worker,
   because `getUserMedia` needs a DOM. `chrome.desktopCapture.chooseDesktopMedia(["screen",
   "window"])` → `getUserMedia` desktop stream → grab one video frame to a canvas.

**Why an editor tab, not the popup:** popups close when they lose focus (which a region
overlay or the desktop picker forces). The editor tab is stable, hosts the desktop engine,
and is where the canvas, clipboard, and `chrome.downloads` share one context.

**Handoff:** captured pixels move as a **Blob through IndexedDB** (`snip-handoff`/`jobs`,
`idbPut` in the worker → `idbTake` in the editor, same extension origin) — never
`chrome.storage` or runtime messaging, which can't carry a tens-of-MB full-page Blob. IDB
survives a worker restart; if a record is missing/already-consumed the editor shows "this snip
expired". The popup awaits an immediate ack from the worker (so the message isn't dropped by
`window.close()`), and the capture itself runs detached.

## The editor model

- Each gallery snip is `{ base: <canvas>, annotations: [...], history, histIndex, ocrText }`.
  `base` is the (possibly cropped) image; annotations are **vector ops** (each with an `id`)
  re-rendered each frame (`render` → `drawOp`), which is what makes undo/redo and re-editing
  possible.
- **Inline text editing:** the Text tool / double-click opens a real `<textarea>` (`#text-input`,
  inside `.canvas-shell`) positioned over the canvas — `beginTextEdit`/`commitTextEditor`/
  `cancelTextEditor`. While it's open the edited op is hidden (`state.editingId`, skipped in
  `drawContent`); commit happens on Enter or blur, cancel on Esc. No `window.prompt`.
- **Interactive elements:** the **Select** tool (default) hit-tests ops + handles
  (`hitTest`/`handleAt`) and `applyMove`/`applyResize` mutate the selected op in **content
  space** (`canvasPoint` subtracts the frame padding; handle sizes use `scaleFactor`). Geometry
  per type lives in `getBBox`/`handlePoints`/`applyMove`/`applyResize`. `drawSelection` (dashed
  box + handles) is drawn **only on the live canvas**, never in `compose`/`flatten`, so it never
  leaks into exports/OCR. `pushHistory` records one undo step per discrete edit; selection is
  cleared on undo/redo/`setActive`/`applyCrop`/tool-switch.
- **Blur/redact** samples `snip.base` (the original pixels), so it genuinely obscures content.
- **Crop** bakes the current annotations into a new, smaller `base` and clears the op list;
  undo restores the previous `base` + ops (history snapshots hold a `base` reference + a deep
  copy of the ops).
- **Background frame** ("beautify") is a global, persisted presentation setting (`state.frame`),
  **not** per-snip and **not** in undo history (like the export format). `frameMetrics` computes
  padding/radius from the base size; `paintSnip` draws the chosen background, a rounded white
  backing (shadow), then clips + translates and draws the content. `canvasPoint` subtracts the
  padding so annotation/crop coords stay in content space regardless of the frame.
- **Two composites:** `flatten(snip)` = content only (base + ops), used by **OCR**.
  `compose(snip)` = the framed output, used by **copy / save / Save-all / thumbnails**.
- **Grab-text mode** (`state.textSelect`) is separate from editing: `ocrRecognize` + `extractLines`
  get per-line boxes, `buildTextLayer` overlays invisible, selectable `.tl-line` divs (positioned
  by `fm.pad`+`ds`, width-fit via `scaleX`) inside `.canvas-shell`; the user drag-selects and
  copies natively (in this mode `onKey` leaves ⌘C/⌘A native). It's a DOM overlay — never in
  `compose`/`flatten`, so exports are unaffected. `runOCR` (side panel) shares `ocrRecognize`.
- **Export** = `compose(snip)` → PNG/JPEG/clipboard/ZIP.

## Invariants — do not break

These are load-bearing and will be asserted in the published privacy policy. Breaking one
silently makes that policy false.

1. **Nothing leaves the device.** No `fetch`/`XMLHttpRequest`/`WebSocket`/`sendBeacon` to any
   server, no analytics/telemetry. The only pixels handled are the user's own captures.
2. **No remote code or external resources at runtime.** No CDN scripts/styles/fonts. Libs
   are vendored in `lib/` (JSZip, Tesseract) and loaded from `chrome.runtime.getURL(...)`.
   `fetch-ocr.sh` downloads the OCR engine at **dev time**, not runtime.
3. **OCR is fully local.** Tesseract's `workerPath`/`corePath`/`langPath` are extension URLs
   and `workerBlobURL` is off; it must never fall back to a CDN.
4. **Captured pixels never persist to `chrome.storage`** — the handoff is a transient IndexedDB
   Blob (deleted on read; pruned after ~5 min), plus the in-tab editor session.
   `chrome.storage.local` holds only `snipSettings`.
5. **Permissions are minimal.** Each entry in `manifest.json` is justified in the Web Store
   listing. Adding one means new review + a privacy-policy update — don't add one casually.
6. **16384px capture cap** (`MAX_DIM`). Taller full-page captures are truncated and flagged.

If a change would touch any of these, call it out explicitly rather than landing it silently.

## Skills

Project skills live in `.claude/skills/` (each is a `SKILL.md`):

- **`package-extension`** — run `build.sh` to produce the Web Store zip.
- **`regenerate-icons`** — regenerate the marquee icon from `icons/gen_icons.py`.
- **`fetch-ocr`** — vendor the Tesseract OCR engine into `lib/tesseract/` (offline OCR).
- **`cut-release`** — bump version → write `docs/releases/v<version>.md` → build → tag →
  publish a GitHub release.

## Conventions

See `GUIDELINES.md`. In short: 2-space indent, double-quoted strings, small `async/await`
functions, vanilla DOM, `chrome.*` callback APIs wrapped in promises, match the surrounding
comment density (explain *why*), no new runtime dependencies.

## Gotchas / context

- **Capture before overlay.** Region mode must `captureVisibleTab` *before* injecting
  `overlay.js`, or the marquee UI ends up in the screenshot.
- `chrome.tabs.captureVisibleTab` is rate-limited (~2/sec) and only reads the **active** tab
  of a window — that's why full-page stitching paces itself and the desktop engine renders a
  `getUserMedia` frame in the editor rather than poking other windows.
- **Desktop capture needs the editor tab** (DOM for `getUserMedia`); the worker only opens
  `editor.html?mode=desktop`. The picker may need a user gesture, so the editor also exposes
  a "Choose screen or window" button as the reliable entry point.
- **OCR + CSP.** WebAssembly needs `wasm-unsafe-eval` in `content_security_policy.extension_pages`,
  and a blob: worker would be blocked by `script-src 'self'` — hence `workerBlobURL: false`.
- Restricted pages (`chrome://`, the Web Store, other extensions) can't be region/visible/
  full-page captured; the popup disables those and points to "Screen or window" instead.
