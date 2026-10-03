#!/usr/bin/env python3
"""Persistent JSONL bridge to DaVinci Resolve's official scripting API.

The Node plugin owns process lifetime and sends one request per line. This file
contains no project-specific policy and never deletes, overwrites, moves, or
renames Resolve objects.
"""

from __future__ import annotations

import importlib
import json
import os
import platform
import sys
import traceback
from decimal import Decimal, InvalidOperation


OUTPUT = sys.stdout
sys.stdout = sys.stderr

DEFAULT_API_ROOTS = {
    "Darwin": "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting",
    "Linux": "/opt/resolve/Developer/Scripting",
    "Windows": r"C:\ProgramData\Blackmagic Design\DaVinci Resolve\Support\Developer\Scripting",
}

_api_module = None
_api_module_path = None
_resolve = None


def _refusal(code, message, details=None):
    result = {"refused": code, "message": message}
    if details is not None:
        result["details"] = details
    return result


def _is_refusal(value):
    return isinstance(value, dict) and isinstance(value.get("refused"), str)


def _api_root():
    return os.environ.get("RESOLVE_SCRIPT_API") or DEFAULT_API_ROOTS.get(platform.system())


def _load_module():
    global _api_module, _api_module_path
    if _api_module is not None:
        return _api_module
    root = _api_root()
    if root:
        modules = os.path.join(root, "Modules")
        if modules not in sys.path:
            sys.path.insert(0, modules)
    try:
        _api_module = importlib.import_module("DaVinciResolveScript")
        _api_module_path = getattr(_api_module, "__file__", None)
    except Exception:
        _api_module = None
        _api_module_path = None
    return _api_module


def _connect():
    global _resolve
    if _resolve is not None:
        try:
            _resolve.GetVersion()
            return _resolve
        except Exception:
            _resolve = None
    module = _load_module()
    if module is None:
        return None
    try:
        _resolve = module.scriptapp("Resolve")
    except Exception:
        _resolve = None
    return _resolve


def _project_name(project):
    if project is None:
        return None
    try:
        value = project.GetName()
        return str(value) if value else None
    except Exception:
        return None


def _setting_equal(observed, requested):
    left = "" if observed is None else str(observed).strip()
    right = "" if requested is None else str(requested).strip()
    if left == right:
        return True
    try:
        return Decimal(left) == Decimal(right)
    except InvalidOperation:
        return False


def _current_project(expected=None):
    resolve = _connect()
    if resolve is None:
        return _refusal(
            "resolve-unavailable",
            "DaVinci Resolve is not reachable through its scripting API. Open Resolve Studio and enable external scripting.",
        )
    manager = resolve.GetProjectManager()
    project = manager.GetCurrentProject() if manager is not None else None
    if project is None:
        return _refusal("project-missing", "No Resolve project is currently open.")
    current = _project_name(project)
    if expected is not None and current != expected:
        return _refusal(
            "project-not-current",
            f'Resolve project "{expected}" is not current (current: "{current or "none"}"). Open it manually before retrying; the plugin never switches an existing project behind you.',
            {"expected": expected, "current": current},
        )
    return project


def _normalize_bin_path(value):
    parts = [part.strip() for part in str(value).replace("\\", "/").split("/") if part.strip()]
    if not parts or any(part in (".", "..") for part in parts):
        return None
    return "/".join(parts)


def _all_bins(media_pool):
    root = media_pool.GetRootFolder()
    result = {"": root}

    def visit(folder, parent):
        children = list(folder.GetSubFolderList() or [])
        for child in children:
            name = str(child.GetName() or "")
            path = f"{parent}/{name}" if parent else name
            result[path] = child
            visit(child, path)

    visit(root, "")
    return result


def _missing_bin_paths(existing, requested):
    known = set(existing)
    missing = set()
    for requested_path in requested:
        parts = requested_path.split("/")
        for index in range(1, len(parts) + 1):
            path = "/".join(parts[:index])
            if path not in known:
                missing.add(path)
                known.add(path)
    return sorted(missing, key=lambda path: (path.count("/"), path.casefold()))


def _ensure_bin(media_pool, path):
    current = media_pool.GetRootFolder()
    walked = []
    for part in path.split("/"):
        walked.append(part)
        children = list(current.GetSubFolderList() or [])
        exact = next((child for child in children if str(child.GetName()) == part), None)
        if exact is None:
            collision = next(
                (child for child in children if str(child.GetName()).casefold() == part.casefold()),
                None,
            )
            if collision is not None:
                raise RuntimeError(
                    f'Bin case conflict at {"/".join(walked)}: Resolve already has "{collision.GetName()}".'
                )
            exact = media_pool.AddSubFolder(current, part)
            if exact is None:
                raise RuntimeError(f'Could not create Media Pool bin "{"/".join(walked)}".')
        current = exact
    return current


def _project_setup_plan(payload):
    resolve = _connect()
    if resolve is None:
        return _refusal(
            "resolve-unavailable",
            "DaVinci Resolve is not reachable. Open Resolve Studio before planning project setup.",
        )
    manager = resolve.GetProjectManager()
    if manager is None:
        return _refusal("resolve-unavailable", "Resolve returned no Project Manager.")

    name = str(payload.get("projectName") or "")
    if not name:
        return _refusal("invalid-plan", "projectName is required.")
    media_location = payload.get("mediaLocationPath")
    if media_location is not None and not os.path.isdir(str(media_location)):
        return _refusal(
            "invalid-plan",
            f"mediaLocationPath is not a readable directory: {media_location}",
        )

    settings = {str(key): str(value) for key, value in dict(payload.get("settings") or {}).items()}
    requested_bins = []
    for raw in list(payload.get("binPaths") or []):
        normalized = _normalize_bin_path(raw)
        if normalized is None:
            return _refusal("invalid-plan", f"Unsafe Media Pool bin path: {raw}")
        if normalized not in requested_bins:
            requested_bins.append(normalized)

    names = [str(value) for value in list(manager.GetProjectListInCurrentFolder() or [])]
    exists = name in names
    current = manager.GetCurrentProject()
    current_name = _project_name(current)
    if exists and current_name != name:
        return _refusal(
            "project-not-current",
            f'Resolve project "{name}" exists but is not current. Open it manually before setup; no project was switched.',
            {"expected": name, "current": current_name},
        )

    actions = []
    read_settings = {}
    bins = []
    if not exists:
        actions.append({"kind": "create-project", "projectName": name})
        for key, value in sorted(settings.items()):
            actions.append({"kind": "set-setting", "key": key, "from": None, "to": value})
        for path in _missing_bin_paths(set(), requested_bins):
            actions.append({"kind": "create-bin", "path": path})
    else:
        project = current
        for key, value in sorted(settings.items()):
            observed = project.GetSetting(key)
            observed_string = "" if observed is None else str(observed)
            read_settings[key] = observed_string
            if not _setting_equal(observed_string, value):
                actions.append(
                    {"kind": "set-setting", "key": key, "from": observed_string, "to": value}
                )
        media_pool = project.GetMediaPool()
        existing_bins = _all_bins(media_pool)
        bins = sorted(path for path in existing_bins if path)
        for path in _missing_bin_paths(existing_bins, requested_bins):
            actions.append({"kind": "create-bin", "path": path})

    return {
        "operation": "project-setup",
        "projectName": name,
        "actions": actions,
        "readback": {
            "exists": exists,
            "currentProject": current_name,
            "settings": read_settings,
            "bins": bins,
        },
    }


def _project_setup_apply(payload):
    plan = _project_setup_plan(payload)
    if _is_refusal(plan):
        return plan
    resolve = _connect()
    manager = resolve.GetProjectManager()
    name = str(payload["projectName"])
    errors = []
    changed = False
    project = manager.GetCurrentProject()

    if any(action["kind"] == "create-project" for action in plan["actions"]):
        try:
            location = payload.get("mediaLocationPath")
            project = (
                manager.CreateProject(name, str(location))
                if location is not None
                else manager.CreateProject(name)
            )
            if project is None:
                errors.append(f'CreateProject("{name}") returned no project.')
            else:
                changed = True
        except Exception as exc:
            errors.append(f"Create project: {exc}")

    if project is not None:
        media_pool = project.GetMediaPool()
        for action in plan["actions"]:
            try:
                if action["kind"] == "set-setting":
                    if not project.SetSetting(action["key"], action["to"]):
                        errors.append(f'Setting "{action["key"]}" was rejected by Resolve.')
                    else:
                        changed = True
                elif action["kind"] == "create-bin":
                    _ensure_bin(media_pool, action["path"])
                    changed = True
            except Exception as exc:
                errors.append(f'{action["kind"]}: {exc}')
        try:
            if not manager.SaveProject():
                errors.append("Resolve did not confirm SaveProject.")
        except Exception as exc:
            errors.append(f"Save project: {exc}")

    readback = _project_setup_plan(payload)
    if _is_refusal(readback):
        readback = plan
    verified = not errors and len(readback.get("actions", [])) == 0
    return {
        "operation": "project-setup",
        "status": "applied" if verified else "partial",
        "changed": changed,
        "verified": verified,
        "errors": errors,
        "readback": readback,
    }


def _path_key(value):
    return os.path.normcase(os.path.realpath(os.path.abspath(str(value))))


def _clip_path(clip):
    try:
        value = clip.GetClipProperty("File Path")
        return str(value) if value else None
    except Exception:
        return None


def _media_inventory(media_pool):
    bins = _all_bins(media_pool)
    inventory = {}
    for bin_path, folder in bins.items():
        for clip in list(folder.GetClipList() or []):
            source = _clip_path(clip)
            if not source:
                continue
            inventory.setdefault(_path_key(source), []).append(
                {"sourcePath": source, "binPath": bin_path, "item": clip}
            )
    return inventory


def _validated_bins(payload):
    assignments = {}
    bins = []
    for raw_bin in list(payload.get("bins") or []):
        bin_path = _normalize_bin_path(raw_bin.get("path"))
        if bin_path is None:
            return _refusal("invalid-plan", f'Unsafe bin path: {raw_bin.get("path")}')
        sources = []
        for raw_source in list(raw_bin.get("sources") or []):
            source = os.path.abspath(str(raw_source))
            if not os.path.isfile(source):
                return _refusal("source-missing", f"Source file is missing: {source}")
            key = _path_key(source)
            assigned = assignments.get(key)
            if assigned is not None and assigned != bin_path:
                return _refusal(
                    "invalid-plan",
                    f"One source was assigned to two bins: {source}",
                    {"firstBin": assigned, "secondBin": bin_path},
                )
            assignments[key] = bin_path
            if source not in sources:
                sources.append(source)
        bins.append({"path": bin_path, "sources": sources})
    return bins


def _bins_sync_plan(payload):
    project = _current_project(str(payload.get("projectName") or ""))
    if _is_refusal(project):
        return project
    validated = _validated_bins(payload)
    if _is_refusal(validated):
        return validated
    media_pool = project.GetMediaPool()
    existing_bins = _all_bins(media_pool)
    inventory = _media_inventory(media_pool)
    actions = []
    already = []
    requested_paths = [entry["path"] for entry in validated]
    for path in _missing_bin_paths(existing_bins, requested_paths):
        actions.append({"kind": "create-bin", "path": path})

    for entry in validated:
        for source in entry["sources"]:
            locations = inventory.get(_path_key(source), [])
            if len(locations) > 1:
                return _refusal(
                    "source-ambiguous",
                    f"Resolve contains more than one Media Pool item for: {source}",
                    [{"binPath": value["binPath"], "sourcePath": value["sourcePath"]} for value in locations],
                )
            if len(locations) == 1:
                location = locations[0]
                if location["binPath"] != entry["path"]:
                    return _refusal(
                        "source-already-imported-elsewhere",
                        f'Source is already in "{location["binPath"]}", not "{entry["path"]}". The plugin never moves clips automatically.',
                        {
                            "sourcePath": source,
                            "currentBin": location["binPath"],
                            "requestedBin": entry["path"],
                        },
                    )
                already.append({"sourcePath": source, "binPath": entry["path"]})
            else:
                actions.append(
                    {"kind": "import-source", "sourcePath": source, "binPath": entry["path"]}
                )
    return {
        "operation": "bins-sync",
        "projectName": str(payload["projectName"]),
        "actions": actions,
        "alreadyPresent": already,
    }


def _bins_sync_apply(payload):
    plan = _bins_sync_plan(payload)
    if _is_refusal(plan):
        return plan
    project = _current_project(str(payload["projectName"]))
    if _is_refusal(project):
        return project
    media_pool = project.GetMediaPool()
    manager = _connect().GetProjectManager()
    errors = []
    changed = False
    original_folder = media_pool.GetCurrentFolder()

    try:
        for action in plan["actions"]:
            if action["kind"] != "create-bin":
                continue
            try:
                _ensure_bin(media_pool, action["path"])
                changed = True
            except Exception as exc:
                errors.append(f'Create bin "{action["path"]}": {exc}')

        imports = {}
        for action in plan["actions"]:
            if action["kind"] == "import-source":
                imports.setdefault(action["binPath"], []).append(action["sourcePath"])
        for bin_path, sources in imports.items():
            try:
                folder = _ensure_bin(media_pool, bin_path)
                if not media_pool.SetCurrentFolder(folder):
                    errors.append(f'Could not select bin "{bin_path}" for import.')
                    continue
                imported = list(media_pool.ImportMedia(sources) or [])
                imported_keys = {_path_key(path) for path in (_clip_path(item) for item in imported) if path}
                missing = [source for source in sources if _path_key(source) not in imported_keys]
                if missing:
                    errors.append(f'Resolve did not return imported items for: {", ".join(missing)}')
                if imported:
                    changed = True
            except Exception as exc:
                errors.append(f'Import into "{bin_path}": {exc}')
    finally:
        if original_folder is not None:
            try:
                media_pool.SetCurrentFolder(original_folder)
            except Exception:
                pass

    try:
        if not manager.SaveProject():
            errors.append("Resolve did not confirm SaveProject.")
    except Exception as exc:
        errors.append(f"Save project: {exc}")

    readback = _bins_sync_plan(payload)
    if _is_refusal(readback):
        readback = plan
    verified = not errors and len(readback.get("actions", [])) == 0
    return {
        "operation": "bins-sync",
        "status": "applied" if verified else "partial",
        "changed": changed,
        "verified": verified,
        "errors": errors,
        "readback": readback,
    }


def _timelines(project, name):
    matches = []
    for index in range(1, int(project.GetTimelineCount() or 0) + 1):
        timeline = project.GetTimelineByIndex(index)
        if timeline is not None and str(timeline.GetName()) == name:
            matches.append(timeline)
    return matches


def _timeline_clips(timeline):
    clips = []
    track_count = int(timeline.GetTrackCount("video") or 0)
    for track in range(1, track_count + 1):
        for item in list(timeline.GetItemListInTrack("video", track) or []):
            media_item = item.GetMediaPoolItem()
            source = _clip_path(media_item) if media_item is not None else None
            if not source:
                continue
            clips.append(
                {
                    "sourcePath": source,
                    "startFrame": float(item.GetSourceStartFrame()),
                    "endFrame": float(item.GetSourceEndFrame()),
                }
            )
    return clips


def _clip_lists_match(actual, desired):
    if len(actual) != len(desired):
        return False
    for observed, expected in zip(actual, desired):
        if _path_key(observed["sourcePath"]) != _path_key(expected["sourcePath"]):
            return False
        if int(observed["startFrame"]) != int(expected["startFrame"]):
            return False
        if int(observed["endFrame"]) != int(expected["endFrame"]):
            return False
    return True


def _selects_build_plan(payload):
    project = _current_project(str(payload.get("projectName") or ""))
    if _is_refusal(project):
        return project
    name = str(payload.get("timelineName") or "")
    fingerprint = str(payload.get("fingerprint") or "")
    if not name or not fingerprint:
        return _refusal("invalid-plan", "timelineName and fingerprint are required.")

    desired = []
    for clip in list(payload.get("clips") or []):
        desired.append(
            {
                "sourcePath": os.path.abspath(str(clip["sourcePath"])),
                "startFrame": int(clip["startFrame"]),
                "endFrame": int(clip["endFrame"]),
            }
        )
    media_pool = project.GetMediaPool()
    inventory = _media_inventory(media_pool)
    for clip in desired:
        locations = inventory.get(_path_key(clip["sourcePath"]), [])
        if not locations:
            return _refusal(
                "source-missing",
                f'Source is not imported in the current project: {clip["sourcePath"]}',
            )
        if len(locations) > 1:
            return _refusal(
                "source-ambiguous",
                f'Resolve contains multiple Media Pool items for: {clip["sourcePath"]}',
            )

    matches = _timelines(project, name)
    if len(matches) > 1:
        return _refusal("timeline-conflict", f'Multiple timelines are named "{name}".')
    status = "create"
    if len(matches) == 1:
        timeline = matches[0]
        marker = timeline.GetMarkerByCustomData(fingerprint)
        actual = _timeline_clips(timeline)
        if marker and _clip_lists_match(actual, desired):
            status = "up-to-date"
        else:
            return _refusal(
                "timeline-conflict",
                f'Timeline "{name}" already exists but does not exactly match this Artists selects plan. It was not replaced.',
                {"markerMatches": bool(marker), "actualClips": actual},
            )

    return {
        "operation": "selects-build",
        "projectName": str(payload["projectName"]),
        "timelineName": name,
        "status": status,
        "fingerprint": fingerprint,
        "clips": desired,
    }


def _selects_build_apply(payload):
    plan = _selects_build_plan(payload)
    if _is_refusal(plan):
        return plan
    if plan["status"] == "up-to-date":
        return {
            "operation": "selects-build",
            "status": "up-to-date",
            "changed": False,
            "verified": True,
            "errors": [],
            "readback": plan,
        }

    project = _current_project(str(payload["projectName"]))
    media_pool = project.GetMediaPool()
    manager = _connect().GetProjectManager()
    inventory = _media_inventory(media_pool)
    errors = []
    changed = False
    timeline = None
    try:
        timeline = media_pool.CreateEmptyTimeline(str(payload["timelineName"]))
        if timeline is None:
            errors.append("Resolve did not create the selects timeline.")
        else:
            changed = True
            project.SetCurrentTimeline(timeline)
            clip_infos = []
            for clip in list(payload["clips"]):
                item = inventory[_path_key(clip["sourcePath"])][0]["item"]
                info = {
                    "mediaPoolItem": item,
                    "startFrame": int(clip["startFrame"]),
                    "endFrame": int(clip["endFrame"]),
                }
                if clip.get("includeAudio") is False:
                    info["mediaType"] = 1
                clip_infos.append(info)
            appended = list(media_pool.AppendToTimeline(clip_infos) or [])
            if not appended:
                errors.append("Resolve created the timeline but appended no clips.")
            if not timeline.AddMarker(
                1,
                "Purple",
                "Artists selects plan",
                "Managed identity marker; safe to leave in place.",
                1,
                str(payload["fingerprint"]),
            ):
                errors.append("Resolve did not confirm the Artists identity marker.")
    except Exception as exc:
        errors.append(f"Build selects timeline: {exc}")

    try:
        if not manager.SaveProject():
            errors.append("Resolve did not confirm SaveProject.")
    except Exception as exc:
        errors.append(f"Save project: {exc}")

    readback = _selects_build_plan(payload)
    if _is_refusal(readback):
        readback = plan
    verified = not errors and readback.get("status") == "up-to-date"
    return {
        "operation": "selects-build",
        "status": "applied" if verified else "partial",
        "changed": changed,
        "verified": verified,
        "errors": errors,
        "readback": readback,
    }


def _probe(_payload):
    resolve = _connect()
    module = _load_module()
    if resolve is None:
        return {
            "connected": False,
            "product": None,
            "version": None,
            "versionFields": [],
            "currentProject": None,
            "currentPage": None,
            "apiModulePath": _api_module_path,
            "pythonVersion": sys.version.split()[0],
            "capabilities": {
                "projectSetup": False,
                "mediaPoolFolders": False,
                "mediaImport": False,
                "timelineCreate": False,
                "timelineAppend": False,
                "timelineReadback": False,
                "intelliSearch": False,
            },
            "message": (
                "Resolve scripting module was not found."
                if module is None
                else "Resolve scripting module loaded, but no running Resolve instance accepted the connection."
            ),
        }
    manager = resolve.GetProjectManager()
    project = manager.GetCurrentProject() if manager is not None else None
    media_pool = project.GetMediaPool() if project is not None else None
    root = media_pool.GetRootFolder() if media_pool is not None else None
    return {
        "connected": True,
        "product": str(resolve.GetProductName() or ""),
        "version": str(resolve.GetVersionString() or ""),
        "versionFields": list(resolve.GetVersion() or []),
        "currentProject": _project_name(project),
        "currentPage": resolve.GetCurrentPage(),
        "apiModulePath": _api_module_path,
        "pythonVersion": sys.version.split()[0],
        "capabilities": {
            "projectSetup": manager is not None and hasattr(manager, "CreateProject"),
            "mediaPoolFolders": media_pool is not None and hasattr(media_pool, "AddSubFolder"),
            "mediaImport": media_pool is not None and hasattr(media_pool, "ImportMedia"),
            "timelineCreate": media_pool is not None and hasattr(media_pool, "CreateEmptyTimeline"),
            "timelineAppend": media_pool is not None and hasattr(media_pool, "AppendToTimeline"),
            "timelineReadback": project is not None and hasattr(project, "GetTimelineByIndex"),
            "intelliSearch": root is not None and hasattr(root, "AnalyzeForIntellisearch"),
        },
        "message": "Connected to DaVinci Resolve through the official scripting API.",
    }


ACTIONS = {
    "probe": _probe,
    "project_setup_plan": _project_setup_plan,
    "project_setup_apply": _project_setup_apply,
    "bins_sync_plan": _bins_sync_plan,
    "bins_sync_apply": _bins_sync_apply,
    "selects_build_plan": _selects_build_plan,
    "selects_build_apply": _selects_build_apply,
}


def _write(value):
    OUTPUT.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
    OUTPUT.flush()


def main():
    for raw_line in sys.stdin:
        request_id = None
        try:
            request = json.loads(raw_line)
            request_id = request.get("id")
            action = request.get("action")
            payload = request.get("payload")
            if action not in ACTIONS:
                raise ValueError(f"Unknown bridge action: {action}")
            if not isinstance(payload, dict):
                raise ValueError("Bridge payload must be an object.")
            result = ACTIONS[action](payload)
            _write({"id": request_id, "ok": True, "result": result})
        except Exception as exc:
            traceback.print_exc(file=sys.stderr)
            _write(
                {
                    "id": request_id,
                    "ok": False,
                    "error": {"code": "bridge-internal", "message": f"{type(exc).__name__}: {exc}"},
                }
            )


if __name__ == "__main__":
    main()
