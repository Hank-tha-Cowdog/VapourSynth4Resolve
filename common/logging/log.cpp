#include "log.h"

#if defined(__APPLE__)
#include <os/log.h>
#else
#include <cstdio>
#endif

namespace vsres::log {

#if defined(__APPLE__)
static os_log_t logger_for(const std::string& category) {
    return os_log_create("com.vapoursynth.resolveofx", category.c_str());
}
#endif

void emit(Level level, const std::string& category, const std::string& message) {
#if defined(__APPLE__)
    os_log_t l = logger_for(category);
    switch (level) {
        case Level::Debug: os_log_debug(l, "%{public}s", message.c_str()); break;
        case Level::Info:  os_log_info(l,  "%{public}s", message.c_str()); break;
        case Level::Warn:  os_log(l,       "%{public}s", message.c_str()); break;
        case Level::Error: os_log_error(l, "%{public}s", message.c_str()); break;
    }
#else
    const char* tag = "";
    switch (level) {
        case Level::Debug: tag = "DEBUG"; break;
        case Level::Info:  tag = "INFO";  break;
        case Level::Warn:  tag = "WARN";  break;
        case Level::Error: tag = "ERROR"; break;
    }
    fprintf(stderr, "[%s][%s] %s\n", tag, category.c_str(), message.c_str());
#endif
}

}  // namespace vsres::log
