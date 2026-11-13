# vsres_conv.py — minimal, independently authored conversion layer.
#
# WHY THIS EXISTS: the composed-script preamble historically imported
# `mvsfunc` (an unlicensed circulated copy) for exactly three functions:
# ToYUV, ToRGB and Depth. This module replaces them with original code built
# only on VapourSynth core resizes, so the shipped bundle no longer needs
# mvsfunc at all (rights-map Conflict 6, option 2: "independently licensed
# replacement layer with color acceptance tests" — see
# docs/vs-helpers-revendor-2026-11-13.md for the acceptance A/B results).
#
# LICENSE: MIT — author: the VapourSynth-for-Resolve authors. No code was
# copied from mvsfunc; behavior mirrors its DOCUMENTED defaults for the
# parameter surface this project uses (matrix / css / depth / sample / full).
#
# Behavioral notes (mirroring mvsfunc's documented defaults):
#   * RGB input is assumed FULL range; YUV/GRAY input is assumed LIMITED.
#   * Output defaults: YUV/GRAY limited, RGB full.
#   * depth >= 32 selects float samples unless `sample` says otherwise.
#   * Matrix accepts int (ITU-T H.273 codes) or string names; unknown strings
#     pass through to the core (which validates them).

import vapoursynth as vs

core = vs.core

_MATRIX_CODES = {
    0: 'rgb', 1: '709', 2: 'unspec', 4: '470bg', 5: '170m', 6: '240m',
    7: '2020ncl', 8: '2020cl', 9: '2020cl', 10: '2020ncl', 12: '2020ncl',
    14: '2020ncl',
}
_CSS = {'420': (1, 1), '422': (1, 0), '444': (0, 0), '440': (0, 1)}

# Explicit format constants (R79 has no core.register_format).
_YUV_FMT = {
    (1, 1): {8: vs.YUV420P8, 16: vs.YUV420P16, 32: vs.YUV420PS},
    (1, 0): {8: vs.YUV422P8, 16: vs.YUV422P16, 32: vs.YUV422PS},
    (0, 0): {8: vs.YUV444P8, 16: vs.YUV444P16, 32: vs.YUV444PS},
    (0, 1): {8: vs.YUV440P8, 16: vs.YUV440P16, 32: vs.YUV440PS},
}
_GRAY_FMT = {8: vs.GRAY8, 16: vs.GRAY16, 32: vs.GRAYS}
_RGB_FMT = {8: vs.RGB24, 16: vs.RGB48, 32: vs.RGBS}


def _norm_matrix(matrix, clip):
    if matrix is None:
        # Prefer the source property, else the 709 default the composers use.
        try:
            prop = clip.get_frame(0).props.get('_Matrix', 1)
        except Exception:
            prop = 1
        matrix = prop if isinstance(prop, int) and prop else 1
    if isinstance(matrix, int):
        return _MATRIX_CODES.get(matrix, '709')
    return str(matrix)


def _fmt(color_family, subsampling, depth, sample):
    if sample is None:
        sample = vs.FLOAT if depth >= 32 else vs.INTEGER
    if color_family == vs.RGB:
        table = _RGB_FMT
    elif color_family == vs.GRAY:
        table = _GRAY_FMT
    else:
        css = subsampling if subsampling in _CSS else '420'
        table = _YUV_FMT[_CSS[css]]
    fmt = table.get(depth)
    if fmt is None or (sample == vs.FLOAT) != (depth >= 32):
        raise ValueError(
            f"unsupported format combination: family={color_family} "
            f"depth={depth} sample={sample}")
    return fmt


def _make(clip, color_family, subsampling, depth, sample, matrix,
          full_in, full_out):
    fmt = _fmt(color_family, subsampling, depth, sample)
    kwargs = {'format': fmt}
    src_fam = clip.format.color_family
    if src_fam == vs.RGB and color_family != vs.RGB:
        # RGB -> YUV: matrix_s names the OUTPUT (YUV) matrix.
        kwargs['matrix_s'] = _norm_matrix(matrix, clip)
    elif src_fam != vs.RGB and color_family == vs.RGB:
        # YUV -> RGB: matrix_in_s names the INPUT (YUV) matrix.
        kwargs['matrix_in_s'] = _norm_matrix(matrix, clip)
    if src_fam == vs.RGB:
        kwargs['range_in_s'] = 'full'
    if color_family == vs.RGB:
        kwargs['range_s'] = 'full'
    # Single Bicubic conversion; matches the composers' kernel expectations.
    return core.resize.Bicubic(clip, **kwargs)


def Depth(input, depth=None, sample=None, **kwargs):
    """Same color family and subsampling; change bit depth / sample type."""
    clip = input
    if depth is None:
        depth = clip.format.bits_per_sample
    if sample is None:
        sample = vs.FLOAT if depth >= 32 else vs.INTEGER
    if clip.format.color_family == vs.YUV:
        # Preserve the source subsampling.
        table = _YUV_FMT.get((clip.format.subsampling_w, clip.format.subsampling_h))
        if table is None:
            raise ValueError("unsupported YUV subsampling for Depth()")
        fmt = table.get(depth)
        if fmt is None or (sample == vs.FLOAT) != (depth >= 32):
            raise ValueError(f"unsupported Depth() target: depth={depth} sample={sample}")
        return core.resize.Bicubic(clip, format=fmt)
    fmt = _fmt(clip.format.color_family, '420', depth, sample)
    return core.resize.Bicubic(clip, format=fmt)


def ToYUV(input, matrix=None, css=None, depth=None, sample=None, full=None):
    """Any -> YUV<css>P<depth>. Defaults: css '420', depth = input depth."""
    clip = input
    if depth is None:
        depth = clip.format.bits_per_sample
    if sample is None:
        sample = vs.FLOAT if depth >= 32 else vs.INTEGER
    return _make(clip, vs.YUV, css or '420', depth, sample, matrix,
                 full_in=full, full_out=full)


def ToRGB(input, matrix=None, depth=None, sample=None, full=None):
    """Any -> RGB at `depth` (default: input depth, float >= 32)."""
    clip = input
    if depth is None:
        depth = clip.format.bits_per_sample
    if sample is None:
        sample = vs.FLOAT if depth >= 32 else vs.INTEGER
    return _make(clip, vs.RGB, None, depth, sample, matrix,
                 full_in=full, full_out=full)
