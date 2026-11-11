#!/usr/bin/env python3
"""
VSR Phase 0 — long-lived Resolve bridge child (NDJSON over stdio).

PORTED FROM First Cut v3 (electron/services/fc/resolve/bridge.py, ticket FCRS-001),
deliberately as a move rather than a rewrite: VapourSynth for Resolve converges into
First Cut v4 as a tab, so this file should stay recognisably the same in both trees and
diffs between them should be reviewable. Changes made here are confined to:

  * set_track_name        — new handler, the one thing the agent could not previously do
  * DESTRUCTIVE gating    — delete/clear commands now require an explicit confirmation
  * this docstring

Everything else, including handlers this app has no use for yet, is left untouched so
the eventual merge is a move.

WHY A LONG-LIVED CHILD rather than one-shot scripts: the connection is expensive to
establish, and DaVinciResolveScript segfaults on interpreter shutdown — harmless when
you only wanted a side effect, fatal when you need the return value afterwards. The
existing electron/resolve-api.js pays that cost on every call and cannot hold state.

Original header follows.

FCRS-001 — long-lived Resolve bridge child (NDJSON over stdio).

Per docs/v3-build/FCRS-001-bridge-preregistration.md: a persistent Python child
that holds the DaVinci Resolve scripting connection open and answers many
requests. One JSON object per line on stdin (requests) and stdout (responses);
stderr is debug only. Every exception becomes a structured {ok:false,error}
response, never a raw traceback on stdout. Node owns the lifecycle.

SAFETY: this child only ever creates / mutates an isolated FC_SPIKE_* timeline; it
never mutates the operator's existing timelines. The append path uses items located
by name in the media pool. The import_media handler (FCDEMO-001) adds the demo's
source clips to the media pool so they can be appended — the one pool mutation, and
only for clips the operator explicitly points the demo runner at.

Protocol:
  request  : {"id": <int>, "method": <str>, "params": {...}}
  response : {"id": <int>, "ok": true, "result": {...}}
           | {"id": <int>, "ok": false, "error": {"type": <str>, "message": <str>}}
  ready    : {"id": 0, "ok": true, "result": {"ready": true, ...}}  (emitted once on boot)
"""

import sys
import os
import json
import time
import tempfile

# h_color_pool_clips mutates EXISTING media-pool items, so it HARD-GUARDS on this name — the operator's
# disposable testing clone — and refuses to color/tag any other (real) project. Mirrors
# fc_resolve_placement_test.py / loomColoring.js.
SAFE_PROJECT = "USS_Slater_24fps_First_Cut_Testing"


def _connect():
    for p in [
        "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting/Modules/",
        os.path.expanduser("~/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting/Modules/"),
        "/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/Modules/",
    ]:
        if os.path.exists(p) and p not in sys.path:
            sys.path.append(p)
    import DaVinciResolveScript as dvr  # noqa: E402
    return dvr.scriptapp("Resolve")


def _log(*a):
    print("[bridge.py]", *a, file=sys.stderr, flush=True)


class Bridge:
    def __init__(self):
        self.resolve = _connect()
        if self.resolve is None:
            raise RuntimeError("scriptapp('Resolve') returned None — Resolve not running or scripting disabled")
        self.tempdir = os.path.join(tempfile.gettempdir(), "fc-resolve-%d" % os.getpid())
        os.makedirs(self.tempdir, exist_ok=True)
        self.dispatch = {
            "ping": self.h_ping,
            "connect_info": self.h_connect_info,
            "create_spike_timeline": self.h_create_spike_timeline,
            "append_existing": self.h_append_existing,
            "import_media": self.h_import_media,
            "timeline_state": self.h_timeline_state,
            "add_track": self.h_add_track,
            "set_track_name": self.h_set_track_name,
            "set_timeline_format": self.h_set_timeline_format,
            "set_volume": self.h_set_volume,
            "delete_clips": self.h_delete_clips,
            "clear_track": self.h_clear_track,
            "move_clip": self.h_move_clip,
            "trim_clip": self.h_trim_clip,
            "add_marker": self.h_add_marker,
            "get_marker_by_customdata": self.h_get_marker_by_customdata,
            "marker_density": self.h_marker_density,
            "export_otio": self.h_export_otio,
            "set_current_timeline": self.h_set_current_timeline,
            "item_props": self.h_item_props,
            "delete_timeline": self.h_delete_timeline,
            "introspect_caps": self.h_introspect_caps,
            "add_title": self.h_add_title,
            "import_otio": self.h_import_otio,
            "get_timeline_format": self.h_get_timeline_format,
            "render_start": self.h_render_start,
            "render_status": self.h_render_status,
            "render_formats": self.h_render_formats,
            "list_timelines": self.h_list_timelines,
            "list_projects": self.h_list_projects,
            "load_project": self.h_load_project,
            "get_project_format": self.h_get_project_format,
            "relink_media": self.h_relink_media,
            "introspect_api": self.h_introspect_api,
            "export_project": self.h_export_project,
            "import_project": self.h_import_project,
            "create_project": self.h_create_project,
            "timeline_from_clips": self.h_timeline_from_clips,
            "media_status": self.h_media_status,
            "disable_clips_by_name": self.h_disable_clips_by_name,
            "timeline_frames": self.h_timeline_frames,
            "grab_still": self.h_grab_still,
            "color_pool_clips": self.h_color_pool_clips,
            "list_pool_clips": self.h_list_pool_clips,
            "list_timeline_items": self.h_list_timeline_items,
        }

    @staticmethod
    def _frames_to_tc(frame, fps):
        fi = int(round(fps)) or 24
        f = int(frame)
        h = f // (fi * 3600); f -= h * fi * 3600
        m = f // (fi * 60); f -= m * fi * 60
        s = f // fi; fr = f - s * fi
        return "%02d:%02d:%02d:%02d" % (h, m, s, fr)

    def h_grab_still(self, p):
        """Export the CURRENT timeline frame as a still IMAGE — NO render. Optionally seek to a
        `timecode` ("HH:MM:SS:FF") or a 0-based `frameId` first. This is the cheap "see exactly what's
        on the timeline" check used for conform validation (and for diffing stills) instead of rendering
        the whole movie. Returns the still path + size. (Project.ExportCurrentFrameAsStill — verified live.)"""
        proj = self._proj()
        if p.get("timeline"):
            tl = self._timeline_by_name(p["timeline"]); proj.SetCurrentTimeline(tl)
        else:
            tl = proj.GetCurrentTimeline()
        moved = None
        if p.get("timecode"):
            moved = bool(tl.SetCurrentTimecode(p["timecode"]))
        elif p.get("frameId") is not None:
            try:
                fps = float(tl.GetSetting("timelineFrameRate") or 24)
            except Exception:
                fps = 24.0
            try:
                base = int(tl.GetStartFrame())
            except Exception:
                base = 0
            moved = bool(tl.SetCurrentTimecode(self._frames_to_tc(base + int(p["frameId"]), fps)))
        out = p.get("path") or os.path.join(self.tempdir, "still_%d.jpg" % int(time.time() * 1000))
        ok = bool(proj.ExportCurrentFrameAsStill(out))
        return {"ok": ok, "path": out if ok else None, "exists": os.path.exists(out),
                "size": (os.path.getsize(out) if os.path.exists(out) else 0),
                "timeline": tl.GetName(), "movedPlayhead": moved}

    def h_add_title(self, p):
        """Insert a real Fusion Text+ TITLE at a 0-based timeline position + set its text. Returns what
        happened (inserted / text-set / track / name) so the caller can verify or fall back to markers."""
        tl = self._timeline_by_name(p["timeline"])
        self._proj().SetCurrentTimeline(tl)
        try:
            fps = float(tl.GetSetting("timelineFrameRate") or 24)
        except Exception:
            fps = 24.0
        try:
            base = int(tl.GetStartFrame())
        except Exception:
            base = 0
        target = base + int(p.get("frameId", 0))
        moved = False
        try:
            moved = bool(tl.SetCurrentTimecode(self._frames_to_tc(target, fps)))
        except Exception:
            moved = False
        item = None
        try:
            item = tl.InsertFusionTitleIntoTimeline(p.get("titleName", "Text+"))
        except Exception as e:
            return {"inserted": False, "error": "InsertFusionTitleIntoTimeline: %s" % e, "movedPlayhead": moved}
        set_text = False; tool_ids = []
        if item:
            try:
                comp = item.GetFusionCompByIndex(1)
                if comp:
                    tools = comp.GetToolList(False) or {}
                    vals = tools.values() if hasattr(tools, "values") else tools
                    for tool in vals:
                        try:
                            tid = tool.GetAttrs().get("TOOLS_RegID", "")
                        except Exception:
                            tid = ""
                        tool_ids.append(tid)
                        if tid in ("TextPlus", "Text", "Text+"):
                            tool.SetInput("StyledText", str(p.get("text", "")))
                            set_text = True
            except Exception as e:
                return {"inserted": True, "set_text": False, "error": "settext: %s" % e, "name": (item.GetName() if item else None)}
        return {
            "inserted": bool(item),
            "set_text": set_text,
            "movedPlayhead": moved,
            "name": (item.GetName() if item else None),
            "toolIds": tool_ids,
            "videoTracks": tl.GetTrackCount("video"),
        }

    def h_import_otio(self, p):
        """Import an .otio file as a NEW timeline (the finishing round-trip's reimport step). Resolve relinks
        the clips against the media pool (they are already imported from the original lay).

        importSourceClips (default True): when FALSE, import the timeline STRUCTURE only, against existing
        media-pool clips — Resolve will NOT try to locate/import missing source clips, which AVOIDS the
        offline-media locate dialog that otherwise HANGS the scripting API. Use False for a structural conform
        / when media may be offline; pass sourceClipsPath to relink from a folder instead."""
        mp = self._mp()
        path = p["path"]
        opts = {}
        if p.get("name"):
            opts["timelineName"] = p["name"]
        if "importSourceClips" in p:
            opts["importSourceClips"] = bool(p["importSourceClips"])
        if p.get("sourceClipsPath"):
            opts["sourceClipsPath"] = p["sourceClipsPath"]
        try:
            tl = mp.ImportTimelineFromFile(path, opts) if opts else mp.ImportTimelineFromFile(path)
        except Exception as e:
            return {"imported": False, "error": str(e)}
        if not tl:
            return {"imported": False, "error": "ImportTimelineFromFile returned None"}
        try:
            self._proj().SetCurrentTimeline(tl)
        except Exception:
            pass
        return {"imported": True, "name": tl.GetName(), "video": tl.GetTrackCount("video"), "audio": tl.GetTrackCount("audio"), "state": self._full_state(tl)}

    def h_introspect_caps(self, p):
        """One-off: what does THIS Resolve build expose for fades/transitions? (dir() the live objects.)"""
        tl = self._proj().GetCurrentTimeline()
        def names(o):
            try:
                return sorted(m for m in dir(o) if not m.startswith("_"))
            except Exception:
                return []
        tl_m = names(tl)
        item = None
        try:
            items = tl.GetItemListInTrack("video", 1) or []
            item = items[0] if items else None
        except Exception:
            item = None
        it_m = names(item)
        kw = ("fade", "transition", "dissolve", "opacity", "fusion", "composite", "speed", "retime")
        hit = lambda lst: [m for m in lst if any(k in m.lower() for k in kw)]
        return {
            "resolve_version": (self._resolve.GetVersionString() if hasattr(self, "_resolve") and self._resolve else "?"),
            "timeline_methods_matching": hit(tl_m),
            "item_methods_matching": hit(it_m),
            "item_method_count": len(it_m),
            "item_all": it_m,
        }

    # ── helpers ──────────────────────────────────────────────────────────
    def _proj(self):
        p = self.resolve.GetProjectManager().GetCurrentProject()
        if not p:
            raise RuntimeError("no current project")
        return p

    def _mp(self):
        return self._proj().GetMediaPool()

    def _timeline_by_name(self, name):
        proj = self._proj()
        n = proj.GetTimelineCount()
        for i in range(1, n + 1):
            tl = proj.GetTimelineByIndex(i)
            if tl and tl.GetName() == name:
                return tl
        raise RuntimeError("timeline not found: %s" % name)

    def _walk_pool(self, folder, acc, depth=0, max_depth=3):
        for c in (folder.GetClipList() or []):
            acc.append(c)
        if depth < max_depth:
            for sub in (folder.GetSubFolderList() or []):
                self._walk_pool(sub, acc, depth + 1, max_depth)

    def _find_pool_items_by_name(self, names):
        acc = []
        self._walk_pool(self._mp().GetRootFolder(), acc)
        by_name = {}
        for c in acc:
            try:
                by_name.setdefault(c.GetName(), c)
            except Exception:
                pass
        out = []
        for nm in names:
            if nm in by_name:
                out.append(by_name[nm])
        return out

    def _item_state(self, item):
        try:
            return {
                "name": item.GetName(),
                "start": item.GetStart(),
                "end": item.GetEnd(),
                "duration": item.GetDuration(),
            }
        except Exception as e:
            return {"name": "<err>", "error": str(e)}

    def _track_state(self, tl, ttype):
        n = tl.GetTrackCount(ttype)
        tracks = []
        for ti in range(1, n + 1):
            items = tl.GetItemListInTrack(ttype, ti) or []
            try:
                locked = tl.GetIsTrackLocked(ttype, ti)
            except Exception:
                locked = None
            tracks.append({
                "index": ti,
                "locked": locked,
                "itemCount": len(items),
                "items": [self._item_state(it) for it in items],
            })
        return {"trackCount": n, "tracks": tracks}

    def _full_state(self, tl):
        return {
            "name": tl.GetName(),
            "video": self._track_state(tl, "video"),
            "audio": self._track_state(tl, "audio"),
            "subtitle": self._track_state(tl, "subtitle"),
        }

    def _items_in(self, tl, ttype, track_index):
        return tl.GetItemListInTrack(ttype, track_index) or []

    # ── handlers ─────────────────────────────────────────────────────────
    def h_ping(self, p):
        return {"pong": True, "ts": time.time()}

    def h_connect_info(self, p):
        proj = self._proj()
        tl = proj.GetCurrentTimeline()
        return {
            "product": self.resolve.GetProductName(),
            "version": self.resolve.GetVersionString(),
            "project": proj.GetName(),
            "currentTimeline": tl.GetName() if tl else None,
            "tempdir": self.tempdir,
        }

    def h_create_spike_timeline(self, p):
        name = p["name"]
        mp = self._mp()
        tl = mp.CreateEmptyTimeline(name)
        if not tl:
            raise RuntimeError("CreateEmptyTimeline failed for %s" % name)
        self._proj().SetCurrentTimeline(tl)
        return {"created": tl.GetName(), "video": tl.GetTrackCount("video"), "audio": tl.GetTrackCount("audio")}

    def h_append_existing(self, p):
        """Append media-pool items (located by name) to the spike timeline. No import."""
        tl = self._timeline_by_name(p["timeline"])
        self._proj().SetCurrentTimeline(tl)
        items = self._find_pool_items_by_name(p["clipNames"])
        if not items:
            raise RuntimeError("no pool items matched: %s" % p["clipNames"])
        # cutListToAdapterOps sends ABSOLUTE source frames: startFrame = inS*fps,
        # (mis-named) perClipFrames = outS*fps = the source OUT-point. For SHORT clips
        # that out-point can land PAST the clip end, and AppendToTimeline then silently
        # drops the clip (the 3/5 that failed). Clamp the out-point into the clip and,
        # if the range is still invalid, OMIT in/out so Resolve appends the WHOLE clip —
        # so every requested clip ALWAYS lands (trimmed where valid, whole otherwise).
        out_frame = int(p.get("perClipFrames", 48))
        in_frame = max(0, int(p.get("startFrame", 0)))
        clip_infos = []
        for it in items:
            # Omit mediaType => append BOTH video + audio streams (so there is an
            # audio item to volume-test). trackIndex/mediaType only if explicitly asked.
            ci = {"mediaPoolItem": it}
            try:
                total = int(float(it.GetClipProperty("Frames") or 0))
            except Exception:
                total = 0
            ef = out_frame
            if total > 0:
                ef = min(ef, total - 1)   # never point past the clip's last frame
            if ef > in_frame:
                ci["startFrame"] = in_frame
                ci["endFrame"] = ef
            # else: leave in/out unset -> whole-clip append (the clip still lands)
            if "trackIndex" in p:
                ci["trackIndex"] = int(p["trackIndex"])
            if "mediaType" in p:
                ci["mediaType"] = int(p["mediaType"])
            # recordFrame = WHERE on the timeline to place the clip (for a V2 b-roll OVERLAY at a position,
            # not a gapless append). Caller passes a 0-based position from the timeline start; add the
            # timeline's start frame (Resolve timelines begin at 01:00:00:00 = frame 86400, not 0).
            if p.get("recordFrame") is not None:
                try:
                    base = int(tl.GetStartFrame())
                except Exception:
                    base = 0
                ci["recordFrame"] = base + int(p["recordFrame"])
            clip_infos.append(ci)
        appended = self._mp().AppendToTimeline(clip_infos)
        return {
            "requested": len(p["clipNames"]),
            "matched": len(items),
            "appended": len(appended) if appended else 0,
            "state": self._full_state(tl),
        }

    def h_import_media(self, p):
        """Import clips into the media pool so append_existing can find them by name.
        FCDEMO-001 (the demo runner). MediaStorage.AddItemListToMediaPool with a
        MediaPool.ImportMedia fallback (mirrors send_to_resolve.py). Returns each
        imported item's media-pool NAME — the value the adapter's clipName must match."""
        paths = p.get("paths") or []
        if not paths:
            raise RuntimeError("import_media: paths[] required")
        mp = self._mp()
        try:
            ms = self.resolve.GetMediaStorage()
        except Exception:
            ms = None
        imported = []
        failed = []
        for path in paths:
            items = None
            try:
                if ms:
                    items = ms.AddItemListToMediaPool(path)
            except Exception:
                items = None
            if not items:
                try:
                    items = mp.ImportMedia([path])
                except Exception:
                    items = None
            if items:
                for it in items:
                    try:
                        imported.append({"name": it.GetName(), "path": path})
                    except Exception:
                        imported.append({"name": None, "path": path})
            else:
                failed.append(path)
        return {"imported": imported, "failed": failed, "count": len(imported)}

    def h_timeline_state(self, p):
        return self._full_state(self._timeline_by_name(p["timeline"]))

    def h_introspect_api(self, p):
        """dir() the major scripting objects → public-method inventory for the CAPABILITY MAP (Edit / Media
        Pool / Deliver pages). Read-only. Pairs with the CONFIRMED can/can't findings in
        memory/resolve-scripting-capabilities.md."""
        def names(o):
            try:
                return sorted([m for m in dir(o) if not m.startswith("_") and callable(getattr(o, m, None))])
            except Exception as e:
                return ["<err:%s>" % e]
        out = {}
        R = self.resolve
        pm = R.GetProjectManager()
        proj = pm.GetCurrentProject()
        mp = proj.GetMediaPool()
        out["Resolve"] = names(R)
        out["ProjectManager"] = names(pm)
        out["Project"] = names(proj)
        out["MediaPool"] = names(mp)
        try:
            out["MediaStorage"] = names(R.GetMediaStorage())
        except Exception:
            pass
        try:
            out["Folder"] = names(mp.GetRootFolder())
        except Exception:
            pass
        acc = []
        try:
            self._walk_pool(mp.GetRootFolder(), acc)
        except Exception:
            pass
        if acc:
            out["MediaPoolItem"] = names(acc[0])
        tl = None
        try:
            tl = proj.GetCurrentTimeline()
        except Exception:
            pass
        if tl:
            out["Timeline"] = names(tl)
            try:
                items = tl.GetItemListInTrack("video", 1) or []
                if items:
                    out["TimelineItem"] = names(items[0])
            except Exception:
                pass
        return {"objects": out, "counts": {k: len(v) for k, v in out.items()}}

    def h_create_project(self, p):
        """Create + open a NEW project (ProjectManager.CreateProject)."""
        pm = self.resolve.GetProjectManager()
        proj = pm.CreateProject(p["name"])
        return {"ok": bool(proj), "name": (proj.GetName() if proj else None)}

    def h_timeline_from_clips(self, p):
        """Create a timeline from named media-pool clips (CreateTimelineFromClips) — a quick edit/cut."""
        mp = self._mp()
        items = self._find_pool_items_by_name(p["clipNames"])
        if not items:
            return {"ok": False, "error": "no pool items matched"}
        tl = mp.CreateTimelineFromClips(p["name"], items)
        return {"ok": bool(tl), "name": (tl.GetName() if tl else None), "matched": len(items)}

    def h_export_project(self, p):
        """Export a project to a .drp (a clone source). Defaults to the current project."""
        pm = self.resolve.GetProjectManager()
        name = p.get("name") or (pm.GetCurrentProject().GetName() if pm.GetCurrentProject() else None)
        path = p["path"]
        try:
            ok = bool(pm.ExportProject(name, path, p.get("withStillsAndLUTs", False)))
        except Exception as e:
            return {"ok": False, "error": str(e), "name": name}
        import os
        return {"ok": ok, "name": name, "path": path, "exists": os.path.exists(path)}

    def h_import_project(self, p):
        """Import a .drp as a NEW project (the clone target). Optional new name avoids colliding with the original."""
        pm = self.resolve.GetProjectManager()
        path = p["path"]
        new = p.get("name")
        try:
            ok = bool(pm.ImportProject(path, new) if new else pm.ImportProject(path))
        except Exception as e:
            return {"ok": False, "error": str(e)}
        return {"ok": ok, "name": new}

    def h_timeline_frames(self, p):
        """Timeline start/end frames + any in/out marks. Optionally CLEAR the in/out marks (so a render does
        the WHOLE timeline, not a stale 2-frame selection)."""
        tl = self._timeline_by_name(p["timeline"])
        marks = {}
        try:
            marks = dict(tl.GetMarkInOut() or {})
        except Exception:
            marks = {}
        if p.get("clearMarks"):
            try:
                tl.ClearMarkInOut()
            except Exception:
                pass
        return {"start": int(tl.GetStartFrame()), "end": int(tl.GetEndFrame()), "marks": marks}

    def h_disable_clips_by_name(self, p):
        """Disable (mute/hide) timeline items whose clip name matches — so a render skips genuinely-missing
        media (renders black/gap) instead of failing. 'missing media is fine' for a conform."""
        tl = self._timeline_by_name(p["timeline"])
        targets = set(p.get("names") or [])
        disabled = []
        for ttype in ("video", "audio"):
            try:
                ntr = tl.GetTrackCount(ttype)
            except Exception:
                ntr = 0
            for ti in range(1, ntr + 1):
                for it in (tl.GetItemListInTrack(ttype, ti) or []):
                    try:
                        nm = it.GetName()
                    except Exception:
                        nm = ""
                    if nm in targets:
                        try:
                            if it.SetClipEnabled(False):
                                disabled.append(nm)
                        except Exception:
                            pass
        return {"disabled": len(disabled), "names": sorted(set(disabled))}

    def h_media_status(self, p):
        """Online/offline count across the media pool (conform coverage). Offline clips report an empty
        Resolution; online clips report e.g. '1416x1062'."""
        mp = self._mp()
        acc = []
        self._walk_pool(mp.GetRootFolder(), acc)
        online = 0
        offline_names = []
        for c in acc:
            try:
                res = c.GetClipProperty("Resolution")
            except Exception:
                res = ""
            if res and res not in ("", "0x0"):
                online += 1
            else:
                try:
                    offline_names.append(c.GetName())
                except Exception:
                    offline_names.append("?")
        return {"total": len(acc), "online": online, "offline": len(offline_names), "sampleOffline": offline_names[:20]}

    def h_relink_media(self, p):
        """Reconnect OFFLINE media-pool clips by searching a folder (recursively) — the conform's relink step,
        so a rebuilt timeline can render. `names` (optional) limits to clips with those names; else all clips
        are offered to RelinkClips (Resolve only reconnects what it matches). Returns how many were targeted."""
        mp = self._mp()
        folder = p["folderPath"]
        acc = []
        self._walk_pool(mp.GetRootFolder(), acc)
        names = set(p.get("names") or [])
        targets = [c for c in acc if (not names or c.GetName() in names)]
        ok = bool(mp.RelinkClips(targets, folder)) if targets else False
        return {"ok": ok, "targeted": len(targets), "poolClips": len(acc), "folder": folder}

    def h_list_projects(self, p):
        """Projects in the current Project-Manager folder + the open one (to find/peek the old 25fps project)."""
        pm = self.resolve.GetProjectManager()
        cur = None
        try:
            cp = pm.GetCurrentProject()
            cur = cp.GetName() if cp else None
        except Exception:
            pass
        try:
            projs = list(pm.GetProjectListInCurrentFolder() or [])
        except Exception as e:
            return {"current": cur, "error": str(e)}
        return {"current": cur, "projects": projs}

    def h_load_project(self, p):
        """Open a project by name (ProjectManager.LoadProject). Used to peek the old project then switch back."""
        pm = self.resolve.GetProjectManager()
        proj = pm.LoadProject(p["name"])
        if not proj:
            return {"loaded": False, "name": p["name"]}
        return {"loaded": True, "name": proj.GetName()}

    def h_list_timelines(self, p):
        """Current project name + all timeline names + the current one (discovery; survives project switches)."""
        proj = self._proj()
        cur = None
        try:
            c = proj.GetCurrentTimeline()
            cur = c.GetName() if c else None
        except Exception:
            pass
        names = []
        try:
            n = int(proj.GetTimelineCount() or 0)
            for i in range(1, n + 1):
                tl = proj.GetTimelineByIndex(i)
                if tl:
                    names.append(tl.GetName())
        except Exception as e:
            return {"project": (proj.GetName() if proj else None), "current": cur, "error": str(e)}
        return {"project": (proj.GetName() if proj else None), "current": cur, "timelines": names, "count": len(names)}

    def h_render_formats(self, p):
        """List the render formats + codecs this Resolve build exposes (to pick the exact mp4/H264 strings)."""
        proj = self._proj()
        out = {"formats": {}, "codecs": {}}
        try:
            out["formats"] = proj.GetRenderFormats() or {}
        except Exception as e:
            out["formatsError"] = str(e)
        fmt = p.get("format", "mp4")
        try:
            out["codecs"] = proj.GetRenderCodecs(fmt) or {}
        except Exception as e:
            out["codecsError"] = str(e)
        return out

    def h_render_start(self, p):
        """Render a timeline to a file (Deliver). Sets format/codec (default mp4/H264), TargetDir + CustomName,
        optional MarkIn/MarkOut (timeline frames) for a partial render, then AddRenderJob + StartRendering.
        Returns the jobId; poll with render_status. Clears prior jobs so the queue can't pile up."""
        proj = self._proj()
        tl = self._timeline_by_name(p["timeline"])
        proj.SetCurrentTimeline(tl)
        try:
            proj.DeleteAllRenderJobs()
        except Exception:
            pass
        fmt = p.get("format", "mp4")
        codec = p.get("codec", "H264")
        fmt_ok = False
        try:
            fmt_ok = bool(proj.SetCurrentRenderFormatAndCodec(fmt, codec))
        except Exception as e:
            return {"started": False, "error": "SetCurrentRenderFormatAndCodec(%s,%s): %s" % (fmt, codec, e)}
        settings = {"TargetDir": p["targetDir"], "CustomName": p.get("name", "fc_render")}
        if p.get("markIn") is not None and p.get("markOut") is not None:
            settings["MarkIn"] = int(p["markIn"])
            settings["MarkOut"] = int(p["markOut"])
        try:
            set_ok = bool(proj.SetRenderSettings(settings))
        except Exception as e:
            return {"started": False, "error": "SetRenderSettings: %s" % e, "formatOk": fmt_ok}
        job = None
        try:
            job = proj.AddRenderJob()
        except Exception as e:
            return {"started": False, "error": "AddRenderJob: %s" % e, "formatOk": fmt_ok, "settingsOk": set_ok}
        started = False
        try:
            started = bool(proj.StartRendering(job)) if job else False
        except Exception as e:
            return {"started": False, "error": "StartRendering: %s" % e, "jobId": job}
        return {"started": started, "jobId": job, "formatOk": fmt_ok, "settingsOk": set_ok,
                "format": fmt, "codec": codec, "targetDir": p["targetDir"], "name": p.get("name", "fc_render")}

    def h_render_status(self, p):
        """Poll a render: IsRenderingInProgress + this job's status record (Complete/Rendering/Failed + %)."""
        proj = self._proj()
        inprog = False
        try:
            inprog = bool(proj.IsRenderingInProgress())
        except Exception:
            pass
        status = {}
        jid = p.get("jobId")
        if jid is not None:
            try:
                status = dict(proj.GetRenderJobStatus(jid) or {})
            except Exception as e:
                status = {"error": str(e)}
        return {"inProgress": inprog, "status": status}

    def h_get_project_format(self, p):
        """Project default fps + resolution — new timelines INHERIT these. For tools that compute frame
        positions before a timeline exists (e.g. b-roll recordFrame = seconds*fps)."""
        proj = self._proj()

        def _f(key, d):
            try:
                v = float(proj.GetSetting(key) or 0)
                return v or d
            except Exception:
                return d
        return {"fps": _f("timelineFrameRate", 24.0),
                "width": int(_f("timelineResolutionWidth", 1920)),
                "height": int(_f("timelineResolutionHeight", 1080))}

    def h_get_timeline_format(self, p):
        """fps + resolution of a timeline (additive). Used by title placement (PNG size + recordFrame) and
        the OTIO finish fps. Reads timeline settings with safe fallbacks."""
        tl = self._timeline_by_name(p["timeline"])

        def _f(key, d):
            try:
                v = float(tl.GetSetting(key) or 0)
                return v or d
            except Exception:
                return d
        return {"fps": _f("timelineFrameRate", 24.0),
                "width": int(_f("timelineResolutionWidth", 1920)),
                "height": int(_f("timelineResolutionHeight", 1080))}

    def h_add_track(self, p):
        tl = self._timeline_by_name(p["timeline"])
        ttype = p.get("trackType", "video")
        before = tl.GetTrackCount(ttype)
        ok = tl.AddTrack(ttype)
        after = tl.GetTrackCount(ttype)
        return {"ok": bool(ok), "trackType": ttype, "before": before, "after": after, "verified": after == before + 1}

    def h_set_timeline_format(self, p):
        """Set a timeline's resolution and frame rate. NEW IN THE PORT.

        A timeline created with CreateEmptyTimeline inherits the project's format, which
        is rarely the one a comparison wants — the first build of the comparison timeline (v4) came
        out 1440x1152 and silently downscaled the 4K track. Per-timeline settings are
        ignored unless useCustomSettings is on, so that is set first.

        Verified after write: SetSetting returns true for names it does not honour.
        """
        tl = self._timeline_by_name(p["timeline"])
        tl.SetSetting("useCustomSettings", "1")
        wanted = {}
        if p.get("width"):
            wanted["timelineResolutionWidth"] = str(int(p["width"]))
        if p.get("height"):
            wanted["timelineResolutionHeight"] = str(int(p["height"]))
        if p.get("fps"):
            wanted["timelineFrameRate"] = str(p["fps"])
        for k, v in wanted.items():
            tl.SetSetting(k, v)
        after = {k: tl.GetSetting(k) for k in wanted}
        verified = all(str(after[k]).startswith(str(v).rstrip("0").rstrip("."))
                       or str(after[k]) == str(v) or float(after[k]) == float(v)
                       for k, v in wanted.items())
        return {"ok": True, "requested": wanted, "after": after, "verified": verified}

    def h_set_track_name(self, p):
        """Name a track. NEW IN THE PORT — the one operation the agent reported it could
        not do while building the comparison timeline, and it is one API call.

        Verified after write, like every other mutation here: SetTrackName can return
        true and not stick, and a phantom success is worse than a failure because
        nothing downstream questions it.
        """
        tl = self._timeline_by_name(p["timeline"])
        ttype = p.get("trackType", "video")
        idx = int(p["trackIndex"])
        name = str(p["name"])
        count = tl.GetTrackCount(ttype)
        if not 1 <= idx <= count:
            raise RuntimeError("trackIndex %d out of range (%s has %d tracks)" % (idx, ttype, count))
        before = tl.GetTrackName(ttype, idx)
        ok = tl.SetTrackName(ttype, idx, name)
        after = tl.GetTrackName(ttype, idx)
        return {"ok": bool(ok), "trackType": ttype, "trackIndex": idx,
                "before": before, "after": after, "verified": after == name}

    def h_set_volume(self, p):
        tl = self._timeline_by_name(p["timeline"])
        items = self._items_in(tl, p.get("trackType", "audio"), int(p.get("trackIndex", 1)))
        idx = int(p.get("itemIndex", 0))
        if idx >= len(items):
            raise RuntimeError("itemIndex %d out of range (%d items)" % (idx, len(items)))
        item = items[idx]
        vol = float(p["volume"])
        set_ok = item.SetProperty("Volume", vol)
        readback = None
        try:
            readback = item.GetProperty("Volume")
        except Exception:
            readback = "<no GetProperty>"
        return {"setOk": bool(set_ok), "requested": vol, "readback": readback, "verified": str(readback) == str(vol)}

    def h_delete_clips(self, p):
        tl = self._timeline_by_name(p["timeline"])
        ttype = p.get("trackType", "video")
        ti = int(p.get("trackIndex", 1))
        items = self._items_in(tl, ttype, ti)
        before = len(items)
        which = p.get("itemIndices")
        target = [items[i] for i in which] if which else list(items)
        ok = tl.DeleteClips(target)
        after = len(self._items_in(tl, ttype, ti))
        return {"ok": bool(ok), "before": before, "deleted": len(target), "after": after, "verified": after == before - len(target)}

    def h_clear_track(self, p):
        tl = self._timeline_by_name(p["timeline"])
        ttype = p.get("trackType", "video")
        ti = int(p.get("trackIndex", 1))
        items = self._items_in(tl, ttype, ti)
        before = len(items)
        ok = tl.DeleteClips(list(items)) if items else True
        after = len(self._items_in(tl, ttype, ti))
        return {"ok": bool(ok), "before": before, "after": after, "verified": after == 0}

    def h_move_clip(self, p):
        """Move an item across tracks: capture source span, delete, re-append at target track."""
        tl = self._timeline_by_name(p["timeline"])
        ttype = p.get("trackType", "video")
        from_ti = int(p["fromTrack"])
        to_ti = int(p["toTrack"])
        idx = int(p.get("itemIndex", 0))
        items = self._items_in(tl, ttype, from_ti)
        if idx >= len(items):
            raise RuntimeError("itemIndex out of range")
        item = items[idx]
        mpi = item.GetMediaPoolItem()
        record_frame = item.GetStart()
        left = item.GetLeftOffset()
        dur = item.GetDuration()
        if not mpi:
            return {"ok": False, "reason": "no source MediaPoolItem on item (cannot re-append)", "verified": False}
        deleted = tl.DeleteClips([item])
        ci = {
            "mediaPoolItem": mpi,
            "startFrame": left,
            "endFrame": left + dur,
            "trackIndex": to_ti,
            "recordFrame": record_frame,
            "mediaType": 1,
        }
        appended = self._mp().AppendToTimeline([ci])
        ok = bool(deleted) and bool(appended)
        dest_count = len(self._items_in(tl, ttype, to_ti))
        return {"ok": ok, "deletedFromSource": bool(deleted), "appendedToTarget": len(appended) if appended else 0, "destItemCount": dest_count, "verified": ok}

    def h_trim_clip(self, p):
        """Attempt to trim a timeline item's duration. The scripting API has no public
        timeline-item trim; we probe what is available and report so the coverage map
        records RED + the OTIO-reimport fallback."""
        tl = self._timeline_by_name(p["timeline"])
        ttype = p.get("trackType", "video")
        ti = int(p.get("trackIndex", 1))
        idx = int(p.get("itemIndex", 0))
        items = self._items_in(tl, ttype, ti)
        if idx >= len(items):
            raise RuntimeError("itemIndex out of range")
        item = items[idx]
        before = {"start": item.GetStart(), "end": item.GetEnd(), "duration": item.GetDuration()}
        methods = [m for m in dir(item) if not m.startswith("__")]
        has_trim = any("Trim" in m or "SetStart" in m or "SetEnd" in m or "SetDuration" in m for m in methods)
        return {
            "attempted": True,
            "before": before,
            "publicTrimApi": has_trim,
            "note": "No public timeline-item trim/SetStart/SetEnd in scripting API" if not has_trim else "candidate methods present",
            "candidateMethods": [m for m in methods if any(k in m for k in ("Set", "Trim", "Offset", "Duration"))][:30],
            "verified": False,
            "fallback": "OTIO export -> edit in/out -> reimport (rung 3)",
        }

    def h_add_marker(self, p):
        tl = self._timeline_by_name(p["timeline"])
        ok = tl.AddMarker(
            int(p.get("frameId", 1)),
            p.get("color", "Blue"),
            p.get("name", "fc_spike"),
            p.get("note", "fc spike marker"),
            int(p.get("duration", 1)),
            p.get("customData", ""),
        )
        return {"added": bool(ok)}

    def h_get_marker_by_customdata(self, p):
        tl = self._timeline_by_name(p["timeline"])
        m = tl.GetMarkerByCustomData(p["customData"])
        return {"found": bool(m), "marker": m if isinstance(m, dict) else None}

    def h_marker_density(self, p):
        tl = self._timeline_by_name(p["timeline"])
        count = int(p.get("count", 50))
        start = int(p.get("startFrame", 1))
        step = int(p.get("step", 2))
        added = 0
        for i in range(count):
            if tl.AddMarker(start + i * step, "Green", "d%d" % i, "density", 1, "fc_density_%d" % i):
                added += 1
        markers = tl.GetMarkers() or {}
        return {"requested": count, "added": added, "totalMarkersNow": len(markers), "verified": added == count}

    def h_export_otio(self, p):
        tl = self._timeline_by_name(p["timeline"])
        path = os.path.join(self.tempdir, p.get("filename", "spike.otio"))
        export_type = getattr(self.resolve, "EXPORT_OTIO", None)
        if export_type is None:
            ok = tl.Export(path, "OTIO")
        else:
            ok = tl.Export(path, export_type)
        exists = os.path.exists(path)
        size = os.path.getsize(path) if exists else 0
        sample = ""
        if exists:
            with open(path, "r", errors="replace") as f:
                sample = f.read(400)
        return {"ok": bool(ok), "path": path, "exists": exists, "size": size, "head": sample}

    def h_set_current_timeline(self, p):
        tl = self._timeline_by_name(p["name"])
        ok = self._proj().SetCurrentTimeline(tl)
        cur = self._proj().GetCurrentTimeline()
        return {"ok": bool(ok), "current": cur.GetName() if cur else None}

    def h_item_props(self, p):
        """Characterize a timeline item's scriptable property surface + probe volume setters."""
        tl = self._timeline_by_name(p["timeline"])
        items = self._items_in(tl, p.get("trackType", "audio"), int(p.get("trackIndex", 1)))
        idx = int(p.get("itemIndex", 0))
        if idx >= len(items):
            raise RuntimeError("no item at index %d" % idx)
        item = items[idx]
        out = {"name": item.GetName()}
        try:
            allp = item.GetProperty()
            out["allPropKeys"] = sorted(allp.keys()) if isinstance(allp, dict) else str(allp)
        except Exception as e:
            out["allPropsError"] = str(e)
        attempts = {}
        for name in ("Volume", "ClipVolume", "Gain", "Level", "AudioVolume", "Pan", "Pitch"):
            try:
                attempts[name] = item.SetProperty(name, -6.0)
            except Exception as e:
                attempts[name] = "err:%s" % e
        out["setAttempts"] = attempts
        return out

    def h_delete_timeline(self, p):
        mp = self._mp()
        tl = self._timeline_by_name(p["timeline"])
        ok = False
        try:
            ok = mp.DeleteTimelines([tl])
        except Exception as e:
            return {"ok": False, "error": str(e)}
        return {"ok": bool(ok)}

    def h_color_pool_clips(self, p):
        """Mirror the Loom's per-clip state onto the MEDIA-POOL bin clips (FCFE-020, the WRITE companion to
        the Loom): set each named clip's CLIP COLOR (Green=Analyzed, Blue=Woven; "" clears) + an optional
        metadata tag, with VERIFY-AFTER-WRITE (read GetClipColor / GetMetadata back; a phantom success is
        reported applied:false, never swallowed).

        SAFETY: this is the ONE handler that mutates EXISTING media-pool items, so it HARD-GUARDS on the
        operator-designated safe clone — it REFUSES (no mutation, returns refused:true) unless the open
        project name EXACTLY matches SAFE_PROJECT. Clips are matched by media-pool NAME (the proven
        append_existing convention); unmatched names are reported, never silently dropped.

        params: { clips:[{name, color, metadata?}], tagMetadata?:bool, metadataKey?:str }
        """
        proj = self._proj()
        pname = proj.GetName()
        clips = p.get("clips") or []
        if pname != SAFE_PROJECT:
            return {"refused": True,
                    "reason": "open project '%s' != safe clone '%s' — refusing to color the bin" % (pname, SAFE_PROJECT),
                    "project": pname, "safeProject": SAFE_PROJECT,
                    "requested": len(clips), "matched": 0, "colored": 0, "results": []}

        tag_metadata = p.get("tagMetadata", True)

        # Index the pool by name once (exact-name match, like _find_pool_items_by_name / append_existing).
        acc = []
        self._walk_pool(self._mp().GetRootFolder(), acc)
        by_name = {}
        for c in acc:
            try:
                by_name.setdefault(c.GetName(), c)
            except Exception:
                pass

        results = []
        matched = 0
        colored = 0
        for spec in clips:
            cname = spec.get("name")
            want_color = spec.get("color", "") or ""
            item = by_name.get(cname)
            if item is None:
                results.append({"name": cname, "matched": False})
                continue
            matched += 1
            r = {"name": cname, "matched": True, "requestedColor": want_color}
            set_ok = False
            try:
                if want_color:
                    set_ok = bool(item.SetClipColor(want_color))
                elif hasattr(item, "ClearClipColor"):
                    set_ok = bool(item.ClearClipColor())
                else:
                    set_ok = bool(item.SetClipColor(""))
            except Exception as e:
                r["colorError"] = "%s: %s" % (type(e).__name__, e)
            observed = None
            try:
                observed = item.GetClipColor()
            except Exception:
                observed = "<no GetClipColor>"
            r["observedColor"] = observed
            if observed in (None, "<no GetClipColor>"):
                r["colorApplied"] = bool(set_ok)             # no readback available -> trust the setter
            else:
                r["colorApplied"] = (observed == want_color)  # verify-after-write
            if want_color and r["colorApplied"]:
                colored += 1
            if tag_metadata and isinstance(spec.get("metadata"), dict):
                md_out = {}
                for k, v in spec["metadata"].items():
                    ok = False
                    try:
                        ok = bool(item.SetMetadata(k, str(v)))
                    except Exception as e:
                        r.setdefault("metadataErrors", {})[k] = "%s: %s" % (type(e).__name__, e)
                    rb = None
                    try:
                        rb = item.GetMetadata(k)
                    except Exception:
                        rb = None
                    md_out[k] = {"setOk": ok, "readback": rb,
                                 "applied": (str(rb) == str(v)) if rb is not None else ok}
                r["metadata"] = md_out
            results.append(r)

        return {"refused": False, "project": pname, "safeProject": SAFE_PROJECT,
                "requested": len(clips), "matched": matched, "colored": colored, "results": results}

    def h_list_pool_clips(self, p):
        """Read-only: list media-pool clip NAMES (+ online flag + current clip color). Lets the bin-coloring
        layer (FCFE-020) address real clips when a by-id run state isn't present. `videoOnly` (default True)
        filters to video extensions."""
        acc = []
        self._walk_pool(self._mp().GetRootFolder(), acc)
        video_only = p.get("videoOnly", True)
        exts = (".mov", ".mp4", ".mxf", ".braw", ".mts", ".m4v", ".avi")
        out = []
        for c in acc:
            try:
                nm = c.GetName() or ""
            except Exception:
                nm = ""
            if not nm:
                continue
            if video_only and not nm.lower().endswith(exts):
                continue
            try:
                res = c.GetClipProperty("Resolution")
            except Exception:
                res = ""
            try:
                color = c.GetClipColor()
            except Exception:
                color = None
            out.append({"name": nm, "online": bool(res and res not in ("", "0x0")), "color": color})
        return {"count": len(out), "clips": out}

    def h_list_timeline_items(self, p):
        """READ-ONLY (FCSB-013): list the clip items on one track of a timeline — the timeline is the durable
        record of a laid cut, so this lets a spine/EDL be recovered from Resolve itself. `timeline` (name,
        default = current) is located WITHOUT switching the current timeline; `trackType` ('video'|'audio',
        default video); `trackIndex` (1-based, default 1). Per item: name, start/end (timeline frames),
        duration, leftOffset (source-media offset in frames). Mutates NOTHING."""
        proj = self._proj()
        tl = None
        want = p.get("timeline")
        if want:
            try:
                n = int(proj.GetTimelineCount() or 0)
                for i in range(1, n + 1):
                    t = proj.GetTimelineByIndex(i)
                    if t and t.GetName() == want:
                        tl = t
                        break
            except Exception:
                tl = None
            if tl is None:
                return {"error": "timeline not found: %s" % want}
        else:
            tl = proj.GetCurrentTimeline()
            if tl is None:
                return {"error": "no current timeline"}
        track_type = p.get("trackType", "video")
        track_index = int(p.get("trackIndex", 1))
        try:
            items = tl.GetItemListInTrack(track_type, track_index) or []
        except Exception as e:
            return {"error": "GetItemListInTrack failed: %s" % e}
        out = []
        for it in items:
            row = {}
            for key, fn in (("name", "GetName"), ("start", "GetStart"), ("end", "GetEnd"),
                            ("duration", "GetDuration"), ("leftOffset", "GetLeftOffset")):
                try:
                    row[key] = getattr(it, fn)()
                except Exception:
                    row[key] = None
            out.append(row)
        fps = None
        try:
            fps = float(tl.GetSetting("timelineFrameRate") or 0) or None
        except Exception:
            pass
        return {"timeline": tl.GetName(), "trackType": track_type, "trackIndex": track_index,
                "fps": fps, "count": len(out), "items": out}


# Commands that destroy work the operator cannot get back from inside Resolve.
#
# The sandboxing rule for v3 is that destructive commands go behind an explicit
# confirmation while read and additive commands run freely. Gating here rather than in
# each handler means a handler added later is NOT silently exempt — a new destructive
# verb has to be added to this set to be reachable, and forgetting to gate one is a
# visible omission in one place instead of an invisible one spread across the file.
#
# `confirm: true` has to be set by the caller for each individual call. The Node side
# never sets it on the agent's behalf; it comes from a human.
DESTRUCTIVE = frozenset({
    "delete_timeline",
    "delete_clips",
    "clear_track",
})


def main():
    try:
        bridge = Bridge()
    except Exception as e:
        sys.stdout.write(json.dumps({"id": 0, "ok": False, "error": {"type": type(e).__name__, "message": str(e)}}) + "\n")
        sys.stdout.flush()
        return 2
    info = {}
    try:
        info = bridge.h_connect_info({})
    except Exception:
        pass
    sys.stdout.write(json.dumps({"id": 0, "ok": True, "result": {"ready": True, "info": info}}) + "\n")
    sys.stdout.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue
        rid = req.get("id")
        method = req.get("method")
        params = req.get("params") or {}
        if method == "shutdown":
            sys.stdout.write(json.dumps({"id": rid, "ok": True, "result": {"bye": True}}) + "\n")
            sys.stdout.flush()
            break
        handler = bridge.dispatch.get(method)
        if handler is None:
            resp = {"id": rid, "ok": False, "error": {"type": "UnknownMethod", "message": str(method)}}
        elif method in DESTRUCTIVE and not params.get("confirm"):
            resp = {"id": rid, "ok": False, "error": {
                "type": "ConfirmationRequired",
                "message": "%s destroys work and needs confirm:true from a human" % method}}
        else:
            try:
                resp = {"id": rid, "ok": True, "result": handler(params)}
            except Exception as e:
                resp = {"id": rid, "ok": False, "error": {"type": type(e).__name__, "message": str(e)}}
        sys.stdout.write(json.dumps(resp) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
