"""C10 regression: presentation-time → frame selection is EXACT at frame
boundaries (correctness review, re-verified 2026-11-11).

Premise (reproduced here): `int((time * fps_num) // fps_den)` selects N−1
for frame N's exact timestamp — 1.16 s at 25 fps → 28.999999999999996 → 28.
The fixed helper snaps the timestamp to its simplest rational
(limit_denominator) and converts with exact rational arithmetic.
"""

import importlib.util
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location(
    "render_preview_frame", REPO / "scripts" / "render_preview_frame.py")
assert spec is not None and spec.loader is not None
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

frame_at_time = mod._frame_at_time

RATES = [(25, 1), (30000, 1001), (24000, 1001), (60000, 1001), (50, 1)]


class TestPremise(unittest.TestCase):
    def test_old_float_math_really_was_off_by_one(self):
        # This is the reviewed defect: float floor math selects N−1. If this
        # ever stops holding, the regression below loses its meaning.
        self.assertEqual(int((1.16 * 25) // 1), 28)
        self.assertEqual(int((0.5005 * 30000) // 1001), 14)


class TestExactBoundaries(unittest.TestCase):
    def test_reviewed_cases(self):
        self.assertEqual(frame_at_time(1.16, 25, 1, 1000), 29)
        self.assertEqual(frame_at_time(0.5005, 30000, 1001, 1000), 15)

    def test_every_boundary_frame_1_to_999(self):
        # Timestamps produced the way the renderer produces them: frame*den/num
        # as a float. Zero mismatches required at every rate.
        for num, den in RATES:
            mismatches = []
            for frame in range(1, 1000):
                t = frame * den / num
                got = frame_at_time(t, num, den, 100000)
                if got != frame:
                    mismatches.append((frame, t, got))
            self.assertEqual(mismatches, [],
                             f"rate {num}/{den}: boundary mismatches {mismatches[:5]}")

    def test_display_rounded_timestamps(self):
        # The UI sends 2-decimal timestamps (toFixed(2) on the renderer side):
        # frame 29 at 25 fps arrives as "1.16" — must select 29.
        self.assertEqual(frame_at_time(float("1.16"), 25, 1, 1000), 29)
        self.assertEqual(frame_at_time(float("0.50"), 25, 1, 1000), 12)


class TestMidFrameAndClamp(unittest.TestCase):
    def test_mid_frame_still_floors_to_containing_frame(self):
        # Half a frame past the start of frame 28 still selects 28.
        self.assertEqual(frame_at_time(28.4 / 25, 25, 1, 1000), 28)
        self.assertEqual(frame_at_time(28.5 / 25, 25, 1, 1000), 28)
        # Half a frame BEFORE frame 29's boundary is still frame 28.
        self.assertEqual(frame_at_time((29 - 0.5) / 25, 25, 1, 1000), 28)

    def test_clamped_to_clip(self):
        self.assertEqual(frame_at_time(-5.0, 25, 1, 100), 0)
        self.assertEqual(frame_at_time(1e9, 25, 1, 100), 99)

    def test_exact_second_samples(self):
        # Whole-second sample points land on the frame containing them.
        for num, den in RATES:
            for sec in (1, 2, 10, 60):
                t = float(sec)
                want = (sec * num) // den
                self.assertEqual(frame_at_time(t, num, den, 100000), want,
                                 f"rate {num}/{den} @ {sec}s")


if __name__ == "__main__":
    unittest.main()
