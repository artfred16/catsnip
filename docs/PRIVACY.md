# Catsnip — Privacy Policy

_Last updated: 2026-06-29_

**Catsnip processes everything on your device. It does not collect, store, transmit, sell, or
share any personal data, browsing activity, screenshot content, or analytics.** There are no
servers, no tracking, and no third parties.

## What Catsnip does with your data

- **Screenshots / captured images** are held only in memory (and a transient, local IndexedDB
  hand‑off between the extension's background worker and its editor tab) while you work. They are
  written to disk **only when you choose to save them**, and are **never uploaded** anywhere.
- **Clipboard** is written **only when you click Copy** (an image, or text recognized on the
  image).
- **Preferences** (annotation color and size, export format, background‑frame settings) are saved
  locally via the browser's `chrome.storage` and never leave your device.
- **Text recognition (OCR)** runs **entirely on your device** using an engine bundled with the
  extension. Image content is never sent anywhere for recognition.

## Permissions

Catsnip requests only the permissions needed to capture the screen, tab, or window **you choose**
and to save or copy the result:

- `activeTab`, `tabs`, `scripting` — capture and (for region selection) overlay the current tab,
  only after you invoke Catsnip.
- `desktopCapture` — let you pick a screen or app window to capture (the "Screen or window" mode).
- `downloads` — save the finished image or ZIP to your Downloads folder.
- `storage` — remember your preferences (no image data is stored).
- `clipboardWrite` — copy an image or recognized text to your clipboard.

None of these permissions are used to collect or transmit data off your device.

## Remote code

Catsnip uses **no remote code**. All third‑party libraries (JSZip for ZIP export and Tesseract
for OCR) are bundled inside the extension package and loaded locally.

## Changes to this policy

If this policy changes, the "Last updated" date above will change. Material changes will be
reflected in the extension's Chrome Web Store listing.

## Contact

Questions? Contact **artfred16** — https://artfred16.github.io
