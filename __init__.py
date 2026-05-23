"""
ComfyUI G-Workflows  v1.0
=========================
Browse / save / organize ComfyUI workflows directly against the native
user/default/workflows folder, with image sidecar thumbnails that follow
the .json through every rename / copy / move / delete operation.

Default storage root: ComfyUI/user/default/workflows/
Extra roots:  any number of additional folders the user registers as peer
              workflow locations (server-side allowlist persisted to
              ComfyUI/user/g_workflows_roots.json). Every path-bearing route
              takes an optional "root" id (POST body field / GET ?root=);
              absence ⇒ the default root (full backward compatibility).
Thumbnails:   sidecar .png / .jpg / .jpeg / .webp matched by basename
              next to the .json (e.g. Foo.json + Foo.png)

All write/delete routes pin paths inside the SELECTED root via
os.path.commonpath (per-root traversal protection preserved).
All delete routes require {"confirm": true} in the request body.

API routes (all POST unless noted):
  GET  /comfy_greg_templates/tree           all roots + recursive listings
  GET  /comfy_greg_templates/workflow       ?path= &root=  read workflow JSON
  GET  /comfy_greg_templates/thumb          ?path= &root=  serve sidecar image
       /comfy_greg_templates/save           write workflow (+ optional thumb)
       /comfy_greg_templates/save_thumb     replace sidecar for a workflow
       /comfy_greg_templates/delete_thumb   remove sidecar only
       /comfy_greg_templates/set_desc       set / clear a workflow's description
       /comfy_greg_templates/set_fav        set / clear a workflow's favorite
       /comfy_greg_templates/rename         rename / move a workflow (+ sidecar)
       /comfy_greg_templates/copy           copy a workflow (+ sidecar)
       /comfy_greg_templates/move           cross-folder move (bulk supported)
       /comfy_greg_templates/delete         delete workflows (+ sidecars), bulk
       /comfy_greg_templates/mkdir          create a folder
       /comfy_greg_templates/rmdir          delete a folder
       /comfy_greg_templates/rename_dir     rename a folder
  GET  /comfy_greg_templates/fs_roots       drives + shortcuts (folder browser)
  GET  /comfy_greg_templates/fs_list        ?path=  list dirs (folder browser)
  GET  /comfy_greg_templates/list_roots     registered roots snapshot
       /comfy_greg_templates/add_root       register a new location
       /comfy_greg_templates/remove_root    unregister a location (keeps files)
"""

import os
import io
import json
import stat
import base64
import shutil
import hashlib

from aiohttp import web

WEB_DIRECTORY = "./js"
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

try:
    import folder_paths
    _BASE = folder_paths.base_path
except Exception:
    _BASE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

TEMPLATES_DIR = os.path.normpath(os.path.join(_BASE, "user", "default", "workflows"))

# Server-side allowlist of extra workflow roots. Lives in ComfyUI's writable
# per-instance user dir (not inside any tree, survives custom-node reinstalls).
ROOTS_CONFIG = os.path.normpath(os.path.join(_BASE, "user", "g_workflows_roots.json"))
DEFAULT_ROOT_ID = "default"
# id -> {"id","label","abspath","available"}. The default entry is always
# present and first; extra entries are loaded from ROOTS_CONFIG.
_ROOTS = {}

THUMB_EXTS = (".png", ".jpg", ".jpeg", ".webp")
DESC_EXT = ".desc.txt"
FAV_EXT = ".fav"  # presence of <stem>.fav marks the workflow a favorite
WORKFLOW_EXT = ".json"
TAGS_EXT = ".tags.txt"
FORBIDDEN_NAME_CHARS = set(':\\/*?"<>|')

# All thumbnails this pack writes are normalized to a single 16:9 JPEG that
# matches the gallery card (CSS aspect-ratio:16/9, background-size:cover).
THUMB_W, THUMB_H = 800, 450
THUMB_JPEG_QUALITY = 88
THUMB_FILL = (24, 27, 33)  # #181b21 — matches the card background
# "Remove thumbnail" renames the sidecar with this postfix instead of deleting
# it: _matching_sidecars only matches image extensions, so the renamed file is
# invisible to the gallery while the bytes stay on disk for manual cleanup.
REMOVED_SUFFIX = ".removed"


def _ensure_root():
    os.makedirs(TEMPLATES_DIR, exist_ok=True)


def _canon(p):
    """Canonical form for comparison: real path, normcase (case-insensitive
    + slash-normalized on Windows), junction/symlink resolved."""
    try:
        return os.path.normcase(os.path.normpath(os.path.realpath(p)))
    except Exception:
        return os.path.normcase(os.path.normpath(p))


def _is_within(child, parent):
    """True if child is inside or equal to parent (canonicalized).
    Cross-drive / UNC mismatch (commonpath ValueError) ⇒ not nested."""
    try:
        cc, cp = _canon(child), _canon(parent)
        return os.path.commonpath([cc, cp]) == cp
    except ValueError:
        return False


def _root_id_for_path(abspath):
    """Deterministic opaque id from the canonical path: re-adding the same
    folder is idempotent and dedupes. Never collides with 'default'."""
    return "r" + hashlib.sha1(_canon(abspath).encode("utf-8", "replace")).hexdigest()[:8]


def _default_root_entry():
    return {"id": DEFAULT_ROOT_ID, "label": "workflows",
            "abspath": TEMPLATES_DIR, "available": True}


def _seed_roots():
    _ROOTS.clear()
    _ROOTS[DEFAULT_ROOT_ID] = _default_root_entry()


def _load_roots():
    """(Re)load the registry from ROOTS_CONFIG. Always starts from the default
    root. Missing file = OK. Corrupt file = logged + default only. Offline
    extra roots are KEPT (available=False) — never auto-pruned."""
    _seed_roots()
    try:
        if not os.path.isfile(ROOTS_CONFIG):
            return
        with open(ROOTS_CONFIG, "r", encoding="utf-8") as f:
            data = json.load(f)
        entries = data.get("roots") if isinstance(data, dict) else None
        if not isinstance(entries, list):
            return
        default_canon = _canon(TEMPLATES_DIR)
        for ent in entries:
            if not isinstance(ent, dict):
                continue
            ap = ent.get("abspath")
            if not ap or not isinstance(ap, str):
                continue
            ap = os.path.normpath(ap)
            rid = _root_id_for_path(ap)              # id is derived; self-heals
            if rid == DEFAULT_ROOT_ID or rid in _ROOTS:
                continue                             # reserved / duplicate
            if _canon(ap) == default_canon:
                continue                             # never alias the default
            label = os.path.basename(ap.rstrip("/\\")) or ap
            _ROOTS[rid] = {"id": rid, "label": label, "abspath": ap,
                           "available": os.path.isdir(ap)}
    except Exception as e:
        print("[G-Workflows] roots config unreadable, ignoring: {}".format(e))
        _seed_roots()


def _save_roots():
    """Atomically persist the non-default registry. Raises on failure."""
    payload = {"version": 1, "roots": [
        {"id": r["id"], "label": r["label"], "abspath": r["abspath"]}
        for rid, r in _ROOTS.items() if rid != DEFAULT_ROOT_ID
    ]}
    os.makedirs(os.path.dirname(ROOTS_CONFIG), exist_ok=True)
    tmp = ROOTS_CONFIG + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)
    os.replace(tmp, ROOTS_CONFIG)


def _base_of(root_id):
    """Absolute base dir for a root id. Unknown id ⇒ 400 (never silent
    fallback to default — a stale client must not write the wrong tree)."""
    entry = _ROOTS.get(root_id or DEFAULT_ROOT_ID)
    if not entry:
        raise web.HTTPBadRequest(reason="unknown root")
    return entry["abspath"]


def _root_of(src):
    """Extract the root id from a parsed JSON body or request.query (both
    expose .get). Absent/empty ⇒ the default root."""
    try:
        v = src.get("root")
    except AttributeError:
        v = None
    return str(v) if v else DEFAULT_ROOT_ID


def _is_root_base(abs_path):
    """True if abs_path is itself any registered root's base dir."""
    c = _canon(abs_path)
    return any(_canon(r["abspath"]) == c for r in _ROOTS.values())


def _rel(abs_path, base):
    """POSIX-style path of abs_path relative to its root base."""
    return os.path.relpath(abs_path, base).replace("\\", "/")


def _resolve(rel_path, root_id=DEFAULT_ROOT_ID):
    """Resolve a relative path under the SELECTED root. Reject traversal."""
    base = _base_of(root_id)
    if rel_path is None:
        rel_path = ""
    rel_path = str(rel_path).replace("\\", "/").lstrip("/")
    abs_path = os.path.normpath(os.path.join(base, rel_path))
    try:
        common = os.path.commonpath([abs_path, base])
    except ValueError:
        # different drive / UNC vs local — cannot be contained
        raise web.HTTPBadRequest(reason="path escapes templates root")
    if common != base:
        raise web.HTTPBadRequest(reason="path escapes templates root")
    return abs_path


def _validate_segment(name):
    """A single file or folder name — no path separators, no forbidden chars."""
    if not name or not isinstance(name, str):
        raise web.HTTPBadRequest(reason="empty or invalid name")
    if "/" in name or "\\" in name:
        raise web.HTTPBadRequest(reason="name may not contain path separators")
    if any(ch in FORBIDDEN_NAME_CHARS for ch in name):
        raise web.HTTPBadRequest(reason="name contains forbidden characters")
    if name in (".", ".."):
        raise web.HTTPBadRequest(reason="invalid name")
    return name


def _is_hidden(name):
    return name.startswith(".")


def _matching_sidecars(workflow_abs_path):
    """Return absolute paths of every image sidecar matching the .json basename."""
    if not workflow_abs_path.lower().endswith(WORKFLOW_EXT):
        return []
    stem = workflow_abs_path[: -len(WORKFLOW_EXT)]
    out = []
    for ext in THUMB_EXTS:
        for candidate in (stem + ext, stem + ext.upper()):
            if os.path.isfile(candidate):
                out.append(candidate)
    return out


def _first_sidecar_rel(workflow_abs_path, root_base):
    """Return the first sidecar's path relative to root_base, or None."""
    sc = _matching_sidecars(workflow_abs_path)
    if not sc:
        return None
    return _rel(sc[0], root_base)


def _first_sidecar_info(workflow_abs_path, root_base):
    """Return (rel_path, mtime) of the first sidecar, or (None, 0)."""
    sc = _matching_sidecars(workflow_abs_path)
    if not sc:
        return None, 0
    abs_sc = sc[0]
    try:
        mt = os.path.getmtime(abs_sc)
    except OSError:
        mt = 0
    return _rel(abs_sc, root_base), mt


def _desc_path(workflow_abs_path):
    """Sidecar text file holding the optional user description."""
    if not workflow_abs_path.lower().endswith(WORKFLOW_EXT):
        return None
    return workflow_abs_path[: -len(WORKFLOW_EXT)] + DESC_EXT


def _read_desc(workflow_abs_path):
    """Return the user description for a workflow, or '' if none."""
    p = _desc_path(workflow_abs_path)
    if not p or not os.path.isfile(p):
        return ""
    try:
        with open(p, "r", encoding="utf-8") as f:
            return f.read()
    except OSError:
        return ""


def _fav_path(workflow_abs_path):
    """Sidecar marker file whose mere existence means 'favorite'."""
    if not workflow_abs_path.lower().endswith(WORKFLOW_EXT):
        return None
    return workflow_abs_path[: -len(WORKFLOW_EXT)] + FAV_EXT


def _is_fav(workflow_abs_path):
    """True if the workflow has a favorite marker sidecar."""
    p = _fav_path(workflow_abs_path)
    return bool(p and os.path.isfile(p))


def _tags_path(workflow_abs_path):
    """Sidecar text file holding the optional user tags (one per line)."""
    if not workflow_abs_path.lower().endswith(WORKFLOW_EXT):
        return None
    return workflow_abs_path[: -len(WORKFLOW_EXT)] + TAGS_EXT


def _normalize_tags(raw):
    """Trim, lowercase, drop blanks, de-duplicate (preserve first-seen order).

    Accepts either a list of strings or a single newline-separated string.
    """
    if raw is None:
        return []
    if isinstance(raw, str):
        lines = raw.splitlines()
    else:
        lines = list(raw)
    out = []
    seen = set()
    for t in lines:
        s = (t or "").strip().lower()
        if not s:
            continue
        if s in seen:
            continue
        seen.add(s)
        out.append(s)
    return out


def _read_tags(workflow_abs_path):
    """Return the workflow's tag list (lowercased, de-duped) or [] if none."""
    p = _tags_path(workflow_abs_path)
    if not p or not os.path.isfile(p):
        return []
    try:
        with open(p, "r", encoding="utf-8") as f:
            return _normalize_tags(f.read())
    except OSError:
        return []


def _write_tags(workflow_abs_path, tags):
    """Overwrite the sidecar with the normalized tags. Empty list -> delete."""
    p = _tags_path(workflow_abs_path)
    if not p:
        return
    normalized = _normalize_tags(tags)
    if not normalized:
        # Empty list collapses the sidecar entirely.
        try:
            os.remove(p)
        except FileNotFoundError:
            pass
        except OSError:
            pass
        return
    with open(p, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(normalized) + "\n")


def _decode_data_url(data_url):
    if not data_url:
        return None
    raw = data_url.split(",", 1)[1] if "," in data_url else data_url
    return base64.b64decode(raw)


def _make_thumb_jpeg(raw_bytes):
    """Cover-fit raw image bytes to THUMB_W x THUMB_H and return JPEG bytes.

    Raises on any failure so the caller can surface a real error instead of
    silently writing an unresized/wrong-format thumbnail.
    """
    from PIL import Image, ImageOps  # hard ComfyUI dependency

    src = Image.open(io.BytesIO(raw_bytes))
    src = ImageOps.exif_transpose(src)  # respect phone-photo orientation
    src = src.convert("RGBA")
    bg = Image.new("RGBA", src.size, THUMB_FILL + (255,))
    src = Image.alpha_composite(bg, src).convert("RGB")

    w, h = src.size
    scale = max(THUMB_W / w, THUMB_H / h)  # cover
    new = (max(1, round(w * scale)), max(1, round(h * scale)))
    src = src.resize(new, Image.LANCZOS)

    left = (new[0] - THUMB_W) // 2
    top = (new[1] - THUMB_H) // 2  # center-crop
    src = src.crop((left, top, left + THUMB_W, top + THUMB_H))

    out = io.BytesIO()
    src.save(out, format="JPEG", quality=THUMB_JPEG_QUALITY, optimize=True)
    return out.getvalue()


def _list_dir(abs_dir):
    """Return (folders, files) inside abs_dir. Filters dotfiles + non-workflow."""
    folders = []
    files = []
    try:
        entries = os.listdir(abs_dir)
    except FileNotFoundError:
        return folders, files
    for name in sorted(entries, key=str.lower):
        if _is_hidden(name):
            continue
        full = os.path.join(abs_dir, name)
        if os.path.isdir(full):
            folders.append(name)
        elif os.path.isfile(full) and name.lower().endswith(WORKFLOW_EXT):
            files.append(name)
    return folders, files


def _build_tree(abs_dir, rel_dir, root_base):
    folders, files = _list_dir(abs_dir)
    file_entries = []
    for name in files:
        full = os.path.join(abs_dir, name)
        rel_file = (rel_dir + "/" + name).lstrip("/")
        sidecar_rel, sidecar_mtime = _first_sidecar_info(full, root_base)
        try:
            mtime = os.path.getmtime(full)
            size = os.path.getsize(full)
        except OSError:
            mtime, size = 0, 0
        file_entries.append({
            "name": name,
            "path": rel_file,
            "thumb": sidecar_rel,
            "thumbMtime": sidecar_mtime,
            "description": _read_desc(full),
            "favorite": _is_fav(full),
            "tags": _read_tags(full),
            "mtime": mtime,
            "size": size,
        })

    subdirs = []
    for fname in folders:
        sub_rel = (rel_dir + "/" + fname).lstrip("/")
        sub_abs = os.path.join(abs_dir, fname)
        subdirs.append(_build_tree(sub_abs, sub_rel, root_base))

    return {
        "name": os.path.basename(abs_dir) if rel_dir else "",
        "path": rel_dir,
        "folders": subdirs,
        "files": file_entries,
    }


def _bad(msg, status=400):
    return web.json_response({"success": False, "error": msg}, status=status)


def _ok(payload=None):
    body = {"success": True}
    if payload:
        body.update(payload)
    return web.json_response(body)


_load_roots()  # warm the registry at import (routes also reload on demand)


def _fs_err(msg, path, parent):
    """Soft folder-browser error: HTTP 200 + success:false so the modal can
    show it inline and keep navigating instead of throwing."""
    return web.json_response({
        "success": False, "error": msg, "path": path,
        "parent": parent, "entries": [], "truncated": False,
    })


try:
    from server import PromptServer

    @PromptServer.instance.routes.get("/comfy_greg_templates/tree")
    async def route_tree(request):
        try:
            _ensure_root()
            _load_roots()
            roots_out = []
            for rid, r in _ROOTS.items():
                base = r["abspath"]
                if os.path.isdir(base):
                    tree = _build_tree(base, "", base)
                    available = True
                else:
                    tree = None
                    available = False
                roots_out.append({
                    "id": rid,
                    "label": r["label"],
                    "abspath": base,
                    "tree": tree,
                    "available": available,
                })
            return _ok({"roots": roots_out})
        except Exception as e:
            return _bad(str(e), 500)

    @PromptServer.instance.routes.get("/comfy_greg_templates/workflow")
    async def route_workflow(request):
        try:
            rel = request.query.get("path", "")
            if not rel.lower().endswith(WORKFLOW_EXT):
                return _bad("path must end with .json")
            abs_path = _resolve(rel, _root_of(request.query))
            if not os.path.isfile(abs_path):
                return _bad("not found", 404)
            with open(abs_path, "r", encoding="utf-8") as f:
                return web.Response(text=f.read(), content_type="application/json")
        except web.HTTPException:
            raise
        except Exception as e:
            return _bad(str(e), 500)

    @PromptServer.instance.routes.get("/comfy_greg_templates/thumb")
    async def route_thumb(request):
        try:
            rel = request.query.get("path", "")
            ext = os.path.splitext(rel)[1].lower()
            if ext not in THUMB_EXTS:
                return _bad("unsupported thumbnail extension")
            abs_path = _resolve(rel, _root_of(request.query))
            if not os.path.isfile(abs_path):
                return _bad("not found", 404)
            return web.FileResponse(abs_path, headers={"Cache-Control": "no-store, no-cache, must-revalidate"})
        except web.HTTPException:
            raise
        except Exception as e:
            return _bad(str(e), 500)

    @PromptServer.instance.routes.post("/comfy_greg_templates/save")
    async def route_save(request):
        """
        Body: {
          "path": "Folder/Sub/Foo.json",        # full target path (overwrite or new)
          "workflow": { ... },                  # the workflow JSON
          "thumbBase64": "data:image/...;base64,...",   # optional
          "thumbExt": ".png",                   # optional, defaults to .png
          "overwrite": true                     # required when target exists
        }
        """
        try:
            data = await request.json()
            root_id = _root_of(data)
            base = _base_of(root_id)
            rel = data.get("path", "")
            workflow = data.get("workflow")
            thumb_b64 = data.get("thumbBase64")
            thumb_ext = (data.get("thumbExt") or ".png").lower()
            overwrite = bool(data.get("overwrite", False))

            if workflow is None:
                return _bad("missing workflow")
            if not rel.lower().endswith(WORKFLOW_EXT):
                return _bad("path must end with .json")

            abs_path = _resolve(rel, root_id)
            if os.path.exists(abs_path) and not overwrite:
                return _bad("target exists; pass overwrite=true to replace", 409)

            os.makedirs(os.path.dirname(abs_path), exist_ok=True)
            with open(abs_path, "w", encoding="utf-8") as f:
                json.dump(workflow, f, indent=2, ensure_ascii=False)

            thumb_rel = None
            if thumb_b64:
                if thumb_ext not in THUMB_EXTS:
                    thumb_ext = ".png"
                stem = abs_path[: -len(WORKFLOW_EXT)]
                # When replacing a workflow that had a sidecar of a different
                # extension, remove the old sidecars so only the new one remains.
                for existing in _matching_sidecars(abs_path):
                    try:
                        os.remove(existing)
                    except OSError:
                        pass
                try:
                    jpg = _make_thumb_jpeg(_decode_data_url(thumb_b64))
                except Exception as e:
                    return _bad("could not process image: {}".format(e), 400)
                thumb_abs = stem + ".jpg"
                with open(thumb_abs, "wb") as f:
                    f.write(jpg)
                thumb_rel = _rel(thumb_abs, base)

            return _ok({
                "path": _rel(abs_path, base),
                "thumb": thumb_rel,
            })
        except web.HTTPException:
            raise
        except Exception as e:
            return _bad(str(e), 500)

    @PromptServer.instance.routes.post("/comfy_greg_templates/save_thumb")
    async def route_save_thumb(request):
        """Body: {path: '...json', thumbBase64: 'data:image/...', thumbExt: '.png'}"""
        try:
            data = await request.json()
            root_id = _root_of(data)
            base = _base_of(root_id)
            rel = data.get("path", "")
            thumb_b64 = data.get("thumbBase64")
            thumb_ext = (data.get("thumbExt") or ".png").lower()
            if not rel.lower().endswith(WORKFLOW_EXT):
                return _bad("path must end with .json")
            if not thumb_b64:
                return _bad("missing thumbBase64")
            if thumb_ext not in THUMB_EXTS:
                thumb_ext = ".png"
            abs_path = _resolve(rel, root_id)
            if not os.path.isfile(abs_path):
                return _bad("workflow not found", 404)
            for existing in _matching_sidecars(abs_path):
                try:
                    os.remove(existing)
                except OSError:
                    pass
            try:
                jpg = _make_thumb_jpeg(_decode_data_url(thumb_b64))
            except Exception as e:
                return _bad("could not process image: {}".format(e), 400)
            thumb_abs = abs_path[: -len(WORKFLOW_EXT)] + ".jpg"
            with open(thumb_abs, "wb") as f:
                f.write(jpg)
            return _ok({"thumb": _rel(thumb_abs, base)})
        except web.HTTPException:
            raise
        except Exception as e:
            return _bad(str(e), 500)

    @PromptServer.instance.routes.post("/comfy_greg_templates/delete_thumb")
    async def route_delete_thumb(request):
        """Body: {path: '...json', confirm: true}"""
        try:
            data = await request.json()
            if not data.get("confirm"):
                return _bad("confirm:true required", 400)
            root_id = _root_of(data)
            base = _base_of(root_id)
            rel = data.get("path", "")
            if not rel.lower().endswith(WORKFLOW_EXT):
                return _bad("path must end with .json")
            abs_path = _resolve(rel, root_id)
            # NOT a disk delete: rename each sidecar with REMOVED_SUFFIX so the
            # gallery stops showing it (the new name no longer matches an image
            # extension) while the image bytes remain on disk for the user to
            # delete manually if they choose.
            removed = []
            for sc in _matching_sidecars(abs_path):
                target = sc + REMOVED_SUFFIX
                n = 1
                while os.path.exists(target):
                    target = "{}{}.{}".format(sc, REMOVED_SUFFIX, n)
                    n += 1
                try:
                    os.rename(sc, target)
                    removed.append(_rel(target, base))
                except OSError as e:
                    print("[G-Workflows] thumb rename-on-remove failed: {}".format(e))
            return _ok({"removed": removed})
        except web.HTTPException:
            raise
        except Exception as e:
            return _bad(str(e), 500)

    @PromptServer.instance.routes.post("/comfy_greg_templates/set_desc")
    async def route_set_desc(request):
        """Body: {path: '...json', description: '...'}  (empty/blank clears it)"""
        try:
            data = await request.json()
            rel = data.get("path", "")
            description = data.get("description", "")
            if description is None:
                description = ""
            description = str(description)
            if not rel.lower().endswith(WORKFLOW_EXT):
                return _bad("path must end with .json")
            abs_path = _resolve(rel, _root_of(data))
            if not os.path.isfile(abs_path):
                return _bad("workflow not found", 404)
            desc_abs = _desc_path(abs_path)
            if not description.strip():
                if os.path.isfile(desc_abs):
                    try:
                        os.remove(desc_abs)
                    except OSError as e:
                        print("[G-Workflows] desc delete failed: {}".format(e))
                return _ok({"path": rel, "description": ""})
            with open(desc_abs, "w", encoding="utf-8") as f:
                f.write(description)
            return _ok({"path": rel, "description": description})
        except web.HTTPException:
            raise
        except Exception as e:
            return _bad(str(e), 500)

    @PromptServer.instance.routes.post("/comfy_greg_templates/set_tags")
    async def route_set_tags(request):
        """Body: {path: '...json', tags: ['flux','character'], root?: 'default'}.

        Overwrites the workflow's .tags.txt sidecar with the normalized list.
        Empty / missing list deletes the sidecar.
        """
        try:
            data = await request.json()
            rel = data.get("path", "")
            tags_in = data.get("tags") or []
            if not isinstance(tags_in, list):
                return _bad("'tags' must be a list of strings")
            if not rel.lower().endswith(WORKFLOW_EXT):
                return _bad("path must end with .json")
            abs_path = _resolve(rel, _root_of(data))
            if not os.path.isfile(abs_path):
                return _bad("workflow not found", 404)
            _write_tags(abs_path, tags_in)
            return _ok({"path": rel, "tags": _read_tags(abs_path)})
        except web.HTTPException:
            raise
        except Exception as e:
            return _bad(str(e), 500)

    @PromptServer.instance.routes.post("/comfy_greg_templates/set_fav")
    async def route_set_fav(request):
        """Body: {path: '...json', favorite: bool}.  Marker = <stem>.fav."""
        try:
            data = await request.json()
            rel = data.get("path", "")
            favorite = bool(data.get("favorite"))
            if not rel.lower().endswith(WORKFLOW_EXT):
                return _bad("path must end with .json")
            abs_path = _resolve(rel, _root_of(data))
            if not os.path.isfile(abs_path):
                return _bad("workflow not found", 404)
            fav_abs = _fav_path(abs_path)
            if favorite:
                if not os.path.isfile(fav_abs):
                    open(fav_abs, "w").close()
            else:
                if os.path.isfile(fav_abs):
                    try:
                        os.remove(fav_abs)
                    except OSError as e:
                        print("[G-Workflows] fav delete failed: {}".format(e))
            return _ok({"path": rel, "favorite": favorite})
        except web.HTTPException:
            raise
        except Exception as e:
            return _bad(str(e), 500)

    @PromptServer.instance.routes.post("/comfy_greg_templates/rename")
    async def route_rename(request):
        """Body: {from: 'a/b.json', to: 'a/c.json'}.  Auto-renames sidecars."""
        try:
            data = await request.json()
            root_id = _root_of(data)
            base = _base_of(root_id)
            src_rel = data.get("from", "")
            dst_rel = data.get("to", "")
            if not src_rel.lower().endswith(WORKFLOW_EXT) or not dst_rel.lower().endswith(WORKFLOW_EXT):
                return _bad("both from and to must end with .json")
            src = _resolve(src_rel, root_id)
            dst = _resolve(dst_rel, root_id)
            if not os.path.isfile(src):
                return _bad("source not found", 404)
            if os.path.exists(dst):
                return _bad("target exists", 409)
            _validate_segment(os.path.basename(dst))
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            os.rename(src, dst)
            moved_sidecars = []
            src_stem = src[: -len(WORKFLOW_EXT)]
            dst_stem = dst[: -len(WORKFLOW_EXT)]
            for ext in THUMB_EXTS:
                for candidate in (src_stem + ext, src_stem + ext.upper()):
                    if os.path.isfile(candidate):
                        new_sc = dst_stem + os.path.splitext(candidate)[1]
                        os.rename(candidate, new_sc)
                        moved_sidecars.append(_rel(new_sc, base))
            src_desc = src_stem + DESC_EXT
            if os.path.isfile(src_desc):
                os.rename(src_desc, dst_stem + DESC_EXT)
                moved_sidecars.append(_rel(dst_stem + DESC_EXT, base))
            src_fav = src_stem + FAV_EXT
            if os.path.isfile(src_fav):
                os.rename(src_fav, dst_stem + FAV_EXT)
                moved_sidecars.append(_rel(dst_stem + FAV_EXT, base))
            src_tags = src_stem + TAGS_EXT
            if os.path.isfile(src_tags):
                os.rename(src_tags, dst_stem + TAGS_EXT)
                moved_sidecars.append(_rel(dst_stem + TAGS_EXT, base))
            return _ok({
                "from": src_rel,
                "to": _rel(dst, base),
                "sidecars": moved_sidecars,
            })
        except web.HTTPException:
            raise
        except Exception as e:
            return _bad(str(e), 500)

    @PromptServer.instance.routes.post("/comfy_greg_templates/copy")
    async def route_copy(request):
        """Body: {from: 'a/b.json', to: 'c/d.json'}.  Auto-copies sidecars."""
        try:
            data = await request.json()
            root_id = _root_of(data)
            base = _base_of(root_id)
            src_rel = data.get("from", "")
            dst_rel = data.get("to", "")
            if not src_rel.lower().endswith(WORKFLOW_EXT) or not dst_rel.lower().endswith(WORKFLOW_EXT):
                return _bad("both from and to must end with .json")
            src = _resolve(src_rel, root_id)
            dst = _resolve(dst_rel, root_id)
            if not os.path.isfile(src):
                return _bad("source not found", 404)
            if os.path.exists(dst):
                return _bad("target exists", 409)
            _validate_segment(os.path.basename(dst))
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(src, dst)
            copied_sidecars = []
            src_stem = src[: -len(WORKFLOW_EXT)]
            dst_stem = dst[: -len(WORKFLOW_EXT)]
            for ext in THUMB_EXTS:
                for candidate in (src_stem + ext, src_stem + ext.upper()):
                    if os.path.isfile(candidate):
                        new_sc = dst_stem + os.path.splitext(candidate)[1]
                        shutil.copy2(candidate, new_sc)
                        copied_sidecars.append(_rel(new_sc, base))
            src_desc = src_stem + DESC_EXT
            if os.path.isfile(src_desc):
                shutil.copy2(src_desc, dst_stem + DESC_EXT)
                copied_sidecars.append(_rel(dst_stem + DESC_EXT, base))
            src_fav = src_stem + FAV_EXT
            if os.path.isfile(src_fav):
                shutil.copy2(src_fav, dst_stem + FAV_EXT)
                copied_sidecars.append(_rel(dst_stem + FAV_EXT, base))
            src_tags = src_stem + TAGS_EXT
            if os.path.isfile(src_tags):
                shutil.copy2(src_tags, dst_stem + TAGS_EXT)
                copied_sidecars.append(_rel(dst_stem + TAGS_EXT, base))
            return _ok({
                "from": src_rel,
                "to": _rel(dst, base),
                "sidecars": copied_sidecars,
            })
        except web.HTTPException:
            raise
        except Exception as e:
            return _bad(str(e), 500)

    @PromptServer.instance.routes.post("/comfy_greg_templates/move")
    async def route_move(request):
        """Body: {items: ['a/b.json', ...], toFolder: 'dest/sub'}"""
        try:
            data = await request.json()
            root_id = _root_of(data)
            base = _base_of(root_id)
            items = data.get("items") or []
            to_folder_rel = data.get("toFolder", "")
            dst_folder = _resolve(to_folder_rel, root_id) if to_folder_rel else base
            if os.path.exists(dst_folder) and not os.path.isdir(dst_folder):
                return _bad("target folder is not a folder")
            os.makedirs(dst_folder, exist_ok=True)
            moved = []
            errors = []
            for rel in items:
                try:
                    if not rel.lower().endswith(WORKFLOW_EXT):
                        errors.append({"item": rel, "error": "not a .json"})
                        continue
                    src = _resolve(rel, root_id)
                    if not os.path.isfile(src):
                        errors.append({"item": rel, "error": "not found"})
                        continue
                    fname = os.path.basename(src)
                    dst = os.path.join(dst_folder, fname)
                    if os.path.exists(dst):
                        errors.append({"item": rel, "error": "target exists"})
                        continue
                    os.rename(src, dst)
                    src_stem = src[: -len(WORKFLOW_EXT)]
                    dst_stem = dst[: -len(WORKFLOW_EXT)]
                    for ext in THUMB_EXTS:
                        for candidate in (src_stem + ext, src_stem + ext.upper()):
                            if os.path.isfile(candidate):
                                os.rename(candidate, dst_stem + os.path.splitext(candidate)[1])
                    src_desc = src_stem + DESC_EXT
                    if os.path.isfile(src_desc):
                        os.rename(src_desc, dst_stem + DESC_EXT)
                    src_fav = src_stem + FAV_EXT
                    if os.path.isfile(src_fav):
                        os.rename(src_fav, dst_stem + FAV_EXT)
                    src_tags = src_stem + TAGS_EXT
                    if os.path.isfile(src_tags):
                        os.rename(src_tags, dst_stem + TAGS_EXT)
                    moved.append({
                        "from": rel,
                        "to": _rel(dst, base),
                    })
                except Exception as e:
                    errors.append({"item": rel, "error": str(e)})
            return _ok({"moved": moved, "errors": errors})
        except web.HTTPException:
            raise
        except Exception as e:
            return _bad(str(e), 500)

    @PromptServer.instance.routes.post("/comfy_greg_templates/delete")
    async def route_delete(request):
        """Body: {items: ['a/b.json', ...], confirm: true}"""
        try:
            data = await request.json()
            if not data.get("confirm"):
                return _bad("confirm:true required", 400)
            root_id = _root_of(data)
            base = _base_of(root_id)
            items = data.get("items") or []
            deleted = []
            errors = []
            for rel in items:
                try:
                    if not rel.lower().endswith(WORKFLOW_EXT):
                        errors.append({"item": rel, "error": "not a .json"})
                        continue
                    abs_path = _resolve(rel, root_id)
                    if not os.path.isfile(abs_path):
                        errors.append({"item": rel, "error": "not found"})
                        continue
                    removed_here = []
                    sidecars = _matching_sidecars(abs_path)
                    os.remove(abs_path)
                    removed_here.append(rel)
                    for sc in sidecars:
                        try:
                            os.remove(sc)
                            removed_here.append(_rel(sc, base))
                        except OSError:
                            pass
                    desc_abs = _desc_path(abs_path)
                    if desc_abs and os.path.isfile(desc_abs):
                        try:
                            os.remove(desc_abs)
                            removed_here.append(_rel(desc_abs, base))
                        except OSError:
                            pass
                    fav_abs = _fav_path(abs_path)
                    if fav_abs and os.path.isfile(fav_abs):
                        try:
                            os.remove(fav_abs)
                            removed_here.append(_rel(fav_abs, base))
                        except OSError:
                            pass
                    tags_abs = _tags_path(abs_path)
                    if tags_abs and os.path.isfile(tags_abs):
                        try:
                            os.remove(tags_abs)
                            removed_here.append(_rel(tags_abs, base))
                        except OSError:
                            pass
                    deleted.extend(removed_here)
                except Exception as e:
                    errors.append({"item": rel, "error": str(e)})
            return _ok({"deleted": deleted, "errors": errors})
        except web.HTTPException:
            raise
        except Exception as e:
            return _bad(str(e), 500)

    @PromptServer.instance.routes.post("/comfy_greg_templates/mkdir")
    async def route_mkdir(request):
        """Body: {path: 'parent/rel', name: 'NewFolder'}"""
        try:
            data = await request.json()
            root_id = _root_of(data)
            base = _base_of(root_id)
            parent_rel = data.get("path", "")
            name = _validate_segment(data.get("name", ""))
            if _is_hidden(name):
                return _bad("folder name may not start with '.'")
            parent_abs = _resolve(parent_rel, root_id) if parent_rel else base
            if not os.path.isdir(parent_abs):
                return _bad("parent folder not found", 404)
            new_abs = os.path.join(parent_abs, name)
            if os.path.exists(new_abs):
                return _bad("folder already exists", 409)
            os.makedirs(new_abs)
            return _ok({"path": _rel(new_abs, base)})
        except web.HTTPException:
            raise
        except Exception as e:
            return _bad(str(e), 500)

    @PromptServer.instance.routes.post("/comfy_greg_templates/rmdir")
    async def route_rmdir(request):
        """Body: {path: 'a/b', recursive: false, confirm: true}"""
        try:
            data = await request.json()
            if not data.get("confirm"):
                return _bad("confirm:true required", 400)
            root_id = _root_of(data)
            rel = data.get("path", "")
            if not rel:
                return _bad("cannot delete root")
            abs_path = _resolve(rel, root_id)
            if _is_root_base(abs_path):
                return _bad("cannot delete a registered location root")
            if not os.path.isdir(abs_path):
                return _bad("folder not found", 404)
            recursive = bool(data.get("recursive", False))
            if recursive:
                shutil.rmtree(abs_path)
            else:
                try:
                    os.rmdir(abs_path)
                except OSError:
                    return _bad("folder not empty; pass recursive=true to force", 409)
            return _ok({"path": rel})
        except web.HTTPException:
            raise
        except Exception as e:
            return _bad(str(e), 500)

    @PromptServer.instance.routes.post("/comfy_greg_templates/rename_dir")
    async def route_rename_dir(request):
        """Body: {from: 'a/b', to: 'a/c'}"""
        try:
            data = await request.json()
            root_id = _root_of(data)
            src_rel = data.get("from", "")
            dst_rel = data.get("to", "")
            if not src_rel or not dst_rel:
                return _bad("missing from/to")
            src = _resolve(src_rel, root_id)
            dst = _resolve(dst_rel, root_id)
            if _is_root_base(src) or _is_root_base(dst):
                return _bad("cannot rename a registered location root")
            if not os.path.isdir(src):
                return _bad("source not found", 404)
            if os.path.exists(dst):
                return _bad("target exists", 409)
            _validate_segment(os.path.basename(dst))
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            os.rename(src, dst)
            return _ok({"from": src_rel, "to": dst_rel})
        except web.HTTPException:
            raise
        except Exception as e:
            return _bad(str(e), 500)

    # ── Folder browser + roots management ──────────────────────────────────

    @PromptServer.instance.routes.get("/comfy_greg_templates/fs_roots")
    async def route_fs_roots(request):
        """Top-level entry points for the server-side folder browser:
        existing drive letters + a few convenience shortcuts."""
        try:
            drives = []
            for c in "ABCDEFGHIJKLMNOPQRSTUVWXYZ":
                d = c + ":\\"
                try:
                    if os.path.exists(d):
                        drives.append({"label": d, "path": d})
                except OSError:
                    pass
            shortcuts = []
            try:
                home = os.path.normpath(os.path.expanduser("~"))
                if os.path.isdir(home):
                    shortcuts.append({"label": "Home", "path": home})
            except Exception:
                pass
            shortcuts.append({"label": "Default workflows", "path": TEMPLATES_DIR})
            return _ok({"drives": drives, "shortcuts": shortcuts})
        except Exception as e:
            return _bad(str(e), 500)

    @PromptServer.instance.routes.get("/comfy_greg_templates/fs_list")
    async def route_fs_list(request):
        """Folder-only listing of an ARBITRARY absolute path. Deliberately not
        _resolve()'d — the user is choosing where to register, so this browses
        anywhere; registration itself is what creates the allowlist entry."""
        raw = request.query.get("path", "")
        if not raw or not os.path.isabs(raw):
            return _fs_err("absolute path required", raw or "", None)
        path = os.path.normpath(raw)
        parent = os.path.dirname(path)
        if not parent or parent == path:   # at a drive / UNC share root
            parent = None
        try:
            entries = []
            truncated = False
            with os.scandir(path) as it:
                for e in it:
                    try:
                        if not e.is_dir():
                            continue
                    except OSError:
                        continue
                    hidden = e.name.startswith(".")
                    try:
                        attrs = e.stat(follow_symlinks=False).st_file_attributes
                        if attrs & (stat.FILE_ATTRIBUTE_HIDDEN | stat.FILE_ATTRIBUTE_SYSTEM):
                            hidden = True
                    except (OSError, AttributeError):
                        pass
                    entries.append({
                        "name": e.name,
                        "path": os.path.join(path, e.name),
                        "hidden": hidden,
                    })
                    if len(entries) >= 5000:
                        truncated = True
                        break
            entries.sort(key=lambda x: x["name"].lower())
            return _ok({"path": path, "parent": parent,
                        "entries": entries, "truncated": truncated})
        except PermissionError:
            return _fs_err("permission denied", path, parent)
        except (FileNotFoundError, NotADirectoryError):
            return _fs_err("folder not found", path, parent)
        except OSError as e:
            return _fs_err(str(e), path, parent)

    @PromptServer.instance.routes.get("/comfy_greg_templates/list_roots")
    async def route_list_roots(request):
        try:
            _load_roots()
            out = [{
                "id": r["id"], "label": r["label"], "abspath": r["abspath"],
                "available": (r["id"] == DEFAULT_ROOT_ID) or os.path.isdir(r["abspath"]),
            } for r in _ROOTS.values()]
            return _ok({"roots": out})
        except Exception as e:
            return _bad(str(e), 500)

    @PromptServer.instance.routes.post("/comfy_greg_templates/add_root")
    async def route_add_root(request):
        """Body: {path: '<absolute folder>'}. Registers a new peer location.
        Rejects: the default root, an already-registered path, or any folder
        that overlaps (is inside / contains) an existing root."""
        try:
            _load_roots()
            data = await request.json()
            raw = data.get("path", "")
            if not raw or not isinstance(raw, str):
                return _bad("path required")
            ap = os.path.normpath(raw)
            if not os.path.isabs(ap):
                return _bad("absolute path required")
            if not os.path.isdir(ap):
                return _bad("folder not found")
            cap = _canon(ap)
            if cap == _canon(TEMPLATES_DIR):
                return _bad("that is already the default workflows location")
            for r in _ROOTS.values():
                rb = r["abspath"]
                if _canon(rb) == cap:
                    return _bad("this location is already registered")
                if _is_within(ap, rb):
                    return _bad("cannot register a folder that is inside an "
                                "already-registered location")
                if _is_within(rb, ap):
                    return _bad("cannot register a folder that contains an "
                                "already-registered location")
            rid = _root_id_for_path(ap)
            label = os.path.basename(ap.rstrip("/\\")) or ap
            _ROOTS[rid] = {"id": rid, "label": label, "abspath": ap,
                           "available": True}
            try:
                _save_roots()
            except Exception as e:
                _ROOTS.pop(rid, None)
                return _bad("could not save roots config: {}".format(e), 500)
            return _ok({"root": {"id": rid, "label": label, "abspath": ap}})
        except web.HTTPException:
            raise
        except Exception as e:
            return _bad(str(e), 500)

    @PromptServer.instance.routes.post("/comfy_greg_templates/remove_root")
    async def route_remove_root(request):
        """Body: {id: '<root id>'}. Unregisters a location. Never deletes any
        files on disk. The default location cannot be removed."""
        try:
            _load_roots()
            data = await request.json()
            rid = str(data.get("id", ""))
            if rid == DEFAULT_ROOT_ID:
                return _bad("the default location cannot be removed")
            if rid not in _ROOTS:
                return _ok({"id": rid})   # idempotent no-op
            _ROOTS.pop(rid, None)
            try:
                _save_roots()
            except Exception as e:
                return _bad("could not save roots config: {}".format(e), 500)
            return _ok({"id": rid})
        except web.HTTPException:
            raise
        except Exception as e:
            return _bad(str(e), 500)

    print("[G-Workflows] Routes registered. Default root: {} | extra roots: {}"
          .format(TEMPLATES_DIR, len(_ROOTS) - 1))

except ImportError:
    print("[G-Workflows] Warning: PromptServer not available — API routes skipped.")

_ensure_root()

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
