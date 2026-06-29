"use strict";

/*
 * Snip — region overlay (injected content script).
 * Freezes the clean screenshot captured by the service worker (window.__SNIP_IMAGE)
 * over the page and lets the user drag a marquee. On release it reports the selected
 * rectangle (CSS px in the viewport) + devicePixelRatio back to the worker, which crops
 * the clean shot. Showing the frozen image — not the live page — keeps what the user
 * selects pixel-identical to what gets cropped.
 */

(() => {
  if (window.__SNIP_OVERLAY_ACTIVE) return;
  window.__SNIP_OVERLAY_ACTIVE = true;

  const image = window.__SNIP_IMAGE || "";
  const dpr = window.devicePixelRatio || 1;
  const root = document.createElement("div");
  root.className = "snip-ov-root";
  root.innerHTML =
    `<img class="snip-ov-frozen" src="${image}" alt="">` +
    `<div class="snip-ov-dim"></div>` +
    `<div class="snip-ov-sel" hidden><div class="snip-ov-size"></div></div>` +
    `<div class="snip-ov-hint">Drag to snip a region · <b>Esc</b> to cancel</div>`;
  document.documentElement.appendChild(root);

  const dim = root.querySelector(".snip-ov-dim");
  const sel = root.querySelector(".snip-ov-sel");
  const size = root.querySelector(".snip-ov-size");

  let startX = 0, startY = 0, dragging = false;

  function teardown() {
    window.removeEventListener("keydown", onKey, true);
    root.remove();
    window.__SNIP_OVERLAY_ACTIVE = false;
  }
  function cancel() {
    chrome.runtime.sendMessage({ type: "snip-overlay-cancel" });
    teardown();
  }
  function rectFrom(x1, y1, x2, y2) {
    return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
  }
  function paint(r) {
    sel.style.left = r.x + "px";
    sel.style.top = r.y + "px";
    sel.style.width = r.w + "px";
    sel.style.height = r.h + "px";
    size.textContent = `${Math.round(r.w)} × ${Math.round(r.h)}`;
  }

  function onDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    dragging = true;
    startX = e.clientX; startY = e.clientY;
    dim.hidden = true;          // the selection's box-shadow provides the dimming now
    sel.hidden = false;
    paint(rectFrom(startX, startY, startX, startY));
  }
  function onMove(e) {
    if (!dragging) return;
    e.preventDefault();
    paint(rectFrom(startX, startY, e.clientX, e.clientY));
  }
  function onUp(e) {
    if (!dragging) return;
    dragging = false;
    const r = rectFrom(startX, startY, e.clientX, e.clientY);
    if (r.w < 5 || r.h < 5) {   // treat a tiny drag/click as "start over"
      sel.hidden = true; dim.hidden = false; return;
    }
    chrome.runtime.sendMessage({ type: "snip-overlay-selected", rect: r, dpr });
    teardown();
  }
  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancel(); }
  }

  root.addEventListener("mousedown", onDown);
  window.addEventListener("mousemove", onMove, true);
  window.addEventListener("mouseup", onUp, true);
  window.addEventListener("keydown", onKey, true);
})();
