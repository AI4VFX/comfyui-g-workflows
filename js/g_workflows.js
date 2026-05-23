// ComfyUI G-Workflows — frontend
// Browses + manages workflows under user/default/workflows with sidecar thumbnails.
// All backend ops route through /comfy_greg_templates/*.

import { app } from "../../scripts/app.js";

const API = "/comfy_greg_templates";
const LS_KEY = "comfy_greg_templates_v1";

// Root-scoped key for the `expanded` Set: a folder's expand state belongs to
// the root it lives in (two roots can have same-named subfolders). "|" is
// forbidden in Windows names + by the backend, so it is a safe separator.
const EKSEP = "|";
function ekey(rootId, p) { return (rootId || "default") + EKSEP + (p || ""); }

// The panel can live in a separate browser window (about:blank), so:
//  - backend URLs must be absolute against the ComfyUI origin, and
//  - panel-side DOM must target whichever document the panel is in.
const API_BASE = window.location.origin + API; // absolute backend base
const APP_DOC  = document;                     // ComfyUI main-window document (canvas, topbar)
let   doc      = document;                     // document the panel UI currently lives in
const CARD_BASE = 160;                         // default grid column min (px); slider & preview base
const LIST_COL_DEFAULT = [220, 170, 300, 260, 90]; // default list column px widths (Name,Date,Desc,Path,Size)
const LIST_COL_MIN = 60;                       // min px width per list column when resizing
const LIST_SORTABLE = { "col-name": "name", "col-date": "date", "col-size": "size" }; // header class -> sort key

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────
const state = {
  roots: [],                  // [{ id, label, abspath, tree, available }]
  rootId: "default",          // id of the currently-selected root
  currentPath: "",            // selected folder rel path within rootId ("" = root)
  expanded: new Set([ekey("default", "")]),  // root-scoped keys: ekey(rootId, relPath)
  selection: new Set(),       // selected file paths in current folder (current root)
  selAnchor: null,            // range-select anchor (path); transient, not persisted
  clipboard: null,            // { op:'cut'|'copy', root:<id>, items:[paths] }
  loadedSourcePath: null,     // last workflow loaded via this node (rel path)
  loadedRootId: null,         // root id loadedSourcePath belongs to
  loadingFromGW: false,     // guards loadGraphData wrapper
  root: "",                   // legacy: current root's abspath (list-view Path col)
  panelMounted: false,
  cardScale: 1,               // workflow card zoom (0.25–2.5)
  recurseSubfolders: false,   // grid shows currentPath + all descendant workflows flattened
  listView: false,            // grid renders as a details-style list (Name/Date/Desc/Path/Size)
  listColW: [220, 170, 300, 260, 90],   // px widths: Name,Date,Desc,Path,Size (resizable)
  listSort: { col: null, dir: "asc" },  // col: null|'name'|'date'|'size'; dir:'asc'|'desc'
  cardSort: [],               // thumbnail sort levels (ordered): [{key:'name'|'date',dir:'asc'|'desc'}…]
  favoritesOnly: false,       // toolbar toggle: show only favorited workflows
  searchQuery: "",            // ephemeral filename filter, narrows the current view (NOT persisted)
};

function loadLS() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (typeof parsed.rootId === "string") state.rootId = parsed.rootId;
    if (typeof parsed.currentPath === "string") state.currentPath = parsed.currentPath;
    if (Array.isArray(parsed.expanded)) {
      // Legacy blob: bare relative paths, no rootId, no separator => default root.
      state.expanded = new Set(
        parsed.expanded
          .filter((x) => typeof x === "string")
          .map((x) => (x.indexOf(EKSEP) >= 0 ? x : ekey("default", x)))
      );
    }
    state.expanded.add(ekey("default", ""));
    state.expanded.add(ekey(state.rootId, ""));
    if (typeof parsed.cardScale === "number") state.cardScale = Math.min(2.5, Math.max(0.25, parsed.cardScale));
    if (typeof parsed.recurseSubfolders === "boolean") state.recurseSubfolders = parsed.recurseSubfolders;
    if (typeof parsed.listView === "boolean") state.listView = parsed.listView;
    if (typeof parsed.favoritesOnly === "boolean") state.favoritesOnly = parsed.favoritesOnly;
    if (Array.isArray(parsed.listColW) && parsed.listColW.length === 5
        && parsed.listColW.every(n => typeof n === "number" && Number.isFinite(n) && n > 0)) {
      state.listColW = parsed.listColW.map(n => Math.max(LIST_COL_MIN, Math.round(n)));
    }
    if (parsed.listSort && typeof parsed.listSort === "object") {
      const c = parsed.listSort.col, d = parsed.listSort.dir;
      if ((c === null || c === "name" || c === "date" || c === "size") && (d === "asc" || d === "desc"))
        state.listSort = { col: c, dir: d };
    }
    if (Array.isArray(parsed.cardSort)) {
      const seen = new Set(); const out = [];
      for (const s of parsed.cardSort) {
        if (s && (s.key === "name" || s.key === "date")
            && (s.dir === "asc" || s.dir === "desc") && !seen.has(s.key)) {
          seen.add(s.key); out.push({ key: s.key, dir: s.dir });
        }
      }
      state.cardSort = out;
    } else if (parsed.cardSort && typeof parsed.cardSort === "object"
               && (parsed.cardSort.key === "name" || parsed.cardSort.key === "date")
               && (parsed.cardSort.dir === "asc" || parsed.cardSort.dir === "desc")) {
      state.cardSort = [{ key: parsed.cardSort.key, dir: parsed.cardSort.dir }];  // migrate legacy single
    }
  } catch (_) {}
}
function saveLS() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      rootId: state.rootId,
      expanded: Array.from(state.expanded),
      currentPath: state.currentPath,
      cardScale: state.cardScale,
      recurseSubfolders: state.recurseSubfolders,
      listView: state.listView,
      favoritesOnly: state.favoritesOnly,
      listColW: state.listColW,
      listSort: state.listSort,
      cardSort: state.cardSort,
    }));
  } catch (_) {}
}

// ─────────────────────────────────────────────────────────────────────────────
// API helpers
// ─────────────────────────────────────────────────────────────────────────────
async function apiGet(path, rootId) {
  let url = API_BASE + path;
  if (rootId) url += (path.indexOf("?") >= 0 ? "&" : "?") + "root=" + encodeURIComponent(rootId);
  const r = await fetch(url);
  if (!r.ok) throw new Error((await r.text()) || r.statusText);
  return r.json();
}
async function apiPost(path, body) {
  const r = await fetch(API_BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const txt = await r.text();
  let data; try { data = JSON.parse(txt); } catch { data = { success: false, error: txt }; }
  if (!r.ok || !data.success) throw new Error(data.error || r.statusText);
  return data;
}
function rootEntry(rootId) { return state.roots.find((r) => r.id === rootId) || null; }
function currentRoot()     { return rootEntry(state.rootId); }

async function refreshTree() {
  const data = await apiGet("/tree");
  if (Array.isArray(data.roots)) {
    state.roots = data.roots;
  } else if (data.tree) {
    // Backward-compat: an OLD backend (ComfyUI not yet restarted after the
    // multi-root update — custom-node Python isn't hot-reloaded) still returns
    // the legacy { tree, root } shape with no `roots`. Present its single root
    // as the default so the tree still renders instead of going blank.
    state.roots = [{
      id: "default", label: "workflows",
      abspath: data.root || "", tree: data.tree, available: true,
    }];
  } else {
    state.roots = [];
  }
  let cur = rootEntry(state.rootId);
  if (!cur) {
    cur = state.roots[0] || null;
    state.rootId = cur ? cur.id : "default";
  }
  state.root = cur ? cur.abspath : "";
}
async function pingNativeRefresh() {
  // Encourage ComfyUI's own Workflows sidebar to resync on its next refresh.
  try { await fetch(window.location.origin + "/v2/userdata?path=workflows", { cache: "no-store" }); } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Workflow load / save
// ─────────────────────────────────────────────────────────────────────────────
async function loadWorkflow(relPath) {
  const rootId = state.rootId;
  // Always fetch the JSON ourselves so we load the disk content directly,
  // not whatever stale activeState a ComfyWorkflow object might carry.
  const r = await fetch(API_BASE + "/workflow?path=" + encodeURIComponent(relPath)
    + "&root=" + encodeURIComponent(rootId));
  if (!r.ok) { toast("Failed to load workflow"); return; }
  const json = await r.json();

  // Try to attach the load to a real ComfyWorkflow object so the tab gets
  // the proper name + Save target. Only meaningful for the DEFAULT root —
  // ComfyUI's workflow store only knows user/default/workflows. Extra roots
  // fall back to a plain filename string.
  let nameOrWorkflow = baseName(relPath);
  const ws = app.extensionManager && app.extensionManager.workflow;
  if (rootId === "default" && ws && typeof ws.getWorkflowByPath === "function") {
    const fullPath = `workflows/${relPath}`;
    try {
      let wf = ws.getWorkflowByPath(fullPath);
      if (!wf && typeof ws.syncWorkflows === "function") {
        await ws.syncWorkflows();
        wf = ws.getWorkflowByPath(fullPath);
      }
      if (wf) nameOrWorkflow = wf;
    } catch (e) {
      console.warn("[G-Workflows] workflow store lookup failed; using filename.", e);
    }
  }

  state.loadingFromGW = true;
  try {
    await app.loadGraphData(json, true, true, nameOrWorkflow);
    state.loadedSourcePath = relPath;
    state.loadedRootId = rootId;
    toast(`Loaded ${baseName(relPath)}`);
  } finally {
    state.loadingFromGW = false;
  }
}

function captureWorkflow() {
  try { return app.graph.serialize(); }
  catch (e) { console.error("[G-Workflows] serialize failed", e); return null; }
}

async function captureThumbBase64() {
  try {
    const canvases = APP_DOC.querySelectorAll("canvas");
    let best = null, bestArea = 0;
    for (const c of canvases) {
      if (!c.width || !c.height) continue;
      const a = c.width * c.height;
      if (a > bestArea) { best = c; bestArea = a; }
    }
    if (!best) return null;
    return best.toDataURL("image/png");
  } catch { return null; }
}

async function doSaveTo(relPath, overwrite, rootId) {
  rootId = rootId || state.rootId;
  // Saves never touch sidecar thumbnails. Use the right-click menu
  // ("Capture thumbnail from canvas", "Set thumbnail…", drag-drop)
  // to manage thumbnails explicitly.
  const workflow = captureWorkflow();
  if (!workflow) { toast("Could not serialize workflow"); return false; }
  const body = { path: relPath, workflow, overwrite: !!overwrite, root: rootId };
  try {
    const r = await apiPost("/save", body);
    state.loadedSourcePath = r.path;
    state.loadedRootId = rootId;
    // Clear ComfyUI's native dirty flag when we just overwrote the file
    // backing the active workflow — otherwise close-tab / switch-tab still
    // prompts "Save changes?". Mirrors what ComfyWorkflow.save() does
    // internally: sync content/originalContent, reset the change tracker,
    // clear isModified. Only meaningful for the default root, since the
    // workflow store only tracks user/default/workflows/.
    if (rootId === "default") {
      try {
        const ws = app && app.extensionManager && app.extensionManager.workflow;
        const aw = ws && (ws.activeWorkflow
          || (typeof ws.getActiveWorkflow === "function" && ws.getActiveWorkflow()));
        if (aw) {
          const awPath = String(aw.path || "").replace(/\\/g, "/");
          const ourPath = "workflows/" + String(r.path).replace(/\\/g, "/");
          if (awPath && awPath === ourPath) {
            const json = JSON.stringify(workflow);
            try { aw.content = json; } catch (_) {}
            try { aw.originalContent = json; } catch (_) {}
            try { aw.changeTracker && typeof aw.changeTracker.reset === "function" && aw.changeTracker.reset(); } catch (_) {}
            try { aw.isModified = false; } catch (_) {}
          }
        }
      } catch (e) {
        console.warn("[G-Workflows] could not clear ComfyUI dirty flag after save", e);
      }
    }
    await refreshTree();
    renderAll();
    pingNativeRefresh();
    toast(`Saved ${baseName(r.path)}`);
    return true;
  } catch (e) {
    toast("Save failed: " + e.message);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// File / folder mutations
// ─────────────────────────────────────────────────────────────────────────────
async function renameFile(fromPath) {
  const oldName = baseName(fromPath);
  const newName = await promptModal("Rename workflow", "New filename:", oldName);
  if (!newName) return;
  let nn = newName.trim();
  if (!nn) return;
  if (!nn.toLowerCase().endsWith(".json")) nn += ".json";
  const parent = dirName(fromPath);
  const target = parent ? `${parent}/${nn}` : nn;
  if (target === fromPath) return;
  try {
    await apiPost("/rename", { from: fromPath, to: target, root: state.rootId });
    if (state.loadedSourcePath === fromPath && state.loadedRootId === state.rootId)
      state.loadedSourcePath = target;
    await refreshTree(); renderAll(); pingNativeRefresh();
  } catch (e) { toast("Rename failed: " + e.message); }
}

async function duplicateFile(fromPath) {
  const base = baseName(fromPath).replace(/\.json$/i, "");
  const proposed = `${base}_copy.json`;
  const newName = await promptModal("Duplicate workflow", "New filename:", proposed);
  if (!newName) return;
  let nn = newName.trim();
  if (!nn) return;
  if (!nn.toLowerCase().endsWith(".json")) nn += ".json";
  const parent = dirName(fromPath);
  const target = parent ? `${parent}/${nn}` : nn;
  try {
    await apiPost("/copy", { from: fromPath, to: target, root: state.rootId });
    await refreshTree(); renderAll(); pingNativeRefresh();
  } catch (e) { toast("Duplicate failed: " + e.message); }
}

async function deleteFiles(paths) {
  if (!paths || !paths.length) return;
  const list = paths.map(p => `• ${p}`).join("\n");
  const ok = await confirmModal("Delete workflows", `Delete these ${paths.length} workflow(s) and their thumbnails?\n\n${list}\n\nThis cannot be undone.`);
  if (!ok) return;
  try {
    const r = await apiPost("/delete", { items: paths, confirm: true, root: state.rootId });
    if (state.loadedSourcePath && state.loadedRootId === state.rootId
        && paths.includes(state.loadedSourcePath)) {
      state.loadedSourcePath = null;
      state.loadedRootId = null;
    }
    state.selection.clear();
    await refreshTree(); renderAll(); pingNativeRefresh();
    toast(`Deleted ${r.deleted.length} file(s)`);
  } catch (e) { toast("Delete failed: " + e.message); }
}

async function pasteHere() {
  const cb = state.clipboard;
  if (!cb || !cb.items.length) return;
  if (cb.root !== state.rootId) {
    toast("Cut/Copy works within one location only");
    return;
  }
  const root = state.rootId;
  const dest = state.currentPath;
  try {
    if (cb.op === "cut") {
      await apiPost("/move", { items: cb.items, toFolder: dest, root });
      if (state.loadedRootId === root && cb.items.includes(state.loadedSourcePath)) {
        state.loadedSourcePath = `${dest ? dest + "/" : ""}${baseName(state.loadedSourcePath)}`;
      }
      state.clipboard = null;
    } else {
      for (const src of cb.items) {
        const target = `${dest ? dest + "/" : ""}${baseName(src)}`;
        if (target === src) continue;
        try {
          await apiPost("/copy", { from: src, to: target, root });
        } catch (e) {
          const base = baseName(src).replace(/\.json$/i, "");
          const alt = `${dest ? dest + "/" : ""}${base}_copy.json`;
          await apiPost("/copy", { from: src, to: alt, root });
        }
      }
    }
    await refreshTree(); renderAll(); pingNativeRefresh();
  } catch (e) { toast("Paste failed: " + e.message); }
}

async function mkFolder(rootId, parentPath) {
  const name = await promptModal("New folder", "Folder name:", "New Folder");
  if (!name) return;
  try {
    await apiPost("/mkdir", { path: parentPath, name: name.trim(), root: rootId });
    const created = `${parentPath ? parentPath + "/" : ""}${name.trim()}`;
    state.expanded.add(ekey(rootId, parentPath));
    state.expanded.add(ekey(rootId, created));
    await refreshTree(); renderAll();
  } catch (e) { toast("Create folder failed: " + e.message); }
}

async function renameFolder(rootId, folderPath) {
  if (!folderPath) return;
  const oldName = folderPath.split("/").pop();
  const newName = await promptModal("Rename folder", "New folder name:", oldName);
  if (!newName) return;
  const parent = folderPath.split("/").slice(0, -1).join("/");
  const target = parent ? `${parent}/${newName.trim()}` : newName.trim();
  try {
    await apiPost("/rename_dir", { from: folderPath, to: target, root: rootId });
    if (state.rootId === rootId
        && (state.currentPath === folderPath || state.currentPath.startsWith(folderPath + "/"))) {
      state.currentPath = state.currentPath.replace(folderPath, target);
    }
    if (state.loadedRootId === rootId && state.loadedSourcePath
        && state.loadedSourcePath.startsWith(folderPath + "/")) {
      state.loadedSourcePath = state.loadedSourcePath.replace(folderPath, target);
    }
    await refreshTree(); renderAll(); pingNativeRefresh();
  } catch (e) { toast("Rename folder failed: " + e.message); }
}

async function deleteFolder(rootId, folderPath) {
  if (!folderPath) return;
  const ok = await confirmModal(
    "Delete folder",
    `Delete folder "${folderPath}" and ALL workflows + thumbnails inside it?\n\nThis cannot be undone.`,
  );
  if (!ok) return;
  try {
    await apiPost("/rmdir", { path: folderPath, recursive: true, confirm: true, root: rootId });
    if (state.rootId === rootId
        && (state.currentPath === folderPath || state.currentPath.startsWith(folderPath + "/"))) {
      state.currentPath = "";
    }
    await refreshTree(); renderAll(); pingNativeRefresh();
  } catch (e) { toast("Delete folder failed: " + e.message); }
}

async function setThumbnailFromFile(workflowPath, file) {
  const dataUrl = await fileToDataURL(file);
  const ext = "." + (file.name.split(".").pop() || "png").toLowerCase();
  try {
    await apiPost("/save_thumb", { path: workflowPath, thumbBase64: dataUrl, thumbExt: ext, root: state.rootId });
    await refreshTree(); renderAll();
    toast("Thumbnail updated");
  } catch (e) { toast("Set thumbnail failed: " + e.message); }
}

async function clearThumbnail(workflowPath) {
  const ok = await confirmModal("Remove thumbnail",
    `Remove the thumbnail for "${baseName(workflowPath)}" from the gallery?\n\n` +
    `The image file is NOT deleted — it is kept on disk with a ".removed" ` +
    `suffix. Delete it yourself later if you want it gone.`);
  if (!ok) return;
  try {
    await apiPost("/delete_thumb", { path: workflowPath, confirm: true, root: state.rootId });
    await refreshTree(); renderAll();
    toast("Thumbnail removed (image kept on disk)");
  } catch (e) { toast("Remove thumbnail failed: " + e.message); }
}

async function editDescription(workflowPath) {
  let current = "";
  const folder = findFolderNode(state.rootId, dirName(workflowPath));
  if (folder) {
    const fe = (folder.files || []).find((x) => x.path === workflowPath);
    if (fe && typeof fe.description === "string") current = fe.description;
  }
  const next = await descModal(`Description — ${baseName(workflowPath)}`, current);
  if (next === null) return; // cancelled
  try {
    await apiPost("/set_desc", { path: workflowPath, description: next, root: state.rootId });
    await refreshTree(); renderAll();
    toast("Description saved");
  } catch (e) { toast("Save description failed: " + e.message); }
}

async function editTags(workflowPath) {
  let current = [];
  const folder = findFolderNode(state.rootId, dirName(workflowPath));
  if (folder) {
    const fe = (folder.files || []).find((x) => x.path === workflowPath);
    if (fe && Array.isArray(fe.tags)) current = fe.tags.slice();
  }
  const next = await tagsModal(`Tags — ${baseName(workflowPath)}`, current);
  if (next === null) return; // cancelled
  try {
    await apiPost("/set_tags", { path: workflowPath, tags: next, root: state.rootId });
    await refreshTree(); renderAll();
    toast("Tags saved");
  } catch (e) { toast("Save tags failed: " + e.message); }
}

async function toggleFavorite(f) {
  const next = !f.favorite;
  try {
    await apiPost("/set_fav", { path: f.path, favorite: next, root: state.rootId });
    await refreshTree(); renderAll();
  } catch (e) { toast("Favorite failed: " + e.message); }
}

// Clickable favorite star. stopPropagation/preventDefault so toggling does
// NOT trigger the card/row's select-or-load wiring (wireFileEl).
function makeFavStar(f) {
  return el("div", {
    class: "gt-fav" + (f.favorite ? " on" : ""),
    text: "★",
    attrs: { title: f.favorite ? "Favorite — click to remove" : "Click to favorite" },
    on: {
      click: (e) => { e.stopPropagation(); e.preventDefault(); toggleFavorite(f); },
    },
  });
}

async function dropWorkflowFile(rootId, folderPath, file) {
  let text; try { text = await file.text(); } catch { return; }
  let workflow; try { workflow = JSON.parse(text); }
  catch { toast("Dropped file is not valid JSON"); return; }
  const target = `${folderPath ? folderPath + "/" : ""}${file.name.toLowerCase().endsWith(".json") ? file.name : file.name + ".json"}`;
  try {
    await apiPost("/save", { path: target, workflow, overwrite: false, root: rootId });
    await refreshTree(); renderAll(); pingNativeRefresh();
    toast(`Saved ${file.name}`);
  } catch (e) {
    if (/exists/.test(e.message)) {
      const ok = await confirmModal("Overwrite?", `"${file.name}" already exists in this folder. Replace it?`);
      if (!ok) return;
      try {
        await apiPost("/save", { path: target, workflow, overwrite: true, root: rootId });
        await refreshTree(); renderAll(); pingNativeRefresh();
      } catch (e2) { toast("Save failed: " + e2.message); }
    } else { toast("Save failed: " + e.message); }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Save buttons
// ─────────────────────────────────────────────────────────────────────────────
// Best-effort filename for the Save As… field: the panel-loaded source if
// any; otherwise the workflow ComfyUI currently has open (opened by ANY
// means — native tab, drag-drop, etc.); otherwise "Untitled.json" for a
// new/unsaved graph. Mirrors the defensive store-access in loadWorkflow.
// Real filename of the workflow ComfyUI currently has open — the
// panel-loaded source, else the active workflow from the store (opened by
// ANY means) — or null if unknown/unsaved. No "Untitled" fallback here so
// callers can distinguish "really named" from "new graph".
function detectedWorkflowName() {
  if (state.loadedSourcePath) {
    const n = baseName(state.loadedSourcePath);
    if (n) return n.toLowerCase().endsWith(".json") ? n : n + ".json";
  }
  try {
    const ws = app && app.extensionManager && app.extensionManager.workflow;
    const aw = ws && (ws.activeWorkflow
      || (typeof ws.getActiveWorkflow === "function" && ws.getActiveWorkflow()));
    if (aw) {
      const raw = aw.path || aw.filename || "";   // real file id, not the display name
      const n = baseName(String(raw).replace(/\\/g, "/")).trim();
      if (n) return n.toLowerCase().endsWith(".json") ? n : n + ".json";
    }
  } catch (_) {}
  return null;
}
function activeWorkflowName() {
  return detectedWorkflowName() || "Untitled.json";
}

// Where the Save button writes: the panel-loaded source if any; otherwise
// the SINGLE selected thumbnail whose filename exactly matches the workflow
// ComfyUI currently has open (case-insensitive). null ⇒ nothing to plain-Save
// to (button disabled; clickSave falls back to Save As…).
function saveTarget() {
  if (state.loadedSourcePath) {
    return { path: state.loadedSourcePath, root: state.loadedRootId || state.rootId };
  }
  if (state.selection.size === 1) {
    const sel = Array.from(state.selection)[0];
    const open = detectedWorkflowName();
    if (open && baseName(sel).toLowerCase() === open.toLowerCase()) {
      return { path: sel, root: state.rootId };
    }
  }
  return null;
}

async function clickSave() {
  const t = saveTarget();
  if (!t) { await clickSaveAs(); return; }
  await doSaveTo(t.path, true, t.root);
}

async function clickSaveAs() {
  // Pre-fill the picker folder with the panel-loaded source's folder (if it
  // was loaded here); the name always reflects the actually-open workflow.
  const startFolder = state.loadedSourcePath ? (dirName(state.loadedSourcePath) || "") : "";
  const startName = activeWorkflowName();
  const picked = await pickerModal({
    title: "Save workflow as",
    startFolder,
    startName,
  });
  if (!picked) return;
  let target = picked.path;
  if (!target.toLowerCase().endsWith(".json")) target += ".json";
  let exists = false;
  try {
    const r = await fetch(API_BASE + "/workflow?path=" + encodeURIComponent(target)
      + "&root=" + encodeURIComponent(state.rootId));
    exists = r.ok;
  } catch {}
  if (exists) {
    const ok = await confirmModal("Overwrite?", `"${target}" already exists. Replace it?`);
    if (!ok) return;
  }
  await doSaveTo(target, true, state.rootId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Path helpers
// ─────────────────────────────────────────────────────────────────────────────
function baseName(p) { return (p || "").split("/").pop(); }
function dirName(p)  { const parts = (p || "").split("/"); parts.pop(); return parts.join("/"); }

function findFolderNode(rootId, path) {
  const r = rootEntry(rootId);
  const tree = r && r.tree;
  if (!tree) return null;
  if (!path) return tree;
  const parts = path.split("/");
  let node = tree;
  for (const part of parts) {
    if (!node) return null;
    node = (node.folders || []).find(f => f.name === part);
  }
  return node;
}

// Flatten this folder's files + all descendant subfolders' files (DFS:
// current folder first, then each subfolder depth-first). Used by the
// "Subfolders" recursive-view toggle.
function collectFilesRecursive(node) {
  if (!node) return [];
  let out = (node.files || []).slice();
  for (const sub of (node.folders || [])) out = out.concat(collectFilesRecursive(sub));
  return out;
}

function rootDisplayLabel(r) {
  return r.id === "default" ? "workflows" : (r.label || r.abspath || r.id);
}

// When a file came from a cross-root search hit, point the active
// location/folder at it so all existing single-root machinery
// (load, save, context menu, thumbnails) operates correctly. No-op for
// normal browsing (f.__root undefined).
function focusFileContext(f) {
  if (f && f.__root) {
    state.rootId = f.__root;
    state.currentPath = dirName(f.path);
  }
}


function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// DOM helpers
// ─────────────────────────────────────────────────────────────────────────────
function el(tag, opts = {}, ...children) {
  const node = doc.createElement(tag);
  if (opts.class)   node.className = opts.class;
  if (opts.id)      node.id = opts.id;
  if (opts.text)    node.textContent = opts.text;
  if (opts.style)   Object.assign(node.style, opts.style);
  if (opts.attrs)   for (const [k, v] of Object.entries(opts.attrs)) node.setAttribute(k, v);
  if (opts.on)      for (const [k, v] of Object.entries(opts.on)) node.addEventListener(k, v);
  for (const c of children) {
    if (c == null) continue;
    if (typeof c === "string") node.appendChild(doc.createTextNode(c));
    else node.appendChild(c);
  }
  return node;
}
function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

// ─────────────────────────────────────────────────────────────────────────────
// CSS
// ─────────────────────────────────────────────────────────────────────────────
const CSS = `
.gt-root { position:relative; display:flex; flex-direction:column; height:100%; min-height:0; color:var(--input-text,#dbe2ea); font:13px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; background:var(--comfy-menu-bg,#1f2227); }
.gt-toolbar { display:flex; gap:6px; padding:6px 8px; border-bottom:1px solid #303540; flex-wrap:wrap; align-items:center; }
.gt-toolbar button { background:#2b313a; color:#dbe2ea; border:1px solid #3a414e; border-radius:4px; padding:5px 10px; cursor:pointer; font-size:12px; }
.gt-toolbar button:hover { background:#363d48; }
.gt-toolbar button.primary { background:#3b82f6; border-color:#3b82f6; color:#fff; }
.gt-toolbar button.primary:hover { background:#2563eb; }
.gt-toolbar button:disabled { opacity:.4; cursor:not-allowed; }
.gt-toolbar .gt-spacer { flex:1; }
.gt-search { display:flex; align-items:center; gap:4px; }
.gt-search-in { background:#13161a; color:#dbe2ea; border:1px solid #3a414e; border-radius:4px; padding:5px 8px; font-size:12px; width:170px; }
.gt-search-in::placeholder { color:#7c8694; }
.gt-search-x { background:#2b313a; color:#dbe2ea; border:1px solid #3a414e; border-radius:4px; padding:4px 8px; cursor:pointer; font-size:11px; line-height:1; }
.gt-search-x:hover { background:#3a414e; }
.gt-body { display:flex; flex:1; min-height:0; overflow:hidden; }
.gt-tree { width:230px; min-width:160px; max-width:50%; overflow:auto; border-right:1px solid #303540; padding:6px 4px; resize:horizontal; }
.gt-grid-wrap { flex:1; overflow:auto; padding:8px 8px 52px 8px; }
.gt-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(160px,1fr)); gap:10px; }
.gt-breadcrumb { padding:4px 4px 8px 4px; opacity:.75; font-size:12px; }
.gt-breadcrumb .crumb { cursor:pointer; }
.gt-breadcrumb .crumb:hover { text-decoration:underline; }
.gt-tnode { display:flex; align-items:center; padding:3px 4px; gap:4px; border-radius:4px; cursor:pointer; user-select:none; }
.gt-tnode:hover { background:#2b313a; }
.gt-tnode.active { background:#3b82f6; color:#fff; }
.gt-tnode .twirl { width:14px; height:14px; display:inline-flex; justify-content:center; align-items:center; opacity:.6; }
.gt-tnode .icon  { width:14px; opacity:.75; }
.gt-tnode .label { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.gt-tnode.drop-target { outline:2px dashed #3b82f6; outline-offset:-2px; }
.gt-tchildren { margin-left:14px; }
.gt-card { background:#262b34; border:1px solid #353c47; border-radius:6px; overflow:hidden; cursor:pointer; display:flex; flex-direction:column; position:relative; transition:transform .08s, border-color .12s; }
.gt-grid .gt-card:hover { border-color:#3b82f6; box-shadow:0 0 0 2px rgba(59,130,246,.35); transform:translateY(-1px); }
.gt-card.selected { border-color:#3b82f6; box-shadow:0 0 0 2px rgba(59,130,246,.35); }
.gt-card.loaded { border-color:#22c55e; box-shadow:0 0 0 2px rgba(34,197,94,.25); }
.gt-card.cut { opacity:.45; }
.gt-card .thumb { position:relative; aspect-ratio:16/9; background:#181b21 center/cover no-repeat; display:flex; align-items:center; justify-content:center; color:#555; font-size:11px; }
.gt-fav { display:inline-flex; align-items:center; justify-content:center; width:22px; height:22px; font-size:15px; line-height:1; cursor:pointer; color:transparent; -webkit-text-stroke:1.4px #d8dde6; text-shadow:0 1px 2px rgba(0,0,0,.6); user-select:none; flex:none; transition:transform .08s; }
.gt-fav.on { color:#ffd400; -webkit-text-stroke:1.4px #ffd400; }
.gt-fav:hover { transform:scale(1.18); }
.gt-card > .gt-fav { position:absolute; bottom:6px; right:6px; width:calc(39px * var(--gt-fav-scale,1)); height:calc(39px * var(--gt-fav-scale,1)); font-size:calc(27px * var(--gt-fav-scale,1)); z-index:2; }
.gt-row .col-name { display:flex; align-items:center; gap:5px; overflow:visible; }
.gt-row .col-name .gt-rowname { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.gt-card .meta { padding:6px calc(39px * var(--gt-fav-scale,1) + 14px) 6px 8px; }
.gt-card .name { font-size:12px; word-break:break-word; }
.gt-card .date { font-size:12px; opacity:.55; margin-top:2px; }
.gt-card .desc { font-size:12px; color:#ffe14d; opacity:1; margin-top:3px; line-height:1.3; min-height:2.6em; max-height:2.6em; overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; word-break:break-word; }
.gt-card.drop-target { outline:2px dashed #f59e0b; outline-offset:-2px; }
.gt-empty { padding:16px; opacity:.6; text-align:center; }
.gt-grid.gt-aslist { display:block; }
.gt-lhead, .gt-row { display:grid; grid-template-columns:var(--gt-lcols, 220px 170px 300px 260px 90px); gap:10px; align-items:center; padding:6px 8px; }
.gt-grid.gt-aslist .gt-lhead, .gt-grid.gt-aslist .gt-row { min-width:var(--gt-lminw, 1040px); box-sizing:border-box; }
.gt-lhead { position:sticky; top:0; background:#1f242b; font-weight:600; opacity:.85; border-bottom:1px solid #353c47; z-index:1; }
.gt-lhead .col { position:relative; }
.gt-lhead .col.sortable { cursor:pointer; user-select:none; }
.gt-lhead .col.sortable:hover { color:#fff; }
.gt-lhead .col .sort-ind { margin-left:6px; font-size:10px; color:#3b82f6; opacity:.85; }
.gt-lhead .col .col-grip { position:absolute; top:0; right:-5px; width:10px; height:100%; cursor:col-resize; z-index:2; }
.gt-lhead .col .col-grip::after { content:""; position:absolute; top:4px; bottom:4px; left:4px; width:1px; background:#3a414e; }
.gt-lhead .col .col-grip:hover::after { background:#3b82f6; width:2px; }
.gt-row { border-bottom:1px solid #2a2f38; cursor:pointer; }
.gt-list .gt-row:hover { background:#2a313b; }
.gt-row.selected { background:rgba(59,130,246,.20); }
.gt-row.loaded { box-shadow:inset 3px 0 0 #22c55e; }
.gt-row.cut { opacity:.45; }
.gt-row.drop-target { outline:2px dashed #f59e0b; outline-offset:-2px; }
.gt-row .col, .gt-lhead .col { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px; }
.gt-row .col-size, .gt-lhead .col-size { text-align:right; opacity:.85; }
.gt-row .col-desc { align-self:stretch; }   /* keep empty desc cells clickable for dblclick */
.gt-grid.gt-aslist .gt-row .col, .gt-grid.gt-aslist .gt-lhead .col { font-size:var(--gt-lfont,12px); }
.gt-menu { position:fixed; background:#20242c; border:1px solid #3a414e; border-radius:6px; padding:4px 0; box-shadow:0 6px 24px rgba(0,0,0,.45); z-index:9999; min-width:180px; color:#dbe2ea; font:13px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
.gt-menu .item { padding:6px 14px; cursor:pointer; font-size:13px; }
.gt-menu .item:hover { background:#3b82f6; color:#fff; }
.gt-menu .item.danger { color:#fca5a5; }
.gt-menu .item.danger:hover { background:#dc2626; color:#fff; }
.gt-menu .sep { height:1px; background:#3a414e; margin:4px 0; }
.gt-menu .item.disabled { opacity:.4; pointer-events:none; }
.gt-modal-bg { position:fixed; inset:0; background:rgba(0,0,0,.6); z-index:10000; display:flex; align-items:center; justify-content:center; }
.gt-modal { background:#1d2128; border:1px solid #3a414e; border-radius:8px; max-width:520px; width:90%; max-height:80vh; display:flex; flex-direction:column; }
.gt-modal h3 { margin:0; padding:12px 16px; border-bottom:1px solid #303540; font-size:14px; }
.gt-modal .body { padding:14px 16px; overflow:auto; }
.gt-modal pre { white-space:pre-wrap; word-break:break-all; background:#13161a; padding:8px; border-radius:4px; max-height:200px; overflow:auto; font-size:11px; }
.gt-modal input[type=text] { width:100%; background:#13161a; color:#dbe2ea; border:1px solid #3a414e; border-radius:4px; padding:6px 8px; font-size:13px; }
.gt-modal textarea { width:100%; box-sizing:border-box; min-height:120px; resize:vertical; background:#13161a; color:#dbe2ea; border:1px solid #3a414e; border-radius:4px; padding:6px 8px; font:13px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
.gt-modal .row { display:flex; gap:8px; padding:10px 16px; justify-content:flex-end; border-top:1px solid #303540; }
.gt-modal .row button { background:#2b313a; color:#dbe2ea; border:1px solid #3a414e; border-radius:4px; padding:6px 14px; cursor:pointer; }
.gt-modal .row button.primary { background:#3b82f6; border-color:#3b82f6; color:#fff; }
.gt-modal .row button.danger  { background:#dc2626; border-color:#dc2626; color:#fff; }
.gt-modal .picker-tree { max-height:260px; overflow:auto; background:#13161a; border:1px solid #303540; border-radius:4px; padding:4px; }
.gt-modal .label-row { margin-bottom:6px; font-size:12px; opacity:.75; }
.gt-modal .preview { margin-top:8px; font-size:11px; opacity:.6; word-break:break-all; }
.gt-toast { position:fixed; bottom:30px; left:50%; transform:translateX(-50%); background:#1d2128; border:1px solid #3b82f6; color:#fff; padding:8px 16px; border-radius:6px; box-shadow:0 4px 18px rgba(0,0,0,.5); z-index:10001; font-size:12px; }
.gt-zoom { position:absolute; right:14px; bottom:12px; z-index:50; display:flex; align-items:center; gap:8px; background:rgba(29,33,40,.9); border:1px solid #3a414e; border-radius:6px; padding:6px 10px; font-size:11px; color:#cbd5e1; box-shadow:0 4px 14px rgba(0,0,0,.45); }
.gt-zoom input[type=range] { width:120px; cursor:pointer; }
.gt-zoom .pct { width:34px; text-align:right; opacity:.8; }
.gt-tnode.gt-troot { font-weight:600; }
.gt-tnode.gt-troot-extra .label { color:#e8b04b; }
.gt-tnode.gt-troot-extra.active .label { color:#fff; }
.gt-tnode.gt-offline { opacity:.5; cursor:default; }
.gt-tnode.gt-offline:hover { background:transparent; }
.gt-fb-crumbs { display:flex; flex-wrap:wrap; align-items:center; gap:0; word-break:break-all; }
.gt-fb-crumbs .crumb { cursor:pointer; color:#9ec1ff; }
.gt-fb-crumbs .crumb:hover { text-decoration:underline; }
.gt-fb-go { display:flex; gap:6px; margin:8px 0; }
.gt-fb-go input[type=text] { flex:1; background:#13161a; color:#dbe2ea; border:1px solid #3a414e; border-radius:4px; padding:6px 8px; font-size:12px; }
.gt-fb-go button { background:#2b313a; color:#dbe2ea; border:1px solid #3a414e; border-radius:4px; padding:6px 12px; cursor:pointer; }
.gt-fb-chips { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:8px; }
.gt-chip { background:#2b313a; color:#dbe2ea; border:1px solid #3a414e; border-radius:4px; padding:4px 10px; cursor:pointer; font-size:12px; }
.gt-chip:hover { background:#363d48; }
.gt-fb-err { min-height:16px; margin-top:6px; color:#fca5a5; font-size:12px; }
`;
function injectCSS() {
  if (doc.getElementById("gt-css")) return;
  const s = doc.createElement("style");
  s.id = "gt-css";
  s.textContent = CSS;
  doc.head.appendChild(s);
}

// ─────────────────────────────────────────────────────────────────────────────
// Toast / modals
// ─────────────────────────────────────────────────────────────────────────────
let toastTimer = 0;
function toast(msg) {
  let t = doc.getElementById("gt-toast");
  if (!t) { t = el("div", { id: "gt-toast", class: "gt-toast" }); doc.body.appendChild(t); }
  t.textContent = msg;
  t.style.display = "block";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.style.display = "none"; }, 2400);
}

function buildModalShell(title) {
  const bg    = el("div", { class: "gt-modal-bg" });
  const modal = el("div", { class: "gt-modal" });
  const h     = el("h3");  h.textContent = title;
  const body  = el("div", { class: "body" });
  const row   = el("div", { class: "row" });
  modal.appendChild(h);
  modal.appendChild(body);
  modal.appendChild(row);
  bg.appendChild(modal);
  return { bg, body, row };
}

function modalPromise(bg, row, onClose) {
  return new Promise((resolve) => {
    const close = (val) => {
      bg.remove();
      doc.removeEventListener("keydown", onKey);
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); close(null); }
      else if (e.key === "Enter" && !e.shiftKey) {
        const p = row.querySelector("button.primary");
        if (p) { e.preventDefault(); p.click(); }
      }
    };
    doc.addEventListener("keydown", onKey);
    // Click-outside closes — but ONLY if the press AND release both land on
    // the backdrop. An internal drag that releases outside the modal (e.g.
    // pulling the textarea's resize grip past the modal edge, or selecting
    // text and overshooting) would otherwise dispatch the click event on bg
    // and close the modal unexpectedly.
    let mouseDownTarget = null;
    bg.addEventListener("mousedown", (e) => { mouseDownTarget = e.target; });
    bg.addEventListener("click", (e) => {
      const wasOutside = e.target === bg && mouseDownTarget === bg;
      mouseDownTarget = null;
      if (wasOutside) close(null);
    });
    onClose(close);
    doc.body.appendChild(bg);
  });
}

async function confirmModal(title, message) {
  const { bg, body, row } = buildModalShell(title);
  const pre = el("pre"); pre.textContent = message; body.appendChild(pre);
  let resolveFn = null;
  const cancel  = el("button");           cancel.textContent  = "Cancel";
  const confirm = el("button", { class: "primary danger" });
  confirm.textContent = "Confirm";
  row.appendChild(cancel); row.appendChild(confirm);
  return modalPromise(bg, row, (close) => {
    cancel.addEventListener("click",  () => close(false));
    confirm.addEventListener("click", () => close(true));
  });
}

// Right-click "Overwrite…": write the CURRENT active ComfyUI workflow onto an
// existing file, after a Yes/No/Cancel confirmation. Reuses doSaveTo (the same
// serialize + /save call the toolbar Save uses) with overwrite=true. Only Yes
// proceeds; No, Cancel, Esc and click-outside all abort.
async function overwriteWorkflow(filePath) {
  const { bg, body, row } = buildModalShell("Overwrite workflow?");
  const pre = el("pre");
  pre.textContent =
    `Replace this file with the CURRENT workflow?\n\n"${filePath}"\n\n` +
    `Yes = overwrite this file  ·  No = open "Save As…" instead  ·  Cancel = do nothing\n\n` +
    `Overwriting replaces the file on disk and cannot be undone.`;
  body.appendChild(pre);
  const yes    = el("button", { class: "primary danger" }); yes.textContent    = "Yes";
  const no     = el("button");                               no.textContent     = "No";
  const cancel = el("button");                               cancel.textContent = "Cancel";
  row.appendChild(yes); row.appendChild(no); row.appendChild(cancel);
  const choice = await modalPromise(bg, row, (close) => {
    yes.addEventListener("click",    () => close("yes"));
    no.addEventListener("click",     () => close("no"));
    cancel.addEventListener("click", () => close("cancel"));
  });
  if (choice === "yes")      await doSaveTo(filePath, true, state.rootId);
  else if (choice === "no")  await clickSaveAs();        // open the Save As… picker
  // "cancel" / Esc / backdrop → do nothing
}

async function promptModal(title, label, defaultValue) {
  const { bg, body, row } = buildModalShell(title);
  const labelRow = el("div", { class: "label-row" }); labelRow.textContent = label;
  const input = el("input", { attrs: { type: "text" } });
  input.value = defaultValue || "";
  body.appendChild(labelRow);
  body.appendChild(input);
  const cancel = el("button"); cancel.textContent = "Cancel";
  const ok     = el("button", { class: "primary" }); ok.textContent = "OK";
  row.appendChild(cancel); row.appendChild(ok);
  setTimeout(() => { input.focus(); input.select(); }, 0);
  return modalPromise(bg, row, (close) => {
    cancel.addEventListener("click", () => close(null));
    ok.addEventListener("click",     () => close(input.value));
  });
}

async function descModal(title, current) {
  const { bg, body, row } = buildModalShell(title);
  const labelRow = el("div", { class: "label-row" });
  labelRow.textContent = "Description (leave empty to clear) — Ctrl+Enter to save:";
  const ta = el("textarea", { attrs: { rows: "6" } });
  ta.value = current || "";
  body.appendChild(labelRow);
  body.appendChild(ta);
  const cancel = el("button"); cancel.textContent = "Cancel";
  const ok     = el("button", { class: "primary" }); ok.textContent = "Save";
  row.appendChild(cancel); row.appendChild(ok);
  setTimeout(() => { ta.focus(); ta.select(); }, 0);
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); ok.click(); }
    else if (e.key === "Enter") { e.stopPropagation(); } // newline, don't submit
  });
  return modalPromise(bg, row, (close) => {
    cancel.addEventListener("click", () => close(null));
    ok.addEventListener("click",     () => close(ta.value));
  });
}

// v0 of the tags editor: a textarea, one tag per line. Tasks 7-8 replace
// this with a chip input + autocomplete; the editTags() caller, the
// shape of the returned value (array of strings), and the modalPromise
// plumbing all stay the same.
async function tagsModal(title, currentTags) {
  const { bg, body, row } = buildModalShell(title);
  const labelRow = el("div", { class: "label-row" });
  labelRow.textContent = "One tag per line — saved lowercased & de-duplicated:";
  const ta = el("textarea", { attrs: { rows: "8" } });
  ta.value = (currentTags || []).join("\n");
  body.appendChild(labelRow);
  body.appendChild(ta);
  const cancel = el("button"); cancel.textContent = "Cancel";
  const ok     = el("button", { class: "primary" }); ok.textContent = "Save";
  row.appendChild(cancel); row.appendChild(ok);
  setTimeout(() => { ta.focus(); ta.select(); }, 0);
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); ok.click(); }
    else if (e.key === "Enter") { e.stopPropagation(); } // newline, don't submit
  });
  return modalPromise(bg, row, (close) => {
    cancel.addEventListener("click", () => close(null));
    ok.addEventListener("click",     () => {
      // Parse: split on lines, trim, lowercase, drop blanks, de-dupe (preserve order).
      const seen = new Set();
      const out  = [];
      for (const line of (ta.value || "").split(/\r?\n/)) {
        const s = line.trim().toLowerCase();
        if (!s || seen.has(s)) continue;
        seen.add(s);
        out.push(s);
      }
      close(out);
    });
  });
}

async function pickerModal({ title, startFolder, startName }) {
  let selectedFolder = startFolder || "";
  const { bg, body, row } = buildModalShell(title);
  const folderLabelRow = el("div", { class: "label-row" }); folderLabelRow.textContent = "Folder:";
  const treeBox        = el("div", { class: "picker-tree" });
  const filesLabelRow  = el("div", { class: "label-row", style: { marginTop: "10px" } });
  filesLabelRow.textContent = "Existing files in this folder (click to use the name):";
  const filesBox       = el("div", { class: "picker-tree" });
  const nameLabelRow   = el("div", { class: "label-row", style: { marginTop: "10px" } }); nameLabelRow.textContent = "Filename:";
  const nameInput      = el("input", { attrs: { type: "text" } }); nameInput.value = startName || "";
  const preview        = el("div", { class: "preview" });
  body.appendChild(folderLabelRow);
  body.appendChild(treeBox);
  body.appendChild(filesLabelRow);
  body.appendChild(filesBox);
  body.appendChild(nameLabelRow);
  body.appendChild(nameInput);
  body.appendChild(preview);
  const rootLabel = () => {
    const r0 = currentRoot();
    return r0 ? (r0.id === "default" ? "workflows" : (r0.label || r0.abspath)) : "workflows";
  };
  function updatePreview() {
    const base = selectedFolder ? selectedFolder : rootLabel();
    preview.textContent = `${base}/${nameInput.value}`;
  }
  function renderPickerTree() {
    clear(treeBox);
    const renderNode = (node, depth) => {
      const r = el("div", { class: "gt-tnode" + (selectedFolder === node.path ? " active" : "") });
      r.style.paddingLeft = (depth * 12 + 4) + "px";
      const icon  = el("span", { class: "icon" });  icon.textContent = "📁";
      const lab   = el("span", { class: "label" });
      lab.textContent = node.name || `(${rootLabel()} root)`;
      r.appendChild(icon); r.appendChild(lab);
      r.addEventListener("click", () => { selectedFolder = node.path; renderPickerTree(); renderFilesList(); updatePreview(); });
      treeBox.appendChild(r);
      for (const sub of (node.folders || [])) renderNode(sub, depth + 1);
    };
    const r0 = currentRoot();
    if (r0 && r0.tree) renderNode(r0.tree, 0);
  }
  // Existing .json files in the currently-selected folder. Clicking a row
  // copies the filename into nameInput so Save targets that file — the
  // existing clickSaveAs `exists` check + confirmModal handle the actual
  // overwrite prompt. Backend already filters out dotfiles + non-.json,
  // so `.desc.txt` / `.fav` sidecars never appear here.
  function renderFilesList() {
    clear(filesBox);
    const folder = findFolderNode(state.rootId, selectedFolder);
    const files  = (folder && folder.files) || [];
    if (!files.length) {
      const empty = el("div", { class: "gt-empty", style: { padding: "8px", fontSize: "11px", textAlign: "left" } });
      empty.textContent = "(no workflows in this folder)";
      filesBox.appendChild(empty);
      return;
    }
    const current = (nameInput.value || "").trim().toLowerCase();
    const sorted  = files.slice().sort((a, b) =>
      (a.name || baseName(a.path)).localeCompare(b.name || baseName(b.path), undefined, { sensitivity: "base" }));
    for (const f of sorted) {
      const fname = f.name || baseName(f.path);
      const r = el("div", { class: "gt-tnode" + (fname.toLowerCase() === current ? " active" : "") });
      r.appendChild(el("span", { class: "icon", text: "📄" }));
      r.appendChild(el("span", { class: "label", text: fname }));
      r.addEventListener("click", () => {
        nameInput.value = fname;
        renderFilesList(); updatePreview();
      });
      filesBox.appendChild(r);
    }
  }
  renderPickerTree();
  renderFilesList();
  nameInput.addEventListener("input", () => { renderFilesList(); updatePreview(); });
  updatePreview();
  const cancel = el("button"); cancel.textContent = "Cancel";
  const newF   = el("button"); newF.textContent   = "New folder…";
  const save   = el("button", { class: "primary" }); save.textContent = "Save";
  row.appendChild(cancel); row.appendChild(newF); row.appendChild(save);
  setTimeout(() => { nameInput.focus(); nameInput.select(); }, 0);
  return modalPromise(bg, row, (close) => {
    cancel.addEventListener("click", () => close(null));
    newF.addEventListener("click", async () => {
      const name = await promptModal("New folder", "Folder name:", "New Folder");
      if (!name) return;
      try {
        await apiPost("/mkdir", { path: selectedFolder, name: name.trim(), root: state.rootId });
        await refreshTree();
        selectedFolder = `${selectedFolder ? selectedFolder + "/" : ""}${name.trim()}`;
        renderPickerTree(); renderFilesList(); updatePreview();
      } catch (e) { toast("Create folder failed: " + e.message); }
    });
    save.addEventListener("click", () => {
      const fname = nameInput.value.trim();
      if (!fname) return;
      close({ path: `${selectedFolder ? selectedFolder + "/" : ""}${fname}` });
    });
  });
}

// Server-side folder browser: navigate the ComfyUI host's filesystem and
// register the chosen folder as an additional workflow root. fs_list is NOT
// sandboxed (you're choosing WHERE to register); add_root creates the
// allowlist entry that every subsequent file op is confined to.
async function openFolderBrowser() {
  const { bg, body, row } = buildModalShell("Add a workflow location");
  const crumbs  = el("div", { class: "label-row gt-fb-crumbs" });
  const goWrap  = el("div", { class: "gt-fb-go" });
  const goInput = el("input", { attrs: { type: "text",
    placeholder: "Paste a full path (incl. \\\\server\\share) then Go" } });
  const goBtn   = el("button"); goBtn.textContent = "Go";
  goWrap.appendChild(goInput); goWrap.appendChild(goBtn);
  const chips   = el("div", { class: "gt-fb-chips" });
  const listBox = el("div", { class: "picker-tree" });
  const errLine = el("div", { class: "gt-fb-err" });
  const preview = el("div", { class: "preview" });
  body.appendChild(crumbs);
  body.appendChild(goWrap);
  body.appendChild(chips);
  body.appendChild(listBox);
  body.appendChild(errLine);
  body.appendChild(preview);

  let cur = (state.roots[0] && state.roots[0].abspath) || "";

  function renderCrumbs() {
    clear(crumbs);
    if (!cur) return;
    const parts = cur.replace(/\//g, "\\").split("\\");
    let acc = "";
    parts.forEach((p, i) => {
      if (i > 0) crumbs.appendChild(doc.createTextNode("  \\  "));
      acc = i === 0 ? (p + "\\") : (acc.replace(/\\+$/, "") + "\\" + p);
      const seg = acc;
      const c = el("span", { class: "crumb", text: p || seg });
      c.addEventListener("click", () => navigate(seg));
      crumbs.appendChild(c);
    });
  }
  function setPreview() {
    preview.textContent = cur ? ("Will register:  " + cur) : "Pick a folder to register";
  }
  const STALE_BACKEND_MSG =
    "G-Workflows backend is out of date. Fully restart the ComfyUI server " +
    "(not just the browser) — custom-node Python is not hot-reloaded.";
  async function navigate(path) {
    let data;
    try {
      const r = await fetch(API_BASE + "/fs_list?path=" + encodeURIComponent(path));
      if (r.status === 404 || r.status === 405) {
        // The new fs_list route is missing ⇒ the running server still has the
        // pre-multi-root __init__.py. Tell the user the real cause.
        data = { success: false, error: STALE_BACKEND_MSG, entries: [], parent: null, path };
      } else {
        data = await r.json();
      }
    } catch (e) {
      data = { success: false, error: String(e), entries: [], parent: null, path };
    }
    if (data.success) { cur = data.path; errLine.textContent = ""; }
    else { errLine.textContent = data.error || "Could not open folder"; if (data.path) cur = data.path; }
    clear(listBox);
    if (data.parent) {
      const up = el("div", { class: "gt-tnode" });
      up.appendChild(el("span", { class: "icon", text: "⤴" }));
      up.appendChild(el("span", { class: "label", text: ".. (up one level)" }));
      up.addEventListener("click", () => navigate(data.parent));
      listBox.appendChild(up);
    }
    for (const ent of (data.entries || [])) {
      const er = el("div", { class: "gt-tnode" + (ent.hidden ? " gt-offline" : "") });
      er.appendChild(el("span", { class: "icon", text: "📁" }));
      er.appendChild(el("span", { class: "label", text: ent.name }));
      er.addEventListener("click", () => navigate(ent.path));
      listBox.appendChild(er);
    }
    if (data.truncated)
      listBox.appendChild(el("div", { class: "gt-empty", text: "(listing truncated at 5000 folders)" }));
    renderCrumbs(); setPreview();
  }

  try {
    const fr = await apiGet("/fs_roots");
    for (const d of (fr.drives || [])) {
      const ch = el("button", { class: "gt-chip", text: d.label });
      ch.addEventListener("click", () => navigate(d.path));
      chips.appendChild(ch);
    }
    for (const s of (fr.shortcuts || [])) {
      const ch = el("button", { class: "gt-chip", text: s.label });
      ch.addEventListener("click", () => navigate(s.path));
      chips.appendChild(ch);
    }
  } catch (_) {}

  goBtn.addEventListener("click", () => { const v = goInput.value.trim(); if (v) navigate(v); });
  goInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); goBtn.click(); }
  });

  const cancel = el("button"); cancel.textContent = "Cancel";
  const add    = el("button", { class: "primary" }); add.textContent = "Add this folder";
  row.appendChild(cancel); row.appendChild(add);

  await navigate(cur);

  return modalPromise(bg, row, (close) => {
    cancel.addEventListener("click", () => close(null));
    add.addEventListener("click", async () => {
      if (!cur) return;
      try {
        const res = await apiPost("/add_root", { path: cur });
        await refreshTree();
        if (res.root && res.root.id) {
          state.rootId = res.root.id;
          state.currentPath = "";
          state.selection.clear();
          state.expanded.add(ekey(state.rootId, ""));
          saveLS();
        }
        renderAll();
        toast("Location added");
        close(true);
      } catch (e) {
        const msg = /(^|\D)(404|405)(\D|$)|Not Found|Method Not Allowed/.test(e.message)
          ? STALE_BACKEND_MSG : e.message;
        errLine.textContent = msg;
        toast(msg);
      }
    });
  });
}

async function removeRoot(rootId) {
  if (rootId === "default") return;
  const r = rootEntry(rootId);
  const label = r ? (r.label || r.abspath) : rootId;
  const ok = await confirmModal("Remove location",
    `Remove "${label}" from the gallery?\n\n` +
    `This only unregisters the location. No files on disk are deleted.`);
  if (!ok) return;
  try {
    await apiPost("/remove_root", { id: rootId });
    if (state.rootId === rootId) {
      state.rootId = "default";
      state.currentPath = "";
      state.selection.clear();
    }
    if (state.loadedRootId === rootId) {
      state.loadedSourcePath = null;
      state.loadedRootId = null;
    }
    if (state.clipboard && state.clipboard.root === rootId) state.clipboard = null;
    saveLS();
    await refreshTree(); renderAll();
    toast("Location removed (files left on disk)");
  } catch (e) { toast("Remove failed: " + e.message); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Context menu
// ─────────────────────────────────────────────────────────────────────────────
let activeMenu = null;
function closeMenu() { if (activeMenu) { activeMenu.remove(); activeMenu = null; } }
// Bound to the panel's document when the standalone window opens (listeners
// die with the popup). The panel only ever lives in that window now.
function bindMenuDocListeners(targetDoc) {
  targetDoc.addEventListener("click", closeMenu);
  targetDoc.addEventListener("contextmenu", (e) => { if (!e.target.closest(".gt-card,.gt-tnode,.gt-grid-wrap")) closeMenu(); }, true);
}

function showMenu(x, y, items) {
  closeMenu();
  const menu = el("div", { class: "gt-menu" });
  for (const it of items) {
    if (it === "sep") { menu.appendChild(el("div", { class: "sep" })); continue; }
    const cls = "item" + (it.danger ? " danger" : "") + (it.disabled ? " disabled" : "");
    const item = el("div", { class: cls });
    item.textContent = it.label;
    item.addEventListener("click", (e) => { e.stopPropagation(); closeMenu(); if (!it.disabled && it.action) it.action(); });
    menu.appendChild(item);
  }
  menu.style.left = x + "px";
  menu.style.top  = y + "px";
  doc.body.appendChild(menu);
  activeMenu = menu;
  const view = doc.defaultView || window;
  const rect = menu.getBoundingClientRect();
  if (rect.right > view.innerWidth)   menu.style.left = (view.innerWidth - rect.width - 6) + "px";
  if (rect.bottom > view.innerHeight) menu.style.top  = (view.innerHeight - rect.height - 6) + "px";
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────
let panelEl = null, toolbarEl = null, treeEl = null, gridEl = null, breadcrumbEl = null;
let zoomSlider = null, zoomLabel = null;
function applyCardScale() {
  if (gridEl) gridEl.style.gridTemplateColumns =
    "repeat(auto-fill,minmax(" + Math.round(CARD_BASE * state.cardScale) + "px,1fr))";
  if (gridEl) gridEl.style.setProperty("--gt-fav-scale", String(Math.max(1, state.cardScale)));
  if (zoomLabel) zoomLabel.textContent = Math.round(state.cardScale * 100) + "%";
}

// List view single source of truth for column widths: push state.listColW into
// a CSS custom property on gridEl. Both .gt-lhead and every .gt-row inherit it
// (grid-template-columns:var(--gt-lcols)), so header and rows stay aligned with
// no per-row inline styles. --gt-lminw (widths + 4 gaps + row padding) keeps
// both grids the same width so they scroll together horizontally.
function applyListCols() {
  if (!gridEl) return;
  const w = (Array.isArray(state.listColW) && state.listColW.length === 5)
    ? state.listColW : LIST_COL_DEFAULT.slice();
  const px = w.map(n => Math.max(LIST_COL_MIN, Math.round(n)));
  gridEl.style.setProperty("--gt-lcols", px.map(n => n + "px").join(" "));
  gridEl.style.setProperty("--gt-lminw", (px.reduce((s, n) => s + n, 0) + 4 * 10 + 2 * 8) + "px");
}

// The lower-right size slider scales List-view text too (shared cardScale):
// base 12px × scale, clamped 8–30px, exposed as the --gt-lfont CSS var.
function applyListFont() {
  if (!gridEl) return;
  const px = Math.max(8, Math.min(30, Math.round(12 * (state.cardScale || 1))));
  gridEl.style.setProperty("--gt-lfont", px + "px");
}

function buildPanel(host) {
  injectCSS();
  clear(host);
  host.style.overflow = "hidden";
  panelEl    = el("div", { class: "gt-root" });
  toolbarEl  = el("div", { class: "gt-toolbar" });
  const body = el("div", { class: "gt-body" });
  treeEl     = el("div", { class: "gt-tree" });
  const gridWrap = el("div", { class: "gt-grid-wrap" });
  breadcrumbEl = el("div", { class: "gt-breadcrumb" });
  gridEl       = el("div", { class: "gt-grid" });
  gridWrap.appendChild(breadcrumbEl);
  gridWrap.appendChild(gridEl);
  body.appendChild(treeEl);
  body.appendChild(gridWrap);
  panelEl.appendChild(toolbarEl);
  panelEl.appendChild(body);

  // Lower-right icon-size slider (0.25×–2.5×). Built once here so renderAll,
  // which only repopulates toolbar/tree/grid, never wipes it.
  zoomLabel  = el("span", { class: "pct" });
  zoomSlider = el("input", { attrs: { type: "range", min: "0.25", max: "2.5", step: "0.05" } });
  zoomSlider.value = state.cardScale;
  zoomSlider.addEventListener("input", () => {
    state.cardScale = parseFloat(zoomSlider.value);
    applyCardScale(); applyListFont(); saveLS();
  });
  zoomSlider.addEventListener("dblclick", () => {
    state.cardScale = 1; zoomSlider.value = 1;
    applyCardScale(); applyListFont(); saveLS();
  });
  const zoom = el("div", { class: "gt-zoom" }, el("span", {}, "Size"), zoomSlider, zoomLabel);
  panelEl.appendChild(zoom);

  host.appendChild(panelEl);
  state.panelMounted = true;
}

function renderToolbar() {
  if (!toolbarEl) return;
  clear(toolbarEl);
  const cbCount = state.clipboard ? state.clipboard.items.length : 0;
  const cbLabel = cbCount ? `Paste (${cbCount}) here` : "Paste";
  const selCount = state.selection.size;
  const mk = (label, onClick, opts = {}) => {
    const b = el("button");
    b.textContent = label;
    if (opts.primary) b.classList.add("primary");
    if (opts.disabled) b.disabled = true;
    b.addEventListener("click", onClick);
    return b;
  };
  const addLocBtn = mk("Add location…", openFolderBrowser);
  addLocBtn.title = "Register another folder on this PC as a workflow location";
  toolbarEl.appendChild(addLocBtn);
  toolbarEl.appendChild(mk("New folder", () => mkFolder(state.rootId, state.currentPath)));
  const loadBtn = mk("Load", () => {
    const sel = Array.from(state.selection);
    if (sel.length === 1) loadWorkflow(sel[0]).then(() => { renderGrid(); renderToolbar(); });
  }, { disabled: state.selection.size !== 1 });
  loadBtn.title = "Load the selected workflow";
  toolbarEl.appendChild(loadBtn);
  toolbarEl.appendChild(mk("Save", clickSave, { primary: true, disabled: !saveTarget() }));
  toolbarEl.appendChild(mk("Save As…", () => clickSaveAs()));
  const favBtn = mk("Favorites", () => {
    state.favoritesOnly = !state.favoritesOnly;
    saveLS();
    renderAll();
  }, { primary: state.favoritesOnly });
  favBtn.title = "Show only favorited workflows (★)";
  toolbarEl.appendChild(favBtn);
  toolbarEl.appendChild(el("div", { class: "gt-spacer" }));
  if (!state.listView) {
    const cs = Array.isArray(state.cardSort) ? state.cardSort : [];
    const lvl = (k) => cs.find((s) => s.key === k);
    const nameLv = lvl("name");
    const nameBtn = mk(
      nameLv ? (nameLv.dir === "asc" ? "A to Z" : "Z to A") : "Name",
      () => cycleCardSort("name"),
      { primary: !!nameLv },
    );
    nameBtn.title = "Sort thumbnails by filename — click cycles: A to Z → Z to A → off";
    toolbarEl.appendChild(nameBtn);
    const dateLv = lvl("date");
    const dateBtn = mk(
      dateLv ? (dateLv.dir === "asc" ? "Newest" : "Oldest") : "Date",
      () => cycleCardSort("date"),
      { primary: !!dateLv },
    );
    dateBtn.title = "Sort thumbnails by date — click cycles: Newest → Oldest → off";
    toolbarEl.appendChild(dateBtn);
  }
  const searchWrap = el("div", { class: "gt-search" });
  const searchInput = el("input", { class: "gt-search-in", attrs: { type: "text", placeholder: "Search…" } });
  searchInput.value = state.searchQuery || "";
  searchInput.title = "Filter visible workflows by filename (current folder, respects Subfolders and Favorites)";
  const clearX = el("button", { class: "gt-search-x", text: "✕", attrs: { title: "Clear search" } });
  clearX.style.display = state.searchQuery ? "" : "none";
  const clearSearch = () => {
    state.searchQuery = ""; searchInput.value = ""; clearX.style.display = "none"; renderGrid();
  };
  searchInput.addEventListener("input", () => {
    state.searchQuery = searchInput.value;
    clearX.style.display = searchInput.value ? "" : "none";
    renderGrid();   // NOT renderToolbar — keep the input focused while typing
  });
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); clearSearch(); }
  });
  clearX.addEventListener("click", () => { clearSearch(); searchInput.focus(); });
  searchWrap.appendChild(searchInput);
  searchWrap.appendChild(clearX);
  toolbarEl.appendChild(searchWrap);
  const subBtn = mk("Subfolders", () => {
    state.recurseSubfolders = !state.recurseSubfolders;
    saveLS();
    renderAll();
  }, { primary: state.recurseSubfolders });
  subBtn.title = "Show workflows from this folder and all its subfolders";
  toolbarEl.appendChild(subBtn);
  const listBtn = mk("List", () => {
    state.listView = !state.listView;
    saveLS();
    renderAll();
  }, { primary: state.listView });
  listBtn.title = "Show workflows as a details list (Name, Date, Description, Path, Size)";
  toolbarEl.appendChild(listBtn);
  toolbarEl.appendChild(mk(cbLabel, pasteHere, { disabled: cbCount === 0 }));
  toolbarEl.appendChild(mk(`Delete (${selCount})`, () => deleteFiles(Array.from(state.selection)), { disabled: selCount === 0 }));
  toolbarEl.appendChild(mk("Refresh", async () => { await refreshTree(); renderAll(); }));
}

function renderBreadcrumb() {
  if (!breadcrumbEl) return;
  clear(breadcrumbEl);
  const rootId = state.rootId;
  const r0 = currentRoot();
  const root = el("span", { class: "crumb" });
  root.textContent = !r0 ? "workflows" : (r0.id === "default" ? "workflows" : (r0.label || r0.abspath));
  if (r0 && r0.id !== "default") root.title = r0.abspath;
  root.addEventListener("click", () => selectFolder(rootId, ""));
  breadcrumbEl.appendChild(root);
  let acc = "";
  for (const p of (state.currentPath ? state.currentPath.split("/") : [])) {
    breadcrumbEl.appendChild(doc.createTextNode(" / "));
    acc = acc ? acc + "/" + p : p;
    const c = el("span", { class: "crumb" }); c.textContent = p;
    const target = acc;
    c.addEventListener("click", () => selectFolder(rootId, target));
    breadcrumbEl.appendChild(c);
  }
}

function renderTree() {
  if (!treeEl) return;
  clear(treeEl);
  for (const r of state.roots) {
    const top = r.tree || { name: "", path: "", folders: [], files: [] };
    renderTreeNode(top, treeEl, 0, r, true);
  }
}

// node: a folder node within rootObj's tree (rel path in node.path).
// isRoot: this is the synthetic top-level node for the whole root.
function renderTreeNode(node, parentEl, depth, rootObj, isRoot) {
  const rootId = rootObj.id;
  const isDefault = rootId === "default";
  const offline = isRoot && rootObj.available === false;
  const active = state.rootId === rootId && state.currentPath === node.path;
  const eHere = ekey(rootId, node.path);
  const isExpanded = state.expanded.has(eHere);
  const hasChildren = !offline && (node.folders || []).length > 0;

  const row = el("div", { class: "gt-tnode"
    + (active ? " active" : "")
    + (isRoot ? " gt-troot" : "")
    + (isRoot && !isDefault ? " gt-troot-extra" : "")
    + (offline ? " gt-offline" : "") });
  const twirl = el("span", { class: "twirl" });
  twirl.textContent = offline ? "⚠" : (hasChildren ? (isExpanded ? "▾" : "▸") : "·");
  const icon = el("span", { class: "icon" });
  icon.textContent = isRoot && !isDefault ? "🔗" : "📁";
  const label = el("span", { class: "label" });
  label.textContent = isRoot
    ? (isDefault ? "workflows" : (rootObj.label || rootObj.abspath))
    : (node.name || "workflows");
  if (isRoot && !isDefault) row.title = rootObj.abspath + (offline ? "  (offline)" : "");
  row.style.paddingLeft = (depth * 12) + "px";
  row.appendChild(twirl); row.appendChild(icon); row.appendChild(label);

  row.addEventListener("click", (e) => {
    if (offline) return;
    if (e.target === twirl) {
      if (state.expanded.has(eHere)) state.expanded.delete(eHere);
      else state.expanded.add(eHere);
      saveLS(); renderTree();
    } else {
      selectFolder(rootId, node.path);
    }
  });
  row.addEventListener("contextmenu", (e) => {
    e.preventDefault(); e.stopPropagation();
    const items = [];
    if (!offline) items.push({ label: "New folder here", action: () => mkFolder(rootId, node.path) });
    items.push({ label: "Refresh", action: async () => { await refreshTree(); renderAll(); } });
    if (!isRoot && node.path) {
      items.push("sep");
      items.push({ label: "Rename folder", action: () => renameFolder(rootId, node.path) });
      items.push({ label: "Delete folder", danger: true, action: () => deleteFolder(rootId, node.path) });
    }
    if (isRoot && !isDefault) {
      items.push("sep");
      items.push({ label: "Remove this location", danger: true, action: () => removeRoot(rootId) });
    }
    showMenu(e.clientX, e.clientY, items);
  });
  if (!offline) {
    row.addEventListener("dragover",  (e) => { e.preventDefault(); row.classList.add("drop-target"); });
    row.addEventListener("dragleave", () => row.classList.remove("drop-target"));
    row.addEventListener("drop", async (e) => {
      e.preventDefault(); row.classList.remove("drop-target");
      const files = Array.from(e.dataTransfer?.files || []);
      for (const f of files) {
        if (f.name.toLowerCase().endsWith(".json")) await dropWorkflowFile(rootId, node.path, f);
      }
    });
  }
  parentEl.appendChild(row);
  if (!offline && isExpanded && hasChildren) {
    for (const sub of node.folders) renderTreeNode(sub, parentEl, depth + 1, rootObj, false);
  }
}

function selectFolder(rootId, path) {
  state.rootId = rootId;
  state.currentPath = path;
  state.selection.clear();
  state.selAnchor = null;     // a new folder invalidates the range anchor
  state.expanded.add(ekey(rootId, ""));
  state.expanded.add(ekey(rootId, path));
  let acc = "";
  for (const part of path.split("/").filter(Boolean)) {
    acc = acc ? acc + "/" + part : part;
    state.expanded.add(ekey(rootId, acc));
  }
  saveLS();
  renderAll();
}

// 3-state header sort cycle for the List view. Same column: unsorted -> asc ->
// desc -> unsorted. A different column starts at asc. dir semantics (user):
// name asc=A→Z desc=Z→A; date asc=newer-first desc=older-first;
// size asc=larger-first desc=smaller-first.
function cycleListSort(col) {
  const s = state.listSort;
  if (s.col !== col)        state.listSort = { col, dir: "asc" };
  else if (s.dir === "asc") state.listSort = { col, dir: "desc" };
  else                      state.listSort = { col: null, dir: "asc" };
  saveLS();
  renderGrid();
}

// Single-key comparator (the shared semantics for BOTH the List header sort
// and the thumbnail Name/Date buttons): name asc = A→Z; date asc =
// newer-first; size asc = larger-first.
function cmpFiles(a, b, col) {
  if (col === "name") {
    const an = baseName(a.path).replace(/\.json$/i, "");
    const bn = baseName(b.path).replace(/\.json$/i, "");
    return an.localeCompare(bn, undefined, { numeric: true, sensitivity: "base" });
  }
  if (col === "date") return (b.mtime || 0) - (a.mtime || 0);
  if (col === "size") return (b.size || 0) - (a.size || 0);
  return 0;
}
// Returns a NEW sorted array (never mutates the tree). Stable via
// decorate-sort-undecorate with original-index tiebreak.
function sortFilesBy(files, col, dir) {
  if (!col) return files;
  return files.map((f, i) => [f, i]).sort((A, B) => {
    let r = cmpFiles(A[0], B[0], col);
    if (dir === "desc") r = -r;
    return r !== 0 ? r : A[1] - B[1];
  }).map(p => p[0]);
}
// Multi-level stable sort: levels = [{key,dir}, …] in precedence order
// (level 0 is primary, the rest are tiebreakers). Used by the stackable
// thumbnail Name/Date buttons.
function sortFilesByMulti(files, levels) {
  if (!levels || !levels.length) return files;
  return files.map((f, i) => [f, i]).sort((A, B) => {
    for (const lv of levels) {
      let r = cmpFiles(A[0], B[0], lv.key);
      if (lv.dir === "desc") r = -r;
      if (r !== 0) return r;
    }
    return A[1] - B[1];
  }).map(p => p[0]);
}
function sortedListFiles(files) {
  const s = state.listSort;
  if (!s || !s.col) return files;
  return sortFilesBy(files, s.col, s.dir);
}

// Thumbnail Name/Date buttons: each is an independent 3-state toggle that
// cycles off → asc → desc → off. `state.cardSort` is an ordered list of the
// active levels (activation order = precedence; first activated is primary,
// later ones are tiebreakers). Reversing direction keeps precedence.
function cycleCardSort(key) {
  const arr = Array.isArray(state.cardSort) ? state.cardSort.slice() : [];
  const i = arr.findIndex((s) => s.key === key);
  if (i < 0) {
    arr.unshift({ key, dir: "asc" });            // off → asc, becomes PRIMARY
  } else if (arr[i].dir === "asc") {
    arr.splice(i, 1);
    arr.unshift({ key, dir: "desc" });           // asc → desc, promote to PRIMARY
  } else {
    arr.splice(i, 1);                            // desc → off
  }
  // Primary = front of the list. The just-pressed button always drives the
  // visible order; the other stays active as a tiebreaker (only observable
  // when two files share a name, e.g. across folders/roots in search/recurse).
  state.cardSort = arr;
  saveLS();
  renderAll();
}

// Column-resize drag. Handle is at the right edge of each header .col. Listen
// on the ACTIVE doc (panel may be in a popup). colResizing guards the header
// sort-click so a release after a drag never triggers a sort.
let colResizing = false;

// Paths in the exact order currently rendered (after card-sort / list-sort /
// search), so Shift+click range-select follows what the user sees. Set by
// renderGrid for BOTH the card and list branches.
let visibleOrder = [];
// Bumped on every click/dblclick. A deferred plain-click select captures the
// value and bails if a later click (e.g. a quick Shift+click on another item)
// superseded it — otherwise the stale single-select would stomp the range.
let clickSeq = 0;
// Inclusive path range between the selection anchor and the clicked item, in
// visible order. No valid anchor → just the target (acts like a plain click).
function pathRange(order, anchor, target) {
  const ti = order.indexOf(target);
  if (ti < 0) return [];
  const ai = anchor == null ? -1 : order.indexOf(anchor);
  if (ai < 0) return [target];
  const lo = Math.min(ai, ti), hi = Math.max(ai, ti);
  return order.slice(lo, hi + 1);
}

function startColResize(e, i) {
  e.preventDefault();
  e.stopPropagation();
  colResizing = true;
  const startX = e.clientX;
  const startW = state.listColW[i];
  const dResize = doc;
  const onMove = (ev) => {
    const next = Math.max(LIST_COL_MIN, Math.round(startW + (ev.clientX - startX)));
    if (next === state.listColW[i]) return;
    state.listColW[i] = next;
    applyListCols();
  };
  const onUp = () => {
    dResize.removeEventListener("mousemove", onMove, true);
    dResize.removeEventListener("mouseup", onUp, true);
    saveLS();
    setTimeout(() => { colResizing = false; }, 0);
  };
  dResize.addEventListener("mousemove", onMove, true);
  dResize.addEventListener("mouseup", onUp, true);
}

function renderGrid() {
  if (!gridEl) return;
  clear(gridEl);
  visibleOrder = [];   // reset; the render branch below repopulates it
  if (panelEl) panelEl.classList.toggle("gt-listmode", !!state.listView);
  gridEl.classList.toggle("gt-aslist", !!state.listView);
  if (!state.listView) applyCardScale();
  const q = (state.searchQuery || "").trim();
  const searching = q.length > 0;
  const r0 = currentRoot();
  if (r0 && r0.available === false) {
    gridEl.appendChild(el("div", { class: "gt-empty",
      text: "This location is offline or was removed. Reconnect the drive/folder and click Refresh." }));
    return;
  }
  // Compute the panel's normal visible-file set first (current root +
  // current folder ± Subfolders toggle ± Favorites filter), THEN apply
  // search as a pure filename-substring filter on top. Search no longer
  // bypasses the current scope and goes cross-root — it just narrows
  // whatever you're already looking at.
  const node = findFolderNode(state.rootId, state.currentPath);
  let files = node ? (state.recurseSubfolders ? collectFilesRecursive(node) : (node.files || [])) : [];
  if (state.favoritesOnly) files = files.filter((f) => f.favorite);
  if (searching) {
    const ql = q.toLowerCase();
    files = files.filter((f) =>
      baseName(f.path).replace(/\.json$/i, "").toLowerCase().indexOf(ql) >= 0);
  }
  if (!files.length) {
    const empty = el("div", { class: "gt-empty" });
    empty.textContent = searching
      ? `No workflows match “${q}”.`
      : state.favoritesOnly
      ? "No favorites here. Click the ☆ on a workflow's thumbnail to add one."
      : state.recurseSubfolders
      ? "No workflows in this folder or any of its subfolders."
      : "No workflows in this folder. Drag a .json here or click 'Save As…'.";
    gridEl.appendChild(empty);
    return;
  }
  if (state.listView) {
    applyListCols();
    applyListFont();
    const head = el("div", { class: "gt-lhead" });
    const cols = [["col-name", "Name"], ["col-date", "Date"], ["col-desc", "Description"], ["col-path", "Path"], ["col-size", "Size"]];
    cols.forEach(([cls, label], i) => {
      const sortKey = LIST_SORTABLE[cls];
      const c = el("div", { class: "col " + cls + (sortKey ? " sortable" : "") });
      c.appendChild(doc.createTextNode(label));
      if (sortKey && state.listSort.col === sortKey)
        c.appendChild(el("span", { class: "sort-ind", text: state.listSort.dir === "asc" ? "▲" : "▼" }));
      if (sortKey) c.addEventListener("click", (e) => {
        if (colResizing) return;
        if (e.target && e.target.classList && e.target.classList.contains("col-grip")) return;
        cycleListSort(sortKey);
      });
      const grip = el("div", { class: "col-grip" });
      grip.addEventListener("mousedown", (ev) => startColResize(ev, i));
      c.appendChild(grip);
      head.appendChild(c);
    });
    gridEl.appendChild(head);
    const list = el("div", { class: "gt-list" });
    const ordered = sortedListFiles(files);
    visibleOrder = ordered.map((x) => x.path);
    for (const f of ordered) list.appendChild(renderRow(f));
    gridEl.appendChild(list);
  } else {
    const cs = Array.isArray(state.cardSort) ? state.cardSort : [];
    const cardFiles = cs.length ? sortFilesByMulti(files, cs) : files;
    visibleOrder = cardFiles.map((x) => x.path);
    for (const f of cardFiles) gridEl.appendChild(renderCard(f));
  }
}

function gridDragOver(e) {
  if (e.target.closest(".gt-card")) return;
  e.preventDefault();
}
async function gridDrop(e) {
  if (e.target.closest(".gt-card")) return;
  e.preventDefault();
  const files = Array.from(e.dataTransfer?.files || []);
  for (const f of files) {
    if (f.name.toLowerCase().endsWith(".json")) await dropWorkflowFile(state.rootId, state.currentPath, f);
  }
}

// Shared interaction wiring for a file element (card OR list row). Single
// source of truth so cards and rows behave identically: dataset, state
// classes, click (multi-select / load), the full context menu, and
// drag-drop-thumbnail.
function wireFileEl(elm, f) {
  const fRoot = (f && f.__root) || state.rootId;   // search hits carry __root
  elm.dataset.path = f.path;
  if (state.selection.has(f.path)) elm.classList.add("selected");
  if (state.loadedRootId === fRoot && state.loadedSourcePath === f.path) elm.classList.add("loaded");
  if (state.clipboard && state.clipboard.op === "cut" && state.clipboard.root === fRoot
      && state.clipboard.items.includes(f.path)) elm.classList.add("cut");
  let clickTimer = null;
  elm.addEventListener("click", (e) => {
    focusFileContext(f);   // cross-root search hit → point state at its location
    const seq = ++clickSeq;
    if (e.shiftKey) {                                   // RANGE select (anchor..here)
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
      const order = visibleOrder;
      const r = pathRange(order, state.selAnchor, f.path);
      if (!r.length) { renderGrid(); renderToolbar(); return; }
      state.selection.clear();
      for (const p of r) state.selection.add(p);
      if (order.indexOf(state.selAnchor) < 0) state.selAnchor = f.path; // had no anchor
      renderGrid(); renderToolbar();
      return;
    }
    if (e.ctrlKey || e.metaKey) {                       // TOGGLE one, anchor moves here
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
      if (state.selection.has(f.path)) state.selection.delete(f.path);
      else state.selection.add(f.path);
      state.selAnchor = f.path;
      renderGrid(); renderToolbar();
      return;
    }
    // Plain click: set the anchor immediately (so a quick Shift+click ranges
    // from here), but DEFER the select+render — renderGrid() rebuilds every
    // card/row, which would destroy this element before the native dblclick
    // can fire. A dblclick, or any later click (clickSeq), cancels this.
    state.selAnchor = f.path;
    if (clickTimer) clearTimeout(clickTimer);
    clickTimer = setTimeout(() => {
      clickTimer = null;
      if (seq !== clickSeq) return;   // a later click superseded this one
      state.selection.clear();
      state.selection.add(f.path);
      renderGrid(); renderToolbar();
    }, 250);
  });
  elm.addEventListener("dblclick", (e) => {
    if (e.shiftKey || e.ctrlKey || e.metaKey) return;   // modified dblclick = no-op
    focusFileContext(f);
    clickSeq++;   // invalidate the paired first-click's deferred single-select
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
    state.selection.clear();
    state.selection.add(f.path);
    state.selAnchor = f.path;
    loadWorkflow(f.path).then(() => { renderGrid(); renderToolbar(); });
  });
  elm.addEventListener("contextmenu", (e) => {
    e.preventDefault(); e.stopPropagation();
    focusFileContext(f);
    if (!state.selection.has(f.path)) { state.selection.clear(); state.selection.add(f.path); renderGrid(); renderToolbar(); }
    const sel = Array.from(state.selection);
    const isSingle = sel.length === 1;
    const single = isSingle ? sel[0] : null;
    showMenu(e.clientX, e.clientY, [
      { label: "Overwrite…",           disabled: !isSingle, action: () => overwriteWorkflow(single) },
      "sep",
      { label: "Rename…",              disabled: !isSingle, action: () => renameFile(single) },
      { label: "Duplicate…",           disabled: !isSingle, action: () => duplicateFile(single) },
      { label: "Cut",                  action: () => { state.clipboard = { op: "cut",  root: state.rootId, items: sel }; renderAll(); } },
      { label: "Copy",                 action: () => { state.clipboard = { op: "copy", root: state.rootId, items: sel }; renderAll(); } },
      "sep",
      { label: "Set thumbnail…",       disabled: !isSingle, action: () => pickThumbnailFile(single) },
      { label: "Capture thumbnail from canvas", disabled: !isSingle, action: () => captureThumbnailFor(single) },
      { label: "Remove thumbnail",     disabled: !isSingle, action: () => clearThumbnail(single) },
      "sep",
      { label: "Description…",         disabled: !isSingle, action: () => editDescription(single) },
      { label: "Tags…",                disabled: !isSingle, action: () => editTags(single) },
      "sep",
      { label: `Delete${sel.length > 1 ? ` (${sel.length})` : ""}`, danger: true, action: () => deleteFiles(sel) },
    ]);
  });
  elm.addEventListener("dragover", (e) => { e.preventDefault(); elm.classList.add("drop-target"); });
  elm.addEventListener("dragleave", () => elm.classList.remove("drop-target"));
  elm.addEventListener("drop", async (e) => {
    e.preventDefault(); e.stopPropagation(); elm.classList.remove("drop-target");
    focusFileContext(f);
    const files = Array.from(e.dataTransfer?.files || []);
    const img = files.find((x) => /^image\/(png|jpe?g|webp)$/i.test(x.type) || /\.(png|jpe?g|webp)$/i.test(x.name));
    if (img) await setThumbnailFromFile(f.path, img);
  });
  // List view: double-clicking the Description cell opens the description
  // editor instead of loading the workflow. Single-click still bubbles to
  // the row's handler (selection works normally). Cards have no .col-desc
  // so this is a no-op there.
  const descCell = elm.querySelector(".col-desc");
  if (descCell) {
    descCell.addEventListener("dblclick", (e) => {
      if (e.shiftKey || e.ctrlKey || e.metaKey) return;   // modified dblclick = no-op
      e.stopPropagation();   // suppress the row's load-workflow dblclick
      focusFileContext(f);
      clickSeq++;            // invalidate the paired first-click's deferred single-select
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
      state.selection.clear();
      state.selection.add(f.path);
      state.selAnchor = f.path;
      renderGrid(); renderToolbar();
      editDescription(f.path);
    });
  }
}

function fmtSize(n) {
  if (!n || n < 0) return "—";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}

// Humanized "time ago" for the CARD view only (List view keeps the exact
// timestamp). Compared against now at render time. mtime is unix seconds.
const REL_WORDS = ["", "One", "Two", "Three", "Four", "Five", "Six",
  "Seven", "Eight", "Nine", "Ten", "Eleven"];
function relDate(mtimeSec) {
  if (!mtimeSec || !Number.isFinite(mtimeSec) || mtimeSec <= 0) return "";
  const when = new Date(mtimeSec * 1000);
  const now = new Date();
  const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((dayStart(now) - dayStart(when)) / 86400000);
  if (days <= 0) return "Today";                 // includes future / clock skew
  if (days === 1) return "Yesterday";
  if (days <= 6) return days + "d ago";
  if (days <= 27) {
    const w = Math.max(1, Math.min(3, Math.round(days / 7)));
    return `${REL_WORDS[w]} week${w > 1 ? "s" : ""} ago`;
  }
  if (days <= 364) {
    const m = Math.max(1, Math.min(11, Math.round(days / 30)));
    return `${REL_WORDS[m]} month${m > 1 ? "s" : ""} ago`;
  }
  const y = Math.floor(days / 365);
  if (y === 1) return "A year ago";
  return `${y <= 11 ? REL_WORDS[y] : y} years ago`;
}

function renderCard(f) {
  const card = el("div", { class: "gt-card" });
  const thumb = el("div", { class: "thumb" });
  if (f.thumb) {
    const bust = f.thumbMtime || f.mtime || Date.now();
    thumb.style.backgroundImage = `url("${API_BASE}/thumb?path=${encodeURIComponent(f.thumb)}&root=${encodeURIComponent(f.__root || state.rootId)}&t=${bust}")`;
  } else {
    thumb.textContent = "no thumbnail";
  }
  const meta = el("div", { class: "meta" });
  const name = el("div", { class: "name" });
  const baseLabel = baseName(f.path).replace(/\.json$/i, "");
  if (f.__rootLabel) {
    // search hit: show location + folder so cross-root duplicates are clear
    const dir = dirName(f.path);
    name.textContent = `${f.__rootLabel}${dir ? "/" + dir : ""}/${baseLabel}`;
  } else if (state.recurseSubfolders) {
    let sub = dirName(f.path);
    if (state.currentPath && sub.startsWith(state.currentPath))
      sub = sub.slice(state.currentPath.length).replace(/^\//, "");
    name.textContent = sub ? sub + "/" + baseLabel : baseLabel;
  } else {
    name.textContent = baseLabel;
  }
  const date = el("div", { class: "date" });
  date.textContent = relDate(f.mtime);
  if (f.mtime) date.title = new Date(f.mtime * 1000).toLocaleString();
  const desc = el("div", { class: "desc" });
  desc.textContent = (f.description || "").trim();
  meta.appendChild(name); meta.appendChild(date); meta.appendChild(desc);
  card.appendChild(thumb); card.appendChild(meta);
  card.appendChild(makeFavStar(f));
  wireFileEl(card, f);
  return card;
}

function renderRow(f) {
  const row = el("div", { class: "gt-row" });
  const mkCol = (cls, text) => {
    const c = el("div", { class: "col " + cls });
    c.textContent = text;
    c.title = text;
    return c;
  };
  const nameCol = el("div", { class: "col col-name" });
  const nameTxt = baseName(f.path).replace(/\.json$/i, "");
  nameCol.title = nameTxt;
  nameCol.appendChild(makeFavStar(f));
  nameCol.appendChild(el("span", { class: "gt-rowname", text: nameTxt }));
  row.appendChild(nameCol);
  row.appendChild(mkCol("col-date", f.mtime ? new Date(f.mtime * 1000).toLocaleString() : ""));
  row.appendChild(mkCol("col-desc", (f.description || "").trim()));
  const _re = f.__root ? rootEntry(f.__root) : null;
  const _root = ((_re ? _re.abspath : state.root) || "").replace(/[\\/]+$/, "");
  const _rel = dirName(f.path);
  const folderPath = _rel ? (_root ? _root + "\\" : "") + _rel.replace(/\//g, "\\") : (_root || "");
  row.appendChild(mkCol("col-path", folderPath || "—"));
  row.appendChild(mkCol("col-size", fmtSize(f.size)));
  wireFileEl(row, f);
  return row;
}

function pickThumbnailFile(workflowPath) {
  const input = doc.createElement("input");
  input.type = "file"; input.accept = "image/png,image/jpeg,image/webp";
  input.addEventListener("change", async () => {
    const file = input.files && input.files[0];
    if (file) await setThumbnailFromFile(workflowPath, file);
  });
  input.click();
}

async function captureThumbnailFor(workflowPath) {
  const dataUrl = await captureThumbBase64();
  if (!dataUrl) { toast("Couldn't capture canvas"); return; }
  try {
    await apiPost("/save_thumb", { path: workflowPath, thumbBase64: dataUrl, thumbExt: ".png", root: state.rootId });
    await refreshTree(); renderAll();
    toast("Thumbnail captured");
  } catch (e) { toast("Thumbnail save failed: " + e.message); }
}

function renderAll() {
  renderToolbar();
  renderBreadcrumb();
  renderTree();
  renderGrid();
  if (gridEl) {
    gridEl.removeEventListener("dragover", gridDragOver);
    gridEl.removeEventListener("drop", gridDrop);
    gridEl.addEventListener("dragover", gridDragOver);
    gridEl.addEventListener("drop", gridDrop);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// loadGraphData wrapper so external loads clear loadedSourcePath
// ─────────────────────────────────────────────────────────────────────────────
function hookLoadGraph() {
  if (!app || !app.loadGraphData || app._gtHooked) return;
  const orig = app.loadGraphData.bind(app);
  app.loadGraphData = function (graphData, ...rest) {
    if (!state.loadingFromGW) { state.loadedSourcePath = null; state.loadedRootId = null; }
    const r = orig(graphData, ...rest);
    if (state.panelMounted) { renderToolbar(); renderGrid(); }
    return r;
  };
  app._gtHooked = true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Standalone OS window
// ─────────────────────────────────────────────────────────────────────────────
const WIN_LS_KEY = LS_KEY + "_win";
let gtWin = null;
let winSaveTimer = null;   // periodic geometry sampler while the popup is open
let wfWatchTimer = null;   // polls ComfyUI's active-workflow name while the popup is open
let lastWfName = null;     // last detected name; re-render toolbar (Save state) on change

// Switching ComfyUI workflow TABS does not call loadGraphData, so the
// hookLoadGraph re-render never fires. Poll the active workflow name and
// refresh the toolbar when it changes, so the Save button re-evaluates
// saveTarget() (and deactivates the instant the open workflow no longer
// matches the selected thumbnail).
function watchActiveWorkflow() {
  let n;
  try { n = detectedWorkflowName(); } catch (_) { return; }
  if (n !== lastWfName) {
    lastWfName = n;
    if (state.panelMounted) renderToolbar();
  }
}

function loadWinRect() {
  try {
    const r = JSON.parse(localStorage.getItem(WIN_LS_KEY) || "null");
    if (r && r.w > 200 && r.h > 200) return r;
  } catch (_) {}
  return { w: 1100, h: 760, x: null, y: null };
}
// Persist the LIVE popup geometry as OUTER size + screen position. The window
// is sized via gtWin.resizeTo() (sets the OUTER window) and positioned via
// gtWin.moveTo(), so outerWidth/outerHeight + screenX/screenY are the
// unit-matched values — persisting these and re-applying via resizeTo/moveTo
// is a true fixed point. We deliberately do NOT pass width/height/left/top to
// window.open: Firefox clamps/ignores them for popups and (this env) inflated
// the window by the requested offset every open→close→reopen. Guard rejects
// 0/teardown reads so a bad sample never clobbers a good saved rect.
function saveWinRect() {
  try {
    if (!gtWin || gtWin.closed) return;
    const w = gtWin.outerWidth, h = gtWin.outerHeight;
    const x = gtWin.screenX,    y = gtWin.screenY;
    if (!(w > 200) || !(h > 200)) return;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    localStorage.setItem(WIN_LS_KEY, JSON.stringify({ w, h, x, y }));
  } catch (_) {}
}

// Close the orphan template window if the main ComfyUI tab goes away.
window.addEventListener("beforeunload", () => {
  try { if (gtWin && !gtWin.closed) gtWin.close(); } catch (_) {}
});

function openStandaloneWindow() {
  if (gtWin && !gtWin.closed) { gtWin.focus(); return; }
  const r = loadWinRect();
  // Open WITHOUT geometry features (Firefox clamps/inflates them for popups —
  // see saveWinRect note). Size/position is applied explicitly below via
  // resizeTo/moveTo, which are screen-pixel and symmetric with what we persist.
  gtWin = window.open("", "GregTemplatesWin", "popup=yes");
  if (!gtWin) {
    // doc is still APP_DOC here, so this toast shows in the main window.
    toast("Allow pop-ups for this site to open G-Workflows in its own window");
    return;
  }

  // Apply saved OUTER geometry explicitly (reliable, unlike window.open feats).
  const applyRect = () => {
    try {
      gtWin.resizeTo(r.w, r.h);
      if (Number.isFinite(r.x) && Number.isFinite(r.y)) gtWin.moveTo(r.x, r.y);
    } catch (_) {}
  };
  applyRect();
  setTimeout(applyRect, 60);   // re-assert once the popup has settled

  // Build the popup document via DOM APIs (window.open("") yields a blank
  // same-origin document with <head>/<body> already present).
  const wdoc = gtWin.document;
  wdoc.title = "💾 G-Workflows";
  const reset = wdoc.createElement("style");
  reset.textContent = "html,body{margin:0;height:100%;background:#1f2227;overflow:hidden}" +
    "body{color:#dbe2ea;font:13px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}";
  wdoc.head.appendChild(reset);

  doc = wdoc;
  injectCSS();
  bindMenuDocListeners(doc);
  const host = el("div", { style: { position: "absolute", inset: "0", display: "flex", flexDirection: "column" } });
  wdoc.body.appendChild(host);

  // Capture geometry from the LIVE window — periodically + on resize — so the
  // last size/position is reliably stored. pagehide alone is unreliable: it
  // fires on a window mid-teardown and Firefox returns stale/zero screenX/Y
  // there, which is why position was never remembered.
  clearInterval(winSaveTimer);
  winSaveTimer = setInterval(saveWinRect, 1000);
  gtWin.addEventListener("resize", saveWinRect);
  lastWfName = detectedWorkflowName();
  clearInterval(wfWatchTimer);
  wfWatchTimer = setInterval(watchActiveWorkflow, 400);

  gtWin.addEventListener("pagehide", () => {
    saveWinRect();                 // best-effort final sample (guarded)
    clearInterval(winSaveTimer);
    winSaveTimer = null;
    clearInterval(wfWatchTimer);
    wfWatchTimer = null;
    lastWfName = null;
    gtWin = null;
    doc = APP_DOC;          // main-window toasts work again
    state.panelMounted = false;
  });

  mountInto(host);
}

async function mountInto(host) {
  buildPanel(host);
  loadLS();
  await refreshTree();
  if (!rootEntry(state.rootId)) {
    state.rootId = (state.roots[0] && state.roots[0].id) || "default";
    state.currentPath = "";
  } else if (state.currentPath && !findFolderNode(state.rootId, state.currentPath)) {
    state.currentPath = "";
  }
  state.expanded.add(ekey(state.rootId, ""));
  state.searchQuery = "";   // start each popup session unfiltered
  renderAll();
}

// ─────────────────────────────────────────────────────────────────────────────
// Extension registration
// ─────────────────────────────────────────────────────────────────────────────
app.registerExtension({
  name: "Comfy.GregTemplates",

  commands: [
    { id: "gregTemplates.openWindow", label: "G-Workflows — open window", icon: "pi pi-save", function: () => openStandaloneWindow() },
    { id: "gregTemplates.saveAs",     label: "G-Workflows — Save As…",    icon: "pi pi-save", function: () => clickSaveAs() },
  ],
  menuCommands: [
    { path: ["File"], commands: ["gregTemplates.openWindow", "gregTemplates.saveAs"] },
  ],

  async setup() {
    // doc is APP_DOC here: keep .gt-toast styled in the main window so the
    // "allow pop-ups" fallback toast renders if window.open is blocked.
    injectCSS();
    hookLoadGraph();
    addTopbarButton();
    console.log("[G-Workflows] v1.0 ready");
  },
});

function addTopbarButton() {
  if (APP_DOC.getElementById("gt-topbar-btn")) return;
  const btn = el("button", { id: "gt-topbar-btn", style: {
    background: "#c2882e", color: "#1f2227", border: "1px solid #9c6c22",
    borderRadius: "4px", padding: "4px 8px", marginLeft: "4px", cursor: "pointer",
    lineHeight: "1", font: "16px system-ui,-apple-system,Segoe UI,Roboto,sans-serif",
  } });
  btn.textContent = "💾";
  btn.title = "G-Workflows";
  btn.setAttribute("aria-label", "G-Workflows");
  btn.addEventListener("click", openStandaloneWindow);
  let attempts = 0, observer = null, timeoutId = 0;
  const MAX = 60;
  const tryInject = () => {
    attempts++;
    if (btn.parentElement) { observer?.disconnect(); clearTimeout(timeoutId); return; }
    if (attempts > MAX)    { observer?.disconnect(); clearTimeout(timeoutId); return; }
    for (const cand of APP_DOC.querySelectorAll("button")) {
      const txt = cand.textContent?.trim();
      if (!txt || txt !== "Manager") continue;
      const r = cand.getBoundingClientRect();
      if (r.top > 100 || r.height === 0 || r.width === 0) continue;
      const container = cand.parentElement;
      if (container) { container.insertBefore(btn, cand); observer?.disconnect(); clearTimeout(timeoutId); return; }
    }
  };
  tryInject();
  if (!btn.parentElement) {
    observer = new MutationObserver(tryInject);
    observer.observe(APP_DOC.body, { childList: true, subtree: true });
    timeoutId = setTimeout(() => observer?.disconnect(), 20000);
  }
}
