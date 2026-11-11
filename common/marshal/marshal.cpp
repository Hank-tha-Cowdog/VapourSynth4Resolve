#include "marshal.h"

// Reference scalar implementation. Correct but slow. Phase 1 swaps these inner loops for
// vDSP_mmov / cblas_scopy / a Metal compute kernel.

namespace vsres {

void interleaved_to_planar(const RgbaFrame& src, PlanarRgb& dst) {
    const int w = src.width;
    const int h = src.height;
    const int src_stride_px = src.stride / static_cast<int>(sizeof(float));
    const int r_stride_px = dst.r.stride / static_cast<int>(sizeof(float));
    const int g_stride_px = dst.g.stride / static_cast<int>(sizeof(float));
    const int b_stride_px = dst.b.stride / static_cast<int>(sizeof(float));

    for (int y = 0; y < h; ++y) {
        const float* src_row = src.data + y * src_stride_px;
        float* r_row = dst.r.data + y * r_stride_px;
        float* g_row = dst.g.data + y * g_stride_px;
        float* b_row = dst.b.data + y * b_stride_px;
        for (int x = 0; x < w; ++x) {
            r_row[x] = src_row[x * 4 + 0];
            g_row[x] = src_row[x * 4 + 1];
            b_row[x] = src_row[x * 4 + 2];
        }
    }
}

void planar_to_interleaved(const PlanarRgb& src, RgbaFrame& dst) {
    const int w = src.width;
    const int h = src.height;
    const int dst_stride_px = dst.stride / static_cast<int>(sizeof(float));
    const int r_stride_px = src.r.stride / static_cast<int>(sizeof(float));
    const int g_stride_px = src.g.stride / static_cast<int>(sizeof(float));
    const int b_stride_px = src.b.stride / static_cast<int>(sizeof(float));

    for (int y = 0; y < h; ++y) {
        const float* r_row = src.r.data + y * r_stride_px;
        const float* g_row = src.g.data + y * g_stride_px;
        const float* b_row = src.b.data + y * b_stride_px;
        float* dst_row = dst.data + y * dst_stride_px;
        for (int x = 0; x < w; ++x) {
            dst_row[x * 4 + 0] = r_row[x];
            dst_row[x * 4 + 1] = g_row[x];
            dst_row[x * 4 + 2] = b_row[x];
            dst_row[x * 4 + 3] = 1.0f;
        }
    }
}

}  // namespace vsres
