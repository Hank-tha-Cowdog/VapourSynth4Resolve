#!/usr/bin/env python3
"""
Auto-discover the source file path of the clip at Resolve's current playhead.

Talks to a running DaVinci Resolve via the bundled `DaVinciResolveScript` Python
module (ships with every Resolve install at the standard scripting path). Prints a
JSON result to stdout; the companion-app Node side spawns this and parses.

Failure modes the companion app distinguishes:
  - notInstalled         — Resolve isn't at the standard install path
  - scriptingUnavailable — module import failed (older Resolve, or installation
                           weirdness)
  - scriptingDisabled    — scriptapp() returned None. Resolve runs without the
                           scripting subsystem online unless the user has flipped
                           Preferences → System → General → External Scripting
                           Using → Local (or Network).

Successful response includes the file path plus a handful of clip properties so
the renderer can sanity-check against the OFX-delivered timeline metadata.
"""

import json
import os
import sys


def emit(payload):
    print(json.dumps(payload))
    sys.exit(0)


def fail(error, **kwargs):
    emit({'ok': False, 'error': error, **kwargs})


# Fixed install paths on macOS. If these don't exist, Resolve isn't at the standard
# location and we bail out clean — companion app falls back to manual identification.
RESOLVE_SCRIPT_API = os.environ.get(
    'RESOLVE_SCRIPT_API',
    '/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting',
)
RESOLVE_SCRIPT_LIB = os.environ.get(
    'RESOLVE_SCRIPT_LIB',
    '/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/fusionscript.so',
)

if not os.path.exists(RESOLVE_SCRIPT_LIB):
    fail(
        'DaVinci Resolve scripting library not found at the standard install path.',
        notInstalled=True,
        searchedAt=RESOLVE_SCRIPT_LIB,
    )

sys.path.insert(0, os.path.join(RESOLVE_SCRIPT_API, 'Modules'))
os.environ['RESOLVE_SCRIPT_API'] = RESOLVE_SCRIPT_API
os.environ['RESOLVE_SCRIPT_LIB'] = RESOLVE_SCRIPT_LIB

try:
    import DaVinciResolveScript as bmd  # type: ignore
except Exception as e:
    fail(f'Failed to import DaVinciResolveScript: {e}', scriptingUnavailable=True)

resolve = bmd.scriptapp('Resolve')
if resolve is None:
    fail(
        'Resolve scripting returned None — either Resolve is not running, or '
        'external scripting is disabled. Enable in Resolve Preferences → System '
        '→ General → External Scripting Using → Local.',
        scriptingDisabled=True,
    )

try:
    pm = resolve.GetProjectManager()
    project = pm.GetCurrentProject() if pm is not None else None
    if project is None:
        fail('No project open in Resolve.')

    timeline = project.GetCurrentTimeline()
    if timeline is None:
        fail('No timeline open in the current Resolve project.')

    item = timeline.GetCurrentVideoItem()
    if item is None:
        fail('No video clip at the current Resolve playhead.')

    media_item = item.GetMediaPoolItem()
    if media_item is None:
        # Compound clips / Fusion clips / generators don't have a media-pool entry.
        fail('Current video item has no underlying media-pool entry '
             '(e.g. compound clip, Fusion clip, or generator).')

    file_path = media_item.GetClipProperty('File Path')
    if not file_path:
        fail('Media pool item has no File Path property.')

    # Source trim points + retime signal straight from the timeline item.
    # GetSourceStartFrame/GetSourceEndFrame are the clip's source-media frame
    # bounds (in/out handles); GetSpeed() reports retimes (e.g. a Percentage
    # speed change). A retime makes source frame mapping non-linear, so the
    # consumer disables direct source-mode and falls back to the OFX clip.
    source_in = source_out = None
    retime_detected = None
    try:
        source_in = item.GetSourceStartFrame()
        source_out = item.GetSourceEndFrame()
    except Exception:
        pass
    try:
        speed = item.GetSpeed()
        if isinstance(speed, dict):
            pct = speed.get('Percentage')
            if pct is not None:
                retime_detected = abs(float(pct) - 100.0) > 1e-6
    except Exception:
        pass

    # Pull a handful of useful properties so the renderer can verify the auto-
    # match against what OFX is delivering and the Archivist has more context.
    props = media_item.GetClipProperty() or {}

    emit({
        'ok': True,
        'filePath': file_path,
        'fileName':       props.get('File Name', ''),
        'clipName':       props.get('Clip Name', ''),
        'resolution':     props.get('Resolution', ''),
        'fps':            props.get('FPS', ''),
        'duration':       props.get('Duration', ''),
        'fieldDominance': props.get('Field Dominance', ''),
        'codec':          props.get('Video Codec', ''),
        'audioCodec':     props.get('Audio Codec', ''),
        'pixelAspect':    props.get('PAR', ''),
        'colorSpace':     props.get('Color Space', ''),
        'gamma':          props.get('Gamma', ''),
        **({'sourceInPoint': int(source_in)} if source_in is not None else {}),
        **({'sourceOutPoint': int(source_out)} if source_out is not None else {}),
        **({'retimeDetected': bool(retime_detected)} if retime_detected is not None else {}),
    })
except Exception as e:
    fail(f'Resolve API error: {e}')
