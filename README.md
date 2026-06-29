# Catsnip ✂️

*Grab anything on your screen — inside or outside the browser — then mark it up and save.*

A Chrome extension (Manifest V3) that captures a **dragged region**, the **visible tab**, a
**full scrollable page**, or **any screen / app window** (even with the browser hidden), then
lets you **crop, annotate, OCR, copy, and save** — all locally. Nothing ever leaves your
device.

![icon](icons/icon128.png)

## Features

- **Four capture modes**
  - **Region** — drag a marquee anywhere on the page (also on a keyboard shortcut).
  - **Visible area** — the current viewport in one shot.
  - **Full page** — scroll & stitch the entire page (capped at 16384px).
  - **Screen or window** — any display or app window via the OS picker — *outside the
    browser*.
- **Annotate** — arrow, rectangle, ellipse, freehand pen, highlighter, text, and
  **blur / redact**. Pick a color and size; **undo/redo** everything.
- **Editable elements** — with the **Select** tool, click any annotation to **move** it, drag
  its **handles to resize**, change its color/size, or **Delete** to remove it. Drawn shapes are
  auto-selected so you can adjust them right away.
- **Inline text** — the **Text** tool drops an editable box right on the screenshot: click and
  type (Enter confirms, Shift+Enter for a new line, Esc cancels). Double-click any text to edit it
  in place — no popups.
- **Background frame** *(on by default)* — drop the snip onto a centered background with
  **rounded corners** and a soft shadow. Pick from a dozen-plus **gradient** presets, solid or
  **transparent**, or choose your **own custom color**; tune padding + corner radius. Turn it
  off for a raw screenshot.
- **Crop** — trim to exactly what you want; it becomes the new image (and undo brings it back).
- **Text recognition (OCR)** — runs **fully offline** against a vendored Tesseract engine, two ways:
  - **Grab text** — a select-to-copy *mode*: the recognized text is overlaid in place on the
    image so you can **drag-select and ⌘/Ctrl+C copy straight off the screenshot** (like macOS
    Live Text), or "Copy all text". Separate from editing.
  - **Extract text** — dumps all recognized text into a side panel to copy.
- **Session gallery** — keep multiple snips, switch between them, remove any.
- **Copy & save** — copy a PNG to the clipboard, save **PNG or JPEG**, or **Save all** as a
  ZIP.
- **Private by design** — no network, no analytics, no remote code; captured pixels never
  touch storage.

## How it works

| Piece | Role |
| --- | --- |
| `popup.html/.css/.js` | **Launcher.** Pick a mode; hand off to the service worker and close so the region overlay / desktop picker can take focus. |
| `background.js` | **Service worker.** Runs the in-browser engines: region (capture → overlay → crop), visible, and full-page scroll-and-stitch. Hands the result to the editor in memory. |
| `overlay.js/.css` | **Region marquee** injected into the page — drag a box on the frozen screenshot. |
| `editor.html/.css/.js` | **Editor tab.** Claims the snip (or grabs a screen/window frame here), then crop / annotate / OCR / gallery / copy / save / ZIP. |
| `lib/` | Vendored `jszip` (ZIP) and `tesseract/` (OCR) — loaded locally, never from a CDN. |

Four capture modes, three engines:

**Region / Visible / Full page (in the browser).** `chrome.tabs.captureVisibleTab` grabs the
page. Region takes a **clean** shot first, then overlays a marquee so the selection UI is
never in the result; the worker crops to your rectangle. Full page scrolls and stitches the
whole height.

**Screen or window (outside the browser).** Captured in the editor tab via
`chrome.desktopCapture` + `getUserMedia` — pick any display or app window, even with the
browser minimized. Then draw your crop right in the editor.

**Why an editor tab (not the popup):** popups close when they lose focus — which a region
overlay and the screen picker both force. The editor tab is stable, hosts the desktop
capture, and is where the canvas, clipboard, and downloads share one context.

## Install (unpacked)

1. (Once, for OCR) run `./fetch-ocr.sh` to vendor the offline OCR engine into `lib/tesseract/`.
   You can skip this — everything else works without it, and the editor will tell you OCR
   isn't installed if you try it.
2. Open `chrome://extensions`.
3. Toggle **Developer mode** (top-right) on.
4. Click **Load unpacked** and select this project folder.
5. Pin the **Catsnip** icon. Click it on any page, or press the **region shortcut**
   (default `Ctrl/Cmd+Shift+S`).

## Usage

1. Click the toolbar icon (or press the region shortcut).
2. Choose a mode: **Snip region**, **Visible area**, **Full page**, or **Screen or window**.
3. For a region, drag a box (Esc cancels). For screen/window, pick the source in the OS picker.
4. The **editor tab** opens. Crop, add arrows/text/blur, or **Extract text** for OCR.
5. **Copy** to the clipboard, or **Save** (PNG/JPEG). Collect several snips and **Save all**
   as a ZIP.

## Notes & limitations

- **Browser/system pages** (`chrome://`, the Web Store, other extensions) can't be region /
  visible / full-page captured — the popup disables those. **Screen or window** still works.
- **Full-page** capture scrolls the live tab and is paced to stay under Chrome's
  capture rate limit; very tall pages are capped at 16384px and flagged "truncated".
- **OCR** is English by default (the vendored `tessdata_fast` model) and runs on-device — the
  first run loads the ~11MB engine from local files, no network.
- It captures what's on screen at capture time, not unsaved in-page state of other tabs.

## Development

No build step, no framework — Catsnip is plain MV3 + vanilla JavaScript, loaded unpacked. See
**[GUIDELINES.md](GUIDELINES.md)** for code style, the manual test checklist, and how to add
an annotation tool, and **[CLAUDE.md](CLAUDE.md)** for the architecture map and the project
invariants (chiefly: nothing leaves the device).

Common tasks — each is also a Claude Code skill under `.claude/skills/`:

| Task | Command | Output |
| --- | --- | --- |
| Package the Web Store zip | `./build.sh` | `dist/snip-v<version>.zip` |
| Regenerate the icon (dependency-free) | `python3 icons/gen_icons.py` | `icons/icon*.png` |
| Vendor the OCR engine (one-time) | `./fetch-ocr.sh` | `lib/tesseract/*` |

To cut a release: bump `version` in `manifest.json`, write release notes under
`docs/releases/`, run `./build.sh`, tag `v<version>`, and `gh release create` with the zip
(see the `cut-release` skill).

## Tech

Manifest V3 · `chrome.tabs.captureVisibleTab` · `chrome.desktopCapture` + `getUserMedia` ·
`chrome.scripting` · `chrome.downloads` · `chrome.storage` · OffscreenCanvas · Canvas 2D ·
JSZip 3.10 · Tesseract.js 5 (vendored, offline).

## License

**Proprietary — © 2026 Artfred Dela Cruz. All rights reserved.** This source is published for viewing and portfolio purposes only; no permission is granted to use, copy, modify, or distribute it without prior written consent. See [LICENSE](LICENSE).

## Author

Made by [artfred16](https://artfred16.github.io).
