#pragma once

// Unified logging façade. On macOS routes to os_log under the `com.vapoursynth.resolveofx`
// subsystem. On Windows v1.x stays on fprintf(stderr) — not wired here yet.

#include <string>

namespace vsres::log {

enum class Level { Debug, Info, Warn, Error };

void emit(Level level, const std::string& category, const std::string& message);

inline void info(const std::string& cat, const std::string& msg)  { emit(Level::Info,  cat, msg); }
inline void warn(const std::string& cat, const std::string& msg)  { emit(Level::Warn,  cat, msg); }
inline void error(const std::string& cat, const std::string& msg) { emit(Level::Error, cat, msg); }
inline void debug(const std::string& cat, const std::string& msg) { emit(Level::Debug, cat, msg); }

}  // namespace vsres::log
