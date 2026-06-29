# Catsnip — Chrome Web Store listing copy (paste-ready)

Everything you need to *type* into the Developer Dashboard, field by field. Privacy policy URL:
**https://gist.github.com/artfred16/9a1248ae8f1c5c927cb565d5cd06a625**

---

## Store listing tab

**Product name**
```
Catsnip
```

**Summary** (single line, max 132 characters)
```
Snip any region — inside or outside the browser — then crop, annotate, OCR, copy & save. All on your device.
```

**Category**
```
Productivity
```

**Language**
```
English (United States)
```

**Description** (paste as-is)
```
Catsnip is a fast, private screenshot tool. Capture anything — a dragged region, the visible tab, a full scrolling page, or any screen or app window outside the browser — then crop it, mark it up, pull the text out of it, and copy or save. Everything happens on your device; nothing is ever uploaded.

CAPTURE
• Region — drag a box anywhere on the page (also on a keyboard shortcut)
• Visible area — the current viewport in one click
• Full page — scroll and stitch the whole page, even pages that scroll inside a panel
• Screen or window — capture any display or app window, even with the browser minimized

EDIT
• Arrows, rectangles, ellipses, pen, highlighter, text, and blur / redact
• Select, move, resize, restyle, and delete any markup — undo/redo everything
• Type text directly on the image; double-click to edit it in place
• Crop to exactly what you want
• Drop your snip on a clean background — gradients, solid, transparent, or a custom color — with rounded corners and a soft shadow

GET THE TEXT (OCR — fully offline)
• Grab text — select and copy text straight off the image, like Live Text
• Extract text — pull all recognized text into a side panel

SAVE & SHARE
• Copy to the clipboard, save as PNG or JPEG, or export several snips as a ZIP

PRIVATE BY DESIGN
• No accounts, no servers, no analytics, no remote code
• Text recognition runs locally with a bundled engine
• Minimal permissions — your captures never leave your device
```

**Screenshots** (upload all five — already rendered at 1280×800 in `dist/promo/`):
1. `screenshot-01.png` — "Snip any region in a drag" (region marquee).
2. `screenshot-02.png` — "Mark it up in seconds" (annotations).
3. `screenshot-03.png` — "Make it look great" (background frame).
4. `screenshot-04.png` — "Grab text off any image" (text selection).
5. `screenshot-05.png` — "Capture anything — even outside the browser" (desktop capture).

Regenerate any time with `./promo/shoot.sh` (sources in `promo/`; see the `generate-promo` skill).

**Small promo tile** (440×280, optional) and **Marquee** (1400×560, optional): logo + the summary line.

---

## Privacy practices tab

**Single purpose** (paste)
```
Catsnip captures a screenshot of a screen region, browser tab, full page, or app window, then lets the user crop, annotate, recognize text (OCR), copy, and save it — entirely on the user's device.
```

**Permission justifications** (one box each — paste the matching line)

- `activeTab`
```
Capture (and, for region selection, overlay) the current tab only, after the user explicitly invokes Catsnip via the toolbar button or keyboard shortcut. This avoids requesting broad host access.
```
- `tabs`
```
Read the active tab's URL/title to name the saved snip and to refuse capturing restricted browser pages, and to open the editor tab.
```
- `scripting`
```
Inject the region-selection overlay and measure/scroll the page for full-page capture, on the active tab the user is capturing.
```
- `desktopCapture`
```
Power the "Screen or window" mode: let the user pick a display or application window to capture, including content outside the browser.
```
- `downloads`
```
Save the finished screenshot (PNG/JPEG) or a ZIP of multiple snips to the user's Downloads folder.
```
- `storage`
```
Remember the user's preferences only (annotation color and size, export format, background-frame settings). No screenshot content is stored.
```
- `clipboardWrite`
```
Let the user copy the captured image, or text recognized on the image, to the clipboard.
```
- **Host permissions:** none requested (Catsnip relies on `activeTab`). If the form asks for a host-permission justification, answer: *"No host permissions are requested; capture is limited to the active tab the user invokes Catsnip on."*

**Are you using remote code?**
```
No
```
Explanation if prompted:
```
No remote code is used. All libraries (JSZip for ZIP export and Tesseract for OCR) are bundled in the extension package and loaded locally via chrome.runtime.getURL. The 'wasm-unsafe-eval' content-security-policy entry is only to run the bundled OCR WebAssembly on-device — it never loads or executes remote code.
```

**Data usage** — what data does this item collect?
```
None. Catsnip does not collect or transmit any user data.
```
Leave every data-type checkbox UNCHECKED (no personally identifiable info, health, financial, authentication, personal communications, location, web history, user activity, or website content is collected/transmitted — images are processed locally and only saved when the user chooses).

Then check all three certifications:
- ✅ I do not sell or transfer user data to third parties, outside of the approved use cases.
- ✅ I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- ✅ I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL**
```
https://gist.github.com/artfred16/9a1248ae8f1c5c927cb565d5cd06a625
```

---

## Account / contact

- **Support / developer email:** the email on your developer account.
- **Support website (optional):** https://artfred16.github.io

---

## Quick reference — fields & limits

| Field | Limit | Status |
| --- | --- | --- |
| Product name | 75 chars | "Catsnip" |
| Summary | 132 chars | ✓ (see above) |
| Description | 16,000 chars | ✓ |
| Screenshots | 1280×800 or 640×400, ≥1 (3–5 recommended) | to add |
| Icon | 128×128 | `icons/icon128.png` |
| Single purpose | required | ✓ |
| Permission justifications | one per permission | ✓ |
| Privacy policy URL | required | ✓ (gist) |
