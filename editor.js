"use strict";

/* ============================================================
 * Snip — editor (stable tab).
 * Receives a captured snip (page region/visible/full-page handed off by the service
 * worker, or a screen/window grabbed here via desktopCapture), then crops, annotates,
 * OCRs, copies, and saves. Multiple snips live in a session gallery. Everything stays
 * on this device — no network, no telemetry; OCR runs against a locally vendored engine.
 * ========================================================== */

const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = () => `s_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const PALETTE = ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#a855f7", "#111827", "#ffffff"];

// Background presets for the "beautify" frame. `colors` → diagonal gradient (any number of
// stops); `color` → solid; `transparent` → no fill (just the rounded image + shadow).
const BACKGROUNDS = [
  { id: "violet", label: "Violet", colors: ["#6366f1", "#a855f7"] },
  { id: "sky", label: "Sky", colors: ["#0ea5e9", "#6366f1"] },
  { id: "ocean", label: "Ocean", colors: ["#2193b0", "#6dd5ed"] },
  { id: "mint", label: "Mint", colors: ["#10b981", "#06b6d4"] },
  { id: "forest", label: "Forest", colors: ["#11998e", "#38ef7d"] },
  { id: "sunset", label: "Sunset", colors: ["#fb7185", "#f59e0b"] },
  { id: "fire", label: "Fire", colors: ["#f12711", "#f5af19"] },
  { id: "peach", label: "Peach", colors: ["#ffecd2", "#fcb69f"] },
  { id: "rose", label: "Rose", colors: ["#ee9ca7", "#ffdde1"] },
  { id: "grape", label: "Grape", colors: ["#8e2de2", "#4a00e0"] },
  { id: "candy", label: "Candy", colors: ["#fc466b", "#3f5efb"] },
  { id: "aurora", label: "Aurora", colors: ["#00c6ff", "#0072ff", "#7b2ff7"] },
  { id: "dusk", label: "Dusk", colors: ["#355c7d", "#6c5b7b", "#c06c84"] },
  { id: "slate", label: "Slate", colors: ["#334155", "#0f172a"] },
  { id: "midnight", label: "Midnight", colors: ["#232526", "#414345"] },
  { id: "light", label: "Light", colors: ["#f1f5f9", "#e2e8f0"] },
  { id: "white", label: "White", color: "#ffffff" },
  { id: "transparent", label: "Transparent", transparent: true },
];

const state = {
  snips: [], activeId: null, tool: "select", selectedId: null, editingId: null, textSelect: false, color: "#ef4444", width: 4, format: "png", jpegQuality: 0.92,
  // Frame is a global presentation setting (like the export format) — applied at render/export
  // time, persisted, and NOT part of the per-snip undo history.
  frame: { enabled: true, bg: "violet", customColor: "#1e293b", paddingRatio: 0.08, radiusRatio: 0.04, shadow: true },
};
let draft = null;            // new annotation being drawn (uncommitted)
let interaction = null;      // an in-progress move/resize of the selected annotation
let textEditor = null;       // { opId, isNew, x, y, color, size } while the inline text box is open
let ocrRunToken = 0;         // invalidates an in-flight Grab-text OCR when the user exits/switches
const HANDLE = 7;            // selection-handle half-size, in SCREEN px
const objectUrls = new Map(); // download id -> blob url (revoked when the download settles)

const view = $("#view");
const vctx = view.getContext("2d");

/* ---------- helpers ---------- */
function active() { return state.snips.find((s) => s.id === state.activeId) || null; }
function cleanName(s) {
  return (s || "").trim()
    .replace(/[\\/:*?"<>|]+/g, "").replace(/[—–]/g, "-")
    .replace(/[\u0000-\u001f]+/g, "").replace(/\s+/g, "-").replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 80) || "snip";
}
function defaultName(source, mode) { return cleanName(`${source || "snip"}-${mode || "snip"}`); }
function timestamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function isEditable(el) { return el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable); }
function formatInfo() { return state.format === "jpeg" ? { mime: "image/jpeg", ext: "jpg" } : { mime: "image/png", ext: "png" }; }

let toastTimer = null;
function toast(msg, kind) {
  const el = $("#toast");
  el.textContent = msg;
  el.className = "toast" + (kind ? " " + kind : "");
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2400);
}

function show(which) {
  for (const id of ["capturing", "empty", "error-state", "editor"]) $("#" + id).hidden = true;
  $("#" + (which === "error" ? "error-state" : which)).hidden = false;
}
function showError(msg) { $("#error-text").textContent = msg; show("error"); }

async function canvasFromBlob(blob) {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement("canvas");
  c.width = bmp.width; c.height = bmp.height;
  c.getContext("2d").drawImage(bmp, 0, 0);
  bmp.close();
  return c;
}

// Snip handoff store — the worker put() the captured Blob here; we take() it once. Shared with
// background.js (same extension origin); see the IDB note there.
const DB_NAME = "snip-handoff", STORE = "jobs";
function openDB() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function idbTake(key) {
  const db = await openDB();
  try {
    return await new Promise((res, rej) => {
      const t = db.transaction(STORE, "readwrite");
      const s = t.objectStore(STORE);
      const g = s.get(key);
      g.onsuccess = () => { const v = g.result; if (v !== undefined) s.delete(key); res(v); };
      g.onerror = () => rej(g.error);
      t.onerror = () => rej(t.error);
    });
  } finally { db.close(); }
}

/* ---------- snip model ---------- */
function cloneOp(a) { return { ...a, points: a.points ? a.points.map((p) => ({ ...p })) : undefined }; }
function snapshot(snip) { return { base: snip.base, ann: snip.annotations.map(cloneOp) }; }
function pushHistory(snip) {
  const snap = snapshot(snip);
  // No-op guard: a drag/edit that ends at the same state shouldn't add an undo step
  // (covers same-color picks, drag-and-back resizes, unchanged text edits, etc.).
  const cur = snip.history[snip.histIndex];
  if (cur && cur.base === snap.base && JSON.stringify(cur.ann) === JSON.stringify(snap.ann)) return;
  snip.history = snip.history.slice(0, snip.histIndex + 1);
  snip.history.push(snap);
  snip.histIndex = snip.history.length - 1;
  snip.ocrLines = null; snip.ocrText = "";   // content changed → cached OCR is stale (and could leak redacted text)
  updateUndoRedo();
}
function restore(snip, snap) { snip.base = snap.base; snip.annotations = snap.ann.map(cloneOp); snip.ocrLines = null; snip.ocrText = ""; }

function addSnip({ base, mode, source, truncated }) {
  const snip = { id: uid(), name: defaultName(source, mode), mode, source, base, annotations: [], history: [], histIndex: -1, ocrText: "", truncated: !!truncated };
  snip.history = [snapshot(snip)];
  snip.histIndex = 0;
  state.snips.push(snip);
  state.activeId = snip.id;
  show("editor");
  render();
  renderGallery();
  updateUndoRedo();
  $("#ocr-text").value = "";
  if (truncated) toast("Page was too large to capture fully — the bottom was cut off.", "err");
}
function setActive(id) {
  hideTextEditor();
  exitTextSelect();   // also cancels an in-flight Grab-text OCR (via the run token)
  state.activeId = id;
  draft = null;
  interaction = null;
  state.selectedId = null;
  updateSelectionUI();
  render();
  renderGallery();
  updateUndoRedo();
  $("#ocr-text").value = active() ? active().ocrText || "" : "";
}
function removeSnip(id) {
  const i = state.snips.findIndex((s) => s.id === id);
  if (i < 0) return;
  state.snips.splice(i, 1);
  if (state.activeId === id) state.activeId = state.snips.length ? state.snips[Math.max(0, i - 1)].id : null;
  if (!state.snips.length) { $("#empty-title").textContent = "No snips yet"; show("empty"); return; }
  setActive(state.activeId);
}

/* ---------- rendering ---------- */
function normalizeRect(d) {
  return { x: Math.min(d.x1, d.x2), y: Math.min(d.y1, d.y2), w: Math.abs(d.x2 - d.x1), h: Math.abs(d.y2 - d.y1) };
}
function normalizeDraft(d) {
  if (d.type === "arrow" || d.type === "pen" || d.type === "highlight" || d.type === "text") return d;
  const r = normalizeRect(d);
  return { type: d.type, color: d.color, width: d.width, ...r };
}

function drawArrow(ctx, o) {
  ctx.save();
  ctx.strokeStyle = o.color; ctx.fillStyle = o.color; ctx.lineWidth = o.width; ctx.lineCap = "round"; ctx.lineJoin = "round";
  const ang = Math.atan2(o.y2 - o.y1, o.x2 - o.x1);
  const head = Math.max(10, o.width * 3.2);
  ctx.beginPath();
  ctx.moveTo(o.x1, o.y1);
  ctx.lineTo(o.x2 - Math.cos(ang) * head * 0.6, o.y2 - Math.sin(ang) * head * 0.6);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(o.x2, o.y2);
  ctx.lineTo(o.x2 - Math.cos(ang - 0.42) * head, o.y2 - Math.sin(ang - 0.42) * head);
  ctx.lineTo(o.x2 - Math.cos(ang + 0.42) * head, o.y2 - Math.sin(ang + 0.42) * head);
  ctx.closePath(); ctx.fill();
  ctx.restore();
}
function drawStrokePath(ctx, o, alpha) {
  if (!o.points || o.points.length < 1) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = o.color; ctx.lineWidth = alpha < 1 ? o.width * 3 : o.width; ctx.lineCap = "round"; ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(o.points[0].x, o.points[0].y);
  for (let i = 1; i < o.points.length; i++) ctx.lineTo(o.points[i].x, o.points[i].y);
  ctx.stroke();
  ctx.restore();
}
function drawBlur(ctx, base, o) {
  const x = Math.round(o.x), y = Math.round(o.y), w = Math.round(o.w), h = Math.round(o.h);
  if (w < 1 || h < 1) return;
  const f = 0.07;
  const tw = Math.max(1, Math.round(w * f)), th = Math.max(1, Math.round(h * f));
  const tmp = document.createElement("canvas"); tmp.width = tw; tmp.height = th;
  tmp.getContext("2d").drawImage(base, x, y, w, h, 0, 0, tw, th);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, 0, 0, tw, th, x, y, w, h);
  ctx.restore();
}
function drawText(ctx, o) {
  ctx.save();
  ctx.fillStyle = o.color;
  ctx.font = `bold ${o.size}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
  ctx.textBaseline = "top";
  String(o.text).split("\n").forEach((ln, i) => ctx.fillText(ln, o.x, o.y + i * o.size * 1.25));
  ctx.restore();
}
function drawOp(ctx, base, o) {
  switch (o.type) {
    case "arrow": return drawArrow(ctx, o);
    case "rect": ctx.save(); ctx.strokeStyle = o.color; ctx.lineWidth = o.width; ctx.strokeRect(o.x, o.y, o.w, o.h); ctx.restore(); return;
    case "ellipse": ctx.save(); ctx.strokeStyle = o.color; ctx.lineWidth = o.width; ctx.beginPath(); ctx.ellipse(o.x + o.w / 2, o.y + o.h / 2, o.w / 2, o.h / 2, 0, 0, Math.PI * 2); ctx.stroke(); ctx.restore(); return;
    case "pen": return drawStrokePath(ctx, o, 1);
    case "highlight": return drawStrokePath(ctx, o, 0.35);
    case "blur": return drawBlur(ctx, base, o);
    case "text": return drawText(ctx, o);
  }
}

// All crop-preview / annotation coords are in CONTENT space (the base image), origin (0,0).
// When the frame is on, the caller translates the context by the padding first.
function drawCropPreview(ctx, snip, d) {
  const r = normalizeRect(d);
  ctx.save();
  ctx.fillStyle = "rgba(17,24,39,0.5)";
  ctx.fillRect(0, 0, snip.base.width, snip.base.height);
  if (r.w > 0 && r.h > 0) ctx.drawImage(snip.base, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
  ctx.strokeStyle = "#2563eb"; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
  ctx.strokeRect(r.x, r.y, r.w, r.h);
  ctx.restore();
}

// Base image + annotations (+ the in-progress draft), in content space.
// The element under live text editing is skipped — the inline textarea stands in for it.
function drawContent(ctx, snip, withDraft) {
  ctx.drawImage(snip.base, 0, 0);
  for (const o of snip.annotations) { if (o.id === state.editingId) continue; drawOp(ctx, snip.base, o); }
  if (withDraft && draft) {
    if (draft.type === "crop") drawCropPreview(ctx, snip, draft);
    else drawOp(ctx, snip.base, normalizeDraft(draft));
  }
}

/* ---------- background frame (the "beautify" presentation) ---------- */
function frameMetrics(snip) {
  if (!snip) return { pad: 0, radius: 0, outW: 0, outH: 0 };
  if (!state.frame.enabled) return { pad: 0, radius: 0, outW: snip.base.width, outH: snip.base.height };
  // Anchor padding to the long edge for normal aspect ratios, but cap it at half the short
  // edge so a panoramic/very-tall strip isn't dwarfed by a huge band of background.
  const longPad = Math.round(Math.max(snip.base.width, snip.base.height) * state.frame.paddingRatio);
  const pad = Math.min(longPad, Math.round(Math.min(snip.base.width, snip.base.height) * 0.5));
  const radius = Math.round(Math.min(snip.base.width, snip.base.height) * state.frame.radiusRatio);
  return { pad, radius, outW: snip.base.width + pad * 2, outH: snip.base.height + pad * 2 };
}
function roundRectPath(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  ctx.beginPath();
  if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
// The active background: a preset, or "custom" (a user-picked solid color).
function currentBackground() {
  if (state.frame.bg === "custom") return { color: state.frame.customColor || "#1e293b" };
  return BACKGROUNDS.find((b) => b.id === state.frame.bg) || BACKGROUNDS[0];
}
function drawBackground(ctx, fm) {
  const bg = currentBackground();
  if (bg.transparent) return; // leave the padding transparent
  ctx.save();
  if (bg.color) {
    ctx.fillStyle = bg.color;
  } else {
    const g = ctx.createLinearGradient(0, 0, fm.outW, fm.outH);
    const cols = bg.colors;
    cols.forEach((c, i) => g.addColorStop(cols.length === 1 ? 0 : i / (cols.length - 1), c));
    ctx.fillStyle = g;
  }
  ctx.fillRect(0, 0, fm.outW, fm.outH);
  ctx.restore();
}
// Paint a snip onto ctx: bare content, or (frame on) centered on a background with a
// rounded-corner clip and a soft shadow. `withDraft` includes the live drawing preview.
function paintSnip(ctx, snip, withDraft) {
  const fm = frameMetrics(snip);
  if (!state.frame.enabled) { drawContent(ctx, snip, withDraft); return; }
  drawBackground(ctx, fm);
  ctx.save();
  if (state.frame.shadow) {
    ctx.shadowColor = "rgba(15,23,42,0.30)";
    ctx.shadowBlur = Math.max(8, fm.pad * 0.5);
    ctx.shadowOffsetY = Math.max(2, fm.pad * 0.18);
  }
  roundRectPath(ctx, fm.pad, fm.pad, snip.base.width, snip.base.height, fm.radius);
  ctx.fillStyle = "#ffffff";           // opaque backing so the shadow shows and corners clip cleanly
  ctx.fill();
  ctx.restore();
  ctx.save();
  roundRectPath(ctx, fm.pad, fm.pad, snip.base.width, snip.base.height, fm.radius);
  ctx.clip();
  ctx.translate(fm.pad, fm.pad);
  drawContent(ctx, snip, withDraft);
  ctx.restore();
}

function render() {
  const snip = active();
  if (!snip) return;
  const fm = frameMetrics(snip);
  if (view.width !== fm.outW || view.height !== fm.outH) { view.width = fm.outW; view.height = fm.outH; }
  vctx.clearRect(0, 0, view.width, view.height);
  paintSnip(vctx, snip, true);
  const sel = selectedOp();
  if (sel && state.tool === "select" && !draft && !textEditor) drawSelection(vctx, snip, sel);
}

// Content only (base + annotations), no frame — used for OCR so the engine isn't fed the
// decorative background.
function flatten(snip) {
  const c = document.createElement("canvas");
  c.width = snip.base.width; c.height = snip.base.height;
  drawContent(c.getContext("2d"), snip, false);
  return c;
}
// Final framed output — used for preview thumbnails, copy, and save.
function compose(snip) {
  const fm = frameMetrics(snip);
  const c = document.createElement("canvas");
  c.width = Math.max(1, fm.outW); c.height = Math.max(1, fm.outH);
  paintSnip(c.getContext("2d"), snip, false);
  return c;
}

/* ---------- gallery ---------- */
function thumbURL(snip) {
  const c = compose(snip);
  const tw = 180, scale = tw / c.width;
  let sh = c.height, th = Math.round(sh * scale);
  if (th > 400) { th = 400; sh = Math.round(400 / scale); }
  const t = document.createElement("canvas"); t.width = tw; t.height = Math.max(1, th);
  t.getContext("2d").drawImage(c, 0, 0, c.width, sh, 0, 0, tw, th);
  return t.toDataURL("image/png");
}
function renderGallery() {
  $("#gallery-count").textContent = `${state.snips.length} snip${state.snips.length === 1 ? "" : "s"}`;
  const list = $("#gallery");
  list.innerHTML = "";
  for (const s of state.snips) {
    const li = document.createElement("li");
    li.className = "gallery-item" + (s.id === state.activeId ? " active" : "");
    const img = document.createElement("img");
    img.src = thumbURL(s);
    img.alt = s.name;
    const name = document.createElement("div");
    name.className = "gi-name";
    name.textContent = s.name;
    const del = document.createElement("button");
    del.className = "gi-del"; del.type = "button"; del.title = "Remove"; del.textContent = "×";
    del.addEventListener("click", (e) => { e.stopPropagation(); removeSnip(s.id); });
    li.append(img, name, del);
    li.addEventListener("click", () => setActive(s.id));
    list.appendChild(li);
  }
}

/* ---------- selection & geometry (all in content space) ---------- */
function opById(id) { const s = active(); return s ? s.annotations.find((o) => o.id === id) : null; }
function selectedOp() { return state.selectedId ? opById(state.selectedId) : null; }
// Content pixels per on-screen pixel — so handles/hit-tolerance are a constant SCREEN size.
function scaleFactor() { const r = view.getBoundingClientRect(); return r.width ? view.width / r.width : 1; }

function measureText(o) {
  vctx.save();
  vctx.font = `bold ${o.size}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
  let w = 0;
  const lines = String(o.text).split("\n");
  for (const ln of lines) w = Math.max(w, vctx.measureText(ln).width);
  vctx.restore();
  return { w: Math.max(1, w), h: Math.max(1, lines.length * o.size * 1.25) };
}
function getBBox(o) {
  switch (o.type) {
    case "rect": case "ellipse": case "blur": return { x: o.x, y: o.y, w: o.w, h: o.h };
    case "arrow": return { x: Math.min(o.x1, o.x2), y: Math.min(o.y1, o.y2), w: Math.abs(o.x2 - o.x1), h: Math.abs(o.y2 - o.y1) };
    case "text": { const m = measureText(o); return { x: o.x, y: o.y, w: m.w, h: m.h }; }
    case "pen": case "highlight": {
      let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
      for (const p of o.points) { a = Math.min(a, p.x); b = Math.min(b, p.y); c = Math.max(c, p.x); d = Math.max(d, p.y); }
      return { x: a, y: b, w: Math.max(0, c - a), h: Math.max(0, d - b) };
    }
  }
  return { x: 0, y: 0, w: 0, h: 0 };
}
function distToSeg(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
  let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
function hitOp(o, p) {
  // Tolerance = a constant screen-px grab margin + the rendered half-width (highlights paint 3x).
  const tol = 6 * scaleFactor() + (o.type === "highlight" ? o.width * 3 : (o.width || 0)) / 2;
  if (o.type === "arrow") return distToSeg(p, { x: o.x1, y: o.y1 }, { x: o.x2, y: o.y2 }) <= tol;
  if (o.type === "pen" || o.type === "highlight") {
    for (let i = 1; i < o.points.length; i++) if (distToSeg(p, o.points[i - 1], o.points[i]) <= tol) return true;
    return o.points.length === 1 && Math.hypot(p.x - o.points[0].x, p.y - o.points[0].y) <= tol;
  }
  const b = getBBox(o);
  return p.x >= b.x - tol && p.x <= b.x + b.w + tol && p.y >= b.y - tol && p.y <= b.y + b.h + tol;
}
function hitTest(snip, p) {
  for (let i = snip.annotations.length - 1; i >= 0; i--) if (hitOp(snip.annotations[i], p)) return snip.annotations[i];
  return null;
}
// Resize handles: the two endpoints for an arrow, otherwise the 8 bounding-box handles.
function handlePoints(o) {
  if (o.type === "arrow") return [{ name: "p1", x: o.x1, y: o.y1 }, { name: "p2", x: o.x2, y: o.y2 }];
  const b = getBBox(o);
  const all = [
    { name: "nw", x: b.x, y: b.y }, { name: "n", x: b.x + b.w / 2, y: b.y }, { name: "ne", x: b.x + b.w, y: b.y },
    { name: "e", x: b.x + b.w, y: b.y + b.h / 2 }, { name: "se", x: b.x + b.w, y: b.y + b.h }, { name: "s", x: b.x + b.w / 2, y: b.y + b.h },
    { name: "sw", x: b.x, y: b.y + b.h }, { name: "w", x: b.x, y: b.y + b.h / 2 },
  ];
  // Text width is font-driven (not handle-driven), so only height-changing handles make sense.
  if (o.type === "text") return all.filter((h) => h.name !== "e" && h.name !== "w");
  return all;
}
function handleAt(o, p) {
  const r = (HANDLE + 2) * scaleFactor();
  for (const h of handlePoints(o)) if (Math.abs(p.x - h.x) <= r && Math.abs(p.y - h.y) <= r) return h.name;
  return null;
}
const CURSOR_FOR = { nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize", n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize", p1: "crosshair", p2: "crosshair" };

function applyMove(o, orig, dx, dy) {
  if (o.type === "arrow") { o.x1 = orig.x1 + dx; o.y1 = orig.y1 + dy; o.x2 = orig.x2 + dx; o.y2 = orig.y2 + dy; }
  else if (o.type === "pen" || o.type === "highlight") o.points = orig.points.map((pt) => ({ x: pt.x + dx, y: pt.y + dy }));
  else { o.x = orig.x + dx; o.y = orig.y + dy; }
}
function applyResize(o, inter, p) {
  const orig = inter.orig, min = 6 * scaleFactor();
  if (o.type === "arrow") {
    // Keep the arrow at least the draw-time minimum (4px) so a handle can't collapse it to a blob.
    const fixed = inter.handle === "p1" ? { x: o.x2, y: o.y2 } : { x: o.x1, y: o.y1 };
    let nx = p.x, ny = p.y;
    let ux = nx - fixed.x, uy = ny - fixed.y, d = Math.hypot(ux, uy);
    if (d < 4) {
      if (d === 0) { const ox = inter.handle === "p1" ? orig.x1 : orig.x2, oy = inter.handle === "p1" ? orig.y1 : orig.y2; ux = ox - fixed.x; uy = oy - fixed.y; d = Math.hypot(ux, uy) || 1; }
      nx = fixed.x + (ux / d) * 4; ny = fixed.y + (uy / d) * 4;
    }
    if (inter.handle === "p1") { o.x1 = nx; o.y1 = ny; } else { o.x2 = nx; o.y2 = ny; }
    return;
  }
  const ob = inter.origBBox, n = inter.handle;
  let left = ob.x, top = ob.y, right = ob.x + ob.w, bottom = ob.y + ob.h;
  if (n.includes("w")) left = p.x;
  if (n.includes("e")) right = p.x;
  if (n.includes("n")) top = p.y;
  if (n.includes("s")) bottom = p.y;
  const nb = { x: Math.min(left, right), y: Math.min(top, bottom), w: Math.max(min, Math.abs(right - left)), h: Math.max(min, Math.abs(bottom - top)) };
  if (o.type === "rect" || o.type === "ellipse" || o.type === "blur") { o.x = nb.x; o.y = nb.y; o.w = nb.w; o.h = nb.h; }
  else if (o.type === "text") {
    // Width is font/content-driven: only scale the font from the height change; keep x anchored,
    // and anchor the bottom edge when dragging a north handle so the text doesn't jump.
    o.size = Math.max(8, Math.round(orig.size * (ob.h > 0 ? nb.h / ob.h : 1)));
    o.x = orig.x;
    o.y = n.includes("n") ? (ob.y + ob.h) - Math.max(1, String(o.text).split("\n").length * o.size * 1.25) : orig.y;
  } else if (o.type === "pen" || o.type === "highlight") {
    // Signed scale anchored to the un-dragged edge (crossing it mirrors the stroke); when the
    // stroke is flat on an axis, distribute the new extent along it so the handle isn't dead.
    const N = orig.points.length;
    let spanX = right - left, spanY = bottom - top;
    if (ob.w > 0 && Math.abs(spanX) < min) spanX = (spanX < 0 ? -1 : 1) * min;
    if (ob.h > 0 && Math.abs(spanY) < min) spanY = (spanY < 0 ? -1 : 1) * min;
    const sx = ob.w > 0 ? spanX / ob.w : 0, sy = ob.h > 0 ? spanY / ob.h : 0;
    o.points = orig.points.map((pt, i) => {
      const t = N > 1 ? i / (N - 1) : 0;
      return {
        x: ob.w > 0 ? left + (pt.x - ob.x) * sx : left + t * spanX,
        y: ob.h > 0 ? top + (pt.y - ob.y) * sy : top + t * spanY,
      };
    });
  }
}
// Selection overlay — drawn only on the live canvas, never in compose()/flatten() (export).
function drawSelection(ctx, snip, o) {
  const fm = frameMetrics(snip), s = scaleFactor();
  ctx.save();
  ctx.translate(fm.pad, fm.pad);
  ctx.strokeStyle = "#2563eb"; ctx.fillStyle = "#fff"; ctx.lineWidth = 1.5 * s;
  if (o.type !== "arrow") {
    const b = getBBox(o);
    ctx.setLineDash([5 * s, 4 * s]);
    ctx.strokeRect(b.x, b.y, b.w, b.h);
    ctx.setLineDash([]);
  }
  const hs = HANDLE * s;
  for (const h of handlePoints(o)) { ctx.beginPath(); ctx.rect(h.x - hs, h.y - hs, hs * 2, hs * 2); ctx.fill(); ctx.stroke(); }
  ctx.restore();
}

/* ---------- pointer interaction ---------- */
// Map a screen event to CONTENT space (the base image). When the frame is on, the on-canvas
// image is offset by the padding, so subtract it — annotations and crop stay aligned to the
// image regardless of the frame.
function canvasPoint(e) {
  const r = view.getBoundingClientRect();
  const fx = (e.clientX - r.left) * (view.width / r.width);
  const fy = (e.clientY - r.top) * (view.height / r.height);
  const fm = frameMetrics(active());
  return { x: fx - fm.pad, y: fy - fm.pad };
}
function onPointerDown(e) {
  const snip = active();
  if (!snip || e.button !== 0 || state.textSelect) return;   // Grab-text mode owns the pointer (text selection)
  const p = canvasPoint(e);

  // SELECT tool: grab a handle (resize), an element (move), or empty space (deselect).
  if (state.tool === "select") {
    const sel = selectedOp();
    if (sel) {
      const h = handleAt(sel, p);
      if (h) {
        interaction = { mode: "resize", id: sel.id, handle: h, start: p, orig: cloneOp(sel), origBBox: getBBox(sel), moved: false };
        view.setPointerCapture(e.pointerId);
        return;
      }
    }
    const hit = hitTest(snip, p);
    if (hit) {
      state.selectedId = hit.id;
      interaction = { mode: "move", id: hit.id, start: p, orig: cloneOp(hit), moved: false };
      view.setPointerCapture(e.pointerId);
      syncStyleToSelection();
    } else {
      state.selectedId = null;
    }
    updateSelectionUI();
    render();
    return;
  }

  if (state.tool === "text") {
    e.preventDefault();   // don't let the default mousedown move focus off the textarea we're opening
    beginTextEdit({ x: p.x, y: p.y }, true);   // inline editable box on the canvas
    return;
  }
  view.setPointerCapture(e.pointerId);
  if (state.tool === "pen" || state.tool === "highlight") {
    draft = { type: state.tool, color: state.color, width: state.width, points: [p] };
  } else {
    // arrow, rect, ellipse, blur, crop — drag from a start point
    draft = { type: state.tool, color: state.color, width: state.width, x1: p.x, y1: p.y, x2: p.x, y2: p.y };
  }
  render();
}
function onPointerMove(e) {
  const snip = active();
  if (interaction && snip) {
    const o = opById(interaction.id);
    if (!o) { interaction = null; return; }
    const p = canvasPoint(e);
    interaction.moved = true;
    if (interaction.mode === "move") applyMove(o, interaction.orig, p.x - interaction.start.x, p.y - interaction.start.y);
    else applyResize(o, interaction, p);
    render();
    return;
  }
  if (draft) {
    const p = canvasPoint(e);
    if (draft.type === "pen" || draft.type === "highlight") draft.points.push(p);
    else { draft.x2 = p.x; draft.y2 = p.y; }
    render();
    return;
  }
  // Hover feedback in select mode: resize cursor over a handle, move cursor over an element.
  if (state.tool === "select" && snip && !state.textSelect) {
    const p = canvasPoint(e);
    const sel = selectedOp();
    const h = sel ? handleAt(sel, p) : null;
    view.style.cursor = h ? (CURSOR_FOR[h] || "default") : (hitTest(snip, p) ? "move" : "default");
  }
}
function onPointerUp() {
  const snip = active();
  if (interaction) {
    if (interaction.moved) pushHistory(snip);
    interaction = null;
    render();
    renderGallery();
    return;
  }
  if (!draft || !snip) return;
  const d = draft; draft = null;

  if (d.type === "crop") { applyCrop(snip, normalizeRect(d)); return; }
  const op = normalizeDraft(d);
  let keep = true;
  if (op.type === "arrow") keep = Math.hypot(op.x2 - op.x1, op.y2 - op.y1) >= 4;
  else if (op.type === "pen" || op.type === "highlight") keep = op.points.length >= 2;
  else keep = op.w >= 3 && op.h >= 3;
  if (keep) {
    op.id = uid();
    snip.annotations.push(op);
    pushHistory(snip);
    selectAfterDraw(op);
  } else {
    render();
  }
}
// After drawing a shape, switch to Select and select it so it's immediately movable/resizable.
function selectAfterDraw(op) {
  state.selectedId = op.id;
  selectTool("select");
  syncStyleToSelection();
  updateSelectionUI();
  render();
  renderGallery();
}
function deleteSelected() {
  const snip = active(), o = selectedOp();
  if (!snip || !o) return;
  snip.annotations = snip.annotations.filter((a) => a.id !== o.id);
  state.selectedId = null;
  pushHistory(snip);
  updateSelectionUI();
  render();
  renderGallery();
}
function onDblClick(e) {
  const snip = active();
  if (!snip || state.tool !== "select") return;   // edit-on-double-click is a Select-tool action
  const p = canvasPoint(e);
  for (let i = snip.annotations.length - 1; i >= 0; i--) {
    const o = snip.annotations[i];
    if (o.type === "text" && hitOp(o, p)) {
      state.selectedId = o.id;
      beginTextEdit(o, false);
      return;
    }
  }
}

/* ---------- inline text editor (a real textbox on the canvas, not a prompt) ---------- */
function autoSizeTextEditor(el) {
  el.style.width = "8px"; el.style.height = "8px";
  el.style.width = (el.scrollWidth + 4) + "px";
  el.style.height = el.scrollHeight + "px";
}
function positionTextEditor(el, x, y, size) {
  const fm = frameMetrics(active());
  const ds = (view.getBoundingClientRect().width / view.width) || 1;  // CSS px per content px
  el.style.left = (view.offsetLeft + (x + fm.pad) * ds) + "px";
  // drawText paints with textBaseline "top", but the textarea's line-height (1.25) insets the
  // first line by the half-leading — lift the box by that so typed glyphs land exactly where
  // they'll render (no jump on commit). fontSize tracks the rendered size (no floor) so it stays
  // WYSIWYG even when the canvas is displayed scaled down.
  el.style.top = (view.offsetTop + (y + fm.pad) * ds - size * ds * 0.125) + "px";
  el.style.fontSize = (size * ds) + "px";
  autoSizeTextEditor(el);
}
// opOrPos: a {x,y} for new text, or an existing text op for editing.
function beginTextEdit(opOrPos, isNew) {
  const snip = active();
  if (!snip) return;
  if (textEditor) commitTextEditor();   // commit any edit already open
  const color = isNew ? state.color : opOrPos.color;
  const size = isNew ? (10 + state.width * 4) : opOrPos.size;
  textEditor = { opId: isNew ? null : opOrPos.id, isNew, x: opOrPos.x, y: opOrPos.y, color, size };
  state.editingId = isNew ? null : opOrPos.id;
  const el = $("#text-input");
  el.value = isNew ? "" : opOrPos.text;
  el.style.color = color;
  el.hidden = false;
  if (view.parentElement) view.parentElement.classList.add("editing-text");
  render();   // hide the op being edited + drop the selection box
  positionTextEditor(el, opOrPos.x, opOrPos.y, size);
  // Focus AFTER this event: focusing during pointerdown gets undone by the browser's default
  // mousedown focus (the canvas isn't focusable, so focus jumps to <body>), which would blur and
  // immediately commit the empty box. Deferring lets our focus land last and stick.
  setTimeout(() => {
    if (!textEditor) return;
    el.focus();
    if (isNew) { const n = el.value.length; el.setSelectionRange(n, n); } else el.select();
  }, 0);
}
function hideTextEditor() {
  textEditor = null;
  state.editingId = null;
  const el = $("#text-input");
  if (el) { el.hidden = true; el.value = ""; }
  if (view.parentElement) view.parentElement.classList.remove("editing-text");
}
function commitTextEditor() {
  if (!textEditor) return;
  const te = textEditor;
  const val = $("#text-input").value;
  const snip = active();
  hideTextEditor();
  if (!snip) { render(); return; }
  if (te.isNew) {
    if (val.trim()) {
      const op = { id: uid(), type: "text", color: te.color, size: te.size, x: te.x, y: te.y, text: val };
      snip.annotations.push(op);
      state.selectedId = op.id;
      selectTool("select");
      pushHistory(snip);
    }
  } else {
    const op = opById(te.opId);
    if (op) {
      if (val.trim()) { op.text = val; state.selectedId = op.id; pushHistory(snip); }
      else { snip.annotations = snip.annotations.filter((a) => a.id !== op.id); state.selectedId = null; pushHistory(snip); }
    }
  }
  updateSelectionUI();
  render();
  renderGallery();
}
function cancelTextEditor() {
  if (!textEditor) return;
  hideTextEditor();
  render();
}

function applyCrop(snip, r) {
  const x = Math.max(0, Math.round(r.x)), y = Math.max(0, Math.round(r.y));
  const w = Math.min(snip.base.width - x, Math.round(r.w)), h = Math.min(snip.base.height - y, Math.round(r.h));
  if (w < 5 || h < 5) { render(); return; }
  const flat = flatten(snip);
  const nb = document.createElement("canvas"); nb.width = w; nb.height = h;
  nb.getContext("2d").drawImage(flat, x, y, w, h, 0, 0, w, h);
  snip.base = nb;
  snip.annotations = [];
  snip.ocrLines = null; snip.ocrText = "";   // coordinates changed — invalidate cached OCR
  state.selectedId = null;
  pushHistory(snip);
  selectTool("select");
  render();
  renderGallery();
}

/* ---------- undo / redo ---------- */
// The selected id may not survive an undo/redo (the element could vanish/reappear), so clear it.
function undo() { const s = active(); if (s && s.histIndex > 0) { s.histIndex--; restore(s, s.history[s.histIndex]); state.selectedId = null; render(); renderGallery(); updateUndoRedo(); updateSelectionUI(); } }
function redo() { const s = active(); if (s && s.histIndex < s.history.length - 1) { s.histIndex++; restore(s, s.history[s.histIndex]); state.selectedId = null; render(); renderGallery(); updateUndoRedo(); updateSelectionUI(); } }
function updateUndoRedo() {
  const s = active();
  $("#undo").disabled = !s || s.histIndex <= 0;
  $("#redo").disabled = !s || s.histIndex >= s.history.length - 1;
}
function updateSelectionUI() {
  const del = $("#del-sel");
  if (del) del.disabled = !selectedOp();
}
// Reflect the selected element's style in the color/size controls.
function syncStyleToSelection() {
  const o = selectedOp();
  if (!o) return;
  if (o.type === "text") $("#width").value = Math.max(1, Math.round((o.size - 10) / 4));
  else if (o.width != null) $("#width").value = o.width;
  if (o.color) {
    $("#color").value = /^#[0-9a-f]{6}$/i.test(o.color) ? o.color : $("#color").value;
    $("#swatches").querySelectorAll(".swatch").forEach((b) => b.classList.toggle("active", b.style.background === hexToRgb(o.color)));
  }
}

/* ---------- toolbar ---------- */
const HINTS = {
  select: "Click an element to select. Drag to move, drag a handle to resize, Delete to remove. Double-click text to edit.",
  crop: "Drag to crop. The selection becomes the new image.",
  arrow: "Drag to draw an arrow.",
  rect: "Drag to draw a rectangle.",
  ellipse: "Drag to draw an ellipse.",
  pen: "Drag to draw freehand.",
  highlight: "Drag to highlight.",
  text: "Click where you want text, then type. Enter confirms · Shift+Enter for a new line · Esc cancels.",
  blur: "Drag over anything you want to blur / redact.",
};
function selectTool(tool) {
  exitTextSelect();           // picking a tool leaves Grab-text mode (and cancels in-flight OCR)
  if (tool !== "select") state.selectedId = null;  // leaving select mode deselects
  state.tool = tool;
  document.querySelectorAll(".tool[data-tool]").forEach((b) => b.classList.toggle("active", b.dataset.tool === tool));
  view.style.cursor = tool === "select" ? "default" : (tool === "text" ? "text" : "crosshair");
  $("#hint").textContent = HINTS[tool] || "";
  updateSelectionUI();
  render();
}
function buildSwatches() {
  const wrap = $("#swatches");
  for (const c of PALETTE) {
    const b = document.createElement("button");
    b.className = "swatch" + (c === state.color ? " active" : "");
    b.type = "button";
    b.style.background = c;
    b.title = c;
    b.addEventListener("click", () => setColor(c, true));
    wrap.appendChild(b);
  }
}
// Sets the default color for new annotations; if an element is selected, recolors it too.
// `commit` pushes an undo step (true for discrete picks, false for live color-input dragging).
function setColor(c, commit) {
  state.color = c;
  $("#color").value = /^#[0-9a-f]{6}$/i.test(c) ? c : "#000000";
  $("#swatches").querySelectorAll(".swatch").forEach((b) => b.classList.toggle("active", b.style.background === hexToRgb(c)));
  const o = selectedOp();
  if (o && "color" in o) { o.color = c; render(); renderGallery(); if (commit) pushHistory(active()); }
  saveSettings();
}
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return m ? `rgb(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)})` : hex;
}

/* ---------- background frame controls ---------- */
function buildBgSwatches() {
  const wrap = $("#bg-swatches");
  for (const bg of BACKGROUNDS) {
    const b = document.createElement("button");
    b.className = "swatch bg-swatch" + (bg.transparent ? " swatch-transparent" : "");
    b.type = "button";
    b.title = bg.label;
    b.dataset.bg = bg.id;
    if (bg.color) b.style.background = bg.color;
    else if (bg.colors) b.style.background = `linear-gradient(135deg, ${bg.colors.join(", ")})`;
    b.addEventListener("click", () => setBackground(bg.id));
    wrap.appendChild(b);
  }
}
function setBackground(id) {
  state.frame.bg = id;
  updateBgActive();
  render(); renderGallery(); saveSettings();
}
// A user-picked solid background color (the "custom" swatch — a native color input).
function setCustomBackground(color) {
  state.frame.customColor = color;
  state.frame.bg = "custom";
  updateBgActive();
  render(); renderGallery(); saveSettings();
}
function updateBgActive() {
  $("#bg-swatches").querySelectorAll(".bg-swatch").forEach((b) => b.classList.toggle("active", b.dataset.bg === state.frame.bg));
  $("#bg-color").classList.toggle("active", state.frame.bg === "custom");
}
function updateFrameUI() {
  $("#bg-enabled").checked = state.frame.enabled;
  $("#bg-controls").classList.toggle("disabled", !state.frame.enabled);
  $("#bg-pad").value = Math.round(state.frame.paddingRatio * 100);
  $("#bg-radius").value = Math.round(state.frame.radiusRatio * 100);
  $("#bg-shadow").checked = state.frame.shadow;
  $("#bg-color").value = /^#[0-9a-f]{6}$/i.test(state.frame.customColor) ? state.frame.customColor : "#1e293b";
  updateBgActive();
}

/* ---------- export ---------- */
function canvasToBlob(canvas, mime, quality) {
  return new Promise((r) => canvas.toBlob(r, mime, quality));
}
// The framed canvas for export. JPEG has no alpha, so a transparent-background frame would
// encode its padding as black — flatten onto white for JPEG. PNG (and clipboard) keep alpha.
function exportCanvas(snip) {
  const c = compose(snip);
  if (state.format !== "jpeg") return c;
  const out = document.createElement("canvas");
  out.width = c.width; out.height = c.height;
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(c, 0, 0);
  return out;
}
function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename, saveAs: false, conflictAction: "uniquify" }, (id) => {
    if (chrome.runtime.lastError || id == null) { URL.revokeObjectURL(url); return; }
    objectUrls.set(id, url);
  });
}
chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.state) return;
  if (delta.state.current === "complete" || delta.state.current === "interrupted") {
    const url = objectUrls.get(delta.id);
    if (url) { URL.revokeObjectURL(url); objectUrls.delete(delta.id); }
  }
});

async function copyImage() {
  const snip = active(); if (!snip) return;
  try {
    const blob = await canvasToBlob(compose(snip), "image/png");
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    toast("Copied to clipboard", "ok");
  } catch (e) { toast("Couldn't copy: " + (e.message || e), "err"); }
}
async function saveImage() {
  const snip = active(); if (!snip) return;
  const { mime, ext } = formatInfo();
  const blob = await canvasToBlob(exportCanvas(snip), mime, mime === "image/jpeg" ? state.jpegQuality : undefined);
  if (!blob) { toast("Couldn't encode the image.", "err"); return; }
  download(blob, `snip-${cleanName(snip.name)}-${timestamp()}.${ext}`);
  toast("Saved to Downloads", "ok");
}
async function saveAll() {
  if (state.snips.length <= 1) return saveImage();
  const { mime, ext } = formatInfo();
  const zip = new JSZip();
  const seen = {};
  for (const snip of state.snips) {
    const blob = await canvasToBlob(exportCanvas(snip), mime, mime === "image/jpeg" ? state.jpegQuality : undefined);
    let base = cleanName(snip.name);
    seen[base] = (seen[base] || 0) + 1;
    if (seen[base] > 1) base = `${base}-${seen[base]}`;
    zip.file(`${base}.${ext}`, blob);
  }
  const out = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
  download(out, `snips-${timestamp()}.zip`);
  toast(`Saved ${state.snips.length} snips as ZIP`, "ok");
}

/* ---------- OCR (local Tesseract; vendored, no network) ---------- */
let tesseractLoad = null;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve();
  if (tesseractLoad) return tesseractLoad;
  tesseractLoad = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("lib/tesseract/tesseract.min.js");
    s.onload = () => resolve();
    s.onerror = () => { tesseractLoad = null; reject(new Error("missing")); };
    document.head.appendChild(s);
  });
  return tesseractLoad;
}
function ocrStatus(msg, isError) {
  const el = $("#ocr-status");
  if (!msg) { el.hidden = true; return; }
  el.hidden = false;
  el.textContent = msg;
  el.className = "status-text small" + (isError ? " error" : "");
}
// Shared recognizer — used by both the side panel (runOCR) and the in-image Grab-text mode.
// Throws Error("missing") if the engine isn't vendored. OEM 1 = LSTM_ONLY → loads the "-lstm"
// core variant (fetch-ocr.sh vendors exactly those). All paths are local; workerBlobURL is off
// (a blob: worker would violate the extension CSP).
async function ocrRecognize(image, onProgress) {
  await loadTesseract();
  const worker = await Tesseract.createWorker("eng", 1, {
    workerPath: chrome.runtime.getURL("lib/tesseract/worker.min.js"),
    corePath: chrome.runtime.getURL("lib/tesseract/"),
    langPath: chrome.runtime.getURL("lib/tesseract/"),
    workerBlobURL: false,
    logger: (m) => { if (m.status === "recognizing text" && onProgress) onProgress(m.progress || 0); },
  });
  try {
    const { data } = await worker.recognize(image, {}, { text: true, blocks: true });
    return data;
  } finally { await worker.terminate(); }
}
// Flatten Tesseract output to lines with bounding boxes (content-space px). Handles both the
// v5 block tree (blocks→paragraphs→lines) and any flat data.lines.
function extractLines(data) {
  const out = [];
  const push = (ln) => { if (ln && ln.bbox && (ln.text || "").trim()) out.push({ text: ln.text.replace(/\n+$/, ""), x0: ln.bbox.x0, y0: ln.bbox.y0, x1: ln.bbox.x1, y1: ln.bbox.y1 }); };
  if (Array.isArray(data.lines) && data.lines.length) { data.lines.forEach(push); return out; }
  for (const b of (data.blocks || [])) for (const p of (b.paragraphs || [])) for (const ln of (p.lines || [])) push(ln);
  return out;
}
function ocrMissingMessage(e) {
  return /missing/.test((e && e.message) || "")
    ? "OCR engine isn't installed. Run the fetch-ocr step (see README) so OCR works offline."
    : "OCR failed: " + ((e && e.message) || e);
}
async function runOCR() {
  const snip = active(); if (!snip) return;
  $("#ocr-pane").hidden = false;
  $("#ocr").disabled = true;
  ocrStatus("Recognizing text…");
  try {
    const data = await ocrRecognize(flatten(snip), (p) => ocrStatus(`Recognizing… ${Math.round(p * 100)}%`));
    snip.ocrText = (data.text || "").trim();
    snip.ocrLines = extractLines(data);
    $("#ocr-text").value = snip.ocrText;
    ocrStatus(snip.ocrText ? "" : "No text found in this snip.", false);
  } catch (e) {
    ocrStatus(ocrMissingMessage(e), true);
  } finally {
    $("#ocr").disabled = false;
  }
}

/* ---------- Grab-text mode (select & copy text right off the image) ----------
 * A separate mode from editing: OCR the snip, overlay invisible, selectable text positioned at
 * each line's bounding box (stretched to fit via scaleX), and let the user drag-select + copy. */
function tsMsg(text) { $("#ts-msg").textContent = text; }
function buildTextLayer(snip) {
  const layer = $("#text-layer");
  layer.innerHTML = "";
  const rect = view.getBoundingClientRect();
  const ds = rect.width / view.width || 1;          // CSS px per content px
  const fm = frameMetrics(snip);
  layer.style.width = rect.width + "px";
  layer.style.height = rect.height + "px";
  layer.hidden = false;
  for (const ln of (snip.ocrLines || [])) {
    if ((ln.x1 - ln.x0) < 1 || (ln.y1 - ln.y0) < 1) continue;  // skip degenerate bbox (zoom-independent)
    const w = (ln.x1 - ln.x0) * ds, h = (ln.y1 - ln.y0) * ds;
    const d = document.createElement("div");
    d.className = "tl-line";
    d.textContent = ln.text;
    d.style.left = ((ln.x0 + fm.pad) * ds) + "px";
    d.style.top = ((ln.y0 + fm.pad) * ds) + "px";
    d.style.height = h + "px";
    d.style.fontSize = (h * 0.86) + "px";
    d.style.lineHeight = h + "px";
    layer.appendChild(d);
    // Stretch the (invisible) text to exactly span the line's width so the selection highlight
    // lines up with the words underneath.
    const natural = d.scrollWidth;
    if (natural > 0) d.style.transform = `scaleX(${w / natural})`;
  }
}
function setFrameControlsDisabled(disabled) {
  // Frame controls would resize the canvas and wipe the live text selection — lock them in mode.
  $("#bg-enabled").disabled = disabled;
  if (disabled) $("#bg-controls").classList.add("disabled");
  else updateFrameUI();   // restores .disabled per state.frame.enabled
}
async function enterTextSelect() {
  if (state.textSelect) { exitTextSelect(); return; }   // toggle off
  const snip = active(); if (!snip) return;
  const token = ++ocrRunToken;            // claim this run; exit/switch bumps the token to cancel
  $("#grab-text").classList.add("active");
  $("#grab-text").disabled = true;
  $("#text-select-bar").hidden = false;
  tsMsg("Recognizing text…");
  if (!snip.ocrLines) {
    try {
      const data = await ocrRecognize(flatten(snip), (p) => { if (token === ocrRunToken) tsMsg(`Recognizing text… ${Math.round(p * 100)}%`); });
      snip.ocrText = (data.text || "").trim();
      snip.ocrLines = extractLines(data);
    } catch (e) {
      $("#grab-text").disabled = false;
      if (token === ocrRunToken) { $("#grab-text").classList.remove("active"); $("#text-select-bar").hidden = true; toast(ocrMissingMessage(e), "err"); }
      return;
    }
  }
  $("#grab-text").disabled = false;
  // Bail if the user exited (Done/Esc), switched tool, or switched snips while OCR ran.
  if (token !== ocrRunToken || active() !== snip) return;
  if (state.selectedId) { state.selectedId = null; updateSelectionUI(); render(); }
  state.textSelect = true;
  setFrameControlsDisabled(true);
  buildTextLayer(snip);
  tsMsg(snip.ocrLines.length ? "Text mode — drag to select, then ⌘/Ctrl+C to copy." : "No text found on this image.");
}
function exitTextSelect() {
  ocrRunToken++;                          // cancel any in-flight OCR run
  state.textSelect = false;
  const layer = $("#text-layer");
  layer.hidden = true; layer.innerHTML = "";
  $("#text-select-bar").hidden = true;
  $("#grab-text").classList.remove("active");
  $("#grab-text").disabled = false;
  setFrameControlsDisabled(false);
  try { const s = window.getSelection(); if (s) s.removeAllRanges(); } catch {}
}
async function copyAllText() {
  const snip = active(); if (!snip) return;
  const txt = (snip.ocrText || "").trim() || (snip.ocrLines || []).map((l) => l.text).join("\n");
  if (!txt) { toast("No text to copy", "err"); return; }
  try { await navigator.clipboard.writeText(txt); toast("All text copied", "ok"); }
  catch { toast("Couldn't copy text", "err"); }
}

/* ---------- desktop capture (screen / window — "outside the browser") ---------- */
function chooseDesktopMedia(sources) {
  return new Promise((resolve) => {
    try { chrome.desktopCapture.chooseDesktopMedia(sources, (streamId) => resolve(streamId || null)); }
    catch { resolve(null); }
  });
}
async function grabDesktopFrame(streamId) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: streamId } },
  });
  const v = document.createElement("video");
  v.srcObject = stream;
  await v.play().catch(() => {});
  if (!v.videoWidth) await new Promise((r) => { v.onloadedmetadata = () => r(); });
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const c = document.createElement("canvas");
  c.width = v.videoWidth; c.height = v.videoHeight;
  c.getContext("2d").drawImage(v, 0, 0);
  stream.getTracks().forEach((t) => t.stop());
  return c;
}
async function captureDesktop() {
  show("capturing");
  try {
    const streamId = await chooseDesktopMedia(["screen", "window"]);
    if (!streamId) { state.snips.length ? show("editor") : show("empty"); return; }
    const base = await grabDesktopFrame(streamId);
    addSnip({ base, mode: "desktop", source: "screen" });
  } catch (e) {
    const msg = (e && e.name === "NotAllowedError") ? "Screen capture was cancelled or denied." : (e && e.message) || "Screen capture failed.";
    if (state.snips.length) { show("editor"); toast(msg, "err"); } else showError(msg);
  }
}

/* ---------- settings ---------- */
async function loadSettings() {
  try {
    const { snipSettings } = await chrome.storage.local.get("snipSettings");
    if (snipSettings) {
      if (snipSettings.color) state.color = snipSettings.color;
      if (snipSettings.width) state.width = snipSettings.width;
      if (snipSettings.format) state.format = snipSettings.format;
      if (snipSettings.frame) state.frame = { ...state.frame, ...snipSettings.frame };
    }
  } catch { /* defaults */ }
  // Guard against a stale/renamed background id so the canvas fallback and the active swatch agree
  // ("custom" is valid even though it isn't a preset).
  if (state.frame.bg !== "custom" && !BACKGROUNDS.some((b) => b.id === state.frame.bg)) state.frame.bg = BACKGROUNDS[0].id;
}
function saveSettings() {
  chrome.storage.local.set({ snipSettings: { color: state.color, width: state.width, format: state.format, frame: state.frame } }).catch(() => {});
}
function applySettingsToUI() {
  $("#width").value = state.width;
  $("#color").value = /^#[0-9a-f]{6}$/i.test(state.color) ? state.color : "#ef4444";
  document.querySelectorAll('input[name="format"]').forEach((r) => { r.checked = r.value === state.format; });
  updateFrameUI();
}

/* ---------- wire up ---------- */
function wireUp() {
  document.querySelectorAll(".tool[data-tool]").forEach((b) => b.addEventListener("click", () => selectTool(b.dataset.tool)));
  $("#color").addEventListener("input", (e) => setColor(e.target.value, false));   // live while dragging the picker
  $("#color").addEventListener("change", () => { if (selectedOp()) pushHistory(active()); }); // commit one undo step
  $("#width").addEventListener("input", (e) => {
    state.width = parseInt(e.target.value, 10) || 4;
    const o = selectedOp();
    if (o) { if (o.type === "text") o.size = 10 + state.width * 4; else if (o.width != null) o.width = state.width; render(); renderGallery(); }
  });
  $("#width").addEventListener("change", () => { saveSettings(); if (selectedOp()) pushHistory(active()); });
  $("#del-sel").addEventListener("click", deleteSelected);
  document.querySelectorAll('input[name="format"]').forEach((r) => r.addEventListener("change", () => { if (r.checked) { state.format = r.value; saveSettings(); } }));

  // Background frame
  $("#bg-enabled").addEventListener("change", (e) => { state.frame.enabled = e.target.checked; updateFrameUI(); render(); renderGallery(); saveSettings(); });
  $("#bg-pad").addEventListener("input", (e) => { state.frame.paddingRatio = (parseInt(e.target.value, 10) || 0) / 100; render(); });
  $("#bg-pad").addEventListener("change", () => { renderGallery(); saveSettings(); });
  $("#bg-radius").addEventListener("input", (e) => { state.frame.radiusRatio = (parseInt(e.target.value, 10) || 0) / 100; render(); });
  $("#bg-radius").addEventListener("change", () => { renderGallery(); saveSettings(); });
  $("#bg-shadow").addEventListener("change", (e) => { state.frame.shadow = e.target.checked; render(); renderGallery(); saveSettings(); });
  $("#bg-color").addEventListener("input", (e) => setCustomBackground(e.target.value));

  $("#undo").addEventListener("click", undo);
  $("#redo").addEventListener("click", redo);
  $("#copy").addEventListener("click", copyImage);
  $("#save").addEventListener("click", saveImage);
  $("#save-all").addEventListener("click", saveAll);
  $("#ocr").addEventListener("click", runOCR);
  $("#grab-text").addEventListener("click", enterTextSelect);
  $("#ts-copy-all").addEventListener("click", copyAllText);
  $("#ts-done").addEventListener("click", exitTextSelect);
  $("#ocr-copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("#ocr-text").value); toast("Text copied", "ok"); }
    catch { toast("Couldn't copy text", "err"); }
  });
  $("#ocr-close").addEventListener("click", () => { $("#ocr-pane").hidden = true; });

  $("#choose-desktop").addEventListener("click", captureDesktop);
  $("#add-desktop").addEventListener("click", captureDesktop);
  $("#error-close").addEventListener("click", async () => { try { const me = await chrome.tabs.getCurrent(); if (me) chrome.tabs.remove(me.id); } catch { window.close(); } });

  view.addEventListener("pointerdown", onPointerDown);
  view.addEventListener("pointermove", onPointerMove);
  view.addEventListener("pointerup", onPointerUp);
  view.addEventListener("pointercancel", onPointerUp);
  view.addEventListener("dblclick", onDblClick);

  const ti = $("#text-input");
  ti.addEventListener("input", () => autoSizeTextEditor(ti));
  ti.addEventListener("blur", () => { if (textEditor) commitTextEditor(); });
  ti.addEventListener("keydown", (e) => {
    e.stopPropagation();  // app shortcuts never fire while typing; native textarea editing (Cmd+Z/C/V/X) still works
    // Cmd/Ctrl+S would otherwise open the browser's Save-page dialog and lose the in-progress text.
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); commitTextEditor(); saveImage(); return; }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commitTextEditor(); }
    else if (e.key === "Escape") { e.preventDefault(); cancelTextEditor(); }
  });

  window.addEventListener("keydown", onKey);
  // Keep the Grab-text overlay aligned whenever the canvas's rendered size changes (window
  // resize, the Extract-text panel opening, responsive breakpoints). Observe the canvas, not the
  // layer (buildTextLayer resizes the layer → would loop).
  if (window.ResizeObserver) {
    new ResizeObserver(() => { if (state.textSelect && active()) buildTextLayer(active()); }).observe(view);
  } else {
    window.addEventListener("resize", () => { if (state.textSelect && active()) buildTextLayer(active()); });
  }
  window.addEventListener("unload", () => { for (const u of objectUrls.values()) URL.revokeObjectURL(u); });
}
function onKey(e) {
  const mod = e.metaKey || e.ctrlKey;
  // Grab-text mode: let the browser handle text selection/copy (⌘C, ⌘A) natively; we only
  // claim Esc (exit) and ⌘S (save image, so it doesn't open the browser's Save-page dialog).
  if (state.textSelect) {
    if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); saveImage(); return; }
    if (mod) return;                                    // ⌘C / ⌘A stay native (copy/select text)
    if (e.key === "Escape") { exitTextSelect(); return; }
    const t = { v: "select", c: "crop", a: "arrow", r: "rect", o: "ellipse", p: "pen", h: "highlight", t: "text", b: "blur" }[e.key.toLowerCase()];
    if (t) selectTool(t);                               // a tool hotkey leaves Grab-text and switches tool
    return;
  }
  if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
  if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); saveImage(); return; }
  if (mod && e.key.toLowerCase() === "c" && !isEditable(e.target)) { e.preventDefault(); copyImage(); return; }
  if (mod) return;
  if (isEditable(e.target)) return;
  if (e.key === "Escape") {
    if (draft) { draft = null; render(); }
    else if (state.selectedId) { state.selectedId = null; updateSelectionUI(); render(); }
    return;
  }
  if ((e.key === "Delete" || e.key === "Backspace") && state.selectedId) { e.preventDefault(); deleteSelected(); return; }
  const map = { v: "select", c: "crop", a: "arrow", r: "rect", o: "ellipse", p: "pen", h: "highlight", t: "text", b: "blur" };
  const tool = map[e.key.toLowerCase()];
  if (tool) selectTool(tool);
}

/* ---------- init ---------- */
async function init() {
  await loadSettings();
  buildSwatches();
  buildBgSwatches();
  applySettingsToUI();
  selectTool(state.tool);
  wireUp();

  const params = new URLSearchParams(location.search);
  const error = params.get("error");
  const job = params.get("job");
  // ?mode=desktop is handled by the shared empty/chooser state below (see comment there).

  if (error) { showError(error); return; }

  if (job) {
    show("capturing");
    try {
      const rec = await idbTake(job);
      if (!rec || !rec.blob) {
        showError("This snip has expired. Capture again from the Snip toolbar icon.");
        return;
      }
      const base = await canvasFromBlob(rec.blob);
      addSnip({ base, mode: rec.mode, source: rec.source, truncated: rec.truncated });
      // The record is consumed (one-shot). Drop ?job= so a reload/restore lands on the chooser
      // instead of the misleading "expired" error.
      try { history.replaceState(null, "", location.pathname); } catch {}
    } catch (e) {
      showError((e && e.message) || "Couldn't load the snip.");
    }
    return;
  }

  // Desktop capture (and the empty default) shows the chooser. We don't auto-invoke the OS
  // picker on load: chrome.desktopCapture.chooseDesktopMedia can be silently ignored without
  // a user gesture, which would hang the tab. The button click is the reliable trigger.
  $("#empty-title").textContent = "Snip a screen or window";
  show("empty");
}

init();
