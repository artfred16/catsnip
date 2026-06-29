"use strict";

/* ============================================================
 * Snip — popup (mode launcher).
 * Picks a capture mode and hands off to the service worker, which captures and opens
 * the stable editor tab. The popup closes immediately so a region snip's overlay (and
 * the desktop picker) can take focus.
 * ========================================================== */

const $ = (s) => document.querySelector(s);
const RESTRICTED = /^(chrome|edge|brave|about|devtools|view-source|chrome-extension|moz-extension):|^https?:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/i;
// Modes that operate on the current web page (vs. desktop capture, which always works).
const PAGE_MODES = new Set(["region", "visible", "fullpage"]);

async function start(mode) {
  // Await the worker's immediate ack so the message is guaranteed delivered before the popup
  // closes (a bare fire-and-forget can be dropped when window.close() races the dispatch). The
  // ack returns right away; the actual capture runs detached in the worker.
  try { await chrome.runtime.sendMessage({ type: "snip-start", mode }); } catch {}
  window.close();
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const capturable = !!(tab && tab.url && !RESTRICTED.test(tab.url));

  if (tab && tab.url) {
    try { $("#page-host").textContent = new URL(tab.url).host || tab.title || "Capture, mark up, and save"; }
    catch { $("#page-host").textContent = tab.title || "Capture, mark up, and save"; }
  }

  // Show the user's actual shortcut for region snip, if one is bound.
  try {
    const cmds = await chrome.commands.getAll();
    const c = cmds.find((x) => x.name === "snip-region");
    if (c && c.shortcut) $("#region-kbd").textContent = c.shortcut; else $("#region-kbd").hidden = true;
  } catch { $("#region-kbd").hidden = true; }

  document.querySelectorAll(".mode").forEach((btn) => {
    const mode = btn.dataset.mode;
    if (PAGE_MODES.has(mode) && !capturable) btn.disabled = true;
    btn.addEventListener("click", () => start(mode));
  });

  if (!capturable) {
    $("#note").hidden = false;
    $("#note").textContent = "This page can't be captured in-browser (it's a browser/system page). “Screen or window” still works.";
  }
}

init();
