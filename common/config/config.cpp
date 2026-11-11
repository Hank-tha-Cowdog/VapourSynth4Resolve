#include "config.h"
#include "../logging/log.h"

namespace vsres::config {

Json parse(const std::string& source) {
    if (source.empty()) return Json::object();
    try {
        return Json::parse(source);
    } catch (const Json::parse_error& e) {
        log::error("config", std::string("JSON parse failed: ") + e.what());
        return Json::object();
    }
}

std::string serialize_compact(const Json& j) {
    return j.dump();
}

std::string serialize_pretty(const Json& j) {
    return j.dump(2);
}

}  // namespace vsres::config
