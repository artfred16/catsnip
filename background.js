"use strict";

/*
 * Snip — background service worker.
 *
 * Owns the three "inside the browser" capture engines and hands the result to the
 * stable editor tab (editor.html), which does crop / annotate / OCR / export:
 *
 *   1. REGION   — captureVisibleTab grabs a CLEAN shot of the current page, then
 *      overlay.js is injected so the user drags a marquee on the frozen image; we
 *      crop the clean shot (OffscreenCanvas) to the selected rectangle.
 *   2. VISIBLE  — captureVisibleTab of the current viewport, no overlay (crop in the editor).
 *   3. FULLPAGE — scroll-and-stitch the live tab into one tall image (capped at MAX_DIM).
 *
 * The fourth mode, DESKTOP (screen / specific window — "outside the browser"), is captured
 * IN the editor tab via chrome.desktopCapture + getUserMedia (getUserMedia needs a DOM),
 * so this worker only opens editor.html?mode=desktop for it.
 *
 * Pixels never touch chrome.storage or runtime messaging: a captured snip is written as a Blob
 * to the IndexedDB "snip-handoff"/"jobs" store (idbPut), then the editor tab reads-and-deletes
 * it (idbTake) — same extension origin. IDB carries a tens-of-MB full-page Blob that the old
 * base64-over-message handoff could not, and it survives a worker restart. Nothing leaves the
 * device. (pendingRegion below is unrelated — it holds the overlay marquee context.)
 */

const MAX_DIM = 16384;            // canvas / screenshot dimension ceiling (device px)
const MAX_AREA = 64 * 1024 * 1024; // stitched-canvas area budget (device px) — keeps memory sane
const SETTLE_MS = 250;            // let the page settle after a scroll
const CAPTURE_GAP_MS = 550;       // stay under captureVisibleTab's rate limit

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RESTRICTED = /^(chrome|edge|brave|about|devtools|view-source|chrome-extension|moz-extension):|^https?:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/i;

const uid = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`;
function hostOf(url) { try { return new URL(url).host || ""; } catch { return ""; } }

// Region captures waiting for the user's marquee selection (tabId -> { dataUrl, source }).
// The captured snip itself is handed to the editor via IndexedDB (see idbPut), not memory.
const pendingRegion = new Map();

/* ---------- promisified chrome APIs ---------- */
function captureVisible(windowId) {
  return new Promise((resolve, reject) => {
    const cb = (d) => { const e = chrome.runtime.lastError; if (e) reject(new Error(e.message)); else resolve(d); };
    if (windowId != null) chrome.tabs.captureVisibleTab(windowId, { format: "png" }, cb);
    else chrome.tabs.captureVisibleTab({ format: "png" }, cb);
  });
}
async function captureVisibleRetry(windowId) {
  let last;
  for (let i = 0; i < 6; i++) {
    try { return await captureVisible(windowId); }
    catch (e) { last = e; if (/MAX_CAPTURE|quota/i.test(e.message || "")) { await sleep(700); continue; } throw e; }
  }
  throw last;
}
function createTab(props) {
  return new Promise((resolve, reject) => chrome.tabs.create(props, (t) => {
    const e = chrome.runtime.lastError; if (e) reject(new Error(e.message)); else resolve(t);
  }));
}

/* ---------- image helpers (service-worker friendly: OffscreenCanvas + btoa) ---------- */
function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(",");
  const mime = (dataUrl.slice(0, comma).match(/data:([^;]+)/) || [])[1] || "image/png";
  const bin = atob(dataUrl.slice(comma + 1));
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}
async function bitmapFromDataUrl(dataUrl) { return createImageBitmap(dataUrlToBlob(dataUrl)); }

// Crop the clean screenshot to the user's marquee (rect is CSS px in the page viewport;
// the screenshot is at devicePixelRatio, so scale by dpr). Returns a PNG Blob + dims.
async function cropToRegion(dataUrl, rect, dpr) {
  const bmp = await bitmapFromDataUrl(dataUrl);
  const sx = Math.max(0, Math.round(rect.x * dpr));
  const sy = Math.max(0, Math.round(rect.y * dpr));
  const sw = Math.min(bmp.width - sx, Math.round(rect.w * dpr));
  const sh = Math.min(bmp.height - sy, Math.round(rect.h * dpr));
  const canvas = new OffscreenCanvas(Math.max(1, sw), Math.max(1, sh));
  canvas.getContext("2d").drawImage(bmp, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  bmp.close();
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return { blob, mime: "image/png", width: canvas.width, height: canvas.height };
}

async function dataUrlToSnip(dataUrl) {
  const blob = dataUrlToBlob(dataUrl);
  const bmp = await createImageBitmap(blob);
  const out = { blob, mime: "image/png", width: bmp.width, height: bmp.height };
  bmp.close();
  return out;
}

/* ---------- snip handoff via IndexedDB (shared by the worker and the editor page) ----------
 * Captured pixels move as a Blob through IndexedDB — NOT chrome.storage or runtime messaging.
 * A full-page shot can be tens of MB, which those channels can't carry (the old base64-over-
 * message handoff silently failed for big captures). IDB stores the Blob natively, has a large
 * quota, is shared across the extension origin, and survives a worker restart. */
const DB_NAME = "snip-handoff", STORE = "jobs";
function openDB() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function idbPut(key, val) {
  const db = await openDB();
  try {
    await new Promise((res, rej) => {
      const t = db.transaction(STORE, "readwrite");
      t.objectStore(STORE).put(val, key);
      t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  } finally { db.close(); }
}
async function idbPrune() {
  const db = await openDB();
  try {
    const now = Date.now();
    await new Promise((res, rej) => {
      const t = db.transaction(STORE, "readwrite");
      const cur = t.objectStore(STORE).openCursor();
      cur.onsuccess = () => { const c = cur.result; if (c) { if (now - ((c.value && c.value.ts) || 0) > 5 * 60 * 1000) c.delete(); c.continue(); } };
      t.oncomplete = res; t.onerror = () => rej(t.error);
    });
  } finally { db.close(); }
}

/* ---------- page-injected functions (run in the tab, not the worker) ----------
 * Many sites scroll an inner container (app shells / SPAs), not the window. We detect the
 * dominant scroller, tag it, and drive THAT — otherwise full-page would only ever capture the
 * top viewport. The scroller's on-screen rect (rx/ry) lets us crop each tile to it. */
function pageMetrics() {
  const de = document.scrollingElement || document.documentElement;
  const vw0 = window.innerWidth, vh0 = window.innerHeight;
  const docScrollH = Math.max(de.scrollHeight, document.body ? document.body.scrollHeight : 0);
  let el = null;
  if (docScrollH - vh0 <= 8) {
    // The window doesn't scroll — look for the biggest visible inner scroll container.
    const all = document.body ? document.body.getElementsByTagName("*") : [];
    let bestArea = 0;
    for (let i = 0; i < all.length; i++) {
      const n = all[i];
      if (n.scrollHeight - n.clientHeight <= 16) continue;
      const oy = getComputedStyle(n).overflowY;
      if (oy !== "auto" && oy !== "scroll") continue;
      const r = n.getBoundingClientRect();
      const area = Math.max(0, Math.min(r.right, vw0) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, vh0) - Math.max(r.top, 0));
      if (r.height >= vh0 * 0.5 && area > bestArea) { bestArea = area; el = n; }
    }
  }
  const dpr = window.devicePixelRatio || 1;
  if (el) {
    el.setAttribute("data-snip-scroller", "1");
    const r = el.getBoundingClientRect();
    return { useEl: true, dpr, vw: el.clientWidth, vh: el.clientHeight, sh: el.scrollHeight,
      rx: Math.max(0, r.left), ry: Math.max(0, r.top), scrollY: el.scrollTop, winY: window.scrollY };
  }
  return { useEl: false, dpr, vw: vw0, vh: vh0, sh: docScrollH, rx: 0, ry: 0, scrollY: window.scrollY, winY: window.scrollY };
}
function pageScrollTo(y) {
  const el = document.querySelector('[data-snip-scroller="1"]');
  if (el) { el.scrollTop = y; return el.scrollTop; }
  window.scrollTo(0, y);
  return window.scrollY || window.pageYOffset || 0;
}
function pagePrep() {
  // Hide scrollbars (window + inner) and force instant scrolling for a clean, jump-free stitch.
  const s = document.createElement("style");
  s.id = "__snip_prep";
  s.textContent = "::-webkit-scrollbar{width:0!important;height:0!important;display:none!important}html{scroll-behavior:auto!important}";
  (document.head || document.documentElement).appendChild(s);
}
function pageRestore(scrollY, winY) {
  const s = document.getElementById("__snip_prep");
  if (s) s.remove();
  const el = document.querySelector('[data-snip-scroller="1"]');
  if (el) { el.scrollTop = scrollY; el.removeAttribute("data-snip-scroller"); window.scrollTo(0, winY); }
  else window.scrollTo(0, scrollY);
}

/* ---------- full-page scroll-and-stitch ---------- */
async function captureFullPage(tab) {
  const tabId = tab.id;
  const exec = async (func, args) => {
    const r = await chrome.scripting.executeScript({ target: { tabId }, func, args: args || [] });
    return r && r[0] ? r[0].result : null;
  };
  const m = await exec(pageMetrics);
  if (!m) throw new Error("Couldn't read the page — it may be a restricted page.");
  if (!m.vw || !m.vh) throw new Error("Couldn't read the page viewport.");
  await exec(pagePrep);
  try {
    const dpr = m.dpr, step = Math.max(1, m.vh);
    // Pre-pass: scroll through to trigger lazy-loaded content, then back to the top.
    for (let y = 0; y < m.sh; y += step) { await exec(pageScrollTo, [y]); await sleep(60); }
    await exec(pageScrollTo, [0]);
    await sleep(SETTLE_MS);

    // Cap the stitched canvas by BOTH the max dimension and a total-area budget, so a tall
    // Retina page doesn't allocate a multi-hundred-MB canvas that fails to create/encode.
    const widthDev = Math.max(1, Math.round(m.vw * dpr));
    const maxHeightDev = Math.min(MAX_DIM, Math.floor(MAX_AREA / widthDev));
    let fullH = Math.min(m.sh, Math.floor(maxHeightDev / dpr));
    let truncated = m.sh > fullH;
    const canvas = new OffscreenCanvas(widthDev, Math.max(1, Math.round(fullH * dpr)));
    const ctx = canvas.getContext("2d");
    const srcX = Math.round(m.rx * dpr), srcY = Math.round(m.ry * dpr);

    let y = 0, first = true, prevAy = -1, bottomDev = 0;
    while (y < fullH) {
      const actualY = await exec(pageScrollTo, [y]);
      const ay = typeof actualY === "number" ? actualY : y;
      if (y > 0 && ay <= prevAy) { truncated = true; break; }  // can't scroll further — stop (avoid redrawing the top)
      prevAy = ay;
      if (!first) await sleep(CAPTURE_GAP_MS); else first = false;
      await sleep(SETTLE_MS);
      const bmp = await bitmapFromDataUrl(await captureVisibleRetry(tab.windowId));
      const sliceDev = Math.max(1, Math.round(Math.min(m.vh, fullH - ay) * dpr));
      const dy = Math.round(ay * dpr);
      // Crop each tile to the scroller's on-screen region (full viewport when scrolling the window).
      ctx.drawImage(bmp, srcX, srcY, widthDev, sliceDev, 0, dy, widthDev, sliceDev);
      bmp.close();
      bottomDev = Math.max(bottomDev, dy + sliceDev);
      if (ay + m.vh >= fullH - 1) break;
      y += step;
    }
    // If we couldn't reach the bottom, trim the unused (blank) tail rather than padding with white.
    let out = canvas;
    if (bottomDev > 0 && bottomDev < canvas.height) {
      out = new OffscreenCanvas(widthDev, bottomDev);
      out.getContext("2d").drawImage(canvas, 0, 0);
    }
    const blob = await out.convertToBlob({ type: "image/png" });
    return { blob, mime: "image/png", width: out.width, height: out.height, truncated };
  } finally {
    await exec(pageRestore, [m.scrollY, m.winY]).catch(() => {});
  }
}

/* ---------- editor handoff ---------- */
function openEditor(params) {
  const qs = new URLSearchParams(params).toString();
  return createTab({ url: chrome.runtime.getURL(`editor.html?${qs}`) });
}
async function stashAndOpen(snip, source, mode) {
  const id = uid();
  await idbPut(id, { blob: snip.blob, mime: snip.mime, width: snip.width, height: snip.height, truncated: !!snip.truncated, source, mode, ts: Date.now() });
  await idbPrune();
  await openEditor({ job: id });
}

/* ---------- mode entry points ---------- */
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function startSnip(mode) {
  // Desktop capture happens in the editor (needs getUserMedia / a DOM).
  if (mode === "desktop") { await openEditor({ mode: "desktop" }); return; }

  const tab = await getActiveTab();
  if (!tab || !tab.url || RESTRICTED.test(tab.url)) {
    await openEditor({ error: "This page can't be captured (browser/system pages are off-limits). Try “Snip screen” instead, or open a normal web page." });
    return;
  }
  const source = hostOf(tab.url) || tab.title || "page";

  try {
    if (mode === "region") {
      const dataUrl = await captureVisibleRetry(tab.windowId);
      pendingRegion.set(tab.id, { dataUrl, source });
      // Pass the clean shot into the page's isolated world, then inject the overlay.
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["overlay.css"] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: (img) => { window.__SNIP_IMAGE = img; }, args: [dataUrl] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["overlay.js"] });
      return; // continues in onMessage when the user finishes the marquee
    }
    if (mode === "visible") {
      const snip = await dataUrlToSnip(await captureVisibleRetry(tab.windowId));
      await stashAndOpen(snip, source, "visible");
      return;
    }
    if (mode === "fullpage") {
      const snip = await captureFullPage(tab);
      await stashAndOpen(snip, source, "fullpage");
      return;
    }
  } catch (e) {
    pendingRegion.delete(tab.id);
    await openEditor({ error: (e && e.message) || "Capture failed." });
  }
}

/* ---------- messages ---------- */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === "snip-start") {
    // Ack immediately so the popup can close right away (a full-page capture takes seconds);
    // the capture runs detached and is kept alive by its own chrome.* calls. Any failure opens
    // the editor with an error message.
    startSnip(msg.mode).catch((e) => openEditor({ error: String((e && e.message) || e) }));
    sendResponse({ ok: true });
    return false;
  }

  // Region overlay finished: crop the clean shot to the marquee and open the editor.
  if (msg.type === "snip-overlay-selected") {
    const tabId = sender.tab && sender.tab.id;
    const ctx = tabId != null ? pendingRegion.get(tabId) : null;
    if (!ctx) { sendResponse({ ok: false }); return false; }
    pendingRegion.delete(tabId);
    cropToRegion(ctx.dataUrl, msg.rect, msg.dpr || 1)
      .then((snip) => stashAndOpen(snip, ctx.source, "region"))
      .then(() => sendResponse({ ok: true }))
      .catch((e) => openEditor({ error: String((e && e.message) || e) }).then(() => sendResponse({ ok: false })));
    return true;
  }

  if (msg.type === "snip-overlay-cancel") {
    const tabId = sender.tab && sender.tab.id;
    if (tabId != null) pendingRegion.delete(tabId);
    sendResponse({ ok: true });
    return false;
  }
});

// Toolbar/keyboard shortcut → region snip (the snipping-tool muscle memory).
chrome.commands.onCommand.addListener((command) => {
  if (command === "snip-region") startSnip("region");
});
