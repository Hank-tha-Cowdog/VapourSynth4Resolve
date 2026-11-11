#!/usr/bin/env python3
"""Generate deterministic synthetic fixtures for filter qualification.

Pure-Python generation (every pixel explicit, no RNG, no VapourSynth expr):
- motion.mov:       moving box edge + vertical gradient + static band
- noise.mov:        motion + deterministic HF dither + smooth ramps
- interlaced.mov:   true TFF interlace (alternating frames vertically
                    shifted 4px → real field motion → combed in frame view)
640x480 YUV420P8, 25fps, 24 frames, encoded ProRes 422 HQ (decoder = lsmas,
same as the production chain). All parameters fixed for reproducibility.
"""
import os
import struct
import subprocess
import sys

W, H, N = 640, 480, 24
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tests", "fixtures")
os.makedirs(OUT, exist_ok=True)


def clamp(v):
    return 16 if v < 16 else 235 if v > 235 else int(v)


def luma_motion(x, y, t):
    # moving box edge (moves 10px/frame), vertical gradient, static top band
    box_x = (t * 10 + 40) % (W - 60)
    box_y = (t * 6 + 100) % (H - 60)
    if abs(y - 40) < 20:
        return 200                                  # static band
    if abs(x - box_x) < 20 and abs(y - box_y) < 30:
        return 220                                  # moving box (edge + flat)
    return clamp(40 + (x * 3) // 10 + t * 2)        # moving gradient


def luma_noise(x, y, t):
    base = luma_motion(x, y, t)
    # deterministic high-frequency dither: interleaved bit-hash pattern
    h = (x * 137 + y * 83 + t * 29) % 251
    return clamp(base + 60) if h < 64 else clamp(base - 30) if h < 128 else base


def luma_flicker(x, y, t):
    """STATIC scene + LOW-amplitude temporal flicker (±5): isolates the
    temporal-denoise test — no motion (motion protection would legitimately
    gate temporal averaging)."""
    box_x, box_y = 200, 140
    if abs(x - box_x) < 24 and abs(y - box_y) < 32:
        base = 200
    else:
        base = clamp(48 + (x * 2) // 10)
    flick = (x * 13 + y * 7 + t * 31) % 11 - 5
    return clamp(base + flick)


def planes_y4m(frame_fn):
    """Return (y_plane, u_plane, v_plane) byte rows for one frame."""
    y = bytearray()
    u = bytearray()
    v = bytearray()
    for yy in range(H):
        for xx in range(W):
            y.append(clamp(frame_fn(xx, yy)))
    for yy in range(H // 2):
        for xx in range(W // 2):
            u.append(128)
    for yy in range(H // 2):
        for xx in range(W // 2):
            v.append(128)
    return bytes(y), bytes(u), bytes(v)


def write_y4m(path, frames):
    with open(path, "wb") as f:
        f.write(f"YUV4MPEG2 W{W} H{H} F25:1 Ip A1:1 C420jpeg\n".encode())
        for i, (y, u, v) in enumerate(frames):
            f.write(b"FRAME\n")
            f.write(y)
            f.write(u)
            f.write(v)


def shift_vertical(frame_fn, px):
    def shifted(x, y, t):
        return frame_fn(x, (y + px) % H, t)
    return shifted


ok = True
specs = []
for name, fn in [("motion", luma_motion),
                 ("noise", luma_noise),
                 ("flicker", luma_flicker),
                 ("interlaced", None)]:
    if name != "interlaced":
        specs.append((name, [planes_y4m(lambda x, y, t=i: fn(x, y, t)) for i in range(N)]))
        continue
    # interlaced: alternate original / 4px-shifted frames (TFF field moments)
    frames = []
    for i in range(N):
        use = luma_motion if i % 2 == 0 else shift_vertical(luma_motion, 4)
        frames.append(planes_y4m(lambda x, y, t=i: use(x, y, t)))
    specs.append((name, frames))

for name, frames in specs:
    y4m = os.path.join(OUT, f"{name}.y4m")
    mov = os.path.join(OUT, f"{name}.mov")
    write_y4m(y4m, frames)
    rc = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", y4m,
                         "-c:v", "prores_ks", "-profile:v", "3",
                         "-pix_fmt", "yuv422p10le", mov])
    os.path.exists(y4m) and os.unlink(y4m)
    good = rc.returncode == 0 and os.path.exists(mov)
    print(("OK  " if good else "FAIL") + f" {mov} ({len(frames)} frames)")
    ok &= good
sys.exit(0 if ok else 1)