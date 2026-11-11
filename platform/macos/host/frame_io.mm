#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <ImageIO/ImageIO.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>

#include "frame_io.h"
#include "../../../common/logging/log.h"

#include <algorithm>
#include <cstdlib>
#include <vector>

namespace vsres::macos::frame_io {

namespace {

// CFTypeRef wrapper — releases via CFRelease on scope exit. Compact RAII for ImageIO.
template <typename T>
class CFOwned {
public:
    explicit CFOwned(T ref) : ref_(ref) {}
    ~CFOwned() { if (ref_) CFRelease(ref_); }
    T get() const { return ref_; }
    explicit operator bool() const { return ref_ != nullptr; }
    CFOwned(const CFOwned&) = delete;
    CFOwned& operator=(const CFOwned&) = delete;
private:
    T ref_;
};

inline uint16_t f32_to_u16(float v) {
    const float scaled = std::clamp(v, 0.0f, 1.0f) * 65535.0f;
    // Round-to-nearest; std::round produces the right behavior for non-negative values.
    return static_cast<uint16_t>(scaled + 0.5f);
}

bool atomic_rename(const std::string& tmp, const std::string& dst) {
    return std::rename(tmp.c_str(), dst.c_str()) == 0;
}

// Core writer: 16-bit RGBA buffer (host endian on macOS == little) → PNG.
bool write_u16_rgba_to_png(const uint16_t* buf, int w, int h, const std::string& path) {
    @autoreleasepool {
        NSString* tmp_path = [NSString stringWithFormat:@"%s.tmp", path.c_str()];
        NSURL* url = [NSURL fileURLWithPath:tmp_path];

        const size_t row_bytes = static_cast<size_t>(w) * 4 * sizeof(uint16_t);
        const size_t total_bytes = row_bytes * static_cast<size_t>(h);

        CFOwned<CGColorSpaceRef> cs(CGColorSpaceCreateWithName(kCGColorSpaceSRGB));
        if (!cs) {
            log::error("frame_io", "CGColorSpaceCreateWithName(sRGB) failed");
            return false;
        }

        CFOwned<CGDataProviderRef> provider(
            CGDataProviderCreateWithData(nullptr, buf, total_bytes, nullptr));
        if (!provider) {
            log::error("frame_io", "CGDataProviderCreateWithData failed");
            return false;
        }

        const CGBitmapInfo bitmap = kCGBitmapByteOrder16Little | kCGImageAlphaPremultipliedLast;

        CFOwned<CGImageRef> image(
            CGImageCreate(static_cast<size_t>(w), static_cast<size_t>(h),
                          /*bitsPerComponent=*/16,
                          /*bitsPerPixel=*/64,
                          row_bytes,
                          cs.get(), bitmap,
                          provider.get(),
                          /*decode=*/nullptr,
                          /*shouldInterpolate=*/false,
                          kCGRenderingIntentDefault));
        if (!image) {
            log::error("frame_io", "CGImageCreate failed");
            return false;
        }

        CFStringRef png_type;
        if (@available(macOS 11.0, *)) {
            png_type = (__bridge CFStringRef)UTTypePNG.identifier;
        } else {
            png_type = CFSTR("public.png");
        }

        CFOwned<CGImageDestinationRef> dest(
            CGImageDestinationCreateWithURL((__bridge CFURLRef)url, png_type, 1, nullptr));
        if (!dest) {
            log::error("frame_io", "CGImageDestinationCreateWithURL failed");
            return false;
        }
        CGImageDestinationAddImage(dest.get(), image.get(), nullptr);
        if (!CGImageDestinationFinalize(dest.get())) {
            log::error("frame_io", "CGImageDestinationFinalize failed");
            return false;
        }

        // Atomic rename into final path so file watchers see one complete write.
        if (!atomic_rename([tmp_path UTF8String], path)) {
            log::error("frame_io", "atomic rename to " + path + " failed");
            return false;
        }
        return true;
    }
}

}  // namespace

bool save_vs_frame_as_png(const VSFrame* frame, const VSAPI* api, const std::string& path) {
    if (!frame || !api) return false;

    const VSVideoFormat* fmt = api->getVideoFrameFormat(frame);
    if (!fmt || fmt->colorFamily != cfRGB || fmt->sampleType != stFloat || fmt->bitsPerSample != 32) {
        log::error("frame_io", "save_vs_frame_as_png: unexpected format (need cfRGB/stFloat/32)");
        return false;
    }

    const int w = api->getFrameWidth(frame, 0);
    const int h = api->getFrameHeight(frame, 0);
    if (w <= 0 || h <= 0) return false;

    const auto* r_base = reinterpret_cast<const float*>(api->getReadPtr(frame, 0));
    const auto* g_base = reinterpret_cast<const float*>(api->getReadPtr(frame, 1));
    const auto* b_base = reinterpret_cast<const float*>(api->getReadPtr(frame, 2));
    const ptrdiff_t rs = api->getStride(frame, 0) / static_cast<ptrdiff_t>(sizeof(float));
    const ptrdiff_t gs = api->getStride(frame, 1) / static_cast<ptrdiff_t>(sizeof(float));
    const ptrdiff_t bs = api->getStride(frame, 2) / static_cast<ptrdiff_t>(sizeof(float));

    std::vector<uint16_t> rgba16(static_cast<size_t>(w) * static_cast<size_t>(h) * 4);
    for (int y = 0; y < h; ++y) {
        const float* rr = r_base + y * rs;
        const float* gr = g_base + y * gs;
        const float* br = b_base + y * bs;
        uint16_t* out = rgba16.data() + static_cast<size_t>(y) * w * 4;
        for (int x = 0; x < w; ++x) {
            out[x * 4 + 0] = f32_to_u16(rr[x]);
            out[x * 4 + 1] = f32_to_u16(gr[x]);
            out[x * 4 + 2] = f32_to_u16(br[x]);
            out[x * 4 + 3] = 0xFFFF;
        }
    }
    return write_u16_rgba_to_png(rgba16.data(), w, h, path);
}

bool save_ofx_image_as_png(OFX::Image* image, const std::string& path) {
    if (!image) return false;
    if (image->getPixelDepth() != OFX::eBitDepthFloat ||
        image->getPixelComponents() != OFX::ePixelComponentRGBA) {
        log::error("frame_io", "save_ofx_image_as_png: unexpected pixel format");
        return false;
    }
    OfxRectI rect = image->getRegionOfDefinition();
    const int w = rect.x2 - rect.x1;
    const int h = rect.y2 - rect.y1;
    if (w <= 0 || h <= 0) return false;

    std::vector<uint16_t> rgba16(static_cast<size_t>(w) * static_cast<size_t>(h) * 4);
    // OFX images are y-up. Walk top-to-bottom (y2-1 down to y1) so the PNG comes out
    // right-side-up.
    for (int yi = 0; yi < h; ++yi) {
        const int ofx_y = (rect.y2 - 1) - yi;
        const float* src = static_cast<const float*>(image->getPixelAddress(rect.x1, ofx_y));
        uint16_t* out = rgba16.data() + static_cast<size_t>(yi) * w * 4;
        for (int x = 0; x < w; ++x) {
            out[x * 4 + 0] = f32_to_u16(src[x * 4 + 0]);
            out[x * 4 + 1] = f32_to_u16(src[x * 4 + 1]);
            out[x * 4 + 2] = f32_to_u16(src[x * 4 + 2]);
            out[x * 4 + 3] = 0xFFFF;
        }
    }
    return write_u16_rgba_to_png(rgba16.data(), w, h, path);
}

bool save_rgba_float_as_png(const float* rgba, int width, int height, const std::string& path) {
    if (!rgba || width <= 0 || height <= 0) return false;
    std::vector<uint16_t> rgba16(static_cast<size_t>(width) * static_cast<size_t>(height) * 4);
    const size_t pixels = static_cast<size_t>(width) * static_cast<size_t>(height);
    for (size_t i = 0; i < pixels; ++i) {
        rgba16[i * 4 + 0] = f32_to_u16(rgba[i * 4 + 0]);
        rgba16[i * 4 + 1] = f32_to_u16(rgba[i * 4 + 1]);
        rgba16[i * 4 + 2] = f32_to_u16(rgba[i * 4 + 2]);
        rgba16[i * 4 + 3] = 0xFFFF;
    }
    return write_u16_rgba_to_png(rgba16.data(), width, height, path);
}

}  // namespace vsres::macos::frame_io
