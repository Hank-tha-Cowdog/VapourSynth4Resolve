#pragma once

// XPC contract between the OFX plugin and the companion Electron app.
// Method names live here so both ends compile against the same vocabulary.

#include <string>

namespace vsres::ipc {

// XPC service name advertised by the OFX plugin process.
inline constexpr const char* kServiceName = "com.vapoursynth.resolveofx.xpc";

// Method names — keep these in sync with companion-app/electron/main.ts.
inline constexpr const char* kHelloFromHost      = "helloFromHost";       // -> popout
inline constexpr const char* kRequestFrame       = "requestFrame";        // popout -> host
inline constexpr const char* kPreviewChain       = "previewChain";        // popout -> host
inline constexpr const char* kApplyConfig        = "applyConfig";         // popout -> host
inline constexpr const char* kStreamLog          = "streamLog";           // host -> popout
inline constexpr const char* kGetClipMetadata    = "getClipMetadata";     // popout -> host

}  // namespace vsres::ipc
